// ---------------------------------------------------------------------------
// executor.ts — 直列実行キュー
// ---------------------------------------------------------------------------
// 不変条件: 同時実行なし（直列のみ）
// 実装: async/await ベースの FIFO キュー。
//   Promise チェーンで直列性を保証する。mutex ライブラリ不要。
// ---------------------------------------------------------------------------

import { ExecutionJob, Plan, PlanExecution } from './types';
import { CdpBridge } from './cdpBridge';
import { FileIpc, sanitizeWorkspaceName } from './fileIpc';
import { PlanStore } from './planStore';
import { readCombinedMemory, appendToGlobalMemory, appendToWorkspaceMemory, extractMemoryTags, stripMemoryTags } from './memoryStore';
import { logDebug, logError, logWarn } from './logger';
import { CdpConnectionError, IpcTimeoutError } from './errors';
import { updateAnticrowMd, getAnticrowMdPath } from './anticrowCustomizer';
import { getPromptRulesMd, EXECUTION_PROMPT_TEMPLATE } from './embeddedRules';
import { buildEmbed, EmbedColor } from './embedHelper';
import { parseSuggestions } from './suggestionParser';
import { buildSuggestionRow, buildSuggestionContent, storeSuggestions } from './suggestionButtons';
import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from 'discord.js';
import { UIWatcher } from './uiWatcher';
import * as vscode from 'vscode';
import { getMaxRetries, getTimezone, getWorkspacePaths } from './configHelper';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 進捗ファイル監視のポーリング間隔（ms） */
const PROGRESS_POLL_INTERVAL_MS = 3_000;
/** リトライ時の待機時間（ms） */
const RETRY_DELAY_MS = 8_000;
/** 重複実行防止: 最近の実行 ID を保持する期間（ms） */
const RECENT_EXECUTION_TTL_MS = 5 * 60 * 1000;

