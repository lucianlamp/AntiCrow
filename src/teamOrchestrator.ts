// ---------------------------------------------------------------------------
// teamOrchestrator.ts — エージェントチーム指揮官モード
// ---------------------------------------------------------------------------
// 責務:
//   1. チームモード有効時にユーザーのプロンプトをサブエージェントに分配
//   2. サブエージェントの進捗を監視（ポーリング）
//   3. 完了報告を集約して Discord に通知
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** git コマンドを安全に実行するヘルパー（シェルインジェクション対策） */
function gitExec(args: string[], opts: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, opts);
}
import { logDebug, logError, logInfo, logWarn } from './logger';
import { t } from './i18n';
import type { SubagentManager } from './subagentManager';
import { WorktreePool } from './subagentManager';
import type { FileIpc } from './fileIpc';
import { loadTeamConfig, type TeamConfig } from './teamConfig';
import type { TeamInstruction } from './subagentTypes';
import { resolveWorkspacePaths } from './configHelper';
import { buildInstructionContent } from './instructionBuilder';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** サブエージェントの進捗情報 */
interface AgentProgress {
    name: string;
    status: string;
    detail?: string;
    percent: number;
    lastUpdate: number;
}

/** オーケストレーション結果 */
export interface OrchestrationResult {
    agentName: string;
    success: boolean;
    response: string;
    durationMs: number;
    /** サブエージェント用スレッドID（存在する場合は結果をスレッドに送信） */
    threadId?: string;
}

/** Discord に送信するためのコールバック */
export type DiscordSender = (channelId: string, content: string) => Promise<void>;

/** Discord スレッド操作コールバック */
export interface ThreadOps {
    /** スレッドを作成し、スレッドIDを返す */
    createThread: (channelId: string, agentName: string, taskSummary?: string) => Promise<string | null>;
    /** スレッドにメッセージを送信 */
    sendToThread: (threadId: string, message: string) => Promise<boolean>;
    /** スレッドをアーカイブ */
    archiveThread: (threadId: string) => Promise<boolean>;
    /** スレッドに typing indicator を送信（オプション） */
    sendTyping?: (threadId: string) => Promise<void>;
}

/** 並列オーケストレーション結果 */
export interface ParallelOrchestrationResult {
    results: OrchestrationResult[];
    totalDurationMs: number;
    successCount: number;
    failCount: number;
}

// ---------------------------------------------------------------------------
// TeamOrchestrator
// ---------------------------------------------------------------------------

export class TeamOrchestrator {
    private readonly subagentManager: SubagentManager;
    private readonly fileIpc: FileIpc;
    private readonly sendToDiscord: DiscordSender;
    private readonly repoRoot: string;
    private monitorTimers = new Map<string, ReturnType<typeof setInterval>>();
    private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
    private disposed = false;
    private threadOps: ThreadOps | null = null;
    private worktreePool: WorktreePool;
    /** 外部からワークスペース名→パスのマッピングを取得するコールバック */
    private wsPathResolver: (() => Record<string, string>) | null = null;

    /** 実行時にワークスペースを動的に切り替えるための repoRoot 解決 */
    private getEffectiveRepoRoot(override?: string): string {
        return override || this.repoRoot;
    }

    /**
     * 外部ワークスペースパスリゾルバーを設定する。
     * CdpPool.getResolvedWorkspacePaths() を注入することで、
     * auto-learned ワークスペースパスを使えるようにする。
     */
    setWsPathResolver(resolver: () => Record<string, string>): void {
        this.wsPathResolver = resolver;
        logDebug('[TeamOrchestrator] wsPathResolver set');
    }

    /**
     * ワークスペース名からリポジトリルートパスを解決する。
     * 優先順位: wsPathResolver（cdpPool auto-learned）> resolveWorkspacePaths（settings.json）
     * 解決できない場合は undefined を返す（デフォルト repoRoot が使用される）。
     */
    private resolveRepoRootForWorkspace(workspaceName: string): string | undefined {
        try {
            // 1. 外部リゾルバー（cdpPool.getResolvedWorkspacePaths）を優先
            if (this.wsPathResolver) {
                const resolvedPaths = this.wsPathResolver();
                const resolvedPath = resolvedPaths[workspaceName];
                if (resolvedPath) {
                    logDebug(`[TeamOrchestrator] resolveRepoRootForWorkspace: "${workspaceName}" → "${resolvedPath}" (via wsPathResolver)`);
                    return resolvedPath;
                }
            }
            // 2. settings.json のフォールバック
            const wsPaths = resolveWorkspacePaths();
            const wsPath = wsPaths[workspaceName];
            if (wsPath) {
                logDebug(`[TeamOrchestrator] resolveRepoRootForWorkspace: "${workspaceName}" → "${wsPath}" (via settings)`);
                return wsPath;
            }
            logDebug(`[TeamOrchestrator] resolveRepoRootForWorkspace: "${workspaceName}" not found in any workspace paths, using default`);
            return undefined;
        } catch (err) {
            logWarn(`[TeamOrchestrator] resolveRepoRootForWorkspace error: ${err}`);
            return undefined;
        }
    }

    constructor(
        subagentManager: SubagentManager,
        fileIpc: FileIpc,
        sendToDiscord: DiscordSender,
        repoRoot: string,
    ) {
        this.subagentManager = subagentManager;
        this.fileIpc = fileIpc;
        this.sendToDiscord = sendToDiscord;
        this.repoRoot = repoRoot;

        // Worktree プールを初期化して SubagentManager に設定
        const pool = new WorktreePool(repoRoot);
        this.worktreePool = pool;
        if (subagentManager?.setWorktreePool) {
            subagentManager.setWorktreePool(pool);
        }
        logDebug('[TeamOrchestrator] WorktreePool を初期化しました');
    }

    /**
     * Discord スレッド操作コールバックを設定する。
     * Bot 初期化後に呼び出す。
     */
    setThreadOps(ops: ThreadOps): void {
        this.threadOps = ops;
        logDebug('[TeamOrchestrator] ThreadOps set');
    }

    // -----------------------------------------------------------------------
    // オーケストレーション
    // -----------------------------------------------------------------------

