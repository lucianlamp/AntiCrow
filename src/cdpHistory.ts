// ---------------------------------------------------------------------------
// cdpHistory.ts — 会話履歴ポップアップ操作ヘルパー
// ---------------------------------------------------------------------------
// cdpBridge.ts から分離した履歴操作の実装。
// CdpBridgeOps インターフェース経由で CdpBridge の内部機能にアクセスする。
//
// 2026-02-20: 全関数を実機 DOM 調査結果に基づいてリライト。
//   - openHistoryPopup: data-tooltip-id="history-tooltip" ベースに変更
//   - getConversationList: サイドバー内 BUTTON 要素のスクレイピングに変更
//   - openHistoryAndGetList: 上記2つの統合版をリライト
//   - selectConversation: ArrowDown/Enter → 直接 BUTTON クリックに変更
//   - closePopup: history-tooltip トグルに変更
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

/** セクション別の会話情報 */
export interface ConversationSection {
    section: 'current' | 'workspace' | 'other';
    sectionLabel: string;
    items: { title: string; index: number; globalIndex: number; timeAgo?: string }[];
}

// -----------------------------------------------------------------------
// openHistoryPopup
// -----------------------------------------------------------------------

/**
 * 履歴パネルを開く（トグル）。
 *
 * DOM 構造（実機調査結果 2026-02-20）:
 *   - 履歴ボタン: <A data-tooltip-id="history-tooltip">
 *   - クリックするとサイドバーに会話リストが展開される
 */
export async function openHistoryPopup(ops: CdpBridgeOps): Promise<void> {
    await ops.conn.connect();

    const CLICK_HISTORY = `
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

    // 戦略0（最優先）: data-tooltip-id="history-tooltip"
    var btn = doc.querySelector('[data-tooltip-id="history-tooltip"]');
    if (btn) {
        btn.click();
        return { success: true, method: 'tooltip-id', tag: btn.tagName, inIframe: doc !== document };
    }

    // 戦略1: data-past-conversations-toggle 属性
    var toggle = doc.querySelector('[data-past-conversations-toggle]');
    if (toggle) {
        toggle.click();
        return { success: true, method: 'past-conversations-toggle', tag: toggle.tagName, inIframe: doc !== document };
    }

    // 戦略2: テキスト/アイコンベースのフォールバック
    var anchors = doc.querySelectorAll('a');
    for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var rect = a.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            var svg = a.querySelector('svg');
            if (svg && a.closest('[class*="header"]')) {
                var tooltipId = a.getAttribute('data-tooltip-id') || '';
                if (tooltipId.indexOf('history') >= 0) {
                    a.click();
                    return { success: true, method: 'heuristic-header-link', tooltipId: tooltipId, inIframe: doc !== document };
                }
            }
        }
    }

    return { success: false, error: 'History button not found', inIframe: doc !== document };
})()
    `.trim();

    try {
        const result = await ops.evaluateInCascade(CLICK_HISTORY) as {
            success: boolean;
            method?: string;
            tag?: string;
            tooltipId?: string;
            error?: string;
        };

        if (result?.success) {
            logDebug(`CDP: openHistoryPopup — clicked (method=${result.method}, tag=${result.tag || 'N/A'})`);
        } else {
            logWarn(`CDP: openHistoryPopup — not found: ${result?.error || 'unknown'}`);
        }
    } catch (e) {
        logWarn(`CDP: openHistoryPopup — failed: ${e instanceof Error ? e.message : e}`);
    }

    await ops.sleep(1500);
}

// -----------------------------------------------------------------------
// getConversationList
// -----------------------------------------------------------------------

/**
 * 会話一覧を取得する。
 *
 * DOM 構造（実機調査結果 2026-02-20）:
 *   DIV.mt-2.flex.flex-col (会話リストコンテナ)
 *     ├── BUTTON.group (会話アイテム)
 *     │    ├── DIV.flex.grow.items-baseline (タイトル)
 *     │    ├── P.text-nowrap (時間: "1h", "2d" 等)
 *     │    └── P.hidden (削除アイコン SVG)
 *     ├── BUTTON.group (会話アイテム)
 *     └── ...
 *
 * 各会話アイテムの削除ボタンに data-tooltip-id="{uuid}-delete-conversation"
 * が付与されているため、これを目印にして会話アイテムを特定する。
 */
