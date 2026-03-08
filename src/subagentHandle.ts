// ---------------------------------------------------------------------------
// subagentHandle.ts — サブエージェントのライフサイクル管理
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §5
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

/** execSync の非同期版。メインスレッドをブロックしない */
const execAsync = promisify(exec);
import { logDebug, logWarn, logError } from './logger';
import {
    SubagentState,
    SubagentPrompt,
    SubagentResponse,
    SubagentConfig,
    SubagentInfo,
    DEFAULT_SUBAGENT_CONFIG,
    WorktreePoolEntry,
} from './subagentTypes';
import { writePrompt, watchResponse } from './subagentIpc';
import { CdpBridge } from './cdpBridge';
import { DiscoveredInstance, discoverInstances, extractWorkspaceName } from './cdpTargets';

/** worktree のライフサイクル状態 */
export type WorktreeLifecycleState = 'none' | 'created' | 'in_use' | 'cleaning' | 'cleaned';

/**
 * 単一のサブエージェントを管理するハンドル。
 * worktree の作成・ウィンドウの起動・プロンプト送信・レスポンス受信・終了を担当。
 */
export class SubagentHandle {
    public readonly name: string;
    public readonly branch: string;
    public readonly worktreePath: string;
    public readonly createdAt: number;
    public currentTask?: string;
    /** プールエントリのインデックス（プール使用時のみ） */
    public poolEntryIndex?: number;
    /** worktree のライフサイクル状態 */
    public worktreeState: WorktreeLifecycleState = 'none';

    private _state: SubagentState = 'IDLE';
    private config: SubagentConfig;
    private ipcDir: string;
    private cdpBridge: CdpBridge;
    private repoRoot: string;
    /** プール使用時: worktree 作成・削除をスキップするフラグ */
    private usePool: boolean;
    /** repoRoot の公開 getter */
    public getRepoRoot(): string { return this.repoRoot; }

    constructor(
        name: string,
        repoRoot: string,
        ipcDir: string,
        cdpBridge: CdpBridge,
        config: Partial<SubagentConfig> = {},
        poolEntry?: WorktreePoolEntry,
    ) {
        this.name = name;
        this.usePool = !!poolEntry;
        if (poolEntry) {
            // プールから取得した worktree を使用
            this.worktreePath = poolEntry.path;
            this.branch = `team/subagent/${name}`;
            this.poolEntryIndex = poolEntry.index;
        } else {
            // 従来通り: 新規 worktree を作成
            this.worktreePath = path.join(repoRoot, '.anticrow', 'worktrees', name);
            this.branch = `team/subagent/${name}`;
        }
        this.createdAt = Date.now();
        this.config = { ...DEFAULT_SUBAGENT_CONFIG, ...config };
        this.ipcDir = ipcDir;
        this.cdpBridge = cdpBridge;
        this.repoRoot = repoRoot;
    }

    /** 現在の状態 */
    get state(): SubagentState {
        return this._state;
    }

    /** 外部公開用の情報 */
    get info(): SubagentInfo {
        return {
            name: this.name,
            branch: this.branch,
            worktreePath: this.worktreePath,
            state: this._state,
            createdAt: this.createdAt,
            currentTask: this.currentTask,
        };
    }

    // -----------------------------------------------------------------------
    // ライフサイクル
    // -----------------------------------------------------------------------

