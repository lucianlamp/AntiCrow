// ---------------------------------------------------------------------------
// executorPool.ts — ワークスペース毎の Executor プール管理
// ---------------------------------------------------------------------------
// 責務:
//   1. ワークスペース名 → Executor インスタンスの 1:1 マッピング管理
//   2. 各ワークスペース内での直列実行を保証
//   3. 異なるワークスペース間の並列実行を実現
// ---------------------------------------------------------------------------

import { Plan } from './types';
import { CdpBridge } from './cdpBridge';
import { FileIpc } from './fileIpc';
import { PlanStore } from './planStore';
import { Executor, NotifyFunc, SendTypingFunc, PostSuggestionsFunc, SendFileFunc } from './executor';
import { CdpPool, DEFAULT_WORKSPACE } from './cdpPool';
import { logDebug, logWarn } from './logger';

/**
 * ワークスペース毎に独立した Executor を管理するプール。
 *
 * 不変条件:
 *   - 同一ワークスペースは1つの Executor が担当（直列実行保証）
 *   - 異なるワークスペースの Executor は独立・並列に動作可能
 */
export class ExecutorPool {
    private pool = new Map<string, Executor>();
    private cdpPool: CdpPool;
    private fileIpc: FileIpc;
    private planStore: PlanStore;
    private timeoutMs: number;
    private notifyDiscord: NotifyFunc;
    private sendTyping: SendTypingFunc;
    private extensionPath: string;
    private postSuggestions: PostSuggestionsFunc | null;
    private sendFile: SendFileFunc | null;

    /** モデル名更新コールバック（新規 Executor 生成時にも自動適用） */
    private setModelNameCallback: ((name: string | null) => void) | null = null;

    constructor(
        cdpPool: CdpPool,
        fileIpc: FileIpc,
        planStore: PlanStore,
        timeoutMs: number,
        notifyDiscord: NotifyFunc,
        sendTyping: SendTypingFunc,
        extensionPath?: string,
        postSuggestions?: PostSuggestionsFunc,
        sendFile?: SendFileFunc,
    ) {
        this.cdpPool = cdpPool;
        this.fileIpc = fileIpc;
        this.planStore = planStore;
        this.timeoutMs = timeoutMs;
        this.notifyDiscord = notifyDiscord;
        this.sendTyping = sendTyping;
        this.extensionPath = extensionPath || '';
        this.postSuggestions = postSuggestions ?? null;
        this.sendFile = sendFile ?? null;
    }

    // -------------------------------------------------------------------
    // Executor 取得・作成
    // -------------------------------------------------------------------

    /**
     * ワークスペース名に対応する Executor を取得する。
     * 存在しなければ CdpPool から CdpBridge を取得して新規作成する。
     *
     * @throws CdpPool.acquire() がターゲットを見つけられない場合
     */
    async getOrCreate(workspaceName: string): Promise<Executor> {
        const key = workspaceName || DEFAULT_WORKSPACE;

        const existing = this.pool.get(key);
        if (existing) {
            logDebug(`ExecutorPool: reusing executor for workspace "${key}"`);
            return existing;
        }

        // CdpPool から CdpBridge を取得（自動接続付き）
        const cdp = await this.cdpPool.acquire(key);

        const executor = new Executor(
            cdp,
            this.fileIpc,
            this.planStore,
            this.timeoutMs,
            this.notifyDiscord,
            this.sendTyping,
            this.extensionPath,
            this.postSuggestions ?? undefined,
            this.sendFile ?? undefined,
        );

        this.pool.set(key, executor);
        logDebug(`ExecutorPool: created executor for workspace "${key}" (pool size=${this.pool.size})`);

        // モデル名更新コールバックが設定済みなら新規 Executor にも自動適用
        if (this.setModelNameCallback) {
            executor.setSetModelNameFn(this.setModelNameCallback);
        }
        return executor;
    }

    /**
     * ワークスペース名で Executor を取得する（なければ null）。
     */
    get(workspaceName: string): Executor | null {
        const key = workspaceName || DEFAULT_WORKSPACE;
        return this.pool.get(key) ?? null;
    }

