// ---------------------------------------------------------------------------
// subagentHandle.ts — サブエージェントのライフサイクル管理
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §5
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
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
 * ダミーフォルダでウィンドウを起動し、プロンプト送信・レスポンス受信・終了を担当。
 */
export class SubagentHandle {
    public readonly name: string;
    public readonly branch: string = '';
    public readonly worktreePath: string;
    public readonly createdAt: number;
    public currentTask?: string;

    private _state: SubagentState = 'IDLE';
    private config: SubagentConfig;
    private ipcDir: string;
    private cdpBridge: CdpBridge;
    private repoRoot: string;
    /** ウィンドウ起動用のパス（ダミーフォルダ） */
    private _launchPath: string;
    /** repoRoot の公開 getter */
    public getRepoRoot(): string { return this.repoRoot; }

    constructor(
        name: string,
        repoRoot: string,
        ipcDir: string,
        cdpBridge: CdpBridge,
        config: Partial<SubagentConfig> = {},
    ) {
        this.name = name;
        // 直接編集モード: repoRoot をそのまま使用
        this.worktreePath = repoRoot;
        // ウィンドウ起動用のダミーフォルダ（同一フォルダ二重オープン不可の回避）
        this._launchPath = path.join(repoRoot, '.anticrow', 'subwindows', name);
        this.createdAt = Date.now();
        this.config = { ...DEFAULT_SUBAGENT_CONFIG, ...config };
        this.ipcDir = ipcDir;
        this.cdpBridge = cdpBridge;
        this.repoRoot = repoRoot;
    }

