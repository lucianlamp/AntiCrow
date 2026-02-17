// ---------------------------------------------------------------------------
// cdpBridge.ts — Chrome DevTools Protocol 経由で Antigravity を操作
// ---------------------------------------------------------------------------
// 設計方針:
//   puppeteer は依存が巨大（Chromium DL含む）なので ws で CDP 直接操作。
//   Antigravity は Electron ベースなので --remote-debugging-port で CDP が使える。
//   チャット UI は cascade-panel.html の iframe 内にあるため、
//   Page.createIsolatedWorld で iframe の実行コンテキストを取得して操作する。
//   プロンプト送信のみ CDP で行い、応答の取得はファイルベース IPC で行う。
//
// モジュール分割:
//   - cdpTargets.ts: ターゲット発見・スコアリング・ワークスペース名抽出
//   - cdpConnection.ts: WebSocket 接続管理・コマンド送信
//   - cdpBridge.ts (本ファイル): 上記をまとめるファサード + DOM 操作
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import { logInfo, logError, logWarn, logDebug } from './logger';
import { ClickOptions, ClickResult } from './types';
import {
    CdpBridgeOps,
    openHistoryPopup as histOpenPopup,
    getConversationList as histGetList,
    openHistoryAndGetList as histOpenAndGet,
    cleanupHistoryObserver as histCleanup,
    selectConversation as histSelect,
    closePopup as histClose,
} from './cdpHistory';
import {
    clickElement as uiClickElement,
    waitForElement as uiWaitForElement,
    checkElementExists as uiCheckElementExists,
    clickExpandAll as uiClickExpandAll,
} from './cdpUI';
import { CdpConnectionError, AntigravityLaunchError, CascadePanelError } from './errors';
import { CdpConnection } from './cdpConnection';
import {
    DiscoveredInstance,
    FrameInfo,
    discoverInstances,
    fetchTargetsFromPort,
    extractWorkspaceName,
} from './cdpTargets';
import { getCdpPorts } from './configHelper';

// Re-export for backward compatibility
export { DiscoveredInstance } from './cdpTargets';

export class CdpBridge {
    private conn: CdpConnection;
    private timeoutMs: number;
    private cascadeContextId: number | null = null;
    private ports: number[];

    constructor(timeoutMs: number = 300_000, ports?: number[]) {
        this.ports = ports ?? [];
        this.conn = new CdpConnection(this.ports);
        this.timeoutMs = timeoutMs;
    }

    /** cdpHistory / cdpModels / 外部ヘルパーに渡す操作オブジェクト */
    get ops(): CdpBridgeOps {
        return {
            conn: this.conn,
            evaluateInCascade: (expr: string) => this.evaluateInCascade(expr),
            sleep: (ms: number) => this.sleep(ms),
            resetCascadeContext: () => { this.cascadeContextId = null; },
        };
    }

    // -----------------------------------------------------------------------
    // 静的メソッド（cdpTargets.ts への委譲）
    // -----------------------------------------------------------------------

    static discoverInstances(ports?: number[]): Promise<DiscoveredInstance[]> {
        return discoverInstances(ports ?? []);
    }

    /** インスタンスのポート一覧を取得 */
    getPorts(): number[] {
        return this.ports;
    }

    static fetchTargetsFromPort(port: number) {
        return fetchTargetsFromPort(port);
    }

    static extractWorkspaceName(title: string): string {
        return extractWorkspaceName(title);
    }

    // -----------------------------------------------------------------------
    // ターゲット情報アクセサ
    // -----------------------------------------------------------------------

    getActiveTargetId(): string | null { return this.conn.getActiveTargetId(); }
    getActiveTargetTitle(): string | null { return this.conn.getActiveTargetTitle(); }
    getActiveTargetPort(): number | null { return this.conn.getActiveTargetPort(); }

    getActiveWorkspaceName(): string | null {
        const title = this.conn.getActiveTargetTitle();
        if (!title) { return null; }
        return extractWorkspaceName(title);
    }

    // -----------------------------------------------------------------------
    // 接続管理（CdpConnection への委譲）
    // -----------------------------------------------------------------------

    async connect(): Promise<void> {
        return this.conn.connect();
    }

    disconnect(): void {
        this.conn.disconnect();
        this.cascadeContextId = null;
    }

    fullDisconnect(): void {
        this.conn.fullDisconnect();
        this.cascadeContextId = null;
    }

    async switchTarget(targetId: string): Promise<DiscoveredInstance> {
        this.cascadeContextId = null;
        return this.conn.switchTarget(targetId);
    }

    // -----------------------------------------------------------------------
    // イベントリスナー
    // -----------------------------------------------------------------------

    onEvent(listener: (method: string, params: unknown) => void): void {
        this.conn.onEvent(listener);
    }

    clearEventListeners(): void {
        this.conn.clearEventListeners();
    }

    async enableRuntimeEvents(): Promise<void> {
        return this.conn.enableRuntimeEvents();
    }

    // -----------------------------------------------------------------------
    // 自動起動付き接続
    // -----------------------------------------------------------------------

