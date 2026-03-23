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
import { getCdpPorts, resolveWorkspacePaths } from './configHelper';
import { logDebug, logError, logWarn } from './logger';
import { WorkspaceStore } from './workspaceStore';
import { t } from './i18n';

/** デフォルトワークスペース名（カテゴリー未指定時のフォールバック） */
export const DEFAULT_WORKSPACE = '__default__';

/**
 * ワークスペース関連のユーザー向けエラー。
 * sanitizeErrorForDiscord に依存せず、安全なメッセージを持つ。
 */
export class WorkspaceConnectionError extends Error {
    /** ユーザーに表示する安全なメッセージ */
    readonly userMessage: string;
    constructor(userMessage: string, internalDetail?: string) {
        super(internalDetail || userMessage);
        this.name = 'WorkspaceConnectionError';
        this.userMessage = userMessage;
    }
}

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
    private workspaceStore: WorkspaceStore | undefined;

    /** このウィンドウのワークスペース名（マルチウィンドウ優先接続用） */
    private ownerWorkspaceName: string | null = null;

    /** acquire() の競合防止ロック（ワークスペース単位） */
    private acquireLocks = new Map<string, Promise<CdpBridge>>();

    constructor(ports?: number[], storagePath?: string) {
        this.ports = ports;
        this.storagePath = storagePath;
        if (storagePath) {
            this.workspaceStore = new WorkspaceStore(storagePath);
        }
    }

    /**
     * このウィンドウのワークスペース名を設定する。
     * DEFAULT_WORKSPACE で CdpBridge を作成する際に、自ウィンドウを優先接続する。
     */
    setOwnerWorkspace(name: string | null): void {
        this.ownerWorkspaceName = name;
        if (name) {
            logDebug(`CdpPool: owner workspace set to "${name}"`);
        }
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
        logDebug(`CdpPool.acquire: input="${workspaceName}", key="${key}", poolKeys=[${Array.from(this.pool.keys()).join(', ')}]`);

        // 既にプールにあり、接続済みなら即座に返す
        const existing = this.pool.get(key);
        if (existing) {
            existing.lastUsedAt = Date.now();
            logDebug(`CdpPool: reusing existing CdpBridge for workspace "${key}" (targetId=${existing.cdp.getActiveTargetId() || 'unknown'})`);
            return existing.cdp;
        }

        // ロックを使って同一ワークスペースへの同時 acquire を直列化
        const pendingLock = this.acquireLocks.get(key);
        if (pendingLock) {
            logDebug(`CdpPool: waiting for pending acquire for workspace "${key}"`);
            const result = await pendingLock;
            // pendingLock 完了後に pool を再チェック（完了間に pool が更新された場合の安全弁）
            const fresh = this.pool.get(key);
            if (fresh) {
                fresh.lastUsedAt = Date.now();
                return fresh.cdp;
            }
            return result;
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
     * ワークスペース名でアクティブな CdpBridge を取得する。
     * プール内に存在する場合はそれを返し、存在しない場合は null を返す。
     * 起動や自動探索は行わない（主にキャンセル等の起動を伴わない操作用）。
     */
    getActive(workspaceName: string): CdpBridge | null {
        const key = workspaceName || DEFAULT_WORKSPACE;
        const existing = this.pool.get(key);
        if (existing) {
            existing.lastUsedAt = Date.now();
            return existing.cdp;
        }
        return null;
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

        // 自ウィンドウのワークスペース名と一致する場合は DEFAULT_WORKSPACE と同じ自動探索接続を使用。
        // これにより、既に開いているウィンドウの CDP に優先接続し、
        // 新しいウィンドウを不必要に起動するのを防ぐ。
        const isOwnWorkspace = this.ownerWorkspaceName && workspaceName === this.ownerWorkspaceName;

        if (workspaceName === DEFAULT_WORKSPACE || isOwnWorkspace) {
            // デフォルトワークスペース or 自ウィンドウ: 従来と同じ自動探索接続
            // マルチウィンドウ対応: 自ウィンドウを優先接続
            if (this.ownerWorkspaceName) {
                cdp.setPreferredWorkspace(this.ownerWorkspaceName);
            }
            logDebug(`CdpPool: creating CdpBridge (auto-discover, preferred=${this.ownerWorkspaceName || 'none'}, isOwn=${!!isOwnWorkspace})`);
            await cdp.connect();
        } else {
            // 特定ワークスペース: ポートファイルを再読取してターゲットを発見
            logDebug(`CdpPool: creating CdpBridge for workspace "${workspaceName}"`);
            const freshPorts = this.getFreshPorts();
            const instances = await CdpBridge.discoverInstances(freshPorts);
            let target = instances.find(
                i => CdpBridge.extractWorkspaceName(i.title) === workspaceName,
            );
            // 完全一致で見つからない場合、大文字小文字無視でフォールバック
            if (!target) {
                const lowerWs = workspaceName.toLowerCase();
                target = instances.find(
                    i => CdpBridge.extractWorkspaceName(i.title).toLowerCase() === lowerWs,
                );
                if (target) {
                    logWarn(`CdpPool: exact match for "${workspaceName}" not found, case-insensitive match: "${CdpBridge.extractWorkspaceName(target.title)}"`);
                }
            }

            if (!target) {
                // ワークスペースが見つからない → 自動学習データまたは手動設定からフォルダパスを取得
                const wsPaths = resolveWorkspacePaths(this.workspaceStore);
                const folderPath = wsPaths[workspaceName];
                if (folderPath) {
                    logDebug(`CdpPool: workspace "${workspaceName}" not found, auto-launching folder "${folderPath}"...`);

                    // コールバックで呼び出し元に通知（Discord へのフィードバック用）
                    if (onAutoLaunch) {
                        try { await onAutoLaunch(workspaceName); } catch (e) { logDebug(`CdpPool: onAutoLaunch callback failed: ${e}`); }
                    }

                    // launchAntigravity は vscode.window.createTerminal を使うため CDP 接続不要。
                    // ただし既存の Antigravity が起動していれば connect してから launch する。
                    // 未起動の場合は connect を安全にスキップして launch のみ実行する。
                    let connectedForLaunch = false;
                    try {
                        await cdp.connect();
                        connectedForLaunch = true;
                        logDebug(`CdpPool: connected to existing Antigravity for launch`);
                    } catch (connectErr) {
                        // Antigravity 未起動 — connect 失敗は想定内。launch のみで進める
                        logDebug(`CdpPool: connect failed (Antigravity may not be running), proceeding with launch only: ${connectErr instanceof Error ? connectErr.message : connectErr}`);
                    }

                    try {
                        await cdp.launchAntigravity(folderPath);
                    } catch (launchErr) {
                        logError(`CdpPool: launchAntigravity failed for "${workspaceName}"`, launchErr);
                        throw new WorkspaceConnectionError(
                            t('cdpPool.launchFailed', workspaceName),
                            `launchAntigravity failed: ${launchErr instanceof Error ? launchErr.message : launchErr}`,
                        );
                    }

                    // ポーリングで新インスタンスを待機
                    const maxWaitMs = 30_000;
                    const pollMs = 2_000;
                    const deadline = Date.now() + maxWaitMs;
                    let pollCount = 0;
                    while (Date.now() < deadline) {
                        await new Promise(r => setTimeout(r, pollMs));
                        try {
                            const freshPorts = this.getFreshPorts();
                            const freshInstances = await CdpBridge.discoverInstances(freshPorts);
                            target = freshInstances.find(
                                i => CdpBridge.extractWorkspaceName(i.title) === workspaceName,
                            );
                            pollCount++;
                            if (target) {
                                logDebug(`CdpPool: auto-launched workspace "${workspaceName}" found (id=${target.id}) after ${pollCount} polls`);
                                break;
                            }
                            logDebug(`CdpPool: polling for workspace "${workspaceName}"... (${pollCount})`);
                        } catch (pollErr) {
                            pollCount++;
                            logDebug(`CdpPool: polling error (${pollCount}): ${pollErr instanceof Error ? pollErr.message : pollErr}`);
                        }
                    }
                } else {
                    // workspacePaths 未設定 — まず guessBaseDirs でフォルダパスの推測を試みる
                    const guessedPath = this.tryGuessAndLearn(workspaceName);
                    if (guessedPath) {
                        logDebug(`CdpPool: workspace "${workspaceName}" — guessed folder path "${guessedPath}", auto-launching...`);

                        if (onAutoLaunch) {
                            try { await onAutoLaunch(workspaceName); } catch (e) { logDebug(`CdpPool: onAutoLaunch callback failed: ${e}`); }
                        }

                        let connectedForLaunch = false;
                        try {
                            await cdp.connect();
                            connectedForLaunch = true;
                            logDebug(`CdpPool: connected to existing Antigravity for guessed launch`);
                        } catch (connectErr) {
                            logDebug(`CdpPool: connect failed for guessed launch (Antigravity may not be running): ${connectErr instanceof Error ? connectErr.message : connectErr}`);
                        }

                        try {
                            await cdp.launchAntigravity(guessedPath);
                        } catch (launchErr) {
                            logError(`CdpPool: launchAntigravity failed for guessed path "${guessedPath}"`, launchErr);
                            throw new WorkspaceConnectionError(
                                t('cdpPool.launchFailed', workspaceName),
                                `launchAntigravity failed (guessed path): ${launchErr instanceof Error ? launchErr.message : launchErr}`,
                            );
                        }

                        // ポーリングで新インスタンスを待機
                        const maxWaitMs = 30_000;
                        const pollMs = 2_000;
                        const deadline = Date.now() + maxWaitMs;
                        let pollCount = 0;
                        while (Date.now() < deadline) {
                            await new Promise(r => setTimeout(r, pollMs));
                            try {
                                const freshPorts = this.getFreshPorts();
                                const freshInstances = await CdpBridge.discoverInstances(freshPorts);
                                target = freshInstances.find(
                                    i => CdpBridge.extractWorkspaceName(i.title) === workspaceName,
                                );
                                pollCount++;
                                if (target) {
                                    logDebug(`CdpPool: guessed-launch workspace "${workspaceName}" found (id=${target.id}) after ${pollCount} polls`);
                                    break;
                                }
                                logDebug(`CdpPool: polling for guessed-launch workspace "${workspaceName}"... (${pollCount})`);
                            } catch (pollErr) {
                                pollCount++;
                                logDebug(`CdpPool: guessed-launch polling error (${pollCount}): ${pollErr instanceof Error ? pollErr.message : pollErr}`);
                            }
                        }
                    } else {
                        // 推測も失敗 — 外部で起動された可能性があるためポーリングで待機
                        logDebug(`CdpPool: workspace "${workspaceName}" not found, no folderPath configured or guessed. Polling for external launch...`);
                        const maxWaitMs = 15_000;
                        const pollMs = 3_000;
                        const deadline = Date.now() + maxWaitMs;
                        let pollCount = 0;
                        while (Date.now() < deadline) {
                            await new Promise(r => setTimeout(r, pollMs));
                            try {
                                const freshPorts = this.getFreshPorts();
                                const freshInstances = await CdpBridge.discoverInstances(freshPorts);
                                target = freshInstances.find(
                                    i => CdpBridge.extractWorkspaceName(i.title) === workspaceName,
                                );
                                pollCount++;
                                if (target) {
                                    logDebug(`CdpPool: externally launched workspace "${workspaceName}" found (id=${target.id}) after ${pollCount} polls`);
                                    break;
                                }
                                logDebug(`CdpPool: polling for external workspace "${workspaceName}"... (${pollCount})`);
                            } catch (pollErr) {
                                pollCount++;
                                logDebug(`CdpPool: external polling error (${pollCount}): ${pollErr instanceof Error ? pollErr.message : pollErr}`);
                            }
                        }
                    }
                }

                if (!target) {
                    // 最終チェック: 全ポートを再スキャンして検出結果をログに記録
                    let discoveredCount = 0;
                    let discoveredNames: string[] = [];
                    try {
                        const finalPorts = this.getFreshPorts();
                        const finalInstances = await CdpBridge.discoverInstances(finalPorts);
                        discoveredCount = finalInstances.length;
                        discoveredNames = finalInstances.map(i => CdpBridge.extractWorkspaceName(i.title));
                    } catch (e) {
                        logDebug(`CdpPool: final discovery failed: ${e instanceof Error ? e.message : e}`);
                    }

                    // 内部詳細はログに記録し、ユーザーには安全なメッセージを表示
                    logWarn(
                        `CdpPool: workspace "${workspaceName}" not found after polling. ` +
                        `Discovered ${discoveredCount} instance(s): [${discoveredNames.join(', ')}]`,
                    );

                    const hasFolder = !!resolveWorkspacePaths(this.workspaceStore)[workspaceName];
                    if (hasFolder) {
                        throw new WorkspaceConnectionError(
                            t('cdpPool.connectFailed', workspaceName),
                        );
                    } else {
                        throw new WorkspaceConnectionError(
                            t('cdpPool.notFound', workspaceName),
                        );
                    }
                }
            }

            // 重複 WebSocket 接続チェック: 同一ターゲット ID が既に別のエントリで使われていないか
            for (const [existingKey, entry] of this.pool.entries()) {
                if (entry.cdp.getActiveTargetId() === target.id) {
                    // 同一ターゲットに接続済み → 要求WSと既存WSが異なる場合は警告
                    if (existingKey !== workspaceName) {
                        const actualWsName = entry.cdp.getActiveWorkspaceName() || existingKey;
                        logWarn(
                            `CdpPool: target ${target.id} for requested workspace "${workspaceName}" ` +
                            `is already connected as workspace "${existingKey}" (actual="${actualWsName}"). ` +
                            `This suggests both workspaces share the same Antigravity window. ` +
                            `Messages will be sent to "${actualWsName}" — consider opening a separate window for "${workspaceName}".`,
                        );
                    } else {
                        logDebug(`CdpPool: target ${target.id} is reconnecting to same workspace "${existingKey}".`);
                    }
                    entry.lastUsedAt = Date.now();
                    // エイリアスとして登録
                    this.pool.set(workspaceName, entry);
                    return entry.cdp;
                }
            }

            await cdp.switchTarget(target.id);

            // Cascade パネル iframe がチャット入力欄を読み込むまでポーリング待機
            {
                const panelMaxWaitMs = 30_000;
                const panelPollMs = 2_000;
                const panelDeadline = Date.now() + panelMaxWaitMs;
                let panelReady = false;
                let panelPollCount = 0;

                logDebug(`CdpPool: waiting for Cascade panel iframe to be ready (max ${panelMaxWaitMs / 1000}s)...`);

                while (Date.now() < panelDeadline) {
                    try {
                        const ok = await cdp.testConnection();
                        panelPollCount++;
                        if (ok) {
                            logDebug(`CdpPool: Cascade panel ready after ${panelPollCount} poll(s)`);
                            panelReady = true;
                            break;
                        }
                    } catch {
                        panelPollCount++;
                        logDebug(`CdpPool: Cascade panel not ready yet (poll ${panelPollCount})`);
                    }
                    await new Promise(r => setTimeout(r, panelPollMs));
                }

                if (!panelReady) {
                    logWarn(`CdpPool: Cascade panel iframe not ready after ${panelMaxWaitMs / 1000}s — proceeding anyway (sendPrompt may fail)`);
                }
            }
        }

        const entry: PoolEntry = {
            cdp,
            workspaceName,
            lastUsedAt: Date.now(),
        };
        this.pool.set(workspaceName, entry);
        logDebug(`CdpPool: pool size = ${this.pool.size} after acquiring "${workspaceName}"`);

        // 接続成功後にフォルダパスを自動学習（バックグラウンド、失敗しても無視）
        if (this.workspaceStore && workspaceName !== DEFAULT_WORKSPACE) {
            this.learnFolderPath(cdp, workspaceName).catch(e =>
                logDebug(`CdpPool: learnFolderPath failed for "${workspaceName}": ${e}`),
            );
        }

        return cdp;
    }

    // -------------------------------------------------------------------
    // ワークスペースフォルダパスの自動学習
    // -------------------------------------------------------------------

    /**
     * ワークスペース名からフォルダパスを推測し、見つかれば WorkspaceStore に保存して返す。
     * doAcquire 内で即座にフォルダパスを取得するために使用（同期的）。
     */
    private tryGuessAndLearn(workspaceName: string): string | null {
        if (!this.workspaceStore) { return null; }

        const fs = require('fs') as typeof import('fs');
        const pathModule = require('path') as typeof import('path');
        const baseDirs = this.guessBaseDirs();

        for (const baseDir of baseDirs) {
            const candidate = pathModule.join(baseDir, workspaceName);
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                    this.workspaceStore.learn(workspaceName, candidate);
                    logDebug(`CdpPool: tryGuessAndLearn — found and learned "${workspaceName}" → "${candidate}"`);
                    return candidate;
                }
            } catch { /* ignore */ }
        }

        logDebug(`CdpPool: tryGuessAndLearn — could not guess folder path for "${workspaceName}"`);
        return null;
    }

    /**
     * CDP 接続成功後にワークスペースのフォルダパスを推定し、WorkspaceStore に保存する。
     * バックグラウンドで実行され、失敗しても接続処理には影響しない。
     */
    private async learnFolderPath(_cdp: CdpBridge, workspaceName: string): Promise<void> {
        if (!this.workspaceStore) { return; }

        // 既に学習済みで、そのパスが存在する場合はスキップ
        const existing = this.workspaceStore.getFolderPath(workspaceName);
        if (existing && require('fs').existsSync(existing)) {
            logDebug(`CdpPool: folder path for "${workspaceName}" already known: "${existing}"`);
            return;
        }

        // フォルダパス推定: ワークスペース名 = フォルダ名と仮定し、
        // よくある開発ディレクトリから探索
        const fs = require('fs') as typeof import('fs');
        const pathModule = require('path') as typeof import('path');
        const baseDirs = this.guessBaseDirs();

        for (const baseDir of baseDirs) {
            const candidate = pathModule.join(baseDir, workspaceName);
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                    this.workspaceStore.learn(workspaceName, candidate);
                    logDebug(`CdpPool: learned folder path for "${workspaceName}": "${candidate}"`);
                    return;
                }
            } catch { /* ignore */ }
        }

        logDebug(`CdpPool: could not determine folder path for "${workspaceName}" — will retry on next connection`);
    }

    /**
     * ワークスペースフォルダの親ディレクトリ候補を推定する。
     */
    private guessBaseDirs(): string[] {
        const pathModule = require('path') as typeof import('path');
        const dirs: string[] = [];

        const userProfile = process.env.USERPROFILE || process.env.HOME;
        if (userProfile) {
            // ホームの親ディレクトリ（例: C:\Users）を追加
            // → ワークスペース名がユーザー名と一致する場合（ホームディレクトリ）を検知
            const parentDir = pathModule.dirname(userProfile);
            if (parentDir && parentDir !== userProfile) {
                dirs.push(parentDir);
            }
            // ホームディレクトリ自体（例: C:\Users\ysk41）を追加
            // → ホーム直下のサブフォルダを検知
            dirs.push(userProfile);
            // よくある開発ディレクトリ
            dirs.push(pathModule.join(userProfile, 'dev'));
            dirs.push(pathModule.join(userProfile, 'projects'));
            dirs.push(pathModule.join(userProfile, 'workspace'));
            dirs.push(pathModule.join(userProfile, 'repos'));
            dirs.push(pathModule.join(userProfile, 'src'));
        }

        return dirs;
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

        // エイリアス対策: 同一 PoolEntry を参照する全キーを収集して一括削除
        const allKeysToDelete = new Set<string>();
        const disconnected = new Set<PoolEntry>();

        for (const key of toRelease) {
            const entry = this.pool.get(key);
            if (entry && !disconnected.has(entry)) {
                logDebug(`CdpPool: releasing idle workspace "${key}" (idle ${Math.round((now - entry.lastUsedAt) / 1000)}s)`);
                entry.cdp.fullDisconnect();
                disconnected.add(entry);
            }
        }

        // 同一エントリを参照する全キーを削除（エイリアスも含む）
        for (const entry of disconnected) {
            for (const [k, v] of this.pool.entries()) {
                if (v === entry) {
                    allKeysToDelete.add(k);
                }
            }
        }
        for (const k of allKeysToDelete) {
            this.pool.delete(k);
        }

        if (allKeysToDelete.size > 0) {
            logDebug(`CdpPool: released ${allKeysToDelete.size} key(s) (${disconnected.size} connection(s)), pool size = ${this.pool.size}`);
        }
    }

    /**
     * 全接続を切断してプールをクリアする。
     */
    disconnectAll(): void {
        for (const [key, entry] of this.pool.entries()) {
            logDebug(`CdpPool: disconnecting workspace "${key}"`);
            entry.cdp.fullDisconnect();
        }
        this.pool.clear();
        this.acquireLocks.clear();
        logDebug('CdpPool: all connections disconnected, pool cleared');
    }

    /**
     * プール内のワークスペース一覧を取得する。
     */
    getWorkspaceNames(): string[] {
        return Array.from(this.pool.keys());
    }

    /**
     * ワークスペース名 → フォルダパスの解決済みマッピングを取得する。
     * WorkspaceStore（自動学習）+ settings.json（手動設定）をマージして返す。
     */
    getResolvedWorkspacePaths(): Record<string, string> {
        return resolveWorkspacePaths(this.workspaceStore);
    }

    /**
     * プールサイズを取得する。
     */
    get size(): number {
        return this.pool.size;
    }
}
