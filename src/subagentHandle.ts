// ---------------------------------------------------------------------------
// subagentHandle.ts — サブエージェントのライフサイクル管理
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §5
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logDebug, logWarn, logError } from './logger';
import {
    SubagentState,
    SubagentPrompt,
    SubagentResponse,
    SubagentConfig,
    SubagentInfo,
    DEFAULT_SUBAGENT_CONFIG,
} from './subagentTypes';
import { writePrompt, watchResponse } from './subagentIpc';
import { CdpBridge } from './cdpBridge';
import { DiscoveredInstance, discoverInstances, extractWorkspaceName } from './cdpTargets';

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

    private _state: SubagentState = 'IDLE';
    private config: SubagentConfig;
    private ipcDir: string;
    private cdpBridge: CdpBridge;
    private repoRoot: string;

    constructor(
        name: string,
        repoRoot: string,
        ipcDir: string,
        cdpBridge: CdpBridge,
        config: Partial<SubagentConfig> = {},
    ) {
        this.name = name;
        this.branch = `team/subagent/${name}`;
        this.worktreePath = path.join(repoRoot, '.anticrow', 'worktrees', name);
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
        logDebug(`[SubagentHandle] ${this.name}: CREATING`);

        try {
            // .anticrow/worktrees ディレクトリが存在しない場合は作成
            const worktreeDir = path.dirname(this.worktreePath);
            if (!fs.existsSync(worktreeDir)) {
                fs.mkdirSync(worktreeDir, { recursive: true });
                logDebug(`[SubagentHandle] worktree ディレクトリ作成: ${worktreeDir}`);
            }

            // ブランチがなければ作成
            try {
                execSync(`git branch ${this.branch}`, {
                    cwd: this.repoRoot,
                    stdio: 'pipe',
                });
            } catch {
                // ブランチが既に存在する場合は無視
                logDebug(`[SubagentHandle] ブランチ ${this.branch} は既に存在します`);
            }

            // worktree 作成
            execSync(`git worktree add "${this.worktreePath}" ${this.branch}`, {
                cwd: this.repoRoot,
                stdio: 'pipe',
            });
            logDebug(`[SubagentHandle] worktree 作成完了: ${this.worktreePath}`);
        } catch (err) {
            logError(`[SubagentHandle] worktree 作成失敗: ${err}`);
            this._state = 'FAILED';
            throw err;
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

        // --- CLEANED ---
        await this.cleanupWorktree();
        this._state = 'CLEANED';
        logDebug(`[SubagentHandle] ${this.name}: CLEANED`);
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
     * worktree とブランチのクリーンアップ。
     */
    private async cleanupWorktree(): Promise<void> {
        try {
            execSync(`git worktree remove "${this.worktreePath}" --force`, {
                cwd: this.repoRoot,
                stdio: 'pipe',
            });
            logDebug(`[SubagentHandle] worktree 削除完了: ${this.worktreePath}`);
        } catch (err) {
            logWarn(`[SubagentHandle] worktree 削除失敗: ${err}`);
            // git worktree prune でゴミを掃除
            try {
                execSync('git worktree prune', { cwd: this.repoRoot, stdio: 'pipe' });
            } catch { /* ignore */ }

            // 物理ディレクトリが残っている場合は強制削除
            try {
                if (fs.existsSync(this.worktreePath)) {
                    fs.rmSync(this.worktreePath, { recursive: true, force: true });
                    logDebug(`[SubagentHandle] worktree ディレクトリ強制削除: ${this.worktreePath}`);
                }
            } catch (rmErr) {
                logWarn(`[SubagentHandle] worktree ディレクトリ強制削除失敗: ${rmErr}`);
            }
        }

        // ブランチ削除
        try {
            execSync(`git branch -D ${this.branch}`, {
                cwd: this.repoRoot,
                stdio: 'pipe',
            });
            logDebug(`[SubagentHandle] ブランチ削除完了: ${this.branch}`);
        } catch {
            // ブランチが存在しない場合は無視
        }
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