    async ensureConnected(folderPath?: string): Promise<void> {
        try {
            await this.conn.connect();
            return;
        } catch (e) {
            logWarn(`CDP: connect failed, attempting auto-launch — ${e instanceof Error ? e.message : e}`);
        }

        await this.launchAntigravity(folderPath);

        const maxWaitMs = 30_000;
        const pollMs = 2_000;
        const deadline = Date.now() + maxWaitMs;

        while (Date.now() < deadline) {
            await this.sleep(pollMs);
            try {
                await this.conn.connect();
                logInfo('CDP: auto-launch connect succeeded');
                return;
            } catch {
                logDebug('CDP: auto-launch polling — not ready yet');
            }
        }

        throw new CdpConnectionError(
            `Antigravity auto-launch timed out after ${maxWaitMs / 1000}s. No CDP port available.`,
            0,
        );
    }

    async launchAntigravity(folderPath?: string): Promise<void> {
        // VS Code Terminal API 経由で起動
        // Extension Host から直接 spawn/exec した子プロセスは GUI ウィンドウを作成できないため、
        // Terminal (pty) コンテキストで launch-antigravity.ps1 スクリプトを実行する
        const scriptPath = path.join(__dirname, '..', 'scripts', 'launch-antigravity.ps1');

        logInfo(`CDP: launchAntigravity called, folderPath="${folderPath || '(none)'}", scriptPath="${scriptPath}"`);

        const folderArg = folderPath ? ` -FolderPath "${folderPath}"` : '';
        const command = `& "${scriptPath}"${folderArg}; exit`;

        logInfo(`CDP: launching via terminal: ${command}`);

        const terminal = vscode.window.createTerminal({
            name: 'Antigravity Launch',
            hideFromUser: true,
            shellPath: 'powershell.exe',
            shellArgs: ['-ExecutionPolicy', 'Bypass', '-NoProfile'],
        });
        terminal.sendText(command);

        // スクリプト完了後にターミナルを自動クリーンアップ
        setTimeout(() => terminal.dispose(), 10000);
        logInfo(`CDP: launch terminal created, command sent`);
    }

    // -----------------------------------------------------------------------
    // cascade-panel iframe のコンテキスト取得
    // -----------------------------------------------------------------------

    private async findCascadeFrameId(): Promise<string | null> {
        const frameTree = await this.conn.send('Page.getFrameTree', {}) as { frameTree: FrameInfo };

        const findFrame = (info: FrameInfo): string | null => {
            if (info.frame.name === 'antigravity.agentPanel' ||
                info.frame.url.includes('cascade-panel.html')) {
                return info.frame.id;
            }
            if (info.childFrames) {
                for (const child of info.childFrames) {
                    const found = findFrame(child);
                    if (found) { return found; }
                }
            }
            return null;
        };

        return findFrame(frameTree.frameTree);
    }

    private async getCascadeContext(): Promise<number> {
        if (this.cascadeContextId !== null) {
            try {
                const ok = await this.conn.evaluate('true', this.cascadeContextId);
                if (ok === true) { return this.cascadeContextId; }
            } catch {
                this.cascadeContextId = null;
            }
        }

        const frameId = await this.findCascadeFrameId();
        if (!frameId) {
            throw new CascadePanelError(
                'Cascade panel iframe not found. ' +
                'Make sure the Antigravity chat panel is visible (open the Agent Panel).'
            );
        }

        const world = await this.conn.send('Page.createIsolatedWorld', {
            frameId,
            grantUniversalAccess: true,
        }) as { executionContextId: number };

        this.cascadeContextId = world.executionContextId;
        logDebug(`CDP: cascade-panel context ID = ${this.cascadeContextId}`);
        return this.cascadeContextId;
    }

    private async evaluateInCascade(expression: string): Promise<unknown> {
        const contextId = await this.getCascadeContext();
        return this.conn.evaluate(expression, contextId);
    }

    // -----------------------------------------------------------------------
    // UI要素クリック操作（cdpUI.ts へ委譲）
    // -----------------------------------------------------------------------

    async clickElement(options: ClickOptions): Promise<ClickResult> {
        return uiClickElement(this.ops, options);
    }

    async waitForElement(
        options: ClickOptions,
        timeoutMs: number = 5000,
        pollMs: number = 300,
    ): Promise<boolean> {
        return uiWaitForElement(this.ops, options, timeoutMs, pollMs);
    }

    async checkElementExists(options: ClickOptions): Promise<boolean> {
        return uiCheckElementExists(this.ops, options);
    }

    // -----------------------------------------------------------------------
    // Expand All 自動クリック（cdpUI.ts へ委譲）
    // -----------------------------------------------------------------------

    async clickExpandAll(): Promise<boolean> {
        return uiClickExpandAll(this.ops);
    }

    // -----------------------------------------------------------------------
    // 接続テスト
    // -----------------------------------------------------------------------