    /**
     * サブエージェントを起動する。
     * 1. git worktree add + ブランチ作成
     * 2. Antigravity ウィンドウを新規起動
     * 3. CDP でターゲット出現を待つ
     */
    async spawn(): Promise<void> {
        if (this._state !== 'IDLE') {
            throw new Error(`spawn() は IDLE 状態でのみ呼び出し可能（現在: ${this._state}）`);
        }

        // --- CREATING: worktree + ブランチ作成 ---
        this._state = 'CREATING';
        this.setWorktreeState('created');
        logDebug(`[SubagentHandle] ${this.name}: CREATING (pool=${this.usePool})`);

        if (this.usePool) {
            // プール使用時: worktree は既に存在するのでブランチ作成のみ
            try {
                // プール worktree 内で新しいブランチを作成してチェックアウト
                try {
                    await execAsync(`git checkout -b ${this.branch}`, {
                        cwd: this.worktreePath,
                    });
                } catch {
                    // ブランチが既に存在する場合はチェックアウトのみ
                    await execAsync(`git checkout ${this.branch}`, {
                        cwd: this.worktreePath,
                    });
                }
                logDebug(`[SubagentHandle] プール worktree でブランチ切替: ${this.branch}`);
            } catch (err) {
                logError(`[SubagentHandle] プール worktree ブランチ切替失敗: ${err}`);
                this._state = 'FAILED';
                throw err;
            }
        } else {
            // 従来通り: worktree + ブランチ作成
            try {
                // コミット存在チェック: HEAD が存在しないと git worktree add が失敗する
                try {
                    await execAsync('git rev-parse HEAD', { cwd: this.repoRoot });
                } catch {
                    this._state = 'FAILED';
                    throw new Error(
                        `リポジトリにコミットがありません。チームモードを使用するには、最低1つのコミットが必要です。` +
                        `先に \`git init && git add -A && git commit -m "initial commit"\` を実行してください。` +
                        `(repoRoot: ${this.repoRoot})`,
                    );
                }

                // .anticrow/worktrees ディレクトリが存在しない場合は作成
                const worktreeDir = path.dirname(this.worktreePath);
                if (!fs.existsSync(worktreeDir)) {
                    fs.mkdirSync(worktreeDir, { recursive: true });
                    logDebug(`[SubagentHandle] worktree ディレクトリ作成: ${worktreeDir}`);
                }

                // git worktree add -b で一括作成（ブランチ作成 + worktree 追加を原子的に実行）
                // 従来の2段階方式（git branch → git worktree add）は、git branch が
                // 黙って失敗するとブランチなしで worktree add を実行してしまう問題があった
                try {
                    await execAsync(`git worktree add -b ${this.branch} "${this.worktreePath}" HEAD`, {
                        cwd: this.repoRoot,
                    });
                    logDebug(`[SubagentHandle] worktree + ブランチ一括作成完了: ${this.worktreePath}`);
                } catch (addErr) {
                    // ブランチが既に存在する場合は -b なしで再試行
                    const errMsg = String(addErr);
                    if (errMsg.includes('already exists')) {
                        logDebug(`[SubagentHandle] ブランチ ${this.branch} は既に存在 — worktree のみ作成`);
                        await execAsync(`git worktree add "${this.worktreePath}" ${this.branch}`, {
                            cwd: this.repoRoot,
                        });
                        logDebug(`[SubagentHandle] worktree 作成完了（既存ブランチ使用）: ${this.worktreePath}`);
                    } else {
                        throw addErr;
                    }
                }
            } catch (err) {
                logError(`[SubagentHandle] worktree 作成失敗: ${err}`);
                this._state = 'FAILED';
                throw err;
            }
        }

        // --- LAUNCHING: Antigravity ウィンドウ起動（リトライ付き） ---
        this._state = 'LAUNCHING';
        logDebug(`[SubagentHandle] ${this.name}: LAUNCHING`);

        const maxRetries = this.config.spawnMaxRetries;
        let launched = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.cdpBridge.launchAntigravity(this.worktreePath, { skipCooldown: true });
            } catch (err) {
                logError(`[SubagentHandle] ウィンドウ起動失敗 (attempt ${attempt}/${maxRetries}): ${err}`);
                if (attempt === maxRetries) {
                    this._state = 'FAILED';
                    await this.cleanupWorktree();
                    throw err;
                }
                // リトライ前に少し待つ
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            // --- READY 待ち ---
            const ready = await this.waitForReady();
            if (ready) {
                launched = true;
                break;
            }

            logWarn(`[SubagentHandle] attempt ${attempt}/${maxRetries} failed (READY timeout), retrying...`);

            if (attempt < maxRetries) {
                // 次のリトライ前に少し待つ
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!launched) {
            logError(`[SubagentHandle] READY タイムアウト: ${this.name} (全 ${maxRetries} 回のリトライ失敗)`);
            this._state = 'FAILED';
            await this.cleanupWorktree();
            throw new Error(`サブエージェント "${this.name}" の起動が ${maxRetries} 回のリトライ後もタイムアウトしました`);
        }

        this._state = 'READY';
        logDebug(`[SubagentHandle] ${this.name}: READY`);

        // ウィンドウを最小化（ベストエフォート）
        try {
            const minimized = await this.cdpBridge.minimizeWindow(this.name);
            if (minimized) {
                logDebug(`[SubagentHandle] ${this.name}: ウィンドウを最小化しました`);
            } else {
                logWarn(`[SubagentHandle] ${this.name}: ウィンドウの最小化に失敗（ベストエフォート）`);
            }
        } catch (err) {
            logWarn(`[SubagentHandle] ${this.name}: ウィンドウ最小化中にエラー: ${err}`);
        }
    }

