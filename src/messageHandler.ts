// ---------------------------------------------------------------------------
// messageHandler.ts — Discord メッセージハンドラ
// ---------------------------------------------------------------------------
import * as fs from 'fs';
// ---------------------------------------------------------------------------
// 責務:
//   1. メッセージキュー管理（ワークスペース毎の排他制御）
//   2. Discord メッセージの受信・処理・Plan 生成・実行
// プロンプト生成 → promptBuilder.ts
// ワークスペース自動切替 → workspaceResolver.ts
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { Message, TextChannel } from 'discord.js';
import { CdpBridge } from './cdpBridge';
import { CascadePanelError } from './errors';
import { parseSkillJson, buildPlan } from './planParser';
import { ChannelIntent, Plan } from './types';
import { logInfo, logError, logWarn, logDebug } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { DiscordBot } from './discordBot';
import { downloadAttachments } from './attachmentDownloader';
import { BridgeContext } from './bridgeContext';
import { getResponseTimeout, isUserAllowed, getMaxMessageLength } from './configHelper';
import { getCurrentModel } from './cdpModels';
import { getCurrentMode } from './cdpModes';

// 委譲先モジュール
import { buildSkillPrompt, buildConfirmMessage, countChoiceItems, cronToPrefix } from './promptBuilder';
import { resolveWorkspace } from './workspaceResolver';

// Re-export for backward compatibility
export { buildSkillPrompt, cronToPrefix } from './promptBuilder';

// ---------------------------------------------------------------------------
// メッセージ処理キュー（ワークスペース毎の排他制御）
// ---------------------------------------------------------------------------

/** ワークスペース毎のメッセージキュー */
const workspaceQueues = new Map<string, Promise<void>>();
/** ワークスペース毎のキュー待ち件数 */
const workspaceQueueCount = new Map<string, number>();
/** デフォルトキー（ワークスペース未特定時） */
const DEFAULT_WS_KEY = '__default__';

/** /reset コマンド用: 全ワークスペースのキューをリセットする */
export function resetProcessingFlag(): void {
    workspaceQueueCount.clear();
    workspaceQueues.clear();
    logInfo('messageHandler: all workspace queues reset');
}

/**
 * メッセージをワークスペース毎のキューに追加して直列処理する。
 * 同一ワークスペースのメッセージは直列処理、異なるワークスペースは並列処理。
 */
export async function enqueueMessage(
    ctx: BridgeContext,
    message: Message,
    intent: ChannelIntent,
    channelName: string,
): Promise<void> {
    // ワークスペース名をチャンネルのカテゴリーから解決
    const channel = message.channel as TextChannel;
    const wsKey = DiscordBot.resolveWorkspaceFromChannel(channel) || DEFAULT_WS_KEY;

    // キューカウンターをインクリメント
    const prevCount = workspaceQueueCount.get(wsKey) ?? 0;
    workspaceQueueCount.set(wsKey, prevCount + 1);

    // キューに待ちがある場合は通知
    if (prevCount > 0) {
        try {
            await channel.send({ embeds: [buildEmbed(`📥 キューに追加しました（待ち: ${prevCount}件）。前のタスク完了後に処理します。`, EmbedColor.Info)] });
        } catch (e) {
            logDebug(`messageHandler: failed to send queue notification: ${e}`);
        }
    }

    const currentQueue = workspaceQueues.get(wsKey) ?? Promise.resolve();
    const task = currentQueue.then(async () => {
        try {
            await handleDiscordMessage(ctx, message, intent, channelName);
        } catch (e) {
            logError(`messageHandler: queued message processing failed (ws=${wsKey})`, e);
        } finally {
            // キューカウンターをデクリメント
            const count = workspaceQueueCount.get(wsKey) ?? 1;
            workspaceQueueCount.set(wsKey, Math.max(0, count - 1));
        }
    });
    workspaceQueues.set(wsKey, task);
    logDebug(`messageHandler: enqueued message for workspace "${wsKey}" (queue size=${prevCount + 1})`);
    return task;
}



// ---------------------------------------------------------------------------
// メッセージハンドラ
// ---------------------------------------------------------------------------

