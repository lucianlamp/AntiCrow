// ---------------------------------------------------------------------------
// teamResponseCollector.ts — サブエージェントのレスポンス収集・IPC中断リカバリー
// ---------------------------------------------------------------------------
// teamOrchestrator.ts から分割。
// collectResponses() と tryRecoverAgentResponse() を独立モジュールとして提供。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logError, logInfo, logWarn } from './logger';
import { t } from './i18n';
import type { FileIpc } from './fileIpc';
import type { TeamConfig } from './teamConfig';
import type { TeamInstruction } from './subagentTypes';
import type { SubagentManager } from './subagentManager';
import type { OrchestrationResult, DiscordSender, ThreadOps } from './teamOrchestrator';
import { updateSharedTaskStatus } from './teamTaskList';

// ---------------------------------------------------------------------------
// 依存オブジェクト型
// ---------------------------------------------------------------------------

/** collectResponses が必要とする外部依存を集約した型 */
export interface ResponseCollectorDeps {
    fileIpc: FileIpc;
    sendToDiscord: DiscordSender;
    threadOps: ThreadOps | null;
    subagentManager: SubagentManager;
    stopMonitor: (agentName: string) => void;
}

// ---------------------------------------------------------------------------
// collectResponses
// ---------------------------------------------------------------------------

/**
 * Phase 4 & 5: サブエージェントのレスポンスを収集し、スレッドに報告する。
 * 全レスポンスが揃ったら報告用 IPC ファイルを生成。
 */
