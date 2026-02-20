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
import { WorkspaceConnectionError } from './cdpPool';
import { CascadePanelError } from './errors';
import { FileIpc } from './fileIpc';
import { parsePlanJson, buildPlan } from './planParser';
import { ChannelIntent, Plan } from './types';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord } from './embedHelper';
import { DiscordBot } from './discordBot';
import { downloadAttachments } from './attachmentDownloader';
import { BridgeContext } from './bridgeContext';
import { getResponseTimeout, isUserAllowed, getMaxMessageLength, getWorkspacePaths } from './configHelper';
import { getCurrentModel } from './cdpModels';
import { getCurrentMode } from './cdpModes';

// 委譲先モジュール
import { buildPlanPrompt, buildConfirmMessage, countChoiceItems, cronToPrefix } from './promptBuilder';
import { resolveWorkspace } from './workspaceResolver';

// Re-export for backward compatibility
export { buildPlanPrompt, cronToPrefix } from './promptBuilder';

// ---------------------------------------------------------------------------
// メッセージ処理キュー（ワークスペース毎の排他制御）
// ---------------------------------------------------------------------------

/** ワークスペース毎のメッセージキュー */
const workspaceQueues = new Map<string, Promise<void>>();
/** ワークスペース毎のキュー待ち件数 */
const workspaceQueueCount = new Map<string, number>();
/** デフォルトキー（ワークスペース未特定時） */
const DEFAULT_WS_KEY = '__default__';

// ---------------------------------------------------------------------------
// 処理ステータス追跡（/queue 表示用）
// ---------------------------------------------------------------------------

/** メッセージ処理パイプラインのステータス */
export type ProcessingPhase = 'connecting' | 'plan_generating' | 'confirming' | 'dispatching';

export interface ProcessingStatus {
    wsKey: string;
    phase: ProcessingPhase;
    startTime: number;
    messagePreview: string;
}

/** ワークスペース毎の現在処理中ステータス */
const currentProcessingStatuses = new Map<string, ProcessingStatus>();

// ---------------------------------------------------------------------------
// Plan 生成キャンセル機構（/cancel 用）
// ---------------------------------------------------------------------------

/** Plan 生成中の AbortController（キャンセル可能にする） */
let currentPlanAbortController: AbortController | null = null;
/** Plan 生成中の typing interval（キャンセル時にクリア可能にする） */
let currentPlanTypingInterval: ReturnType<typeof setInterval> | null = null;
/** Plan 生成中の progress interval（キャンセル時にクリア可能にする） */
let currentPlanProgressInterval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// メッセージID 重複チェック（二重処理防止）
// ---------------------------------------------------------------------------
/** 最近処理したメッセージ ID → 処理開始時刻 */
const recentMessageIds = new Map<string, number>();
/** 重複チェックの保持期間（ms） */
const MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000;

/** 定期的に古いエントリを削除する */
function cleanupRecentMessageIds(): void {
    const now = Date.now();
    for (const [id, ts] of recentMessageIds) {
        if (now - ts > MESSAGE_DEDUP_TTL_MS) {
            recentMessageIds.delete(id);
        }
    }
}
// 60秒毎にクリーンアップ
setInterval(cleanupRecentMessageIds, 60_000);

/** /reset コマンド用: 全ワークスペースのキューをリセットする */
export function resetProcessingFlag(): void {
    workspaceQueueCount.clear();
    workspaceQueues.clear();
    logDebug('messageHandler: all workspace queues reset');
}

/** Plan 生成をキャンセルする（/cancel コマンド用） */
export function cancelPlanGeneration(): void {
    if (currentPlanAbortController) {
        currentPlanAbortController.abort();
        currentPlanAbortController = null;
        logDebug('messageHandler: plan generation AbortController triggered');
    }
    if (currentPlanTypingInterval) {
        clearInterval(currentPlanTypingInterval);
        currentPlanTypingInterval = null;
        logDebug('messageHandler: plan typing interval cleared');
    }
    if (currentPlanProgressInterval) {
        clearInterval(currentPlanProgressInterval);
        currentPlanProgressInterval = null;
        logDebug('messageHandler: plan progress interval cleared');
    }
    currentProcessingStatuses.clear();
}

