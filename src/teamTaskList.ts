// ---------------------------------------------------------------------------
// teamTaskList.ts — 共有タスクリスト管理（生成・更新・ポーリング・サマリー）
// ---------------------------------------------------------------------------
// teamOrchestrator.ts から分割。
// generateSharedTaskList(), updateSharedTaskStatus(), pollTaskListStatus(),
// buildProgressSummary() を独立モジュールとして提供。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logInfo, logWarn } from './logger';
import type { TeamInstruction } from './subagentTypes';
import type { DiscordSender } from './teamOrchestrator';

// ---------------------------------------------------------------------------
// generateSharedTaskList
// ---------------------------------------------------------------------------

/**
 * 共有タスクリスト JSON を生成する。
 * チーム全体のタスク一覧をファイルに書き出し、サブエージェントが読み書きできるようにする。
 * ヘルプモード用にフルタスク内容と利用ガイドも含める。
 */
export function generateSharedTaskList(
    ipcDir: string,
    instructions: TeamInstruction[],
    requestId: string,
): string {
    const taskListPath = path.join(ipcDir, `team_tasklist_${requestId}.json`);
    const taskList = {
        requestId,
        createdAt: Date.now(),
        _guide: {
            description: 'チーム全体のタスク一覧。各サブエージェントは自分のタスク完了後にこのファイルを確認し、pendingタスクがあれば手伝う。',
            statusValues: {
                pending: '未着手（手伝い可能）',
                in_progress: '作業中（他エージェントが担当中。ファイルを上書きしないこと）',
                completed: '完了',
                failed: '失敗',
                helped: 'オーケストレーターがヘルプを割り当て済み',
                helping: '他エージェントがヘルプ中',
            },
            howToHelp: '1. statusがpendingのタスクを探す → 2. fullTaskの内容を実行 → 3. 他エージェントのファイルは上書きしない',
        },
        tasks: instructions.map(inst => ({
            agentIndex: inst.agentIndex,
            taskSummary: inst.task.substring(0, 200) + (inst.task.length > 200 ? '...' : ''),
            fullTask: inst.task,
            status: 'pending' as string,
            assignedTo: `anti-crow-subagent-${inst.agentIndex}`,
            startedAt: null as number | null,
            completedAt: null as number | null,
        })),
    };

    fs.writeFileSync(taskListPath, JSON.stringify(taskList, null, 2), 'utf-8');
    logInfo(`[TeamTaskList] 共有タスクリスト生成: ${taskListPath} (${instructions.length} タスク)`);
    return taskListPath;
}

// ---------------------------------------------------------------------------
// updateSharedTaskStatus
// ---------------------------------------------------------------------------

/**
 * 共有タスクリストの特定タスクのステータスを更新する。
 * orchestrator 側からのステータス更新用（helped など）。
 */
export function updateSharedTaskStatus(
    taskListPath: string,
    agentIndex: number,
    status: string,
): void {
    try {
        const content = fs.readFileSync(taskListPath, 'utf-8');
        const taskList = JSON.parse(content);
        const task = taskList.tasks?.find((t: { agentIndex: number }) => t.agentIndex === agentIndex);
        if (task) {
            task.status = status;
            if (status === 'completed' || status === 'failed' || status === 'helped') {
                task.completedAt = Date.now();
            }
            if (status === 'in_progress') {
                task.startedAt = Date.now();
            }
            fs.writeFileSync(taskListPath, JSON.stringify(taskList, null, 2), 'utf-8');
            logDebug(`[TeamTaskList] タスクリスト更新: agent${agentIndex} -> ${status}`);
        }
    } catch (e) {
        logWarn(`[TeamTaskList] タスクリスト更新失敗: ${e}`);
    }
}

// ---------------------------------------------------------------------------
// pollTaskListStatus
// ---------------------------------------------------------------------------

/**
 * 共有タスクリストファイルをポーリングし、ステータス変化を Discord にリアルタイム通知する。
 * 5秒間隔でファイルを読み込み、前回状態との差分を検出。
 */
