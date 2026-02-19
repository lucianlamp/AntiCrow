// ---------------------------------------------------------------------------
// cdpUI.ts — UI要素のクリック・検出操作
// ---------------------------------------------------------------------------
// cdpBridge.ts から抽出。DOM スクリプトの注入でブラウザ内の
// 要素クリック・存在確認・待機を行う。
// ---------------------------------------------------------------------------

import { logDebug } from './logger';
import { ClickOptions, ClickResult } from './types';
import { CdpBridgeOps } from './cdpHistory';

// -----------------------------------------------------------------------
// clickElement
// -----------------------------------------------------------------------

export async function clickElement(
    ops: CdpBridgeOps,
    options: ClickOptions,
): Promise<ClickResult> {
    await ops.conn.connect();

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
        // 画面外の要素をビューポート内にスクロールしてからクリック
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch(e) {}
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
            result = await ops.evaluateInCascade(CLICK_SCRIPT);
        } else {
            result = await ops.conn.evaluate(CLICK_SCRIPT);
        }

        const clickResult = result as ClickResult;
        if (clickResult?.success) {
            logDebug(`CDP: clickElement success — method=${clickResult.method}, target=${clickResult.target}`);
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

// -----------------------------------------------------------------------
// waitForElement
// -----------------------------------------------------------------------

export async function waitForElement(
    ops: CdpBridgeOps,
    options: ClickOptions,
    timeoutMs: number = 5000,
    pollMs: number = 300,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const result = await clickElement(ops, { ...options });
        if (result.success) {
            return true;
        }
        await ops.sleep(pollMs);
    }

    return false;
}

// -----------------------------------------------------------------------
// checkElementExists
// -----------------------------------------------------------------------

export async function checkElementExists(
    ops: CdpBridgeOps,
    options: ClickOptions,
): Promise<boolean> {
    await ops.conn.connect();

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
        // 部分一致フォールバック（clickElement と同じロジック）
        match = findInTree(document, function(el) {
            var tag = el.tagName.toLowerCase();
            var isCorrectTag = tagToFind === '*' || tag === tagToFind.toLowerCase();
            if (!isCorrectTag) return false;
            var text = el.innerText || el.textContent || '';
            return text.indexOf(textToFind) >= 0 && isVisible(el);
        });
        if (match) return true;
    }

    return false;
})()
    `.trim();

    try {
        const inCascade = options.inCascade !== false;
        const result = inCascade
            ? await ops.evaluateInCascade(CHECK_SCRIPT)
            : await ops.conn.evaluate(CHECK_SCRIPT);
        return result === true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------
// clickExpandAll
// -----------------------------------------------------------------------

export async function clickExpandAll(
    ops: CdpBridgeOps,
): Promise<boolean> {
    // メインウィンドウ（inCascade: false）のセレクタ
    const mainSelectors = [
        '[aria-label="Expand All"]',
        '[title="Expand All"]',
        '.expand-all-button',
    ];

    for (const selector of mainSelectors) {
        try {
            const result = await clickElement(ops, {
                selector,
                inCascade: false,
            });
            if (result.success) {
                logDebug(`CDP: clickExpandAll succeeded — selector=${selector} (main window)`);
                return true;
            }
        } catch (e) {
            logDebug(`CDP: clickExpandAll selector "${selector}" failed — ${e instanceof Error ? e.message : e}`);
        }
    }

    // Cascade iframe 内の Expand ボタン（テキストマッチ）
    try {
        const result = await clickElement(ops, {
            text: 'Expand',
            tag: 'button',
            inCascade: true,
        });
        if (result.success) {
            logDebug('CDP: clickExpandAll succeeded — text="Expand" (cascade)');
            return true;
        }
    } catch (e) {
        logDebug(`CDP: clickExpandAll cascade Expand failed — ${e instanceof Error ? e.message : e}`);
    }

    logDebug('CDP: clickExpandAll — no Expand All button found');
    return false;
}

// -----------------------------------------------------------------------
// scrollToBottom — チャットエリアを最下部にスクロール
// -----------------------------------------------------------------------

export async function scrollToBottom(
    ops: CdpBridgeOps,
): Promise<boolean> {
    const SCROLL_SCRIPT = `
(function() {
    var scrolled = false;

    // 優先: "Scroll to bottom" ボタンをクリック（最も確実）
    var scrollBtn = document.querySelector('button[aria-label="Scroll to bottom"]');
    if (scrollBtn) {
        try {
            scrollBtn.click();
            scrolled = true;
        } catch(e) {}
    }

    // フォールバック: overflow-y-auto コンテナを最下部にスクロール
    if (!scrolled) {
        var containers = document.querySelectorAll('.overflow-y-auto, [class*="overflow-y-auto"]');
        for (var i = 0; i < containers.length; i++) {
            var el = containers[i];
            if (el.scrollHeight > el.clientHeight + 50) {
                el.scrollTop = el.scrollHeight;
                scrolled = true;
            }
        }
    }

    return { scrolled: scrolled };
})()
`;

    try {
        const result = await ops.evaluateInCascade(SCROLL_SCRIPT) as { scrolled: boolean } | null;
        if (result?.scrolled) {
            logDebug('CDP: scrollToBottom succeeded');
            return true;
        }
    } catch (e) {
        logDebug(`CDP: scrollToBottom failed — ${e instanceof Error ? e.message : e}`);
    }

    return false;
}

// -----------------------------------------------------------------------
// dismissReviewUI — Antigravity のレビュー提案パネルを自動 Accept/Dismiss
// -----------------------------------------------------------------------

export async function dismissReviewUI(
    ops: CdpBridgeOps,
): Promise<boolean> {
    // メインウィンドウ（inCascade: false）でレビューUI を探す
    const DISMISS_SCRIPT = `
(function() {
    // "Accept All" や "Accept" ボタンを探してクリック
    var buttons = document.querySelectorAll('button');
    var dismissed = 0;
    for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        var text = (btn.textContent || '').trim().toLowerCase();
        var ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text === 'accept all' || text === 'accept' || text === 'dismiss' ||
            ariaLabel.includes('accept all') || ariaLabel.includes('dismiss')) {
            // レビュー系ボタンのみ対象にするため、特定のコンテキストを確認
            var parent = btn.closest('[class*="review"], [class*="diff"], [class*="notification"], [class*="inline-chat"]');
            if (parent) {
                try {
                    btn.scrollIntoView({ block: 'center', behavior: 'instant' });
                    btn.click();
                    dismissed++;
                } catch(e) {}
            }
        }
    }
    return { dismissed: dismissed };
})()
`;

    try {
        // メインウィンドウで実行（レビューUIはCascade外にある）
        const result = await ops.evaluateInCascade(DISMISS_SCRIPT) as { dismissed: number } | null;
        if (result && result.dismissed > 0) {
            logDebug(`CDP: dismissReviewUI — dismissed ${result.dismissed} review panel(s)`);
            return true;
        }
    } catch (e) {
        logDebug(`CDP: dismissReviewUI failed — ${e instanceof Error ? e.message : e}`);
    }

    return false;
}

// -----------------------------------------------------------------------
// autoFollowOutput — AI出力追従（スクロール + 展開 + レビューUI消去）
// -----------------------------------------------------------------------

export async function autoFollowOutput(
    ops: CdpBridgeOps,
): Promise<void> {
    // 1. チャットエリアを最下部にスクロール
    await scrollToBottom(ops);

    // 2. 折りたたまれたセクションを展開
    await clickExpandAll(ops);

    // 3. レビューUI を自動 Dismiss
    await dismissReviewUI(ops);

    logDebug('CDP: autoFollowOutput completed');
}
