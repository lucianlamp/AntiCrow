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
}

/** Discord に送信するためのコールバック */
export type DiscordSender = (channelId: string, content: string) => Promise<void>;

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
    ): Promise<OrchestrationResult> {
        const config = loadTeamConfig(this.repoRoot);
        const startTime = Date.now();

        // サブエージェントをスポーン（名前は SubagentManager が自動生成）
        const name = agentName ?? `agent-${Date.now()}`;
        logInfo(`[TeamOrchestrator] Spawning agent: ${name}`);

        try {
            // spawn() は taskPrompt を受け取るが、ここでは後で sendPrompt するため省略
            const handle = await this.subagentManager.spawn();

            // 進捗監視を開始
            this.startMonitor(handle.name, channelId, config);

            // Discord に spawn 通知
            await this.sendToDiscord(channelId,
                `🤖 **サブエージェント "${handle.name}" を起動しました。** タスクを実行中...`);

            // プロンプトを送信してレスポンスを待機
            const resp = await handle.sendPrompt(prompt);
            const durationMs = Date.now() - startTime;

            // 監視停止
            this.stopMonitor(name);

            const success = resp.status === 'success';
            logInfo(`[TeamOrchestrator] Agent "${name}" completed in ${durationMs}ms (${resp.status})`);

            return {
                agentName: name,
                success,
                response: success ? resp.result : (resp.error ?? resp.result),
                durationMs,
            };
        } catch (e) {
            const durationMs = Date.now() - startTime;
            const errMsg = e instanceof Error ? e.message : String(e);
            logError(`[TeamOrchestrator] Agent "${name}" failed after ${durationMs}ms`, e);

            // 監視停止
            this.stopMonitor(name);

            // Discord にエラー通知
            await this.sendToDiscord(channelId,
                `❌ **サブエージェント "${name}" でエラー発生**\n${errMsg}`).catch(() => { });

            return {
                agentName: name,
                success: false,
                response: errMsg,
                durationMs,
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
    private startMonitor(agentName: string, channelId: string, config: TeamConfig): void {
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
                const progress = await this.readAgentProgress(ipcDir, agentName);
                if (!progress) { return; }

                // 前回と同じなら無視
                if (lastProgress &&
                    lastProgress.status === progress.status &&
                    lastProgress.percent === progress.percent) {
                    return;
                }

                lastProgress = progress;

                // Discord に中間報告
                const progressBar = this.buildProgressBar(progress.percent);
                await this.sendToDiscord(channelId,
                    `📊 **${agentName}** ${progressBar} ${progress.percent}%\n`
                    + `**ステータス**: ${progress.status}`
                    + (progress.detail ? `\n**詳細**: ${progress.detail}` : ''));

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
    private async readAgentProgress(ipcDir: string, agentName: string): Promise<AgentProgress | null> {
        try {
            const files = await fs.promises.readdir(ipcDir);
            // 最新の progress ファイルを探す
            const progressFiles = files
                .filter(f => f.endsWith('_progress.json'))
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
                            detail: data.detail,
                            percent: typeof data.percent === 'number' ? data.percent : 0,
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
    ): Promise<ParallelOrchestrationResult> {
        const config = loadTeamConfig(this.repoRoot);
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
                return this.orchestrate(task, channelId)
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
}
