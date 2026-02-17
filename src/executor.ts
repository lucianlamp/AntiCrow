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
    // Expand All: 差分ビューの折りたたみ展開ボタン（aria-label で検索）
    { name: 'expand-all', selector: '[aria-label="Expand All"]', tag: 'button', inCascade: false },
    // Expand: 「N Step Requires Input」表示時の展開ボタン（cascade 内テキストマッチ）
    { name: 'expand-step-input', text: 'Expand', tag: 'button', inCascade: true },
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
    private running = false;
    private processing = false;
    private recentlyExecutedPlanIds = new Set<string>();
    private uiWatcherTimer: ReturnType<typeof setInterval> | null = null;
    private autoClickRules: AutoClickRule[] = [...DEFAULT_AUTO_CLICK_RULES];

    constructor(cdp: CdpBridge, fileIpc: FileIpc, planStore: PlanStore, timeoutMs: number, notifyDiscord: NotifyFunc, sendTyping: SendTypingFunc) {
        this.cdp = cdp;
        this.fileIpc = fileIpc;
        this.planStore = planStore;
        this.timeoutMs = timeoutMs;
        this.notifyDiscord = notifyDiscord;
        this.sendTypingToChannel = sendTyping;
    }

    /** 自動クリックルールを取得 */
    getAutoClickRules(): AutoClickRule[] {
        return [...this.autoClickRules];
    }

    /** 自動クリックルールを設定（デフォルトを上書き） */
    setAutoClickRules(rules: AutoClickRule[]): void {
        this.autoClickRules = [...rules];
        logInfo(`Executor: auto-click rules updated (${rules.length} rules)`);
    }

    /** ジョブをキューに追加 */
    enqueue(job: ExecutionJob): void {
        // 重複防止: 最近実行済みの plan_id はスキップ
        if (this.recentlyExecutedPlanIds.has(job.plan.plan_id)) {
            logWarn(`Executor: skipping duplicate job for plan ${job.plan.plan_id} (recently executed)`);
            return;
        }
        // 重複防止: 同じ plan_id が既にキューにある場合はスキップ
        if (this.queue.some(j => j.plan.plan_id === job.plan.plan_id)) {
            logWarn(`Executor: skipping duplicate job for plan ${job.plan.plan_id} (already in queue)`);
            return;
        }
        this.queue.push(job);
        logInfo(`Executor: enqueued job for plan ${job.plan.plan_id} (trigger: ${job.triggerType})`);
        this.processQueue();
    }

    /** 即時実行用ヘルパー */
    enqueueImmediate(plan: Plan): void {
        this.enqueue({ plan, triggerType: 'immediate' });
    }

    /** スケジュール実行用ヘルパー */
    enqueueScheduled(plan: Plan): void {
        this.enqueue({ plan, triggerType: 'schedule' });
    }

    /** キューを直列に処理 */
    private async processQueue(): Promise<void> {
        if (this.processing) { return; } // 既に処理中
        this.processing = true;

        while (this.queue.length > 0) {
            const job = this.queue.shift()!;
            await this.executeJob(job);
        }

        this.processing = false;
    }

    /** 個別ジョブの実行 */
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

            logInfo(`Executor: executing plan ${plan.plan_id} — sending prompt via CDP (${plan.prompt.length} chars)`);
            this.running = true;

            // ファイルベース IPC: レスポンスパスと進捗パスを生成
            const { requestId, responsePath } = this.fileIpc.createRequestId();
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
            const timeContext = `## コンテキスト\n現在時刻(JST): ${year}年${month}月${day}日（${dow}）${hours}:${minutes}\n\n`;

            // プロンプトにファイル書き込み指示と進捗ファイル指示を追加
            const promptWithFileInstruction = `${timeContext}${plan.prompt}

## 重要: 出力方法
結果をすべて以下のファイルパスに write_to_file ツールで書き込んでください。
チャットにも結果を出力してください。
ファイルパス: ${responsePath}

## 重要: Discord フォーマット制約
結果は Discord に送信されます。以下のルールに従ってください。
- 表形式データには **Markdown テーブル** を使用してください。Bot が自動的に Embed fields に変換します。
- Markdown テーブルの書式:
\`\`\`
| 項目     | 内容       |
| -------- | ---------- |
| 天気     | 晴れのち雨 |
| 最高気温 | 14℃       |
| 最低気温 | 5℃        |
\`\`\`
- 簡単な情報は箇条書き（- や •）で代替しても構いません。


## 進捗通知（任意）
処理が長くなる場合は、以下のファイルに進捗状況を JSON で書き込んでください（write_to_file, Overwrite: true）。
Discord に進捗がリアルタイム通知されます。書き込みは任意です。
ファイルパス: ${progressPath}
フォーマット: {"status": "現在のステータス", "detail": "詳細（任意）", "percent": 50}`;

            // 添付ファイルがある場合、プロンプトに追記
            let finalPrompt = promptWithFileInstruction;
            if (plan.attachment_paths && plan.attachment_paths.length > 0) {
                finalPrompt += `\n\n## 添付ファイル\n以下のファイルが Discord メッセージに添付されています。view_file ツールで内容を確認してください。\n\n`;
                for (const p of plan.attachment_paths) {
                    finalPrompt += `- ${p}\n`;
                }
            }

            // typing indicator 開始（実行中に「入力中...」を表示）
            const typingInterval = setInterval(async () => {
                try { await this.sendTypingToChannel(notifyChannel); } catch (e) { logDebug(`Executor: sendTyping failed: ${e}`); }
            }, 8_000);
            try { await this.sendTypingToChannel(notifyChannel); } catch (e) { logDebug(`Executor: sendTyping failed: ${e}`); }

            // 進捗監視ループ開始（5秒間隔）
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
            }, 5_000);

            let response: string;
            try {
                // CDP 経由で Antigravity にプロンプト送信（送信のみ）
                await this.cdp.sendPrompt(finalPrompt);
                logInfo(`Executor: prompt sent, waiting for file response at ${responsePath}`);

                // UIウォッチャー開始（ダイアログ自動クリック）
                this.startUIWatcher();

                // ファイル経由でレスポンスを待機
                response = await this.fileIpc.waitForResponse(responsePath, this.timeoutMs);
            } finally {
                // UIウォッチャー停止（必ず停止させる）
                this.stopUIWatcher();
                clearInterval(typingInterval);
                clearInterval(progressInterval);
                // 進捗ファイルクリーンアップ
                await this.fileIpc.cleanupProgress(progressPath);
            }

            this.running = false;
            const durationMs = Date.now() - jobStartTime;
            logInfo(`Executor: plan ${plan.plan_id} — response received (${response.length} chars)`);

            // 成功通知（重複タイトル防止: レスポンスが prefix と同等の内容で始まる場合はスキップ）
            const prefix = plan.discord_templates.run_success_prefix || '✅ 実行完了';
            const extracted = FileIpc.extractResult(response);
            // prefix のテキスト部分（絵文字・太字マーカーを除去）を取り出し、レスポンス先頭と比較
            const prefixCore = prefix.replace(/[\s*]/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
            const extractedStart = extracted.substring(0, 100).replace(/[\s*]/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
            const isDuplicate = prefixCore.length > 0 && extractedStart.startsWith(prefixCore);
            const resultMsg = isDuplicate ? extracted : `${prefix}\n${extracted}`;
            logInfo(`Executor: sending success notification to channel ${notifyChannel} (${resultMsg.length} chars, prefixSkipped=${isDuplicate})`);
            await this.safeNotify(notifyChannel, resultMsg, 0x00CED1);

            // 実行履歴を記録
            this.recordExecution(plan, true, durationMs, extracted);

            // 即時実行の重複防止
            if (!plan.cron) {
                this.recentlyExecutedPlanIds.add(plan.plan_id);
                setTimeout(() => this.recentlyExecutedPlanIds.delete(plan.plan_id), 5 * 60 * 1000);
            }

            logInfo(`Executor: plan ${plan.plan_id} completed successfully`);
        } catch (err) {
            this.running = false;
            const durationMs = Date.now() - jobStartTime;
            const errMsg = err instanceof Error ? err.message : String(err);

            // 進捗ファイルクリーンアップ（エラー時も確実に削除）
            if (progressPath) { try { await this.fileIpc.cleanupProgress(progressPath); } catch (e) { logDebug(`Executor: progress cleanup failed: ${e}`); } }

            // エラー通知
            const errorTemplate = plan.discord_templates.run_error || '❌ 実行失敗';
            logError(`Executor: plan ${plan.plan_id} failed — notifying channel ${notifyChannel}`, err);
            await this.safeNotify(notifyChannel, `${errorTemplate}\n\`\`\`\n${errMsg}\n\`\`\``);

            // 実行履歴を記録
            this.recordExecution(plan, false, durationMs, errMsg);

            logError(`Executor: plan ${plan.plan_id} failed`, err);
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
        this.queue = [];
        logInfo('Executor: force reset — running/processing flags cleared, queue emptied');
    }

    /** 現在実行中かどうか */
    isRunning(): boolean {
        return this.running;
    }

    /** キュー内のジョブ数 */
    queueLength(): number {
        return this.queue.length;
    }

    // -----------------------------------------------------------------------
    // UIウォッチャー（フェーズ4）
    // -----------------------------------------------------------------------

    /**
     * UIウォッチャーを開始する。
     * ジョブ実行中（sendPrompt → waitForResponse 間）に
     * 既知のダイアログ（Continue, Allow, Retry 等）を自動検出してクリックする。
     */
    private startUIWatcher(): void {
        if (this.uiWatcherTimer) { return; } // 既に動作中

        logInfo('Executor: UI watcher started');

        this.uiWatcherTimer = setInterval(async () => {
            for (const rule of this.autoClickRules) {
                try {
                    // まず存在チェック（クリックせずに確認）
                    const exists = await this.cdp.checkElementExists({
                        text: rule.text,
                        selector: rule.selector,
                        tag: rule.tag,
                        inCascade: rule.inCascade !== false,
                    });

                    if (!exists) { continue; }

                    // 要素が存在 → クリック実行
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
                    logDebug(`Executor: UI watcher rule "${rule.name}" scan error: ${e instanceof Error ? e.message : e}`);
                }
            }
        }, 2_000); // 2秒間隔
    }

    /** UIウォッチャーを停止する */
    private stopUIWatcher(): void {
        if (this.uiWatcherTimer) {
            clearInterval(this.uiWatcherTimer);
            this.uiWatcherTimer = null;
            logInfo('Executor: UI watcher stopped');
        }
    }
}
