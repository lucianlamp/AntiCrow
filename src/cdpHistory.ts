// ---------------------------------------------------------------------------
// cdpHistory.ts — 会話履歴ポップアップ操作ヘルパー
// ---------------------------------------------------------------------------
// cdpBridge.ts から分離した履歴操作の実装。
// CdpBridgeOps インターフェース経由で CdpBridge の内部機能にアクセスする。
// ---------------------------------------------------------------------------

import { logDebug, logWarn } from './logger';

/** CdpBridge の内部操作を外部ヘルパーに公開するインターフェース */
export interface CdpBridgeOps {
    conn: {
        connect(): Promise<void>;
        send(method: string, params: unknown): Promise<unknown>;
        evaluate(expr: string, contextId?: number): Promise<unknown>;
    };
    evaluateInCascade(expression: string): Promise<unknown>;
    sleep(ms: number): Promise<void>;
    resetCascadeContext(): void;
}

// -----------------------------------------------------------------------
// openHistoryPopup
// -----------------------------------------------------------------------

export async function openHistoryPopup(ops: CdpBridgeOps): Promise<void> {
    await ops.conn.connect();

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
        const result = await ops.evaluateInCascade(CLICK_HISTORY_BUTTON) as {
            success: boolean;
            method?: string;
            selector?: string;
            label?: string;
            error?: string;
        };

        if (result?.success) {
            logDebug(`CDP: openHistoryPopup — clicked history button (method=${result.method}, selector=${result.selector || result.label || 'N/A'})`);
        } else {
            logWarn(`CDP: openHistoryPopup — history button not found: ${result?.error || 'unknown'}`);
        }
    } catch (e) {
        logWarn(`CDP: openHistoryPopup — failed to click history button: ${e instanceof Error ? e.message : e}`);
    }

    await ops.sleep(1500);
}

// -----------------------------------------------------------------------
// getConversationList
// -----------------------------------------------------------------------

