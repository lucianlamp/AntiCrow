// ---------------------------------------------------------------------------
// messageHandler.ts — Discord メッセージハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   1. Skill プロンプトの生成
//   2. 確認フロー（リアクション / 番号選択）
//   3. Discord メッセージの受信・処理・Plan 生成・実行
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { Message, TextChannel } from 'discord.js';
import { CdpBridge } from './cdpBridge';
import { getCdpPorts } from './configHelper';
import { CascadePanelError } from './errors';
import { parseSkillJson, buildPlan } from './planParser';
import { ChannelIntent, Plan } from './types';
import { logInfo, logError, logWarn, logDebug } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { DiscordBot } from './discordBot';
import { downloadAttachments } from './attachmentDownloader';
import { BridgeContext } from './bridgeContext';
import { getResponseTimeout, getWorkspacePaths, getAllowedUserIds, getMaxMessageLength } from './configHelper';

// ---------------------------------------------------------------------------
// メッセージ処理キュー（ワークスペース毎の排他制御）
// ---------------------------------------------------------------------------

/** ワークスペース毎のメッセージキュー */
const workspaceQueues = new Map<string, Promise<void>>();
/** ワークスペース毎の処理中フラグ */
const workspaceProcessing = new Map<string, boolean>();
/** デフォルトキー（ワークスペース未特定時） */
const DEFAULT_WS_KEY = '__default__';

/** /reset コマンド用: 全ワークスペースの処理フラグとキューをリセットする */
export function resetProcessingFlag(): void {
    workspaceProcessing.clear();
    workspaceQueues.clear();
    logInfo('messageHandler: all workspace processing flags and queues reset');
}

/**
 * メッセージをワークスペース毎のキューに追加して直列処理する。
 * 同一ワークスペースのメッセージは直列処理、異なるワークスペースは並列処理。
 */
export function enqueueMessage(
    ctx: BridgeContext,
    message: Message,
    intent: ChannelIntent,
    channelName: string,
): Promise<void> {
    // ワークスペース名をチャンネルのカテゴリーから解決
    const channel = message.channel as TextChannel;
    const wsKey = DiscordBot.resolveWorkspaceFromChannel(channel) || DEFAULT_WS_KEY;

    const currentQueue = workspaceQueues.get(wsKey) ?? Promise.resolve();
    const task = currentQueue.then(async () => {
        try {
            await handleDiscordMessage(ctx, message, intent, channelName);
        } catch (e) {
            logError(`messageHandler: queued message processing failed (ws=${wsKey})`, e);
        }
    });
    workspaceQueues.set(wsKey, task);
    logDebug(`messageHandler: enqueued message for workspace "${wsKey}"`);
    return task;
}

// ---------------------------------------------------------------------------
// Skill プロンプト生成
// ---------------------------------------------------------------------------