/** メッセージキューの状態を取得（/queue, /status コマンド用） */
export function getMessageQueueStatus(): {
    total: number;
    perWorkspace: Map<string, number>;
    processing: ProcessingStatus[];
} {
    let total = 0;
    const perWorkspace = new Map<string, number>();
    for (const [wsKey, count] of workspaceQueueCount.entries()) {
        if (count > 0) {
            total += count;
            perWorkspace.set(wsKey, count);
        }
    }
    const processing = Array.from(currentProcessingStatuses.values());
    return { total, perWorkspace, processing };
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
    // メッセージID 重複チェック（二重処理防止）
    const msgId = message.id;
    if (recentMessageIds.has(msgId)) {
        logDebug(`messageHandler: duplicate message detected (id=${msgId}), skipping`);
        return;
    }
    recentMessageIds.set(msgId, Date.now());

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

/**
 * 返信コンテキストを取得してテキストに付加する。
 */
async function resolveReplyContext(channel: TextChannel, text: string, messageRef?: { messageId?: string }): Promise<string> {
    if (!messageRef?.messageId) { return text; }
    try {
        const refMsg = await channel.messages.fetch(messageRef.messageId);
        if (!refMsg) { return text; }

        const refContent = refMsg.content?.trim() || '';
        const refAuthor = refMsg.author?.tag ?? '不明';
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
            logDebug(`handleDiscordMessage: reply detected, referenced message from ${refAuthor} (content=${refContent.length} chars, embeds=${embedText.length} chars)`);
            return `## 返信先メッセージ（${refAuthor} の発言）\n${combinedContent}\n\n## 上記メッセージに対する指示\n${text}`;
        }
    } catch (e) {
        logWarn(`handleDiscordMessage: failed to fetch referenced message: ${e instanceof Error ? e.message : e}`);
    }
    return text;
}

/**
 * CDP 接続を取得する。CdpPool 使用時は acquire、従来モードは直接接続。
 * 接続失敗時は null を返し、呼び出し元でエラー通知する。
 */
async function acquireCdpConnection(
    ctx: BridgeContext,
    channel: TextChannel,
    wsNameFromCategory: string | undefined,
    fileIpc: FileIpc,
): Promise<{ cdp: CdpBridge; autoLaunched: boolean } | null> {
    const { cdp, cdpPool } = ctx;
    const useCdpPool = !!cdpPool;

    if (useCdpPool && cdpPool) {
        try {
            const activeCdp = await cdpPool.acquire(wsNameFromCategory || '', async (wsName) => {
                try {
                    await channel.sendTyping();
                    await channel.send({ embeds: [buildEmbed(`🚀 ワークスペース "${wsName}" を起動中です。しばらくお待ちください...`, EmbedColor.Info)] });
                } catch (e) { logDebug(`handleDiscordMessage: failed to react: ${e}`); }
            });
            logDebug(`handleDiscordMessage: acquired CdpBridge from pool for workspace "${wsNameFromCategory || 'default'}"`);
            return { cdp: activeCdp, autoLaunched: false };
        } catch (e) {
            logError(`handleDiscordMessage: failed to acquire CdpBridge for workspace "${wsNameFromCategory}"`, e);
            // WorkspaceConnectionError の場合はユーザーフレンドリーな userMessage を直接表示
            const displayMsg = (e instanceof WorkspaceConnectionError)
                ? e.userMessage
                : `ワークスペース "${wsNameFromCategory}" への接続に失敗しました: ${sanitizeErrorForDiscord(e instanceof Error ? e.message : String(e))}`;
            await channel.send({ embeds: [buildEmbed(`⚠️ ${displayMsg}`, EmbedColor.Warning)] });
            return null;
        }
    }

    const activeCdp = cdp!;
    if (!activeCdp.getActiveTargetTitle()) {
        try { await activeCdp.connect(); } catch (e) {
            logDebug(`handleDiscordMessage: pre-connect for instance title failed: ${e instanceof Error ? e.message : e}`);
        }
    }

    // ワークスペースカテゴリーから自動切替（CdpPool未使用時のみ）
    if (wsNameFromCategory) {
        const result = await resolveWorkspace(activeCdp, wsNameFromCategory, channel, fileIpc);
        if (!result) { return null; }
        return { cdp: result.cdp, autoLaunched: result.autoLaunched };
    }
    return { cdp: activeCdp, autoLaunched: false };
}