    async testConnection(): Promise<boolean> {
        try {
            await this.conn.connect();
            const contextId = await this.getCascadeContext();
            const hasInput = await this.conn.evaluate(
                'document.querySelector(\'div[role="textbox"]\') !== null',
                contextId,
            );
            logInfo(`CDP: connection test OK — cascade panel chat input found: ${hasInput}`);
            return true;
        } catch (e) {
            logError('CDP: connection test failed', e);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // チャット操作
    // -----------------------------------------------------------------------

    async startNewChat(): Promise<void> {
        await this.conn.connect();

        await this.conn.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: 10,
            windowsVirtualKeyCode: 76,
            code: 'KeyL',
            key: 'L',
        });
        await this.sleep(50);
        await this.conn.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: 10,
            windowsVirtualKeyCode: 76,
            code: 'KeyL',
            key: 'L',
        });

        logInfo('CDP: startNewChat — sent Ctrl+Shift+L');
        await this.sleep(1500);
        this.cascadeContextId = null;
    }

    // -----------------------------------------------------------------------
    // 会話履歴ポップアップ操作（cdpHistory.ts へ委譲）
    // -----------------------------------------------------------------------

    /** 会話履歴ポップアップを開く（チャット画面右上の時計アイコンをクリック） */
    async openHistoryPopup(): Promise<void> {
        return histOpenPopup(this.ops);
    }

    /** 会話履歴ポップアップ内の会話一覧を取得 (Quick Pick ウィジェットの DOM スクレイピング) */
    async getConversationList(): Promise<{ title: string; index: number }[]> {
        return histGetList(this.ops);
    }

    /**
     * 会話履歴ポップアップを開き、会話一覧を取得する（統合版）。
     * Quick Pick ポップアップが一瞬で閉じても検出できるよう、
     * MutationObserver をクリック前にメインウィンドウに設置する。
     */
    async openHistoryAndGetList(): Promise<{ title: string; index: number }[]> {
        return histOpenAndGet(this.ops);
    }

    /** メインウィンドウに設置した MutationObserver をクリーンアップする */
    private async cleanupHistoryObserver(): Promise<void> {
        return histCleanup(this.ops);
    }

    /** ポップアップ内の N 番目の会話を選択 (Arrow Down + Enter) */
    async selectConversation(index: number): Promise<boolean> {
        return histSelect(this.ops, index);
    }

    /** ポップアップを閉じる (Escape) */
    async closePopup(): Promise<void> {
        return histClose(this.ops);
    }
    async sendPrompt(prompt: string): Promise<void> {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await this.conn.connect();
                break;
            } catch (e) {
                logWarn(`CDP: connect attempt ${attempt}/3 failed`);
                if (attempt === 3) { throw e; }
                await this.sleep(2000 * attempt);
            }
        }

        const contextId = await this.getCascadeContext();

        const setInputJs = `
      (function() {
        const el = document.querySelector('div[role="textbox"]');
        if (!el) {
          return { success: false, error: 'No chat input (div[role=textbox]) found' };
        }
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        const lines = ${JSON.stringify(prompt)}.split('\\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 0) {
            document.execCommand('insertText', false, lines[i]);
          }
          if (i < lines.length - 1) {
            document.execCommand('insertLineBreak', false);
          }
        }
        return { success: true };
      })()
    `;

        const inputResult = await this.conn.evaluate(setInputJs, contextId) as {
            success: boolean;
            error?: string;
        };
        if (!inputResult?.success) {
            throw new CascadePanelError(`Failed to find chat input: ${inputResult?.error}`);
        }
        logDebug('CDP: input set via div[role="textbox"]');

        await this.sleep(500);

        const submitJs = `
      (function() {
        const el = document.querySelector('div[role="textbox"]');
        if (!el) { return { success: false }; }
        const opts = {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        return { success: true };
      })()
    `;
        await this.conn.evaluate(submitJs, contextId);
        logInfo('CDP: prompt submitted');
    }

    // -----------------------------------------------------------------------
    // ユーティリティ
    // -----------------------------------------------------------------------

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * ポート範囲から空きポートを探す。
     * 全ポートを並列に TCP チェックし、最初の空きポートを返す。
     */
    private async findFreePort(): Promise<number> {
        const results = await Promise.allSettled(
            this.ports.map(async (port) => ({
                port,
                inUse: await this.isPortInUse(port),
            })),
        );
        for (const result of results) {
            if (result.status === 'fulfilled' && !result.value.inUse) {
                logInfo(`CDP: found free port ${result.value.port} for launch`);
                return result.value.port;
            }
        }
        // 全ポートが使用中の場合はデフォルトの最初のポートで試行
        logWarn(`CDP: all ports in range are in use, falling back to ${this.ports[0]}`);
        return this.ports[0];
    }

    /** ポートが使用中かどうかを TCP 接続でチェックする */
    private isPortInUse(port: number): Promise<boolean> {
        return new Promise(resolve => {
            const socket = new net.Socket();
            socket.setTimeout(300);
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);  // 接続成功 = 使用中
            });
            socket.once('error', () => {
                socket.destroy();
                resolve(false); // 接続失敗 = 空き
            });
            socket.once('timeout', () => {
                socket.destroy();
                resolve(false); // タイムアウト = 空き
            });
            socket.connect(port, '127.0.0.1');
        });
    }
}