    /**
     * useDirectEdit 時にプロンプト冒頭にリポジトリパス情報を付与する。
     * ダミーサブフォルダで起動したサブエージェントが正しいディレクトリのファイルを編集するよう誘導する。
     */
    private _prependRepoRootInfo(prompt: string): string {
        if (!this.repoRoot) {
            return prompt;
        }
        // AGENTS.md に詳細指示があるため、プロンプトにはリポジトリパスのみ付与
        return `作業対象リポジトリ: ${this.repoRoot}\n\n${prompt}`;
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
     * 1. ダミーフォルダ作成
     * 2. Antigravity ウィンドウを新規起動
     * 3. CDP でターゲット出現を待つ
     */
    async spawn(): Promise<void> {
        if (this._state !== 'IDLE') {
            throw new Error(`spawn() は IDLE 状態でのみ呼び出し可能（現在: ${this._state}）`);
        }

        // --- CREATING: ダミーフォルダ作成 ---
        this._state = 'CREATING';
        logDebug(`[SubagentHandle] ${this.name}: CREATING`);

        // ダミーフォルダを作成してウィンドウ起動に使う
        logDebug(`[SubagentHandle] ${this.name}: ダミーフォルダ作成中 (repoRoot=${this.repoRoot})`);
        try {
            fs.mkdirSync(this._launchPath, { recursive: true });
            // ダミーフォルダに AGENTS.md を配置（Antigravity が自動読み込み）
            const agentsPath = path.join(this._launchPath, 'AGENTS.md');
            // エージェント名から番号を抽出（例: "anti-crow-subagent-2" → 2）
            const agentNumMatch = this.name.match(/subagent-(\d+)$/);
            const agentNum = agentNumMatch ? agentNumMatch[1] : undefined;

            fs.writeFileSync(agentsPath, [
                '# サブエージェント作業指示',
                '',
                ...(agentNum ? [
                    '## あなたの識別情報',
                    '',
                    `あなたは**サブエージェント ${agentNum}** です。チーム内で並列に作業しています。`,
                    '',
                ] : []),
                '## 作業対象リポジトリ',
                '',
                `すべてのファイル操作は \`${this.repoRoot}\` の絶対パスで行ってください。`,
                '',
                '## 禁止事項',
                '',
                `- このフォルダ（\`${this._launchPath}\`）内のファイルを編集・作成しないでください`,
                '- 相対パスでのファイル操作は禁止です',
            ].join('\n'), 'utf-8');
            logDebug(`[SubagentHandle] ${this.name}: ダミーフォルダ作成完了: ${this._launchPath}`);
        } catch (err) {
            logError(`[SubagentHandle] ${this.name}: ダミーフォルダ作成失敗: ${err}`);
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
                await this.cdpBridge.launchAntigravity(this._launchPath, { skipCooldown: true });
            } catch (err) {
                logError(`[SubagentHandle] ウィンドウ起動失敗 (attempt ${attempt}/${maxRetries}): ${err}`);
                if (attempt === maxRetries) {
                    this._state = 'FAILED';
                    await this.cleanupDummyFolder();
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
            await this.cleanupDummyFolder();
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
    async sendPrompt(prompt: string, teamRequestId?: string): Promise<SubagentResponse> {
        if (this._state !== 'READY') {
            throw new Error(`sendPrompt() は READY 状態でのみ呼び出し可能（現在: ${this._state}）`);
        }

        this._state = 'BUSY';
        this.currentTask = prompt;
        const effectivePrompt = this._prependRepoRootInfo(prompt);
        logDebug(`[SubagentHandle] ${this.name}: BUSY`);

        const timestamp = Date.now();
        const teamReqPart = teamRequestId ? `${teamRequestId}_` : '';
        const callbackPath = path.join(
            this.ipcDir,
            `subagent_${this.name}_response_${teamReqPart}${timestamp}.json`,
        );

        // プロンプトファイル書き込み
        const promptData: SubagentPrompt = {
            type: 'subagent_prompt',
            from: extractWorkspaceName(
                this.cdpBridge.getActiveTargetTitle() ?? 'anti-crow',
            ),
            to: this.name,
            timestamp,
            prompt: effectivePrompt,
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
     * サブエージェントにプロンプトを送信するが、レスポンスは待たない（Fire-and-Forget）。
     *
     * チームモード（orchestrateTeam）で使用する。
     * レスポンスの収集は teamOrchestrator.collectResponses() の
     * waitForResponseWithPattern() に一本化するため、ここでは watchResponse() を呼ばない。
     *
     * 従来の sendPrompt() は writePrompt + watchResponse の両方を行うが、
     * collectResponses() も同じパターンのファイルを監視するため二重待機になっていた。
     * この問題（FileIpc: aborted before waiting）を解消するために分離。
     *
     * @returns IPC プロンプトファイルのパスと、レスポンスの期待先パス
     */
    async sendPromptFireAndForget(prompt: string, teamRequestId?: string): Promise<{ promptFile: string; callbackPath: string }> {
        if (this._state !== 'READY') {
            throw new Error(`sendPromptFireAndForget() は READY 状態でのみ呼び出し可能（現在: ${this._state}）`);
        }

        this._state = 'BUSY';
        this.currentTask = prompt;
        const effectivePrompt = this._prependRepoRootInfo(prompt);
        logDebug(`[SubagentHandle] ${this.name}: BUSY (fire-and-forget)`);

        const timestamp = Date.now();
        const teamReqPart = teamRequestId ? `${teamRequestId}_` : '';
        const callbackPath = path.join(
            this.ipcDir,
            `subagent_${this.name}_response_${teamReqPart}${timestamp}.json`,
        );

        // プロンプトファイル書き込み
        const promptData: SubagentPrompt = {
            type: 'subagent_prompt',
            from: extractWorkspaceName(
                this.cdpBridge.getActiveTargetTitle() ?? 'anti-crow',
            ),
            to: this.name,
            timestamp,
            prompt: effectivePrompt,
            timeout_ms: this.config.promptTimeoutMs,
            callback_path: callbackPath,
        };

        const promptFile = writePrompt(this.ipcDir, promptData);
        logDebug(`[SubagentHandle] sendPromptFireAndForget: IPC ファイル書き込み完了: ${path.basename(promptFile)}, callbackPath=${path.basename(callbackPath)}`);

        // watchResponse() は呼ばない — レスポンスは collectResponses() が収集する
        return { promptFile, callbackPath };
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

        // ダミーフォルダを削除
        await this.cleanupDummyFolder();

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
        const launchPathBase = path.basename(this._launchPath);
        let pollCount = 0;

        logDebug(`[SubagentHandle] waitForReady: name=${this.name}, launchPathBase=${launchPathBase}, launchPath=${this._launchPath}, ports=[${ports}], timeout=${this.config.launchTimeoutMs}ms`);

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
     * ダミーフォルダのクリーンアップ。
     */
    private async cleanupDummyFolder(): Promise<void> {
        try {
            if (fs.existsSync(this._launchPath)) {
                fs.rmSync(this._launchPath, { recursive: true, force: true });
                logDebug(`[SubagentHandle] ${this.name}: ダミーフォルダ削除完了: ${this._launchPath}`);
            }
        } catch (err) {
            logWarn(`[SubagentHandle] ${this.name}: ダミーフォルダ削除失敗（無視）: ${err}`);
        }
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
        const launchBase = path.basename(this._launchPath);

        const checks = [
            { label: 'wsName===name', result: wsName === this.name },
            { label: 'wsName===launchBase', result: wsName === launchBase },
            { label: 'title.includes(launchPath)', result: instance.title.includes(this._launchPath) },
            { label: 'title.includes(launchBase)', result: instance.title.includes(launchBase) },
        ];

        const matched = checks.some(c => c.result);
        if (matched) {
            const matchedChecks = checks.filter(c => c.result).map(c => c.label).join(', ');
            logDebug(`[SubagentHandle] matchesSubagent: ✅ MATCH (${matchedChecks}) | wsName="${wsName}", name="${this.name}", launchBase="${launchBase}"`);
        }

        return matched;
    }

    // -----------------------------------------------------------------------
    // 静的ヘルパー: 起動時クリーンアップ
    // -----------------------------------------------------------------------

    /**
     * 起動時に .anticrow/subwindows/ 内の orphan ダミーフォルダを一括削除する。
     * タイムアウトやクラッシュで close() が呼ばれなかったフォルダが蓄積するのを防ぐ。
     *
     * @param repoRoot ワークスペースのルートパス
     * @returns 削除されたフォルダ数
     */
    static cleanupOrphanDummyFolders(repoRoot: string): number {
        const subwindowsDir = path.join(repoRoot, '.anticrow', 'subwindows');
        if (!fs.existsSync(subwindowsDir)) {
            return 0;
        }

        let cleaned = 0;
        try {
            const entries = fs.readdirSync(subwindowsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const folderPath = path.join(subwindowsDir, entry.name);
                    try {
                        fs.rmSync(folderPath, { recursive: true, force: true });
                        cleaned++;
                        logDebug(`[SubagentHandle] cleanupOrphanDummyFolders: 削除完了: ${folderPath}`);
                    } catch (err) {
                        logWarn(`[SubagentHandle] cleanupOrphanDummyFolders: 削除失敗（無視）: ${folderPath}: ${err}`);
                    }
                }
            }

            // subwindows ディレクトリ自体が空になった場合は削除
            try {
                const remaining = fs.readdirSync(subwindowsDir);
                if (remaining.length === 0) {
                    fs.rmSync(subwindowsDir, { recursive: true, force: true });
                    logDebug(`[SubagentHandle] cleanupOrphanDummyFolders: subwindows ディレクトリ自体を削除`);
                }
            } catch { /* ignore */ }
        } catch (err) {
            logWarn(`[SubagentHandle] cleanupOrphanDummyFolders: subwindows ディレクトリ読み取り失敗: ${err}`);
        }

        if (cleaned > 0) {
            logDebug(`[SubagentHandle] cleanupOrphanDummyFolders: ${cleaned} 個の orphan フォルダを削除しました`);
        }
        return cleaned;
    }
}