export async function getConversationList(ops: CdpBridgeOps): Promise<{ title: string; index: number; timeAgo?: string }[]> {
    await ops.conn.connect();

    const SCRAPE_CONVERSATIONS = `
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
    var result = { success: false, items: [], debugInfo: { inIframe: doc !== document } };

    // Shadow DOM 再帰探索ヘルパー
    function findAllInTree(root, predicate) {
        if (!root) return [];
        var matches = [];
        var ownerDoc = root.ownerDocument || root;
        if (root.nodeType === 1 && predicate(root)) matches.push(root);
        var walker = (ownerDoc.createTreeWalker || document.createTreeWalker).call(ownerDoc, root, 1, null, false);
        var el;
        while ((el = walker.nextNode())) {
            if (predicate(el)) matches.push(el);
            if (el.shadowRoot) {
                matches = matches.concat(findAllInTree(el.shadowRoot, predicate));
            }
        }
        return matches;
    }

    // 戦略0: delete-conversation tooltip-id を持つ SVG の親 BUTTON を探す
    var deleteIcons = doc.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
    // Shadow DOM フォールバック
    if (deleteIcons.length === 0) {
        deleteIcons = findAllInTree(doc, function(el) {
            var tid = el.getAttribute && el.getAttribute('data-tooltip-id');
            return tid && tid.indexOf('delete-conversation') >= 0;
        });
    }
    result.debugInfo.deleteIconCount = deleteIcons.length;

    if (deleteIcons.length > 0) {
        var buttons = [];
        for (var i = 0; i < deleteIcons.length; i++) {
            var btn = deleteIcons[i].closest('button');
            if (btn && buttons.indexOf(btn) === -1) {
                buttons.push(btn);
            }
        }

        result.debugInfo.buttonCount = buttons.length;
        var items = [];
        for (var j = 0; j < buttons.length; j++) {
            var button = buttons[j];
            var titleEl = button.querySelector('div');
            var text = '';
            var timeAgo = '';
            if (titleEl) {
                var spans = titleEl.querySelectorAll('span, p');
                var parts = [];
                for (var k = 0; k < spans.length; k++) {
                    var span = spans[k];
                    if (span.tagName === 'P' && (span.className || '').indexOf('text-nowrap') >= 0) {
                        timeAgo = (span.textContent || '').trim();
                        continue;
                    }
                    if (span.tagName === 'P' && (span.className || '').indexOf('hidden') >= 0) continue;
                    var t = (span.textContent || '').trim();
                    if (t) parts.push(t);
                }
                text = parts.join(' ').trim();
            }
            if (!text) {
                var cloned = button.cloneNode(true);
                var pTags = cloned.querySelectorAll('p');
                for (var m = 0; m < pTags.length; m++) { pTags[m].remove(); }
                text = (cloned.textContent || '').trim();
            }
            if (text.length > 0) {
                var item = { title: text.substring(0, 100), index: j };
                if (timeAgo) item.timeAgo = timeAgo;
                items.push(item);
            }
        }
        if (items.length > 0) {
            result.success = true;
            result.items = items;
            return result;
        }
    }

    // 戦略1: group クラスの BUTTON を直接探す
    var groupButtons = doc.querySelectorAll('button.group[class*="cursor-pointer"][class*="flex-row"]');
    // Shadow DOM フォールバック
    if (!groupButtons || groupButtons.length === 0) {
        groupButtons = findAllInTree(doc, function(el) {
            if (el.tagName !== 'BUTTON') return false;
            var cls = el.className || '';
            return cls.indexOf('group') >= 0 && cls.indexOf('cursor-pointer') >= 0 && cls.indexOf('flex-row') >= 0;
        });
    }
    result.debugInfo.groupButtonCount = groupButtons ? groupButtons.length : 0;
    if (groupButtons && groupButtons.length > 0) {
        var items2 = [];
        for (var n = 0; n < groupButtons.length; n++) {
            var gb = groupButtons[n];
            var titleDiv = gb.querySelector('div');
            var txt = titleDiv ? (titleDiv.textContent || '').trim() : (gb.textContent || '').trim();
            if (txt.length > 0) {
                items2.push({ title: txt.substring(0, 100), index: n });
            }
        }
        if (items2.length > 0) {
            result.success = true;
            result.items = items2;
            return result;
        }
    }

    // 戦略2: 汎用 — 会話リストエリア内の全 BUTTON / A 要素をスキャン
    // (CSS クラスや tooltip 属性に依存しないフォールバック)
    var allButtons = doc.querySelectorAll('button, a');
    var candidateItems = [];
    for (var bi = 0; bi < allButtons.length; bi++) {
        var candidate = allButtons[bi];
        // 最低限のフィルタ: テキストがある + 可視 + 会話っぽいサイズ
        var cRect = candidate.getBoundingClientRect();
        if (cRect.width < 50 || cRect.height < 20) continue;
        var cText = (candidate.textContent || '').trim();
        if (cText.length < 2 || cText.length > 200) continue;
        // ナビゲーション系ボタンを除外
        var cTid = candidate.getAttribute('data-tooltip-id') || '';
        if (cTid === 'history-tooltip' || cTid === 'send-tooltip' || cTid === 'cancel-tooltip') continue;
        if (cTid === 'new-conversation-tooltip') continue;
        // 親に scrollable なコンテナがあるか (会話リストは通常スクロール可能)
        var scrollParent = candidate.parentElement;
        var inScrollArea = false;
        for (var sp = 0; sp < 10 && scrollParent; sp++) {
            var overflowY = '';
            try {
                var win = scrollParent.ownerDocument.defaultView || window;
                overflowY = win.getComputedStyle(scrollParent).overflowY || '';
            } catch(e2) {}
            if (overflowY === 'auto' || overflowY === 'scroll') { inScrollArea = true; break; }
            scrollParent = scrollParent.parentElement;
        }
        if (!inScrollArea) continue;
        candidateItems.push({ title: cText.substring(0, 100), index: candidateItems.length });
    }
    result.debugInfo.genericCandidateCount = candidateItems.length;
    if (candidateItems.length > 0) {
        result.success = true;
        result.items = candidateItems;
        return result;
    }

    // DOM ダンプ診断: 最初の 5 つの button 要素の情報を収集
    var diagButtons = doc.querySelectorAll('button');
    var diagInfo = [];
    for (var di = 0; di < Math.min(diagButtons.length, 10); di++) {
        var db = diagButtons[di];
        diagInfo.push({
            tag: db.tagName,
            text: (db.textContent || '').trim().substring(0, 60),
            cls: (db.className || '').substring(0, 100),
            tooltipId: db.getAttribute('data-tooltip-id') || '',
            rect: { w: Math.round(db.getBoundingClientRect().width), h: Math.round(db.getBoundingClientRect().height) }
        });
    }
    result.debugInfo.totalButtonsInDoc = diagButtons.length;
    result.debugInfo.sampleButtons = diagInfo;
    result.debugInfo.error = 'No conversation items found (all 3 strategies failed)';
    return result;
})()
    `.trim();

    for (const [label, evaluator] of [
        ['cascade', () => ops.evaluateInCascade(SCRAPE_CONVERSATIONS)],
        ['main', () => ops.conn.evaluate(SCRAPE_CONVERSATIONS)],
    ] as [string, () => Promise<unknown>][]) {
        try {
            const result = await evaluator() as {
                success: boolean;
                items: { title: string; index: number; timeAgo?: string }[];
                debugInfo?: unknown;
            };

            if (result?.success && result.items.length > 0) {
                logDebug(`CDP: getConversationList — found ${result.items.length} conversations in ${label} context`);
                logDebug(`CDP: getConversationList debugInfo (${label}): ${JSON.stringify(result.debugInfo)}`);
                return result.items;
            }

            logDebug(`CDP: getConversationList (${label}) — no items, debugInfo: ${JSON.stringify(result?.debugInfo)}`);
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

/**
 * 履歴パネルを開いて会話一覧を取得する統合版。
 *
 * 1. MutationObserver を設置して会話アイテムの出現を監視
 * 2. history-tooltip をクリックしてパネルを開く
 * 3. ポーリングで会話アイテムをスクレイピング
 */
export async function openHistoryAndGetList(ops: CdpBridgeOps): Promise<{ title: string; index: number; timeAgo?: string }[]> {
    await ops.conn.connect();

    // --- Step 1: MutationObserver を設置 ---
    const INSTALL_OBSERVER = `
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

    if (window.__historyCaptureObserver) {
        try { window.__historyCaptureObserver.disconnect(); } catch(e) {}
    }
    window.__historyCapture = { items: [], captured: false, events: 0, diag: [], inIframe: doc !== document };

    // Shadow DOM 再帰探索ヘルパー
    function findAllInTree(root, predicate) {
        if (!root) return [];
        var matches = [];
        var ownerDoc = root.ownerDocument || root;
        if (root.nodeType === 1 && predicate(root)) matches.push(root);
        var walker = (ownerDoc.createTreeWalker || document.createTreeWalker).call(ownerDoc, root, 1, null, false);
        var el;
        while ((el = walker.nextNode())) {
            if (predicate(el)) matches.push(el);
            if (el.shadowRoot) {
                matches = matches.concat(findAllInTree(el.shadowRoot, predicate));
            }
        }
        return matches;
    }

    function scrapeConversations() {
        var deleteIcons = doc.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
        // Shadow DOM フォールバック
        if (deleteIcons.length === 0) {
            deleteIcons = findAllInTree(doc, function(el) {
                var tid = el.getAttribute && el.getAttribute('data-tooltip-id');
                return tid && tid.indexOf('delete-conversation') >= 0;
            });
        }

        if (deleteIcons.length > 0) {
            var buttons = [];
            for (var i = 0; i < deleteIcons.length; i++) {
                var btn = deleteIcons[i].closest('button');
                if (btn && buttons.indexOf(btn) === -1) {
                    buttons.push(btn);
                }
            }

            if (buttons.length > 0) {
                var items = [];
                for (var j = 0; j < buttons.length; j++) {
                    var button = buttons[j];
                    var titleEl = button.querySelector('div');
                    var text = '';
                    var timeAgo2 = '';
                    if (titleEl) {
                        var spans = titleEl.querySelectorAll('span, p');
                        var parts = [];
                        for (var k = 0; k < spans.length; k++) {
                            var span = spans[k];
                            if (span.tagName === 'P' && (span.className || '').indexOf('text-nowrap') >= 0) {
                                timeAgo2 = (span.textContent || '').trim();
                                continue;
                            }
                            if (span.tagName === 'P' && (span.className || '').indexOf('hidden') >= 0) continue;
                            var t = (span.textContent || '').trim();
                            if (t) parts.push(t);
                        }
                        text = parts.join(' ').trim();
                    }
                    if (!text) {
                        var cloned = button.cloneNode(true);
                        var pTags = cloned.querySelectorAll('p');
                        for (var m = 0; m < pTags.length; m++) { pTags[m].remove(); }
                        text = (cloned.textContent || '').trim();
                    }
                    if (text.length > 0) {
                        var item2 = { title: text.substring(0, 100), index: j };
                        if (timeAgo2) item2.timeAgo = timeAgo2;
                        items.push(item2);
                    }
                }

                if (items.length > 0 && !window.__historyCapture.captured) {
                    window.__historyCapture.items = items;
                    window.__historyCapture.captured = true;
                    return;
                }
            } else {
                window.__historyCapture.diag.push('no_parent_buttons');
            }
        } else {
            window.__historyCapture.diag.push('no_delete_icons');
        }

        // フォールバック: スクロール可能エリア内のボタン/リンクをスキャン
        if (!window.__historyCapture.captured) {
            var allBtns = doc.querySelectorAll('button, a');
            var fallbackItems = [];
            for (var fi2 = 0; fi2 < allBtns.length; fi2++) {
                var cand = allBtns[fi2];
                var cR = cand.getBoundingClientRect();
                if (cR.width < 50 || cR.height < 20) continue;
                var cTxt = (cand.textContent || '').trim();
                if (cTxt.length < 2 || cTxt.length > 200) continue;
                var ctid = cand.getAttribute('data-tooltip-id') || '';
                if (ctid === 'history-tooltip' || ctid === 'send-tooltip' || ctid === 'cancel-tooltip' || ctid === 'new-conversation-tooltip') continue;
                var sp2 = cand.parentElement;
                var inScroll = false;
                for (var si = 0; si < 10 && sp2; si++) {
                    try {
                        var w2 = sp2.ownerDocument.defaultView || window;
                        var ov = w2.getComputedStyle(sp2).overflowY || '';
                        if (ov === 'auto' || ov === 'scroll') { inScroll = true; break; }
                    } catch(e3) {}
                    sp2 = sp2.parentElement;
                }
                if (!inScroll) continue;
                fallbackItems.push({ title: cTxt.substring(0, 100), index: fallbackItems.length });
            }
            if (fallbackItems.length > 0) {
                window.__historyCapture.items = fallbackItems;
                window.__historyCapture.captured = true;
                window.__historyCapture.diag.push('generic_fallback_used');
            }
        }
    }

    var observer = new MutationObserver(function() {
        window.__historyCapture.events++;
        scrapeConversations();
    });

    var observeTarget = (doc === document) ? document.body : (doc.body || doc.documentElement);
    observer.observe(observeTarget, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'aria-hidden']
    });
    window.__historyCaptureObserver = observer;

    scrapeConversations();

    return { success: true, inIframe: doc !== document };
})()
    `.trim();

    try {
        await ops.evaluateInCascade(INSTALL_OBSERVER);
        logDebug('CDP: openHistoryAndGetList — installed MutationObserver in cascade');
    } catch (e) {
        logWarn(`CDP: openHistoryAndGetList — failed to install observer: ${e instanceof Error ? e.message : e}`);
    }

    // --- Step 2: 履歴ボタンをクリック ---
    const CLICK_HISTORY2 = `
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

    var btn = doc.querySelector('[data-tooltip-id="history-tooltip"]');
    if (btn) {
        btn.click();
        return { success: true, method: 'tooltip-id', tag: btn.tagName, inIframe: doc !== document };
    }
    var toggle = doc.querySelector('[data-past-conversations-toggle]');
    if (toggle) {
        toggle.click();
        return { success: true, method: 'past-conversations-toggle', tag: toggle.tagName, inIframe: doc !== document };
    }

    // Shadow DOM 再帰探索フォールバック
    function findFirstInTree(root, predicate) {
        if (!root) return null;
        var ownerDoc = root.ownerDocument || root;
        if (root.nodeType === 1 && predicate(root)) return root;
        var walker = (ownerDoc.createTreeWalker || document.createTreeWalker).call(ownerDoc, root, 1, null, false);
        var el;
        while ((el = walker.nextNode())) {
            if (predicate(el)) return el;
            if (el.shadowRoot) {
                var found = findFirstInTree(el.shadowRoot, predicate);
                if (found) return found;
            }
        }
        return null;
    }

    var shadowBtn = findFirstInTree(doc, function(el) {
        return el.getAttribute && el.getAttribute('data-tooltip-id') === 'history-tooltip';
    });
    if (shadowBtn) {
        shadowBtn.click();
        return { success: true, method: 'shadow-tooltip-id', tag: shadowBtn.tagName, inIframe: doc !== document };
    }
    var shadowToggle = findFirstInTree(doc, function(el) {
        return el.getAttribute && el.hasAttribute('data-past-conversations-toggle');
    });
    if (shadowToggle) {
        shadowToggle.click();
        return { success: true, method: 'shadow-past-conversations-toggle', tag: shadowToggle.tagName, inIframe: doc !== document };
    }
    return { success: false, error: 'History button not found', inIframe: doc !== document };
})()
    `.trim();

    try {
        const clickResult = await ops.evaluateInCascade(CLICK_HISTORY2) as {
            success: boolean;
            method?: string;
            tag?: string;
            error?: string;
        };

        if (clickResult?.success) {
            logDebug(`CDP: openHistoryAndGetList — clicked history (method=${clickResult.method})`);
        } else {
            logWarn(`CDP: openHistoryAndGetList — history button not found: ${clickResult?.error || 'unknown'}`);
            await cleanupHistoryObserver(ops);
            return [];
        }
    } catch (e) {
        logWarn(`CDP: openHistoryAndGetList — failed to click: ${e instanceof Error ? e.message : e}`);
        await cleanupHistoryObserver(ops);
        return [];
    }

    // --- Step 3: ポーリング ---
    const READ_CAPTURE = `
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
    var c = window.__historyCapture || { items: [], captured: false, events: 0, diag: [] };
    var deleteIcons = doc.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
    // Shadow DOM フォールバック
    if (deleteIcons.length === 0) {
        function findAllInTree(root, predicate) {
            if (!root) return [];
            var matches = [];
            var ownerDoc = root.ownerDocument || root;
            if (root.nodeType === 1 && predicate(root)) matches.push(root);
            var walker = (ownerDoc.createTreeWalker || document.createTreeWalker).call(ownerDoc, root, 1, null, false);
            var el;
            while ((el = walker.nextNode())) {
                if (predicate(el)) matches.push(el);
                if (el.shadowRoot) { matches = matches.concat(findAllInTree(el.shadowRoot, predicate)); }
            }
            return matches;
        }
        deleteIcons = findAllInTree(doc, function(el) {
            var tid = el.getAttribute && el.getAttribute('data-tooltip-id');
            return tid && tid.indexOf('delete-conversation') >= 0;
        });
    }
    return {
        captured: c.captured,
        items: c.items,
        events: c.events,
        diag: c.diag,
        deleteIconCount: deleteIcons.length,
        inIframe: doc !== document,
    };
})()
    `.trim();

    const POLL_INTERVAL_MS = 80;
    const POLL_TIMEOUT_MS = 6000;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let pollCount = 0;

    type CaptureResult = {
        captured: boolean;
        items: { title: string; index: number; timeAgo?: string }[];
        events: number;
        diag: string[];
        deleteIconCount: number;
    };

    while (Date.now() < deadline) {
        pollCount++;
        try {
            const result = await ops.evaluateInCascade(READ_CAPTURE) as CaptureResult;

            if (pollCount === 1 || pollCount % 10 === 0) {
                logDebug(`CDP: openHistoryAndGetList poll #${pollCount} — captured=${result?.captured}, events=${result?.events}, deleteIcons=${result?.deleteIconCount}, diag=${JSON.stringify(result?.diag)}`);
            }

            if (result?.captured && result.items.length > 0) {
                logDebug(`CDP: openHistoryAndGetList — captured ${result.items.length} conversations (poll #${pollCount}, events=${result.events})`);
                await cleanupHistoryObserver(ops);
                return result.items;
            }
        } catch (e) {
            logDebug(`CDP: openHistoryAndGetList polling exception — ${e instanceof Error ? e.message : e}`);
        }
        await ops.sleep(POLL_INTERVAL_MS);
    }

    // タイムアウト — 最後にもう一度直接スクレイピングを試行
    try {
        const directResult = await getConversationList(ops);
        if (directResult.length > 0) {
            logDebug(`CDP: openHistoryAndGetList — timeout but direct scrape found ${directResult.length} conversations`);
            await cleanupHistoryObserver(ops);
            return directResult;
        }
    } catch (e) { /* ignore */ }

    // 本当にタイムアウト
    try {
        const finalResult = await ops.evaluateInCascade(READ_CAPTURE) as CaptureResult;
        logWarn(`CDP: openHistoryAndGetList — timeout after ${pollCount} polls. events=${finalResult?.events}, deleteIcons=${finalResult?.deleteIconCount}, diag=${JSON.stringify(finalResult?.diag)}`);
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
        await ops.evaluateInCascade(
            'if(window.__historyCaptureObserver){window.__historyCaptureObserver.disconnect();delete window.__historyCaptureObserver;delete window.__historyCapture;}'
        );
    } catch (e) {
        logDebug(`CDP: cleanupHistoryObserver — ${e instanceof Error ? e.message : e}`);
    }
}

// -----------------------------------------------------------------------
// openHistoryAndGetSections (セクション別取得)
// -----------------------------------------------------------------------

/**
 * 履歴パネルを開いて会話一覧をセクション別に取得する。
 *
 * パネルには3つのセクションがある:
 *   - Current: 現在の会話
 *   - Recent in {workspace}: ワークスペース固有の履歴（★メイン対象）
 *   - Other Conversations: 他ワークスペースの履歴
 *
 * "Show X more..." リンクも自動クリックして全件展開する。
 */
export async function openHistoryAndGetSections(ops: CdpBridgeOps): Promise<ConversationSection[]> {
    // まず履歴パネルを開いて全会話を取得
    const allItems = await openHistoryAndGetList(ops);
    if (allItems.length === 0) {
        return [];
    }

    // --- "Show X more..." リンクをクリックして展開 ---
    const CLICK_SHOW_MORE = `
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
    // "Show X more..." リンクを探す（workspace セクション内のもの）
    var allLinks = doc.querySelectorAll('button, a, div, span, p');
    var clicked = 0;
    for (var i = 0; i < allLinks.length; i++) {
        var el = allLinks[i];
        var text = (el.textContent || '').trim();
        if (/^Show \\d+ more/i.test(text)) {
            el.click();
            clicked++;
        }
    }
    return { clicked: clicked };
})()
    `.trim();

    try {
        const clickResult = await ops.evaluateInCascade(CLICK_SHOW_MORE) as { clicked: number };
        if (clickResult?.clicked > 0) {
            logDebug(`CDP: openHistoryAndGetSections — clicked ${clickResult.clicked} "Show more" links`);
            await ops.sleep(800);
        }
    } catch (e) {
        logDebug(`CDP: openHistoryAndGetSections — show more click failed: ${e instanceof Error ? e.message : e}`);
    }

    // --- セクション別にスクレイピング ---
    const SCRAPE_SECTIONS = `
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

    // 会話リストのスクロール可能コンテナを特定
    var scrollContainers = doc.querySelectorAll('[class*="overflow"]');
    var listContainer = null;
    for (var sc = 0; sc < scrollContainers.length; sc++) {
        var container = scrollContainers[sc];
        var win = container.ownerDocument.defaultView || window;
        var ov = '';
        try { ov = win.getComputedStyle(container).overflowY || ''; } catch(e) {}
        if (ov === 'auto' || ov === 'scroll') {
            // 会話リストのコンテナは delete-conversation tooltip-id を持つ要素を含む
            if (container.querySelector('[data-tooltip-id*="delete-conversation"]')) {
                listContainer = container;
                break;
            }
        }
    }

    if (!listContainer) {
        // フォールバック: delete-conversation を含む最も近い祖先のスクロールコンテナ
        var anyDelete = doc.querySelector('[data-tooltip-id*="delete-conversation"]');
        if (anyDelete) {
            var parent = anyDelete.parentElement;
            for (var sp = 0; sp < 15 && parent; sp++) {
                var win2 = parent.ownerDocument.defaultView || window;
                try {
                    var ov2 = win2.getComputedStyle(parent).overflowY || '';
                    if (ov2 === 'auto' || ov2 === 'scroll') { listContainer = parent; break; }
                } catch(e2) {}
                parent = parent.parentElement;
            }
        }
    }

    if (!listContainer) {
        return { success: false, error: 'list container not found', sections: [] };
    }

    // セクションヘッダーとボタンを順番に走査
    var sections = [];
    var currentSection = { section: 'unknown', label: '', items: [] };
    var globalIdx = 0;

    // コンテナ内の全子要素をフラットに走査
    function walkChildren(node) {
        var results = [];
        var children = node.children || [];
        for (var ci = 0; ci < children.length; ci++) {
            results.push(children[ci]);
        }
        return results;
    }

    // セクションヘッダーかどうかを判定
    function classifySectionHeader(text) {
        var t = text.toLowerCase().trim();
        if (t === 'current') return 'current';
        if (t.indexOf('recent in') === 0) return 'workspace';
        if (t === 'other conversations') return 'other';
        return null;
    }

    // 再帰的に全要素を浅い順に走査して、セクションヘッダーとボタンを検出
    function processContainer(container) {
        var children = container.children || [];
        for (var ci = 0; ci < children.length; ci++) {
            var child = children[ci];
            var tag = (child.tagName || '').toUpperCase();
            var text = (child.textContent || '').trim();

            // "Show X more..." リンクはスキップ
            if (/^Show \\d+ more/i.test(text)) continue;

            // セクションヘッダー判定: 短いテキスト（50文字以下）で delete-conversation を含まない要素
            if (text.length > 0 && text.length <= 50 && !child.querySelector('[data-tooltip-id*="delete-conversation"]')) {
                var sectionType = classifySectionHeader(text);
                if (sectionType) {
                    // 前のセクションを保存
                    if (currentSection.items.length > 0 || currentSection.section !== 'unknown') {
                        sections.push({ section: currentSection.section, sectionLabel: currentSection.label, items: currentSection.items });
                    }
                    currentSection = { section: sectionType, label: text, items: [] };
                    continue;
                }
            }

            // 会話ボタン判定: delete-conversation tooltip を含む
            var deleteIcon = child.querySelector('[data-tooltip-id*="delete-conversation"]');
            if (!deleteIcon && tag === 'BUTTON') {
                // ボタン自身が delete tooltip を持つか
                var tid = child.getAttribute('data-tooltip-id') || '';
                if (tid.indexOf('delete-conversation') >= 0) deleteIcon = child;
            }

            if (deleteIcon) {
                // これは会話アイテム
                var btn = deleteIcon.closest('button') || child;
                var titleEl = btn.querySelector('div');
                var convText = '';
                var timeAgo = '';
                if (titleEl) {
                    var spans = titleEl.querySelectorAll('span, p');
                    var parts = [];
                    for (var k = 0; k < spans.length; k++) {
                        var span = spans[k];
                        if (span.tagName === 'P' && (span.className || '').indexOf('text-nowrap') >= 0) {
                            timeAgo = (span.textContent || '').trim();
                            continue;
                        }
                        if (span.tagName === 'P' && (span.className || '').indexOf('hidden') >= 0) continue;
                        var st = (span.textContent || '').trim();
                        if (st) parts.push(st);
                    }
                    convText = parts.join(' ').trim();
                }
                if (!convText) {
                    var cloned = btn.cloneNode(true);
                    var pTags = cloned.querySelectorAll('p');
                    for (var m = 0; m < pTags.length; m++) { pTags[m].remove(); }
                    convText = (cloned.textContent || '').trim();
                }
                if (convText.length > 0) {
                    var item = { title: convText.substring(0, 100), index: currentSection.items.length, globalIndex: globalIdx, timeAgo: timeAgo || undefined };
                    currentSection.items.push(item);
                    globalIdx++;
                }
            } else if (child.children && child.children.length > 0) {
                // 子要素を再帰的に走査（DIV ラッパーの中身を探索）
                processContainer(child);
            }
        }
    }

    processContainer(listContainer);

    // 最後のセクションを追加
    if (currentSection.items.length > 0 || currentSection.section !== 'unknown') {
        sections.push({ section: currentSection.section, sectionLabel: currentSection.label, items: currentSection.items });
    }

    return { success: true, sections: sections, totalItems: globalIdx };
})()
    `.trim();

    for (const [label, evaluator] of [
        ['cascade', () => ops.evaluateInCascade(SCRAPE_SECTIONS)],
        ['main', () => ops.conn.evaluate(SCRAPE_SECTIONS)],
    ] as [string, () => Promise<unknown>][]) {
        try {
            const result = await evaluator() as {
                success: boolean;
                sections: ConversationSection[];
                totalItems: number;
                error?: string;
            };

            if (result?.success && result.sections.length > 0) {
                logDebug(`CDP: openHistoryAndGetSections — found ${result.sections.length} sections (${result.totalItems} total items) in ${label} context`);
                for (const sec of result.sections) {
                    logDebug(`  section: ${sec.section} (${sec.sectionLabel}) — ${sec.items.length} items`);
                }
                return result.sections;
            }

            logDebug(`CDP: openHistoryAndGetSections (${label}) — no sections, error: ${result?.error || 'unknown'}`);
        } catch (e) {
            logDebug(`CDP: openHistoryAndGetSections (${label}) exception — ${e instanceof Error ? e.message : e}`);
        }
    }

    // フォールバック: セクション分けできない場合は全アイテムを workspace セクションとして返す
    logDebug('CDP: openHistoryAndGetSections — fallback to flat list as workspace section');
    return [{
        section: 'workspace',
        sectionLabel: 'Recent',
        items: allItems.map((item, i) => ({ ...item, globalIndex: item.index, index: i })),
    }];
}

// -----------------------------------------------------------------------
// debugConversationAttributes (DOM 属性調査用)
// -----------------------------------------------------------------------

/**
 * 会話アイテム BUTTON 要素の全属性を収集するデバッグ関数。
 * ワークスペースフィルタリングに使える属性がないか調査する。
 */
export async function debugConversationAttributes(ops: CdpBridgeOps): Promise<unknown> {
    await ops.conn.connect();

    const DEBUG_SCRIPT = `
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
    var result = { buttonCount: 0, items: [], inIframe: doc !== document };
    var deleteIcons = doc.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
    if (deleteIcons.length === 0) return { error: 'no delete icons found', inIframe: doc !== document };

    var buttons = [];
    for (var i = 0; i < deleteIcons.length; i++) {
        var btn = deleteIcons[i].closest('button');
        if (btn && buttons.indexOf(btn) === -1) buttons.push(btn);
    }
    result.buttonCount = buttons.length;

    for (var j = 0; j < Math.min(buttons.length, 5); j++) {
        var button = buttons[j];
        var attrs = {};
        for (var k = 0; k < button.attributes.length; k++) {
            var attr = button.attributes[k];
            attrs[attr.name] = attr.value.substring(0, 200);
        }
        var parentAttrs = {};
        if (button.parentElement) {
            for (var m = 0; m < button.parentElement.attributes.length; m++) {
                var pAttr = button.parentElement.attributes[m];
                parentAttrs[pAttr.name] = pAttr.value.substring(0, 200);
            }
        }
        var grandparentAttrs = {};
        if (button.parentElement && button.parentElement.parentElement) {
            var gp = button.parentElement.parentElement;
            for (var n = 0; n < gp.attributes.length; n++) {
                var gpAttr = gp.attributes[n];
                grandparentAttrs[gpAttr.name] = gpAttr.value.substring(0, 200);
            }
        }
        var titleEl = button.querySelector('div');
        var title = titleEl ? (titleEl.textContent || '').trim().substring(0, 50) : '';

        result.items.push({
            index: j,
            title: title,
            buttonAttrs: attrs,
            parentTag: button.parentElement ? button.parentElement.tagName : null,
            parentAttrs: parentAttrs,
            grandparentTag: button.parentElement && button.parentElement.parentElement ? button.parentElement.parentElement.tagName : null,
            grandparentAttrs: grandparentAttrs,
            ariaCurrent: button.getAttribute('aria-current'),
            ariaSelected: button.getAttribute('aria-selected'),
            ariaLabel: button.getAttribute('aria-label'),
            hasDataWorkspace: !!button.dataset.workspace,
            className: (button.className || '').substring(0, 200),
        });
    }

    return result;
})()
    `.trim();

    for (const [label, evaluator] of [
        ['cascade', () => ops.evaluateInCascade(DEBUG_SCRIPT)],
        ['main', () => ops.conn.evaluate(DEBUG_SCRIPT)],
    ] as [string, () => Promise<unknown>][]) {
        try {
            const result = await evaluator();
            if (result) {
                logDebug(`CDP: debugConversationAttributes (${label}): ${JSON.stringify(result)}`);
                return result;
            }
        } catch (e) {
            logDebug(`CDP: debugConversationAttributes (${label}) failed: ${e instanceof Error ? e.message : e}`);
        }
    }

    return { error: 'could not inspect conversation attributes' };
}

// -----------------------------------------------------------------------
// selectConversation
// -----------------------------------------------------------------------

/**
 * N 番目の会話を選択する。
 *
 * 改善: ArrowDown/Enter キー入力ではなく、会話アイテムの BUTTON を直接クリック。
 * delete-conversation tooltip-id を持つ SVG の親 BUTTON を使って
 * 会話アイテムを正確に特定してクリックする。
 */
export async function selectConversation(ops: CdpBridgeOps, index: number): Promise<boolean> {
    await ops.conn.connect();

    const CLICK_CONVERSATION = `
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

    var deleteIcons = doc.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
    if (deleteIcons.length === 0) {
        return { success: false, error: 'No conversation items found (no delete icons)', inIframe: doc !== document };
    }

    var buttons = [];
    for (var i = 0; i < deleteIcons.length; i++) {
        var btn = deleteIcons[i].closest('button');
        if (btn && buttons.indexOf(btn) === -1) {
            buttons.push(btn);
        }
    }

    var targetIndex = ${index};
    if (targetIndex < 0 || targetIndex >= buttons.length) {
        return { success: false, error: 'Index out of range: ' + targetIndex + ' (total: ' + buttons.length + ')' };
    }

    var target = buttons[targetIndex];
    var rect = target.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var ownerWin = target.ownerDocument.defaultView || window;
    var opts = { bubbles: true, cancelable: true, view: ownerWin, clientX: cx, clientY: cy };
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));

    return { success: true, index: targetIndex, total: buttons.length, inIframe: doc !== document };
})()
    `.trim();

    try {
        const result = await ops.evaluateInCascade(CLICK_CONVERSATION) as {
            success: boolean;
            index?: number;
            total?: number;
            error?: string;
        };

        if (result?.success) {
            logDebug(`CDP: selectConversation — selected index ${result.index} of ${result.total}`);
            await ops.sleep(1000);
            ops.resetCascadeContext();
            return true;
        } else {
            logWarn(`CDP: selectConversation — failed: ${result?.error || 'unknown'}`);
            return false;
        }
    } catch (e) {
        logWarn(`CDP: selectConversation — exception: ${e instanceof Error ? e.message : e}`);
        return false;
    }
}

// -----------------------------------------------------------------------
// closePopup
// -----------------------------------------------------------------------

/**
 * 履歴パネルを閉じる。
 *
 * 改善: Escape キーではなく history-tooltip を再クリック（トグル）で閉じる。
 * フォールバックとして Escape キーも残す。
 */
export async function closePopup(ops: CdpBridgeOps): Promise<void> {
    await ops.conn.connect();

    // 戦略0（最優先）: Escape キー送信
    // cascade context リセットに影響されず最も安定した方法
    try {
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
        logDebug('CDP: closePopup — sent Escape key');
        await ops.sleep(300);
        return;
    } catch (e) {
        logDebug(`CDP: closePopup — Escape failed: ${e instanceof Error ? e.message : e}`);
    }

    // 戦略1: history-tooltip を再クリックしてトグル（cascade context）
    const TOGGLE_CLOSE = `
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
    var btn = doc.querySelector('[data-tooltip-id="history-tooltip"]');
    if (btn) {
        btn.click();
        return { success: true, method: 'tooltip-toggle', inIframe: doc !== document };
    }
    return { success: false, inIframe: doc !== document };
})()
    `.trim();

    try {
        const result = await ops.evaluateInCascade(TOGGLE_CLOSE) as {
            success: boolean;
            method?: string;
        };

        if (result?.success) {
            logDebug(`CDP: closePopup — closed via cascade ${result.method}`);
            await ops.sleep(300);
            return;
        }
    } catch (e) {
        logDebug(`CDP: closePopup — cascade toggle failed: ${e instanceof Error ? e.message : e}`);
    }

    // 戦略2: メインコンテキストでトグル（cascade context リセット後の対策）
    try {
        const result = await ops.conn.evaluate(TOGGLE_CLOSE) as {
            success: boolean;
            method?: string;
        };

        if (result?.success) {
            logDebug(`CDP: closePopup — closed via main context (${result.method})`);
            await ops.sleep(300);
            return;
        }
    } catch (e) {
        logDebug(`CDP: closePopup — main context toggle failed: ${e instanceof Error ? e.message : e}`);
    }

    logWarn('CDP: closePopup — all strategies failed');
    await ops.sleep(300);
}
