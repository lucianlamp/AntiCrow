// ---------------------------------------------------------------------------
// executor.ts — 直列実行キュー
// ---------------------------------------------------------------------------
// 不変条件: 同時実行なし（直列のみ）
// 実装: async/await ベースの FIFO キュー。
//   Promise チェーンで直列性を保証する。mutex ライブラリ不要。
// ---------------------------------------------------------------------------

import { ExecutionJob, Plan, PlanExecution } from './types';
import { CdpBridge } from './cdpBridge';
import { FileIpc } from './fileIpc';
import { PlanStore } from './planStore';
import { logInfo, logError, logWarn, logDebug } from './logger';
import { CdpConnectionError, IpcTimeoutError } from './errors';
import { updateAnticrowMd, getAnticrowMdPath } from './anticrowCustomizer';
import { PROMPT_RULES_MD, EXECUTION_PROMPT_TEMPLATE } from './embeddedRules';
import * as vscode from 'vscode';
import { getMaxRetries } from './configHelper';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** UIウォッチャーのポーリング間隔（ms） */
const UI_WATCHER_INTERVAL_MS = 1_000;
/** 進捗ファイル監視のポーリング間隔（ms） */
const PROGRESS_POLL_INTERVAL_MS = 3_000;
/** リトライ時の待機時間（ms） */
const RETRY_DELAY_MS = 8_000;
/** 重複実行防止: 最近の実行 ID を保持する期間（ms） */
const RECENT_EXECUTION_TTL_MS = 5 * 60 * 1000;


/** UIウォッチャーの自動クリックルール */
export interface AutoClickRule {
    name: string;            // ルール名（ログ用）
    text?: string;           // テキストマッチ
    selector?: string;       // セレクタマッチ
    tag?: string;            // タグフィルタ
    inCascade?: boolean;     // cascade-panel 内（デフォルト: true）
}

/** デフォルトの自動クリックルール（外部から参照・オーバーライド可能） */
export const DEFAULT_AUTO_CLICK_RULES: AutoClickRule[] = [
    { name: 'continue-warning', text: 'Continue', tag: 'button', inCascade: true },
    { name: 'allow-tool', text: 'Allow', tag: 'button', inCascade: true },
    { name: 'retry-error', text: 'Retry', tag: 'button', inCascade: true },
    // Run: 「1 Step Requires Input」展開後の実行ボタン
    { name: 'run-command', text: 'Run', tag: 'button', inCascade: true },
    // Always run: 常時許可ボタン（Run の横にある）
    { name: 'always-run', text: 'Always run', inCascade: true },
    // Expand All: 差分ビューの折りたたみ展開ボタン（aria-label で検索）
    { name: 'expand-all', selector: '[aria-label="Expand All"]', tag: 'button', inCascade: false },
    // Expand: 「N Step Requires Input」表示時の展開ボタン（cascade 内テキストマッチ）
    { name: 'expand-step-input', text: 'Expand', tag: 'button', inCascade: true },
    // ScrollDown: 出力が長い場合の下矢印スクロールボタン（cascade 内、複数セレクタ対応）
    { name: 'scroll-down-arrow', selector: '.codicon-arrow-down', tag: 'button', inCascade: true },
    { name: 'scroll-down-arrow-text', text: '↓', tag: 'button', inCascade: true },
];

export type NotifyFunc = (channelId: string, message: string, color?: number) => Promise<void>;
export type SendTypingFunc = (channelId: string) => Promise<void>;

export class Executor {
    private cdp: CdpBridge;
    private fileIpc: FileIpc;
    private planStore: PlanStore;
    private timeoutMs: number;
    private notifyDiscord: NotifyFunc;
    private sendTypingToChannel: SendTypingFunc;
    private queue: ExecutionJob[] = [];
    private jobCompletionResolvers = new Map<string, () => void>();
    private running = false;
    private processing = false;
    private aborted = false;
    private abortController: AbortController | null = null;
    private currentJob: ExecutionJob | null = null;
    private currentJobStartTime: number = 0;
    private recentlyExecutedPlanIds = new Set<string>();
    private uiWatcherTimer: ReturnType<typeof setInterval> | null = null;
    private readonly autoClickRules: AutoClickRule[] = [...DEFAULT_AUTO_CLICK_RULES];
    private extensionPath: string;
    private promptTemplate: string | null = null;
    private userGlobalRules: string | null = null;
    private promptRulesContent: string | null = null;

