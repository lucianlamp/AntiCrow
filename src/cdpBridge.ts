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

    // -----------------------------------------------------------------------
    // 会話履歴ポップアップ操作
    // -----------------------------------------------------------------------

    /** 会話履歴ポップアップを開く（チャット画面右上の時計アイコンをクリック） */
    async openHistoryPopup(): Promise<void> {
        await this.conn.connect();

        const CLICK_HISTORY_BUTTON = `
(function() {
    // Cascade iframe 内の履歴ボタン（時計アイコン）を探してクリックする
    // 複数のセレクタ候補をフォールバックで試行
    var selectors = [
        'button[aria-label*="history" i]',
        'button[aria-label*="History" i]',
        'button[aria-label*="conversation" i]',
        'button[aria-label*="Conversation" i]',
        '.codicon-history',
        '[class*="history"]',
        'button[data-testid*="history"]',
    ];

    function isVisible(el) {
        if (!el) return false;
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
    }

    // セレクタ候補で検索
    for (var i = 0; i < selectors.length; i++) {
        try {
            var els = document.querySelectorAll(selectors[i]);
            for (var j = 0; j < els.length; j++) {
                var el = els[j];
                // .codicon-history などアイコン要素の場合は親ボタンを探す
                var target = el;
                if (el.tagName !== 'BUTTON') {
                    var parent = el.closest('button') || el.parentElement;
                    if (parent && parent.tagName === 'BUTTON') {
                        target = parent;
                    }
                }
                if (isVisible(target)) {
                    clickEl(target);
                    return { success: true, method: 'selector', selector: selectors[i] };
                }
            }
        } catch(e) {}
    }

    // フォールバック: SVG の中にクロック系パスを持つボタンを探す
    var buttons = document.querySelectorAll('button');
    for (var k = 0; k < buttons.length; k++) {
        var btn = buttons[k];
        var svg = btn.querySelector('svg');
        if (svg && isVisible(btn)) {
            var paths = svg.querySelectorAll('path, circle');
            if (paths.length > 0) {
                var ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                var title = (btn.getAttribute('title') || '').toLowerCase();
                if (ariaLabel.indexOf('histor') >= 0 || ariaLabel.indexOf('clock') >= 0 ||
                    title.indexOf('histor') >= 0 || title.indexOf('clock') >= 0) {
                    clickEl(btn);
                    return { success: true, method: 'svg_fallback', label: ariaLabel || title };
                }
            }
        }
    }

    return { success: false, error: 'History button not found in Cascade panel' };
})()
        `.trim();

        try {
            const result = await this.evaluateInCascade(CLICK_HISTORY_BUTTON) as {
                success: boolean;
                method?: string;
                selector?: string;
                label?: string;
                error?: string;
            };

            if (result?.success) {
                logInfo(`CDP: openHistoryPopup — clicked history button (method=${result.method}, selector=${result.selector || result.label || 'N/A'})`);
            } else {
                logWarn(`CDP: openHistoryPopup — history button not found: ${result?.error || 'unknown'}`);
            }
        } catch (e) {
            logWarn(`CDP: openHistoryPopup — failed to click history button: ${e instanceof Error ? e.message : e}`);
        }

        await this.sleep(1500);
    }

    /** 会話履歴ポップアップ内の会話一覧を取得 (Quick Pick ウィジェットの DOM スクレイピング) */
    async getConversationList(): Promise<{ title: string; index: number }[]> {
        await this.conn.connect();

        const SCRAPE_SCRIPT = `
(function() {
// 会話履歴は VS Code の Quick Pick ウィジェットとしてメインウィンドウに表示される
// Quick Pick 専用のセレクタのみ使用し、エクスプローラ等の誤マッチを防止する
var selectors = [
    // Quick Pick ウィジェット内のリスト行（Quick Pick 内に限定）
    '.quick-input-list .monaco-list-row',
    '.quick-input-widget [role="option"]',
    '.quick-input-widget .monaco-list-row',
    '.quick-input-widget [role="listbox"] [role="option"]',
];

var debugInfo = { tried: [], foundSelector: null, totalElements: 0, quickInputVisible: false };

// Quick Pick ウィジェットが表示されているか確認
var quickInput = document.querySelector('.quick-input-widget');
var qiStyle = quickInput ? window.getComputedStyle(quickInput) : null;
debugInfo.quickInputVisible = quickInput ? (quickInput.style.display !== 'none' && (!qiStyle || qiStyle.display !== 'none')) : false;

// Quick Pick が表示されていない場合はスキップ
if (!debugInfo.quickInputVisible) {
    return {
        success: false, items: [], debugInfo: debugInfo,
        error: 'Quick Pick widget not visible'
    };
}

var rows = [];
for (var s = 0; s < selectors.length; s++) {
    try {
        var found = document.querySelectorAll(selectors[s]);
        debugInfo.tried.push({ selector: selectors[s], count: found ? found.length : 0 });
        if (found && found.length > 0) {
            rows = Array.from(found);
            debugInfo.foundSelector = selectors[s];
            break;
        }
    } catch(e) {
        debugInfo.tried.push({ selector: selectors[s], error: e.message });
    }
}

debugInfo.totalElements = document.querySelectorAll('*').length;

if (rows.length === 0) {
    return {
        success: false, items: [], debugInfo: debugInfo,
        error: 'No Quick Pick items found. quickInputVisible=' + debugInfo.quickInputVisible
    };
}
var items = [];
for (var i = 0; i < Math.min(rows.length, 10); i++) {
    var el = rows[i];
    // Quick Pick の各行からラベルテキストを抽出
    // 構造: .monaco-list-row > ... > .label-name > span (複数)
    // .label-name 直下のスパンを結合してフルラベルを得る
    var labelEl = el.querySelector('.label-name');
    var text = '';
    if (labelEl) {
        // .label-name 内のハイライトスパンを結合
        var spans = labelEl.querySelectorAll(':scope > span');
        if (spans.length > 0) {
            var parts = [];
            for (var j = 0; j < spans.length; j++) {
                parts.push(spans[j].textContent || '');
            }
            text = parts.join('').trim();
        }
        // スパンがない場合は textContent をそのまま使う
        if (!text) {
            text = (labelEl.textContent || '').trim();
        }
    }
    // フォールバック: aria-label や行全体の textContent
    if (!text) {
        text = (el.getAttribute('aria-label') || el.textContent || '').trim();
    }
    if (text.length > 0) {
        items.push({ title: text.substring(0, 100), index: i });
    }
}
return { success: true, items: items, debugInfo: debugInfo };
})()
        `.trim();

        // Quick Pick ウィジェットはメインウィンドウに表示されるため、メインを先に検索
        // フォールバックとして Cascade iframe 内も検索する
        for (const [label, evaluator] of [
            ['main', () => this.conn.evaluate(SCRAPE_SCRIPT)],
            ['cascade', () => this.evaluateInCascade(SCRAPE_SCRIPT)],
        ] as [string, () => Promise<unknown>][]) {
            try {
                const result = await evaluator() as {
                    success: boolean;
                    items: { title: string; index: number }[];
                    debugInfo?: unknown;
                    error?: string;
                };

                if (result?.success && result.items.length > 0) {
                    logInfo(`CDP: getConversationList — found ${result.items.length} conversations in ${label} context`);
                    logDebug(`CDP: getConversationList debugInfo (${label}): ${JSON.stringify(result.debugInfo)}`);
                    return result.items;
                }

                logDebug(`CDP: getConversationList (${label}) — ${result?.error || 'no items'}, debugInfo: ${JSON.stringify(result?.debugInfo)}`);
            } catch (e) {
                logDebug(`CDP: getConversationList (${label}) exception — ${e instanceof Error ? e.message : e}`);
            }
        }

        logWarn('CDP: getConversationList — no conversations found in either context');
        return [];
    }

    /**
     * 会話履歴ポップアップを開き、会話一覧を取得する（統合版）。
     *
     * Quick Pick ポップアップが一瞬で閉じても検出できるよう、
     * MutationObserver をクリック前にメインウィンドウに設置し、
     * Quick Pick の表示をリアルタイムにキャプチャする。
     */
    async openHistoryAndGetList(): Promise<{ title: string; index: number }[]> {
        await this.conn.connect();

        // --- Step 1: メインウィンドウに MutationObserver を設置 ---
        // Quick Pick が一瞬でも表示されたら、その内容をキャプチャする
        const INSTALL_OBSERVER = `
(function() {
    // 既存のオブザーバーがあればクリーンアップ
    if (window.__historyCaptureObserver) {
        try { window.__historyCaptureObserver.disconnect(); } catch(e) {}
    }
    window.__historyCapture = { items: [], captured: false, events: 0, diag: [] };

    function scrapeQuickPick() {
        var qiw = document.querySelector('.quick-input-widget');
        if (!qiw) return;
        var style = window.getComputedStyle(qiw);
        if (style.display === 'none' || qiw.style.display === 'none') return;

        // Quick Pick が表示された！リスト行を取得
        var selectors = [
            '.quick-input-list .monaco-list-row',
            '.quick-input-widget [role="option"]',
            '.quick-input-widget .monaco-list-row',
        ];

        var rows = [];
        for (var s = 0; s < selectors.length; s++) {
            try {
                var found = qiw.querySelectorAll(selectors[s].replace('.quick-input-widget ', '').replace('.quick-input-list ', '.quick-input-list '));
                // Quick Pick ウィジェット内に限定して検索
                found = document.querySelectorAll(selectors[s]);
                if (found && found.length > 0) {
                    rows = Array.from(found);
                    break;
                }
            } catch(e) {}
        }

        if (rows.length === 0) {
            window.__historyCapture.diag.push('visible_but_no_rows');
            return;
        }

        var items = [];
        for (var i = 0; i < Math.min(rows.length, 20); i++) {
            var el = rows[i];
            var labelEl = el.querySelector('.label-name');
            var text = '';
            if (labelEl) {
                var spans = labelEl.querySelectorAll(':scope > span');
                if (spans.length > 0) {
                    var parts = [];
                    for (var j = 0; j < spans.length; j++) {
                        parts.push(spans[j].textContent || '');
                    }
                    text = parts.join('').trim();
                }
                if (!text) {
                    text = (labelEl.textContent || '').trim();
                }
            }
            if (!text) {
                text = (el.getAttribute('aria-label') || '').trim();
            }
            if (!text) {
                var descEl = el.querySelector('.label-description');
                if (descEl) { text = (descEl.textContent || '').trim(); }
            }
            if (!text) {
                text = (el.textContent || '').trim();
            }
            if (text.length > 0) {
                items.push({ title: text.substring(0, 100), index: i });
            }
        }

        if (items.length > 0 && !window.__historyCapture.captured) {
            window.__historyCapture.items = items;
            window.__historyCapture.captured = true;
        }
    }

    var observer = new MutationObserver(function() {
        window.__historyCapture.events++;
        scrapeQuickPick();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'aria-hidden']
    });
    window.__historyCaptureObserver = observer;

    // 設置直後にも一度チェック（既に表示されている場合に備える）
    scrapeQuickPick();

    return { success: true };
})()
        `.trim();

        try {
            await this.conn.evaluate(INSTALL_OBSERVER);
            logInfo('CDP: openHistoryAndGetList — installed MutationObserver in main window');
        } catch (e) {
            logWarn(`CDP: openHistoryAndGetList — failed to install observer: ${e instanceof Error ? e.message : e}`);
        }

        // --- Step 2: 履歴ボタンをクリック ---
        const CLICK_HISTORY_BUTTON = `
(function() {
var selectors = [
    'button[aria-label*="history" i]',
    'button[aria-label*="History" i]',
    'button[aria-label*="conversation" i]',
    'button[aria-label*="Conversation" i]',
    '.codicon-history',
    '[class*="history"]',
    'button[data-testid*="history"]',
];

function isVisible(el) {
    if (!el) return false;
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
}

for (var i = 0; i < selectors.length; i++) {
    try {
        var els = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < els.length; j++) {
            var el = els[j];
            var target = el;
            if (el.tagName !== 'BUTTON') {
                var parent = el.closest('button') || el.parentElement;
                if (parent && parent.tagName === 'BUTTON') {
                    target = parent;
                }
            }
            if (isVisible(target)) {
                clickEl(target);
                return { success: true, method: 'selector', selector: selectors[i] };
            }
        }
    } catch(e) {}
}

var buttons = document.querySelectorAll('button');
for (var k = 0; k < buttons.length; k++) {
    var btn = buttons[k];
    var svg = btn.querySelector('svg');
    if (svg && isVisible(btn)) {
        var paths = svg.querySelectorAll('path, circle');
        if (paths.length > 0) {
            var ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            var title = (btn.getAttribute('title') || '').toLowerCase();
            if (ariaLabel.indexOf('histor') >= 0 || ariaLabel.indexOf('clock') >= 0 ||
                title.indexOf('histor') >= 0 || title.indexOf('clock') >= 0) {
                clickEl(btn);
                return { success: true, method: 'svg_fallback', label: ariaLabel || title };
            }
        }
    }
}

return { success: false, error: 'History button not found in Cascade panel' };
})()
        `.trim();

        try {
            const clickResult = await this.evaluateInCascade(CLICK_HISTORY_BUTTON) as {
                success: boolean;
                method?: string;
                selector?: string;
                label?: string;
                error?: string;
            };

            if (clickResult?.success) {
                logInfo(`CDP: openHistoryAndGetList — clicked history button (method=${clickResult.method}, selector=${clickResult.selector || clickResult.label || 'N/A'})`);
            } else {
                logWarn(`CDP: openHistoryAndGetList — history button not found: ${clickResult?.error || 'unknown'}`);
                await this.cleanupHistoryObserver();
                return [];
            }
        } catch (e) {
            logWarn(`CDP: openHistoryAndGetList — failed to click history button: ${e instanceof Error ? e.message : e}`);
            await this.cleanupHistoryObserver();
            return [];
        }

        // --- Step 3: MutationObserver のキャプチャ結果をポーリング ---
        const READ_CAPTURE = `
(function() {
    var c = window.__historyCapture || { items: [], captured: false, events: 0, diag: [] };
    var qiw = document.querySelector('.quick-input-widget');
    var qpState = 'not_found';
    if (qiw) {
        var s = window.getComputedStyle(qiw);
        qpState = (qiw.style.display || s.display) + ' children=' + qiw.children.length;
    }
    return {
        captured: c.captured,
        items: c.items,
        events: c.events,
        diag: c.diag,
        quickPickState: qpState,
    };
})()
        `.trim();

        const POLL_INTERVAL_MS = 80;
        const POLL_TIMEOUT_MS = 6000;
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let pollCount = 0;

        type CaptureResult = {
            captured: boolean;
            items: { title: string; index: number }[];
            events: number;
            diag: string[];
            quickPickState: string;
        };

        while (Date.now() < deadline) {
            pollCount++;
            try {
                const result = await this.conn.evaluate(READ_CAPTURE) as CaptureResult;

                if (pollCount === 1 || pollCount % 10 === 0) {
                    logInfo(`CDP: openHistoryAndGetList poll #${pollCount} — captured=${result?.captured}, events=${result?.events}, qp=${result?.quickPickState}, diag=${JSON.stringify(result?.diag)}`);
                }

                if (result?.captured && result.items.length > 0) {
                    logInfo(`CDP: openHistoryAndGetList — captured ${result.items.length} conversations via MutationObserver (poll #${pollCount}, events=${result.events})`);
                    await this.cleanupHistoryObserver();
                    return result.items;
                }
            } catch (e) {
                logDebug(`CDP: openHistoryAndGetList polling exception — ${e instanceof Error ? e.message : e}`);
            }
            await this.sleep(POLL_INTERVAL_MS);
        }

        // タイムアウト — 最終診断ログ
        try {
            const finalResult = await this.conn.evaluate(READ_CAPTURE) as CaptureResult;
            logWarn(`CDP: openHistoryAndGetList — timeout after ${pollCount} polls. events=${finalResult?.events}, qp=${finalResult?.quickPickState}, diag=${JSON.stringify(finalResult?.diag)}`);
        } catch (e) { /* ignore */ }

        await this.cleanupHistoryObserver();
        logWarn(`CDP: openHistoryAndGetList — no conversations found after ${pollCount} polls`);
        return [];
    }

    /** メインウィンドウに設置した MutationObserver をクリーンアップする */
    private async cleanupHistoryObserver(): Promise<void> {
        try {
            await this.conn.evaluate(
                'if(window.__historyCaptureObserver){window.__historyCaptureObserver.disconnect();delete window.__historyCaptureObserver;delete window.__historyCapture;}'
            );
        } catch (e) {
            logDebug(`CDP: cleanupHistoryObserver — ${e instanceof Error ? e.message : e}`);
        }
    }

    /** ポップアップ内の N 番目の会話を選択 (Arrow Down + Enter) */
    async selectConversation(index: number): Promise<boolean> {
        await this.conn.connect();

        // Arrow Down で目的の行まで移動
        for (let i = 0; i < index; i++) {
            await this.conn.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                windowsVirtualKeyCode: 40,
                code: 'ArrowDown',
                key: 'ArrowDown',
            });
            await this.sleep(30);
            await this.conn.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                windowsVirtualKeyCode: 40,
                code: 'ArrowDown',
                key: 'ArrowDown',
            });
            await this.sleep(100);
        }

        // Enter で選択
        await this.conn.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            windowsVirtualKeyCode: 13,
            code: 'Enter',
            key: 'Enter',
        });
        await this.sleep(30);
        await this.conn.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            windowsVirtualKeyCode: 13,
            code: 'Enter',
            key: 'Enter',
        });

        logInfo(`CDP: selectConversation — selected index ${index}`);
        await this.sleep(1000);
        this.cascadeContextId = null;
        return true;
    }

    /** ポップアップを閉じる (Escape) */
    async closePopup(): Promise<void> {
        await this.conn.connect();

        await this.conn.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            windowsVirtualKeyCode: 27,
            code: 'Escape',
            key: 'Escape',
        });
        await this.sleep(30);
        await this.conn.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            windowsVirtualKeyCode: 27,
            code: 'Escape',
            key: 'Escape',
        });

        logInfo('CDP: closePopup — sent Escape');
        await this.sleep(300);
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