export type NotifyFunc = (channelId: string, message: string, color?: number) => Promise<void>;
export type SendTypingFunc = (channelId: string) => Promise<void>;
export type PostSuggestionsFunc = (channelId: string, components: ActionRowBuilder<ButtonBuilder>[], embed?: EmbedBuilder) => Promise<void>;

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
    private uiWatcher: UIWatcher | null = null;
    private typingInterval: ReturnType<typeof setInterval> | null = null;
    private progressInterval: ReturnType<typeof setInterval> | null = null;
    private extensionPath: string;
    private promptTemplate: string | null = null;
    private userGlobalRules: string | null = null;
    private promptRulesContent: string | null = null;
    private userMemory: string | null = null;
    private postSuggestions: PostSuggestionsFunc | null = null;

    constructor(cdp: CdpBridge, fileIpc: FileIpc, planStore: PlanStore, timeoutMs: number, notifyDiscord: NotifyFunc, sendTyping: SendTypingFunc, extensionPath?: string, postSuggestions?: PostSuggestionsFunc) {
        this.cdp = cdp;
        this.fileIpc = fileIpc;
        this.planStore = planStore;
        this.timeoutMs = timeoutMs;
        this.notifyDiscord = notifyDiscord;
        this.sendTypingToChannel = sendTyping;
        this.extensionPath = extensionPath || '';
        this.postSuggestions = postSuggestions ?? null;

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

    /** プロンプトルールを読み込む（タイムゾーンを動的に埋め込む） */
    private loadPromptRules(): void {
        this.promptRulesContent = getPromptRulesMd(getTimezone());
        logDebug(`Executor: loaded embedded prompt rules (${this.promptRulesContent.length} chars)`);
    }

    /** ユーザーグローバルルールを読み込む */
    private loadUserGlobalRules(): void {
        const homedir = os.homedir();
        const filePath = path.join(homedir, '.anticrow', 'SOUL.md');
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.trim().length > 0) {
                this.userGlobalRules = content.trim();
                logDebug(`Executor: loaded user global rules from ${filePath} (${this.userGlobalRules.length} chars)`);
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
                    await this.safeNotify(job.plan.notify_channel_id, `🔄 リトライ中... (${attempt}/${maxRetries})`);
                }
                try {
                    await this.executeJob(job);
                    success = true;
                } catch (retryErr) {
                    // aborted の場合はリトライせず即座に終了
                    if (this.aborted) {
                        logDebug(`Executor: plan ${job.plan.plan_id} aborted, skipping retry`);
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
            // ExecutorPool と CdpPool が 1:1 マッピングを保証しているため、
            // executeJob 内での動的なターゲット再探索・切替（レガシーな振る舞い）は削除。
            // 既存の this.cdp をそのまま使用する。

            // 開始通知
            const startMsg = plan.discord_templates.run_start
                || `⏳ 実行開始: ${plan.human_summary || plan.plan_id}`;
            logDebug(`Executor: sending start notification to channel ${notifyChannel}`);
            await this.safeNotify(notifyChannel, startMsg);

            // 実行詳細通知（execution_summary = prompt の要約と解説）
            try {
                const detailParts: string[] = [];
                const summary = plan.execution_summary || plan.action_summary || plan.human_summary;
                if (summary) {
                    detailParts.push(`📋 **実行内容**\n> ${summary.replace(/\n/g, '\n> ')}`);
                }
                if (detailParts.length > 0) {
                    await this.safeNotify(notifyChannel, detailParts.join('\n\n'));
                }
            } catch { /* 詳細通知失敗は無視 */ }

            // 実行前にユーザーグローバルルールを再読み込み（SOUL.md 更新反映）
            this.loadUserGlobalRules();

            // MEMORY.md を読み込み（グローバル + ワークスペース）
            {
                const wsPaths = getWorkspacePaths();
                const wsPath = plan.workspace_name ? wsPaths[plan.workspace_name] : undefined;
                this.userMemory = readCombinedMemory(wsPath);
            }

            logDebug(`Executor: executing plan ${plan.plan_id} — sending prompt via CDP (${plan.prompt.length} chars)`);
            this.running = true;

            // AbortController を生成（forceStop でキャンセル可能にする）
            this.abortController = new AbortController();
            const { signal } = this.abortController;

            // ファイルベース IPC: レスポンスパス（Markdown形式）と進捗パスを生成
            const { requestId, responsePath } = this.fileIpc.createMarkdownRequestId(plan.workspace_name);
            this.fileIpc.writeRequestMeta(requestId, notifyChannel, plan.workspace_name);
            progressPath = this.fileIpc.createProgressPath(requestId);

            // 現在時刻(JST)と曜日をコンテキストとして生成
            const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
            const nowJst = new Date(new Date().toLocaleString('en-US', { timeZone: getTimezone() }));
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
                    if (this.userMemory) {
                        tplObj.memory = this.userMemory;
                        tplObj.memory_instruction = 'これはエージェントの記憶です。過去の学びや教訓を参考にしてください。';
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
                    if (this.userMemory) {
                        finalPrompt += `\n\n## エージェントの記憶\n${this.userMemory}`;
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
                if (this.userMemory) {
                    promptObj.memory = this.userMemory;
                    promptObj.memory_instruction = 'これはエージェントの記憶です。過去の学びや教訓を参考にしてください。';
                }
                finalPrompt = JSON.stringify(promptObj, null, 2);
            }

            // プロンプトを一時ファイルに書き出し、CDP には view_file 指示のみ送る
            const ipcDir = path.dirname(responsePath);
            const wsExecPrefix = sanitizeWorkspaceName(plan.workspace_name);
            const tmpExecPath = wsExecPrefix
                ? path.join(ipcDir, `tmp_exec_${wsExecPrefix}_${requestId}.json`)
                : path.join(ipcDir, `tmp_exec_${requestId}.json`);
            fs.writeFileSync(tmpExecPath, finalPrompt, 'utf-8');
            logDebug(`Executor: prompt written to temp file: ${tmpExecPath}`);
            const cdpInstruction = `以下のファイルを view_file ツールで読み込み、その指示に従ってください。ファイルパス: ${tmpExecPath}`;

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
                            const progressMsg = `📊 **進捗${percentStr}:** ${progress.status}${detailStr}`;
                            logDebug(`Executor: progress update — ${progress.status}`);
                            await this.safeNotify(notifyChannel, progressMsg, EmbedColor.Progress);
                        }
                    }
                } catch {
                    // 進捗ファイル読み取り失敗は無視
                }

                // AI出力を自動追従（スクロール + 展開 + レビューUI消去）
                try {
                    await this.cdp.autoFollowOutput();
                } catch {
                    // 追従失敗は無視（接続断等）
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
                            logDebug('Executor: reconnected successfully, retrying sendPrompt');
                            await this.cdp.sendPrompt(cdpInstruction);
                        } catch (reconnectErr) {
                            logError('Executor: reconnect + retry failed', reconnectErr);
                            throw reconnectErr; // processQueue のリトライループに委譲
                        }
                    } else {
                        throw sendErr;
                    }
                }
                logDebug(`Executor: prompt sent, waiting for file response at ${responsePath}`);

                // 伝令完了ステータスを Discord に通知
                await this.safeNotify(notifyChannel, '✅ 指示を伝令しました。応答を待っています...');

                // 一時プロンプトファイルを即時クリーンアップ（レビューUI被り防止）
                // ただし自身の tmp_exec ファイルは除外（Antigravity が読み取り中の可能性）
                await this.fileIpc.cleanupTmpFiles([tmpExecPath]);

                // ファイル経由でレスポンスを待機（AbortSignal 付き）
                // （UIウォッチャーは bridgeLifecycle で常時動作しているため、ここでは起動/停止しない）
                response = await this.fileIpc.waitForResponse(responsePath, this.timeoutMs, signal);
            } finally {
                this.clearJobIntervals();
                // 進捗ファイルクリーンアップ
                await this.fileIpc.cleanupProgress(progressPath);
                // 一時プロンプトファイル削除
                try { fs.unlinkSync(tmpExecPath); } catch { /* ignore */ }
            }

            this.running = false;
            this.abortController = null;
            const durationMs = Date.now() - jobStartTime;
            logDebug(`Executor: plan ${plan.plan_id} — response received (${response.length} chars)`);

            // Markdown レスポンスはそのまま Discord に送信（JSON の場合はフォールバック展開）
            const isMarkdown = responsePath.endsWith('.md');
            const content = isMarkdown ? response.trim() : FileIpc.extractResult(response);

            // レスポンスから MEMORY タグを抽出して MEMORY.md に書き込み
            try {
                const memoryEntries = extractMemoryTags(content);
                if (memoryEntries.length > 0) {
                    const wsPaths = getWorkspacePaths();
                    const wsPath = plan.workspace_name ? wsPaths[plan.workspace_name] : undefined;
                    for (const entry of memoryEntries) {
                        if (entry.scope === 'global') {
                            appendToGlobalMemory(entry.content);
                            logDebug(`Executor: auto-recorded global memory (${entry.content.length} chars)`);
                        } else if (entry.scope === 'workspace' && wsPath) {
                            appendToWorkspaceMemory(wsPath, entry.content);
                            logDebug(`Executor: auto-recorded workspace memory (${entry.content.length} chars)`);
                        }
                    }
                    logDebug(`Executor: extracted ${memoryEntries.length} memory entries from response`);
                }
            } catch (e) {
                logDebug(`Executor: memory extraction failed: ${e instanceof Error ? e.message : e}`);
            }

            // MEMORY タグを除去してから Discord に送信
            const memoryCleanContent = stripMemoryTags(content);

            // 提案タグを抽出してクリーンコンテンツを取得
            const { suggestions, cleanContent } = parseSuggestions(memoryCleanContent);

            // 成功通知（重複タイトル防止: レスポンスが prefix と同等の内容で始まる場合はスキップ）
            const prefix = plan.discord_templates.run_success_prefix || '✅ 実行完了';
            // prefix のテキスト部分（絵文字・太字マーカーを除去）を取り出し、レスポンス先頭と比較
            const prefixCore = prefix.replace(/[\s*]/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
            const contentStart = cleanContent.substring(0, 100).replace(/[\s*]/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
            const isDuplicate = prefixCore.length > 0 && contentStart.startsWith(prefixCore);
            const resultMsg = isDuplicate ? cleanContent : `${prefix}\n${cleanContent}`;
            logDebug(`Executor: sending success notification to channel ${notifyChannel} (${resultMsg.length} chars, prefixSkipped=${isDuplicate}, markdown=${isMarkdown})`);
            await this.safeNotify(notifyChannel, resultMsg, EmbedColor.Response);

            // 提案ボタンを送信（提案があり、コールバックが設定されている場合）
            if (suggestions.length > 0 && this.postSuggestions) {
                try {
                    const row = buildSuggestionRow(suggestions);
                    if (row) {
                        storeSuggestions(notifyChannel, suggestions);
                        const suggestionText = buildSuggestionContent(suggestions);
                        const suggestionEmbed = buildEmbed(suggestionText, EmbedColor.Suggest);
                        await this.postSuggestions(notifyChannel, [row], suggestionEmbed);
                        logDebug(`Executor: sent ${suggestions.length} suggestion buttons to channel ${notifyChannel}`);
                    }
                } catch (e) {
                    logDebug(`Executor: failed to send suggestion buttons: ${e instanceof Error ? e.message : e}`);
                }
            }

            // 実行履歴を記録
            this.recordExecution(plan, true, durationMs, cleanContent);

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
            logDebug(`Executor: skipping execution record for plan ${plan.plan_id} (not in PlanStore)`);
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
            logDebug(`Executor: recorded execution for plan ${plan.plan_id} (success=${success}, ${durationMs}ms)`);
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
        // typing / progress interval を即座に停止
        this.clearJobIntervals();
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        // pending な jobCompletionResolvers を全て resolve
        for (const [planId, resolver] of this.jobCompletionResolvers.entries()) {
            logDebug(`Executor: force-resolving pending job completion for plan ${planId} (reset)`);
            resolver(false);
        }
        this.jobCompletionResolvers.clear();
        logDebug('Executor: force reset — running/processing/aborted flags set, queue emptied');
    }

    /** 強制停止: 現在実行中のジョブのみ停止する（キューは保持） */
    forceStop(): void {
        this.running = false;
        this.processing = false;
        this.aborted = true;
        this.currentJob = null;
        // typing / progress interval を即座に停止
        this.clearJobIntervals();
        // AbortController で実行中の waitForResponse を即座にキャンセル
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            logDebug('Executor: abortController triggered — waitForResponse cancelled');
        }
        // pending な jobCompletionResolvers を全て resolve して呼び出し元のハングを防止
        for (const [planId, resolver] of this.jobCompletionResolvers.entries()) {
            logDebug(`Executor: force-resolving pending job completion for plan ${planId}`);
            resolver(false);
        }
        this.jobCompletionResolvers.clear();
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
    // UIウォッチャー委譲
    // -----------------------------------------------------------------------

    /** UIウォッチャーを開始する（bridgeLifecycle から呼ばれる） */
    startUIWatcher(isProCheck?: () => boolean): void {
        this.stopUIWatcher();
        this.uiWatcher = new UIWatcher(this.cdp, () => this.processing, isProCheck);
        this.uiWatcher.start();
    }

    /** UIウォッチャーを停止する */
    stopUIWatcher(): void {
        if (this.uiWatcher) {
            this.uiWatcher.stop();
            this.uiWatcher = null;
        }
    }
}
