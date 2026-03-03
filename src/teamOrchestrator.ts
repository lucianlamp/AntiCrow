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
import { logDebug, logError, logInfo, logWarn } from './logger';
import type { SubagentManager } from './subagentManager';
import type { FileIpc } from './fileIpc';
import { loadTeamConfig, type TeamConfig } from './teamConfig';
import type { TeamInstruction, TeamReport } from './subagentTypes';

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
    private disposed = false;
    private threadOps: ThreadOps | null = null;

    /** 実行時にワークスペースを動的に切り替えるための repoRoot 解決 */
    private getEffectiveRepoRoot(override?: string): string {
        return override || this.repoRoot;
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
                    `🧵 **サブエージェント "${name}" の作業スレッド**\n` +
                    `開始時刻: ${new Date().toLocaleTimeString('ja-JP')}\n\n` +
                    `📋 **作業内容:**\n${taskPreview}`);
            }
        }

        // 進捗の送信先: スレッドがあればスレッド、なければメインチャンネル
        const progressChannelId = threadId || channelId;

        try {
            // spawn() は taskPrompt を受け取るが、ここでは後で sendPrompt するため省略
            const handle = await this.subagentManager.spawn(undefined, workspaceName);

            // 進捗監視を開始（スレッドがあればスレッドに送信）
            this.startMonitor(handle.name, progressChannelId, config, threadId);

            // Discord に spawn 通知（メインチャンネルにもスレッドリンク付きで通知）
            if (threadId) {
                await this.sendToDiscord(channelId,
                    `🤖 **サブエージェント "${handle.name}" を起動しました。** 進捗は 🧵 スレッドで確認できます。`);
            } else {
                await this.sendToDiscord(channelId,
                    `🤖 **サブエージェント "${handle.name}" を起動しました。** タスクを実行中...`);
            }

            // プロンプトを送信してレスポンスを待機
            const resp = await handle.sendPrompt(prompt);
            const durationMs = Date.now() - startTime;

            // 監視停止
            this.stopMonitor(name);

            const success = resp.status === 'success';
            logInfo(`[TeamOrchestrator] Agent "${name}" completed in ${durationMs}ms (${resp.status})`);

            // スレッドに完了通知 + アーカイブ
            if (threadId && this.threadOps) {
                const statusEmoji = success ? '✅' : '❌';
                await this.threadOps.sendToThread(threadId,
                    `${statusEmoji} **完了** (${Math.round(durationMs / 1000)}秒)\n` +
                    `ステータス: ${resp.status}`);
                await this.threadOps.archiveThread(threadId);
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

            // スレッドにエラー通知 + アーカイブ
            if (threadId && this.threadOps) {
                await this.threadOps.sendToThread(threadId,
                    `❌ **エラー発生** (${Math.round(durationMs / 1000)}秒)\n${errMsg}`).catch(() => { });
                await this.threadOps.archiveThread(threadId).catch(() => { });
            }

            // メインチャンネルにもエラー通知
            await this.sendToDiscord(channelId,
                `❌ **サブエージェント "${name}" でエラー発生**\n${errMsg}`).catch(() => { });

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

                // Discord に中間報告（プレーンテキスト形式）
                const progressBar = this.buildProgressBar(progress.percent);
                const progressMsg = `📊 **${agentName}** ${progressBar} ${progress.percent}%\n`
                    + `**ステータス**: ${progress.status}`
                    + (progress.detail ? `\n**作業内容**: ${progress.detail}` : '');

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
    }

    private stopMonitor(agentName: string): void {
        const timer = this.monitorTimers.get(agentName);
        if (timer) {
            clearInterval(timer);
            this.monitorTimers.delete(agentName);
            logDebug(`[TeamOrchestrator] Stopped monitoring "${agentName}"`);
        }
    }

    /**
     * IPC ディレクトリからサブエージェントの進捗ファイルを読み取る。
     * ファイル名パターン: req_*_progress.json
     */
    private async readAgentProgress(ipcDir: string, agentName: string, agentIndex?: number): Promise<AgentProgress | null> {
        try {
            const files = await fs.promises.readdir(ipcDir);

            // チームモード（agentIndex指定あり）の場合、対象エージェントの progress ファイルのみを読み取る
            const agentPattern = agentIndex !== undefined
                ? `_agent${agentIndex}_progress.json`
                : '_progress.json';

            const progressFiles = files
                .filter(f => f.endsWith(agentPattern))
                .sort()
                .reverse();

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

    private buildProgressBar(percent: number): string {
        const filled = Math.round(percent / 10);
        const empty = 10 - filled;
        return '▓'.repeat(filled) + '░'.repeat(empty);
    }

    /**
     * 全監視タイマーを停止し、リソースを解放する。
     */
    dispose(): void {
        this.disposed = true;
        for (const [name] of this.monitorTimers) {
            this.stopMonitor(name);
        }
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
                        agentName: `タスク${taskIdx}: ${result.agentName}`,
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
     * @returns 書き出した指令ファイルのパス一覧
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

            // 他のサブエージェントのタスク概要を生成（重複防止用）
            const otherTasksSummary = tasks
                .map((t, j) => j !== i ? `- サブエージェント${j + 1}: ${t.substring(0, 100)}${t.length > 100 ? '...' : ''}` : null)
                .filter(Boolean)
                .join('\n');

            const instruction: TeamInstruction = {
                persona: `あなたはサブエージェント${agentIndex}（全${tasks.length}名中）です。チームの一員として、割り当てられたタスクを実行してください。` +
                    `\n\n【重要】他のサブエージェントと作業が重複しないよう注意してください。` +
                    `あなたの担当範囲のみを実行し、他のサブエージェントの担当範囲には手を出さないでください。` +
                    `同じファイルの同じ箇所を修正しないでください。` +
                    (otherTasksSummary ? `\n\n【他のサブエージェントの担当】\n${otherTasksSummary}` : '') +
                    `\n\n進捗は progress_path に定期的に書き込み、完了したら response_path に結果を書き込んでください。`,
                agentIndex,
                task: tasks[i],
                response_path: path.join(ipcDir, `team_${requestId}_agent${agentIndex}_response.md`),
                progress_path: path.join(ipcDir, `team_${requestId}_agent${agentIndex}_progress.json`),
                context: originalContext,
                timestamp: Date.now(),
                requestId,
                totalAgents: tasks.length,
            };

            // 指令ファイルを書き込む
            const instructionPath = path.join(ipcDir, `team_${requestId}_agent${agentIndex}_instruction.json`);
            fs.writeFileSync(instructionPath, JSON.stringify(instruction, null, 2), 'utf-8');
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

        logInfo(`[TeamOrchestrator] orchestrateTeam: ${instructions.length} agents, workspace=${workspaceName || 'default'}`);

        // 前回のサブエージェントのウィンドウを全て閉じる（ウィンドウが開いたまま残っている場合の対策）
        await this.subagentManager.killAll();

        // killAll() で閉じきれなかった stale エージェントをクリーンアップ
        const staleCount = await this.subagentManager.cleanupStaleAgents();
        if (staleCount > 0) {
            logInfo(`[TeamOrchestrator] Cleaned up ${staleCount} stale agents before team orchestration`);
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
                // サブエージェントを spawn
                const handle = await this.subagentManager.spawn(undefined, workspaceName);
                agentNames.set(instruction.agentIndex, handle.name);
                logInfo(`[TeamOrchestrator] Spawned agent ${handle.name} for task ${instruction.agentIndex}`);

                // Discord スレッド作成（状況見える化用）
                let threadId: string | null = null;
                if (this.threadOps) {
                    const taskPreview = instruction.task.substring(0, 500) + (instruction.task.length > 500 ? '...' : '');
                    // スレッド名はサブエージェント名のみ
                    threadId = await this.threadOps.createThread(
                        channelId,
                        `サブエージェント${instruction.agentIndex}`,
                    );
                    if (threadId) {
                        agentThreads.set(instruction.agentIndex, threadId);
                        // 開始通知に作業内容を含める
                        await this.threadOps.sendToThread(threadId,
                            `🧵 **サブエージェント${instruction.agentIndex} の作業スレッド**\n` +
                            `担当エージェント: ${handle.name}\n` +
                            `開始時刻: ${new Date().toLocaleTimeString('ja-JP')}\n\n` +
                            `📋 **作業内容:**\n${taskPreview}`
                        );
                    }
                }

                // 進捗モニター開始（スレッドに送信、agentIndexでフィルタ）
                this.startMonitor(handle.name, threadId || channelId, config, threadId, instruction.agentIndex);

                // サブエージェントにプロンプト送信:
                // 「以下のファイルを view_file ツールで読み取って指示を実行してください」方式
                const instructionPath = path.join(ipcDir, `team_${instruction.requestId}_agent${instruction.agentIndex}_instruction.json`);
                const subagentPrompt =
                    `あなたはサブエージェント${instruction.agentIndex}です。\n\n` +
                    `以下のファイルを view_file ツールで読み込み、その指示に従ってください。\n` +
                    `ファイルパス: ${instructionPath}\n\n` +
                    `重要:\n` +
                    `- このタスクは既に計画済みです。計画の生成や承認は不要で、直ちに実行に移ってください\n` +
                    `- plan_generation タスクを生成しないでください。実行（execution）のみを行ってください\n` +
                    `- 指令ファイルの task フィールドに記載されたタスクを実行してください\n` +
                    `- 進捗は progress_path に定期的に JSON で書き込んでください（write_to_file, Overwrite: true）\n` +
                    `- 完了したら response_path に結果を Markdown で書き込んでください（write_to_file）\n` +
                    `- response_path に書き込んだ時点で完了と見なされます`;

                await handle.sendPrompt(subagentPrompt);

                // メインチャンネルに通知
                if (threadId) {
                    await this.sendToDiscord(channelId,
                        `🤖 **サブエージェント${instruction.agentIndex}** (${handle.name}) を起動しました。進捗は 🧵 スレッドで確認できます。`);
                } else {
                    await this.sendToDiscord(channelId,
                        `🤖 **サブエージェント${instruction.agentIndex}** (${handle.name}) にタスクを送信しました。`);
                }

            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                logError(`[TeamOrchestrator] Failed to spawn/send agent ${instruction.agentIndex}: ${errMsg}`, e);
                await this.sendToDiscord(channelId,
                    `❌ サブエージェント${instruction.agentIndex} の起動に失敗しました: ${errMsg}`);
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
            signal,
        );

        const totalDurationMs = Date.now() - startTime;
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;

        logInfo(`[TeamOrchestrator] orchestrateTeam completed: ${successCount}/${results.length} succeeded, ${totalDurationMs}ms`);

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
        signal?: AbortSignal,
    ): Promise<OrchestrationResult[]> {
        const results: OrchestrationResult[] = [];

        // 各サブエージェントのレスポンスを並行して待機
        const promises = instructions.map(async (instruction) => {
            const agentName = agentNames.get(instruction.agentIndex) || `agent-${instruction.agentIndex}`;
            const threadId = agentThreads.get(instruction.agentIndex);
            const startTime = Date.now();

            try {
                // レスポンスファイルの出現を待機（FileIpc のポーリング方式）
                const response = await this.fileIpc.waitForResponse(
                    instruction.response_path,
                    config.responseTimeoutMs,
                    signal,
                );

                const durationMs = Date.now() - startTime;
                this.stopMonitor(agentName);

                logInfo(`[TeamOrchestrator] Agent ${instruction.agentIndex} (${agentName}) completed in ${durationMs}ms`);

                // スレッドに完了通知
                if (threadId && this.threadOps) {
                    await this.threadOps.sendToThread(threadId,
                        `✅ **タスク完了** (${Math.round(durationMs / 1000)}秒)\n` +
                        `結果: ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`
                    );
                    await this.threadOps.archiveThread(threadId);
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

                logError(`[TeamOrchestrator] Agent ${instruction.agentIndex} (${agentName}) failed: ${errMsg}`, e);

                // スレッドにエラー通知
                if (threadId && this.threadOps) {
                    await this.threadOps.sendToThread(threadId,
                        `❌ **エラー発生** (${Math.round(durationMs / 1000)}秒)\n${errMsg}`
                    ).catch(() => { });
                    await this.threadOps.archiveThread(threadId).catch(() => { });
                }

                return {
                    agentName,
                    success: false,
                    response: errMsg,
                    durationMs,
                    threadId: threadId ?? undefined,
                } as OrchestrationResult;
            }
        });

        const settled = await Promise.allSettled(promises);
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

        return results;
    }

    /**
     * Phase 5: 全サブエージェントの結果を報告用 IPC ファイルとして書き出す。
     * Discord Bot がこれをメインエージェントにプロンプトとして送信する。
     */
    writeReportFile(
        requestId: string,
        results: OrchestrationResult[],
        instructions: TeamInstruction[],
        mainResponsePath: string,
    ): string {
        const ipcDir = this.fileIpc.getIpcDir();
        const reportPath = path.join(ipcDir, `team_${requestId}_report_all.json`);

        const allReports = results.map((r, i) => ({
            agentIndex: i + 1,
            agentName: r.agentName,
            success: r.success,
            result: r.response,
        }));

        const report: TeamReport = {
            persona: 'あなたはメインエージェントです。サブエージェントたちからの報告を受け取り、統合レポートを作成してください。',
            report_from: '全サブエージェント',
            agentIndex: 0,
            task_summary: instructions.map((inst, i) => `タスク${i + 1}: ${inst.task.substring(0, 80)}`).join('\n'),
            result: '',
            success: results.every(r => r.success),
            remaining_agents: 0,
            response_path: mainResponsePath,
            timestamp: Date.now(),
            requestId,
            all_reports_collected: true,
            all_reports: allReports,
        };

        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
        logInfo(`[TeamOrchestrator] Wrote report file: ${reportPath}`);
        return reportPath;
    }
}
