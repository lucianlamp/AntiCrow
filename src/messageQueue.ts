// ---------------------------------------------------------------------------
// messageQueue.ts — メッセージキュー管理モジュール
// ---------------------------------------------------------------------------
// 責務:
//   ワークスペース毎の排他制御キュー、処理ステータス追跡、
//   重複チェック、キャンセル機構を提供する。
// ---------------------------------------------------------------------------

import { Message, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logDebug, logError } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { t } from './i18n';
import { DiscordBot } from './discordBot';
import { cancelActiveConfirmation } from './discordReactions';

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
export const DEFAULT_WS_KEY = '__default__';

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

// ---------------------------------------------------------------------------
// キャンセル機構のアクセサ
// ---------------------------------------------------------------------------

export function getPlanAbortController(): AbortController | null {
    return currentPlanAbortController;
}

export function setPlanAbortController(ctrl: AbortController | null): void {
    currentPlanAbortController = ctrl;
}

export function getTeamAbortController(): AbortController | null {
    return currentTeamAbortController;
}

export function setTeamAbortController(ctrl: AbortController | null): void {
    currentTeamAbortController = ctrl;
}

export function getActivePlanTypingIntervals(): Set<ReturnType<typeof setInterval>> {
    return activePlanTypingIntervals;
}

export function getActivePlanProgressIntervals(): Set<ReturnType<typeof setInterval>> {
    return activePlanProgressIntervals;
}

// ---------------------------------------------------------------------------
// ステータス追跡のアクセサ
// ---------------------------------------------------------------------------

export function setProcessingStatus(wsKey: string, status: ProcessingStatus): void {
    currentProcessingStatuses.set(wsKey, status);
}

export function getProcessingStatus(wsKey: string): ProcessingStatus | undefined {
    return currentProcessingStatuses.get(wsKey);
}

export function deleteProcessingStatus(wsKey: string): void {
    currentProcessingStatuses.delete(wsKey);
}

// ---------------------------------------------------------------------------
// キューカウンタのアクセサ
// ---------------------------------------------------------------------------

export function getQueueCount(wsKey: string): number {
    return workspaceQueueCount.get(wsKey) ?? 0;
}

export function setQueueCount(wsKey: string, count: number): void {
    if (count <= 0) {
        workspaceQueueCount.delete(wsKey);
    } else {
        workspaceQueueCount.set(wsKey, count);
    }
}

export function getWorkspaceQueue(wsKey: string): Promise<void> {
    return workspaceQueues.get(wsKey) ?? Promise.resolve();
}

export function setWorkspaceQueue(wsKey: string, task: Promise<void>): void {
    workspaceQueues.set(wsKey, task);
}

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------

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
    for (const [wsKey, _queueCount] of workspaceQueueCount.entries()) {
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
    ctx: import('./bridgeContext').BridgeContext,
    message: Message,
    intent: import('./types').ChannelIntent,
    channelName: string,
    handleFn: (ctx: import('./bridgeContext').BridgeContext, message: Message, intent: import('./types').ChannelIntent, channelName: string) => Promise<void>,
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
                    await channel.send({ embeds: [buildEmbed(t('queue.autoDismissed'), EmbedColor.Warning)] });
                } catch (e) {
                    logDebug(`messageHandler: failed to send auto-dismiss notification: ${e}`);
                }
            } else {
                try {
                    const editBtn = new ButtonBuilder()
                        .setCustomId(`queue_edit_waiting_${msgId}`)
                        .setLabel(t('queue.editBtn'))
                        .setStyle(ButtonStyle.Primary);
                    const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(editBtn);
                    await channel.send({ embeds: [buildEmbed(t('queue.enqueued', String(prevCount)), EmbedColor.Info)], components: [editRow] });
                } catch (e) {
                    logDebug(`messageHandler: failed to send queue notification: ${e}`);
                }
            }
        } else {
            try {
                const editBtn = new ButtonBuilder()
                    .setCustomId(`queue_edit_waiting_${msgId}`)
                    .setLabel(t('queue.editBtn'))
                    .setStyle(ButtonStyle.Primary);
                const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(editBtn);
                await channel.send({ embeds: [buildEmbed(t('queue.enqueued', String(prevCount)), EmbedColor.Info)], components: [editRow] });
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
            await handleFn(ctx, message, intent, channelName);
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