    /**
     * サブエージェントにプロンプトを送信し、応答を待つ。
     */
    async sendPrompt(prompt: string): Promise<SubagentResponse> {
        if (this._state !== 'READY') {
            throw new Error(`sendPrompt() は READY 状態でのみ呼び出し可能（現在: ${this._state}）`);
        }

        this._state = 'BUSY';
        this.currentTask = prompt;
        logDebug(`[SubagentHandle] ${this.name}: BUSY`);

        const timestamp = Date.now();
        const callbackPath = path.join(
            this.ipcDir,
            `subagent_${this.name}_response_${timestamp}.json`,
        );

        // プロンプトファイル書き込み
        const promptData: SubagentPrompt = {
            type: 'subagent_prompt',
            from: extractWorkspaceName(
                this.cdpBridge.getActiveTargetTitle() ?? 'anti-crow',
            ),
            to: this.name,
            timestamp,
            prompt,
            timeout_ms: this.config.promptTimeoutMs,
            callback_path: callbackPath,
        };

        const promptFile = writePrompt(this.ipcDir, promptData);
        logDebug(`[SubagentHandle] sendPrompt: IPC ファイル書き込み完了: ${path.basename(promptFile)}, callbackPath=${path.basename(callbackPath)}`);
        logDebug(`[SubagentHandle] sendPrompt: promptData.to="${promptData.to}", promptData.from="${promptData.from}", prompt(100chars)="${prompt.substring(0, 100)}"`);
        logDebug(`[SubagentHandle] sendPrompt: watchResponse 開始 (timeout=${this.config.promptTimeoutMs}ms, poll=${this.config.pollIntervalMs}ms)`);

        // レスポンス待ち
        const response = await watchResponse(
            callbackPath,
            this.config.promptTimeoutMs,
            this.config.pollIntervalMs,
        );

        if (response) {
            this._state = 'COMPLETED';
            this.currentTask = undefined;
            logDebug(`[SubagentHandle] ${this.name}: COMPLETED (${response.execution_time_ms}ms)`);
            return response;
        }

        // タイムアウト
        this._state = 'COMPLETED';
        this.currentTask = undefined;
        const timeoutResponse: SubagentResponse = {
            type: 'subagent_response',
            from: this.name,
            timestamp: Date.now(),
            status: 'timeout',
            result: '',
            execution_time_ms: this.config.promptTimeoutMs,
            error: `タイムアウト (${this.config.promptTimeoutMs}ms)`,
        };
        logWarn(`[SubagentHandle] ${this.name}: タイムアウト`);
        return timeoutResponse;
    }

    /**
     * サブエージェントをシャットダウンし、リソースをクリーンアップする。
     */
    async close(): Promise<void> {
        if (this._state === 'CLEANED' || this._state === 'IDLE') return;

        // --- CLOSING ---
        this._state = 'CLOSING';
        logDebug(`[SubagentHandle] ${this.name}: CLOSING`);

        // ウィンドウを閉じる
        try {
            await this.cdpBridge.closeWindow(this.name);
        } catch (err) {
            logWarn(`[SubagentHandle] closeWindow 失敗: ${err}`);
        }

        // プロセスが worktree ディレクトリのロックを解放するまで待機
        // closeWindow() は非同期で、プロセス終了に時間がかかる
        await this.waitForWorktreeUnlock();

        // --- マージ: worktree 削除前にサブエージェントの変更をメインブランチへ ---
        await this.mergeChanges();

        // --- CLEANED ---
        if (this.usePool) {
            // プール使用時: ブランチのみ削除。worktree フォルダは次回再利用のため残す
            try {
                await execAsync(`git branch -D ${this.branch}`, {
                    cwd: this.repoRoot,
                });
                logDebug(`[SubagentHandle] プール使用: ブランチ削除: ${this.branch}`);
            } catch {
                logDebug(`[SubagentHandle] ブランチ削除スキップ（存在しない可能性）: ${this.branch}`);
            }
            // cleanupWorktree() は呼ばない（フォルダを残して再利用するため）
            logDebug(`[SubagentHandle] プール使用: worktree フォルダは再利用のため残します: ${this.worktreePath}`);
        } else {
            await this.cleanupWorktree();
        }
        this._state = 'CLEANED';
        logDebug(`[SubagentHandle] ${this.name}: CLEANED (pool=${this.usePool})`);
    }