export function buildSkillPrompt(
    userMessage: string,
    intent: ChannelIntent,
    channelName: string,
    responsePath: string,
    attachmentPaths?: string[],
): string {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    let prompt = `以下の Discord メッセージから実行計画 JSON を生成してください。

## 入力
- チャンネル: #${channelName}
- Intent: ${intent}
- 現在時刻(JST): ${now}
- メッセージ:
${userMessage}

## ルール
1. timezone は必ず "Asia/Tokyo"
2. cron は5項目標準（即時実行なら "now"）
3. メッセージ内容から即時実行か定期登録かを判断してください
4. 曖昧な場合は requires_confirmation: true
5. prompt は Antigravity にそのまま投げられる最終形

## 出力スキーマ
{
  "plan_id": "string (UUID形式)",
  "timezone": "Asia/Tokyo",
  "cron": "string (cron式 or 'now')",
  "prompt": "string",
  "requires_confirmation": boolean,
  "choice_mode": "none" | "single" | "multi" | "all",  // デフォルト: "none"
  "discord_templates": {
    "ack": "string",
    "confirm": "string (optional)",
    "run_start": "string (optional)",
    "run_success_prefix": "string (optional)",
    "run_error": "string (optional)"
  },
  "human_summary": "string (optional, Discordチャンネル名に使用。15文字以内の簡潔な要約)"
}

## choice_mode の使い方
- "none": 選択肢なし。従来の承認/却下（✅/❌）を使う
- "single": 選択肢が1つだけ選べる場合。confirm テンプレートに番号絵文字付き選択肢を記載
- "multi": 複数選択可能。☑️で確定、✅で全選択、❌で却下
- "all": 手順など全て実行する内容。選択UIなしで即実行

重要: 番号付きリスト（手順・ステップ等）は choice_mode: "all" または "none" にしてください。
choice_mode を "single" や "multi" にするのは、ユーザーに明確な選択を求める場合のみです。

## 重要: 出力方法
結果の JSON を以下のファイルパスに write_to_file ツールで書き込んでください。
チャットにも結果を出力してください。
ファイルパス: ${responsePath}`;

    // 添付ファイルがある場合、プロンプトに追記
    if (attachmentPaths && attachmentPaths.length > 0) {
        prompt += `\n\n## 添付ファイル\n以下のファイルが Discord メッセージに添付されています。\nprompt の中で view_file ツールで内容を確認するよう指示を含めてください。\n\n`;
        for (const p of attachmentPaths) {
            prompt += `- ${p}\n`;
        }
    }

    return prompt;
}

// ---------------------------------------------------------------------------
// 確認メッセージ生成
// ---------------------------------------------------------------------------

/** confirm テンプレートから選択肢の数をカウントする（choice_mode が指定されている場合のみ使用） */
function countChoiceItems(confirmText?: string): number {
    if (!confirmText) { return 0; }
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    let emojiCount = 0;
    for (const emoji of numberEmojis) {
        if (confirmText.includes(emoji)) { emojiCount++; }
    }
    return emojiCount;
}

