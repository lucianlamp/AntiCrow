// ---------------------------------------------------------------------------
// subagentHandle.ts — サブエージェントのライフサイクル管理
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §5
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
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
import { discoverInstances, extractWorkspaceName } from './cdpTargets';

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
        this.worktreePath = path.join(repoRoot, '.worktrees', name);
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

        // --- LAUNCHING: Antigravity ウィンドウ起動 ---
        this._state = 'LAUNCHING';
        logDebug(`[SubagentHandle] ${this.name}: LAUNCHING`);

        try {
            await this.cdpBridge.launchAntigravity(this.worktreePath);
        } catch (err) {
            logError(`[SubagentHandle] ウィンドウ起動失敗: ${err}`);
            this._state = 'FAILED';
            await this.cleanupWorktree();
            throw err;
        }

        // --- READY 待ち ---
        const ready = await this.waitForReady();
        if (!ready) {
            logError(`[SubagentHandle] READY タイムアウト: ${this.name}`);
            this._state = 'FAILED';
            await this.cleanupWorktree();
            throw new Error(`サブエージェント "${this.name}" の起動がタイムアウトしました`);
        }

        this._state = 'READY';
        logDebug(`[SubagentHandle] ${this.name}: READY`);
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

        writePrompt(this.ipcDir, promptData);

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
     */
    private async waitForReady(): Promise<boolean> {
        const start = Date.now();
        const ports = this.cdpBridge.getPorts();

        while (Date.now() - start < this.config.launchTimeoutMs) {
            try {
                const instances = await discoverInstances(ports);
                const found = instances.find(
                    (i) => extractWorkspaceName(i.title) === this.name,
                );
                if (found) return true;
            } catch {
                // ネットワークエラーは無視して再試行
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
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
                (i) => extractWorkspaceName(i.title) === this.name,
            );
        } catch {
            return false;
        }
    }
}