    // -----------------------------------------------------------------------
    // 内部ヘルパー
    // -----------------------------------------------------------------------

    /**
     * CDP でターゲットの出現を待つ。
     * worktree フォルダ名 or サブエージェント名でマッチングする。
     */
    private async waitForReady(): Promise<boolean> {
        const start = Date.now();
        const ports = this.cdpBridge.getPorts();
        const worktreeBase = path.basename(this.worktreePath);
        let pollCount = 0;

        logDebug(`[SubagentHandle] waitForReady: name=${this.name}, worktreeBase=${worktreeBase}, worktreePath=${this.worktreePath}, ports=[${ports}], timeout=${this.config.launchTimeoutMs}ms`);

        while (Date.now() - start < this.config.launchTimeoutMs) {
            pollCount++;
            try {
                const instances = await discoverInstances(ports);
                const elapsed = Date.now() - start;
                // 毎回ログ出力（デバッグ中）
                const names = instances.map(i => {
                    const ws = extractWorkspaceName(i.title);
                    return `{ws="${ws}", title="${i.title.substring(0, 80)}", port=${i.port}}`;
                }).join(', ');
                logDebug(`[SubagentHandle] waitForReady poll#${pollCount} (${elapsed}ms): found ${instances.length} instances: [${names}]`);

                const found = instances.find(
                    (i) => this.matchesSubagent(i),
                );
                if (found) {
                    logDebug(`[SubagentHandle] waitForReady: ✅ MATCHED target "${found.title}" (port=${found.port}) after ${pollCount} polls (${elapsed}ms)`);
                    return true;
                } else {
                    logDebug(`[SubagentHandle] waitForReady: ❌ no match in poll#${pollCount}`);
                }
            } catch (err) {
                logDebug(`[SubagentHandle] waitForReady poll#${pollCount}: network error: ${err}`);
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
        logWarn(`[SubagentHandle] waitForReady: timed out after ${this.config.launchTimeoutMs}ms (${pollCount} polls) for "${this.name}"`);
        return false;
    }

    /**
     * サブエージェントのブランチの変更をメインブランチにマージする。
     * close() 時に cleanupWorktree() の前に呼び出される。
     * コンフリクト発生時はマージを中断し、ログに記録する（変更は失われない）。
     */
    async mergeChanges(): Promise<{ merged: boolean; conflicted: boolean; error?: string }> {
        try {
            // メインブランチ（HEAD）とサブエージェントブランチの差分をチェック
            const { stdout: diffOutput_ } = await execAsync(
                `git log HEAD..${this.branch} --oneline`,
                { cwd: this.repoRoot },
            );
            const diffOutput = diffOutput_.trim();

            if (!diffOutput) {
                logDebug(`[SubagentHandle] ${this.name}: マージ不要（差分なし）`);
                return { merged: false, conflicted: false };
            }

            const commitCount = diffOutput.split('\n').filter(l => l.trim()).length;
            logDebug(`[SubagentHandle] ${this.name}: ${commitCount} 個のコミットをマージします`);

            // マージ実行
            try {
                await execAsync(`git merge ${this.branch} --no-edit`, {
                    cwd: this.repoRoot,
                });
                logDebug(`[SubagentHandle] ${this.name}: ✅ マージ成功 (${commitCount} commits)`);
                return { merged: true, conflicted: false };
            } catch (mergeErr) {
                // コンフリクト発生 → マージを中断
                logWarn(`[SubagentHandle] ${this.name}: ⚠️ マージコンフリクト発生。マージを中断します。`);
                logWarn(`[SubagentHandle] コンフリクト詳細: ${mergeErr}`);
                try {
                    await execAsync('git merge --abort', { cwd: this.repoRoot });
                } catch { /* ignore: merge --abort 自体は失敗しても問題ない */ }
                return { merged: false, conflicted: true, error: String(mergeErr) };
            }
        } catch (err) {
            // git log 自体が失敗した場合（ブランチが存在しない等）
            logDebug(`[SubagentHandle] ${this.name}: マージチェックをスキップ（ブランチが存在しない可能性）: ${err}`);
            return { merged: false, conflicted: false, error: String(err) };
        }
    }

    /**
     * closeWindow() 後にプロセスが worktree ディレクトリのロックを解放するまで待つ。
     * Windows ではプロセスがファイルハンドルを保持していると rmSync が EBUSY で失敗する。
     * 最大 5 秒（500ms × 10 回）ポーリングする。
     */
    private async waitForWorktreeUnlock(): Promise<void> {
        if (!fs.existsSync(this.worktreePath)) return;

        const maxAttempts = 10;
        const intervalMs = 500;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                // テストとして .git ファイルへの書き込みを試みる
                // ロックされていれば EBUSY/EPERM が発生する
                const testFile = path.join(this.worktreePath, '.wt_unlock_test');
                fs.writeFileSync(testFile, 'test', 'utf-8');
                fs.unlinkSync(testFile);
                logDebug(`[SubagentHandle] worktree ロック解放確認 (${i + 1}回目): OK`);
                return;
            } catch {
                if (i < maxAttempts - 1) {
                    await new Promise(r => setTimeout(r, intervalMs));
                }
            }
        }
        logWarn(`[SubagentHandle] worktree ロック解放待ちタイムアウト（${maxAttempts * intervalMs}ms）。削除を試行します。`);
    }

