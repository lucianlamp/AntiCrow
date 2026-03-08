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
import { logDebug, logError, logWarn } from './logger';
import { ClickOptions, ClickResult } from './types';
import {
    sendPrompt as doSendPrompt,
    startNewChat as doStartNewChat,
    PromptSenderContext,
} from './cdpPromptSender';
import {
    closeWindow as doCloseWindow,
    minimizeWindow as doMinimizeWindow,
    findFreePort as doFindFreePort,
    isPortInUse as doIsPortInUse,
} from './cdpWindowManager';
import {
    CdpBridgeOps,
} from './cdpHistory';
import {
    clickElement as uiClickElement,
    waitForElement as uiWaitForElement,
    checkElementExists as uiCheckElementExists,
    clickExpandAll as uiClickExpandAll,
    clickDropupChevron as uiClickDropupChevron,
    scrollToBottom as uiScrollToBottom,
    autoFollowOutput as uiAutoFollowOutput,
    autoApprove as uiAutoApprove,
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


// Re-export for backward compatibility
export { DiscoveredInstance } from './cdpTargets';

export class CdpBridge {
    private conn: CdpConnection;
    private timeoutMs: number;
    private cascadeContextId: number | null = null;
    private ports: number[];

    /** ランチガード: 起動中の Promise を共有して重複起動を防止 */
    private static launchInFlight: Promise<void> | null = null;
    /** 最後にランチが完了した時刻（クールダウン用） */
    private static lastLaunchTime = 0;
    /** ランチ完了後のクールダウン期間（ms） */
    private static readonly LAUNCH_COOLDOWN_MS = 10_000;

    constructor(timeoutMs: number = 300_000, ports?: number[]) {
        this.ports = ports ?? [];
        this.conn = new CdpConnection(this.ports);
        this.timeoutMs = timeoutMs;
    }

    /**
     * 自ウィンドウのワークスペース名を設定する。
     * CDP接続時にこのワークスペース名を持つターゲットを優先的に選択する。
     */
    setPreferredWorkspace(name: string | null): void {
        this.conn.setPreferredWorkspace(name);
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

    /** cdpPromptSender に渡すコンテキスト */
    private get promptSenderContext(): PromptSenderContext {
        return {
            conn: this.conn,
            getCascadeContext: () => this.getCascadeContext(),
            ensureCascadePanel: () => this.ensureCascadePanel(),
            resetCascadeContext: () => { this.cascadeContextId = null; },
            sleep: (ms: number) => this.sleep(ms),
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
                logDebug('CDP: auto-launch connect succeeded');
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

    async launchAntigravity(folderPath?: string, options?: { skipCooldown?: boolean }): Promise<void> {
        const skipCooldown = options?.skipCooldown ?? false;

        if (skipCooldown) {
            // サブエージェント用: クールダウンとランチガードをバイパスし、独立して起動
            logDebug('CDP: launchAntigravity — skipCooldown mode, bypassing cooldown and launch guard');
            await this.doLaunchAntigravity(folderPath);
            return;
        }

        // ランチガード: 既に起動中なら既存の Promise を共有して待機
        if (CdpBridge.launchInFlight) {
            logDebug('CDP: launchAntigravity — already in flight, waiting for existing launch');
            return CdpBridge.launchInFlight;
        }

        // クールダウン: 直前の起動から一定時間はスキップ
        const elapsed = Date.now() - CdpBridge.lastLaunchTime;
        if (elapsed < CdpBridge.LAUNCH_COOLDOWN_MS) {
            logDebug(`CDP: launchAntigravity — skipped (cooldown: ${Math.ceil((CdpBridge.LAUNCH_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
            return;
        }

        CdpBridge.launchInFlight = this.doLaunchAntigravity(folderPath)
            .finally(() => {
                CdpBridge.launchInFlight = null;
                CdpBridge.lastLaunchTime = Date.now();
            });
        return CdpBridge.launchInFlight;
    }

    private async doLaunchAntigravity(folderPath?: string): Promise<void> {
        // VS Code Terminal API 経由で起動
        // Extension Host から直接 spawn/exec した子プロセスは GUI ウィンドウを作成できないため、
        // Terminal (pty) コンテキストで antigravity CLI を実行する
        // ※ 以前は anticrow.ps1 スクリプトを使っていたが、スクリプトが存在しなかったため
        //    antigravity CLI の直接呼び出しに変更

        logDebug(`CDP: launchAntigravity called, folderPath="${folderPath || '(none)'}"`);

        // コマンド組み立て: antigravity "folderPath" --new-window
        const args: string[] = ['antigravity'];
        if (folderPath) {
            args.push(`"${folderPath}"`);
        }
        args.push('--new-window');

        // NOTE: --remote-debugging-port は渡さない。
        // Antigravity は単一 CDP ポートで全ウィンドウを管理するため、
        // 明示的に指定すると既存ポートと競合する可能性がある。

        // OS 別のシェル設定
        let shellPath: string;
        let shellArgs: string[];
        let command: string;

        if (process.platform === 'win32') {
            shellPath = 'powershell.exe';
            shellArgs = ['-ExecutionPolicy', 'Bypass', '-NoProfile'];
            command = `${args.join(' ')}; exit`;
        } else if (process.platform === 'darwin') {
            shellPath = '/bin/zsh';
            shellArgs = ['-l'];
            command = `${args.join(' ')} && exit`;
        } else {
            // Linux 等
            shellPath = '/bin/bash';
            shellArgs = ['-l'];
            command = `${args.join(' ')} && exit`;
        }

        logDebug(`CDP: launching via terminal (${process.platform}): ${command}`);

        const terminal = vscode.window.createTerminal({
            name: 'Antigravity Launch',
            hideFromUser: true,
            shellPath,
            shellArgs,
        });
        terminal.sendText(command);

        // ターミナル完了検知: onDidCloseTerminal で自動クリーンアップ
        // フォールバック: 30秒後に強制 dispose（スクリプトが長時間かかる場合の安全弁）
        const disposeTimer = setTimeout(() => {
            logDebug('CDP: launch terminal fallback dispose (30s timeout)');
            terminal.dispose();
        }, 30_000);
        const disposable = vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) {
                clearTimeout(disposeTimer);
                disposable.dispose();
                logDebug('CDP: launch terminal closed naturally');
            }
        });
        logDebug(`CDP: launch terminal created, command sent`);
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

    private async getCascadeContext(): Promise<number | undefined> {
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
            // Antigravity の新バージョンでは Cascade iframe が存在せず、
            // UI がメインフレームに直接埋め込まれているため undefined を返す
            return undefined;
        }

        const world = await this.conn.send('Page.createIsolatedWorld', {
            frameId,
            grantUniversalAccess: true,
        }) as { executionContextId: number };

        this.cascadeContextId = world.executionContextId;
        logDebug(`CDP: cascade-panel context ID = ${this.cascadeContextId}`);
        return this.cascadeContextId;
    }

    /**
     * Cascade パネル（Agent Panel）が表示されていることを保証する。
     * パネルが見つからない場合、VSCode コマンドで自動オープンを試みる。
     */
    async ensureCascadePanel(): Promise<void> {
        // 1. パネルの存在を確認
        const frameId = await this.findCascadeFrameId();
        if (frameId) { return; } // iframe なら開いている

        const checkInputJs = `
        (() => {
            function isVisible(el) {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
                if (el.offsetParent === null && style.position !== 'fixed') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }
            const editors = Array.from(document.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)')).filter(isVisible);
            return editors.length > 0;
        })()
    `;

        try {
            // メインフレームに textbox があれば開いていると見なす
            const hasInput = await this.conn.evaluate(checkInputJs);
            if (hasInput) { return; }
        } catch { }

        logDebug('CDP: ensureCascadePanel — panel not found, attempting auto-open...');

        // 2. VSCode コマンドで Agent Panel を開く（複数候補を順に試行）
        const panelCommands = [
            'antigravity.agentPanel.focus',
            'antigravity.openAgentChat',
            'antigravity.cascade.focus',
            'workbench.panel.chat.view.copilot.focus',
        ];
        for (const cmd of panelCommands) {
            try {
                // Execute command inside the CDP target window, NOT the currently active VSCode window 
                // which might be a different workspace
                const evalJs = `
                    (async () => {
                        if (typeof vscode !== 'undefined' && vscode.commands) {
                            await vscode.commands.executeCommand('${cmd}');
                            return true;
                        }
                        return false;
                    })()
                `;
                const executed = await this.conn.evaluate(evalJs);
                if (executed) {
                    logDebug(`CDP: ensureCascadePanel — executed command in target: ${cmd}`);
                    break;
                }
            } catch {
                logDebug(`CDP: ensureCascadePanel — command not available in target: ${cmd}`);
            }
        }

        // 3. パネルが開くまでポーリング待機（最大15秒）
        const maxWaitMs = 15_000;
        const pollMs = 1_000;
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            await this.sleep(pollMs);
            const fid = await this.findCascadeFrameId();
            if (fid) {
                logDebug('CDP: ensureCascadePanel — panel opened successfully (iframe)');
                this.cascadeContextId = null; // コンテキストをリセット
                return;
            }
            try {
                const hasInput = await this.conn.evaluate(checkInputJs);
                if (hasInput) {
                    logDebug('CDP: ensureCascadePanel — panel opened successfully (main frame)');
                    this.cascadeContextId = null; // コンテキストをリセット
                    return;
                }
            } catch { }
        }
        logWarn('CDP: ensureCascadePanel — panel did not open within timeout');
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

    async clickDropupChevron(): Promise<boolean> {
        return uiClickDropupChevron(this.ops);
    }

    async scrollToBottom(): Promise<boolean> {
        return uiScrollToBottom(this.ops);
    }

    async autoFollowOutput(): Promise<void> {
        return uiAutoFollowOutput(this.ops);
    }

    async autoApprove(): Promise<{ clicked: number }> {
        return uiAutoApprove(this.ops);
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
            logDebug(`CDP: connection test OK — cascade panel chat input found: ${hasInput}`);
            return true;
        } catch (e) {
            logError('CDP: connection test failed', e);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // スクリーンショット
    // -----------------------------------------------------------------------

    /** 現在のアクティブなページのスクリーンショットを取得する */
    async getScreenshot(): Promise<Buffer | null> {
        try {
            await this.conn.connect();
            const result = await this.conn.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
            if (result && result.data) {
                return Buffer.from(result.data, 'base64');
            }
            return null;
        } catch (e) {
            logError('CDP: getScreenshot failed', e);
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // チャット操作
    // -----------------------------------------------------------------------

    async startNewChat(): Promise<void> {
        return doStartNewChat(this.promptSenderContext);
    }

    /**
     * キャンセルボタン検索用の JS コード。
     * iframe 内 (evaluateInCascade) とメインフレーム (conn.evaluate) の両方で使い回す。
     */
    private static readonly CANCEL_BUTTON_JS = `
(function() {
    // DisGrav 参考: getTargetDoc() パターン — iframe 内外を透過的に検索
    // メインフレームから実行されても cascade-panel iframe 内の document を取得できる
    function getTargetDoc() {
        var iframes = document.querySelectorAll('iframe');
        for (var fi = 0; fi < iframes.length; fi++) {
            try {
                if (iframes[fi].src && iframes[fi].src.includes('cascade-panel') && iframes[fi].contentDocument) {
                    return iframes[fi].contentDocument;
                }
            } catch(e) { /* cross-origin の場合は無視 */ }
        }
        return document;
    }
    var doc = getTargetDoc();
    var inIframe = doc !== document;

    // 戦略0: data-tooltip-id セレクタ（最も信頼性が高い）
    // キャンセルボタンは DIV 要素のため offsetParent チェックを緩和（存在すれば即クリック）
    var cancelByTooltip = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancelByTooltip) {
        cancelByTooltip.click();
        return { found: true, method: 'tooltip-id', tag: cancelByTooltip.tagName, visible: cancelByTooltip.offsetParent !== null, inIframe: inIframe };
    }

    // 戦略0.5: button innerText が Stop または 停止 (DisGrav 参考)
    var buttons = doc.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
        var txt = (buttons[i].innerText || '').trim().toLowerCase();
        if (txt === 'stop' || txt === '停止') {
            buttons[i].click();
            return { found: true, method: 'button-text-stop', tag: 'BUTTON', text: txt, inIframe: inIframe };
        }
    }

    // Cancel tooltip-id の部分一致フォールバック（Antigravity アップデートで ID が変わった場合の対策）
    var cancelPartial = doc.querySelector('[data-tooltip-id*="cancel"]');
    if (cancelPartial) {
        cancelPartial.click();
        return { found: true, method: 'tooltip-id-partial', tag: cancelPartial.tagName, tooltipId: cancelPartial.getAttribute('data-tooltip-id'), inIframe: inIframe };
    }

    // clickable な要素セレクタ（BUTTON だけでなく DIV も含む）
    var CLICKABLE_SELECTOR = 'button, div[data-tooltip-id], div[role="button"], div[aria-label], [data-tooltip-id]';

    // 戦略A: textbox の親要素内にある clickable 要素で SVG rect/stop アイコンを持つもの
    var textbox = doc.querySelector('div[role="textbox"]');
    if (textbox) {
        var container = textbox.closest('form') || textbox.parentElement?.parentElement?.parentElement;
        if (container) {
            var buttons = container.querySelectorAll(CLICKABLE_SELECTOR);
            for (var i = 0; i < buttons.length; i++) {
                var btn = buttons[i];
                // マイクボタン除外（SVG rect を含むが cancel ボタンではない）
                if (btn.getAttribute('data-tooltip-id') === 'audio-tooltip') continue;
                // 送信ボタン除外
                if (btn.getAttribute('data-tooltip-id') === 'input-send-button-send-tooltip') continue;
                if ((btn.getAttribute('aria-label') || '').toLowerCase().includes('record')) continue;
                var hasSvgRect = btn.querySelector('svg rect') !== null;
                var hasSvgStop = btn.querySelector('svg [data-icon="stop"]') !== null || btn.querySelector('svg .stop-icon') !== null;
                var ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                var isStopBtn = hasSvgRect || hasSvgStop || ariaLabel.includes('stop') || ariaLabel.includes('cancel');
                if (isStopBtn) {
                    btn.click();
                    return { found: true, method: 'svg-rect', tag: btn.tagName, ariaLabel: btn.getAttribute('aria-label'), text: btn.textContent?.trim(), tooltipId: btn.getAttribute('data-tooltip-id'), inIframe: inIframe };
                }
            }
        }
    }

    // 戦略B: ドキュメント全体から SVG rect を持つ clickable 要素を探す
    var allClickable = doc.querySelectorAll(CLICKABLE_SELECTOR);
    for (var j = 0; j < allClickable.length; j++) {
        var b = allClickable[j];
        // マイクボタン・送信ボタン除外
        if (b.getAttribute('data-tooltip-id') === 'audio-tooltip') continue;
        if (b.getAttribute('data-tooltip-id') === 'input-send-button-send-tooltip') continue;
        if ((b.getAttribute('aria-label') || '').toLowerCase().includes('record')) continue;
        var rect = b.querySelector('svg rect');
        if (rect) {
            var style = doc.defaultView.getComputedStyle(rect);
            var fill = style.fill || rect.getAttribute('fill') || '';
            var hexRedRe = new RegExp('#[fF]');
            var rgbRedRe = new RegExp('rgb\\\\(2[0-9]{2},\\\\s*[0-4]');
            if (fill.includes('red') || hexRedRe.test(fill) || rgbRedRe.test(fill)) {
                b.click();
                return { found: true, method: 'red-svg-rect', tag: b.tagName, fill: fill, ariaLabel: b.getAttribute('aria-label'), tooltipId: b.getAttribute('data-tooltip-id'), inIframe: inIframe };
            }
        }
    }

    // 戦略C: aria-label/title 属性にマッチする clickable 要素
    for (var k = 0; k < allClickable.length; k++) {
        var btn2 = allClickable[k];
        var label = (btn2.getAttribute('aria-label') || '').toLowerCase();
        var title = (btn2.getAttribute('title') || '').toLowerCase();
        if (label.includes('stop') || label.includes('cancel') || title.includes('stop') || title.includes('cancel')) {
            btn2.click();
            return { found: true, method: 'aria-match', tag: btn2.tagName, ariaLabel: btn2.getAttribute('aria-label'), title: btn2.getAttribute('title'), tooltipId: btn2.getAttribute('data-tooltip-id'), inIframe: inIframe };
        }
    }

    // 戦略D: textbox の送信エリアで SVG を持つ非送信ボタンの DIV を探す（より広い探索）
    if (textbox) {
        // 5段階まで親要素を遡って探す
        var parent = textbox.parentElement;
        for (var depth = 0; depth < 5 && parent; depth++) {
            var svgEls = parent.querySelectorAll('svg');
            for (var s = 0; s < svgEls.length; s++) {
                var svgParent = svgEls[s].parentElement;
                if (!svgParent) continue;
                // 送信ボタン・マイクボタンは除外
                var tid = svgParent.getAttribute('data-tooltip-id') || '';
                if (tid === 'input-send-button-send-tooltip' || tid === 'audio-tooltip') continue;
                if (tid.includes('send')) continue;
                // SVG rect を含む要素 = キャンセルボタンの可能性
                if (svgParent.querySelector('rect') || svgParent.querySelector('[data-icon="stop"]')) {
                    svgParent.click();
                    return { found: true, method: 'svg-parent-walk', tag: svgParent.tagName, tooltipId: tid || null, depth: depth, inIframe: inIframe };
                }
            }
            parent = parent.parentElement;
        }
    }

    // DOM 調査情報を返す（デバッグ用: BUTTON + tooltip 付き要素）
    var allButtons = doc.querySelectorAll('button');
    var allTooltipEls = doc.querySelectorAll('[data-tooltip-id]');
    var cancelTooltipEl = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    var cancelPartialEl = doc.querySelector('[data-tooltip-id*="cancel"]');
    var buttonInfo = [];
    for (var m = 0; m < allClickable.length && m < 20; m++) {
        var bi = allClickable[m];
        buttonInfo.push({
            ariaLabel: bi.getAttribute('aria-label'),
            title: bi.getAttribute('title'),
            text: (bi.textContent || '').trim().substring(0, 30),
            tag: bi.tagName,
            hasSvg: bi.querySelector('svg') !== null,
            hasSvgRect: bi.querySelector('svg rect') !== null,
            tooltipId: bi.getAttribute('data-tooltip-id'),
            classes: bi.className?.substring?.(0, 50) || '',
        });
    }
    var tooltipInfo = [];
    for (var t = 0; t < allTooltipEls.length && t < 20; t++) {
        tooltipInfo.push({
            tag: allTooltipEls[t].tagName,
            tooltipId: allTooltipEls[t].getAttribute('data-tooltip-id'),
            visible: allTooltipEls[t].offsetParent !== null,
        });
    }
    return {
        found: false,
        method: 'none',
        inIframe: inIframe,
        buttonCount: allButtons.length,
        clickableCount: allClickable.length,
        tooltipCount: allTooltipEls.length,
        buttons: buttonInfo,
        tooltips: tooltipInfo,
        textboxFound: !!textbox,
        cancelTooltipExists: !!cancelTooltipEl,
        cancelPartialExists: !!cancelPartialEl,
        cancelPartialId: cancelPartialEl ? cancelPartialEl.getAttribute('data-tooltip-id') : null,
        cancelTooltipTag: cancelTooltipEl ? cancelTooltipEl.tagName : null,
        cancelTooltipVisible: cancelTooltipEl ? cancelTooltipEl.offsetParent !== null : null,
    };
})()`;

    /**
     * Antigravity のキャンセルボタンをクリックして処理を停止する。
     * 複数戦略を順に試行し、結果を返す。
     */
    async clickCancelButton(): Promise<string> {
        const results: string[] = [];

        // 0. VSCode コマンド（ターゲットウィンドウ内で実行）
        try {
            const evalJs = `
                (async () => {
                    if (typeof vscode !== 'undefined' && vscode.commands) {
                        await vscode.commands.executeCommand('antigravity.cancelCurrentTask');
                        return true;
                    }
                    return false;
                })()
            `;
            const executed = await this.conn.evaluate(evalJs);
            if (executed) {
                results.push('vscode-cmd-target:OK');
                logDebug('CDP: clickCancelButton — used VSCode command in target');
            } else {
                results.push('vscode-cmd-target:SKIP');
                logDebug('CDP: clickCancelButton — VSCode command context unavailable in target');
            }
        } catch {
            results.push('vscode-cmd-target:FAIL');
            logDebug('CDP: clickCancelButton — VSCode command failed in target');
        }

        // 1. CDP 接続
        try {
            await this.conn.connect();
        } catch (e) {
            results.push(`cdp-connect:FAIL(${e instanceof Error ? e.message : e})`);
            return results.join(', ');
        }

        let buttonClicked = false;

        // 2. Cascade iframe 内でボタンを探す
        try {
            const stopBtnResult = await this.evaluateInCascade(
                CdpBridge.CANCEL_BUTTON_JS,
            ) as { found: boolean; method: string;[key: string]: unknown } | null;

            if (stopBtnResult?.found) {
                results.push(`cascade-js:OK(${stopBtnResult.method})`);
                logDebug(`CDP: clickCancelButton — stop button found via JS: ${JSON.stringify(stopBtnResult)}`);
                buttonClicked = true;
            } else {
                const debugStr = stopBtnResult ? JSON.stringify(stopBtnResult).substring(0, 200) : 'null';
                results.push(`cascade-js:NOT_FOUND(${debugStr})`);
                logDebug(`CDP: clickCancelButton — JS search result: ${debugStr}`);
            }
        } catch (e) {
            results.push(`cascade-js:ERROR(${e instanceof Error ? e.message : e})`);
            logDebug(`CDP: clickCancelButton — evaluateInCascade failed: ${e instanceof Error ? e.message : e}`);
        }

        // 3. メインフレームフォールバック: iframe 外でもボタンを探す
        if (!buttonClicked) {
            try {
                const mainResult = await this.conn.evaluate(
                    CdpBridge.CANCEL_BUTTON_JS,
                ) as { found: boolean; method: string;[key: string]: unknown } | null;

                if (mainResult?.found) {
                    results.push(`main-js:OK(${mainResult.method})`);
                    logDebug(`CDP: clickCancelButton — stop button found in main frame: ${JSON.stringify(mainResult)}`);
                    buttonClicked = true;
                } else {
                    const debugStr = mainResult ? JSON.stringify(mainResult).substring(0, 200) : 'null';
                    results.push(`main-js:NOT_FOUND(${debugStr})`);
                    logDebug(`CDP: clickCancelButton — main frame search result: ${debugStr}`);
                }
            } catch (e) {
                results.push(`main-js:ERROR(${e instanceof Error ? e.message : e})`);
            }
        }

        // 4. フォールバック: aria-label/text ベースの clickElement（iframe + メインフレーム両方試行）
        if (!buttonClicked) {
            const stopCandidates: ClickOptions[] = [
                // iframe 内（tooltip-id セレクタは tag 制約なし — cancel ボタンは DIV 要素のため）
                { selector: '[data-tooltip-id="input-send-button-cancel-tooltip"]', inCascade: true },
                { selector: '[data-tooltip-id*="cancel"]', inCascade: true },
                { selector: '[aria-label="Cancel"]', inCascade: true },
                { selector: '[aria-label="Stop"]', inCascade: true },
                { text: 'Cancel', inCascade: true },
                { text: 'Stop', inCascade: true },
                // メインフレーム（tooltip-id セレクタは tag 制約なし）
                { selector: '[data-tooltip-id="input-send-button-cancel-tooltip"]', inCascade: false },
                { selector: '[data-tooltip-id*="cancel"]', inCascade: false },
                { selector: '[aria-label="Cancel"]', inCascade: false },
                { selector: '[aria-label="Stop"]', inCascade: false },
            ];
            for (const candidate of stopCandidates) {
                try {
                    const result = await this.clickElement(candidate);
                    if (result.success) {
                        const label = candidate.selector || candidate.text || '';
                        const scope = candidate.inCascade ? 'cascade' : 'main';
                        results.push(`button:OK(${scope}:${label})`);
                        logDebug(`CDP: clickCancelButton — button clicked (${scope}:${label})`);
                        buttonClicked = true;
                        break;
                    }
                } catch {
                    // continue to next candidate
                }
            }
            if (!buttonClicked) {
                results.push('button:NOT_FOUND');
            }
        }

        // 5. cascade iframe 内で textbox にフォーカスしてから Escape キーを DOM ディスパッチ
        if (!buttonClicked) {
            try {
                const escapeResult = await this.evaluateInCascade(`
                    (function() {
                        var el = document.querySelector('div[role="textbox"]');
                        if (el) { el.focus(); }
                        var target = el || document.activeElement || document.body;
                        var opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
                        target.dispatchEvent(new KeyboardEvent('keydown', opts));
                        target.dispatchEvent(new KeyboardEvent('keyup', opts));
                        return { sent: true, target: target.tagName, role: target.getAttribute && target.getAttribute('role') };
                    })()
                `) as { sent?: boolean; target?: string } | null;
                if (escapeResult?.sent) {
                    results.push(`cascade-escape:SENT(${escapeResult.target})`);
                    logDebug(`CDP: clickCancelButton — Escape dispatched in cascade iframe: ${JSON.stringify(escapeResult)}`);
                    await this.sleep(500);
                } else {
                    results.push('cascade-escape:FAIL(no-result)');
                }
            } catch (e) {
                results.push(`cascade-escape:ERROR(${e instanceof Error ? e.message : e})`);
                logDebug(`CDP: clickCancelButton — cascade Escape dispatch failed: ${e instanceof Error ? e.message : e}`);
            }
        }

        // 6. 最終フォールバック: CDP Input.dispatchKeyEvent で Escape キーを送信（複数回リトライ）
        if (!buttonClicked) {
            const ESCAPE_RETRIES = 3;
            let escapeSent = false;
            for (let i = 0; i < ESCAPE_RETRIES; i++) {
                try {
                    await this.conn.send('Input.dispatchKeyEvent', {
                        type: 'keyDown',
                        windowsVirtualKeyCode: 27,
                        code: 'Escape',
                        key: 'Escape',
                    });
                    await this.sleep(50);
                    await this.conn.send('Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        windowsVirtualKeyCode: 27,
                        code: 'Escape',
                        key: 'Escape',
                    });
                    escapeSent = true;
                    logDebug(`CDP: clickCancelButton — Escape key sent (attempt ${i + 1}/${ESCAPE_RETRIES})`);
                    await this.sleep(300);
                } catch (e) {
                    logDebug(`CDP: clickCancelButton — Escape attempt ${i + 1} failed: ${e instanceof Error ? e.message : e}`);
                }
            }
            results.push(escapeSent ? `escape:SENT(${ESCAPE_RETRIES}x)` : 'escape:FAIL');
            if (escapeSent) { await this.sleep(200); }
        }

        return results.join(', ');
    }

    /** @deprecated clickCancelButton を使用してください */
    async clickStopButton(): Promise<void> {
        await this.clickCancelButton();
    }


    async sendPrompt(prompt: string): Promise<void> {
        return doSendPrompt(this.promptSenderContext, prompt);
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
        return doFindFreePort(this.ports);
    }

    /** ポートが使用中かどうかを TCP 接続でチェックする */
    private isPortInUse(port: number): Promise<boolean> {
        return doIsPortInUse(port);
    }

    // -----------------------------------------------------------------------
    // サブエージェント ウィンドウ制御
    // -----------------------------------------------------------------------

    /**
     * 指定ワークスペース名の Antigravity ウィンドウを閉じる。
     * VSCode API の workbench.action.closeWindow を CDP 経由で実行する。
     *
     * メインウィンドウ（現在接続中のターゲット）は閉じないようガードする。
     * 一時的な CdpConnection を作成して実行するため、現在の接続には影響しない。
     *
     * @param workspaceName 閉じたいウィンドウのワークスペース名（例: "anti-crow-subagent-1"）
     * @returns true: ウィンドウを閉じた, false: ターゲットが見つからない or 失敗
     */
    async closeWindow(workspaceName: string): Promise<boolean> {
        return doCloseWindow(this.conn, this.ports, workspaceName);
    }

    async minimizeWindow(workspaceName: string): Promise<boolean> {
        return doMinimizeWindow(this.ports, workspaceName);
    }
}