export async function pollTaskListStatus(
    taskListPath: string,
    channelId: string,
    sendToDiscord: DiscordSender,
    signal: AbortSignal,
): Promise<void> {
    const POLL_INTERVAL_MS = 5000;
    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'helped']);
    const STATUS_EMOJI: Record<string, string> = {
        'in_progress': '🔄',
        'completed': '✅',
        'failed': '❌',
        'helped': '🤝',
    };

    // 前回のステータスマップ（agentIndex -> status）
    let prevStatuses = new Map<number, string>();

    // 初期状態を読み込み
    try {
        const content = fs.readFileSync(taskListPath, 'utf-8');
        const taskList = JSON.parse(content);
        for (const task of taskList.tasks || []) {
            prevStatuses.set(task.agentIndex, task.status);
        }
    } catch { /* ignore initial read error */ }

    logInfo(`[TeamTaskList] タスクリストポーリング開始: ${taskListPath}`);

    while (!signal.aborted) {
        // 待機
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, POLL_INTERVAL_MS);
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });

        if (signal.aborted) break;

        try {
            const content = fs.readFileSync(taskListPath, 'utf-8');
            const taskList = JSON.parse(content);
            const tasks: Array<{ agentIndex: number; status: string; task: string }> = taskList.tasks || [];

            // 個別ステータスファイルを読み取り、タスクリストに統合
            const statusDir = path.dirname(taskListPath);
            const requestIdMatch = path.basename(taskListPath).match(/team_tasklist_(.+)\.json/);
            const taskRequestId = requestIdMatch ? requestIdMatch[1] : '';

            for (const task of tasks) {
                const agentStatusFile = path.join(statusDir, `team_status_${taskRequestId}_agent${task.agentIndex}.json`);
                try {
                    const statusContent = fs.readFileSync(agentStatusFile, 'utf-8');
                    const agentStatus = JSON.parse(statusContent);
                    if (agentStatus && typeof agentStatus.status === 'string') {
                        task.status = agentStatus.status;
                    }
                } catch { /* 個別ファイルがまだ存在しない場合は無視 */ }
            }

            // ステータス変化を検出
            const changes: Array<{ agentIndex: number; oldStatus: string; newStatus: string; task: string }> = [];
            for (const task of tasks) {
                const prev = prevStatuses.get(task.agentIndex) || 'pending';
                if (task.status !== prev) {
                    changes.push({
                        agentIndex: task.agentIndex,
                        oldStatus: prev,
                        newStatus: task.status,
                        task: task.task,
                    });
                    prevStatuses.set(task.agentIndex, task.status);
                }
            }

            // 変化があれば Discord に通知
            if (changes.length > 0) {
                for (const change of changes) {
                    const emoji = STATUS_EMOJI[change.newStatus] || '🔔';
                    // completed の通知は既存の完了通知と重複するためスキップ
                    if (change.newStatus === 'completed') continue;

                    let msg = '';
                    if (change.newStatus === 'in_progress') {
                        msg = `${emoji} サブエージェント${change.agentIndex} がタスクを開始しました`;
                    } else if (change.newStatus === 'helped') {
                        msg = `${emoji} サブエージェント${change.agentIndex} のタスクにヘルプが入りました`;
                    } else if (change.newStatus === 'failed') {
                        msg = `${emoji} サブエージェント${change.agentIndex} のタスクが失敗しました`;
                    } else {
                        msg = `${emoji} サブエージェント${change.agentIndex}: ${change.oldStatus} → ${change.newStatus}`;
                    }
                    await sendToDiscord(channelId, msg);
                }
            }

            // 全タスクが終了ステータスかチェック
            const allDone = tasks.every(t => TERMINAL_STATUSES.has(t.status));

            // 全体進捗サマリーを表示（全完了時は既存の完了通知と重複するためスキップ）
            if (changes.length > 0 && !allDone) {
                const summary = buildProgressSummary(tasks);
                await sendToDiscord(channelId, summary);
            }

            // 全タスクが終了ステータスなら停止
            if (allDone && tasks.length > 0) {
                logInfo('[TeamTaskList] タスクリストポーリング: 全タスク完了、停止');
                break;
            }

        } catch (e) {
            // ファイル読み取りエラーは無視（ファイルが一時的にロックされている可能性）
            logDebug(`[TeamTaskList] タスクリストポーリング: 読み取りエラー: ${e}`);
        }
    }

    logInfo('[TeamTaskList] タスクリストポーリング終了');
}

// ---------------------------------------------------------------------------
// buildProgressSummary
// ---------------------------------------------------------------------------

/**
 * タスクリストの全体進捗サマリーを生成する。
 */
export function buildProgressSummary(
    tasks: Array<{ agentIndex: number; status: string }>,
): string {
    const counts: Record<string, number> = {};
    for (const task of tasks) {
        counts[task.status] = (counts[task.status] || 0) + 1;
    }

    const parts: string[] = [];
    if (counts['pending']) parts.push(`⬜ pending: ${counts['pending']}`);
    if (counts['in_progress']) parts.push(`🔄 in_progress: ${counts['in_progress']}`);
    if (counts['completed']) parts.push(`✅ completed: ${counts['completed']}`);
    if (counts['helped']) parts.push(`🤝 helped: ${counts['helped']}`);
    if (counts['failed']) parts.push(`❌ failed: ${counts['failed']}`);

    return `📊 進捗: ${parts.join(' | ')}`;
}