/**
 * Plan プロンプトを Antigravity に送信し、JSON レスポンスをパースして Plan を返す。
 * パース失敗時は null を返す（呼び出し元でフォールバック通知する）。
 */
async function generatePlan(
    activeCdp: CdpBridge,
    autoLaunched: boolean,
    fileIpc: FileIpc,
    channel: TextChannel,
    text: string,
    intent: ChannelIntent,
    channelName: string,
    attachmentPaths: string[] | undefined,
    extensionPath: string | undefined,
    resolvedWsPath: string | undefined,
): Promise<{ plan: Plan; guild: typeof import('discord.js').Guild.prototype | null } | null> {
    const { requestId, responsePath } = fileIpc.createRequestId();
    const ipcDir = fileIpc.getIpcDir();
    const progressPath = fileIpc.createProgressPath(requestId);
    const { prompt: planPrompt, tempFiles } = buildPlanPrompt(
        text || '（添付ファイルを確認してください）', intent, channelName,
        responsePath, attachmentPaths, extensionPath, ipcDir, resolvedWsPath, progressPath,
    );
    logDebug('handleDiscordMessage: sending plan prompt via CDP...');

    // AbortController 生成（/cancel でキャンセル可能にする）
    const abortController = new AbortController();
    currentPlanAbortController = abortController;

    // typing indicator 開始（モジュールレベル変数に格納し /cancel でクリア可能にする）
    currentPlanTypingInterval = setInterval(async () => {
        try { await channel.sendTyping(); } catch (e) { logDebug(`handleDiscordMessage: sendTyping failed: ${e}`); }
    }, 8_000);
    try { await channel.sendTyping(); } catch (e) { logDebug(`handleDiscordMessage: sendTyping failed: ${e}`); }

    let planResponse: string;
    try {
        // CDP でプロンプト送信（自動起動直後は UI 初期化待ちのためリトライ）
        const maxRetries = autoLaunched ? 3 : 1;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 1) {
                    logDebug(`handleDiscordMessage: retrying sendPrompt (attempt ${attempt}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, 5_000));
                }
                await activeCdp.sendPrompt(planPrompt);
                break;
            } catch (retryErr) {
                if (retryErr instanceof CascadePanelError && attempt < maxRetries) {
                    logWarn(`handleDiscordMessage: CascadePanelError on attempt ${attempt}, will retry...`);
                    continue;
                }
                throw retryErr;
            }
        }
        logDebug('handleDiscordMessage: prompt sent, waiting for file response...');

        // 伝令完了 → 計画生成中ステータス
        try {
            await channel.send({ embeds: [buildEmbed('✅ 伝令完了。計画を練っています...', EmbedColor.Success)] });
        } catch (ackErr) {
            logDebug(`handleDiscordMessage: failed to send plan-generation ack: ${ackErr}`);
        }

        // 計画生成中の進捗報告（モジュールレベル変数に格納）
        let lastPlanProgress = '';
        currentPlanProgressInterval = setInterval(async () => {
            try {
                const progress = await fileIpc.readProgress(progressPath);
                if (progress) {
                    const currentContent = JSON.stringify(progress);
                    if (currentContent !== lastPlanProgress) {
                        lastPlanProgress = currentContent;
                        const percentStr = progress.percent !== undefined ? ` (${progress.percent}%)` : '';
                        const detail = progress.detail ? `\n> ${progress.detail}` : '';
                        await channel.send({ embeds: [buildEmbed(`⏳ ${progress.status || '処理中...'}${percentStr}${detail}`, EmbedColor.Progress)] });
                    }
                }
            } catch { /* ignore */ }
        }, 3_000);

        const responseTimeout = getResponseTimeout();
        try {
            planResponse = await fileIpc.waitForResponse(responsePath, responseTimeout, abortController.signal);
        } finally {
            if (currentPlanProgressInterval) {
                clearInterval(currentPlanProgressInterval);
                currentPlanProgressInterval = null;
            }
            fileIpc.cleanupProgress(progressPath).catch(() => { });
        }
    } finally {
        if (currentPlanTypingInterval) {
            clearInterval(currentPlanTypingInterval);
            currentPlanTypingInterval = null;
        }
        currentPlanAbortController = null;
        for (const f of tempFiles) {
            try { fs.unlinkSync(f); logDebug(`handleDiscordMessage: cleaned up temp file: ${f}`); } catch { /* ignore */ }
        }
    }
    logDebug(`handleDiscordMessage: plan response received(${planResponse.length} chars)`);

    // パース
    logDebug(`handleDiscordMessage: raw plan response: ${planResponse.substring(0, 200)} `);
    const planOutput = parsePlanJson(planResponse);
    if (!planOutput) {
        logError('handleDiscordMessage: plan JSON parse failed');
        const formatted = FileIpc.extractResult(planResponse);
        const isFormatted = formatted !== planResponse;
        const warningHeader = '⚠️ Antigravity からの応答を解析できませんでした。';
        if (isFormatted) {
            await channel.send({ embeds: [buildEmbed(`${warningHeader}\n応答内容:\n${formatted}`, EmbedColor.Warning)] });
        } else {
            const preview = planResponse.substring(0, 800);
            await channel.send({ embeds: [buildEmbed(`${warningHeader}\n応答:\n\`\`\`\n${preview}\n\`\`\``, EmbedColor.Warning)] });
        }
        return null;
    }
    logDebug(`handleDiscordMessage: plan parsed — plan_id = ${planOutput.plan_id}, cron = ${planOutput.cron} `);

    const plan = buildPlan(planOutput, channel.id, channel.id);
    if (attachmentPaths && attachmentPaths.length > 0) {
        plan.attachment_paths = attachmentPaths;
    }
    return { plan, guild: channel.guild };
}

