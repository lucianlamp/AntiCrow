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
import { CdpConnectionError, AntigravityLaunchError, CascadePanelError } from './errors';
import { CdpConnection } from './cdpConnection';
import {
    DiscoveredInstance,
    FrameInfo,
    discoverInstances,
    fetchTargetsFromPort,
    extractWorkspaceName,
} from './cdpTargets';
import { CDP_PORT_RANGE, getCdpPorts } from './configHelper';

// Re-export for backward compatibility
export { DiscoveredInstance } from './cdpTargets';

export class CdpBridge {
    private conn: CdpConnection;
    private timeoutMs: number;
    private cascadeContextId: number | null = null;
    private ports: number[];

    constructor(timeoutMs: number = 300_000, ports?: number[]) {
        this.ports = ports ?? CDP_PORT_RANGE;
        this.conn = new CdpConnection(this.ports);
        this.timeoutMs = timeoutMs;
    }

    // -----------------------------------------------------------------------
    // 静的メソッド（cdpTargets.ts への委譲）
    // -----------------------------------------------------------------------

    static discoverInstances(ports?: number[]): Promise<DiscoveredInstance[]> {
        return discoverInstances(ports ?? CDP_PORT_RANGE);
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
            grantUniveralAccess: true,
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
    // UI要素クリック操作
    // -----------------------------------------------------------------------

    async clickElement(options: ClickOptions): Promise<ClickResult> {
        await this.conn.connect();

        const selectorToFind = options.selector || '';
        const textToFind = options.text || '';
        const tagToFind = options.tag || '*';
        const targetX = options.x;
        const targetY = options.y;

        const CLICK_SCRIPT = `
(function() {
    var selectorToFind = ${JSON.stringify(selectorToFind)};
    var textToFind = ${JSON.stringify(textToFind)};
    var tagToFind = ${JSON.stringify(tagToFind)};
    var targetX = ${targetX !== undefined ? targetX : 'null'};
    var targetY = ${targetY !== undefined ? targetY : 'null'};

    function isVisible(el) {
        if (!el) return false;
        if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
            var style = window.getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'sticky') return false;
        }
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function clickEl(el) {
        var rect = el.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };

        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
        } catch(e) {}

        if (['INPUT', 'TEXTAREA'].includes(el.tagName) || el.getAttribute('contenteditable') === 'true') {
            el.focus();
        }
    }

    function findInTree(root, predicate) {
        if (!root) return null;
        if (root.querySelector && selectorToFind) {
            try {
                var found = root.querySelector(selectorToFind);
                if (found && isVisible(found)) return found;
            } catch(e) {}
        }
        var elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            if (predicate(el)) return el;
            if (el.shadowRoot) {
                var shadowFound = findInTree(el.shadowRoot, predicate);
                if (shadowFound) return shadowFound;
            }
        }
        return null;
    }

    if (selectorToFind) {
        var el = findInTree(document, function(e) {
            try { return e.matches && e.matches(selectorToFind) && isVisible(e); } catch(err) { return false; }
        });
        if (el) {
            clickEl(el);
            return { success: true, method: 'selector_hit', target: selectorToFind };
        }
    }

    if (typeof targetX === 'number' && typeof targetY === 'number') {
        var el2 = document.elementFromPoint(targetX, targetY);
        if (el2) {
            var interactive = el2;
            var parent = el2.parentElement;
            while (parent && parent !== document.body) {
                var tag = parent.tagName.toLowerCase();
                if (tag === 'button' || tag === 'a' || parent.getAttribute('role') === 'button' || parent.onclick) {
                    interactive = parent;
                    break;
                }
                parent = parent.parentElement;
            }
            clickEl(interactive);
            return { success: true, method: 'coordinate_hit', target: interactive.tagName };
        }
    }

    if (textToFind && textToFind.length > 0) {
        var match = findInTree(document, function(el) {
            var tag = el.tagName.toLowerCase();
            var isCorrectTag = tagToFind === '*' || tag === tagToFind.toLowerCase();
            if (!isCorrectTag) return false;
            var text = el.innerText || el.textContent || '';
            return text.trim() === textToFind && isVisible(el);
        });
        if (!match) {
            match = findInTree(document, function(el) {
                var tag = el.tagName.toLowerCase();
                var isCorrectTag = tagToFind === '*' || tag === tagToFind.toLowerCase();
                if (!isCorrectTag) return false;
                var text = el.innerText || el.textContent || '';
                return text.indexOf(textToFind) >= 0 && isVisible(el);
            });
        }
        if (match) {
            var interactive2 = match;
            var parent2 = match.parentElement;
            while (parent2 && parent2 !== document.body) {
                var tag2 = parent2.tagName.toLowerCase();
                if (tag2 === 'button' || tag2 === 'a' || parent2.getAttribute('role') === 'button') {
                    interactive2 = parent2;
                    break;
                }
                parent2 = parent2.parentElement;
            }
            clickEl(interactive2);
            return { success: true, method: 'text_hit', target: textToFind };
        }
    }

    return { success: false, error: 'No element found' };
})()
        `.trim();

        try {
            const inCascade = options.inCascade !== false;
            let result: unknown;

            if (inCascade) {
                result = await this.evaluateInCascade(CLICK_SCRIPT);
            } else {
                result = await this.conn.evaluate(CLICK_SCRIPT);
            }

            const clickResult = result as ClickResult;
            if (clickResult?.success) {
                logInfo(`CDP: clickElement success — method=${clickResult.method}, target=${clickResult.target}`);
            } else {
                logDebug(`CDP: clickElement failed — ${clickResult?.error || 'unknown'}`);
            }
            return clickResult || { success: false, error: 'No result returned' };
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logDebug(`CDP: clickElement exception — ${errMsg}`);
            return { success: false, error: errMsg };
        }
    }

    async waitForElement(
        options: ClickOptions,
        timeoutMs: number = 5000,
        pollMs: number = 300,
    ): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const result = await this.clickElement({ ...options });
            if (result.success) {
                return true;
            }
            await this.sleep(pollMs);
        }