function buildConfirmMessage(plan: Plan): string {
    const isImmediate = plan.cron === null;
    const choiceMode = plan.choice_mode || 'none';
    const lines: string[] = [];

    lines.push('📋 **実行確認**');
    lines.push('');

    // 概要
    if (plan.human_summary) {
        lines.push(`**概要:** ${plan.human_summary}`);
    }

    // 実行タイプ
    lines.push(`**実行タイプ:** ${isImmediate ? '⚡ 即時実行' : '🔄 定期実行'}`);

    // cron 式
    if (!isImmediate && plan.cron) {
        lines.push(`**スケジュール:** \`${plan.cron}\` (${plan.timezone})`);
    }

    // プロンプト内容（プレビュー）
    const promptPreview = plan.prompt.length > 300
        ? plan.prompt.substring(0, 300) + '…'
        : plan.prompt;
    lines.push('');
    lines.push('**実行内容:**');
    lines.push('```');
    lines.push(promptPreview);
    lines.push('```');

    // plan_id
    lines.push(`**Plan ID:** \`${plan.plan_id}\``);

    // カスタム確認メッセージがあれば追加
    if (plan.discord_templates.confirm) {
        lines.push('');
        lines.push(plan.discord_templates.confirm);
    }

    // choice_mode に応じたフッター
    lines.push('');
    switch (choiceMode) {
        case 'all':
            lines.push('▶️ 以下の内容をすべて実行します（自動承認）');
            break;
        case 'single': {
            const choiceCount = countChoiceItems(plan.discord_templates.confirm);
            const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            const lastEmoji = numberEmojis[Math.min(choiceCount || 1, 10) - 1];
            lines.push(`1️⃣~${lastEmoji} で1つ選択、❌ で却下`);
            lines.push('💡 修正したい場合は ❌ で却下し、要件を修正して再送信できます。');
            break;
        }
        case 'multi': {
            const choiceCount = countChoiceItems(plan.discord_templates.confirm);
            const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            const lastEmoji = numberEmojis[Math.min(choiceCount || 1, 10) - 1];
            lines.push(`1️⃣~${lastEmoji} で複数選択 → ☑️ で確定`);
            lines.push('✅ 全て選択 / ❌ 却下');
            lines.push('💡 修正したい場合は ❌ で却下し、要件を修正して再送信できます。');
            break;
        }
        default:
            lines.push('✅ で承認、❌ で却下');
            lines.push('💡 修正したい場合は ❌ で却下し、要件を修正して再送信できます。');
            break;
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// cron プレフィックス生成
// ---------------------------------------------------------------------------

/**
 * cron 式から人間が読めるプレフィックスを生成する。
 * 例: "star/5 * * * *" → "[5m]", "0 * * * *" → "[1h]", "0 0 * * *" → "[daily]"
 */
export function cronToPrefix(cron: string): string {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) { return '[cron]'; }
    const [minute, hour, dom, , dow] = parts;

    // */N * * * * → [Nm]
    const everyMinMatch = minute.match(/^\*\/(\d+)$/);
    if (everyMinMatch && hour === '*') {
        return `[${everyMinMatch[1]}m]`;
    }

    // 0 */N * * * → [Nh]
    const everyHourMatch = hour.match(/^\*\/(\d+)$/);
    if (minute === '0' && everyHourMatch) {
        return `[${everyHourMatch[1]}h]`;
    }

    // 0 * * * * → [1h]
    if (minute === '0' && hour === '*') {
        return '[1h]';
    }

    // 0 0 1 * * → [monthly]
    if (minute === '0' && hour === '0' && dom === '1') {
        return '[monthly]';
    }

    // 0 0 * * N → [weekly]
    if (minute === '0' && hour === '0' && dom === '*' && dow !== '*') {
        return '[weekly]';
    }

    // 0 0 * * * → [daily]
    if (minute === '0' && hour === '0' && dom === '*' && dow === '*') {
        return '[daily]';
    }

    // 0 N * * * (特定時刻、毎日) → [daily]
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && dow === '*') {
        return '[daily]';
    }

    return '[cron]';
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
    const allowedIds = getAllowedUserIds();
    if (allowedIds.length === 0) {
        logDebug('handleDiscordMessage: allowedUserIds is empty — all users are permitted');
    } else if (!allowedIds.includes(message.author.id)) {
        logWarn(`handleDiscordMessage: unauthorized user ${message.author.tag} (${message.author.id}) — message ignored`);
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

    // ワークスペース毎の処理中ガード: 同一ワークスペースの前リクエスト処理中は受け付けない
    const wsKey = DiscordBot.resolveWorkspaceFromChannel(channel) || DEFAULT_WS_KEY;
    if (workspaceProcessing.get(wsKey)) {
        logWarn(`handleDiscordMessage: already processing for workspace "${wsKey}", skipping`);
        await channel.send({ embeds: [buildEmbed(`⏳ ワークスペース "${wsKey}" の前のリクエストを処理中です。完了するまでお待ちください。`, EmbedColor.Warning)] });
        return;
    }

    // -----------------------------------------------------------------
    // 計画生成: Skill プロンプトを Antigravity に送信
    // -----------------------------------------------------------------
    const { bot, cdp, cdpPool, fileIpc, planStore, executor, executorPool, scheduler } = ctx;
    if (!fileIpc || !planStore || !scheduler || !bot) {
        await channel.send({ embeds: [buildEmbed('⚠️ Bridge の内部モジュールが初期化されていません。', EmbedColor.Warning)] });
        return;
    }
    // CdpPool/ExecutorPool がある場合はそちらを優先、なければ従来の cdp/executor を使用
    const useCdpPool = !!cdpPool;
    if (!useCdpPool && (!cdp || !executor)) {
        await channel.send({ embeds: [buildEmbed('⚠️ CDP接続が初期化されていません。', EmbedColor.Warning)] });
        return;
    }

    workspaceProcessing.set(wsKey, true);
    try {
        logInfo(`handleDiscordMessage: processing #${channelName} (intent = ${intent}) message: (${text.length} chars)`);

        // CDP 接続の取得: CdpPool があればワークスペース名で acquire、なければ従来の cdp を使用
        let activeCdp: CdpBridge;
        const wsNameFromCategory = DiscordBot.resolveWorkspaceFromChannel(channel);
        if (useCdpPool && cdpPool) {
            try {
                activeCdp = await cdpPool.acquire(wsNameFromCategory || '', async (wsName) => {
                    // 自動起動が発動したら Discord にフィードバック
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
        }

        // ワークスペースカテゴリーから自動切替（CdpPool未使用時のみ — CdpPool使用時は acquire で解決済み）
        let autoLaunched = false;
        logInfo(`handleDiscordMessage: wsNameFromCategory=${wsNameFromCategory || '(null)'}`);
        if (!useCdpPool && wsNameFromCategory && activeCdp) {
            const currentWs = activeCdp.getActiveWorkspaceName();
            logInfo(`handleDiscordMessage: currentWs=${currentWs || '(null)'}, wsNameFromCategory=${wsNameFromCategory}`);
            if (currentWs !== wsNameFromCategory) {
                logInfo(`handleDiscordMessage: auto-switching workspace "${currentWs}" → "${wsNameFromCategory}"`);
                try {
                    const cdpPorts = activeCdp.getPorts();
                    let instances = await CdpBridge.discoverInstances(cdpPorts);
                    const instancesLog = instances.map(i => `"${i.title}" (port=${i.port}, ws=${CdpBridge.extractWorkspaceName(i.title)})`).join(', ');
                    logInfo(`handleDiscordMessage: discoverInstances found ${instances.length} instance(s): ${instancesLog}`);
                    let target = instances.find(i => CdpBridge.extractWorkspaceName(i.title) === wsNameFromCategory);
                    logInfo(`handleDiscordMessage: workspace match for "${wsNameFromCategory}": ${target ? `found id=${target.id}` : 'NOT FOUND'}`);

                    // ワークスペースが見つからない場合、workspacePaths 設定からフォルダパスを検索して自動起動
                    if (!target) {
                        const wsPaths = getWorkspacePaths();
                        const folderPath = wsPaths[wsNameFromCategory];
                        logInfo(`handleDiscordMessage: workspacePaths keys=${JSON.stringify(Object.keys(wsPaths))}, folderPath for "${wsNameFromCategory}"=${folderPath || '(not found)'}`);

                        if (folderPath) {
                            logInfo(`handleDiscordMessage: workspace "${wsNameFromCategory}" not found, auto-opening folder "${folderPath}"...`);
                            await channel.send({ embeds: [buildEmbed(`🚀 ワークスペース "${wsNameFromCategory}" を起動中...`, EmbedColor.Info)] });
                            try {
                                await activeCdp.launchAntigravity(folderPath);
                                const maxWaitMs = 30_000;
                                const pollMs = 2_000;
                                const deadline = Date.now() + maxWaitMs;
                                let pollCount = 0;
                                while (Date.now() < deadline) {
                                    await new Promise(r => setTimeout(r, pollMs));
                                    // ポートファイルを再読取して新インスタンスのランダムポートを検出
                                    const freshPorts = getCdpPorts(fileIpc.getStoragePath());
                                    instances = await CdpBridge.discoverInstances(freshPorts);
                                    target = instances.find(i => CdpBridge.extractWorkspaceName(i.title) === wsNameFromCategory);
                                    pollCount++;
                                    if (target) { break; }
                                    logDebug(`handleDiscordMessage: polling for workspace "${wsNameFromCategory}"... (${pollCount})`);
                                }
                                if (target) {
                                    autoLaunched = true;
                                    logInfo(`handleDiscordMessage: auto-launched workspace found (id=${target.id}), waiting for UI init...`);
                                } else {
                                    logWarn(`handleDiscordMessage: workspace not found after ${pollCount} polls`);
                                }
                            } catch (autoOpenErr) {
                                logWarn(`handleDiscordMessage: auto-open failed — ${autoOpenErr instanceof Error ? autoOpenErr.message : autoOpenErr}`);
                                await channel.send({ embeds: [buildEmbed(`⚠️ 自動起動に失敗しました: ${autoOpenErr instanceof Error ? autoOpenErr.message : autoOpenErr}`, EmbedColor.Warning)] });
                            }
                        } else {
                            logInfo(`handleDiscordMessage: workspace "${wsNameFromCategory}" not found, no folderPath configured, trying ensureConnected...`);
                            try {
                                await activeCdp.ensureConnected();
                                instances = await CdpBridge.discoverInstances(cdpPorts);
                                target = instances.find(i => CdpBridge.extractWorkspaceName(i.title) === wsNameFromCategory);
                            } catch (autoLaunchErr) {
                                logWarn(`handleDiscordMessage: auto-launch failed — ${autoLaunchErr instanceof Error ? autoLaunchErr.message : autoLaunchErr}`);
                            }
                        }
                    }

                    if (target) {
                        await activeCdp.switchTarget(target.id);
                        logInfo(`handleDiscordMessage: switched to workspace "${wsNameFromCategory}"(id = ${target.id})`);
                    } else {
                        logWarn(`handleDiscordMessage: workspace "${wsNameFromCategory}" not found even after auto-open`);
                        const wsPaths = getWorkspacePaths();
                        if (!wsPaths[wsNameFromCategory]) {
                            await channel.send({ embeds: [buildEmbed(`⚠️ ワークスペース "${wsNameFromCategory}" のパスが設定されていません。\n設定 \`antiCrow.workspacePaths\` にパスを追加してください。\n例: \`"${wsNameFromCategory}": "C:\\\\Users\\\\...\\\\${wsNameFromCategory}"\``, EmbedColor.Warning)] });
                        } else {
                            await channel.send({ embeds: [buildEmbed(`⚠️ ワークスペース "${wsNameFromCategory}" を起動しましたが、接続できませんでした。Antigravity のウインドウを確認してください。`, EmbedColor.Warning)] });
                        }
                        return;
                    }
                } catch (e) {
                    logError(`handleDiscordMessage: auto-switch to workspace "${wsNameFromCategory}" failed`, e);
                }
            }
        }

        try {
            const instanceLabel = activeCdp.getActiveWorkspaceName();
            const ackPrefix = instanceLabel ? `[${instanceLabel}]` : '';
            await channel.send({ embeds: [buildEmbed(`🔄 ${ackPrefix}計画を生成中...`, EmbedColor.Info)] });
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

        // Skill プロンプト生成（ファイル書き込み指示付き + 添付ファイル情報）
        const skillPrompt = buildSkillPrompt(text || '（添付ファイルを確認してください）', intent, channelName, responsePath, attachmentPaths);
        logInfo('handleDiscordMessage: sending skill prompt via CDP...');

        // typing indicator 開始（CDP応答待機中に「入力中...」を表示）
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
                    break; // 成功
                } catch (retryErr) {
                    if (retryErr instanceof CascadePanelError && attempt < maxRetries) {
                        logWarn(`handleDiscordMessage: CascadePanelError on attempt ${attempt}, will retry...`);
                        continue;
                    }
                    throw retryErr; // 最終試行 or 別のエラー → 上位に伝播
                }
            }
            logInfo('handleDiscordMessage: prompt sent, waiting for file response...');

            // ファイル経由でレスポンスを待機
            const responseTimeout = getResponseTimeout();
            skillResponse = await fileIpc.waitForResponse(responsePath, responseTimeout);
        } finally {
            clearInterval(typingInterval);

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
        // デフォルトは元チャンネル。定期登録時は後で専用チャンネルに上書き。
        const guild = message.guild;
        const isImmediate = !skillOutput.cron || skillOutput.cron === 'now' || skillOutput.cron === 'immediate';
        const notifyTarget = channel.id;
        logInfo(`handleDiscordMessage: notify target = ${notifyTarget} (intent = ${intent}, immediate = ${isImmediate})`);
        const plan = buildPlan(skillOutput, channel.id, notifyTarget);

        // 添付ファイルパスを Plan に引き継ぐ
        if (attachmentPaths && attachmentPaths.length > 0) {
            plan.attachment_paths = attachmentPaths;
        }

        // ACK 送信（空文字の場合はスキップ — Discord.js は空 description を拒否する）
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
                // choice_mode: 'all' — 全て実行（確認不要だが内容は表示）
                await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Info)] });
                plan.status = 'active';
            } else if (choiceMode === 'multi') {
                // choice_mode: 'multi' — 複数選択モード
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
                // choice_mode: 'single' — 単一選択モード
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
                // choice_mode: 'none' — 従来の承認/却下
                const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
                const confirmed = await bot.waitForConfirmation(sentMsg);
                if (!confirmed) {
                    await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
                    return;
                }
                plan.status = 'active';
            }
        } else {
            // 承認不要でも実行予定の概要を表示
            const summary = plan.human_summary || plan.prompt.substring(0, 100);
            await channel.send({ embeds: [buildEmbed(`📋 **実行予定:** ${summary}`, EmbedColor.Info)] });
        }

        // -----------------------------------------------------------------
        // 即時実行 or 定期登録
        // -----------------------------------------------------------------
        if (plan.cron === null) {
            // 即時実行 — PlanStore には保存しない（ゴミ蓄積防止）
            // ワークスペース名を設定（executor での自動起動フォールバック用）
            const wsNameForImmediate = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
            if (wsNameForImmediate) { plan.workspace_name = wsNameForImmediate; }
            // Executor が進捗通知・結果通知を送信するチャンネル
            plan.notify_channel_id = channel.id;
            logInfo(`handleDiscordMessage: enqueueing immediate execution for plan ${plan.plan_id}(not persisted, workspace=${wsNameForImmediate || 'default'})`);
            // ExecutorPool があればワークスペース指定で enqueue、なければ従来の executor
            if (executorPool) {
                await executorPool.enqueueImmediate(wsNameForImmediate || '', plan);
            } else if (executor) {
                executor.enqueueImmediate(plan);
            }
        } else {
            // 定期登録 — 専用チャンネル作成 → PlanStore に永続化 → Scheduler に登録
            logInfo(`handleDiscordMessage: registering scheduled plan ${plan.plan_id} with cron = ${plan.cron} `);

            // ワークスペースカテゴリー内に専用チャンネルを作成
            if (guild && bot) {
                const prefix = cronToPrefix(plan.cron!);
                const baseName = plan.human_summary || plan.plan_id;
                const chName = `${prefix} ${baseName} `;
                // ワークスペース名を特定（カテゴリーから or 現在のアクティブワークスペース）
                const wsName = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
                if (wsName) { plan.workspace_name = wsName; }
                const planChannelId = await bot.createPlanChannel(guild.id, chName, wsName);
                if (planChannelId) {
                    plan.channel_id = planChannelId;
                    plan.notify_channel_id = planChannelId;
                    logInfo(`handleDiscordMessage: created plan channel ${planChannelId} for plan ${plan.plan_id}(workspace = ${wsName || 'default'})`);
                }
            }

            planStore.add(plan);
            scheduler.register(plan);
            const channelMention = plan.channel_id ? `< #${plan.channel_id}> ` : '#schedule';
            await channel.send({ embeds: [buildEmbed(`📅 定期実行を登録しました: \`${plan.cron}\` (${plan.timezone})\n結果は ${channelMention} チャンネルに通知されます。`, EmbedColor.Success)] });
        }

    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleDiscordMessage failed', e);
        await channel.send({ embeds: [buildEmbed(`❌ エラー: ${errMsg}`, EmbedColor.Error)] });
    } finally {
        workspaceProcessing.set(wsKey, false);
    }
}