/**
 * 確認フロー: choice_mode に応じてユーザーの承認を待つ。
 * 承認されたら true、却下されたら false を返す。
 */
async function handleConfirmation(
    plan: Plan,
    channel: TextChannel,
    bot: DiscordBot,
): Promise<boolean> {
    const choiceMode = plan.choice_mode || 'none';
    const confirmMsg = buildConfirmMessage(plan);

    if (choiceMode === 'all') {
        await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Info)] });
        plan.status = 'active';
        return true;
    }
    if (choiceMode === 'multi') {
        const choiceCount = countChoiceItems(plan.discord_templates.confirm);
        const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
        const choices = await bot.waitForMultiChoice(sentMsg, choiceCount);
        if (choices.length === 0) {
            await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
            return false;
        }
        if (choices[0] === -1) {
            await channel.send({ embeds: [buildEmbed('✅ 全て選択しました。', EmbedColor.Success)] });
        } else {
            await channel.send({ embeds: [buildEmbed(`✅ 選択肢 ${choices.join(', ')} を選択しました。`, EmbedColor.Success)] });
        }
        plan.status = 'active';
        return true;
    }
    if (choiceMode === 'single') {
        const choiceCount = countChoiceItems(plan.discord_templates.confirm);
        const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
        const choice = await bot.waitForChoice(sentMsg, choiceCount);
        if (choice === -1) {
            await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
            return false;
        }
        await channel.send({ embeds: [buildEmbed(`✅ 選択肢 ${choice} を承認しました。`, EmbedColor.Success)] });
        plan.status = 'active';
        return true;
    }
    // choiceMode === 'none'
    const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
    const confirmed = await bot.waitForConfirmation(sentMsg);
    if (!confirmed) {
        await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
        return false;
    }
    plan.status = 'active';
    return true;
}

/**
 * Plan を即時実行キューに追加、または定期スケジュールとして登録する。
 */
