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
import { logDebug, logError, logWarn } from './logger';
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
    scrollToBottom as uiScrollToBottom,
    autoFollowOutput as uiAutoFollowOutput,
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

    async launchAntigravity(folderPath?: string): Promise<void> {
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
        // Terminal (pty) コンテキストで anticrow.ps1 スクリプトを実行する
        const scriptPath = path.join(__dirname, '..', 'scripts', 'anticrow.ps1');

        logDebug(`CDP: launchAntigravity called, folderPath="${folderPath || '(none)'}", scriptPath="${scriptPath}"`);

        const folderArg = folderPath ? ` -FolderPath "${folderPath}"` : '';
        const command = `& "${scriptPath}"${folderArg}; exit`;

        logDebug(`CDP: launching via terminal: ${command}`);

        const terminal = vscode.window.createTerminal({
            name: 'Antigravity Launch',
            hideFromUser: true,
            shellPath: 'powershell.exe',
            shellArgs: ['-ExecutionPolicy', 'Bypass', '-NoProfile'],
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

    /**
     * Cascade パネル（Agent Panel）が表示されていることを保証する。
     * パネルが見つからない場合、VSCode コマンドで自動オープンを試みる。
     */
    async ensureCascadePanel(): Promise<void> {
        // 1. パネルの存在を確認
        const frameId = await this.findCascadeFrameId();
        if (frameId) { return; } // 既に開いている

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
                await vscode.commands.executeCommand(cmd);
                logDebug(`CDP: ensureCascadePanel — executed command: ${cmd}`);
                break;
            } catch {
                logDebug(`CDP: ensureCascadePanel — command not available: ${cmd}`);
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
                logDebug('CDP: ensureCascadePanel — panel opened successfully');
                this.cascadeContextId = null; // コンテキストをリセット
                return;
            }
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

    async scrollToBottom(): Promise<boolean> {
        return uiScrollToBottom(this.ops);
    }

    async autoFollowOutput(): Promise<void> {
        return uiAutoFollowOutput(this.ops);
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
    // チャット操作
    // -----------------------------------------------------------------------

    async startNewChat(): Promise<void> {
        // 優先: VSCode コマンド（UI変更に強い）
        try {
            await vscode.commands.executeCommand('antigravity.startNewConversation');
            logDebug('CDP: startNewChat — used VSCode command (antigravity.startNewConversation)');
            this.cascadeContextId = null;
            return;
        } catch (e) {
            logDebug(`CDP: startNewChat — VSCode command failed, falling back to key injection: ${e instanceof Error ? e.message : e}`);
        }

        // フォールバック: CDP でキー注入 (Ctrl+Shift+L)
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

        logDebug('CDP: startNewChat — fell back to Ctrl+Shift+L key injection');
        await this.sleep(1500);
        this.cascadeContextId = null;
    }

    /**
     * キャンセルボタン検索用の JS コード。
     * iframe 内 (evaluateInCascade) とメインフレーム (conn.evaluate) の両方で使い回す。
     */
    private static readonly CANCEL_BUTTON_JS = `
(function() {
    // 戦略0: data-tooltip-id セレクタ（最も信頼性が高い）
    // キャンセルボタンは DIV 要素のため offsetParent チェックを緩和（存在すれば即クリック）
    var cancelByTooltip = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancelByTooltip) {
        cancelByTooltip.click();
        return { found: true, method: 'tooltip-id', tag: cancelByTooltip.tagName, visible: cancelByTooltip.offsetParent !== null };
    }

    // 戦略A: textbox の親要素内にある button で SVG rect/stop アイコンを持つもの
    var textbox = document.querySelector('div[role="textbox"]');
    if (textbox) {
        var container = textbox.closest('form') || textbox.parentElement?.parentElement?.parentElement;
        if (container) {
            var buttons = container.querySelectorAll('button');
            for (var i = 0; i < buttons.length; i++) {
                var btn = buttons[i];
                // マイクボタン除外（SVG rect を含むが cancel ボタンではない）
                if (btn.getAttribute('data-tooltip-id') === 'audio-tooltip') continue;
                if ((btn.getAttribute('aria-label') || '').toLowerCase().includes('record')) continue;
                var hasSvgRect = btn.querySelector('svg rect') !== null;
                var hasSvgStop = btn.querySelector('svg [data-icon="stop"]') !== null || btn.querySelector('svg .stop-icon') !== null;
                var ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                var isStopBtn = hasSvgRect || hasSvgStop || ariaLabel.includes('stop') || ariaLabel.includes('cancel');
                if (isStopBtn) {
                    btn.click();
                    return { found: true, method: 'svg-rect', ariaLabel: btn.getAttribute('aria-label'), text: btn.textContent?.trim() };
                }
            }
        }
    }

    // 戦略B: ドキュメント全体から SVG rect を持つボタンを探す
    var allButtons = document.querySelectorAll('button');
    for (var j = 0; j < allButtons.length; j++) {
        var b = allButtons[j];
        // マイクボタン除外
        if (b.getAttribute('data-tooltip-id') === 'audio-tooltip') continue;
        if ((b.getAttribute('aria-label') || '').toLowerCase().includes('record')) continue;
        var rect = b.querySelector('svg rect');
        if (rect) {
            var style = window.getComputedStyle(rect);
            var fill = style.fill || rect.getAttribute('fill') || '';
            if (fill.includes('red') || fill.match(/#[fF]/) || fill.match(/rgb\(2[0-9]{2},\s*[0-4]/)) {
                b.click();
                return { found: true, method: 'red-svg-rect', fill: fill, ariaLabel: b.getAttribute('aria-label') };
            }
        }
    }

    // 戦略C: aria-label/title 属性にマッチするボタン
    for (var k = 0; k < allButtons.length; k++) {
        var btn2 = allButtons[k];
        var label = (btn2.getAttribute('aria-label') || '').toLowerCase();
        var title = (btn2.getAttribute('title') || '').toLowerCase();
        if (label.includes('stop') || label.includes('cancel') || title.includes('stop') || title.includes('cancel')) {
            btn2.click();
            return { found: true, method: 'aria-match', ariaLabel: btn2.getAttribute('aria-label'), title: btn2.getAttribute('title') };
        }
    }

    // DOM 調査情報を返す（デバッグ用）
    var cancelTooltipEl = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    var buttonInfo = [];
    for (var m = 0; m < allButtons.length && m < 20; m++) {
        var bi = allButtons[m];
        buttonInfo.push({
            ariaLabel: bi.getAttribute('aria-label'),
            title: bi.getAttribute('title'),
            text: (bi.textContent || '').trim().substring(0, 30),
            hasSvg: bi.querySelector('svg') !== null,
            hasSvgRect: bi.querySelector('svg rect') !== null,
            tooltipId: bi.getAttribute('data-tooltip-id'),
            classes: bi.className?.substring?.(0, 50) || '',
        });
    }
    return {
        found: false,
        method: 'none',
        buttonCount: allButtons.length,
        buttons: buttonInfo,
        textboxFound: !!textbox,
        cancelTooltipExists: !!cancelTooltipEl,
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

        // 0. VSCode コマンド（UI変更に強いが効かない場合がある）
        try {
            await vscode.commands.executeCommand('antigravity.cancelCurrentTask');
            results.push('vscode-cmd:OK');
            logDebug('CDP: clickCancelButton — used VSCode command');
        } catch {
            results.push('vscode-cmd:FAIL');
            logDebug('CDP: clickCancelButton — VSCode command not available');
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
                { selector: '[aria-label="Cancel"]', tag: 'button', inCascade: true },
                { selector: '[aria-label="Stop"]', tag: 'button', inCascade: true },
                { text: 'Cancel', tag: 'button', inCascade: true },
                { text: 'Stop', tag: 'button', inCascade: true },
                // メインフレーム（tooltip-id セレクタは tag 制約なし）
                { selector: '[data-tooltip-id="input-send-button-cancel-tooltip"]', inCascade: false },
                { selector: '[aria-label="Cancel"]', tag: 'button', inCascade: false },
                { selector: '[aria-label="Stop"]', tag: 'button', inCascade: false },
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

        // 5. 最終フォールバック: Escape キーを送信
        if (!buttonClicked) {
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
                results.push('escape:SENT');
                logDebug('CDP: clickCancelButton — sent Escape key as fallback');
                await this.sleep(500);
            } catch (e) {
                results.push(`escape:FAIL(${e instanceof Error ? e.message : e})`);
            }
        }

        return results.join(', ');
    }

    /** @deprecated clickCancelButton を使用してください */
    async clickStopButton(): Promise<void> {
        await this.clickCancelButton();
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

        // Cascade パネルのコンテキスト取得（パネル未表示時は自動オープン試行）
        let contextId: number;
        try {
            contextId = await this.getCascadeContext();
        } catch (e) {
            if (e instanceof CascadePanelError) {
                logWarn('CDP: sendPrompt — Cascade panel not found, attempting auto-open...');
                await this.ensureCascadePanel();
                contextId = await this.getCascadeContext(); // リトライ（失敗時はそのままスロー）
            } else {
                throw e;
            }
        }

        // NOTE: document.execCommand は W3C で非推奨（deprecated）だが、
        // Electron の Chromium エンジンでは当面動作する。
        // 将来的に InputEvent / beforeinput ベースの入力方式に移行を検討すること。
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
        logDebug('CDP: prompt submitted');
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
                logDebug(`CDP: found free port ${result.value.port} for launch`);
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
