// ---------------------------------------------------------------------------
// executor.ts — 直列実行キュー（ファサード）
// ---------------------------------------------------------------------------
// 不変条件: 同時実行なし（直列のみ）
// 実装: async/await ベースの FIFO キュー。
//   Promise チェーンで直列性を保証する。mutex ライブラリ不要。
// ---------------------------------------------------------------------------
// プロンプト構築 → executorPromptBuilder.ts
// レスポンス処理 → executorResponseHandler.ts
// ---------------------------------------------------------------------------

import { ExecutionJob, Plan } from './types';
import type { BridgeContext } from './bridgeContext';
import { CdpBridge } from './cdpBridge';
import { FileIpc } from './fileIpc';
import { PlanStore } from './planStore';
import { logDebug, logError, logInfo, logWarn } from './logger';
import { CdpConnectionError, IpcTimeoutError } from './errors';
import { EmbedColor } from './embedHelper';
import { getCurrentModel } from './cdpModels';

import { getMaxRetries } from './configHelper';
import { t } from './i18n';
import { isAutoModeActive, isAutoModeTeamMode, onStepComplete, handleAutoModeError, cleanupAutoModeState } from './autoModeController';
import type { SuggestionItem } from './suggestionParser';
import * as fs from 'fs';
import { getActivePlanTypingIntervals, getActivePlanProgressIntervals } from './messageQueue';

// 新モジュールから関数を import
import {
    loadPromptTemplate,
    loadPromptRules,
    loadUserGlobalRules,
    loadUserMemory,
    buildFinalPrompt,
    writeTempPrompt,
} from './executorPromptBuilder';
import {
    sendProcessedResponse,
    sendSuggestionButtons,
    recordExecution,
} from './executorResponseHandler';

// 後方互換: 型定義を re-export
export type { NotifyFunc, SendTypingFunc, PostSuggestionsFunc, SendFileResult, SendFileFunc } from './executorResponseHandler';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 進捗ファイル監視のポーリング間隔（ms） */
const PROGRESS_POLL_INTERVAL_MS = 3_000;
/** リトライ時の待機時間（ms） */
const RETRY_DELAY_MS = 8_000;
/** 重複実行防止: 最近の実行 ID を保持する期間（ms） */
const RECENT_EXECUTION_TTL_MS = 5 * 60 * 1000;

// ローカル型（re-export は上で実施済み）
import type { NotifyFunc, SendTypingFunc, PostSuggestionsFunc, SendFileFunc } from './executorResponseHandler';

export class Executor {
    private cdp: CdpBridge;
    private fileIpc: FileIpc;
    private planStore: PlanStore;
    private timeoutMs: number;
    private notifyDiscord: NotifyFunc;
    private sendTypingToChannel: SendTypingFunc;
    private queue: ExecutionJob[] = [];
    private jobCompletionResolvers = new Map<string, (success: boolean) => void>();
    private running = false;
    private processing = false;
    private aborted = false;
    private abortController: AbortController | null = null;
    private currentJob: ExecutionJob | null = null;
    private currentJobStartTime: number = 0;
    private recentlyExecutedPlanIds = new Set<string>();

    private typingInterval: ReturnType<typeof setInterval> | null = null;
    private progressInterval: ReturnType<typeof setInterval> | null = null;
    private promptTemplate: string | null = null;
    private userGlobalRules: string | null = null;
    private promptRulesContent: string | null = null;
    private userMemory: string | null = null;
    private postSuggestions: PostSuggestionsFunc | null = null;
    private sendFile: SendFileFunc | null = null;
    private setModelNameFn: ((name: string | null) => void) | null = null;
    private bridgeCtx: BridgeContext | null = null;

    constructor(cdp: CdpBridge, fileIpc: FileIpc, planStore: PlanStore, timeoutMs: number, notifyDiscord: NotifyFunc, sendTyping: SendTypingFunc, extensionPath?: string, postSuggestions?: PostSuggestionsFunc, sendFile?: SendFileFunc) {
        this.cdp = cdp;
        this.fileIpc = fileIpc;
        this.planStore = planStore;
        this.timeoutMs = timeoutMs;
        this.notifyDiscord = notifyDiscord;
        this.sendTypingToChannel = sendTyping;
        this.postSuggestions = postSuggestions ?? null;
        this.sendFile = sendFile ?? null;

        // テンプレート・ルールを起動時に読み込み（新モジュールに委譲）
        this.promptTemplate = loadPromptTemplate();
        this.promptRulesContent = loadPromptRules();
        this.userGlobalRules = loadUserGlobalRules();
    }

