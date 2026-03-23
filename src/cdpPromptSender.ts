// ---------------------------------------------------------------------------
// cdpPromptSender.ts — プロンプト送信・新規チャット開始ロジック
// ---------------------------------------------------------------------------
// cdpBridge.ts から分離。sendPrompt / startNewChat の実装をヘルパー関数として提供。
// CdpBridge クラスのメソッドからはこれらの関数を委譲呼び出しする。
// ---------------------------------------------------------------------------

import { logDebug, logWarn } from './logger';
import { CascadePanelError } from './errors';
import { CdpConnection } from './cdpConnection';

// ---------------------------------------------------------------------------
// 型定義（CdpBridge 内部状態を受け取るためのインターフェース）
// ---------------------------------------------------------------------------

/** sendPrompt / startNewChat に必要な操作コンテキスト */
export interface PromptSenderContext {
    conn: CdpConnection;
    /** Cascade iframe の実行コンテキスト ID を取得 */
    getCascadeContext: () => Promise<number | undefined>;
    /** Cascade パネルの表示を保証 */
    ensureCascadePanel: () => Promise<void>;
    /** cascade コンテキスト ID をリセット */
    resetCascadeContext: () => void;
    /** スリープ */
    sleep: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// startNewChat
// ---------------------------------------------------------------------------

export async function startNewChat(ctx: PromptSenderContext): Promise<void> {
    // 優先: VSCode コマンド（ターゲットウィンドウ内で実行）
    try {
        const evalJs = `
            (async () => {
                if (typeof vscode !== 'undefined' && vscode.commands) {
                    await vscode.commands.executeCommand('antigravity.startNewConversation');
                    return true;
                }
                return false;
            })()
        `;
        const executed = await ctx.conn.evaluate(evalJs);
        if (executed) {
            logDebug('CDP: startNewChat — used VSCode command (antigravity.startNewConversation) in target');
            ctx.resetCascadeContext();
            return;
        }
    } catch (e) {
        logDebug(`CDP: startNewChat — VSCode command failed in target: ${e}`);
    }

    // フォールバック: CDP でキー注入 (Ctrl+Shift+L)
    await ctx.conn.connect();

    await ctx.conn.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        modifiers: 10,
        windowsVirtualKeyCode: 76,
        code: 'KeyL',
        key: 'L',
    });
    await ctx.sleep(50);
    await ctx.conn.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: 10,
        windowsVirtualKeyCode: 76,
        code: 'KeyL',
        key: 'L',
    });

    logDebug('CDP: startNewChat — fell back to Ctrl+Shift+L key injection');
    await ctx.sleep(1000);
    ctx.resetCascadeContext();
}

// ---------------------------------------------------------------------------
// waitForCascadeIdle
// ---------------------------------------------------------------------------

/**
 * Cascade がアイドル状態（処理中でない）になるまで待機する。
 * キャンセルボタンが存在する = 処理中。自動クリックで停止させる。
 */
async function waitForCascadeIdle(ctx: PromptSenderContext, maxWaitMs = 15000): Promise<void> {
    const t0 = Date.now();
    const IDLE_CHECK_JS = `
(function() {
    function getTargetDoc() {
        var iframes = document.querySelectorAll('iframe');
        for (var fi = 0; fi < iframes.length; fi++) {
            try {
                if (iframes[fi].src && iframes[fi].src.includes('cascade-panel') && iframes[fi].contentDocument) {
                    return iframes[fi].contentDocument;
                }
            } catch(e) {}
        }
        return document;
    }
    var doc = getTargetDoc();
    // キャンセルボタンの存在チェック（処理中の指標）
    var cancelBtn = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (!cancelBtn) {
        cancelBtn = doc.querySelector('[data-tooltip-id*="cancel"]');
    }
    if (cancelBtn) {
        cancelBtn.click();
        return { idle: false, action: 'cancelled' };
    }
    // Stop/停止 ボタンテキストの存在チェック
    var buttons = doc.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
        var txt = (buttons[i].innerText || '').trim().toLowerCase();
        if (txt === 'stop' || txt === '停止') {
            buttons[i].click();
            return { idle: false, action: 'stopped' };
        }
    }
    return { idle: true };
})()
    `.trim();

    // ファストパス: ループに入る前に1回だけチェック（sleepなしで即リターン）
    try {
        const contextId = await ctx.getCascadeContext();
        const fastResult = await ctx.conn.evaluate(IDLE_CHECK_JS, contextId) as { idle: boolean; action?: string };
        if (fastResult?.idle) {
            logDebug(`CDP: waitForCascadeIdle — fast path idle (${Date.now() - t0}ms)`);
            return;
        }
        if (fastResult?.action) {
            logDebug(`CDP: waitForCascadeIdle — fast path action: ${fastResult.action}`);
        }
    } catch (e) {
        logDebug(`CDP: waitForCascadeIdle — fast path check failed: ${e instanceof Error ? e.message : e}`);
    }

    const deadline = Date.now() + maxWaitMs;
    const pollMs = 500;
    let clickedCancel = true; // ファストパスでキャンセル済みの可能性

    while (Date.now() < deadline) {
        await ctx.sleep(pollMs);
        try {
            const contextId = await ctx.getCascadeContext();
            const result = await ctx.conn.evaluate(IDLE_CHECK_JS, contextId) as { idle: boolean; action?: string };
            if (result?.idle) {
                if (clickedCancel) {
                    logDebug(`CDP: waitForCascadeIdle — idle after cancel (${Date.now() - t0}ms)`);
                    await ctx.sleep(500); // キャンセル後の安定待ち
                }
                return;
            }
            if (result?.action) {
                logDebug(`CDP: waitForCascadeIdle — action: ${result.action}, waiting for idle...`);
                clickedCancel = true;
            }
        } catch (e) {
            logDebug(`CDP: waitForCascadeIdle — check failed: ${e instanceof Error ? e.message : e}`);
        }
    }
    logWarn(`CDP: waitForCascadeIdle — timeout after ${Date.now() - t0}ms, proceeding anyway`);
}

