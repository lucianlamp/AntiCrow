// ---------------------------------------------------------------------------
// cdpPool.ts — ワークスペース毎の CdpBridge プール管理
// ---------------------------------------------------------------------------
// 責務:
//   1. ワークスペース名 → CdpBridge インスタンスの 1:1 マッピング管理
//   2. 同一ワークスペースへの重複インスタンス防止（ロック機構）
//   3. アイドル接続の自動開放
//   4. 後方互換: デフォルトワークスペースのフォールバック
// ---------------------------------------------------------------------------

import { CdpBridge, DiscoveredInstance } from './cdpBridge';
import { getCdpPorts, getWorkspacePaths } from './configHelper';
import { logInfo, logWarn, logDebug } from './logger';

/** デフォルトワークスペース名（カテゴリー未指定時のフォールバック） */
export const DEFAULT_WORKSPACE = '__default__';

/** プール内のエントリ */
interface PoolEntry {
    cdp: CdpBridge;
    workspaceName: string;
    lastUsedAt: number;
}

/**
 * ワークスペース毎に CdpBridge を管理するプール。
 *
 * 不変条件:
 *   - 同一 workspaceName に対して常に同じ CdpBridge インスタンスを返す
 *   - acquire() の同時呼び出しに対してロック（Promise チェーン）で排他制御
 *   - 同一ターゲット ID への重複 WebSocket 接続を防止
 */
export class CdpPool {
    private pool = new Map<string, PoolEntry>();
    private ports: number[] | undefined;
    private storagePath: string | undefined;

    /** acquire() の競合防止ロック（ワークスペース単位） */
    private acquireLocks = new Map<string, Promise<CdpBridge>>();

    constructor(ports?: number[], storagePath?: string) {
        this.ports = ports;
        this.storagePath = storagePath;
    }

    /** ポートファイルを再読取して最新のポートリストを取得 */
    private getFreshPorts(): number[] | undefined {
        if (this.storagePath) {
            return getCdpPorts(this.storagePath);
        }
        return this.ports;
    }

    // -------------------------------------------------------------------
    // acquire — メイン API
    // -------------------------------------------------------------------

    /**
     * ワークスペース名で CdpBridge を取得する。
     * プールに存在すれば既存インスタンスを返し、なければ新規作成して接続する。
     *
     * 同一ワークスペースに対する並行 acquire() 呼び出しは直列化される。
     */
    async acquire(workspaceName: string, onAutoLaunch?: (wsName: string) => void | Promise<void>): Promise<CdpBridge> {
        const key = workspaceName || DEFAULT_WORKSPACE;

        // 既にプールにあり、接続済みなら即座に返す
        const existing = this.pool.get(key);
        if (existing) {
            existing.lastUsedAt = Date.now();
            logDebug(`CdpPool: reusing existing CdpBridge for workspace "${key}"`);
            return existing.cdp;
        }

        // ロックを使って同一ワークスペースへの同時 acquire を直列化
        const pendingLock = this.acquireLocks.get(key);
        if (pendingLock) {
            logDebug(`CdpPool: waiting for pending acquire for workspace "${key}"`);
            return pendingLock;
        }

        const acquirePromise = this.doAcquire(key, onAutoLaunch);
        this.acquireLocks.set(key, acquirePromise);

        try {
            const cdp = await acquirePromise;
            return cdp;
        } finally {
            this.acquireLocks.delete(key);
        }
    }