    // -------------------------------------------------------------------
    // ジョブ追加ヘルパー
    // -------------------------------------------------------------------

    /**
     * 即時実行ジョブをワークスペース指定で追加する。
     * Executor が存在しなければ自動作成する。
     */
    async enqueueImmediate(workspaceName: string, plan: Plan): Promise<void> {
        const executor = await this.getOrCreate(workspaceName);
        await executor.enqueueImmediate(plan);
    }

    /**
     * スケジュール実行ジョブをワークスペース指定で追加する。
     * Executor が存在しなければ自動作成する。
     */
    async enqueueScheduled(workspaceName: string, plan: Plan): Promise<void> {
        const executor = await this.getOrCreate(workspaceName);
        executor.enqueueScheduled(plan);
    }

    // -------------------------------------------------------------------
    // 後方互換: デフォルト Executor
    // -------------------------------------------------------------------

    /**
     * デフォルトワークスペースの Executor を取得する（後方互換用）。
     * プールが空なら null。プールに1つだけなら、それを返す。
     */
    getDefault(): Executor | null {
        // デフォルトキーがあればそれ
        const def = this.pool.get(DEFAULT_WORKSPACE);
        if (def) { return def; }
        // エントリが1つだけなら、それを返す
        if (this.pool.size === 1) {
            const [executor] = this.pool.values();
            return executor;
        }
        return null;
    }

    // -------------------------------------------------------------------
    // プール管理
    // -------------------------------------------------------------------

    /**
     * 全 Executor をリセット（停止）する。
     */
    forceResetAll(): void {
        for (const [key, executor] of this.pool.entries()) {
            logDebug(`ExecutorPool: force-resetting executor for workspace "${key}"`);
            executor.forceReset();
        }
    }

    /**
     * 指定ワークスペースの Executor の現在のジョブを停止する（キューは保持）。
     * @returns 対象 Executor が存在して停止できたかどうか。
     */
    forceStop(workspaceName: string): boolean {
        const key = workspaceName || DEFAULT_WORKSPACE;
        const executor = this.pool.get(key);
        if (executor) {
            logDebug(`ExecutorPool: force-stopping executor for workspace "${key}"`);
            executor.forceStop();
            return true;
        }
        logDebug(`ExecutorPool: no executor found for workspace "${key}" (skip forceStop)`);
        return false;
    }

    /**
     * 全 Executor の現在のジョブを停止する（キューは保持）。
     */
    forceStopAll(): void {
        for (const [key, executor] of this.pool.entries()) {
            logDebug(`ExecutorPool: force-stopping executor for workspace "${key}"`);
            executor.forceStop();
        }
    }

    /**
     * プールをクリアする（Bridge 停止時用）。
     */
    clear(): void {
        this.forceResetAll();
        this.pool.clear();
        logDebug('ExecutorPool: pool cleared');
    }



    /**
     * いずれかの Executor が実行中かどうか。
     */
    isAnyRunning(): boolean {
        for (const executor of this.pool.values()) {
            if (executor.isRunning()) { return true; }
        }
        return false;
    }

    /**
     * 指定ワークスペースの Executor が実行中かどうか。
     */
    isRunning(workspaceName: string): boolean {
        const key = workspaceName || DEFAULT_WORKSPACE;
        const executor = this.pool.get(key);
        return executor ? executor.isRunning() : false;
    }

    /**
     * プールサイズを取得する。
     */
    get size(): number {
        return this.pool.size;
    }

    /**
     * プール内のワークスペース一覧を取得する。
     */
    getWorkspaceNames(): string[] {
        return Array.from(this.pool.keys());
    }



    // -------------------------------------------------------------------
    // モデル名更新コールバック
    // -------------------------------------------------------------------

    /**
     * モデル名更新コールバックを設定する。
     * 既存の全 Executor と今後作成される Executor に適用される。
     */
    setSetModelNameFn(fn: (name: string | null) => void): void {
        this.setModelNameCallback = fn;
        for (const executor of this.pool.values()) {
            executor.setSetModelNameFn(fn);
        }
    }
}