    constructor(cdp: CdpBridge, fileIpc: FileIpc, planStore: PlanStore, timeoutMs: number, notifyDiscord: NotifyFunc, sendTyping: SendTypingFunc, extensionPath?: string) {
        this.cdp = cdp;
        this.fileIpc = fileIpc;
        this.planStore = planStore;
        this.timeoutMs = timeoutMs;
        this.notifyDiscord = notifyDiscord;
        this.sendTypingToChannel = sendTyping;
        this.extensionPath = extensionPath || '';

        // テンプレート・ルールを起動時に読み込み
        this.loadPromptTemplate();
        this.loadPromptRules();
        this.loadUserGlobalRules();
    }



    /** プロンプトテンプレートを読み込む */
    private loadPromptTemplate(): void {
        this.promptTemplate = EXECUTION_PROMPT_TEMPLATE;
        logDebug(`Executor: loaded embedded prompt template (${this.promptTemplate.length} chars)`);
    }

    /** プロンプトルールを読み込む */
    private loadPromptRules(): void {
        this.promptRulesContent = PROMPT_RULES_MD;
        logDebug(`Executor: loaded embedded prompt rules (${this.promptRulesContent.length} chars)`);
    }

    /** ユーザーグローバルルールを読み込む */
    private loadUserGlobalRules(): void {
        const homedir = os.homedir();
        const filePath = path.join(homedir, '.anticrow', 'ANTICROW.md');
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.trim().length > 0) {
                this.userGlobalRules = content.trim();
                logInfo(`Executor: loaded user global rules from ${filePath} (${this.userGlobalRules.length} chars)`);
            }
        } catch {
            logDebug(`Executor: no user global rules found at ${filePath} (optional)`);
        }
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
            this.jobCompletionResolvers.set(job.plan.plan_id, resolve);
            this.queue.push(job);
            logInfo(`Executor: enqueued job for plan ${job.plan.plan_id} (trigger: ${job.triggerType})`);
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
                    logInfo(`Executor: retrying plan ${job.plan.plan_id} (attempt ${attempt}/${maxRetries})`);
                    await this.safeNotify(job.plan.notify_channel_id, `🔄 リトライ中... (${attempt}/${maxRetries})`);
                }
                try {
                    await this.executeJob(job);
                    success = true;
                } catch (retryErr) {
                    // aborted の場合はリトライせず即座に終了
                    if (this.aborted) {
                        logInfo(`Executor: plan ${job.plan.plan_id} aborted, skipping retry`);
                        await this.safeNotify(job.plan.notify_channel_id, '⏹️ 停止しました');
                        break;
                    }

                    // IPC タイムアウト: 処理は進行中の可能性があるためリトライしない
                    if (retryErr instanceof IpcTimeoutError) {
                        const errMsg = retryErr.message;
                        logWarn(`Executor: plan ${job.plan.plan_id} timed out — skipping retry (task may still be in progress)`);
                        await this.safeNotify(job.plan.notify_channel_id,
                            `⏱️ タイムアウトしました。処理は進行中の可能性があります。\n\`\`\`\n${errMsg}\n\`\`\``);
                        this.recordExecution(job.plan, false, Date.now() - this.currentJobStartTime, errMsg);
                        break;
                    }

                    const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    logWarn(`Executor: plan ${job.plan.plan_id} attempt ${attempt} failed — ${errMsg}`);
                    if (attempt >= maxRetries) {
                        // 最終試行も失敗: エラー通知
                        const errorTemplate = job.plan.discord_templates.run_error || '❌ 実行失敗';
                        const retryNote = maxRetries > 0 ? `\n(${maxRetries}回リトライ後も失敗)` : '';
                        await this.safeNotify(job.plan.notify_channel_id, `${errorTemplate}${retryNote}\n\`\`\`\n${errMsg}\n\`\`\``);
                        this.recordExecution(job.plan, false, Date.now() - this.currentJobStartTime, errMsg);
                    }
                    attempt++;
                }
            }

            // ジョブ完了を通知
            const resolver = this.jobCompletionResolvers.get(job.plan.plan_id);
            if (resolver) {
                this.jobCompletionResolvers.delete(job.plan.plan_id);
                resolver();
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
            // ワークスペース切り替え（plan に紐づくワークスペースで実行）
            if (plan.workspace_name) {
                const currentWs = this.cdp.getActiveWorkspaceName();
                if (currentWs !== plan.workspace_name) {
                    logInfo(`Executor: switching workspace "${currentWs}" → "${plan.workspace_name}" for plan ${plan.plan_id}`);
                    const port = this.cdp.getActiveTargetPort();
                    let instances = await CdpBridge.discoverInstances(this.cdp.getPorts());
                    let target = instances.find(i =>
                        CdpBridge.extractWorkspaceName(i.title) === plan.workspace_name);

                    // ワークスペースが見つからない場合、Antigravity を自動起動して再試行
                    if (!target) {
                        logInfo(`Executor: workspace "${plan.workspace_name}" not found, attempting auto-launch...`);
                        try {
                            await this.cdp.ensureConnected();
                            instances = await CdpBridge.discoverInstances(this.cdp.getPorts());
                            target = instances.find(i =>
                                CdpBridge.extractWorkspaceName(i.title) === plan.workspace_name);
                        } catch (e) {
                            logWarn(`Executor: auto-launch failed — ${e instanceof Error ? e.message : e}`);
                        }
                    }

                    if (target) {
                        await this.cdp.switchTarget(target.id);
                        logInfo(`Executor: switched to workspace "${plan.workspace_name}" (id=${target.id})`);
                    } else {
                        logWarn(`Executor: workspace "${plan.workspace_name}" not found even after auto-launch, skipping job`);
                        await this.safeNotify(notifyChannel,
                            `⚠️ ワークスペース "${plan.workspace_name}" が見つかりません。Antigravity の自動起動も試みましたが接続できませんでした。`);
                        this.recordExecution(plan, false, Date.now() - jobStartTime, `Workspace "${plan.workspace_name}" not found`);
                        return;
                    }
                }
            }

            // 開始通知
            const startMsg = plan.discord_templates.run_start
                || `⏳ 実行開始: ${plan.human_summary || plan.plan_id}`;
            logInfo(`Executor: sending start notification to channel ${notifyChannel}`);
            await this.safeNotify(notifyChannel, startMsg);

            // 実行前にユーザーグローバルルールを再読み込み（ANTICROW.md 更新反映）
            this.loadUserGlobalRules();

            logInfo(`Executor: executing plan ${plan.plan_id} — sending prompt via CDP (${plan.prompt.length} chars)`);
            this.running = true;

            // AbortController を生成（forceStop でキャンセル可能にする）
            this.abortController = new AbortController();
            const { signal } = this.abortController;

            // ファイルベース IPC: レスポンスパス（Markdown形式）と進捗パスを生成
            const { requestId, responsePath } = this.fileIpc.createMarkdownRequestId();
            progressPath = this.fileIpc.createProgressPath(requestId);

            // 現在時刻(JST)と曜日をコンテキストとして生成
            const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
            const nowJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
            const year = nowJst.getFullYear();
            const month = nowJst.getMonth() + 1;
            const day = nowJst.getDate();
            const dow = dayNames[nowJst.getDay()];
            const hours = String(nowJst.getHours()).padStart(2, '0');
            const minutes = String(nowJst.getMinutes()).padStart(2, '0');
            const datetimeStr = `${year}年${month}月${day}日（${dow}）${hours}:${minutes}`;

            // ルール内容をインライン展開用に準備
            const rulesInline = this.promptRulesContent || '';

            // プロンプト構築: JSON オブジェクト形式
            let finalPrompt: string;
            if (this.promptTemplate) {
                // テンプレート内のプレースホルダーを置換
                let expanded = this.promptTemplate
                    .replace(/\{\{datetime\}\}/g, datetimeStr)
                    .replace(/\{\{user_prompt\}\}/g, plan.prompt)
                    .replace(/\{\{response_path\}\}/g, responsePath)
                    .replace(/\{\{progress_path\}\}/g, progressPath)
                    .replace(/\{\{rules_content\}\}/g, rulesInline);
                // テンプレートが JSON の場合、追加プロパティを注入
                try {
                    const tplObj = JSON.parse(expanded);
                    if (plan.attachment_paths && plan.attachment_paths.length > 0) {
                        tplObj.attachments = plan.attachment_paths;
                        tplObj.attachments_instruction = '添付ファイルを view_file ツールで確認してください。';
                    }
                    if (this.userGlobalRules) {
                        tplObj.user_rules = this.userGlobalRules;
                        tplObj.user_rules_instruction = '出力のスタイルや口調に反映してください。';
                    }
                    finalPrompt = JSON.stringify(tplObj, null, 2);
                } catch {
                    // JSON パース失敗時はテキストとしてそのまま使用（旧 .md 互換）
                    finalPrompt = expanded;
                    if (plan.attachment_paths && plan.attachment_paths.length > 0) {
                        finalPrompt += `\n\n## 添付ファイル\n以下のファイルが Discord メッセージに添付されています。view_file ツールで内容を確認してください。\n\n`;
                        for (const p of plan.attachment_paths) {
                            finalPrompt += `- ${p}\n`;
                        }
                    }
                    if (this.userGlobalRules) {
                        finalPrompt += `\n\n## ユーザー設定\n${this.userGlobalRules}`;
                    }
                }
            } else {
                // インラインフォールバック: JSON オブジェクト
                const promptObj: Record<string, unknown> = {
                    task: 'execution',
                    context: { datetime_jst: datetimeStr },
                    prompt: plan.prompt,
                    output: {
                        response_path: responsePath,
                        format: 'markdown',
                        constraint: 'すべての作業が完了してから write_to_file で Markdown 形式のレスポンスを1回だけ書き込む。途中経過は書き込まない。ファイルに書き込んだ時点でレスポンス完了と見なされ、内容がそのまま Discord に送信される。Discord の Markdown 記法に準拠すること（**太字**, - 箇条書き, `コード` 等）。結果には何をしたか・変更内容・影響範囲・注意点などを具体的かつ詳細に記述すること。簡素すぎる報告は避ける。変更したファイル名・変更の概要・テスト結果・注意事項をすべて含めること。',
                    },
                    rules: rulesInline || undefined,
                    progress: {
                        path: progressPath,
                        instruction: '進捗ファイルに JSON で進捗状況を定期的に書き込むこと（write_to_file, Overwrite: true）。処理の各段階で必ず status を更新。30秒〜1分おきに percent と status を更新する。',
                        format: { status: '現在のステータス', detail: '詳細（任意）', percent: 50 },
                    },
                };
                if (plan.attachment_paths && plan.attachment_paths.length > 0) {
                    promptObj.attachments = plan.attachment_paths;
                    promptObj.attachments_instruction = '添付ファイルを view_file ツールで確認してください。';
                }
                if (this.userGlobalRules) {
                    promptObj.user_rules = this.userGlobalRules;
                    promptObj.user_rules_instruction = '出力のスタイルや口調に反映してください。';
                }
                finalPrompt = JSON.stringify(promptObj, null, 2);
            }

            // プロンプトを一時ファイルに書き出し、CDP には view_file 指示のみ送る
            const ipcDir = path.dirname(responsePath);
            const tmpExecPath = path.join(ipcDir, `tmp_exec_${requestId}.json`);
            fs.writeFileSync(tmpExecPath, finalPrompt, 'utf-8');
            logInfo(`Executor: prompt written to temp file: ${tmpExecPath}`);
            const cdpInstruction = `以下のファイルを view_file ツールで読み込み、その指示に従ってください。ファイルパス: ${tmpExecPath}`;

            // typing indicator 開始（実行中に「入力中...」を表示）
            const typingInterval = setInterval(async () => {
                try { await this.sendTypingToChannel(notifyChannel); } catch (e) { logDebug(`Executor: sendTyping failed: ${e}`); }
            }, RETRY_DELAY_MS);
            try { await this.sendTypingToChannel(notifyChannel); } catch (e) { logDebug(`Executor: sendTyping failed: ${e}`); }

            // 進捗監視ループ開始（3秒間隔）
            let lastProgressContent = '';
            const progressInterval = setInterval(async () => {
                try {
                    const progress = await this.fileIpc.readProgress(progressPath);
                    if (progress) {
                        const currentContent = JSON.stringify(progress);
                        if (currentContent !== lastProgressContent) {
                            lastProgressContent = currentContent;
                            const percentStr = progress.percent !== undefined ? ` (${progress.percent}%)` : '';
                            const detailStr = progress.detail ? `\n${progress.detail}` : '';
                            const progressMsg = `📊 **進捗${percentStr}:** ${progress.status}${detailStr}`;
                            logInfo(`Executor: progress update — ${progress.status}`);
                            await this.safeNotify(notifyChannel, progressMsg);
                        }
                    }
                } catch {
                    // 進捗ファイル読み取り失敗は無視
                }
            }, PROGRESS_POLL_INTERVAL_MS);

            let response: string;
            try {
                // CDP 経由で Antigravity にプロンプト送信（1行 view_file 指示のみ）
                // 接続エラー時は再接続を1回試みてリトライ
                try {
                    await this.cdp.sendPrompt(cdpInstruction);
                } catch (sendErr) {
                    if (sendErr instanceof CdpConnectionError) {
                        logWarn(`Executor: sendPrompt failed due to connection error, attempting reconnect — ${sendErr.message}`);
                        await this.safeNotify(notifyChannel, '🔌 接続断を検出しました。再接続中...');
                        try {
                            await this.cdp.ensureConnected();
                            logInfo('Executor: reconnected successfully, retrying sendPrompt');
                            await this.cdp.sendPrompt(cdpInstruction);
                        } catch (reconnectErr) {
                            logError('Executor: reconnect + retry failed', reconnectErr);
                            throw reconnectErr; // processQueue のリトライループに委譲
                        }
                    } else {
                        throw sendErr;
                    }
                }
                logInfo(`Executor: prompt sent, waiting for file response at ${responsePath}`);

                // 伝達完了ステータスを Discord に通知
                await this.safeNotify(notifyChannel, '✅ 指示を伝達しました。応答を待っています...');

                // ファイル経由でレスポンスを待機（AbortSignal 付き）
                // （UIウォッチャーは bridgeLifecycle で常時動作しているため、ここでは起動/停止しない）
                response = await this.fileIpc.waitForResponse(responsePath, this.timeoutMs, signal);
            } finally {
                clearInterval(typingInterval);
                clearInterval(progressInterval);
                // 進捗ファイルクリーンアップ
                await this.fileIpc.cleanupProgress(progressPath);
                // 一時プロンプトファイル削除
                try { fs.unlinkSync(tmpExecPath); } catch { /* ignore */ }
            }

            this.running = false;
            this.abortController = null;
            const durationMs = Date.now() - jobStartTime;
            logInfo(`Executor: plan ${plan.plan_id} — response received (${response.length} chars)`);

            // Markdown レスポンスはそのまま Discord に送信（JSON の場合はフォールバック展開）
            const isMarkdown = responsePath.endsWith('.md');
            const content = isMarkdown ? response.trim() : FileIpc.extractResult(response);

            // 成功通知（重複タイトル防止: レスポンスが prefix と同等の内容で始まる場合はスキップ）
            const prefix = plan.discord_templates.run_success_prefix || '✅ 実行完了';
            // prefix のテキスト部分（絵文字・太字マーカーを除去）を取り出し、レスポンス先頭と比較
            const prefixCore = prefix.replace(/[\s*]/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
            const contentStart = content.substring(0, 100).replace(/[\s*]/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
            const isDuplicate = prefixCore.length > 0 && contentStart.startsWith(prefixCore);
            const resultMsg = isDuplicate ? content : `${prefix}\n${content}`;
            logInfo(`Executor: sending success notification to channel ${notifyChannel} (${resultMsg.length} chars, prefixSkipped=${isDuplicate}, markdown=${isMarkdown})`);
            await this.safeNotify(notifyChannel, resultMsg, 0x00CED1);

            // 実行履歴を記録
            this.recordExecution(plan, true, durationMs, content);

            // 即時実行の重複防止
            if (!plan.cron) {
                this.recentlyExecutedPlanIds.add(plan.plan_id);
                setTimeout(() => this.recentlyExecutedPlanIds.delete(plan.plan_id), RECENT_EXECUTION_TTL_MS);
            }

            logInfo(`Executor: plan ${plan.plan_id} completed successfully`);
        } catch (err) {
            this.running = false;
            this.abortController = null;

            // 進捗ファイルクリーンアップ（エラー時も確実に削除）
            if (progressPath) { try { await this.fileIpc.cleanupProgress(progressPath); } catch (e) { logDebug(`Executor: progress cleanup failed: ${e}`); } }

            logError(`Executor: plan ${plan.plan_id} failed`, err);
            // processQueue のリトライループに制御を渡す
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

    /** 実行履歴をPlanStoreに記録（定期実行 Plan のみ） */
    private recordExecution(plan: Plan, success: boolean, durationMs: number, resultPreview: string): void {
        // 即時実行 Plan は PlanStore に存在しないのでスキップ
        if (!this.planStore.get(plan.plan_id)) {
            logInfo(`Executor: skipping execution record for plan ${plan.plan_id} (not in PlanStore)`);
            return;
        }
        try {
            const execution: PlanExecution = {
                executed_at: new Date().toISOString(),
                success,
                duration_ms: durationMs,
                result_preview: resultPreview.substring(0, 200),
            };
            const existingExecutions = plan.executions || [];
            const executions = [execution, ...existingExecutions].slice(0, 10); // 直近10件
            this.planStore.update(plan.plan_id, {
                last_executed_at: execution.executed_at,
                execution_count: (plan.execution_count || 0) + 1,
                executions,
            });
            logInfo(`Executor: recorded execution for plan ${plan.plan_id} (success=${success}, ${durationMs}ms)`);
        } catch (e) {
            logError('Executor: failed to record execution', e);
        }
    }

    /** 強制リセット: 実行状態をクリアする */
    forceReset(): void {
        this.running = false;
        this.processing = false;
        this.aborted = true;
        this.queue = [];
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        logInfo('Executor: force reset — running/processing/aborted flags set, queue emptied');
    }

    /** 強制停止: 現在実行中のジョブのみ停止する（キューは保持） */
    forceStop(): void {
        this.running = false;
        this.processing = false;
        this.aborted = true;
        this.currentJob = null;
        // AbortController で実行中の waitForResponse を即座にキャンセル
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            logInfo('Executor: abortController triggered — waitForResponse cancelled');
        }
        logInfo('Executor: force stop — running/processing/aborted flags set, queue preserved');
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
        logInfo(`Executor: cancelled queued job for plan ${planId}`);
        return true;
    }

    // -----------------------------------------------------------------------
    // UIウォッチャー（フェーズ4）
    // -----------------------------------------------------------------------

    /**
     * UIウォッチャーを開始する。
     * autoOperation が有効な場合、既知のダイアログ（Continue, Allow, Retry 等）を
     * 自動検出してクリックし、VSCode コマンド経由で提案を自動承認する。
     * bridgeLifecycle からブリッジ起動時に呼ばれる（常時動作）。
     */
    startUIWatcher(): void {
        if (this.uiWatcherTimer) { return; } // 既に動作中

        logInfo('Executor: UI watcher started');

        this.uiWatcherTimer = setInterval(async () => {
            // autoOperation 設定を毎回チェック（設定変更を動的に反映）
            const autoEnabled = vscode.workspace.getConfiguration('antiCrow')
                .get<boolean>('autoOperation') ?? false;
            if (!autoEnabled) { return; }

            // ANTICROW 経由のジョブ実行中のみ自動承認を行う
            if (!this.processing) { return; }

            // --- DOM ルールベースの自動クリック（直接クリック方式） ---
            // checkElementExists を省略し clickElement を直接呼ぶことで、
            // コンテキストID無効化による失敗リスクを半減させる。
            for (const rule of this.autoClickRules) {
                try {
                    const result = await this.cdp.clickElement({
                        text: rule.text,
                        selector: rule.selector,
                        tag: rule.tag,
                        inCascade: rule.inCascade !== false,
                    });

                    if (result.success) {
                        logInfo(`Executor: UI watcher auto-clicked "${rule.name}" (method=${result.method})`);
                    }
                } catch (e) {
                    // コンテキスト取得失敗時はキャッシュをリセットして次回再取得を促す
                    this.cdp.ops.resetCascadeContext();
                    logDebug(`Executor: UI watcher rule "${rule.name}" error (context reset): ${e instanceof Error ? e.message : e}`);
                }
            }

            // --- VSCode コマンド直接呼び出しによる自動承認 ---
            try {
                await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
            } catch { /* コマンドが存在しない場合は無視 */ }

            try {
                await vscode.commands.executeCommand('antigravity.terminal.accept');
            } catch { /* 同上 */ }
        }, UI_WATCHER_INTERVAL_MS);
    }

    /** UIウォッチャーを停止する */
    stopUIWatcher(): void {
        if (this.uiWatcherTimer) {
            clearInterval(this.uiWatcherTimer);
            this.uiWatcherTimer = null;
            logInfo('Executor: UI watcher stopped');
        }
    }
}