    /**
     * 内部: CdpBridge を作成してターゲットに接続する。
     */
    private async doAcquire(workspaceName: string, onAutoLaunch?: (wsName: string) => void | Promise<void>): Promise<CdpBridge> {
        // ダブルチェック: ロック待ちの間に別の呼び出しが作成済みかもしれない
        const existing = this.pool.get(workspaceName);
        if (existing) {
            existing.lastUsedAt = Date.now();
            return existing.cdp;
        }

        const cdp = new CdpBridge(undefined, this.ports);

        if (workspaceName === DEFAULT_WORKSPACE) {
            // デフォルトワークスペース: 従来と同じ自動探索接続
            logInfo(`CdpPool: creating default CdpBridge (auto-discover)`);
            await cdp.connect();
        } else {
            // 特定ワークスペース: ポートファイルを再読取してターゲットを発見
            logInfo(`CdpPool: creating CdpBridge for workspace "${workspaceName}"`);
            const freshPorts = this.getFreshPorts();
            const instances = await CdpBridge.discoverInstances(freshPorts);
            let target = instances.find(
                i => CdpBridge.extractWorkspaceName(i.title) === workspaceName,
            );

            if (!target) {
                // ワークスペースが見つからない → workspacePaths 設定から自動起動を試みる
                const wsPaths = getWorkspacePaths();
                const folderPath = wsPaths[workspaceName];
                if (folderPath) {
                    logInfo(`CdpPool: workspace "${workspaceName}" not found, auto-launching folder "${folderPath}"...`);

                    // コールバックで呼び出し元に通知（Discord へのフィードバック用）
                    if (onAutoLaunch) {
                        try { await onAutoLaunch(workspaceName); } catch { /* ignore */ }
                    }

                    await cdp.connect();  // launchAntigravity のために接続が必要
                    await cdp.launchAntigravity(folderPath);

                    // UI 初期化待ち: Antigravity が起動してチャットパネルが準備完了するまで待機
                    logInfo(`CdpPool: waiting 10s for Antigravity UI initialization...`);
                    await new Promise(r => setTimeout(r, 10_000));

                    // ポーリングで新インスタンスを待機
                    const maxWaitMs = 30_000;
                    const pollMs = 2_000;
                    const deadline = Date.now() + maxWaitMs;
                    let pollCount = 0;
                    while (Date.now() < deadline) {
                        await new Promise(r => setTimeout(r, pollMs));
                        const freshPorts = this.getFreshPorts();
                        const freshInstances = await CdpBridge.discoverInstances(freshPorts);
                        target = freshInstances.find(
                            i => CdpBridge.extractWorkspaceName(i.title) === workspaceName,
                        );
                        pollCount++;
                        if (target) {
                            logInfo(`CdpPool: auto-launched workspace "${workspaceName}" found (id=${target.id}) after ${pollCount} polls`);
                            break;
                        }
                        logDebug(`CdpPool: polling for workspace "${workspaceName}"... (${pollCount})`);
                    }
                } else {
                    // workspacePaths 未設定 — 外部で起動された可能性があるためポーリングで待機
                    logInfo(`CdpPool: workspace "${workspaceName}" not found, no folderPath configured. Polling for external launch...`);
                    const maxWaitMs = 15_000;
                    const pollMs = 3_000;
                    const deadline = Date.now() + maxWaitMs;
                    let pollCount = 0;
                    while (Date.now() < deadline) {
                        await new Promise(r => setTimeout(r, pollMs));
                        const freshPorts = this.getFreshPorts();
                        const freshInstances = await CdpBridge.discoverInstances(freshPorts);
                        target = freshInstances.find(
                            i => CdpBridge.extractWorkspaceName(i.title) === workspaceName,
                        );
                        pollCount++;
                        if (target) {
                            logInfo(`CdpPool: externally launched workspace "${workspaceName}" found (id=${target.id}) after ${pollCount} polls`);
                            break;
                        }
                        logDebug(`CdpPool: polling for external workspace "${workspaceName}"... (${pollCount})`);
                    }
                }

                if (!target) {
                    // 最終チェック: 全ポートを再スキャンしてエラーメッセージに反映
                    const finalPorts = this.getFreshPorts();
                    const finalInstances = await CdpBridge.discoverInstances(finalPorts);
                    throw new Error(
                        `CdpPool: workspace "${workspaceName}" not found among ` +
                        `${finalInstances.length} discovered instance(s): ` +
                        finalInstances.map(i => `"${CdpBridge.extractWorkspaceName(i.title)}"`).join(', '),
                    );
                }
            }

            // 重複 WebSocket 接続チェック: 同一ターゲット ID が既に別のエントリで使われていないか
            for (const [existingKey, entry] of this.pool.entries()) {
                if (entry.cdp.getActiveTargetId() === target.id) {
                    logWarn(
                        `CdpPool: target ${target.id} is already connected as workspace "${existingKey}". ` +
                        `Returning existing instance.`,
                    );
                    entry.lastUsedAt = Date.now();
                    // エイリアスとして登録
                    this.pool.set(workspaceName, entry);
                    return entry.cdp;
                }
            }

            await cdp.switchTarget(target.id);
        }

        const entry: PoolEntry = {
            cdp,
            workspaceName,
            lastUsedAt: Date.now(),
        };
        this.pool.set(workspaceName, entry);
        logInfo(`CdpPool: pool size = ${this.pool.size} after acquiring "${workspaceName}"`);
        return cdp;
    }

    // -------------------------------------------------------------------
    // プール管理
    // -------------------------------------------------------------------

    /**
     * プール内の CdpBridge を取得する（acquire と違い、なければ null）。
     */
    get(workspaceName: string): CdpBridge | null {
        const key = workspaceName || DEFAULT_WORKSPACE;
        const entry = this.pool.get(key);
        if (entry) {
            entry.lastUsedAt = Date.now();
            return entry.cdp;
        }
        return null;
    }

    /**
     * デフォルトの CdpBridge を取得する（後方互換用）。
     * プールが空なら null。プールにエントリが1つだけならそれを返す。
     * DEFAULT_WORKSPACE があればそれを返す。
     */
    getDefault(): CdpBridge | null {
        // DEFAULT_WORKSPACE が明示的にあればそれを返す
        const def = this.pool.get(DEFAULT_WORKSPACE);
        if (def) { return def.cdp; }
        // プールにエントリが1つだけならそれを返す
        if (this.pool.size === 1) {
            const [entry] = this.pool.values();
            return entry.cdp;
        }
        return null;
    }

    /**
     * 指定時間以上使用されていない接続を開放する。
     */
    async releaseIdle(maxIdleMs: number): Promise<void> {
        const now = Date.now();
        const toRelease: string[] = [];

        for (const [key, entry] of this.pool.entries()) {
            if (now - entry.lastUsedAt > maxIdleMs) {
                toRelease.push(key);
            }
        }

        for (const key of toRelease) {
            const entry = this.pool.get(key);
            if (entry) {
                logInfo(`CdpPool: releasing idle workspace "${key}" (idle ${Math.round((now - entry.lastUsedAt) / 1000)}s)`);
                entry.cdp.fullDisconnect();
                this.pool.delete(key);
            }
        }

        if (toRelease.length > 0) {
            logInfo(`CdpPool: released ${toRelease.length} idle connection(s), pool size = ${this.pool.size}`);
        }
    }

    /**
     * 全接続を切断してプールをクリアする。
     */
    disconnectAll(): void {
        for (const [key, entry] of this.pool.entries()) {
            logInfo(`CdpPool: disconnecting workspace "${key}"`);
            entry.cdp.fullDisconnect();
        }
        this.pool.clear();
        this.acquireLocks.clear();
        logInfo('CdpPool: all connections disconnected, pool cleared');
    }

    /**
     * プール内のワークスペース一覧を取得する。
     */
    getWorkspaceNames(): string[] {
        return Array.from(this.pool.keys());
    }

    /**
     * プールサイズを取得する。
     */
    get size(): number {
        return this.pool.size;
    }
}