    /**
     * プロンプトをサブエージェントに送信し、完了を待って結果を返す。
     * 複数のサブエージェントを並行して実行する場合は、呼び出し側で複数回呼ぶ。
     */
    async orchestrate(
        prompt: string,
        channelId: string,
        agentName?: string,
        repoRootOverride?: string,
        workspaceName?: string,
    ): Promise<OrchestrationResult> {
        const effectiveRoot = this.getEffectiveRepoRoot(repoRootOverride);
        const config = loadTeamConfig(effectiveRoot);
        const startTime = Date.now();

        // Worktree プールの自動初期化
        if (!this.worktreePool.isInitialized) {
            await this.worktreePool.initialize(config.maxAgents || 3);
            logDebug(`[TeamOrchestrator] WorktreePool 自動初期化完了 (size=${config.maxAgents || 3})`);
        }

        // サブエージェントをスポーン（名前は SubagentManager が自動生成）
        const name = agentName ?? `agent-${Date.now()}`;
        logInfo(`[TeamOrchestrator] Spawning agent: ${name} (workspace=${workspaceName || 'default'})`);

        // Discord スレッド作成（threadOps が設定されている場合）
        let threadId: string | null = null;
        if (this.threadOps) {
            const taskPreview = prompt.substring(0, 500) + (prompt.length > 500 ? '...' : '');
            threadId = await this.threadOps.createThread(channelId, name);
            if (threadId) {
                logDebug(`[TeamOrchestrator] Created thread ${threadId} for agent "${name}"`);
                await this.threadOps.sendToThread(threadId,
                    `${t('team.taskPreviewLabel')}\n${taskPreview}`);
            }
        }

        // 進捗の送信先: スレッドがあればスレッド、なければメインチャンネル
        const progressChannelId = threadId || channelId;

        try {
            // ワークスペース名からリポジトリルートを解決
            const wsRepoRoot = workspaceName ? this.resolveRepoRootForWorkspace(workspaceName) : undefined;

            // spawn() は taskPrompt を受け取るが、ここでは後で sendPrompt するため省略
            const handle = await this.subagentManager.spawn(undefined, workspaceName, wsRepoRoot);

            // 進捗監視を開始（スレッドがあればスレッドに送信）
            this.startMonitor(handle.name, progressChannelId, config, threadId);

            // 起動通知は廃止 — 完了時に通知する

            // プロンプトを送信してレスポンスを待機
            const resp = await handle.sendPrompt(prompt);
            const durationMs = Date.now() - startTime;

            // 監視停止
            this.stopMonitor(name);

            const success = resp.status === 'success';
            logInfo(`[TeamOrchestrator] Agent "${name}" completed in ${durationMs}ms (${resp.status})`);

            // スレッドに完了通知
            if (threadId && this.threadOps) {
                const statusEmoji = success ? '✅' : '❌';
                await this.threadOps.sendToThread(threadId,
                    `${statusEmoji} ${t('team.completed')}`);
            }

            // メインチャンネルに完了通知（スレッドリンク付き）
            if (threadId) {
                await this.sendToDiscord(channelId,
                    `✅ ${t('team.completedMain')} <#${threadId}>`);
            } else {
                await this.sendToDiscord(channelId,
                    `✅ **"${name}"** ${t('team.completedMain')}`);
            }

            return {
                agentName: name,
                success,
                response: success ? resp.result : (resp.error ?? resp.result),
                durationMs,
                threadId: threadId ?? undefined,
            };
        } catch (e) {
            const durationMs = Date.now() - startTime;
            const errMsg = e instanceof Error ? e.message : String(e);
            logError(`[TeamOrchestrator] Agent "${name}" failed after ${durationMs}ms`, e);

            // 監視停止
            this.stopMonitor(name);

            // スレッドにエラー通知
            if (threadId && this.threadOps) {
                await this.threadOps.sendToThread(threadId,
                    `❌ **${t('team.errorOccurred')}**\n${errMsg}`).catch(() => { });
            }

            // メインチャンネルにもエラー通知
            if (threadId) {
                await this.sendToDiscord(channelId,
                    `❌ ${t('team.errorOccurred')} <#${threadId}>`).catch(() => { });
            } else {
                await this.sendToDiscord(channelId,
                    `❌ **"${name}"** ${t('team.errorOccurred')}\n${errMsg}`).catch(() => { });
            }

            return {
                agentName: name,
                success: false,
                response: errMsg,
                durationMs,
                threadId: threadId ?? undefined,
            };
        }
    }

    // -----------------------------------------------------------------------
    // サブエージェント監視
    // -----------------------------------------------------------------------

    /**
     * 指定のサブエージェントの進捗ファイルをポーリングし、
     * 更新があれば Discord に中間報告を送信する。
     */
    private startMonitor(agentName: string, channelId: string, config: TeamConfig, threadId?: string | null, agentIndex?: number): void {
        if (this.monitorTimers.has(agentName)) {
            return; // 既に監視中
        }

        let lastProgress: AgentProgress | null = null;
        const ipcDir = this.fileIpc.getIpcDir();

        const timer = setInterval(async () => {
            if (this.disposed) {
                this.stopMonitor(agentName);
                return;
            }

            try {
                // IPC ディレクトリから進捗ファイルを検索
                const progress = await this.readAgentProgress(ipcDir, agentName, agentIndex);
                if (!progress) { return; }

                // 前回と同じなら無視
                if (lastProgress &&
                    lastProgress.status === progress.status &&
                    lastProgress.percent === progress.percent &&
                    lastProgress.detail === progress.detail) {
                    return;
                }

                lastProgress = progress;

                // Discord に中間報告（パーセンテージ付きフォーマット）
                const progressMsg = `${progress.percent}% — ${progress.status}`
                    + (progress.detail ? `\n${progress.detail}` : '');

                if (threadId && this.threadOps) {
                    // スレッドに typing indicator を送信
                    if (this.threadOps.sendTyping) {
                        await this.threadOps.sendTyping(threadId).catch(() => { });
                    }
                    await this.threadOps.sendToThread(threadId, progressMsg);
                } else {
                    await this.sendToDiscord(channelId, progressMsg);
                }

            } catch (e) {
                logWarn(`[TeamOrchestrator] monitor error for "${agentName}": ${e instanceof Error ? e.message : e}`);
            }
        }, config.monitorIntervalMs);

        this.monitorTimers.set(agentName, timer);
        logDebug(`[TeamOrchestrator] Started monitoring "${agentName}" every ${config.monitorIntervalMs}ms`);

        // 8秒間隔のタイピングインジケーター（スレッドがある場合のみ）
        if (threadId && this.threadOps?.sendTyping) {
            const typingTimer = setInterval(async () => {
                if (this.disposed) { return; }
                try {
                    await this.threadOps!.sendTyping!(threadId!).catch(() => { });
                } catch { /* ignore */ }
            }, 8_000);
            this.typingTimers.set(agentName, typingTimer);
            // 初回即時送信
            this.threadOps.sendTyping(threadId).catch(() => { });
        }

        // 初回ポーリングを即座に実行（短いタスクでも進捗を検出できるようにする）
        // setInterval は初回実行が monitorIntervalMs 後のため、開始直後の進捗が検出されない
        setTimeout(() => {
            if (!this.disposed && this.monitorTimers.has(agentName)) {
                // タイマーのコールバックと同じロジックを即座に実行
                this.readAgentProgress(ipcDir, agentName, agentIndex)
                    .then(async (progress) => {
                        if (!progress) { return; }
                        const progressMsg = `${progress.percent}% — ${progress.status}`
                            + (progress.detail ? `\n${progress.detail}` : '');
                        if (threadId && this.threadOps) {
                            await this.threadOps.sendToThread(threadId, progressMsg);
                        } else {
                            await this.sendToDiscord(channelId, progressMsg);
                        }
                    })
                    .catch(() => { /* ignore first poll errors */ });
            }
        }, 3_000); // 3秒後に初回チェック（サブエージェントが進捗ファイルを書き込む猶予）
    }

    private stopMonitor(agentName: string): void {
        const timer = this.monitorTimers.get(agentName);
        if (timer) {
            clearInterval(timer);
            this.monitorTimers.delete(agentName);
            logDebug(`[TeamOrchestrator] Stopped monitoring "${agentName}"`);
        }
        const typingTimer = this.typingTimers.get(agentName);
        if (typingTimer) {
            clearInterval(typingTimer);
            this.typingTimers.delete(agentName);
        }
    }

    /**
     * IPC ディレクトリからサブエージェントの進捗ファイルを読み取る。
     * 以下のパターンに対応:
     *   1. req_{requestId}_agent{N}_progress.json（writeInstructionFiles が指定）
     *   2. req_{agentName}_{ts}_{uuid}_progress.json（executor が実際に生成）
     *   3. req_*_progress.json（汎用フォールバック、agentIndex 未指定時）
     */
    private async readAgentProgress(ipcDir: string, agentName: string, agentIndex?: number): Promise<AgentProgress | null> {
        try {
            const files = await fs.promises.readdir(ipcDir);

            // チームモード（agentIndex指定あり）の場合、複数パターンでマッチ
            let progressFiles: string[];
            if (agentIndex !== undefined) {
                // パターン1: _agent{N}_progress.json（writeInstructionFiles が指定するパス）
                const agentIdxPattern = `_agent${agentIndex}_progress.json`;
                // パターン2: req_{agentName}_{ts}_{uuid}_progress.json（executor が生成するパス）
                // agentName 例: "anti-crow-subagent-1"
                const agentNameEscaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const agentNamePattern = new RegExp(
                    `^req_${agentNameEscaped}_\\d+_[a-f0-9]+_progress\\.json$`
                );

                progressFiles = files
                    .filter(f => f.endsWith(agentIdxPattern) || agentNamePattern.test(f))
                    .sort()
                    .reverse();
            } else {
                // 非チームモード: 全 _progress.json にマッチ
                progressFiles = files
                    .filter(f => f.endsWith('_progress.json'))
                    .sort()
                    .reverse();
            }

            for (const file of progressFiles) {
                try {
                    const filePath = path.join(ipcDir, file);
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    const data = JSON.parse(content);
                    if (data.status) {
                        return {
                            name: agentName,
                            status: data.status,
                            detail: data.detail || data.currentStep,
                            percent: typeof data.percentage === 'number' ? data.percentage
                                : typeof data.percent === 'number' ? data.percent : 0,
                            lastUpdate: Date.now(),
                        };
                    }
                } catch { /* skip broken files */ }
            }
        } catch { /* ipc dir not found */ }
        return null;
    }