// ---------------------------------------------------------------------------
// sendPrompt
// ---------------------------------------------------------------------------

export async function sendPrompt(ctx: PromptSenderContext, prompt: string): Promise<void> {
    const sendStart = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await ctx.conn.connect();
            break;
        } catch (e) {
            logWarn(`CDP: connect attempt ${attempt}/3 failed`);
            if (attempt === 3) { throw e; }
            await ctx.sleep(2000 * attempt);
        }
    }

    // Cascade パネルの表示を保証
    try {
        await ctx.ensureCascadePanel();
    } catch (e) {
        logWarn(`CDP: ensureCascadePanel failed: ${e}`);
    }
    // --- (0) Cascade のアイドル状態を保証 ---
    const idleStart = Date.now();
    await waitForCascadeIdle(ctx);
    logDebug(`CDP: sendPrompt — waitForCascadeIdle took ${Date.now() - idleStart}ms`);

    const contextId = await ctx.getCascadeContext();

    // --- (A) テキストボックスの readiness チェック ---
    const TEXTBOX_READINESS_JS = `
(function() {
    function isVisible(el) {
        if (!el) return false;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (el.offsetParent === null && style.position !== 'fixed') return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }
    var editors = Array.from(document.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)')).filter(isVisible);
    var el = editors[editors.length - 1];
    if (!el) return { ready: false, reason: 'no textbox' };
    if (el.contentEditable !== 'true') return { ready: false, reason: 'not editable' };
    return { ready: true };
})()
    `.trim();

    const readinessStart = Date.now();
    const READINESS_MAX_WAIT_MS = 10_000;
    const READINESS_POLL_MS = 300;
    const readinessDeadline = Date.now() + READINESS_MAX_WAIT_MS;
    let textboxReady = false;
    while (Date.now() < readinessDeadline) {
        try {
            const readiness = await ctx.conn.evaluate(TEXTBOX_READINESS_JS, contextId) as { ready: boolean; reason?: string };
            if (readiness?.ready) {
                textboxReady = true;
                break;
            }
            logDebug(`CDP: sendPrompt — waiting for textbox readiness: ${readiness?.reason || 'unknown'}`);
        } catch (e) {
            logDebug(`CDP: sendPrompt — readiness check failed: ${e instanceof Error ? e.message : e}`);
        }
        await ctx.sleep(READINESS_POLL_MS);
    }
    logDebug(`CDP: sendPrompt — readiness check took ${Date.now() - readinessStart}ms`);
    if (!textboxReady) {
        logWarn('CDP: sendPrompt — textbox readiness timeout, proceeding anyway');
    }

    // NOTE: document.execCommand は W3C で非推奨（deprecated）だが、
    // Electron の Chromium エンジンでは当面動作する。
    const setInputJs = `
  (function() {
    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (el.offsetParent === null && style.position !== 'fixed') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    const editors = Array.from(document.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)')).filter(isVisible);
    const el = editors.at(-1);

    if (!el) {
      return { success: false, error: 'No visible chat input found' };
    }
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    
    // Convert prompt to multiple lines and insert
    const text = ${JSON.stringify(prompt)};
    
    let inserted = false;
    try {
        inserted = document.execCommand('insertText', false, text);
    } catch (e) {}

    if (!inserted) {
        el.textContent = text;
        try {
            el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        } catch (e) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return { success: true };
  })()
`;

    const inputResult = await ctx.conn.evaluate(setInputJs, contextId) as {
        success: boolean;
        error?: string;
    };
    if (!inputResult?.success) {
        throw new CascadePanelError(`Failed to find chat input: ${inputResult?.error}`);
    }
    logDebug('CDP: input set via div[role="textbox"]');

    // --- (B) テキスト挿入後の検証 ---
    const VERIFY_JS = `
(function() {
    var editors = Array.from(document.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)'));
    var el = editors[editors.length - 1];
    return { hasContent: el && (el.textContent || '').trim().length > 0, length: (el && el.textContent || '').length };
})()
    `.trim();

    for (let verify = 0; verify < 3; verify++) {
        await ctx.sleep(100);
        try {
            const verifyResult = await ctx.conn.evaluate(VERIFY_JS, contextId) as { hasContent: boolean; length: number };
            if (verifyResult?.hasContent) {
                logDebug(`CDP: sendPrompt — text verification OK (length=${verifyResult.length}, attempt=${verify + 1})`);
                break;
            }
            logWarn(`CDP: sendPrompt — text verification failed (attempt ${verify + 1}/3, length=${verifyResult?.length || 0}), retrying insert`);
            await ctx.conn.evaluate(setInputJs, contextId);
        } catch (e) {
            logDebug(`CDP: sendPrompt — verify failed: ${e instanceof Error ? e.message : e}`);
        }
    }

    await ctx.sleep(200);

    const submitJs = `
  (function() {
    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (el.offsetParent === null && style.position !== 'fixed') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    const editors = Array.from(document.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)')).filter(isVisible);
    const el = editors.at(-1);
    
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
    await ctx.conn.evaluate(submitJs, contextId);
    logDebug(`CDP: prompt submitted (total sendPrompt: ${Date.now() - sendStart}ms)`);
}