        return false;
    }

    async checkElementExists(options: ClickOptions): Promise<boolean> {
        await this.conn.connect();

        const selectorToFind = options.selector || '';
        const textToFind = options.text || '';
        const tagToFind = options.tag || '*';

        const CHECK_SCRIPT = `
(function() {
    var selectorToFind = ${JSON.stringify(selectorToFind)};
    var textToFind = ${JSON.stringify(textToFind)};
    var tagToFind = ${JSON.stringify(tagToFind)};

    function isVisible(el) {
        if (!el) return false;
        if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
            var style = window.getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'sticky') return false;
        }
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function findInTree(root, predicate) {
        if (!root) return null;
        var elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            if (predicate(el)) return el;
            if (el.shadowRoot) {
                var found = findInTree(el.shadowRoot, predicate);
                if (found) return found;
            }
        }
        return null;
    }

    if (selectorToFind) {
        try {
            var el = document.querySelector(selectorToFind);
            if (el && isVisible(el)) return true;
        } catch(e) {}
        var found = findInTree(document, function(e) {
            try { return e.matches && e.matches(selectorToFind) && isVisible(e); } catch(err) { return false; }
        });
        if (found) return true;
    }

    if (textToFind && textToFind.length > 0) {
        var match = findInTree(document, function(el) {
            var tag = el.tagName.toLowerCase();
            var isCorrectTag = tagToFind === '*' || tag === tagToFind.toLowerCase();
            if (!isCorrectTag) return false;
            var text = el.innerText || el.textContent || '';
            return text.trim() === textToFind && isVisible(el);
        });
        if (match) return true;
    }

    return false;
})()
        `.trim();

        try {
            const inCascade = options.inCascade !== false;
            const result = inCascade
                ? await this.evaluateInCascade(CHECK_SCRIPT)
                : await this.conn.evaluate(CHECK_SCRIPT);
            return result === true;
        } catch {
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Expand All 自動クリック
    // -----------------------------------------------------------------------

    async clickExpandAll(): Promise<boolean> {
        const selectors = [
            '[aria-label="Expand All"]',
            '[title="Expand All"]',
            '.expand-all-button',
        ];

        for (const selector of selectors) {
            try {
                const result = await this.clickElement({
                    selector,
                    inCascade: false,
                });
                if (result.success) {
                    logInfo(`CDP: clickExpandAll succeeded — selector=${selector}`);
                    return true;
                }
            } catch (e) {
                logDebug(`CDP: clickExpandAll selector "${selector}" failed — ${e instanceof Error ? e.message : e}`);
            }
        }

        logDebug('CDP: clickExpandAll — no Expand All button found');
        return false;
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