async function dispatchPlan(
    ctx: BridgeContext,
    plan: Plan,
    channel: TextChannel,
    activeCdp: CdpBridge,
    wsNameFromCategory: string | undefined,
    guild: typeof import('discord.js').Guild.prototype | null,
): Promise<void> {
    const { bot, planStore, executor, executorPool, scheduler } = ctx;

    if (plan.cron === null) {
        const wsNameForImmediate = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
        if (wsNameForImmediate) { plan.workspace_name = wsNameForImmediate; }
        plan.notify_channel_id = channel.id;
        logDebug(`handleDiscordMessage: enqueueing immediate execution for plan ${plan.plan_id} (not persisted, workspace=${wsNameForImmediate || 'default'})`);
        if (executorPool) {
            await executorPool.enqueueImmediate(wsNameForImmediate || '', plan);
        } else if (executor) {
            await executor.enqueueImmediate(plan);
        }
    } else {
        logDebug(`handleDiscordMessage: registering scheduled plan ${plan.plan_id} with cron = ${plan.cron} `);
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
                logDebug(`handleDiscordMessage: created plan channel ${planChannelId} for plan ${plan.plan_id} (workspace=${wsName || 'default'})`);
            }
        }

        planStore!.add(plan);
        scheduler!.register(plan);
        const channelMention = plan.channel_id ? `<#${plan.channel_id}> ` : '#schedule';
        await channel.send({ embeds: [buildEmbed(`📅 定期実行を登録しました: \`${plan.cron}\` (${plan.timezone})\n結果は ${channelMention} チャンネルに通知されます。`, EmbedColor.Success)] });
    }
}