    /**
     * worktree とブランチのクリーンアップ。
     * マージ完了後に呼ばれ、物理ディレクトリを確実に削除する。
     */
    async cleanupWorktree(): Promise<void> {
        this.setWorktreeState('cleaning');
        // Step 1: git worktree remove --force で正規の削除を試みる
        try {
            await execAsync(`git worktree remove "${this.worktreePath}" --force`, {
                cwd: this.repoRoot,
            });
            logDebug(`[SubagentHandle] worktree 削除完了: ${this.worktreePath}`);
        } catch (err) {
            logWarn(`[SubagentHandle] git worktree remove 失敗（フォールバック実行）: ${err}`);

            // Step 2: git worktree prune でゴミ参照を掃除
            try {
                await execAsync('git worktree prune', { cwd: this.repoRoot });
                logDebug(`[SubagentHandle] git worktree prune 実行完了`);
            } catch { /* ignore */ }

            // Step 3: .git/worktrees 内のロックファイルを削除（ロックが残ると再削除できない）
            try {
                const gitWorktreesDir = path.join(this.repoRoot, '.git', 'worktrees');
                const wtBaseName = path.basename(this.worktreePath);
                const lockFile = path.join(gitWorktreesDir, wtBaseName, 'locked');
                if (fs.existsSync(lockFile)) {
                    fs.unlinkSync(lockFile);
                    logDebug(`[SubagentHandle] ロックファイル削除: ${lockFile}`);
                    // ロック解除後に再度 git worktree remove を試みる
                    try {
                        await execAsync(`git worktree remove "${this.worktreePath}" --force`, {
                            cwd: this.repoRoot,
                        });
                        logDebug(`[SubagentHandle] ロック解除後の worktree 削除成功`);
                    } catch {
                        // それでも失敗したら物理削除にフォールバック
                    }
                }
            } catch (lockErr) {
                logDebug(`[SubagentHandle] ロックファイル処理スキップ: ${lockErr}`);
            }

            // Step 4: 物理ディレクトリが残っている場合はリトライ付き強制削除
            // プロセスがまだロックを保持している可能性があるため、リトライする
            for (let retry = 0; retry < 3; retry++) {
                try {
                    if (!fs.existsSync(this.worktreePath)) break;
                    fs.rmSync(this.worktreePath, { recursive: true, force: true });
                    logDebug(`[SubagentHandle] worktree ディレクトリ強制削除 (試行${retry + 1}): ${this.worktreePath}`);
                    break;
                } catch (rmErr) {
                    if (retry < 2) {
                        logDebug(`[SubagentHandle] worktree 削除リトライ (${retry + 1}/3): ${rmErr}`);
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        logWarn(`[SubagentHandle] worktree ディレクトリ強制削除失敗 (全リトライ失敗): ${rmErr}`);
                    }
                }
            }

            // Step 5: 最終 prune で git 内部参照を完全にクリーンアップ
            try {
                await execAsync('git worktree prune', { cwd: this.repoRoot });
            } catch { /* ignore */ }
        }

        // 物理ディレクトリが残っていないか最終確認（リトライ付き）
        for (let retry = 0; retry < 3; retry++) {
            if (!fs.existsSync(this.worktreePath)) break;
            logWarn(`[SubagentHandle] worktree ディレクトリがまだ残っています（最終強制削除 試行${retry + 1}）: ${this.worktreePath}`);
            try {
                fs.rmSync(this.worktreePath, { recursive: true, force: true });
            } catch (finalErr) {
                if (retry < 2) {
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    logWarn(`[SubagentHandle] 最終強制削除も全リトライ失敗: ${finalErr}`);
                }
            }
        }

        // ブランチ削除
        try {
            await execAsync(`git branch -D ${this.branch}`, {
                cwd: this.repoRoot,
            });
            logDebug(`[SubagentHandle] ブランチ削除完了: ${this.branch}`);
        } catch {
            // ブランチが存在しない場合は無視
        }
        this.setWorktreeState('cleaned');
    }

