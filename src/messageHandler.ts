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
import { Message, TextChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { CdpBridge } from './cdpBridge';
import { WorkspaceConnectionError } from './cdpPool';
import { CascadePanelError } from './errors';
import { FileIpc } from './fileIpc';
import { parsePlanJson, buildPlan } from './planParser';
import { ChannelIntent, Plan } from './types';
import { logDebug, logError, logInfo, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord, normalizeHeadings } from './embedHelper';
import { splitForEmbeds } from './discordFormatter';
import { DiscordBot } from './discordBot';
import { downloadAttachments } from './attachmentDownloader';
import { BridgeContext } from './bridgeContext';
import { getResponseTimeout, isUserAllowed, getMaxMessageLength, getWorkspacePaths } from './configHelper';
import { getCurrentModel } from './cdpModels';
import { getCurrentMode } from './cdpModes';
import { AUTO_PROMPT, buildSuggestionRow, buildSuggestionContent, storeSuggestions } from './suggestionButtons';
import { parseSuggestions } from './suggestionParser';
import { loadTeamConfig } from './teamConfig';

// 委譲先モジュール
import { buildPlanPrompt, buildConfirmMessage, countChoiceItems, cronToPrefix } from './promptBuilder';
import { resolveWorkspace } from './workspaceResolver';
import { cancelActiveConfirmation } from './discordReactions';

// Re-export for backward compatibility
export { buildPlanPrompt, cronToPrefix } from './promptBuilder';

// ---------------------------------------------------------------------------
// メッセージ処理キュー（ワークスペース毎の排他制御）
// ---------------------------------------------------------------------------

/** ワークスペース毎のメッセージキュー */
const workspaceQueues = new Map<string, Promise<void>>();
/** ワークスペース毎のキュー待ち件数 */
const workspaceQueueCount = new Map<string, number>();
/** ワークスペース毎の待機中メッセージ情報（/queue 表示用） */
const workspaceWaitingMessages = new Map<string, { id: string; preview: string; content: string; enqueuedAt: number }[]>();
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
/** チームモード実行中の AbortController（キャンセル可能にする） */
let currentTeamAbortController: AbortController | null = null;
/** Plan 生成中の typing interval Set（複数並行時の上書き防止） */
const activePlanTypingIntervals = new Set<ReturnType<typeof setInterval>>();
/** Plan 生成中の progress interval Set（複数並行時の上書き防止） */
const activePlanProgressIntervals = new Set<ReturnType<typeof setInterval>>();

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

/**
 * ワークスペースのキューをリセットする（cancelPlanGeneration や内部リセットで使用）。
 * wsKey を指定すると対象ワークスペースのみリセット、省略時は全ワークスペース一括リセット。
 */
export function resetProcessingFlag(wsKey?: string): void {
    if (wsKey) {
        workspaceQueueCount.delete(wsKey);
        workspaceQueues.delete(wsKey);
        workspaceWaitingMessages.delete(wsKey);
        currentProcessingStatuses.delete(wsKey);
        logDebug(`messageHandler: workspace queue reset for "${wsKey}"`);
    } else {
        workspaceQueueCount.clear();
        workspaceQueues.clear();
        workspaceWaitingMessages.clear();
        currentProcessingStatuses.clear();
        logDebug('messageHandler: all workspace queues reset');
    }
}

/**
 * Plan 生成をキャンセルする（/cancel コマンド用）。
 * wsKey を指定すると対象ワークスペースのキュー状態のみクリア、
 * AbortController / typing / progress interval は全体に影響する（ワークスペース単位の分離は不可）。
 * wsKey 省略時は従来通り全クリア。
 */
export function cancelPlanGeneration(wsKey?: string): void {
    // AbortController と interval は全体共有リソースのため常に全クリア
    if (currentPlanAbortController) {
        currentPlanAbortController.abort();
        currentPlanAbortController = null;
        logDebug('messageHandler: plan generation AbortController triggered');
    }
    if (currentTeamAbortController) {
        currentTeamAbortController.abort();
        currentTeamAbortController = null;
        logDebug('messageHandler: team orchestration AbortController triggered');
    }
    for (const iv of activePlanTypingIntervals) {
        clearInterval(iv);
    }
    if (activePlanTypingIntervals.size > 0) {
        logDebug(`messageHandler: cleared ${activePlanTypingIntervals.size} plan typing interval(s)`);
        activePlanTypingIntervals.clear();
    }
    for (const iv of activePlanProgressIntervals) {
        clearInterval(iv);
    }
    if (activePlanProgressIntervals.size > 0) {
        logDebug(`messageHandler: cleared ${activePlanProgressIntervals.size} plan progress interval(s)`);
        activePlanProgressIntervals.clear();
    }
    // キュー状態のクリア（ワークスペース単位 or 全体）
    if (wsKey) {
        currentProcessingStatuses.delete(wsKey);
        workspaceQueueCount.delete(wsKey);
        workspaceWaitingMessages.delete(wsKey);
        // Promise チェーンをリセット（キャンセル後に次のメッセージが詰まるのを防止）
        workspaceQueues.delete(wsKey);
        logDebug(`messageHandler: cancelled plan generation for workspace "${wsKey}"`);
    } else {
        currentProcessingStatuses.clear();
        workspaceQueueCount.clear();
        workspaceWaitingMessages.clear();
        // 全 Promise チェーンをリセット
        workspaceQueues.clear();
        logDebug('messageHandler: cancelled plan generation for all workspaces');
    }
}

/** メッセージキューの状態を取得（/queue, /status コマンド用） */
export function getMessageQueueStatus(): {
    total: number;
    perWorkspace: Map<string, number>;
    processing: ProcessingStatus[];
    waiting: { id: string; preview: string; content: string; enqueuedAt: number }[];
} {
    const processing: ProcessingStatus[] = Array.from(currentProcessingStatuses.values());
    const waiting: { id: string; preview: string; content: string; enqueuedAt: number }[] = [];
    for (const msgs of workspaceWaitingMessages.values()) {
        waiting.push(...msgs);
    }
    // total は processing + waiting から算出（workspaceQueueCount との乖離を防止）
    const total = processing.length + waiting.length;
    const perWorkspace = new Map<string, number>();
    for (const [wsKey, count] of workspaceQueueCount.entries()) {
        if (count > 0) {
            perWorkspace.set(wsKey, count);
        }
    }
    return { total, perWorkspace, processing, waiting };
}

/** 待機中メッセージを全削除する（/queue 削除ボタン用） */
export function clearWaitingMessages(): number {
    let count = 0;
    for (const msgs of workspaceWaitingMessages.values()) {
        count += msgs.length;
    }
    workspaceWaitingMessages.clear();
    // キューカウントも待機分をリセット（処理中の分は残す）
    for (const [wsKey, queueCount] of workspaceQueueCount.entries()) {
        const processingCount = currentProcessingStatuses.has(wsKey) ? 1 : 0;
        workspaceQueueCount.set(wsKey, processingCount);
    }
    logDebug(`messageHandler: cleared ${count} waiting messages`);
    return count;
}

/** 待機中メッセージを1件削除する（/queue 個別削除ボタン用） */
export function removeWaitingMessage(msgId: string): boolean {
    for (const [wsKey, msgs] of workspaceWaitingMessages.entries()) {
        const idx = msgs.findIndex(w => w.id === msgId);
        if (idx >= 0) {
            msgs.splice(idx, 1);
            // キューカウントも1つ減らす
            const current = workspaceQueueCount.get(wsKey) ?? 0;
            if (current > 0) {
                workspaceQueueCount.set(wsKey, current - 1);
            }
            logDebug(`messageHandler: removed waiting message ${msgId}`);
            return true;
        }
    }
    return false;
}

/** 待機中メッセージの内容を編集する（キュー編集モーダル用） */
export function editWaitingMessage(msgId: string, newContent: string): boolean {
    for (const msgs of workspaceWaitingMessages.values()) {
        const entry = msgs.find(w => w.id === msgId);
        if (entry) {
            entry.content = newContent;
            entry.preview = newContent.substring(0, 50);
            logDebug(`messageHandler: edited waiting message ${msgId} (${newContent.length} chars)`);
            return true;
        }
    }
    return false;
}

/** 待機中メッセージの内容を取得する（キュー編集モーダルの初期値用） */
export function getWaitingMessageContent(msgId: string): string | null {
    for (const msgs of workspaceWaitingMessages.values()) {
        const entry = msgs.find(w => w.id === msgId);
        if (entry) {
            return entry.content;
        }
    }
    return null;
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

    // 待機メッセージ情報を記録（/queue 表示用）
    const fullContent = message.content || '';
    const preview = fullContent.substring(0, 50);
    if (prevCount > 0) {
        const waitingList = workspaceWaitingMessages.get(wsKey) ?? [];
        waitingList.push({ id: msgId, preview, content: fullContent, enqueuedAt: Date.now() });
        workspaceWaitingMessages.set(wsKey, waitingList);
    }

    // キューに待ちがある場合
    if (prevCount > 0) {
        // 確認フェーズ中なら自動却下して新しいメッセージを優先
        const currentStatus = currentProcessingStatuses.get(wsKey);
        if (currentStatus?.phase === 'confirming') {
            const channelId = channel.id;
            const cancelled = cancelActiveConfirmation(channelId);
            if (cancelled) {
                logDebug(`messageHandler: auto-dismissed confirmation for channel ${channelId}`);
                try {
                    await channel.send({ embeds: [buildEmbed('🔄 前のタスクの確認を自動却下しました。新しいメッセージを処理します。', EmbedColor.Warning)] });
                } catch (e) {
                    logDebug(`messageHandler: failed to send auto-dismiss notification: ${e}`);
                }
            } else {
                try {
                    const editBtn = new ButtonBuilder()
                        .setCustomId(`queue_edit_waiting_${msgId}`)
                        .setLabel('✏️ 編集する')
                        .setStyle(ButtonStyle.Primary);
                    const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(editBtn);
                    await channel.send({ embeds: [buildEmbed(`📥 キューに追加しました（待ち: ${prevCount}件）。前のタスク完了後に処理します。`, EmbedColor.Info)], components: [editRow] });
                } catch (e) {
                    logDebug(`messageHandler: failed to send queue notification: ${e}`);
                }
            }
        } else {
            try {
                const editBtn = new ButtonBuilder()
                    .setCustomId(`queue_edit_waiting_${msgId}`)
                    .setLabel('✏️ 編集する')
                    .setStyle(ButtonStyle.Primary);
                const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(editBtn);
                await channel.send({ embeds: [buildEmbed(`📥 キューに追加しました（待ち: ${prevCount}件）。前のタスク完了後に処理します。`, EmbedColor.Info)], components: [editRow] });
            } catch (e) {
                logDebug(`messageHandler: failed to send queue notification: ${e}`);
            }
        }
    }

    const currentQueue = workspaceQueues.get(wsKey) ?? Promise.resolve();
    const task = currentQueue.then(async () => {
        // 処理開始時に待機メッセージリストから該当エントリを取得し、編集済み内容を反映
        const waitingList = workspaceWaitingMessages.get(wsKey);
        if (waitingList) {
            const idx = waitingList.findIndex(w => w.id === msgId);
            if (idx >= 0) {
                const editedContent = waitingList[idx].content;
                if (editedContent && editedContent !== (message.content || '')) {
                    (message as any).content = editedContent;
                    logDebug(`messageHandler: applied edited content for message ${msgId} (${editedContent.length} chars)`);
                }
                waitingList.splice(idx, 1);
            }
        }
        try {
            await handleDiscordMessage(ctx, message, intent, channelName);
        } catch (e) {
            logError(`messageHandler: queued message processing failed (ws=${wsKey})`, e);
        } finally {
            // キューカウンターをデクリメント（0 になったらエントリ削除）
            const count = workspaceQueueCount.get(wsKey) ?? 1;
            const newCount = Math.max(0, count - 1);
            if (newCount === 0) {
                workspaceQueueCount.delete(wsKey);
            } else {
                workspaceQueueCount.set(wsKey, newCount);
            }
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
    const wsNameForMeta = DiscordBot.resolveWorkspaceFromChannel(channel) ?? undefined;
    fileIpc.writeRequestMeta(requestId, channel.id, wsNameForMeta);
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

    // typing indicator 開始（Set で管理し、複数並行時の上書きを防止）
    const myTypingInterval = setInterval(async () => {
        try { await channel.sendTyping(); } catch (e) { logDebug(`handleDiscordMessage: sendTyping failed: ${e}`); }
    }, 8_000);
    activePlanTypingIntervals.add(myTypingInterval);
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

        // 計画生成中の進捗報告（Set で管理し、複数並行時の上書きを防止）
        let lastPlanProgress = '';
        const myProgressInterval = setInterval(async () => {
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
        activePlanProgressIntervals.add(myProgressInterval);

        const responseTimeout = getResponseTimeout();
        fileIpc.registerActiveRequest(requestId, tempFiles);
        try {
            planResponse = await fileIpc.waitForResponse(responsePath, responseTimeout, abortController.signal);
        } finally {
            fileIpc.unregisterActiveRequest(requestId, tempFiles);
            clearInterval(myProgressInterval);
            activePlanProgressIntervals.delete(myProgressInterval);
            fileIpc.cleanupProgress(progressPath).catch(() => { });
        }
    } finally {
        clearInterval(myTypingInterval);
        activePlanTypingIntervals.delete(myTypingInterval);
        currentPlanAbortController = null;
        for (const f of tempFiles) {
            try { fs.unlinkSync(f); logDebug(`handleDiscordMessage: cleaned up temp file: ${f}`); } catch { /* ignore */ }
        }
    }
    logDebug(`handleDiscordMessage: plan response received(${planResponse.length} chars)`);

    const planOutput = parsePlanJson(planResponse);
    if (!planOutput) {
        // Plan JSON として解析できなかった
        const trimmed = planResponse.trim();

        // 検出1: 壊れた計画JSON（plan_id や prompt を含むが不正形式）
        if (trimmed.startsWith('{') && (trimmed.includes('"plan_id"') || trimmed.includes('"prompt"'))) {
            logWarn('handleDiscordMessage: broken plan JSON detected, aborting to prevent raw JSON leak');
            await channel.send({ embeds: [buildEmbed('❌ 計画の生成に失敗しました（JSONフォーマットエラー）。もう一度指示をお試しください。', EmbedColor.Error)] });
            return null;
        }

        // 検出2: plan_generation なのに Markdown 形式で返ってきた場合
        // （Markdown ヘッダー、太字、箇条書き、絵文字で始まるテキストを検出）
        const looksLikeMarkdown = /^(?:#|\*\*|[-•]|[✅❌🔧📋📸💡⚠️🎉])/.test(trimmed);
        if (looksLikeMarkdown) {
            logWarn(`handleDiscordMessage: plan_generation response appears to be Markdown instead of JSON (${trimmed.substring(0, 80)}...)`);
            logWarn('handleDiscordMessage: this indicates the AI returned Markdown for a plan_generation task — forwarding as-is but this should be corrected');
        } else {
            logWarn('handleDiscordMessage: plan JSON parse failed, forwarding as markdown');
        }

        const formatted = FileIpc.extractResult(planResponse);
        const content = formatted !== planResponse ? formatted : planResponse;
        // normalizeHeadings + splitForEmbeds で長文分割 Embed 送信
        const normalized = normalizeHeadings(content);
        const embedGroups = splitForEmbeds(normalized);
        for (const group of embedGroups) {
            const embeds = group.map((desc) =>
                new EmbedBuilder()
                    .setDescription(desc)
                    .setColor(EmbedColor.Info)
            );
            await channel.send({ embeds });
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

/** handleConfirmation の返り値 */
interface ConfirmationResult {
    confirmed: boolean;
    /** single/multi で選択された番号（1-indexed）。全選択は [-1]。none/all は undefined。 */
    selectedChoices?: number[];
    /** エージェントに委任された場合 true */
    agentDelegated?: boolean;
}

/**
 * 確認フロー: choice_mode に応じてユーザーの承認を待つ。
 * 承認されたら confirmed: true と選択結果を返す。却下されたら confirmed: false。
 */
async function handleConfirmation(
    plan: Plan,
    channel: TextChannel,
    bot: DiscordBot,
): Promise<ConfirmationResult> {
    const choiceMode = plan.choice_mode || 'none';
    const confirmMsg = buildConfirmMessage(plan);

    if (choiceMode === 'all') {
        await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Info)] });
        plan.status = 'active';
        return { confirmed: true };
    }
    if (choiceMode === 'multi') {
        const choiceCount = countChoiceItems(plan.discord_templates.confirm);
        const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
        const choices = await bot.waitForMultiChoice(sentMsg, choiceCount);
        if (choices.length === 0) {
            await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
            return { confirmed: false };
        }
        if (choices.length === 1 && choices[0] === 0) {
            await channel.send({ embeds: [buildEmbed('🤖 **エージェントの判断で次のアクションを実行します**', EmbedColor.Info)] });
            return { confirmed: false, agentDelegated: true };
        }
        if (choices[0] === -1) {
            await channel.send({ embeds: [buildEmbed('✅ 全て選択しました。', EmbedColor.Success)] });
        } else {
            await channel.send({ embeds: [buildEmbed(`✅ 選択肢 ${choices.join(', ')} を選択しました。`, EmbedColor.Success)] });
        }
        plan.status = 'active';
        return { confirmed: true, selectedChoices: choices };
    }
    if (choiceMode === 'single') {
        const choiceCount = countChoiceItems(plan.discord_templates.confirm);
        const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
        const choice = await bot.waitForChoice(sentMsg, choiceCount);
        if (choice === -1) {
            await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
            return { confirmed: false };
        }
        if (choice === 0) {
            await channel.send({ embeds: [buildEmbed('🤖 **エージェントの判断で次のアクションを実行します**', EmbedColor.Info)] });
            return { confirmed: false, agentDelegated: true };
        }
        await channel.send({ embeds: [buildEmbed(`✅ 選択肢 ${choice} を承認しました。`, EmbedColor.Success)] });
        plan.status = 'active';
        return { confirmed: true, selectedChoices: [choice] };
    }
    // choiceMode === 'none'
    const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
    const confirmed = await bot.waitForConfirmation(sentMsg);
    if (!confirmed) {
        await channel.send({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
        return { confirmed: false };
    }
    plan.status = 'active';
    return { confirmed: true };
}

/**
 * 選択結果を plan.prompt の先頭に付加する。
 * single/multi の場合のみ。全選択（[-1]）の場合は修正不要。
 */
function applyChoiceSelection(plan: Plan, selectedChoices?: number[]): void {
    if (!selectedChoices || selectedChoices.length === 0) { return; }
    // 全選択（[-1]）の場合は prompt 修正不要
    if (selectedChoices.length === 1 && selectedChoices[0] === -1) { return; }
    const choiceStr = selectedChoices.join(', ');
    plan.prompt = `【重要】ユーザーは以下のリストから選択肢 ${choiceStr} を選びました。選択された項目のみを実行してください。他の項目は無視してください。\n\n${plan.prompt}`;
    logDebug(`messageHandler: applied choice selection [${choiceStr}] to plan prompt`);
}

/**
 * Plan を即時実行キューに追加、または定期スケジュールとして登録する。
 * チームモード有効時は teamOrchestrator 経由でサブエージェントに委譲する。
 */
async function dispatchPlan(
    ctx: BridgeContext,
    plan: Plan,
    channel: TextChannel,
    activeCdp: CdpBridge,
    wsNameFromCategory: string | undefined,
    guild: typeof import('discord.js').Guild.prototype | null,
    isTeamMode = false,
): Promise<void> {
    const { bot, fileIpc, planStore, executor, executorPool, scheduler } = ctx;

    if (plan.cron === null) {
        const wsNameForImmediate = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
        if (wsNameForImmediate) { plan.workspace_name = wsNameForImmediate; }
        plan.notify_channel_id = channel.id;

        // -------------------------------------------------------------------
        // チームモード: IPC ファイルベースのオーケストレーション
        // -------------------------------------------------------------------
        let teamModeFallback = false; // チームモード分割失敗時のフォールバックフラグ
        if (isTeamMode && ctx.teamOrchestrator) {
            logDebug(`dispatchPlan: Team mode — IPC-based orchestration (workspace=${wsNameForImmediate || 'default'})`);

            // AI 委任方式: plan.tasks の有無でチームモード使用を判断
            // plan_generation フェーズで AI が tasks 配列を出力した場合のみチームモード実行
            // tasks がない場合はメインエージェント単独実行にフォールバック
            if (plan.tasks && plan.tasks.length > 1) {
                try {
                    await channel.send({ embeds: [buildEmbed(`🤖 **チームモード**: AI が ${plan.tasks.length} 個のタスクに分割済み。サブエージェントに指令を作成中...`, EmbedColor.Info)] });
                    logDebug(`dispatchPlan: Team mode — AI provided ${plan.tasks.length} tasks`);

                    // maxAgents に従ってグループ化（WS別のrepoRootを使用）
                    const teamRepoRoot = (() => {
                        if (wsNameFromCategory) {
                            const wsPaths = ctx.cdpPool?.getResolvedWorkspacePaths() ?? {};
                            if (wsPaths[wsNameFromCategory]) { return wsPaths[wsNameFromCategory]; }
                        }
                        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    })();
                    const teamConfig = loadTeamConfig(teamRepoRoot);
                    const tasks = ctx.teamOrchestrator.groupTasks(plan.tasks, teamConfig.maxAgents);
                    logDebug(`dispatchPlan: Team mode — grouped ${plan.tasks.length} tasks into ${tasks.length} groups (maxAgents=${teamConfig.maxAgents})`);

                    const teamRequestId = `team_${Date.now()}`;
                    const instructions = ctx.teamOrchestrator.writeInstructionFiles(
                        tasks,
                        teamRequestId,
                        plan.prompt, // 元のユーザーリクエストをコンテキストとして渡す
                    );

                    await channel.send({ embeds: [buildEmbed(`📋 ${plan.tasks.length}個のタスクを${tasks.length}個のサブエージェントに割り振りました。起動中...`, EmbedColor.Info)] });

                    // Phase 3~5: サブエージェント起動 → 実行 → レスポンス収集
                    const abortController = new AbortController();
                    currentTeamAbortController = abortController;
                    let teamResult: Awaited<ReturnType<typeof ctx.teamOrchestrator.orchestrateTeam>> | null = null;

                    try {
                        teamResult = await ctx.teamOrchestrator.orchestrateTeam(
                            instructions,
                            channel.id,
                            wsNameForImmediate,
                            abortController.signal,
                        );

                        // Phase 5: 報告 IPC ファイルを生成 → メインエージェントに報告プロンプト送信
                        const { requestId: reportReqId, responsePath: reportResponsePath } = fileIpc!.createRequestId();
                        logDebug(`dispatchPlan: Team mode — reportReqId=${reportReqId}, reportResponsePath=${reportResponsePath}`);
                        const reportPath = ctx.teamOrchestrator.writeReportFile(
                            teamRequestId,
                            teamResult.results,
                            instructions,
                            reportResponsePath,
                        );

                        // メインエージェントに報告プロンプトを送信（ファイル読み取り方式）:
                        const reportInstructionPath = ctx.teamOrchestrator.writeReportInstructionFile(
                            teamRequestId,
                            reportPath,
                            reportResponsePath,
                        );
                        const reportPrompt =
                            `あなたはメインエージェントです。以下のファイルを view_file ツールで読み込み、その指示に従ってください。\n` +
                            `ファイルパス: ${reportInstructionPath}` +
                            `\n\n重要:\n` +
                            `- 全サブエージェントの報告を確認してください\n` +
                            `- 統合レポートを作成し、response_path に Markdown で書き込んでください（write_to_file）\n` +
                            `- response_path: ${reportResponsePath}\n` +
                            `- レポートにはすべてのタスクの結果・成否・注意点をまとめてください\n` +
                            `- ユーザー向けにわかりやすい報告書を作成してください\n` +
                            `- 必ず response_path に write_to_file で書き込んでください。書き込まないと完了と見なされません`;

                        logDebug(`dispatchPlan: Team mode — sending report prompt to main Cascade (${reportPrompt.length} chars)`);

                        await activeCdp.sendPrompt(reportPrompt);
                        logDebug('dispatchPlan: Team mode — report prompt sent, waiting for response...');

                        // メインエージェントの統合レポートを待機
                        const cascadeReportTimeoutMs = 300_000;
                        fileIpc!.registerActiveRequest(reportReqId);
                        try {
                            const cascadeResponse = await fileIpc!.waitForResponse(reportResponsePath, cascadeReportTimeoutMs);
                            logDebug(`dispatchPlan: Team mode — received Cascade integrated report (${cascadeResponse.length} chars)`);

                            // 統合レポートを Discord に送信（suggestion 分離）
                            const formatted = FileIpc.extractResult(cascadeResponse);
                            logDebug(`dispatchPlan: Team mode — extractResult returned ${formatted.length} chars (original: ${cascadeResponse.length} chars)`);

                            // 提案タグを抽出してクリーンコンテンツを取得
                            const { suggestions, cleanContent } = parseSuggestions(formatted);

                            const normalized = normalizeHeadings(cleanContent);
                            const embedGroups = splitForEmbeds(normalized);
                            logDebug(`dispatchPlan: Team mode — sending ${embedGroups.length} embed groups to Discord`);
                            for (const group of embedGroups) {
                                const embeds = group.map((desc) =>
                                    new EmbedBuilder()
                                        .setDescription(desc)
                                        .setColor(EmbedColor.Success)
                                );
                                await channel.send({ embeds });
                            }

                            // 提案ボタンを送信（通常モードと同じ処理）
                            if (suggestions.length > 0 && bot) {
                                try {
                                    const row = buildSuggestionRow(suggestions);
                                    if (row) {
                                        storeSuggestions(channel.id, suggestions);
                                        const suggestionText = buildSuggestionContent(suggestions);
                                        const suggestionEmbed = buildEmbed(suggestionText, EmbedColor.Suggest);
                                        await bot.sendComponentsToChannel(channel.id, [row], suggestionEmbed);
                                        logDebug(`dispatchPlan: Team mode — sent ${suggestions.length} suggestion buttons`);
                                    }
                                } catch (e) {
                                    logDebug(`dispatchPlan: Team mode — failed to send suggestion buttons: ${e instanceof Error ? e.message : e}`);
                                }
                            }
                            logInfo('dispatchPlan: Team mode — integrated report sent to Discord ✅');
                        } finally {
                            fileIpc!.unregisterActiveRequest(reportReqId);
                        }
                    } catch (cascadeErr) {
                        // Cascade 送信/待機に失敗した場合はフォールバック: 個別結果を直接送信
                        logWarn(`dispatchPlan: Team mode — failed to get integrated report, falling back: ${cascadeErr instanceof Error ? cascadeErr.message : cascadeErr}`);
                        await channel.send({ embeds: [buildEmbed('⚠️ 統合レポートの生成に失敗しました。個別結果を表示します。', EmbedColor.Warning)] });

                        // フォールバック: 各サブエージェントの結果を個別に送信
                        if (teamResult) {
                            for (const result of teamResult.results) {
                                const statusEmoji = result.success ? '✅' : '❌';
                                const resultPreview = result.response.substring(0, 500) + (result.response.length > 500 ? '...' : '');
                                const normalized = normalizeHeadings(`${statusEmoji} **${result.agentName}**\n${resultPreview}`);
                                const embedGroups = splitForEmbeds(normalized);
                                for (const group of embedGroups) {
                                    const embeds = group.map((desc) =>
                                        new EmbedBuilder()
                                            .setDescription(desc)
                                            .setColor(result.success ? EmbedColor.Success : EmbedColor.Error)
                                    );
                                    await channel.send({ embeds });
                                }
                            }
                        }
                    } finally {
                        currentTeamAbortController = null;
                    }
                    return;
                } catch (e) {
                    const errMsg = e instanceof Error ? e.message : String(e);
                    logError(`dispatchPlan: Team orchestration failed: ${errMsg}`, e);
                    await channel.send({ embeds: [buildEmbed(`❌ チームモード実行エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)] });
                    teamModeFallback = true;
                }
            } else {
                // plan.tasks がない → AI がチームモード不要と判断
                logDebug('dispatchPlan: Team mode — no plan.tasks provided by AI, falling back to normal mode');
                await channel.send({ embeds: [buildEmbed('📋 メインエージェントで実行します（チームモード対象外）', EmbedColor.Info)] });
                teamModeFallback = true;
            }

            if (!teamModeFallback) {
                return;
            }
            logDebug('dispatchPlan: Team mode fallback — continuing to normal mode execution');
        }

        // -------------------------------------------------------------------
        // 通常モード: executor / executorPool 経由
        // -------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // チームモード判定: 有効時もメインエージェントがオーケストレーターとして実行
    // （Plan 生成 → 承認 → メインエージェントで実行。サブエージェントはメインが指揮）
    // -----------------------------------------------------------------------
    // ワークスペースパスの解決: Discordカテゴリー → ワークスペースパス設定 → フォールバック
    const resolvedRepoRoot = (() => {
        if (wsNameFromCategory) {
            const wsPaths = ctx.cdpPool?.getResolvedWorkspacePaths() ?? {};
            if (wsPaths[wsNameFromCategory]) {
                return wsPaths[wsNameFromCategory];
            }
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    })();
    let isTeamMode = false;
    if (resolvedRepoRoot) {
        const teamConfig = loadTeamConfig(resolvedRepoRoot);
        if (teamConfig.enabled && ctx.teamOrchestrator) {
            isTeamMode = true;
            logDebug(`handleDiscordMessage: Team mode enabled for workspace "${wsNameFromCategory || 'local'}" (repoRoot=${resolvedRepoRoot}) — main agent will orchestrate`);
        }
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
            // cascade コンテキスト汚染防止（接続処理後の残留コンテキストをリセット）
            activeCdp.ops.resetCascadeContext();
            // 直列呼び出し（並列だと cascade コンテキストが競合して取得失敗する）
            const currentMode = await getCurrentMode(activeCdp.ops).catch(() => null);
            activeCdp.ops.resetCascadeContext();
            const currentModel = await getCurrentModel(activeCdp.ops).catch(() => null);
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
        const resolvedWsPath = wsNameFromCategory ? (ctx.cdpPool?.getResolvedWorkspacePaths() ?? {})[wsNameFromCategory] : undefined;

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
            const confirmResult = await handleConfirmation(plan, channel, bot);
            if (confirmResult.agentDelegated) {
                // エージェント委任: AUTO_PROMPT を processSuggestionPrompt 経由で実行
                processSuggestionPrompt(ctx, channel.id, AUTO_PROMPT, message.author.id).catch((e: unknown) => {
                    logError('agent delegation from confirmation: processSuggestionPrompt failed', e);
                });
                return;
            }
            if (!confirmResult.confirmed) { return; }
            applyChoiceSelection(plan, confirmResult.selectedChoices);
        }

        // チームモード: サブエージェント向けのタスク指示を付加
        if (isTeamMode) {
            plan.prompt = `【サブエージェントタスク】以下のタスクを実行してください。\n` +
                `結果は明確かつ詳細に記述してください。\n\n` +
                plan.prompt;
            logDebug(`handleDiscordMessage: Team mode — augmented prompt with subagent instructions`);
        }

        // ステータス: ディスパッチ中
        currentProcessingStatuses.set(wsKeyForStatus, {
            wsKey: wsKeyForStatus, phase: 'dispatching', startTime: Date.now(), messagePreview: msgPreview,
        });

        // 即時実行 or 定期登録
        await dispatchPlan(ctx, plan, channel, activeCdp, wsNameFromCategory, guild, isTeamMode);

    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes('aborted')) {
            logDebug(`handleDiscordMessage: aborted (expected via /cancel)`);
        } else {
            logError('handleDiscordMessage failed', e);
            await channel.send({ embeds: [buildEmbed(`❌ エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)] });
        }
    } finally {
        // 処理完了時にステータスをクリア
        currentProcessingStatuses.delete(wsKeyForStatus);
    }
}

// ---------------------------------------------------------------------------
// 提案ボタンからのプロンプト処理（handleDiscordMessage の簡易版）
// ---------------------------------------------------------------------------

/**
 * 提案ボタンクリック時に呼ばれる。channelId とプロンプトテキストを受け取り、
 * メッセージパイプライン（Plan 生成→確認→実行）に流す。
 */
export async function processSuggestionPrompt(
    ctx: BridgeContext,
    channelId: string,
    promptText: string,
    userId: string,
): Promise<void> {
    // 認証チェック
    const authResult = isUserAllowed(userId);
    if (!authResult.allowed) {
        logWarn(`processSuggestionPrompt: user ${userId} not allowed — ${authResult.reason}`);
        return;
    }

    // Bot & FileIpc チェック
    const { bot, fileIpc, cdpPool, cdp: fallbackCdp } = ctx;
    if (!bot || !fileIpc) {
        logWarn('processSuggestionPrompt: bot or fileIpc not initialized');
        return;
    }

    const client = (bot as any).client;
    if (!client) {
        logWarn('processSuggestionPrompt: bot client not available');
        return;
    }

    let channel: TextChannel;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (!fetched || !(fetched instanceof TextChannel)) {
            logWarn(`processSuggestionPrompt: channel ${channelId} not found or not text channel`);
            return;
        }
        channel = fetched;
    } catch (e) {
        logWarn(`processSuggestionPrompt: failed to fetch channel ${channelId}: ${e instanceof Error ? e.message : e}`);
        return;
    }

    const channelName = channel.name;
    logDebug(`processSuggestionPrompt: processing suggestion in #${channelName} (${promptText.length} chars)`);

    // ワークスペース解決
    const wsKey = DiscordBot.resolveWorkspaceFromChannel(channel) || DEFAULT_WS_KEY;

    // キューに追加して直列処理
    const prevCount = workspaceQueueCount.get(wsKey) ?? 0;
    workspaceQueueCount.set(wsKey, prevCount + 1);

    const currentQueue = workspaceQueues.get(wsKey) ?? Promise.resolve();
    const task = currentQueue.then(async () => {
        try {
            // ACK 送信
            try {
                await channel.send({ embeds: [buildEmbed('💡 提案されたタスクを実行中...', EmbedColor.Info)] });
            } catch { /* ignore */ }

            // ワークスペース解決（カテゴリーから特定）
            const wsNameFromCategory = DiscordBot.resolveWorkspaceFromChannel(channel);

            // CdpBridge 取得
            currentProcessingStatuses.set(wsKey, {
                wsKey, phase: 'connecting', startTime: Date.now(),
                messagePreview: promptText.substring(0, 50),
            });

            let activeCdp: CdpBridge;
            if (wsNameFromCategory && cdpPool) {
                try {
                    activeCdp = await cdpPool.acquire(wsNameFromCategory);
                } catch (e) {
                    logError(`processSuggestionPrompt: failed to acquire CdpBridge for workspace "${wsNameFromCategory}"`, e);
                    const displayMsg = (e instanceof WorkspaceConnectionError)
                        ? e.userMessage
                        : `ワークスペース "${wsNameFromCategory}" への接続に失敗しました: ${sanitizeErrorForDiscord(e instanceof Error ? e.message : String(e))}`;
                    await channel.send({ embeds: [buildEmbed(`⚠️ ${displayMsg}`, EmbedColor.Warning)] });
                    return;
                }
            } else if (fallbackCdp) {
                activeCdp = fallbackCdp;
            } else {
                await channel.send({ embeds: [buildEmbed('⚠️ Bridge が未接続です。`/status` を確認してください。', EmbedColor.Warning)] });
                return;
            }

            // Plan 生成ステータス
            currentProcessingStatuses.set(wsKey, {
                wsKey, phase: 'plan_generating', startTime: Date.now(),
                messagePreview: promptText.substring(0, 50),
            });

            const wsPaths = cdpPool?.getResolvedWorkspacePaths() ?? {};
            const resolvedWsPath = wsNameFromCategory ? wsPaths[wsNameFromCategory] : undefined;

            const result = await generatePlan(
                activeCdp, false, fileIpc, channel,
                promptText, 'agent-chat', channelName,
                undefined, ctx.extensionPath, resolvedWsPath,
            );
            if (!result) { return; }

            const { plan, guild } = result;

            // 確認フロー
            if (plan.requires_confirmation) {
                currentProcessingStatuses.set(wsKey, {
                    wsKey, phase: 'confirming', startTime: Date.now(),
                    messagePreview: promptText.substring(0, 50),
                });
                const confirmResult = await handleConfirmation(plan, channel, bot);
                if (confirmResult.agentDelegated) {
                    processSuggestionPrompt(ctx, channel.id, AUTO_PROMPT, userId).catch((e: unknown) => {
                        logError('agent delegation from suggestion confirmation: processSuggestionPrompt failed', e);
                    });
                    return;
                }
                if (!confirmResult.confirmed) { return; }
                applyChoiceSelection(plan, confirmResult.selectedChoices);
            }

            // ディスパッチ
            currentProcessingStatuses.set(wsKey, {
                wsKey, phase: 'dispatching', startTime: Date.now(),
                messagePreview: promptText.substring(0, 50),
            });

            await dispatchPlan(ctx, plan, channel, activeCdp, wsNameFromCategory ?? undefined, guild);
        } catch (e) {
            logError('processSuggestionPrompt failed', e);
            const errMsg = e instanceof Error ? e.message : String(e);
            await channel.send({ embeds: [buildEmbed(`❌ エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)] });
        } finally {
            const count = workspaceQueueCount.get(wsKey) ?? 1;
            workspaceQueueCount.set(wsKey, Math.max(0, count - 1));
            currentProcessingStatuses.delete(wsKey);
        }
    });
    workspaceQueues.set(wsKey, task);
}
