// ---------------------------------------------------------------------------
// subagentManager.ts — サブエージェントの並列管理
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §6, §7
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

/** execFile の非同期版。シェルを経由せずコマンドを直接実行（インジェクション対策） */
const execFileAsync = promisify(execFile);

/** git コマンドを安全に実行するヘルパー（シェルインジェクション対策） */
function gitExec(args: string[], opts: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, opts);
}
import { logDebug, logWarn, logError } from './logger';
import {
    SubagentConfig,
    SubagentInfo,
    SubagentResponse,
    DEFAULT_SUBAGENT_CONFIG,
    WorktreePoolEntry,
    WorktreeHealthState,
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
    private nextId = 1;
    /** worktree プール参照（設定時のみプールモード有効） */
    private worktreePool: WorktreePool | null = null;

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
    // Worktree プール連携
    // -----------------------------------------------------------------------

    /** worktree プールを設定する */
    setWorktreePool(pool: WorktreePool): void {
        this.worktreePool = pool;
        logDebug(`[SubagentManager] WorktreePool 設定完了`);
    }

    /** handle.close() 後にプールエントリを release するヘルパー */
    releasePoolEntry(handle: SubagentHandle): void {
        if (this.worktreePool && handle.poolEntryIndex !== undefined) {
            this.worktreePool.release(handle.poolEntryIndex);
            logDebug(`[SubagentManager] プールエントリ release: pool_${handle.poolEntryIndex}`);
        }
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
     * @returns サブエージェントハンドル
     */
    async spawn(taskPrompt?: string, workspaceName?: string, repoRootOverride?: string): Promise<SubagentHandle> {
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

        // ワークスペース名を決定（オーバーライド優先）
        const mainWsName = workspaceName ?? this.cdpBridge.getActiveWorkspaceName() ?? 'anti-crow';
        const name = `${mainWsName}-subagent-${this.nextId++}`;

        // repoRoot を決定（オーバーライド優先）
        const effectiveRepoRoot = repoRootOverride || this.repoRoot;

        // プール使用条件: プールが初期化済み かつ 対象 repoRoot がプールの repoRoot と一致する場合のみ
        // 異なるワークスペースの場合はプールをスキップし、対象リポに直接 worktree を作成する
        const usePool = this.worktreePool?.isInitialized &&
            path.resolve(effectiveRepoRoot) === path.resolve(this.repoRoot);
        if (!usePool && repoRootOverride) {
            logDebug(`[SubagentManager] 異なるワークスペースのためプールをスキップ: pool=${this.repoRoot} → target=${effectiveRepoRoot}`);
        }

        logDebug(`[SubagentManager] サブエージェント "${name}" を起動中... (repoRoot=${effectiveRepoRoot}, usePool=${!!usePool})`);

        const handle = new SubagentHandle(
            name,
            effectiveRepoRoot,
            this.ipcDir,
            this.cdpBridge,
            this.config,
            usePool ? await this.worktreePool!.acquire(name) : undefined,
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
            return all.filter((info) => info.name.startsWith(`${workspaceName}-`));
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
        this.releasePoolEntry(handle);
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
                handle.close().then(() => {
                    this.releasePoolEntry(handle);
                }).catch((err) => {
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
                this.releasePoolEntry(idle.handle);
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
                        this.releasePoolEntry(idle.handle);
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
                    this.releasePoolEntry(handle);
                } catch {
                    // close 失敗は無視
                }
                this.agents.delete(name);
            }
        }

        if (staleNames.length > 0) {
            logDebug(`[SubagentManager] ${staleNames.length} 個の stale エージェントをクリーンアップしました: ${staleNames.join(', ')}`);
        }

        // 残存 worktree ディレクトリの掃除
        // git worktree remove 失敗やプロセス強制終了で物理ディレクトリだけ残るケースを自動回復
        try {
            const worktreesDir = path.join(this.repoRoot, '.anticrow', 'worktrees');
            if (fs.existsSync(worktreesDir)) {
                // git worktree list で登録済み worktree パスを取得
                let registeredPaths: Set<string>;
                try {
                    const { stdout: output } = await gitExec(['worktree', 'list', '--porcelain'], {
                        cwd: this.repoRoot,
                    });
                    registeredPaths = new Set(
                        output.split('\n')
                            .filter((line: string) => line.startsWith('worktree '))
                            .map((line: string) => line.replace('worktree ', '').trim()),
                    );
                } catch {
                    registeredPaths = new Set();
                }

                // 現在アクティブなエージェントの worktree パスを取得
                const activeWorktrees = new Set(
                    Array.from(this.agents.values()).map(h => h.worktreePath),
                );

                const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
                let orphanCount = 0;
                for (const entry of entries) {
                    if (!entry.isDirectory()) { continue; }
                    const dirPath = path.join(worktreesDir, entry.name);

                    // アクティブなエージェントの worktree はスキップ
                    if (activeWorktrees.has(dirPath)) { continue; }

                    // git worktree list に登録済みの場合もスキップ
                    if (registeredPaths.has(dirPath)) { continue; }

                    // 孤児ディレクトリ → 削除
                    try {
                        fs.rmSync(dirPath, { recursive: true, force: true });
                        orphanCount++;
                        logDebug(`[SubagentManager] 残存 worktree ディレクトリ削除: ${entry.name}`);
                    } catch (rmErr) {
                        logWarn(`[SubagentManager] 残存 worktree ディレクトリ削除失敗: ${entry.name}: ${rmErr}`);
                    }

                    // 対応するブランチも削除
                    try {
                        await gitExec(['branch', '-D', `team/subagent/${entry.name}`], {
                            cwd: this.repoRoot,
                        });
                        logDebug(`[SubagentManager] 残存ブランチ削除: team/subagent/${entry.name}`);
                    } catch { /* ブランチが存在しない場合は無視 */ }
                }

                if (orphanCount > 0) {
                    // git worktree prune で git 側の参照も掃除
                    try {
                        await gitExec(['worktree', 'prune'], { cwd: this.repoRoot });
                    } catch { /* ignore */ }
                    logDebug(`[SubagentManager] ${orphanCount} 個の残存 worktree ディレクトリを削除しました`);
                }
            }
        } catch (cleanupErr) {
            logWarn(`[SubagentManager] 残存 worktree ディレクトリの掃除中にエラー: ${cleanupErr}`);
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

// ---------------------------------------------------------------------------
// WorktreePool — worktree の再利用プール
// ---------------------------------------------------------------------------

/**
 * git worktree を事前作成してプール管理するクラス。
 * acquire() で空き worktree を取得し、release() でリセットして返却する。
 */
export class WorktreePool {
    private entries: WorktreePoolEntry[] = [];
    private repoRoot: string;
    private poolDir: string;
    private initialized = false;
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;
        this.poolDir = path.join(repoRoot, '.anticrow', 'worktrees');
    }

    /** プールが初期化済みかどうか */
    get isInitialized(): boolean {
        return this.initialized;
    }

    /** プール内のエントリ一覧 */
    get pool(): ReadonlyArray<WorktreePoolEntry> {
        return this.entries;
    }

    /**
     * プールを初期化する。指定数の worktree を事前作成。
     * 既に存在する worktree は再利用する。
     */
    async initialize(size: number): Promise<void> {
        if (this.initialized) {
            logDebug(`[WorktreePool] 既に初期化済み（${this.entries.length} entries）`);
            return;
        }

        // コミット存在チェック: HEAD が存在しないと git worktree / git branch が失敗する
        try {
            await gitExec(['rev-parse', 'HEAD'], { cwd: this.repoRoot });
        } catch {
            throw new Error(
                `リポジトリにコミットがありません。チームモードを使用するには、最低1つのコミットが必要です。` +
                `先に \`git init && git add -A && git commit -m "initial commit"\` を実行してください。` +
                `(repoRoot: ${this.repoRoot})`,
            );
        }

        // poolDir が存在しない場合は作成
        if (!fs.existsSync(this.poolDir)) {
            fs.mkdirSync(this.poolDir, { recursive: true });
        }

        for (let i = 0; i < size; i++) {
            const entryPath = path.join(this.poolDir, `pool_${i}`);
            const branchName = `team/pool/pool_${i}`;

            if (fs.existsSync(entryPath)) {
                // 既存 worktree を再利用
                logDebug(`[WorktreePool] 既存 worktree 再利用: pool_${i}`);
                try {
                    await this.resetWorktree(entryPath, branchName);
                } catch (err) {
                    logWarn(`[WorktreePool] 既存 worktree のリセット失敗（再作成します）: ${err}`);
                    await this.removeWorktreeForced(entryPath, branchName);
                    await this.createWorktree(entryPath, branchName);
                }
                // 再利用時も Source Control から非表示にする
                this.hideFromSourceControl(entryPath);
            } else {
                // 新規作成
                await this.createWorktree(entryPath, branchName);
            }

            this.entries.push({
                index: i,
                path: entryPath,
                state: 'available',
                health: 'healthy',
            });
        }

        this.initialized = true;
        logDebug(`[WorktreePool] 初期化完了: ${this.entries.length} worktrees`);
    }

    /**
     * 空き worktree を取得する（LRU 順: lastUsedAt が古いものを優先）。
     * health === 'healthy' のエントリのみ返す。
     * @param agentName 使用するサブエージェント名
     * @returns WorktreePoolEntry（空きがない場合は自動拡張）
     */
    async acquire(agentName: string): Promise<WorktreePoolEntry> {
        // 空きエントリを LRU 順で検索（healthy のみ）
        const availableEntries = this.entries
            .filter(e => e.state === 'available' && e.health === 'healthy')
            .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));

        let entry = availableEntries[0];

        if (!entry) {
            // 空きがない場合は自動拡張
            const newIndex = this.entries.length;
            const entryPath = path.join(this.poolDir, `pool_${newIndex}`);
            const branchName = `team/pool/pool_${newIndex}`;
            await this.createWorktree(entryPath, branchName);
            entry = {
                index: newIndex,
                path: entryPath,
                state: 'available',
                health: 'healthy',
            };
            this.entries.push(entry);
            logDebug(`[WorktreePool] プール自動拡張: pool_${newIndex}`);
        }

        entry.state = 'in-use';
        entry.usedBy = agentName;
        entry.lastUsedAt = Date.now();
        logDebug(`[WorktreePool] acquire: pool_${entry.index} → ${agentName}`);
        return entry;
    }

    /**
     * worktree をリセットしてプールに返却する。
     * @param entryIndex 返却するエントリのインデックス
     */
    async release(entryIndex: number): Promise<void> {
        const entry = this.entries.find(e => e.index === entryIndex);
        if (!entry) {
            logWarn(`[WorktreePool] release: インデックス ${entryIndex} が見つかりません`);
            return;
        }

        const branchName = `team/pool/pool_${entry.index}`;

        try {
            await this.resetWorktree(entry.path, branchName);
            entry.state = 'available';
            entry.health = 'healthy';
            entry.usedBy = undefined;
            entry.lastUsedAt = Date.now();
            logDebug(`[WorktreePool] release: pool_${entry.index} → available`);
        } catch (err) {
            logWarn(`[WorktreePool] release リセット失敗: pool_${entry.index}: ${err}`);
            // リセット失敗時は worktree を再作成
            try {
                await this.removeWorktreeForced(entry.path, branchName);
                await this.createWorktree(entry.path, branchName);
                entry.state = 'available';
                entry.health = 'healthy';
                entry.usedBy = undefined;
                entry.lastUsedAt = Date.now();
            } catch (recreateErr) {
                logError(`[WorktreePool] worktree 再作成も失敗: pool_${entry.index}: ${recreateErr}`);
                entry.health = 'broken';
            }
        }
    }

    /**
     * 全 worktree を削除してプールを破棄する。
     */
    async dispose(): Promise<void> {
        this.stopHealthCheck();
        for (const entry of this.entries) {
            const branchName = `team/pool/pool_${entry.index}`;
            await this.removeWorktreeForced(entry.path, branchName);
        }
        this.entries = [];
        this.initialized = false;
        logDebug('[WorktreePool] dispose 完了');
    }

    // -----------------------------------------------------------------------
    // ヘルスチェック
    // -----------------------------------------------------------------------

    /**
     * 全 worktree エントリのヘルスチェックを実行する。
     * - git lock ファイルの残留チェック → 自動削除
     * - dirty state チェック → 自動修復
     * - 修復不能 → broken にして再作成
     */
    async worktreeHealthCheck(): Promise<void> {
        for (const entry of this.entries) {
            // in-use のエントリはスキップ
            if (entry.state === 'in-use') { continue; }

            const branchName = `team/pool/pool_${entry.index}`;

            try {
                // 1. git lock ファイルの残留チェック
                const lockFile = path.join(entry.path, '.git', 'index.lock');
                if (fs.existsSync(lockFile)) {
                    logWarn(`[WorktreePool] git lock ファイル検出: pool_${entry.index} → 削除`);
                    fs.unlinkSync(lockFile);
                    entry.health = 'degraded';
                }

                // 2. dirty state チェック
                try {
                    const { stdout: status } = await gitExec(['status', '--porcelain'], {
                        cwd: entry.path,
                    });
                    if (status.trim()) {
                        logWarn(`[WorktreePool] dirty state 検出: pool_${entry.index} → 自動修復`);
                        await this.resetWorktree(entry.path, branchName);
                        entry.health = 'healthy';
                        logDebug(`[WorktreePool] pool_${entry.index}: 自動修復完了`);
                    } else if (entry.health === 'degraded') {
                        // lock 削除後にクリーンなら healthy に回復
                        entry.health = 'healthy';
                        logDebug(`[WorktreePool] pool_${entry.index}: healthy に回復`);
                    }
                } catch (statusErr) {
                    // git status 自体が失敗 → broken
                    logError(`[WorktreePool] git status 失敗: pool_${entry.index}: ${statusErr}`);
                    entry.health = 'broken';
                }

                // 3. broken エントリの再作成
                if (entry.health === 'broken') {
                    logWarn(`[WorktreePool] broken エントリ再作成: pool_${entry.index}`);
                    try {
                        await this.removeWorktreeForced(entry.path, branchName);
                        await this.createWorktree(entry.path, branchName);
                        entry.health = 'healthy';
                        entry.state = 'available';
                        logDebug(`[WorktreePool] pool_${entry.index}: 再作成完了 → healthy`);
                    } catch (recreateErr) {
                        logError(`[WorktreePool] pool_${entry.index} 再作成失敗: ${recreateErr}`);
                    }
                }
            } catch (err) {
                logWarn(`[WorktreePool] ヘルスチェックエラー: pool_${entry.index}: ${err}`);
            }
        }
    }

    /**
     * 定期ヘルスチェックを開始する（60秒間隔）。
     */
    startHealthCheck(): void {
        if (this.healthCheckTimer) { return; }

        const intervalMs = 60_000;
        this.healthCheckTimer = setInterval(async () => {
            try {
                await this.worktreeHealthCheck();
            } catch (err) {
                logWarn(`[WorktreePool] 定期ヘルスチェックエラー: ${err}`);
            }
        }, intervalMs);

        logDebug(`[WorktreePool] 定期ヘルスチェック開始 (${intervalMs}ms 間隔)`);
    }

    /**
     * 定期ヘルスチェックを停止する。
     */
    stopHealthCheck(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
            logDebug('[WorktreePool] 定期ヘルスチェック停止');
        }
    }

    // -----------------------------------------------------------------------
    // 内部ヘルパー
    // -----------------------------------------------------------------------

    /** worktree を新規作成 */
    private async createWorktree(wtPath: string, branchName: string): Promise<void> {
        // ブランチ作成（存在する場合は無視）
        try {
            await gitExec(['branch', branchName], { cwd: this.repoRoot });
        } catch { /* 既存ブランチ */ }

        await gitExec(['worktree', 'add', wtPath, branchName], {
            cwd: this.repoRoot,
        });

        // worktree を lock して Git 管理画面に影響しないようにする
        try {
            await gitExec(['worktree', 'lock', wtPath, '--reason', 'anti-crow pool worktree'], {
                cwd: this.repoRoot,
            });
            logDebug(`[WorktreePool] worktree lock 完了: ${wtPath}`);
        } catch {
            logDebug(`[WorktreePool] worktree lock スキップ: ${wtPath}`);
        }

        // Source Control パネルからこの worktree リポジトリを非表示にする
        this.hideFromSourceControl(wtPath);

        logDebug(`[WorktreePool] worktree 作成: ${wtPath}`);
    }

    /** worktree をリセット（作業内容をクリーン） */
    private async resetWorktree(wtPath: string, _branchName: string): Promise<void> {
        // メインブランチの内容にリセット
        await gitExec(['checkout', '--', '.'], { cwd: wtPath });
        await gitExec(['clean', '-fd'], { cwd: wtPath });
        logDebug(`[WorktreePool] worktree リセット: ${wtPath}`);
    }

    /** worktree を強制削除 */
    private async removeWorktreeForced(wtPath: string, branchName: string): Promise<void> {
        try {
            await gitExec(['worktree', 'remove', wtPath, '--force'], {
                cwd: this.repoRoot,
            });
        } catch {
            // git worktree remove 失敗時はディレクトリを直接削除
            if (fs.existsSync(wtPath)) {
                fs.rmSync(wtPath, { recursive: true, force: true });
            }
            try {
                await gitExec(['worktree', 'prune'], { cwd: this.repoRoot });
            } catch { /* ignore */ }
        }
        // ブランチも削除
        try {
            await gitExec(['branch', '-D', branchName], { cwd: this.repoRoot });
        } catch { /* ignore */ }
    }

    /**
     * VSCode の git.ignoredRepositories に worktree パスを追加して、
     * Source Control パネルに表示させないようにする。
     */
    private hideFromSourceControl(wtPath: string): void {
        try {
            const gitConfig = vscode.workspace.getConfiguration('git');
            const ignored: string[] = [...(gitConfig.get<string[]>('ignoredRepositories') ?? [])];
            const normalizedPath = wtPath.replace(/\\/g, '/');
            if (!ignored.includes(normalizedPath)) {
                ignored.push(normalizedPath);
                gitConfig.update('ignoredRepositories', ignored, vscode.ConfigurationTarget.Workspace);
                logDebug(`[WorktreePool] git.ignoredRepositories に追加: ${normalizedPath}`);
            }
        } catch (err) {
            logDebug(`[WorktreePool] git.ignoredRepositories 更新失敗: ${err}`);
        }
    }
}
