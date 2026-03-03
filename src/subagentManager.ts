// ---------------------------------------------------------------------------
// subagentManager.ts — サブエージェントの並列管理
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §6, §7
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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
    async spawn(taskPrompt?: string, workspaceName?: string): Promise<SubagentHandle> {
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
     * 複数のサブエージェントをstagger（時間差）起動する。
     * 各起動の間に config.staggerDelayMs の間隔を空け、
     * OS のリソース競合やポート競合を回避する。
     *
     * @param tasks 各サブエージェントのタスク情報
     * @returns 起動されたサブエージェントハンドルの配列
     */
    async spawnMultiple(tasks: Array<{ prompt?: string; workspaceName?: string }>): Promise<SubagentHandle[]> {
        const handles: SubagentHandle[] = [];
        const staggerDelay = this.config.staggerDelayMs;

        logDebug(`[SubagentManager] spawnMultiple: ${tasks.length} 個のサブエージェントをstagger起動 (間隔: ${staggerDelay}ms)`);

        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            const handle = await this.spawn(task.prompt, task.workspaceName);
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

        // 残存 worktree ディレクトリの掃除
        // git worktree remove 失敗やプロセス強制終了で物理ディレクトリだけ残るケースを自動回復
        try {
            const worktreesDir = path.join(this.repoRoot, '.anticrow', 'worktrees');
            if (fs.existsSync(worktreesDir)) {
                // git worktree list で登録済み worktree パスを取得
                let registeredPaths: Set<string>;
                try {
                    const output = execSync('git worktree list --porcelain', {
                        cwd: this.repoRoot,
                        stdio: 'pipe',
                    }).toString();
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
                        execSync(`git branch -D team/subagent/${entry.name}`, {
                            cwd: this.repoRoot,
                            stdio: 'pipe',
                        });
                        logDebug(`[SubagentManager] 残存ブランチ削除: team/subagent/${entry.name}`);
                    } catch { /* ブランチが存在しない場合は無視 */ }
                }

                if (orphanCount > 0) {
                    // git worktree prune で git 側の参照も掃除
                    try {
                        execSync('git worktree prune', { cwd: this.repoRoot, stdio: 'pipe' });
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
        await this.killAll();
        logDebug('[SubagentManager] dispose 完了');
    }
}