export async function handleDiscordMessage(
    ctx: BridgeContext,
    message: Message,
    intent: ChannelIntent,
    channelName: string,
): Promise<void> {
    let text = message.content.trim();
    if (!text && message.attachments.size === 0) { return; }

    const channel = message.channel as TextChannel;

    // -----------------------------------------------------------------
    // セキュリティ: 許可ユーザーID制限
    // -----------------------------------------------------------------
    const authResult = isUserAllowed(message.author.id);
    if (!authResult.allowed) {
        logWarn(`handleDiscordMessage: user ${message.author.tag} (${message.author.id}) not allowed — ${authResult.reason}`);
        await channel.send({ embeds: [buildEmbed(`🔒 ${authResult.reason}`, EmbedColor.Warning)] });
        return;
    }

    // -----------------------------------------------------------------
    // セキュリティ: メッセージ長制限
    // -----------------------------------------------------------------
    const maxLen = getMaxMessageLength();
    if (maxLen > 0 && text.length > maxLen) {
        logWarn(`handleDiscordMessage: message too long (${text.length} > ${maxLen}) from ${message.author.tag}`);
        await channel.send({ embeds: [buildEmbed(`⚠️ メッセージが長すぎます（${text.length}文字）。上限は ${maxLen} 文字です。`, EmbedColor.Warning)] });
        return;
    }


    // -----------------------------------------------------------------
    // 返信コンテキスト: リプライ先メッセージの内容を取得してプロンプトに付加
    // -----------------------------------------------------------------
    if (message.reference?.messageId) {
        try {
            const refMsg = await channel.messages.fetch(message.reference.messageId);
            if (refMsg) {
                const refContent = refMsg.content?.trim() || '';
                const refAuthor = refMsg.author?.tag ?? '不明';

                // 返信先の Embed 内容も取得
                let embedText = '';
                if (refMsg.embeds && refMsg.embeds.length > 0) {
                    const parts: string[] = [];
                    for (const embed of refMsg.embeds) {
                        if (embed.title) { parts.push(embed.title); }
                        if (embed.description) { parts.push(embed.description); }
                        if (embed.fields && embed.fields.length > 0) {
                            for (const field of embed.fields) {
                                parts.push(`${field.name}: ${field.value}`);
                            }
                        }
                    }
                    embedText = parts.join('\n');
                }

                const combinedContent = [refContent, embedText].filter(Boolean).join('\n\n');
                if (combinedContent) {
                    logInfo(`handleDiscordMessage: reply detected, referenced message from ${refAuthor} (content=${refContent.length} chars, embeds=${embedText.length} chars)`);
                    text = `## 返信先メッセージ（${refAuthor} の発言）\n${combinedContent}\n\n## 上記メッセージに対する指示\n${text}`;
                }
            }
        } catch (e) {
            logWarn(`handleDiscordMessage: failed to fetch referenced message: ${e instanceof Error ? e.message : e}`);
        }
    }

    // -----------------------------------------------------------------
    // 計画生成: Skill プロンプトを Antigravity に送信
    // -----------------------------------------------------------------
    const wsNameFromCategory = DiscordBot.resolveWorkspaceFromChannel(channel);
    const { bot, cdp, cdpPool, fileIpc, planStore, executor, executorPool, scheduler } = ctx;
    if (!fileIpc || !planStore || !scheduler || !bot) {
        await channel.send({ embeds: [buildEmbed('⚠️ Bridge の内部モジュールが初期化されていません。', EmbedColor.Warning)] });
        return;
    }
    // CdpPool/ExecutorPool がある場合はそちらを優先、なければ従来の cdp/executor を使用
    const useCdpPool = !!cdpPool;
    if (!useCdpPool && (!cdp || !executor)) {
        await channel.send({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
        return;
    }
    try {
        logInfo(`handleDiscordMessage: processing #${channelName} (intent = ${intent}) message: (${text.length} chars)`);

        // CDP 接続の取得
        let activeCdp: CdpBridge;
        let autoLaunched = false;

        if (useCdpPool && cdpPool) {
            try {
                activeCdp = await cdpPool.acquire(wsNameFromCategory || '', async (wsName) => {
                    try {
                        await channel.sendTyping();
                        await channel.send({ embeds: [buildEmbed(`🚀 ワークスペース "${wsName}" を起動中です。しばらくお待ちください...`, EmbedColor.Info)] });
                    } catch (e) { logDebug(`handleDiscordMessage: failed to react: ${e}`); }
                });
                logInfo(`handleDiscordMessage: acquired CdpBridge from pool for workspace "${wsNameFromCategory || 'default'}"`);
            } catch (e) {
                logError(`handleDiscordMessage: failed to acquire CdpBridge for workspace "${wsNameFromCategory}"`, e);
                await channel.send({ embeds: [buildEmbed(`⚠️ ワークスペース "${wsNameFromCategory}" への接続に失敗しました: ${e instanceof Error ? e.message : e}`, EmbedColor.Warning)] });
                return;
            }
        } else {
            activeCdp = cdp!;
            // 従来の事前接続
            if (!activeCdp.getActiveTargetTitle()) {
                try {
                    await activeCdp.connect();
                } catch (e) {
                    logDebug(`handleDiscordMessage: pre-connect for instance title failed: ${e instanceof Error ? e.message : e}`);
                }
            }

            // ワークスペースカテゴリーから自動切替（CdpPool未使用時のみ）
            if (wsNameFromCategory) {
                const result = await resolveWorkspace(activeCdp, wsNameFromCategory, channel, fileIpc);
                if (!result) { return; } // 切替失敗
                activeCdp = result.cdp;
                autoLaunched = result.autoLaunched;
            }
        }

        try {
            const [currentMode, currentModel] = await Promise.all([
                getCurrentMode(activeCdp.ops).catch(() => null),
                getCurrentModel(activeCdp.ops).catch(() => null),
            ]);
            const parts = [currentMode, currentModel].filter(Boolean);
            const ackPrefix = parts.length > 0 ? `[${parts.join(' - ')}]` : '';
            await channel.send({ embeds: [buildEmbed(`🔄 ${ackPrefix} 伝達中...`, EmbedColor.Info)] });
        } catch (sendErr) {
            logError('handleDiscordMessage: failed to send acknowledgement', sendErr);
        }

        // ファイルベース IPC: リクエストIDとレスポンスパスを生成
        const { requestId, responsePath } = fileIpc.createRequestId();

        // 添付ファイルのダウンロード
        let attachmentPaths: string[] | undefined;
        const storageBase = fileIpc.getStoragePath();
        if (message.attachments.size > 0) {
            logInfo(`handleDiscordMessage: downloading ${message.attachments.size} attachment(s)...`);
            const downloaded = await downloadAttachments(message.attachments, storageBase, requestId);
            if (downloaded.length > 0) {
                attachmentPaths = downloaded.map(d => d.localPath);
                logInfo(`handleDiscordMessage: ${downloaded.length} attachment(s) saved`);
            }
        }

        // Skill プロンプト生成
        const ipcDir = fileIpc.getIpcDir();
        const { prompt: skillPrompt, tempFiles } = buildSkillPrompt(text || '（添付ファイルを確認してください）', intent, channelName, responsePath, attachmentPaths, ctx.extensionPath, ipcDir);
        logInfo('handleDiscordMessage: sending skill prompt via CDP...');

        // typing indicator 開始
        const typingInterval = setInterval(async () => {
            try { await channel.sendTyping(); } catch (e) { logDebug(`handleDiscordMessage: sendTyping failed: ${e}`); }
        }, 8_000);
        try { await channel.sendTyping(); } catch (e) { logDebug(`handleDiscordMessage: sendTyping failed: ${e}`); }

        let skillResponse: string;
        try {
            // CDP でプロンプト送信（自動起動直後は UI 初期化待ちのためリトライ）
            const maxRetries = autoLaunched ? 3 : 1;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 1) {
                        logInfo(`handleDiscordMessage: retrying sendPrompt (attempt ${attempt}/${maxRetries})...`);
                        await new Promise(r => setTimeout(r, 5_000));
                    }
                    await activeCdp.sendPrompt(skillPrompt);
                    break;
                } catch (retryErr) {
                    if (retryErr instanceof CascadePanelError && attempt < maxRetries) {
                        logWarn(`handleDiscordMessage: CascadePanelError on attempt ${attempt}, will retry...`);
                        continue;
                    }
                    throw retryErr;
                }
            }
            logInfo('handleDiscordMessage: prompt sent, waiting for file response...');

            // ファイル経由でレスポンスを待機
            const responseTimeout = getResponseTimeout();
            skillResponse = await fileIpc.waitForResponse(responsePath, responseTimeout);
        } finally {
            clearInterval(typingInterval);
            // 一時ファイルのクリーンアップ
            for (const f of tempFiles) {
                try { fs.unlinkSync(f); logInfo(`handleDiscordMessage: cleaned up temp file: ${f}`); } catch { /* ignore */ }
            }
        }
        logInfo(`handleDiscordMessage: skill response received(${skillResponse.length} chars)`);

        // パース
        logInfo(`handleDiscordMessage: raw skill response: ${skillResponse.substring(0, 200)} `);
        const skillOutput = parseSkillJson(skillResponse);
        if (!skillOutput) {
            logError('handleDiscordMessage: skill JSON parse failed');
            await channel.send({
                embeds: [buildEmbed(
                    '⚠️ Antigravity からの応答を解析できませんでした。\n' +
                    '応答:\n```\n' + skillResponse.substring(0, 1000) + '\n```',
                    EmbedColor.Warning
                )]
            });
            return;
        }
        logInfo(`handleDiscordMessage: plan parsed — plan_id = ${skillOutput.plan_id}, cron = ${skillOutput.cron} `);

        // 通知先の決定
        const guild = message.guild;
        const plan = buildPlan(skillOutput, channel.id, channel.id);

        // 添付ファイルパスを Plan に引き継ぐ
        if (attachmentPaths && attachmentPaths.length > 0) {
            plan.attachment_paths = attachmentPaths;
        }

        // ACK 送信
        if (plan.discord_templates.ack) {
            await channel.send({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });
        }

        // -----------------------------------------------------------------
        // 確認フロー
        // -----------------------------------------------------------------
        if (plan.requires_confirmation) {
            const choiceMode = plan.choice_mode || 'none';
            const confirmMsg = buildConfirmMessage(plan);

            if (choiceMode === 'all') {
                await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Info)] });
                plan.status = 'active';
            } else if (choiceMode === 'multi') {
                const choiceCount = countChoiceItems(plan.discord_templates.confirm);
                const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
                const choices = await bot.waitForMultiChoice(sentMsg, choiceCount);
                if (choices.length === 0) {
                    await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
                    return;
                }
                if (choices[0] === -1) {
                    await channel.send({ embeds: [buildEmbed('✅ 全て選択しました。', EmbedColor.Success)] });
                } else {
                    await channel.send({ embeds: [buildEmbed(`✅ 選択肢 ${choices.join(', ')} を選択しました。`, EmbedColor.Success)] });
                }
                plan.status = 'active';
            } else if (choiceMode === 'single') {
                const choiceCount = countChoiceItems(plan.discord_templates.confirm);
                const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
                const choice = await bot.waitForChoice(sentMsg, choiceCount);
                if (choice === -1) {
                    await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
                    return;
                }
                await channel.send({ embeds: [buildEmbed(`✅ 選択肢 ${choice} を承認しました。`, EmbedColor.Success)] });
                plan.status = 'active';
            } else {
                const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
                const confirmed = await bot.waitForConfirmation(sentMsg);
                if (!confirmed) {
                    await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
                    return;
                }
                plan.status = 'active';
            }
        } else {
            const summary = plan.human_summary || plan.prompt.substring(0, 100);
            await channel.send({ embeds: [buildEmbed(`📋 **実行予定:** ${summary}`, EmbedColor.Info)] });
        }

        // -----------------------------------------------------------------
        // 即時実行 or 定期登録
        // -----------------------------------------------------------------
        if (plan.cron === null) {
            const wsNameForImmediate = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
            if (wsNameForImmediate) { plan.workspace_name = wsNameForImmediate; }
            plan.notify_channel_id = channel.id;
            logInfo(`handleDiscordMessage: enqueueing immediate execution for plan ${plan.plan_id} (not persisted, workspace=${wsNameForImmediate || 'default'})`);
            if (executorPool) {
                await executorPool.enqueueImmediate(wsNameForImmediate || '', plan);
            } else if (executor) {
                executor.enqueueImmediate(plan);
            }
        } else {
            logInfo(`handleDiscordMessage: registering scheduled plan ${plan.plan_id} with cron = ${plan.cron} `);

            if (guild && bot) {
                const prefix = cronToPrefix(plan.cron!);
                const baseName = plan.human_summary || plan.plan_id;
                const chName = `${prefix} ${baseName} `;
                const wsName = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
                if (wsName) { plan.workspace_name = wsName; }
                const planChannelId = await bot.createPlanChannel(guild.id, chName, wsName);
                if (planChannelId) {
                    plan.channel_id = planChannelId;
                    plan.notify_channel_id = planChannelId;
                    logInfo(`handleDiscordMessage: created plan channel ${planChannelId} for plan ${plan.plan_id} (workspace=${wsName || 'default'})`);
                }
            }

            planStore.add(plan);
            scheduler.register(plan);
            const channelMention = plan.channel_id ? `<#${plan.channel_id}> ` : '#schedule';
            await channel.send({ embeds: [buildEmbed(`📅 定期実行を登録しました: \`${plan.cron}\` (${plan.timezone})\n結果は ${channelMention} チャンネルに通知されます。`, EmbedColor.Success)] });
        }

    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleDiscordMessage failed', e);
        await channel.send({ embeds: [buildEmbed(`❌ エラー: ${errMsg}`, EmbedColor.Error)] });
    }
}
