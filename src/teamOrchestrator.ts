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

        // サブエージェントをスポーン
        const name = agentName ?? `agent-${Date.now()}`;
        logInfo(`[TeamOrchestrator] Spawning agent: ${name}`);

        try {
            const handle = await this.subagentManager.spawn(name);

            // 進捗監視を開始
            this.startMonitor(name, channelId, config);

            // Discord に spawn 通知
            await this.sendToDiscord(channelId,
                `🤖 **サブエージェント "${name}" を起動しました。** タスクを実行中...`);

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
}