export async function collectResponses(
    deps: ResponseCollectorDeps,
    instructions: TeamInstruction[],
    channelId: string,
    config: TeamConfig,
    agentThreads: Map<number, string>,
    agentNames: Map<number, string>,
    taskListPath: string | null,
    teamRequestId: string,
    pollTaskListStatus: (taskListPath: string, channelId: string, signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
): Promise<OrchestrationResult[]> {
    const results: OrchestrationResult[] = [];
    const ipcDir = deps.fileIpc.getIpcDir();

    // 完了カウンター（並行実行のため各完了時にインクリメント）
    let completedCount = 0;

    // ヘルパーモード用: 完了済みエージェントのインデックスを追跡
    const completedAgentIndices = new Set<number>();
    // ヘルパーモード用: ヘルパーとして支援済みのペアを追跡（二重送信防止）
    const helperPairs = new Set<string>();

    // ヘルパーモード
    const helperModeActive = config.enableHelperMode;
    if (helperModeActive) {
        logInfo(`[TeamResponseCollector] ${t('team.helperModeEnabled')}`);
    }

    // 各サブエージェントのレスポンスを並行して待機
    const promises = instructions.map(async (instruction) => {
        const agentName = agentNames.get(instruction.agentIndex) || `agent-${instruction.agentIndex}`;
        const threadId = agentThreads.get(instruction.agentIndex);
        const startTime = Date.now();

        try {
            // レスポンスパターン:
            //   1. subagentIpc.watchResponse が書き込む subagent_{name}_response_{ts}.json
            //   2. SubagentReceiver が FileIpc 経由で生成する req_*_response.md（フォールバック）
            // teamRequestId でスコープして、別WSの同名サブエージェントのレスポンスを拾わないようにする
            const agentNameEscaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const teamReqEscaped = teamRequestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const responsePattern = new RegExp(
                // ★優先: teamRequestId でスコープしたパターン（クロスWS防止）
                `^subagent_${agentNameEscaped}_response_${teamReqEscaped}_\\d+\\.json$` +
                // 後方互換: teamRequestId なしのパターン（旧バージョンのサブエージェント用）
                `|^subagent_${agentNameEscaped}_response_\\d+\\.json$` +
                // req_ パターン: teamRequestId でスコープ
                `|^req_${teamReqEscaped}_agent${instruction.agentIndex}_\\d+_[a-f0-9]+_response\\.md$` +
                // req_ パターン: 後方互換（agentName ベース）
                `|^req_${agentNameEscaped}_\\d+_[a-f0-9]+_response\\.md$` +
                `|^req_anti-crow-subagent-${instruction.agentIndex}_\\d+_[a-f0-9]+_response\\.md$`
            );

            // primaryPath: IPCディレクトリ内のダミーパス（dir 導出に使用）
            const primaryPath = path.join(ipcDir, `subagent_${agentName}_response_primary.json`);

            // レスポンスファイルの出現を待機（パターンベース + 正しいディレクトリ）
            // FileIpc: aborted 対策: リトライ機構付き
            let response: string;
            let retriedSuccessfully = false;
            try {
                response = await deps.fileIpc.waitForResponseWithPattern(
                    primaryPath,
                    responsePattern,
                    config.responseTimeoutMs,
                    signal,
                );
            } catch (ipcErr) {
                // FileIpc: aborted の場合のみリトライを試みる
                // （拡張ホスト再起動等でAbortSignalが発火した場合）
                if (ipcErr instanceof Error && ipcErr.message.includes('FileIpc: aborted')) {
                    logWarn(`[TeamResponseCollector] Agent ${instruction.agentIndex} (${agentName}) IPC aborted — リトライ開始（5秒待機後）`);

                    // 5秒待機: 拡張ホスト再起動の完了を待つ
                    await new Promise<void>(resolve => setTimeout(resolve, 5000));

                    // ステップ1: stale レスポンスリカバリーを試行
                    // （AI がレスポンスファイルを書き込み済みの可能性がある）
                    const staleRecovery = await tryRecoverAgentResponse(
                        agentName, instruction.agentIndex, teamRequestId, ipcDir
                    );

                    if (staleRecovery) {
                        response = staleRecovery;
                        retriedSuccessfully = true;
                        logInfo(`[TeamResponseCollector] Agent ${instruction.agentIndex} (${agentName}) stale レスポンスから回復成功`);
                    } else {
                        // ステップ2: 新しい AbortController でリトライ
                        // （元の signal は aborted 済みのため再利用不可）
                        logInfo(`[TeamResponseCollector] Agent ${instruction.agentIndex} (${agentName}) stale 回復失敗 — 新 AbortController でリトライ`);
                        const retryController = new AbortController();
                        const retryTimeout = setTimeout(() => retryController.abort(), 120_000);
                        try {
                            response = await deps.fileIpc.waitForResponseWithPattern(
                                primaryPath,
                                responsePattern,
                                120_000,
                                retryController.signal,
                            );
                            retriedSuccessfully = true;
                            logInfo(`[TeamResponseCollector] Agent ${instruction.agentIndex} (${agentName}) リトライ成功`);
                        } catch (retryErr) {
                            clearTimeout(retryTimeout);
                            // リトライも失敗 → 元のエラーを再 throw
                            logWarn(`[TeamResponseCollector] Agent ${instruction.agentIndex} (${agentName}) リトライも失敗: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
                            throw ipcErr;
                        }
                        clearTimeout(retryTimeout);
                    }
                } else {
                    // FileIpc: aborted 以外のエラーはそのまま throw
                    throw ipcErr;
                }
            }

            const durationMs = Date.now() - startTime;
            deps.stopMonitor(agentName);

            const retryTag = retriedSuccessfully ? '（リトライで回復）' : '';
            logInfo(`[TeamResponseCollector] Agent ${instruction.agentIndex} (${agentName}) completed in ${durationMs}ms${retryTag}`);

            // スレッドに完了通知
            if (threadId && deps.threadOps) {
                await deps.threadOps.sendToThread(threadId,
                    retriedSuccessfully
                        ? `🔄 **${t('team.taskCompleted')}**（IPC中断→リトライで回復）`
                        : `✅ **${t('team.taskCompleted')}**`);
            }

            // メインチャンネルに完了通知（スレッドリンク + N/M 表記付き）
            completedCount++;
            if (threadId) {
                await deps.sendToDiscord(channelId,
                    retriedSuccessfully
                        ? `🔄 ${completedCount}/${instructions.length} リトライで回復しました <#${threadId}>`
                        : `✅ ${completedCount}/${instructions.length} 完了しました <#${threadId}>`);
            }

            // 完了済みとしてマーク
            completedAgentIndices.add(instruction.agentIndex);

            // --- ヘルパーモード: 完了したエージェントが他を手伝う ---
            if (helperModeActive && completedCount < instructions.length) {
                // まだ完了していないエージェントを探す
                const pendingInstructions = instructions.filter(
                    inst => !completedAgentIndices.has(inst.agentIndex)
                );

                if (pendingInstructions.length > 0) {
                    // 最初の未完了エージェントを手伝う
                    const targetInstruction = pendingInstructions[0];
                    const pairKey = `${instruction.agentIndex}->${targetInstruction.agentIndex}`;

                    if (!helperPairs.has(pairKey)) {
                        helperPairs.add(pairKey);

                        const helperMsg = t('team.helperStarted', String(instruction.agentIndex), String(targetInstruction.agentIndex));
                        logInfo(`[TeamResponseCollector] ${helperMsg}`);
                        await deps.sendToDiscord(channelId, helperMsg);

                        // 共有タスクリストを更新（helped ステータス）
                        if (taskListPath) {
                            updateSharedTaskStatus(taskListPath, targetInstruction.agentIndex, 'helped');
                        }

                        // 完了したエージェントにフォローアッププロンプトを送信
                        const handle = deps.subagentManager.getAgent(agentName);
                        if (handle) {
                            try {
                                // ヘルプ送信前に状態を READY に戻す
                                // （COMPLETED のまま sendPromptFireAndForget するとエラーになる）
                                await handle.resetForReuse();

                                let followupPrompt = t('team.helperFollowup',
                                    String(targetInstruction.agentIndex),
                                    targetInstruction.task
                                );
                                // タスクリスト参照を含める
                                if (taskListPath) {
                                    followupPrompt += `\n\n📋 共有タスクリスト: ${taskListPath}\n` +
                                        `他エージェントが作業中のファイルは上書きしないでください。` +
                                        `テスト作成・ドキュメント更新・コードレビュー・未着手の関連作業を優先してください。`;
                                }
                                // sendPromptFireAndForget を使用（sendPrompt はレスポンス待機でブロックするため）
                                await handle.sendPromptFireAndForget(followupPrompt, teamRequestId);
                                logInfo(`[TeamResponseCollector] ヘルパープロンプト送信完了: ${agentName} -> タスク${targetInstruction.agentIndex}`);
                            } catch (helperErr) {
                                logWarn(`[TeamResponseCollector] ヘルパープロンプト送信失敗: ${helperErr}`);
                            }
                        }
                    }
                }
            }

            return {
                agentName,
                success: true,
                response,
                durationMs,
                threadId: threadId ?? undefined,
                retried: retriedSuccessfully,
            } as OrchestrationResult;

        } catch (e) {
            const durationMs = Date.now() - startTime;
            const errMsg = e instanceof Error ? e.message : String(e);
            deps.stopMonitor(agentName);

            // IPC中断フォールバック: 進捗ファイルから部分完了情報を復元
            let partialSuccess = false;
            try {
                const progressContent = await deps.fileIpc.readProgress(instruction.progress_path);
                if (progressContent && typeof progressContent.percent === 'number' && progressContent.percent >= 50) {
                    partialSuccess = true;
                    logWarn(`[TeamResponseCollector] Agent ${instruction.agentIndex} (${agentName}) IPC interrupted but progress was ${progressContent.percent}%. Treating as partial success.`);
                    // メインチャンネルに通知
                    await deps.sendToDiscord(channelId,
                        `⚠️ ${t('team.subagentLabel')}${instruction.agentIndex} の IPC 通信が中断しました（進捗: ${progressContent.percent}%）。部分完了として処理します。`);
                }
            } catch { /* 進捗読み取り失敗 — 通常のエラーとして処理 */ }

            logError(`[TeamResponseCollector] Agent ${instruction.agentIndex} (${agentName}) failed: ${errMsg}`, e);

            // スレッドにエラー通知
            if (threadId && deps.threadOps) {
                await deps.threadOps.sendToThread(threadId,
                    partialSuccess
                        ? `⚠️ **IPC中断** (${Math.round(durationMs / 1000)}秒) — 部分完了として記録`
                        : `❌ **エラー発生** (${Math.round(durationMs / 1000)}秒)\n${errMsg}`
                ).catch(() => { });
            }

            // エラーでも完了としてマーク（ヘルパーの対象にしない）
            completedAgentIndices.add(instruction.agentIndex);

            return {
                agentName,
                success: partialSuccess,
                response: partialSuccess
                    ? `[IPC中断・部分完了] ${errMsg}`
                    : errMsg,
                durationMs,
                threadId: threadId ?? undefined,
            } as OrchestrationResult;
        }
    });

    // タスクリストポーリング: ステータス変化を Discord にリアルタイム通知
    const pollingAbort = new AbortController();
    let pollingPromise: Promise<void> | null = null;
    if (taskListPath) {
        pollingPromise = pollTaskListStatus(
            taskListPath, channelId, pollingAbort.signal,
        );
    }

    const settled = await Promise.allSettled(promises);

    // ポーリング停止
    pollingAbort.abort();
    if (pollingPromise) {
        await pollingPromise.catch(() => { /* ignore abort */ });
    }

    for (const result of settled) {
        if (result.status === 'fulfilled') {
            results.push(result.value);
        } else {
            results.push({
                agentName: 'unknown',
                success: false,
                response: result.reason instanceof Error ? result.reason.message : String(result.reason),
                durationMs: 0,
            });
        }
    }

    // メインチャンネルに進捗サマリー
    const successCount = results.filter(r => r.success).length;
    await deps.sendToDiscord(channelId,
        `📊 **全サブエージェント完了**: ${successCount}/${results.length} 成功`);

    // 待機インジケーター: メインエージェントが結果を統合するまでの待ち時間をカバー
    await deps.sendToDiscord(channelId,
        `⏳ メインエージェントが結果を統合中です...しばらくお待ちください`);

    return results;
}

// ---------------------------------------------------------------------------
// tryRecoverAgentResponse
// ---------------------------------------------------------------------------

/**
 * IPC 中断後のサブエージェントレスポンスを IPC ディレクトリから回復する。
 * AbortSignal 発火後でも、AI がレスポンスファイルを書き込み済みの場合がある。
 * そのファイルを直接読み取って回復を試みる。
 */
export async function tryRecoverAgentResponse(
    agentName: string,
    agentIndex: number,
    teamRequestId: string,
    ipcDir: string,
): Promise<string | null> {
    try {
        const files = await fs.promises.readdir(ipcDir);
        // teamRequestId でスコープしたパターンを優先検索
        const agentNameEscaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const teamReqEscaped = teamRequestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
            // 優先: teamRequestId でスコープ
            new RegExp(`^subagent_${agentNameEscaped}_response_${teamReqEscaped}_\\d+\\.json$`),
            // 後方互換: teamRequestId なし
            new RegExp(`^subagent_${agentNameEscaped}_response_\\d+\\.json$`),
            // req_ パターン
            new RegExp(`^req_${teamReqEscaped}_agent${agentIndex}_\\d+_[a-f0-9]+_response\\.md$`),
            new RegExp(`^req_${agentNameEscaped}_\\d+_[a-f0-9]+_response\\.md$`),
            new RegExp(`^req_anti-crow-subagent-${agentIndex}_\\d+_[a-f0-9]+_response\\.md$`),
        ];

        for (const pattern of patterns) {
            for (const f of files) {
                if (pattern.test(f)) {
                    const filePath = path.join(ipcDir, f);
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    if (content.trim().length > 0) {
                        logInfo(`[TeamResponseCollector] tryRecoverAgentResponse: found ${f} (${content.length} chars)`);
                        return content;
                    }
                }
            }
        }

        logDebug(`[TeamResponseCollector] tryRecoverAgentResponse: no stale response found for ${agentName}`);
        return null;
    } catch (e) {
        logDebug(`[TeamResponseCollector] tryRecoverAgentResponse error: ${e}`);
        return null;
    }
}