    // -----------------------------------------------------------------------
    // ユーティリティ
    // -----------------------------------------------------------------------

    // buildProgressBar は廃止

    /**
     * 全監視タイマーを停止し、リソースを解放する。
     */
    dispose(): void {
        this.disposed = true;
        for (const [name] of this.monitorTimers) {
            this.stopMonitor(name);
        }
        // Worktree プールの破棄
        this.worktreePool.dispose().catch(err => {
            logWarn(`[TeamOrchestrator] WorktreePool dispose 失敗: ${err}`);
        });
        logDebug('[TeamOrchestrator] disposed');
    }

    // -----------------------------------------------------------------------
    // タスク分割
    // -----------------------------------------------------------------------

    /**
     * プロンプトを独立したサブタスクに分割する。
     * 検出パターン:
     *   1. 番号付きリスト（1. / 1) / ① 等）
     *   2. 「タスクN:」「Task N:」パターン
     *   3. `---` セパレーター
     * 分割できない場合は元のプロンプト1件を返す。
     */
    splitTasks(prompt: string): string[] {
        const lines = prompt.split('\n');

        // コンテキスト行（タスクの前の背景情報）を抽出
        let contextLines: string[] = [];
        let taskStartIdx = -1;

        // パターン1: 番号付きリスト（1. / 1) / ① 等）
        const numberedPattern = /^\s*(?:\d+[\.\)\]）]|[①②③④⑤⑥⑦⑧⑨⑩])\s+/;
        const numberedIndices = lines
            .map((line, i) => numberedPattern.test(line) ? i : -1)
            .filter(i => i >= 0);

        if (numberedIndices.length >= 2) {
            taskStartIdx = numberedIndices[0];
            contextLines = lines.slice(0, taskStartIdx).filter(l => l.trim());
            const tasks: string[] = [];
            for (let i = 0; i < numberedIndices.length; i++) {
                const start = numberedIndices[i];
                const end = i + 1 < numberedIndices.length ? numberedIndices[i + 1] : lines.length;
                const taskContent = lines.slice(start, end).join('\n').trim();
                if (taskContent) { tasks.push(taskContent); }
            }
            if (tasks.length >= 2) {
                return this.prependContext(tasks, contextLines);
            }
        }

        // パターン2: 「タスクN:」「Task N:」パターン
        const taskLabelPattern = /^\s*(?:タスク|Task|TASK)\s*\d+\s*[:：]/i;
        const taskLabelIndices = lines
            .map((line, i) => taskLabelPattern.test(line) ? i : -1)
            .filter(i => i >= 0);

        if (taskLabelIndices.length >= 2) {
            taskStartIdx = taskLabelIndices[0];
            contextLines = lines.slice(0, taskStartIdx).filter(l => l.trim());
            const tasks: string[] = [];
            for (let i = 0; i < taskLabelIndices.length; i++) {
                const start = taskLabelIndices[i];
                const end = i + 1 < taskLabelIndices.length ? taskLabelIndices[i + 1] : lines.length;
                const taskContent = lines.slice(start, end).join('\n').trim();
                if (taskContent) { tasks.push(taskContent); }
            }
            if (tasks.length >= 2) {
                return this.prependContext(tasks, contextLines);
            }
        }

        // パターン3: `---` セパレーター
        const separatorPattern = /^\s*-{3,}\s*$/;
        const separatorIndices = lines
            .map((line, i) => separatorPattern.test(line) ? i : -1)
            .filter(i => i >= 0);

        if (separatorIndices.length >= 1) {
            const sections: string[] = [];
            let prevEnd = 0;
            for (const sepIdx of separatorIndices) {
                const section = lines.slice(prevEnd, sepIdx).join('\n').trim();
                if (section) { sections.push(section); }
                prevEnd = sepIdx + 1;
            }
            const lastSection = lines.slice(prevEnd).join('\n').trim();
            if (lastSection) { sections.push(lastSection); }

            if (sections.length >= 2) {
                return sections;
            }
        }

        // 分割できない場合は元のプロンプトを返す
        return [prompt];
    }

    /**
     * タスク数が maxAgents を超える場合、タスクをグループ化して maxAgents 以下に収める。
     * 例: maxAgents=3, tasks=6 → 3グループ（各2タスク）
     * タスク数が maxAgents 以下の場合はそのまま返す。
     */
    groupTasks(tasks: string[], maxAgents: number): string[] {
        if (tasks.length <= maxAgents || maxAgents <= 0) {
            return tasks;
        }

        const grouped: string[] = [];
        const tasksPerGroup = Math.ceil(tasks.length / maxAgents);

        for (let i = 0; i < maxAgents; i++) {
            const start = i * tasksPerGroup;
            const end = Math.min(start + tasksPerGroup, tasks.length);
            const groupTasks = tasks.slice(start, end);

            if (groupTasks.length === 0) { break; }

            if (groupTasks.length === 1) {
                grouped.push(groupTasks[0]);
            } else {
                // 複数タスクを1つにまとめる
                const combined = groupTasks
                    .map((task, idx) => `## サブタスク${String.fromCharCode(65 + idx)}\n${task}`)
                    .join('\n\n');
                grouped.push(combined);
            }
        }

        logInfo(`[TeamOrchestrator] groupTasks: ${tasks.length} tasks → ${grouped.length} groups (maxAgents=${maxAgents})`);
        return grouped;
    }

    /**
     * タスクリストから重複するタスクを除去する。
     * splitTasks の結果に対して呼び出し、同じ内容のタスクが複数のサブエージェントに
     * 割り当てられるのを防ぐ。
     *
     * 重複判定:
     *   1. 番号プレフィックス（「1. 」「## サブタスクA」等）と空白を除去して正規化
     *   2. 正規化後の文字列が完全一致 → 重複
     *   3. 正規化後の文字列の類似度が80%以上 → 重複
     *
     * 重複時は最も長い記述を保持する。
     *
     * @returns 重複除去済みのタスクリストと、除去されたタスク数
     */
    deduplicateTasks(tasks: string[]): { tasks: string[]; removedCount: number } {
        if (tasks.length <= 1) {
            return { tasks, removedCount: 0 };
        }

        const normalize = (text: string): string => {
            return text
                // 番号プレフィックス（1. / 1) / ① 等）を除去
                .replace(/^\s*(?:\d+[.\)）\]]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/gm, '')
                // ## サブタスクA 等のヘッダーを除去
                .replace(/^##\s*サブタスク[A-Z]\s*/gm, '')
                // ## 背景, ## タスク ヘッダーを除去
                .replace(/^##\s*(?:背景|タスク)\s*/gm, '')
                // 【サブエージェントタスク】等のプレフィックスを除去
                .replace(/【[^】]*】\s*/g, '')
                // 連続する空白・改行を単一スペースに
                .replace(/\s+/g, ' ')
                .trim();
        };

        const similarity = (a: string, b: string): number => {
            if (a === b) return 1.0;
            if (a.length === 0 || b.length === 0) return 0;
            const longer = a.length >= b.length ? a : b;
            const shorter = a.length >= b.length ? b : a;
            // 短い方が長い方に含まれているかチェック
            if (longer.includes(shorter)) return shorter.length / longer.length;
            // 共通文字数ベースの簡易類似度
            const charSet = new Set(shorter.split(''));
            let matchCount = 0;
            for (const c of longer) {
                if (charSet.has(c)) matchCount++;
            }
            return matchCount / longer.length;
        };

        const unique: { original: string; normalized: string }[] = [];
        let removedCount = 0;

        for (const task of tasks) {
            const norm = normalize(task);
            let isDuplicate = false;

            for (let i = 0; i < unique.length; i++) {
                const sim = similarity(norm, unique[i].normalized);
                if (sim >= 0.8) {
                    isDuplicate = true;
                    removedCount++;
                    // より長い記述を保持
                    if (task.length > unique[i].original.length) {
                        unique[i] = { original: task, normalized: norm };
                    }
                    logDebug(`[TeamOrchestrator] deduplicateTasks: 重複検出 (類似度=${(sim * 100).toFixed(0)}%)`);
                    break;
                }
            }

            if (!isDuplicate) {
                unique.push({ original: task, normalized: norm });
            }
        }

        if (removedCount > 0) {
            logInfo(`[TeamOrchestrator] deduplicateTasks: ${tasks.length} tasks → ${unique.length} unique (${removedCount} duplicates removed)`);
        }

        return { tasks: unique.map(u => u.original), removedCount };
    }

    /**
     * 各サブタスクにコンテキスト（背景情報）を付加する。
     */
    private prependContext(tasks: string[], contextLines: string[]): string[] {
        if (contextLines.length === 0) { return tasks; }
        const context = contextLines.join('\n');
        return tasks.map(task => `## 背景\n${context}\n\n## タスク\n${task}`);
    }

    // -----------------------------------------------------------------------
    // 並列オーケストレーション
    // -----------------------------------------------------------------------

    /**
     * 複数のサブタスクを並行してサブエージェントに委譲する。
     * maxAgents を超えるタスクは順次実行（バッチ分割）。
     */
    async orchestrateParallel(
        tasks: string[],
        channelId: string,
        repoRootOverride?: string,
        workspaceName?: string,
    ): Promise<ParallelOrchestrationResult> {
        const effectiveRoot = this.getEffectiveRepoRoot(repoRootOverride);
        const config = loadTeamConfig(effectiveRoot);
        const startTime = Date.now();
        const maxConcurrent = Math.min(tasks.length, config.maxAgents);

        logInfo(`[TeamOrchestrator] Parallel orchestration: ${tasks.length} tasks, max concurrent: ${maxConcurrent}`);

        await this.sendToDiscord(channelId,
            `🚀 **${tasks.length}個のタスクを並行実行します**（最大同時: ${maxConcurrent}）`);

        const allResults: OrchestrationResult[] = [];

        // バッチ分割: maxConcurrent ずつ並行実行
        for (let batchStart = 0; batchStart < tasks.length; batchStart += maxConcurrent) {
            const batch = tasks.slice(batchStart, batchStart + maxConcurrent);
            const batchNum = Math.floor(batchStart / maxConcurrent) + 1;
            const totalBatches = Math.ceil(tasks.length / maxConcurrent);

            if (totalBatches > 1) {
                await this.sendToDiscord(channelId,
                    `📦 **バッチ ${batchNum}/${totalBatches}** を実行中（${batch.length}タスク）`);
            }

            // 並行実行: Promise.allSettled で全タスクの完了を待つ
            const promises = batch.map((task, idx) => {
                const taskIdx = batchStart + idx + 1;
                return this.orchestrate(task, channelId, undefined, repoRootOverride, workspaceName)
                    .then(result => ({
                        ...result,
                        agentName: `${t('team.subagentLabel')}${taskIdx}: ${result.agentName}`,
                    }));
            });

            const settled = await Promise.allSettled(promises);

            for (const result of settled) {
                if (result.status === 'fulfilled') {
                    allResults.push(result.value);
                } else {
                    allResults.push({
                        agentName: 'unknown',
                        success: false,
                        response: result.reason instanceof Error ? result.reason.message : String(result.reason),
                        durationMs: Date.now() - startTime,
                    });
                }
            }
        }

        const totalDurationMs = Date.now() - startTime;
        const successCount = allResults.filter(r => r.success).length;
        const failCount = allResults.length - successCount;

        logInfo(`[TeamOrchestrator] Parallel orchestration completed: ${successCount} succeeded, ${failCount} failed, ${totalDurationMs}ms total`);

        return {
            results: allResults,
            totalDurationMs,
            successCount,
            failCount,
        };
    }

    // -----------------------------------------------------------------------
    // チームモード新設計: IPC ファイルベースのオーケストレーション
    // -----------------------------------------------------------------------

    /**
     * Phase 2: メインエージェントが生成したタスク分割を IPC 指令ファイルとして書き出す。
     *
     * 書き出す JSON は tmp_exec_*.json と同じ構造化フォーマット
     * （task/context/prompt/output/rules/progress）に統一。
     *
     * @returns 書き出した指令ファイルのパス一覧（内部管理用の TeamInstruction 配列）
     */
    writeInstructionFiles(
        tasks: string[],
        requestId: string,
        originalContext: string,
    ): TeamInstruction[] {
        const ipcDir = this.fileIpc.getIpcDir();
        const instructions: TeamInstruction[] = [];

        for (let i = 0; i < tasks.length; i++) {
            const agentIndex = i + 1;

            // 他のサブエージェントのタスク概要（重複防止用）
            const otherTasks = tasks
                .map((tk, j) => j !== i ? `${t('team.subagentLabel')}${j + 1}: ${tk.substring(0, 50)}${tk.length > 50 ? '...' : ''}` : null)
                .filter((x): x is string => x !== null);

            const progressPath = path.join(ipcDir, `req_${requestId}_agent${agentIndex}_progress.json`);

            // 内部管理用: collectResponses 等で参照するフィールドを維持
            // response_path は空文字列: レスポンスは SubagentReceiver の req_*_response.md のみ
            const instruction: TeamInstruction = {
                persona: '', // 廃止: JSON ファイルには書き出さない
                agentIndex,
                task: tasks[i],
                response_path: '',
                progress_path: progressPath,
                context: originalContext,
                timestamp: Date.now(),
                requestId,
                totalAgents: tasks.length,
            };

            // 共通ヘルパーで instruction.json を構築・書き出し
            const taskPrompt = `⚠️ 以下はあなた専用のタスクです。他のサブエージェントのタスクは無視してください。\n\n${tasks[i]}`;
            const fileContent = buildInstructionContent({
                prompt: taskPrompt,
                context: {
                    team: {
                        agentIndex,
                        totalAgents: tasks.length,
                        otherTasks,
                    },
                    original_request: originalContext,
                },
                progressPath,
                executionRules: [
                    'このタスクは既に計画済みです。計画の生成や承認は不要で、直ちに実行に移ってください',
                    'plan_generation タスクを生成しないでください。実行（execution）のみを行ってください',
                    '他のサブエージェントの担当範囲には手を出さないでください。あなたの担当範囲のみを実行すること',
                    '同じファイルの同じ箇所を修正しないでください',
                    'VSIX インストール（antigravity --install-extension）やデプロイコマンドは実行しないでください。ビルドとパッケージングまでが担当範囲です',
                ],
            });

            const instructionPath = path.join(ipcDir, `tmp_exec_anti-crow_req_${requestId}_agent${agentIndex}.json`);
            fs.writeFileSync(instructionPath, JSON.stringify(fileContent, null, 2), 'utf-8');
            logInfo(`[TeamOrchestrator] Wrote instruction file: ${instructionPath}`);
            instructions.push(instruction);
        }

        return instructions;
    }


    /**
     * Phase 3~5: サブエージェントを起動し、指令を送信し、レスポンスを収集してメインエージェントに報告する。
     *
     * Discord Bot がすべてを中継制御する。
     *
     * @param instructions - writeInstructionFiles() で作成した指令一覧
     * @param channelId - Discord メインチャンネルID
     * @param activeCdp - メインエージェントの CdpBridge（報告プロンプト送信用）
     * @param signal - キャンセル用 AbortSignal
     */
    async orchestrateTeam(
        instructions: TeamInstruction[],
        channelId: string,
        workspaceName?: string,
        signal?: AbortSignal,
    ): Promise<ParallelOrchestrationResult> {
        const config = loadTeamConfig(this.getEffectiveRepoRoot());
        const startTime = Date.now();
        const ipcDir = this.fileIpc.getIpcDir();
        const effectiveRepoRoot = this.getEffectiveRepoRoot();

        logInfo(`[TeamOrchestrator] orchestrateTeam: ${instructions.length} agents, workspace=${workspaceName || 'default'}, useDirectEdit=${config.useDirectEdit}`);

        // --- orphan worktree のクリーンアップ ---
        await this.cleanupOrphanWorktrees(effectiveRepoRoot);

        // --- 共有タスクリスト生成 ---
        const taskListPath = this.generateSharedTaskList(
            ipcDir, instructions, instructions[0]?.requestId || 'unknown',
        );

        // ウィンドウ再利用が有効な場合: アイドルプールから回収を試みる
        if (this.subagentManager.enableWindowReuse) {
            logInfo('[TeamOrchestrator] ウィンドウ再利用モード: アイドルプールから回収を試みます');
            const reclaimed = await this.subagentManager.reclaimFromIdlePool();
            logInfo(`[TeamOrchestrator] アイドルプールから ${reclaimed.length} 個のウィンドウを回収`);
            // killAll はスキップ（再利用可能なウィンドウを殺さない）
            // ただし stale エージェントはクリーンアップ
            const staleCount = await this.subagentManager.cleanupStaleAgents();
            if (staleCount > 0) {
                logInfo(`[TeamOrchestrator] Cleaned up ${staleCount} stale agents`);
            }
        } else {
            // 従来動作: 前回のサブエージェントのウィンドウを全て閉じる
            await this.subagentManager.killAll();

            // killAll() で閉じきれなかった stale エージェントをクリーンアップ
            const staleCount = await this.subagentManager.cleanupStaleAgents();
            if (staleCount > 0) {
                logInfo(`[TeamOrchestrator] Cleaned up ${staleCount} stale agents before team orchestration`);
            }
        }

        await this.sendToDiscord(channelId,
            `🚀 **チームモード**: ${instructions.length}個のサブエージェントを起動します`);

        // --- Phase 3: サブエージェント起動 & プロンプト送信 ---
        const agentThreads = new Map<number, string>(); // agentIndex -> threadId
        const agentNames = new Map<number, string>();     // agentIndex -> agentName

        // 個別のサブエージェント起動処理（1エージェント分）
        const spawnAgent = async (instruction: TeamInstruction): Promise<void> => {
            if (signal?.aborted) {
                throw new Error('Team orchestration aborted');
            }

            try {
                // ワークスペース名からリポジトリルートを解決
                const wsRepoRoot = workspaceName ? this.resolveRepoRootForWorkspace(workspaceName) : undefined;

                // サブエージェントを spawn
                const handle = await this.subagentManager.spawn(undefined, workspaceName, wsRepoRoot);
                agentNames.set(instruction.agentIndex, handle.name);
                logInfo(`[TeamOrchestrator] Spawned agent ${handle.name} for task ${instruction.agentIndex}`);

                // Discord スレッド作成（状況見える化用）
                let threadId: string | null = null;
                if (this.threadOps) {
                    const taskPreview = instruction.task.substring(0, 500) + (instruction.task.length > 500 ? '...' : '');
                    // スレッド名は「サブエージェントN」
                    threadId = await this.threadOps.createThread(
                        channelId,
                        `${t('team.subagentLabel')}${instruction.agentIndex}`,
                    );
                    if (threadId) {
                        agentThreads.set(instruction.agentIndex, threadId);
                        // 開始通知に作業内容を含める
                        await this.threadOps.sendToThread(threadId,
                            `📋 **作業内容:**\n${taskPreview}`
                        );
                    }
                }

                // 進捗モニター開始（スレッドに送信、agentIndexでフィルタ）
                this.startMonitor(handle.name, threadId || channelId, config, threadId, instruction.agentIndex);

                // サブエージェントにプロンプト送信:
                // 通常モードと同じ「ファイル読み取り方式」— 短い指示のみ送信
                const instructionPath = path.join(ipcDir, `tmp_exec_anti-crow_req_${instruction.requestId}_agent${instruction.agentIndex}.json`);

                // 直接編集モード: 元リポジトリのパスで作業するよう指示を追加
                let subagentPrompt =
                    `以下のファイルを view_file ツールで読み込み、その指示に従ってください。` +
                    `ファイルパス: ${instructionPath}`;

                if (config.useDirectEdit) {
                    const wsRepoRootPath = wsRepoRoot || effectiveRepoRoot;
                    subagentPrompt += `\n\n` +
                        `※重要: ファイルの編集・作成・削除はすべて元のリポジトリパス ${wsRepoRootPath} に対して行ってください。` +
                        `現在開いている worktree ディレクトリ内のファイルは編集しないでください。` +
                        `ファイルの読み取りも元のリポジトリパスで行ってください。`;
                }

                // 共有タスクリストの参照指示を追加
                if (taskListPath) {
                    const statusDir = path.dirname(taskListPath);
                    const requestIdMatch = path.basename(taskListPath).match(/team_tasklist_(.+)\.json/);
                    const taskRequestId = requestIdMatch ? requestIdMatch[1] : '';
                    const agentStatusFile = path.join(statusDir, `team_status_${taskRequestId}_agent${instruction.agentIndex}.json`);

                    subagentPrompt += `\n\n` +
                        `📋 共有タスクリスト: ${taskListPath}（読み取り専用）\n` +
                        `このファイルにはチーム全体のタスク一覧が記載されています。\n` +
                        `❗ このファイルは直接編集しないでください。代わりに以下の個別ステータスファイルを更新してください。\n` +
                        `📄 自分のステータスファイル: ${agentStatusFile}\n` +
                        `- 作業開始時: {"status": "in_progress", "startedAt": ${Date.now()}} を書き込んでください\n` +
                        `- 作業完了時: {"status": "completed", "completedAt": ${Date.now()}} を書き込んでください\n` +
                        `- 失敗時: {"status": "failed", "completedAt": ${Date.now()}} を書き込んでください\n`;

                    if (config.enableHelperMode && config.useDirectEdit) {
                        subagentPrompt += `\n\n` +
                            `🤝 **ヘルプモード（重要）**\n` +
                            `自分のメインタスクが完了したら、以下の手順で他のタスクを手伝ってください:\n\n` +
                            `1. 共有タスクリスト（${taskListPath}）を view_file ツールで読み込む\n` +
                            `2. "status" が "pending" のタスクがあるか確認する\n` +
                            `3. "pending" のタスクがあれば、そのタスクの "fullTask" フィールドの内容を実行する\n` +
                            `4. 実行前に自分のステータスファイルに {"status": "helping", "helpingTask": N} を書き込む\n` +
                            `5. **制約**: 他エージェントが作業中（"in_progress"）のファイルは絶対に上書きしないこと\n` +
                            `6. **優先順位**: テスト作成 > ドキュメント更新 > コードレビュー > 未着手の関連作業\n` +
                            `7. 全タスクが "completed" または "in_progress" なら、ヘルプ不要。作業を終了してよい\n`;
                    }
                }

                await handle.sendPromptFireAndForget(subagentPrompt);

                // 起動通知は廃止 — 完了時に通知する

            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                logError(`[TeamOrchestrator] Failed to spawn/send agent ${instruction.agentIndex}: ${errMsg}`, e);
                await this.sendToDiscord(channelId,
                    `❌ ${t('team.subagentLabel')}${instruction.agentIndex} の起動に失敗しました: ${errMsg}`);
            }
        };

        // enableParallel 設定に基づいて並行/直列を切り替え
        if (config.enableParallel) {
            // 並行起動: maxAgents ずつバッチ分割して Promise.allSettled で同時実行
            const maxConcurrent = config.maxAgents;
            logInfo(`[TeamOrchestrator] Parallel spawn enabled: ${instructions.length} agents, max concurrent: ${maxConcurrent}`);

            for (let batchStart = 0; batchStart < instructions.length; batchStart += maxConcurrent) {
                if (signal?.aborted) {
                    throw new Error('Team orchestration aborted');
                }

                const batch = instructions.slice(batchStart, batchStart + maxConcurrent);
                const batchNum = Math.floor(batchStart / maxConcurrent) + 1;
                const totalBatches = Math.ceil(instructions.length / maxConcurrent);

                if (totalBatches > 1) {
                    await this.sendToDiscord(channelId,
                        `📦 **バッチ ${batchNum}/${totalBatches}** を起動中（${batch.length}エージェント）`);
                }

                // バッチ内は並行実行
                await Promise.allSettled(batch.map(inst => spawnAgent(inst)));
            }
        } else {
            // 直列起動（従来動作）
            logInfo(`[TeamOrchestrator] Sequential spawn: ${instructions.length} agents`);
            for (const instruction of instructions) {
                await spawnAgent(instruction);
            }
        }

        // --- Phase 4 & 5: レスポンス収集 ---
        const results = await this.collectResponses(
            instructions,
            channelId,
            config,
            agentThreads,
            agentNames,
            taskListPath,
            signal,
        );

        const totalDurationMs = Date.now() - startTime;
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;

        logInfo(`[TeamOrchestrator] orchestrateTeam completed: ${successCount}/${results.length} succeeded, ${totalDurationMs}ms`);

        // --- 全サブエージェントの変更をメインブランチにマージ ---
        if (config.useDirectEdit) {
            // 直接編集モード: マージ不要（全エージェントが元リポジトリに直接編集済み）
            logInfo('[TeamOrchestrator] 直接編集モード: マージステップをスキップ');
        } else {
            // 従来モード: worktreeの変更をマージ
            logInfo('[TeamOrchestrator] 全サブエージェントの変更をメインブランチにマージします...');
            let mergedCount = 0;
            let conflictCount = 0;
            for (const [, agentName] of agentNames) {
                const handle = this.subagentManager.getAgent(agentName);
                if (handle) {
                    const mergeResult = await handle.mergeChanges();
                    if (mergeResult.merged) {
                        mergedCount++;
                    } else if (mergeResult.conflicted) {
                        conflictCount++;
                        logWarn(`[TeamOrchestrator] サブエージェント "${agentName}" のマージにコンフリクトが発生しました`);
                    }
                }
            }
            if (mergedCount > 0 || conflictCount > 0) {
                logInfo(`[TeamOrchestrator] マージ結果: ${mergedCount} 成功, ${conflictCount} コンフリクト`);
                await this.sendToDiscord(channelId,
                    `🔀 **マージ結果**: ${mergedCount} サブエージェントの変更をマージ成功` +
                    (conflictCount > 0 ? `, ${conflictCount} コンフリクト` : ''));
            }
        }

        // --- クリーンアップ ---
        logInfo('[TeamOrchestrator] worktree のクリーンアップを実行します...');
        for (const [, agentName] of agentNames) {
            const handle = this.subagentManager.getAgent(agentName);
            if (handle) {
                try {
                    await handle.close();
                    logDebug(`[TeamOrchestrator] サブエージェント "${agentName}" をクローズ（worktree 削除完了）`);
                } catch (closeErr) {
                    logWarn(`[TeamOrchestrator] サブエージェント "${agentName}" のクローズに失敗: ${closeErr}`);
                }
            }
        }

        // --- 最終検証: 残留 worktree フォルダがあれば強制削除 ---
        await this.verifyWorktreeCleanup(effectiveRepoRoot, agentNames);

        // ウィンドウ再利用モード
        if (this.subagentManager.enableWindowReuse) {
            // アイドルプール移動前に worktree を確実にクリーンアップ
            for (const [, agentName] of agentNames) {
                const handle = this.subagentManager.getAgent(agentName);
                if (handle && fs.existsSync(handle.worktreePath)) {
                    // プール worktree は削除しない（再利用するため）
                    if (handle.poolEntryIndex === undefined) {
                        try {
                            await handle.cleanupWorktree();
                            logDebug(`[TeamOrchestrator] アイドルプール移動前に worktree 削除: ${agentName}`);
                        } catch (e) {
                            logWarn(`[TeamOrchestrator] アイドルプール前 worktree 削除失敗: ${agentName}: ${e}`);
                        }
                    } else {
                        logDebug(`[TeamOrchestrator] プール worktree は再利用のため保持: ${agentName}`);
                    }
                }
            }
            for (const [, agentName] of agentNames) {
                const handle = this.subagentManager.getAgent(agentName);
                if (handle) {
                    await this.subagentManager.moveToIdlePool(handle);
                }
            }
            this.subagentManager.startIdleCleanup();
            logInfo(`[TeamOrchestrator] ${agentNames.size} 個のウィンドウをアイドルプールに移動`);
        }

        return {
            results,
            totalDurationMs,
            successCount,
            failCount,
        };
    }

    /**
     * Phase 4 & 5: サブエージェントのレスポンスを収集し、スレッドに報告する。
     * 全レスポンスが揃ったら報告用 IPC ファイルを生成。
     */
    private async collectResponses(
        instructions: TeamInstruction[],
        channelId: string,
        config: TeamConfig,
        agentThreads: Map<number, string>,
        agentNames: Map<number, string>,
        taskListPath: string | null,
        signal?: AbortSignal,
    ): Promise<OrchestrationResult[]> {
        const results: OrchestrationResult[] = [];
        const ipcDir = this.fileIpc.getIpcDir();

        // 完了カウンター（並行実行のため各完了時にインクリメント）
        let completedCount = 0;

        // ヘルパーモード用: 完了済みエージェントのインデックスを追跡
        const completedAgentIndices = new Set<number>();
        // ヘルパーモード用: ヘルパーとして支援済みのペアを追跡（二重送信防止）
        const helperPairs = new Set<string>();

        // ヘルパーモード: useDirectEdit が有効な場合のみ動作（worktreeモードではコンフリクトリスクのため無効）
        const helperModeActive = config.enableHelperMode && config.useDirectEdit;
        if (helperModeActive) {
            logInfo(`[TeamOrchestrator] ${t('team.helperModeEnabled')}`);
            await this.sendToDiscord(channelId, t('team.helperModeEnabled'));
        } else if (config.enableHelperMode && !config.useDirectEdit) {
            logInfo('[TeamOrchestrator] ヘルパーモードは直接編集モード（useDirectEdit: true）でのみ有効です。スキップします。');
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
                const agentNameEscaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const responsePattern = new RegExp(
                    // subagentIpc.ts の writeResponse が書き込むパターン（最優先）
                    `^subagent_${agentNameEscaped}_response_\\d+\\.json$` +
                    // req_{name}_{ts}_{uuid}_response.md パターン（フォールバック）
                    `|^req_${agentNameEscaped}_\\d+_[a-f0-9]+_response\\.md$` +
                    `|^req_anti-crow-subagent-${instruction.agentIndex}_\\d+_[a-f0-9]+_response\\.md$`
                );

                // primaryPath: IPCディレクトリ内のダミーパス（dir 導出に使用）
                const primaryPath = path.join(ipcDir, `subagent_${agentName}_response_primary.json`);

                // レスポンスファイルの出現を待機（パターンベース + 正しいディレクトリ）
                const response = await this.fileIpc.waitForResponseWithPattern(
                    primaryPath,
                    responsePattern,
                    config.responseTimeoutMs,
                    signal,
                );

                const durationMs = Date.now() - startTime;
                this.stopMonitor(agentName);

                logInfo(`[TeamOrchestrator] Agent ${instruction.agentIndex} (${agentName}) completed in ${durationMs}ms`);

                // スレッドに完了通知
                if (threadId && this.threadOps) {
                    await this.threadOps.sendToThread(threadId,
                        `✅ **${t('team.taskCompleted')}**`);
                }

                // メインチャンネルに完了通知（スレッドリンク + N/M 表記付き）
                completedCount++;
                if (threadId) {
                    await this.sendToDiscord(channelId,
                        `✅ ${completedCount}/${instructions.length} 完了しました <#${threadId}>`);
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
                            logInfo(`[TeamOrchestrator] ${helperMsg}`);
                            await this.sendToDiscord(channelId, helperMsg);

                            // 共有タスクリストを更新（helped ステータス）
                            if (taskListPath) {
                                this.updateSharedTaskStatus(taskListPath, targetInstruction.agentIndex, 'helped');
                            }

                            // 完了したエージェントにフォローアッププロンプトを送信
                            const handle = this.subagentManager.getAgent(agentName);
                            if (handle) {
                                try {
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
                                    await handle.sendPrompt(followupPrompt);
                                    logInfo(`[TeamOrchestrator] ヘルパープロンプト送信完了: ${agentName} -> タスク${targetInstruction.agentIndex}`);
                                } catch (helperErr) {
                                    logWarn(`[TeamOrchestrator] ヘルパープロンプト送信失敗: ${helperErr}`);
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
                } as OrchestrationResult;

            } catch (e) {
                const durationMs = Date.now() - startTime;
                const errMsg = e instanceof Error ? e.message : String(e);
                this.stopMonitor(agentName);

                // IPC中断フォールバック: 進捗ファイルから部分完了情報を復元
                let partialSuccess = false;
                try {
                    const progressContent = await this.fileIpc.readProgress(instruction.progress_path);
                    if (progressContent && typeof progressContent.percent === 'number' && progressContent.percent >= 50) {
                        partialSuccess = true;
                        logWarn(`[TeamOrchestrator] Agent ${instruction.agentIndex} (${agentName}) IPC interrupted but progress was ${progressContent.percent}%. Treating as partial success.`);
                        // メインチャンネルに通知
                        await this.sendToDiscord(channelId,
                            `⚠️ ${t('team.subagentLabel')}${instruction.agentIndex} の IPC 通信が中断しました（進捗: ${progressContent.percent}%）。部分完了として処理します。`);
                    }
                } catch { /* 進捗読み取り失敗 — 通常のエラーとして処理 */ }

                logError(`[TeamOrchestrator] Agent ${instruction.agentIndex} (${agentName}) failed: ${errMsg}`, e);

                // スレッドにエラー通知
                if (threadId && this.threadOps) {
                    await this.threadOps.sendToThread(threadId,
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
            pollingPromise = this.pollTaskListStatus(
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
        await this.sendToDiscord(channelId,
            `📊 **全サブエージェント完了**: ${successCount}/${results.length} 成功`);

        // 待機インジケーター: メインエージェントが結果を統合するまでの待ち時間をカバー
        await this.sendToDiscord(channelId,
            `⏳ メインエージェントが結果を統合中です...しばらくお待ちください`);

        return results;
    }

    /**
     * Phase 5: 全サブエージェントの結果を報告用 IPC ファイルとして書き出す。
     * Discord Bot がこれをメインエージェントにプロンプトとして送信する。
     */
    /**
     * メインエージェントへの報告指示をIPCファイルとして書き出す。
     * サブエージェントへのプロンプトと同じ「ファイル読み取り方式」に統一する。
     *
     * 書き出す JSON は tmp_exec_*.json と同じ構造化フォーマット。
     *
     * @returns 書き出した指示ファイルの絶対パス
     */
    writeReportInstructionFile(
        teamRequestId: string,
        reportPath: string,
        reportResponsePath: string,
    ): { instructionPath: string; progressPath: string } {
        const ipcDir = this.fileIpc.getIpcDir();
        const instructionPath = path.join(ipcDir, `tmp_exec_anti-crow_req_${teamRequestId}_report.json`);
        const progressPath = path.join(ipcDir, `req_${teamRequestId}_report_progress.json`);

        // 共通ヘルパーで instruction.json を構築
        const fileContent = buildInstructionContent({
            prompt: '全サブエージェントの報告を確認し、統合レポートを作成してください。\n\n' +
                '1. report_path (context.report_path) のファイルを view_file ツールで読み込んでください\n' +
                '2. 全サブエージェントの報告を確認してください\n' +
                '3. 統合レポートを作成し、output.response_path に Markdown で書き込んでください（write_to_file）\n' +
                '4. レポートにはすべてのタスクの結果・成否・注意点をまとめてください\n' +
                '5. ユーザー向けにわかりやすい報告書を作成してください',
            context: {
                role: 'main_agent_report',
                report_path: reportPath,
            },
            responsePath: reportResponsePath,
            progressPath,
        });

        fs.writeFileSync(instructionPath, JSON.stringify(fileContent, null, 2), 'utf-8');
        logInfo(`[TeamOrchestrator] Wrote report instruction file: ${instructionPath}`);
        return { instructionPath, progressPath };
    }

    writeReportFile(
        requestId: string,
        results: OrchestrationResult[],
        instructions: TeamInstruction[],
        mainResponsePath: string,
    ): string {
        const ipcDir = this.fileIpc.getIpcDir();
        const reportPath = path.join(ipcDir, `req_${requestId}_report_all.json`);

        const allReports = results.map((r, i) => ({
            agentIndex: i + 1,
            agentName: r.agentName,
            success: r.success,
            result: r.response,
        }));

        // tmp_exec_*.json 互換フォーマット: データのみを構造化して書き出す
        const reportData: Record<string, unknown> = {
            type: 'team_report',
            requestId,
            timestamp: Date.now(),
            summary: {
                totalAgents: instructions.length,
                successCount: results.filter(r => r.success).length,
                failureCount: results.filter(r => !r.success).length,
                allSucceeded: results.every(r => r.success),
            },
            task_summary: instructions.map((inst, i) => `${t('team.subagentLabel')}${i + 1}: ${inst.task.substring(0, 80)}`).join('\n'),
            reports: allReports,
            // response_path は writeReportInstructionFile の output.response_path でのみ指定する（一本化）
        };

        fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf-8');
        logInfo(`[TeamOrchestrator] Wrote report file: ${reportPath}`);
        return reportPath;
    }

    // -----------------------------------------------------------------------
    // worktree クリーンアップヘルパー
    // -----------------------------------------------------------------------

    /**
     * orphan worktree の検出と自動クリーンアップ。
     * チームモード開始時に前回の実行で残ったゴミを掃除する。
     */
    private async cleanupOrphanWorktrees(repoRoot: string): Promise<void> {
        const worktreesDir = path.join(repoRoot, '.anticrow', 'worktrees');
        const gitWorktreesDir = path.join(repoRoot, '.git', 'worktrees');

        let cleanedCount = 0;

        // 1. .anticrow/worktrees/ 内の残留ディレクトリを検出
        try {
            if (fs.existsSync(worktreesDir)) {
                const entries = fs.readdirSync(worktreesDir);
                for (const entry of entries) {
                    const entryPath = path.join(worktreesDir, entry);
                    try {
                        const stat = fs.statSync(entryPath);
                        if (stat.isDirectory()) {
                            // pool_ プレフィックスのエントリはプール用として保護
                            if (entry.startsWith('pool_')) {
                                logDebug(`[TeamOrchestrator] プール worktree 保護: ${entryPath}`);
                                continue;
                            }
                            logInfo(`[TeamOrchestrator] orphan worktree 検出: ${entryPath}`);
                            // git worktree remove を試行
                            try {
                                await gitExec(['worktree', 'remove', entryPath, '--force'], { cwd: repoRoot });
                            } catch {
                                // 失敗したら物理削除
                                fs.rmSync(entryPath, { recursive: true, force: true });
                            }
                            cleanedCount++;
                            logInfo(`[TeamOrchestrator] orphan worktree 削除完了: ${entryPath}`);
                        }
                    } catch (e) {
                        logWarn(`[TeamOrchestrator] orphan worktree 削除失敗: ${entryPath}: ${e}`);
                    }
                }
            }
        } catch (e) {
            logDebug(`[TeamOrchestrator] .anticrow/worktrees/ の読み取りスキップ: ${e}`);
        }

        // 2. .git/worktrees/ 内の不整合エントリを prune
        try {
            if (fs.existsSync(gitWorktreesDir)) {
                await gitExec(['worktree', 'prune'], { cwd: repoRoot });
                logDebug('[TeamOrchestrator] git worktree prune 実行完了');
            }
        } catch (e) {
            logDebug(`[TeamOrchestrator] git worktree prune スキップ: ${e}`);
        }

        if (cleanedCount > 0) {
            logInfo(`[TeamOrchestrator] orphan worktree ${cleanedCount} 個をクリーンアップしました`);
        }
    }

    /**
     * 最終検証: すべてのworktreeフォルダが削除されていることを確認。
     * 残っているものがあれば強制削除する。
     */
    private async verifyWorktreeCleanup(
        repoRoot: string,
        agentNames: Map<number, string>,
    ): Promise<void> {
        const worktreesDir = path.join(repoRoot, '.anticrow', 'worktrees');
        let remainingCount = 0;

        // 各エージェントのworktreeパスをチェック
        for (const [, agentName] of agentNames) {
            const handle = this.subagentManager.getAgent(agentName);
            if (handle && fs.existsSync(handle.worktreePath)) {
                logWarn(`[TeamOrchestrator] 最終検証: worktree が残留しています: ${handle.worktreePath}`);
                try {
                    fs.rmSync(handle.worktreePath, { recursive: true, force: true });
                    logInfo(`[TeamOrchestrator] 最終検証: 強制削除完了: ${handle.worktreePath}`);
                } catch (e) {
                    logWarn(`[TeamOrchestrator] 最終検証: 強制削除失敗: ${handle.worktreePath}: ${e}`);
                }
                remainingCount++;
            }
        }

        // worktrees ディレクトリ全体もチェック
        try {
            if (fs.existsSync(worktreesDir)) {
                const remaining = fs.readdirSync(worktreesDir);
                for (const entry of remaining) {
                    const entryPath = path.join(worktreesDir, entry);
                    const stat = fs.statSync(entryPath);
                    if (stat.isDirectory()) {
                        // pool_ プレフィックスのエントリはプール用として保護
                        if (entry.startsWith('pool_')) {
                            logDebug(`[TeamOrchestrator] 最終検証: プール worktree 保護: ${entryPath}`);
                            continue;
                        }
                        logWarn(`[TeamOrchestrator] 最終検証: 未知のworktreeが残留: ${entryPath}`);
                        // リトライ付き削除（プロセスがまだロックを保持している可能性）
                        for (let retry = 0; retry < 3; retry++) {
                            try {
                                if (!fs.existsSync(entryPath)) break;
                                fs.rmSync(entryPath, { recursive: true, force: true });
                                logInfo(`[TeamOrchestrator] 最終検証: 強制削除完了 (試行${retry + 1}): ${entryPath}`);
                                break;
                            } catch (e) {
                                if (retry < 2) {
                                    logDebug(`[TeamOrchestrator] 最終検証: 削除リトライ (${retry + 1}/3): ${e}`);
                                    await new Promise(r => setTimeout(r, 1000));
                                } else {
                                    logWarn(`[TeamOrchestrator] 最終検証: 強制削除失敗 (全リトライ失敗): ${entryPath}: ${e}`);
                                }
                            }
                        }
                        remainingCount++;
                    }
                }
            }
        } catch { /* ignore */ }

        // 3. .git/worktrees/ 内のサブエージェント関連エントリを直接削除
        const gitWorktreesDir = path.join(repoRoot, '.git', 'worktrees');
        try {
            if (fs.existsSync(gitWorktreesDir)) {
                const gitEntries = fs.readdirSync(gitWorktreesDir);
                for (const entry of gitEntries) {
                    // サブエージェント関連のエントリのみ対象（安全チェック）
                    if (!entry.includes('subagent')) continue;

                    // pool_ プレフィックスのエントリはプール用として保護
                    if (entry.startsWith('pool_')) {
                        logDebug(`[TeamOrchestrator] 最終検証: .git/worktrees/ プール worktree 保護: ${entry}`);
                        continue;
                    }

                    const gitEntryPath = path.join(gitWorktreesDir, entry);
                    try {
                        const stat = fs.statSync(gitEntryPath);
                        if (!stat.isDirectory()) continue;
                    } catch { continue; }

                    logInfo(`[TeamOrchestrator] 最終検証: .git/worktrees/ に残留するサブエージェント参照を削除: ${entry}`);
                    try {
                        // まず git worktree remove を試す
                        await gitExec(['worktree', 'remove', entry, '--force'], { cwd: repoRoot });
                        logInfo(`[TeamOrchestrator] git worktree remove 成功: ${entry}`);
                    } catch {
                        // 失敗したら直接削除
                        try {
                            fs.rmSync(gitEntryPath, { recursive: true, force: true });
                            logInfo(`[TeamOrchestrator] .git/worktrees/${entry} を直接削除完了`);
                        } catch (e2) {
                            logWarn(`[TeamOrchestrator] .git/worktrees/${entry} の削除失敗: ${e2}`);
                        }
                    }
                    remainingCount++;
                }
            }
        } catch (e) {
            logDebug(`[TeamOrchestrator] .git/worktrees/ の読み取りスキップ: ${e}`);
        }

        // git worktree prune で最終クリーンアップ
        try {
            await gitExec(['worktree', 'prune'], { cwd: repoRoot });
        } catch { /* ignore */ }

        if (remainingCount > 0) {
            logInfo(`[TeamOrchestrator] 最終検証: ${remainingCount} 個の残留worktreeを強制削除しました`);
        } else {
            logDebug('[TeamOrchestrator] 最終検証: worktreeの残留なし ✅');
        }
    }

    // -----------------------------------------------------------------------
    // 共有タスクリスト管理
    // -----------------------------------------------------------------------

    /**
     * 共有タスクリスト JSON を生成する。
     * チーム全体のタスク一覧をファイルに書き出し、サブエージェントが読み書きできるようにする。
     * ヘルプモード用にフルタスク内容と利用ガイドも含める。
     */
    private generateSharedTaskList(
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
        logInfo(`[TeamOrchestrator] 共有タスクリスト生成: ${taskListPath} (${instructions.length} タスク)`);
        return taskListPath;
    }

    /**
     * 共有タスクリストの特定タスクのステータスを更新する。
     * orchestrator 側からのステータス更新用（helped など）。
     */
    private updateSharedTaskStatus(
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
                logDebug(`[TeamOrchestrator] タスクリスト更新: agent${agentIndex} -> ${status}`);
            }
        } catch (e) {
            logWarn(`[TeamOrchestrator] タスクリスト更新失敗: ${e}`);
        }
    }

    /**
     * 共有タスクリストファイルをポーリングし、ステータス変化を Discord にリアルタイム通知する。
     * 5秒間隔でファイルを読み込み、前回状態との差分を検出。
     */
    private async pollTaskListStatus(
        taskListPath: string,
        channelId: string,
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

        logInfo(`[TeamOrchestrator] タスクリストポーリング開始: ${taskListPath}`);

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
                        await this.sendToDiscord(channelId, msg);
                    }

                    // 全体進捗サマリーを表示
                    const summary = this.buildProgressSummary(tasks);
                    await this.sendToDiscord(channelId, summary);
                }

                // 全タスクが終了ステータスなら停止
                const allDone = tasks.every(t => TERMINAL_STATUSES.has(t.status));
                if (allDone && tasks.length > 0) {
                    await this.sendToDiscord(channelId, '📋 **全タスク完了済み** ✅');
                    logInfo('[TeamOrchestrator] タスクリストポーリング: 全タスク完了、停止');
                    break;
                }

            } catch (e) {
                // ファイル読み取りエラーは無視（ファイルが一時的にロックされている可能性）
                logDebug(`[TeamOrchestrator] タスクリストポーリング: 読み取りエラー: ${e}`);
            }
        }

        logInfo('[TeamOrchestrator] タスクリストポーリング終了');
    }

    /**
     * タスクリストの全体進捗サマリーを生成する。
     */
    private buildProgressSummary(
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

}