    setSetModelNameFn(fn: (name: string | null) => void): void {
        this.setModelNameFn = fn;
    }

    /** BridgeContext を設定（チームモード分岐で使用） */
    setBridgeContext(ctx: BridgeContext): void {
        this.bridgeCtx = ctx;
    }

    /** ジョブをキューに追加（完了を待つ Promise を返す） */
    enqueue(job: ExecutionJob): Promise<void> {
        // 重複防止: 最近実行済みの plan_id はスキップ
        if (this.recentlyExecutedPlanIds.has(job.plan.plan_id)) {
            logWarn(`Executor: skipping duplicate job for plan ${job.plan.plan_id} (recently executed)`);
            return Promise.resolve();
        }
        // 重複防止: 同じ plan_id が既にキューにある場合はスキップ
        if (this.queue.some(j => j.plan.plan_id === job.plan.plan_id)) {
            logWarn(`Executor: skipping duplicate job for plan ${job.plan.plan_id} (already in queue)`);
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.jobCompletionResolvers.set(job.plan.plan_id, () => resolve());
            this.queue.push(job);
            logDebug(`Executor: enqueued job for plan ${job.plan.plan_id} (trigger: ${job.triggerType})`);
            this.processQueue();
        });
    }

    /** 即時実行用ヘルパー（完了を待つ Promise を返す） */
    enqueueImmediate(plan: Plan): Promise<void> {
        return this.enqueue({ plan, triggerType: 'immediate' });
    }

    /** スケジュール実行用ヘルパー */
    enqueueScheduled(plan: Plan): void {
        this.enqueue({ plan, triggerType: 'schedule' });
    }

    /** キューを直列に処理 */
    private async processQueue(): Promise<void> {
        if (this.processing) { return; } // 既に処理中
        this.processing = true;
        this.aborted = false;

        while (this.queue.length > 0 && this.processing) {
            const job = this.queue.shift()!;
            this.currentJob = job;
            this.currentJobStartTime = Date.now();

            const maxRetries = getMaxRetries();
            let attempt = 0;
            let success = false;

            while (attempt <= maxRetries && !success && !this.aborted) {
                if (attempt > 0) {
                    logDebug(`Executor: retrying plan ${job.plan.plan_id} (attempt ${attempt}/${maxRetries})`);
                    await this.safeNotify(job.plan.notify_channel_id, t('executor.run.retry', String(attempt), String(maxRetries)));
                }
                try {
                    await this.executeJob(job);
                    success = true;
                } catch (retryErr) {
                    // aborted の場合はリトライせず即座に終了
                    if (this.aborted) {
                        logDebug(`Executor: plan ${job.plan.plan_id} aborted, skipping retry`);
                        await this.safeNotify(job.plan.notify_channel_id, t('executor.run.stopped'));
                        break;
                    }

                    // IPC タイムアウト: 処理は進行中の可能性があるためリトライしない
                    if (retryErr instanceof IpcTimeoutError) {
                        const errMsg = retryErr.message;
                        logWarn(`Executor: plan ${job.plan.plan_id} timed out — skipping retry (task may still be in progress)`);
                        await this.safeNotify(job.plan.notify_channel_id,
                            t('executor.run.timeout', errMsg));
                        recordExecution(this.planStore, job.plan, false, Date.now() - this.currentJobStartTime, errMsg);
                        break;
                    }

                    const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    logWarn(`Executor: plan ${job.plan.plan_id} attempt ${attempt} failed — ${errMsg}`);
                    if (attempt >= maxRetries) {
                        // 最終試行も失敗: エラー通知
                        const errorTemplate = job.plan.discord_templates.run_error || t('executor.run.errorDefault');
                        const retryNote = maxRetries > 0 ? t('executor.run.retryExhausted', String(maxRetries)) : '';
                        await this.safeNotify(job.plan.notify_channel_id, `${errorTemplate}${retryNote}\n\`\`\`\n${errMsg}\n\`\`\``);
                        recordExecution(this.planStore, job.plan, false, Date.now() - this.currentJobStartTime, errMsg);
                    }
                    attempt++;
                }
            }

            // ジョブ完了を通知（成功/失敗を伝令）
            const resolver = this.jobCompletionResolvers.get(job.plan.plan_id);
            if (resolver) {
                this.jobCompletionResolvers.delete(job.plan.plan_id);
                resolver(success);
            }
            this.currentJob = null;
        }

        this.processing = false;
    }

    /** 個別ジョブの実行（リトライ時は例外を投げる） */
    private async executeJob(job: ExecutionJob): Promise<void> {
        const { plan } = job;
        const notifyChannel = plan.notify_channel_id;
        const jobStartTime = Date.now();
        let progressPath = '';

        try {
            // 開始通知
            const startMsg = plan.discord_templates.run_start
                || t('executor.run.startDefault', plan.human_summary || plan.plan_id);
            logDebug(`Executor: sending start notification to channel ${notifyChannel}`);
            await this.safeNotify(notifyChannel, startMsg);

            // 実行詳細通知
            try {
                const detailParts: string[] = [];
                const summary = plan.execution_summary || plan.action_summary || plan.human_summary;
                if (summary) {
                    detailParts.push(`${t('executor.run.detailLabel')}\n> ${summary.replace(/\n/g, '\n> ')}`);
                }
                if (detailParts.length > 0) {
                    await this.safeNotify(notifyChannel, detailParts.join('\n\n'));
                }
            } catch { /* 詳細通知失敗は無視 */ }

            // 実行前にユーザーグローバルルールを再読み込み（SOUL.md 更新反映）
            this.userGlobalRules = loadUserGlobalRules();

            // MEMORY.md を読み込み（新モジュールに委譲）
            this.userMemory = loadUserMemory(plan.workspace_name);

            logDebug(`Executor: executing plan ${plan.plan_id} — sending prompt via CDP (${plan.prompt.length} chars)`);
            this.running = true;

            // AbortController を生成（forceStop でキャンセル可能にする）
            this.abortController = new AbortController();
            const { signal } = this.abortController;

            // ファイルベース IPC: レスポンスパス（Markdown形式）と進捗パスを生成
            const { requestId, responsePath } = this.fileIpc.createMarkdownRequestId(plan.workspace_name);
            this.fileIpc.writeRequestMeta(requestId, notifyChannel, plan.workspace_name);
            progressPath = this.fileIpc.createProgressPath(requestId);

            // プロンプト構築（新モジュールに委譲）
            const finalPrompt = buildFinalPrompt({
                plan,
                responsePath,
                progressPath,
                promptTemplate: this.promptTemplate,
                promptRulesContent: this.promptRulesContent,
                userGlobalRules: this.userGlobalRules,
                userMemory: this.userMemory,
            });

            // プロンプトを一時ファイルに書き出し（新モジュールに委譲）
            const { tmpExecPath, cdpInstruction } = writeTempPrompt(finalPrompt, responsePath, requestId, plan.workspace_name);

            // typing indicator 開始（実行中に「入力中...」を表示）
            this.typingInterval = setInterval(async () => {
                try { await this.sendTypingToChannel(notifyChannel); } catch (e) { logDebug(`Executor: sendTyping failed: ${e}`); }
            }, RETRY_DELAY_MS);
            try { await this.sendTypingToChannel(notifyChannel); } catch (e) { logDebug(`Executor: sendTyping failed: ${e}`); }

            // 進捗監視ループ開始（3秒間隔）
            let lastProgressContent = '';
            this.progressInterval = setInterval(async () => {
                try {
                    const progress = await this.fileIpc.readProgress(progressPath);
                    if (progress) {
                        const currentContent = JSON.stringify(progress);
                        if (currentContent !== lastProgressContent) {
                            lastProgressContent = currentContent;
                            const percentStr = progress.percent !== undefined ? ` (${progress.percent}%)` : '';
                            const detailStr = progress.detail ? `\n${progress.detail}` : '';
                            const progressMsg = t('executor.run.progress', percentStr, progress.status, detailStr);
                            logDebug(`Executor: progress update — ${progress.status}`);
                            await this.safeNotify(notifyChannel, progressMsg, EmbedColor.Progress);
                        }
                    }
                } catch {
                    // 進捗ファイル読み取り失敗は無視
                }


            }, PROGRESS_POLL_INTERVAL_MS);

            let response: string;
            try {
                // CDP 経由で Antigravity にプロンプト送信
                try {
                    await this.cdp.sendPrompt(cdpInstruction);
                } catch (sendErr) {
                    if (sendErr instanceof CdpConnectionError) {
                        logWarn(`Executor: sendPrompt failed due to connection error, attempting reconnect — ${sendErr.message}`);
                        await this.safeNotify(notifyChannel, t('executor.run.connectionLost'));
                        try {
                            await this.cdp.ensureConnected();
                            logDebug('Executor: reconnected successfully, retrying sendPrompt');
                            await this.cdp.sendPrompt(cdpInstruction);
                        } catch (reconnectErr) {
                            logError('Executor: reconnect + retry failed', reconnectErr);
                            throw reconnectErr;
                        }
                    } else {
                        throw sendErr;
                    }
                }
                logDebug(`Executor: prompt sent, waiting for file response at ${responsePath}`);

                // 伝令完了ステータスを Discord に通知
                await this.safeNotify(notifyChannel, t('executor.run.promptSent'));

                // 一時プロンプトファイルを即時クリーンアップ
                await this.fileIpc.cleanupTmpFiles([tmpExecPath]);

                // ファイル経由でレスポンスを待機（AbortSignal 付き）
                response = await this.fileIpc.waitForResponse(responsePath, this.timeoutMs, signal);
            } finally {
                this.clearJobIntervals();
                await this.fileIpc.cleanupProgress(progressPath);
                try { fs.unlinkSync(tmpExecPath); } catch { /* ignore */ }
            }

            this.running = false;
            this.abortController = null;
            const durationMs = Date.now() - jobStartTime;
            logDebug(`Executor: plan ${plan.plan_id} — response received (${response.length} chars)`);

            // レスポンス送信前にモデル名を再取得してフッターに反映
            try {
                this.cdp.ops.resetCascadeContext();
                const currentModel = await getCurrentModel(this.cdp.ops);
                if (currentModel && this.setModelNameFn) {
                    this.setModelNameFn(currentModel);
                }
            } catch { /* ignore */ }

            // メモリ抽出 + コンテンツ処理 + ファイル参照送信 + Discord送信 + 提案ボタン送信
            // （sendProcessedResponse で通常モード・チームモード共通化）

            // 連続オートモード: wsKey 指定で厳密にチェック（クロスWS漏洩防止）
            // 以前は wsKey 不一致時に getActiveAutoModeWsKey() で別WSのオートモードを
            // 横取りしていたが、これがクロスWS漏洩の原因だったため削除した。
            const isAutoModeActiveNow = isAutoModeActive(plan.workspace_name);
            logDebug(`Executor: autoMode check — wsKey=${plan.workspace_name}, active=${isAutoModeActiveNow}`);

            const { cleanContent } = await sendProcessedResponse({
                response,
                responsePath,
                plan,
                channelId: notifyChannel,
                wsKey: plan.workspace_name,
                callbacks: {
                    sendToChannel: this.safeNotify.bind(this),
                    sendFileToChannel: this.sendFile!,
                    sendEmbeds: async (descriptions, color) => {
                        // 通常モード: safeNotify で1メッセージ送信
                        const combined = descriptions.join('\n');
                        await this.safeNotify(notifyChannel, combined, color);
                    },
                    sendSuggestionButtons: async (suggestions) => {
                        if (this.postSuggestions) {
                            await sendSuggestionButtons(suggestions, notifyChannel, this.postSuggestions, plan.workspace_name);
                        }
                    },
                    // 連続オートモード: ステップ完了時に次のプロンプトを自動投入
                    onAutoModeComplete: isAutoModeActiveNow
                        ? (suggestions: SuggestionItem[], cleanContent: string) => {
                            this.autoModeContinueLoop(notifyChannel, suggestions, cleanContent, plan)
                                .catch(err => {
                                    logError('Executor: autoModeContinueLoop failed', err);
                                    // セッション残存を防止: フォールバックとしてセッションをクリア
                                    // autoModeContinueLoop 内部の catch で handleAutoModeError が呼ばれるが、
                                    // チャンネル取得失敗等で到達しないケースがあるため、ここでも確実にクリアする
                                    cleanupAutoModeState(plan.workspace_name);
                                });
                        }
                        : undefined,
                },
            });

            // 実行履歴を記録（新モジュールに委譲）
            recordExecution(this.planStore, plan, true, durationMs, cleanContent);

            // 配信済みレスポンスファイル + meta を即削除（stale response 誤再送防止）
            try {
                await fs.promises.unlink(responsePath);
                const metaPath = responsePath.replace(/_response\.(json|md)$/, '_meta.json');
                await fs.promises.unlink(metaPath).catch(() => { });
                logDebug(`Executor: cleaned up delivered response: ${require('path').basename(responsePath)}`);
            } catch (e) {
                logDebug(`Executor: failed to cleanup response file: ${e}`);
            }

            // 即時実行の重複防止
            if (!plan.cron) {
                this.recentlyExecutedPlanIds.add(plan.plan_id);
                setTimeout(() => this.recentlyExecutedPlanIds.delete(plan.plan_id), RECENT_EXECUTION_TTL_MS);
            }

            logDebug(`Executor: plan ${plan.plan_id} completed successfully`);
        } catch (err) {
            this.running = false;
            this.abortController = null;

            // 進捗ファイルクリーンアップ（エラー時も確実に削除）
            if (progressPath) { try { await this.fileIpc.cleanupProgress(progressPath); } catch (e) { logDebug(`Executor: progress cleanup failed: ${e}`); } }

            // 連続オートモード セッション残存防止
            if (isAutoModeActive(plan.workspace_name)) {
                cleanupAutoModeState(plan.workspace_name);
                logWarn('Executor: autoMode session cleaned up due to executeJob error');
            }

            logError(`Executor: plan ${plan.plan_id} failed`, err);
            throw err;
        }
    }

    /** Discord 通知（エラーを握りつぶさない） */
    private async safeNotify(channelId: string, message: string, color?: number): Promise<void> {
        try {
            await this.notifyDiscord(channelId, message, color);
        } catch (e) {
            logError('Executor: failed to send Discord notification', e);
        }
    }

    /** 強制リセット: 実行状態をクリアする */
    forceReset(): void {
        this.running = false;
        this.processing = false;
        this.aborted = true;
        this.queue = [];
        this.clearJobIntervals();
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        for (const [planId, resolver] of this.jobCompletionResolvers.entries()) {
            logDebug(`Executor: force-resolving pending job completion for plan ${planId} (reset)`);
            resolver(false);
        }
        this.jobCompletionResolvers.clear();
        // 連続オートモード セッション残存防止
        cleanupAutoModeState();
        logDebug('Executor: force reset — running/processing/aborted flags set, queue emptied');
    }

    /** 強制停止: 現在実行中のジョブのみ停止する（キューは保持） */
    forceStop(): void {
        this.running = false;
        this.processing = false;
        this.aborted = true;
        this.currentJob = null;
        this.clearJobIntervals();
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            logDebug('Executor: abortController triggered — waitForResponse cancelled');
        }
        for (const [planId, resolver] of this.jobCompletionResolvers.entries()) {
            logDebug(`Executor: force-resolving pending job completion for plan ${planId}`);
            resolver(false);
        }
        this.jobCompletionResolvers.clear();
        // 連続オートモード セッション残存防止
        cleanupAutoModeState();
        logDebug('Executor: force stop — running/processing/aborted flags set, queue preserved');
    }

    /** typing / progress の interval タイマーをクリアする */
    private clearJobIntervals(): void {
        if (this.typingInterval) {
            clearInterval(this.typingInterval);
            this.typingInterval = null;
        }
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
    }

    /** 現在実行中かどうか */
    isRunning(): boolean {
        return this.running;
    }

    /** キュー内のジョブ数 */
    queueLength(): number {
        return this.queue.length;
    }

    /** キュー情報を取得（/queue コマンド用） */
    getQueueInfo(): { current: { plan: Plan; startTime: number } | null; pending: Plan[] } {
        return {
            current: this.currentJob ? { plan: this.currentJob.plan, startTime: this.currentJobStartTime } : null,
            pending: this.queue.map(j => j.plan),
        };
    }

    /** キューからジョブを削除（plan_id 指定） */
    cancelJob(planId: string): boolean {
        const idx = this.queue.findIndex(j => j.plan.plan_id === planId);
        if (idx === -1) { return false; }
        this.queue.splice(idx, 1);
        logDebug(`Executor: cancelled queued job for plan ${planId}`);
        return true;
    }

    // -----------------------------------------------------------------------
    // 連続オートモードループ
    // -----------------------------------------------------------------------

    /**
     * 連続オートモードの次ステップを自動投入するループ。
     * onStepComplete → 次プロンプト構築 → CDP 送信 → waitForResponse → sendProcessedResponse
     * を繰り返す。onStepComplete が null を返したらループ終了。
     */
    private async autoModeContinueLoop(
        notifyChannel: string,
        suggestions: SuggestionItem[],
        cleanContent: string,
        plan: Plan,
    ): Promise<void> {
        logDebug(`Executor: autoModeContinueLoop entered — wsKey=${plan.workspace_name}, suggestions=${suggestions.length}, cleanContentLen=${cleanContent.length}`);

        // Discord チャンネルを取得するために TextChannel が必要
        // onStepComplete は TextChannel を要求するので、discordBot 経由で取得
        const { TextChannel: TC } = await import('discord.js');
        let channel: import('discord.js').TextChannel;
        try {
            // executor 内では Discord client への直接参照がないため、
            // notifyDiscord コールバック経由でチャンネルを特定できない。
            // 代わりに onStepComplete に TextChannel を渡す必要がある。
            // ここでは discord.js の Client を動的に取得する方法がないため、
            // safeNotify を使ってチャンネルに通知するラッパーを使う。
            //
            // onStepComplete のシグネチャ: (channel: TextChannel, suggestions, responseContent) => Promise<string | null>
            // TextChannel を取得するために DiscordBot のクライアントを使う
            const { DiscordBot } = await import('./discordBot');
            const client = DiscordBot.getClient();
            if (!client) {
                logWarn('Executor: autoModeContinueLoop — Discord client not available');
                return;
            }
            const fetched = await client.channels.fetch(notifyChannel);
            if (!fetched || !(fetched instanceof TC)) {
                logWarn(`Executor: autoModeContinueLoop — channel ${notifyChannel} not found or not TextChannel`);
                return;
            }
            channel = fetched;
        } catch (e) {
            logError('Executor: autoModeContinueLoop — failed to fetch channel', e);
            return;
        }

        let currentSuggestions = suggestions;
        let currentCleanContent = cleanContent;

        while (true) {
            try {
                // onStepComplete: セーフティチェック → Discord通知 → ループ継続判定 → 次プロンプト構築
                const nextPrompt = await onStepComplete(channel, currentSuggestions, currentCleanContent, plan.workspace_name);
                if (!nextPrompt) {
                    // ループ終了（stopAutoMode が呼ばれた）
                    logInfo('Executor: autoModeContinueLoop — loop ended (onStepComplete returned null)');
                    return;
                }

                logInfo(`Executor: autoModeContinueLoop — next step prompt (${nextPrompt.length} chars)`);

                // -----------------------------------------------------------------
                // チームモード分岐: plan_generation → dispatchPlan パス
                // team_mode が有効な場合、AI が plan.tasks を出力できるよう
                // plan_generation フェーズを通す。tasks がある場合はサブエージェント
                // 並列実行、ない場合は通常の単一エージェント実行にフォールバック。
                // -----------------------------------------------------------------
                if (isAutoModeTeamMode(plan.workspace_name)) {
                    logInfo('Executor: autoModeContinueLoop — team mode active, routing through plan_generation');

                    // BridgeContext と関連モジュールを動的 import（executor は直接参照を持たない）
                    const { generatePlan, dispatchPlan } = await import('./planPipeline');
                    const ctx = this.bridgeCtx;

                    if (!ctx) {
                        logWarn('Executor: autoModeContinueLoop — BridgeContext not available, falling back to direct execution');
                    } else {
                        try {
                            // plan_generation: team_mode 注入済みプロンプトで AI にプラン生成させる
                            const wsPath = (() => {
                                const wsPaths = ctx.cdpPool?.getResolvedWorkspacePaths() ?? {};
                                if (plan.workspace_name && wsPaths[plan.workspace_name]) {
                                    return wsPaths[plan.workspace_name];
                                }
                                const vscode = require('vscode');
                                return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? undefined;
                            })();

                            const extensionPath = (() => {
                                try {
                                    const vscode = require('vscode');
                                    return vscode.extensions.getExtension('lucianlamp.anti-crow')?.extensionPath;
                                } catch { return undefined; }
                            })();

                            const planResult = await generatePlan(
                                this.cdp,
                                false, // autoLaunched
                                this.fileIpc,
                                channel,
                                nextPrompt,
                                'agent-chat', // intent
                                channel.name ?? '',
                                undefined, // attachmentPaths
                                extensionPath,
                                wsPath,
                            );

                            if (planResult) {
                                const { plan: generatedPlan, guild } = planResult;
                                // workspace_name と notify_channel_id を引き継ぐ
                                generatedPlan.workspace_name = plan.workspace_name;
                                generatedPlan.notify_channel_id = plan.notify_channel_id;

                                logInfo(`Executor: autoModeContinueLoop — plan generated (plan_id=${generatedPlan.plan_id}, tasks=${generatedPlan.tasks?.length ?? 0})`);

                                // dispatchPlan 経由で実行（autoMode=true, isTeamMode=true）
                                // tasks がある場合はチームオーケストレーション、ない場合は単一実行
                                const teamResponse = await dispatchPlan(
                                    ctx,
                                    generatedPlan,
                                    channel,
                                    this.cdp,
                                    plan.workspace_name,
                                    guild,
                                    true, // isTeamMode
                                    true, // autoMode
                                );

                                // チームモード実行の場合、dispatchPlan 内部でレスポンスの
                                // 送信まで完了するため、ここではレスポンス処理をスキップし
                                // 次の onStepComplete に進む
                                // dispatchPlan 内で Discord へのレスポンス送信は完了済み
                                // ただし tasks がなく通常実行された場合は executor のキューに
                                // 入るため、そのレスポンスは別途処理される

                                // dispatchPlan が tasks ありでチーム実行した場合:
                                //   → orchestrateTeam 内で完結（レスポンス送信済み）
                                //   → ここで cleanContent/suggestions を空にして次ループへ
                                if (generatedPlan.tasks && generatedPlan.tasks.length > 1) {
                                    currentSuggestions = [];
                                    // 統合レポートが返された場合はそれを使い、shouldContinue の完了判定を正確にする
                                    currentCleanContent = typeof teamResponse === 'string'
                                        ? teamResponse
                                        : `チームモードで ${generatedPlan.tasks.length} タスクを並列実行しました。`;
                                    logDebug(`Executor: autoModeContinueLoop — team mode result length: ${currentCleanContent.length} chars`);
                                    continue;
                                }

                                // tasks なし → splitTasks でプロンプトから自動分割を試みる
                                // AI が tasks を出力しなくても、プロンプト構造から分割可能な場合がある
                                if (ctx.teamOrchestrator) {
                                    const splitResult = ctx.teamOrchestrator.splitTasks(nextPrompt);
                                    if (splitResult.length >= 2) {
                                        logInfo(`Executor: autoModeContinueLoop — splitTasks fallback succeeded (${splitResult.length} tasks)`);
                                        generatedPlan.tasks = splitResult;
                                        const splitTeamResponse = await dispatchPlan(
                                            ctx,
                                            generatedPlan,
                                            channel,
                                            this.cdp,
                                            plan.workspace_name,
                                            guild,
                                            true, // isTeamMode
                                            true, // autoMode
                                        );
                                        currentSuggestions = [];
                                        currentCleanContent = typeof splitTeamResponse === 'string'
                                            ? splitTeamResponse
                                            : `splitTasks フォールバックでチームモード ${splitResult.length} タスクを並列実行しました。`;
                                        logDebug(`Executor: autoModeContinueLoop — splitTasks team result length: ${currentCleanContent.length} chars`);
                                        continue;
                                    }
                                    logDebug(`Executor: autoModeContinueLoop — splitTasks returned ${splitResult.length} task(s), falling back to single execution`);
                                }

                                // splitTasks でも分割不可 → 通常キュー処理に委ねる
                                logInfo('Executor: autoModeContinueLoop — plan dispatched without tasks, loop continues');
                                currentSuggestions = [];
                                currentCleanContent = `プランが生成され、実行キューに追加されました。`;
                                continue;
                            }

                            // planResult が null = plan 生成失敗
                            // → フォールバックとして通常の execution パスで実行
                            logWarn('Executor: autoModeContinueLoop — plan generation failed, falling back to direct execution');
                        } catch (teamErr) {
                            logWarn(`Executor: autoModeContinueLoop — team mode plan_generation failed: ${teamErr instanceof Error ? teamErr.message : teamErr}`);
                            logWarn('Executor: autoModeContinueLoop — falling back to direct execution');
                        }
                    }
                    // フォールバック: チームモード失敗時は通常の execution パスに落ちる
                }

                // -----------------------------------------------------------------
                // 通常パス: plan_generation をスキップして直接 execution
                // -----------------------------------------------------------------

                // 新しい requestId / responsePath を生成
                const { requestId: nextReqId, responsePath: nextResponsePath } = this.fileIpc.createMarkdownRequestId(plan.workspace_name);
                this.fileIpc.writeRequestMeta(nextReqId, notifyChannel, plan.workspace_name);
                const nextProgressPath = this.fileIpc.createProgressPath(nextReqId);

                // ユーザーメモリを再読み込み
                this.userMemory = loadUserMemory(plan.workspace_name);

                // プロンプト構築（連続オートモード用：plan_generation をスキップして直接 execution）
                const nextFinalPrompt = buildFinalPrompt({
                    plan: { ...plan, prompt: nextPrompt },
                    responsePath: nextResponsePath,
                    progressPath: nextProgressPath,
                    promptTemplate: this.promptTemplate,
                    promptRulesContent: this.promptRulesContent,
                    userGlobalRules: this.userGlobalRules,
                    userMemory: this.userMemory,
                });

                // 一時ファイル書き出し
                const { tmpExecPath: nextTmpPath, cdpInstruction: nextCdpInstruction } = writeTempPrompt(
                    nextFinalPrompt, nextResponsePath, nextReqId, plan.workspace_name,
                );

                // typing indicator（外部停止可能にするためグローバルセットにも登録）
                const stepTyping = setInterval(async () => {
                    try { await this.sendTypingToChannel(notifyChannel); } catch { /* ignore */ }
                }, RETRY_DELAY_MS);
                getActivePlanTypingIntervals().add(stepTyping);
                try { await this.sendTypingToChannel(notifyChannel); } catch { /* ignore */ }

                // 進捗監視（外部停止可能にするためグローバルセットにも登録）
                let lastStepProgress = '';
                const stepProgress = setInterval(async () => {
                    try {
                        const progress = await this.fileIpc.readProgress(nextProgressPath);
                        if (progress) {
                            const cur = JSON.stringify(progress);
                            if (cur !== lastStepProgress) {
                                lastStepProgress = cur;
                                const pct = progress.percent !== undefined ? ` (${progress.percent}%)` : '';
                                const det = progress.detail ? `\n${progress.detail}` : '';
                                await this.safeNotify(notifyChannel, t('executor.run.progress', pct, progress.status, det), EmbedColor.Progress);
                            }
                        }
                    } catch { /* ignore */ }

                }, PROGRESS_POLL_INTERVAL_MS);
                getActivePlanProgressIntervals().add(stepProgress);

                let stepResponse: string;
                try {
                    // CDP 経由でプロンプト送信
                    await this.cdp.sendPrompt(nextCdpInstruction);
                    logDebug('Executor: autoModeContinueLoop — prompt sent, waiting for response...');

                    // 一時ファイルクリーンアップ
                    await this.fileIpc.cleanupTmpFiles([nextTmpPath]);

                    // レスポンス待ち
                    this.fileIpc.registerActiveRequest(nextReqId);
                    try {
                        stepResponse = await this.fileIpc.waitForResponse(nextResponsePath, this.timeoutMs);
                    } finally {
                        this.fileIpc.unregisterActiveRequest(nextReqId);
                    }
                } finally {
                    clearInterval(stepTyping);
                    getActivePlanTypingIntervals().delete(stepTyping);
                    clearInterval(stepProgress);
                    getActivePlanProgressIntervals().delete(stepProgress);
                    await this.fileIpc.cleanupProgress(nextProgressPath).catch(() => { });
                    try { fs.unlinkSync(nextTmpPath); } catch { /* ignore */ }
                }

                logDebug(`Executor: autoModeContinueLoop — response received (${stepResponse.length} chars)`);

                // レスポンス処理（ループ内でも onAutoModeComplete を設定して SUGGESTIONS ボタンを抑制する）
                // ダミーの onAutoModeComplete を設定：sendProcessedResponse 内の suppressSuggestions 判定で
                // isAutoModeActive() && !!callbacks.onAutoModeComplete が true になり、ボタン送信をスキップする。
                // 実際のループ継続は while(true) で制御するため、コールバック内では何もしない。
                const { cleanContent: stepCleanContent, suggestions: stepSuggestions } = await sendProcessedResponse({
                    response: stepResponse,
                    responsePath: nextResponsePath,
                    plan,
                    channelId: notifyChannel,
                    wsKey: plan.workspace_name,
                    callbacks: {
                        sendToChannel: this.safeNotify.bind(this),
                        sendFileToChannel: this.sendFile!,
                        sendEmbeds: async (descriptions, color) => {
                            const combined = descriptions.join('\n');
                            await this.safeNotify(notifyChannel, combined, color);
                        },
                        sendSuggestionButtons: async (sug) => {
                            if (this.postSuggestions) {
                                await sendSuggestionButtons(sug, notifyChannel, this.postSuggestions, plan.workspace_name);
                            }
                        },
                        // ダミー onAutoModeComplete: SUGGESTIONS ボタンを抑制するために設定
                        // （実際の継続処理は while(true) ループが担当）
                        onAutoModeComplete: () => { /* no-op: ループは while(true) で制御 */ },
                    },
                });

                // レスポンスファイルクリーンアップ
                try {
                    await fs.promises.unlink(nextResponsePath);
                    const metaPath = nextResponsePath.replace(/_response\.(json|md)$/, '_meta.json');
                    await fs.promises.unlink(metaPath).catch(() => { });
                } catch { /* ignore */ }

                // sendProcessedResponse の返り値から suggestions を直接取得
                // （二重 parseSuggestions 呼び出しを排除）
                currentSuggestions = stepSuggestions;
                currentCleanContent = stepCleanContent;

            } catch (err) {
                logError('Executor: autoModeContinueLoop — error in loop', err);
                await handleAutoModeError(channel, err, plan.workspace_name);
                return;
            }
        }
    }


}