export async function getConversationList(ops: CdpBridgeOps): Promise<{ title: string; index: number }[]> {
    await ops.conn.connect();

    const SCRAPE_SCRIPT = `
(function() {
var selectors = [
    '.quick-input-list .monaco-list-row',
    '.quick-input-widget [role="option"]',
    '.quick-input-widget .monaco-list-row',
    '.quick-input-widget [role="listbox"] [role="option"]',
];

var debugInfo = { tried: [], foundSelector: null, totalElements: 0, quickInputVisible: false };

var quickInput = document.querySelector('.quick-input-widget');
var qiStyle = quickInput ? window.getComputedStyle(quickInput) : null;
debugInfo.quickInputVisible = quickInput ? (quickInput.style.display !== 'none' && (!qiStyle || qiStyle.display !== 'none')) : false;

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
        text = (el.getAttribute('aria-label') || el.textContent || '').trim();
    }
    if (text.length > 0) {
        items.push({ title: text.substring(0, 100), index: i });
    }
}
return { success: true, items: items, debugInfo: debugInfo };
})()
    `.trim();

    for (const [label, evaluator] of [
        ['main', () => ops.conn.evaluate(SCRAPE_SCRIPT)],
        ['cascade', () => ops.evaluateInCascade(SCRAPE_SCRIPT)],
    ] as [string, () => Promise<unknown>][]) {
        try {
            const result = await evaluator() as {
                success: boolean;
                items: { title: string; index: number }[];
                debugInfo?: unknown;
                error?: string;
            };

            if (result?.success && result.items.length > 0) {
                logDebug(`CDP: getConversationList — found ${result.items.length} conversations in ${label} context`);
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

// -----------------------------------------------------------------------
// openHistoryAndGetList (統合版: MutationObserver + ポーリング)
// -----------------------------------------------------------------------

export async function openHistoryAndGetList(ops: CdpBridgeOps): Promise<{ title: string; index: number }[]> {
    await ops.conn.connect();

    // --- Step 1: MutationObserver を設置 ---
    const INSTALL_OBSERVER = `
(function() {
    if (window.__historyCaptureObserver) {
        try { window.__historyCaptureObserver.disconnect(); } catch(e) {}
    }
    window.__historyCapture = { items: [], captured: false, events: 0, diag: [] };

    function scrapeQuickPick() {
        var qiw = document.querySelector('.quick-input-widget');
        if (!qiw) return;
        var style = window.getComputedStyle(qiw);
        if (style.display === 'none' || qiw.style.display === 'none') return;

        var selectors = [
            '.quick-input-list .monaco-list-row',
            '.quick-input-widget [role="option"]',
            '.quick-input-widget .monaco-list-row',
        ];

        var rows = [];
        for (var s = 0; s < selectors.length; s++) {
            try {
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

    scrapeQuickPick();

    return { success: true };
})()
    `.trim();

    try {
        await ops.conn.evaluate(INSTALL_OBSERVER);
        logDebug('CDP: openHistoryAndGetList — installed MutationObserver in main window');
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
        const clickResult = await ops.evaluateInCascade(CLICK_HISTORY_BUTTON) as {
            success: boolean;
            method?: string;
            selector?: string;
            label?: string;
            error?: string;
        };

        if (clickResult?.success) {
            logDebug(`CDP: openHistoryAndGetList — clicked history button (method=${clickResult.method}, selector=${clickResult.selector || clickResult.label || 'N/A'})`);
        } else {
            logWarn(`CDP: openHistoryAndGetList — history button not found: ${clickResult?.error || 'unknown'}`);
            await cleanupHistoryObserver(ops);
            return [];
        }
    } catch (e) {
        logWarn(`CDP: openHistoryAndGetList — failed to click history button: ${e instanceof Error ? e.message : e}`);
        await cleanupHistoryObserver(ops);
        return [];
    }

    // --- Step 3: ポーリング ---
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
            const result = await ops.conn.evaluate(READ_CAPTURE) as CaptureResult;

            if (pollCount === 1 || pollCount % 10 === 0) {
                logDebug(`CDP: openHistoryAndGetList poll #${pollCount} — captured=${result?.captured}, events=${result?.events}, qp=${result?.quickPickState}, diag=${JSON.stringify(result?.diag)}`);
            }

            if (result?.captured && result.items.length > 0) {
                logDebug(`CDP: openHistoryAndGetList — captured ${result.items.length} conversations via MutationObserver (poll #${pollCount}, events=${result.events})`);
                await cleanupHistoryObserver(ops);
                return result.items;
            }
        } catch (e) {
            logDebug(`CDP: openHistoryAndGetList polling exception — ${e instanceof Error ? e.message : e}`);
        }
        await ops.sleep(POLL_INTERVAL_MS);
    }

    // タイムアウト
    try {
        const finalResult = await ops.conn.evaluate(READ_CAPTURE) as CaptureResult;
        logWarn(`CDP: openHistoryAndGetList — timeout after ${pollCount} polls. events=${finalResult?.events}, qp=${finalResult?.quickPickState}, diag=${JSON.stringify(finalResult?.diag)}`);
    } catch (e) { /* ignore */ }

    await cleanupHistoryObserver(ops);
    logWarn(`CDP: openHistoryAndGetList — no conversations found after ${pollCount} polls`);
    return [];
}

// -----------------------------------------------------------------------
// cleanupHistoryObserver
// -----------------------------------------------------------------------

export async function cleanupHistoryObserver(ops: CdpBridgeOps): Promise<void> {
    try {
        await ops.conn.evaluate(
            'if(window.__historyCaptureObserver){window.__historyCaptureObserver.disconnect();delete window.__historyCaptureObserver;delete window.__historyCapture;}'
        );
    } catch (e) {
        logDebug(`CDP: cleanupHistoryObserver — ${e instanceof Error ? e.message : e}`);
    }
}

// -----------------------------------------------------------------------
// selectConversation
// -----------------------------------------------------------------------

export async function selectConversation(ops: CdpBridgeOps, index: number): Promise<boolean> {
    await ops.conn.connect();

    for (let i = 0; i < index; i++) {
        await ops.conn.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            windowsVirtualKeyCode: 40,
            code: 'ArrowDown',
            key: 'ArrowDown',
        });
        await ops.sleep(30);
        await ops.conn.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            windowsVirtualKeyCode: 40,
            code: 'ArrowDown',
            key: 'ArrowDown',
        });
        await ops.sleep(100);
    }

    await ops.conn.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        windowsVirtualKeyCode: 13,
        code: 'Enter',
        key: 'Enter',
    });
    await ops.sleep(30);
    await ops.conn.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 13,
        code: 'Enter',
        key: 'Enter',
    });

    logDebug(`CDP: selectConversation — selected index ${index}`);
    await ops.sleep(1000);
    ops.resetCascadeContext();
    return true;
}

// -----------------------------------------------------------------------
// closePopup
// -----------------------------------------------------------------------

export async function closePopup(ops: CdpBridgeOps): Promise<void> {
    await ops.conn.connect();

    await ops.conn.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        windowsVirtualKeyCode: 27,
        code: 'Escape',
        key: 'Escape',
    });
    await ops.sleep(30);
    await ops.conn.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 27,
        code: 'Escape',
        key: 'Escape',
    });

    logDebug('CDP: closePopup — sent Escape');
    await ops.sleep(300);
}