// ---------------------------------------------------------------------------
// メインディスパッチャー
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

    // セキュリティ: 許可ユーザーID制限
    const authResult = isUserAllowed(message.author.id);
    if (!authResult.allowed) {
        logWarn(`handleDiscordMessage: user ${message.author.tag} (${message.author.id}) not allowed — ${authResult.reason}`);
        await channel.send({ embeds: [buildEmbed(`🔒 ${authResult.reason}`, EmbedColor.Warning)] });
        return;
    }

    // セキュリティ: メッセージ長制限
    const maxLen = getMaxMessageLength();
    if (maxLen > 0 && text.length > maxLen) {
        logWarn(`handleDiscordMessage: message too long (${text.length} > ${maxLen}) from ${message.author.tag}`);
        await channel.send({ embeds: [buildEmbed(`⚠️ メッセージが長すぎます（${text.length}文字）。上限は ${maxLen} 文字です。`, EmbedColor.Warning)] });
        return;
    }

    // 返信コンテキスト解決
    text = await resolveReplyContext(channel, text, message.reference ?? undefined);

    // 依存モジュールの検証
    const wsNameFromCategory = DiscordBot.resolveWorkspaceFromChannel(channel) ?? undefined;
    const { bot, fileIpc, planStore, scheduler, cdp, cdpPool, executor } = ctx;
    if (!fileIpc || !planStore || !scheduler || !bot) {
        await channel.send({ embeds: [buildEmbed('⚠️ Bridge の内部モジュールが初期化されていません。', EmbedColor.Warning)] });
        return;
    }
    const useCdpPool = !!cdpPool;
    if (!useCdpPool && (!cdp || !executor)) {
        await channel.send({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
        return;
    }

    // メッセージプレビュー（ステータス追跡用）
    const msgPreview = text.substring(0, 50) + (text.length > 50 ? '...' : '') || '（添付ファイル）';
    const wsKeyForStatus = DiscordBot.resolveWorkspaceFromChannel(channel) || DEFAULT_WS_KEY;

    try {
        logDebug(`handleDiscordMessage: processing #${channelName} (intent = ${intent}) message: (${text.length} chars)`);

        // ステータス: 接続中
        currentProcessingStatuses.set(wsKeyForStatus, {
            wsKey: wsKeyForStatus, phase: 'connecting', startTime: Date.now(), messagePreview: msgPreview,
        });

        // CDP 接続の取得
        const connResult = await acquireCdpConnection(ctx, channel, wsNameFromCategory, fileIpc);
        if (!connResult) { return; }
        const { cdp: activeCdp, autoLaunched } = connResult;

        // ACK 送信（モデル/モード情報付き）
        try {
            const [currentMode, currentModel] = await Promise.all([
                getCurrentMode(activeCdp.ops).catch(() => null),
                getCurrentModel(activeCdp.ops).catch(() => null),
            ]);
            if (currentModel) { ctx.bot?.setModelName(currentModel); }
            const parts = [currentMode, currentModel].filter(Boolean);
            const ackPrefix = parts.length > 0 ? `[${parts.join(' - ')}]` : '';
            await channel.send({ embeds: [buildEmbed(`🔄 ${ackPrefix} 伝令中...`, EmbedColor.Info)] });
        } catch (sendErr) {
            logError('handleDiscordMessage: failed to send acknowledgement', sendErr);
        }

        // 添付ファイルのダウンロード
        let attachmentPaths: string[] | undefined;
        if (message.attachments.size > 0) {
            logDebug(`handleDiscordMessage: downloading ${message.attachments.size} attachment(s)...`);
            const downloaded = await downloadAttachments(message.attachments, fileIpc.getStoragePath(), fileIpc.createRequestId().requestId);
            if (downloaded.length > 0) {
                attachmentPaths = downloaded.map(d => d.localPath);
                logDebug(`handleDiscordMessage: ${downloaded.length} attachment(s) saved`);
            }
        }
        const resolvedWsPath = wsNameFromCategory ? getWorkspacePaths()[wsNameFromCategory] : undefined;

        // ステータス: Plan 生成中
        currentProcessingStatuses.set(wsKeyForStatus, {
            wsKey: wsKeyForStatus, phase: 'plan_generating', startTime: Date.now(), messagePreview: msgPreview,
        });

        // Plan 生成
        const result = await generatePlan(
            activeCdp, autoLaunched, fileIpc, channel, text, intent, channelName,
            attachmentPaths, ctx.extensionPath, resolvedWsPath,
        );
        if (!result) { return; }
        const { plan, guild } = result;

        // 計画詳細を Discord に表示
        try {
            const summaryText = plan.action_summary || plan.discord_templates.ack || plan.human_summary
                || plan.prompt.substring(0, 100) + (plan.prompt.length > 100 ? '...' : '');
            const execType = plan.cron ? `定期: \`${plan.cron}\`` : '即時実行';
            const confirmText = plan.requires_confirmation ? `要確認 (${plan.choice_mode || 'none'})` : '自動実行';
            await channel.send({
                embeds: [buildEmbed(
                    `📋 **実行計画**\n> **📝 概要:** ${summaryText}\n> **⏱️ 実行:** ${execType}　|　**🔐 確認:** ${confirmText}`,
                    EmbedColor.Info,
                )]
            });
        } catch (detailErr) {
            logDebug(`handleDiscordMessage: failed to send plan detail: ${detailErr}`);
        }

        // ACK 送信
        if (plan.discord_templates.ack) {
            await channel.send({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });
        }

        // 確認フロー
        if (plan.requires_confirmation) {
            // ステータス: 確認待ち
            currentProcessingStatuses.set(wsKeyForStatus, {
                wsKey: wsKeyForStatus, phase: 'confirming', startTime: Date.now(), messagePreview: msgPreview,
            });
            const confirmed = await handleConfirmation(plan, channel, bot);
            if (!confirmed) { return; }
        }

        // ステータス: ディスパッチ中
        currentProcessingStatuses.set(wsKeyForStatus, {
            wsKey: wsKeyForStatus, phase: 'dispatching', startTime: Date.now(), messagePreview: msgPreview,
        });

        // 即時実行 or 定期登録
        await dispatchPlan(ctx, plan, channel, activeCdp, wsNameFromCategory, guild);

    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleDiscordMessage failed', e);
        await channel.send({ embeds: [buildEmbed(`❌ エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)] });
    } finally {
        // 処理完了時にステータスをクリア
        currentProcessingStatuses.delete(wsKeyForStatus);
    }
}
