// ---------------------------------------------------------------------------
// subagentManager.ts — サブエージェントの並列管理
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §6, §7
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { logDebug, logWarn, logError } from './logger';
import {
    SubagentConfig,
    SubagentInfo,
    SubagentResponse,
    DEFAULT_SUBAGENT_CONFIG,
} from './subagentTypes';
import { SubagentHandle } from './subagentHandle';
import { CdpBridge } from './cdpBridge';

/**
 * 複数のサブエージェントを管理するマネージャー。
 * spawn / kill / healthCheck を一元管理する。
 */
export class SubagentManager {
    private agents: Map<string, SubagentHandle> = new Map();
    private config: SubagentConfig;
    private cdpBridge: CdpBridge;
    private ipcDir: string;
    private repoRoot: string;
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
    private nextId = 1;

    constructor(
        cdpBridge: CdpBridge,
        ipcDir: string,
        repoRoot: string,
        config: Partial<SubagentConfig> = {},
    ) {
        this.cdpBridge = cdpBridge;
        this.ipcDir = ipcDir;
        this.repoRoot = repoRoot;
        this.config = { ...DEFAULT_SUBAGENT_CONFIG, ...config };
    }

    // -----------------------------------------------------------------------
    // 公開 API
    // -----------------------------------------------------------------------

    /**
     * 新しいサブエージェントを起動する。
     *
     * @param taskPrompt 初回タスクのプロンプト（省略可、後で sendPrompt で送信）
     * @returns サブエージェントハンドル
     */
    async spawn(taskPrompt?: string): Promise<SubagentHandle> {
        // 同時実行数チェック
        const activeCount = this.getActiveCount();
        if (activeCount >= this.config.maxConcurrent) {
            throw new Error(
                `最大同時実行数 (${this.config.maxConcurrent}) に達しています。` +
                `現在 ${activeCount} 個のサブエージェントが稼働中。`
            );
        }

        // ワークスペース名を決定
        const mainWsName = this.cdpBridge.getActiveWorkspaceName() ?? 'anti-crow';
        const name = `${mainWsName}-subagent-${this.nextId++}`;

        logDebug(`[SubagentManager] サブエージェント "${name}" を起動中...`);

        const handle = new SubagentHandle(
            name,
            this.repoRoot,
            this.ipcDir,
            this.cdpBridge,
            this.config,
        );

        this.agents.set(name, handle);

        try {
            await handle.spawn();
            logDebug(`[SubagentManager] サブエージェント "${name}" 起動完了`);

            // タスクが指定されていればプロンプト送信
            if (taskPrompt) {
                return handle; // プロンプトは呼び出し側で送信
            }
            return handle;
        } catch (err) {
            this.agents.delete(name);
            throw err;
        }
    }

    /**
     * 名前でサブエージェントを取得する。
     */
    getAgent(name: string): SubagentHandle | undefined {
        return this.agents.get(name);
    }

    /**
     * 全サブエージェントの一覧を返す。
     */
    list(): SubagentInfo[] {
        return Array.from(this.agents.values()).map((h) => h.info);
    }

    /**
     * 個別のサブエージェントをシャットダウンする。
     */
    async killAgent(name: string): Promise<void> {
        const handle = this.agents.get(name);
        if (!handle) {
            logWarn(`[SubagentManager] エージェント "${name}" が見つかりません`);
            return;
        }

        logDebug(`[SubagentManager] エージェント "${name}" をシャットダウン中...`);
        await handle.close();
        this.agents.delete(name);
        logDebug(`[SubagentManager] エージェント "${name}" シャットダウン完了`);
    }

    /**
     * 全サブエージェントをシャットダウンする。
     */
    async killAll(): Promise<void> {
        logDebug(`[SubagentManager] 全 ${this.agents.size} エージェントをシャットダウン中...`);

        const closePromises: Promise<void>[] = [];
        for (const [name, handle] of this.agents) {
            closePromises.push(
                handle.close().catch((err) => {
                    logError(`[SubagentManager] "${name}" のシャットダウン失敗: ${err}`);
                }),
            );
        }
        await Promise.all(closePromises);
        this.agents.clear();
        logDebug('[SubagentManager] 全エージェントシャットダウン完了');
    }

    // -----------------------------------------------------------------------
    // ヘルスチェック
    // -----------------------------------------------------------------------

    /**
     * 定期ヘルスチェックを開始する。
     * クラッシュしたサブエージェントを検出してクリーンアップする。
     */
    startHealthCheck(): void {
        if (this.healthCheckTimer) return;

        this.healthCheckTimer = setInterval(async () => {
            await this.runHealthCheck();
        }, this.config.healthCheckIntervalMs);

        logDebug(`[SubagentManager] ヘルスチェック開始 (${this.config.healthCheckIntervalMs}ms 間隔)`);
    }

    /**
     * 定期ヘルスチェックを停止する。
     */
    stopHealthCheck(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
            logDebug('[SubagentManager] ヘルスチェック停止');
        }
    }

    /**
     * 1回分のヘルスチェックを実行する。
     */
    private async runHealthCheck(): Promise<void> {
        for (const [name, handle] of this.agents) {
            if (handle.state !== 'BUSY' && handle.state !== 'READY') continue;

            const alive = await handle.isAlive();
            if (!alive) {
                logWarn(`[SubagentManager] エージェント "${name}" がクラッシュを検出。クリーンアップ中...`);
                try {
                    await handle.close();
                } catch {
                    // close 失敗は無視
                }
                this.agents.delete(name);
            }
        }
    }

    // -----------------------------------------------------------------------
    // リソース管理
    // -----------------------------------------------------------------------

    /**
     * アクティブなサブエージェント数を返す。
     */
    private getActiveCount(): number {
        let count = 0;
        for (const handle of this.agents.values()) {
            const s = handle.state;
            if (s !== 'CLEANED' && s !== 'FAILED' && s !== 'IDLE') {
                count++;
            }
        }
        return count;
    }

    /**
     * マネージャーの破棄。deactivate() 時に呼び出す。
     */
    async dispose(): Promise<void> {
        this.stopHealthCheck();
        await this.killAll();
        logDebug('[SubagentManager] dispose 完了');
    }
}