    /** worktree ライフサイクル状態を更新し、ログを出力する */
    private setWorktreeState(newState: WorktreeLifecycleState): void {
        const oldState = this.worktreeState;
        this.worktreeState = newState;
        logDebug(`[SubagentHandle] ${this.name}: worktreeState ${oldState} → ${newState}`);
    }

    /**
     * サブエージェントを再利用するために状態をリセットする。
     * ウィンドウは閉じず、_state を READY に戻して新しいプロンプトを受け付けられるようにする。
     * 必要に応じて startNewChat() でコンテキストをリセットする。
     */
    async resetForReuse(): Promise<void> {
        const validStates: SubagentState[] = ['COMPLETED', 'BUSY', 'READY'];
        if (!validStates.includes(this._state)) {
            throw new Error(`resetForReuse() は COMPLETED/BUSY/READY 状態でのみ呼び出し可能（現在: ${this._state}）`);
        }

        logDebug(`[SubagentHandle] ${this.name}: resetForReuse (from ${this._state})`);

        // コンテキストリセットはスキップ（ユーザーフィードバック: 不要）
        // 新しいプロンプトを送ればサブエージェントは新しいタスクとして処理する

        this._state = 'READY';
        this.currentTask = undefined;
        logDebug(`[SubagentHandle] ${this.name}: READY (reuse)`);
    }

    /**
     * サブエージェントのウィンドウがまだ存在するか確認する。
     */
    async isAlive(): Promise<boolean> {
        try {
            const ports = this.cdpBridge.getPorts();
            const instances = await discoverInstances(ports);
            return instances.some(
                (i) => this.matchesSubagent(i),
            );
        } catch {
            return false;
        }
    }

    /**
     * CDP で発見されたインスタンスがこのサブエージェントのものかを判定する。
     * ウィンドウタイトルから抽出したワークスペース名と、以下の候補を比較:
     *   1. サブエージェント名（例: "anti-crow-subagent-1"）
     *   2. worktree フォルダのベース名（例: "anti-crow-subagent-1"）
     * また、ウィンドウタイトルに worktree パスが直接含まれるケースにも対応。
     */
    private matchesSubagent(instance: DiscoveredInstance): boolean {
        const wsName = extractWorkspaceName(instance.title);
        const worktreeBase = path.basename(this.worktreePath);

        const checks = [
            { label: 'wsName===name', result: wsName === this.name },
            { label: 'wsName===worktreeBase', result: wsName === worktreeBase },
            { label: 'title.includes(worktreePath)', result: instance.title.includes(this.worktreePath) },
            { label: 'title.includes(worktreeBase)', result: instance.title.includes(worktreeBase) },
        ];

        const matched = checks.some(c => c.result);
        if (matched) {
            const matchedChecks = checks.filter(c => c.result).map(c => c.label).join(', ');
            logDebug(`[SubagentHandle] matchesSubagent: ✅ MATCH (${matchedChecks}) | wsName="${wsName}", name="${this.name}", worktreeBase="${worktreeBase}"`);
        }

        return matched;
    }
}
