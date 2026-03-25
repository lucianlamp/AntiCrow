// ---------------------------------------------------------------------------
// subagentManager.ts — サブエージェントの並列管理
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §6, §7
// ---------------------------------------------------------------------------

import * as path from 'path';
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
    private idlePool: Map<string, { handle: SubagentHandle; idleSince: number }> = new Map();
    private config: SubagentConfig;
    private cdpBridge: CdpBridge;
    private ipcDir: string;
    private repoRoot: string;
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
    private idleCleanupTimer: ReturnType<typeof setInterval> | null = null;
    private healthCheckPaused = false;
    /** 連続ヘルスチェック失敗カウンター（エージェント名 → 連続失敗回数） */
    private consecutiveFailures = new Map<string, number>();
    /** 連続失敗で close する閾値 */
    private static readonly HEALTH_CHECK_FAIL_THRESHOLD = 3;
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
     * @param workspaceName ワークスペース名（ウィンドウ名に使用）
     * @param repoRootOverride 対象ワークスペースのリポジトリルート（省略時はデフォルトの repoRoot）
     * @param _useDirectEdit 未使用（常に直接編集モード）
     * @param agentIndex チームモード用のエージェントインデックス（指定時はこの番号でサブエージェント名を生成）
     * @returns サブエージェントハンドル
     */
    async spawn(taskPrompt?: string, workspaceName?: string, repoRootOverride?: string, _useDirectEdit: boolean = false, agentIndex?: number): Promise<SubagentHandle> {
        // spawn 前に stale エージェントをクリーンアップ
        await this.cleanupStaleAgents();

        // 同時実行数チェック
        const activeCount = this.getActiveCount();
        if (activeCount >= this.config.maxConcurrent) {
            throw new Error(
                `最大同時実行数 (${this.config.maxConcurrent}) に達しています。` +
                `現在 ${activeCount} 個のサブエージェントが稼働中。`
            );
        }

        // ワークスペース名を決定（オーバーライド優先）→ サニタイズして安全な名前にする
        const rawWsName = workspaceName ?? this.cdpBridge.getActiveWorkspaceName() ?? 'anti-crow';
        const mainWsName = rawWsName.toLowerCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
        // agentIndex 指定時はその番号で命名（チームモード並行起動でのシャッフル防止）
        // 未指定時は従来通りグローバルカウンターで命名（後方互換）
        const name = agentIndex !== undefined
            ? `${mainWsName}-subagent-${agentIndex}`
            : `${mainWsName}-subagent-${this.nextId++}`;

        // repoRoot を決定（オーバーライド優先）
        const effectiveRepoRoot = repoRootOverride || this.repoRoot;

        logDebug(`[SubagentManager] サブエージェント "${name}" を起動中... (repoRoot=${effectiveRepoRoot})`);

        const handle = new SubagentHandle(
            name,
            effectiveRepoRoot,
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
     * 複数のサブエージェントをstagger（時間差）起動する。
     * 各起動の間に config.staggerDelayMs の間隔を空け、
     * OS のリソース競合やポート競合を回避する。
     *
     * @param tasks 各サブエージェントのタスク情報
     * @returns 起動されたサブエージェントハンドルの配列
     */
    async spawnMultiple(tasks: Array<{ prompt?: string; workspaceName?: string; repoRootOverride?: string }>): Promise<SubagentHandle[]> {
        const handles: SubagentHandle[] = [];
        const staggerDelay = this.config.staggerDelayMs;

        logDebug(`[SubagentManager] spawnMultiple: ${tasks.length} 個のサブエージェントをstagger起動 (間隔: ${staggerDelay}ms)`);

        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            const handle = await this.spawn(task.prompt, task.workspaceName, task.repoRootOverride);
            handles.push(handle);

            // 最後のタスク以外はstagger delayを入れる
            if (i < tasks.length - 1) {
                logDebug(`[SubagentManager] spawnMultiple: stagger delay ${staggerDelay}ms before next spawn`);
                await new Promise(r => setTimeout(r, staggerDelay));
            }
        }

        logDebug(`[SubagentManager] spawnMultiple: 全 ${handles.length} 個のサブエージェント起動完了`);
        return handles;
    }

    /**
     * 名前でサブエージェントを取得する。
     */
    getAgent(name: string): SubagentHandle | undefined {
        return this.agents.get(name);
    }

    /**
     * 全サブエージェントの一覧を返す。
     * @param workspaceName 指定時は該当WSのサブエージェントのみ返す（名前プレフィックスでフィルタ）
     */
    list(workspaceName?: string): SubagentInfo[] {
        const all = Array.from(this.agents.values()).map((h) => h.info);
        if (workspaceName) {
            const sanitized = workspaceName.toLowerCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
            return all.filter((info) => info.name.startsWith(`${sanitized}-`));
        }
        return all;
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
    // アイドルプール管理
    // -----------------------------------------------------------------------

    /**
     * タスク完了後のサブエージェントをアイドルプールに移動する。
     * ウィンドウは閉じず、TTL 経過後に自動クリーンアップされる。
     */
    async moveToIdlePool(handle: SubagentHandle): Promise<void> {
        logDebug(`[SubagentManager] "${handle.name}" をアイドルプールに移動`);
        this.agents.delete(handle.name);
        this.idlePool.set(handle.name, {
            handle,
            idleSince: Date.now(),
        });
    }

    /**
     * アイドルプールから生存しているサブエージェントを回収する。
     * resetForReuse() で状態を READY にリセットし、再利用可能にする。
     * @returns 回収に成功したサブエージェントハンドルの配列
     */
    async reclaimFromIdlePool(): Promise<SubagentHandle[]> {
        const reclaimed: SubagentHandle[] = [];
        const deadNames: string[] = [];

        for (const [name, idle] of this.idlePool) {
            try {
                const alive = await idle.handle.isAlive();
                if (alive) {
                    await idle.handle.resetForReuse();
                    this.agents.set(name, idle.handle);
                    reclaimed.push(idle.handle);
                    logDebug(`[SubagentManager] アイドルプールから回収: "${name}"`);
                } else {
                    deadNames.push(name);
                    logDebug(`[SubagentManager] アイドルプールの "${name}" は死んでいるためスキップ`);
                }
            } catch (err) {
                deadNames.push(name);
                logWarn(`[SubagentManager] アイドルプール回収エラー ("${name}"): ${err}`);
            }
        }

        // 回収済み・死亡をプールから除去
        for (const h of reclaimed) {
            this.idlePool.delete(h.name);
        }
        for (const name of deadNames) {
            const idle = this.idlePool.get(name);
            if (idle) {
                try { await idle.handle.close(); } catch { /* ignore */ }
                this.idlePool.delete(name);
            }
        }

        logDebug(`[SubagentManager] アイドルプール回収完了: ${reclaimed.length} 個回収, ${deadNames.length} 個クリーンアップ`);
        return reclaimed;
    }

    /**
     * アイドルプール内の全ウィンドウをクリーンアップする。
     */
    async clearIdlePool(): Promise<void> {
        for (const [name, idle] of this.idlePool) {
            try {
                await idle.handle.close();
            } catch (err) {
                logWarn(`[SubagentManager] アイドルプール "${name}" のクリーンアップ失敗: ${err}`);
            }
        }
        this.idlePool.clear();
        logDebug('[SubagentManager] アイドルプール全クリア完了');
    }

    /**
     * アイドルプールの TTL チェックを開始する。
     * TTL を超過したウィンドウを自動的にクリーンアップする。
     */
    startIdleCleanup(): void {
        if (this.idleCleanupTimer) return;

        const checkIntervalMs = 30_000; // 30秒間隔
        this.idleCleanupTimer = setInterval(async () => {
            const now = Date.now();
            const ttl = this.config.idleTtlMs;
            const expired: string[] = [];

            for (const [name, idle] of this.idlePool) {
                if (now - idle.idleSince >= ttl) {
                    expired.push(name);
                }
            }

            for (const name of expired) {
                const idle = this.idlePool.get(name);
                if (idle) {
                    try {
                        await idle.handle.close();

                    } catch (err) {
                        logWarn(`[SubagentManager] アイドルTTL超過クリーンアップ失敗 ("${name}"): ${err}`);
                    }
                    this.idlePool.delete(name);
                }
            }

            if (expired.length > 0) {
                logDebug(`[SubagentManager] アイドルTTL超過: ${expired.length} 個クリーンアップ (TTL=${ttl}ms)`);
            }
        }, checkIntervalMs);

        logDebug(`[SubagentManager] アイドルクリーンアップ開始 (TTL=${this.config.idleTtlMs}ms, チェック間隔=${checkIntervalMs}ms)`);
    }

    /**
     * アイドルプールの TTL チェックを停止する。
     */
    stopIdleCleanup(): void {
        if (this.idleCleanupTimer) {
            clearInterval(this.idleCleanupTimer);
            this.idleCleanupTimer = null;
            logDebug('[SubagentManager] アイドルクリーンアップ停止');
        }
    }

    /**
     * ウィンドウ再利用が有効かどうかを返す。
     */
    get enableWindowReuse(): boolean {
        return this.config.enableWindowReuse;
    }

    /**
     * ウィンドウ再利用の有効/無効を動的に切り替える。
     * 連続オートモード開始時に true、終了時に false を設定する。
     */
    setWindowReuse(enabled: boolean): void {
        this.config.enableWindowReuse = enabled;
        logDebug(`[SubagentManager] enableWindowReuse = ${enabled}`);
        if (!enabled) {
            // 無効化時はアイドルプールをクリア
            this.stopIdleCleanup();
            this.clearIdlePool().catch(err => {
                logWarn(`[SubagentManager] アイドルプールクリア失敗: ${err}`);
            });
        }
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
     * ヘルスチェックを一時停止する。
     * チームモード実行中など、BUSY エージェントを誤って殺さないために使用。
     * タイマー自体は動き続けるが、runHealthCheck 内でスキップされる。
     */
    pauseHealthCheck(): void {
        this.healthCheckPaused = true;
        this.consecutiveFailures.clear();
        logDebug('[SubagentManager] ヘルスチェック一時停止');
    }

    /**
     * ヘルスチェックの一時停止を解除する。
     */
    resumeHealthCheck(): void {
        this.healthCheckPaused = false;
        this.consecutiveFailures.clear();
        logDebug('[SubagentManager] ヘルスチェック再開');
    }

    /**
     * 1回分のヘルスチェックを実行する。
     */
    private async runHealthCheck(): Promise<void> {
        // チームモード実行中はヘルスチェックをスキップ
        if (this.healthCheckPaused) {
            return;
        }

        for (const [name, handle] of this.agents) {
            if (handle.state !== 'BUSY' && handle.state !== 'READY') continue;

            const alive = await handle.isAlive();
            if (!alive) {
                // 連続失敗カウンターをインクリメント
                const failures = (this.consecutiveFailures.get(name) ?? 0) + 1;
                this.consecutiveFailures.set(name, failures);

                if (failures >= SubagentManager.HEALTH_CHECK_FAIL_THRESHOLD) {
                    logWarn(`[SubagentManager] エージェント "${name}" がクラッシュを検出（連続 ${failures} 回失敗）。クリーンアップ中...`);
                    this.consecutiveFailures.delete(name);
                    try {
                        await handle.close();
                    } catch {
                        // close 失敗は無視
                    }
                    this.agents.delete(name);
                } else {
                    logDebug(`[SubagentManager] エージェント "${name}" の isAlive 失敗（${failures}/${SubagentManager.HEALTH_CHECK_FAIL_THRESHOLD}）— 次回再チェック`);
                }
            } else {
                // 成功したらカウンターをリセット
                if (this.consecutiveFailures.has(name)) {
                    this.consecutiveFailures.delete(name);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // リソース管理
    // -----------------------------------------------------------------------

    /**
     * stale（死んでいる）サブエージェントをクリーンアップする。
     * 各エージェントの isAlive() を確認し、死んでいるものを Map から除去する。
     * spawn() 前やチームモード開始時に呼び出して、残留エージェントが
     * maxConcurrent を圧迫するのを防ぐ。
     */
    async cleanupStaleAgents(): Promise<number> {
        const staleNames: string[] = [];
        for (const [name, handle] of this.agents) {
            const s = handle.state;
            // 既に終了状態のものは即座にクリーンアップ対象
            if (s === 'CLEANED' || s === 'FAILED') {
                staleNames.push(name);
                continue;
            }
            // BUSY / READY 状態のものは実際に生きているか確認
            if (s === 'BUSY' || s === 'READY') {
                try {
                    const alive = await handle.isAlive();
                    if (!alive) {
                        logWarn(`[SubagentManager] stale エージェント検出: "${name}" (state=${s}, alive=false)`);
                        staleNames.push(name);
                    }
                } catch {
                    // isAlive 失敗 = 死んでいると判断
                    logWarn(`[SubagentManager] stale エージェント検出 (isAlive failed): "${name}"`);
                    staleNames.push(name);
                }
            }
        }

        // クリーンアップ実行
        for (const name of staleNames) {
            const handle = this.agents.get(name);
            if (handle) {
                try {
                    await handle.close();
                } catch {
                    // close 失敗は無視
                }
                this.agents.delete(name);
            }
        }

        if (staleNames.length > 0) {
            logDebug(`[SubagentManager] ${staleNames.length} 個の stale エージェントをクリーンアップしました: ${staleNames.join(', ')}`);
        }



        return staleNames.length;
    }

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
        this.stopIdleCleanup();
        await this.killAll();
        await this.clearIdlePool();
        logDebug('[SubagentManager] dispose 完了');
    }
}
