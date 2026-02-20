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
    // 戦略0（最優先）: data-tooltip-id="history-tooltip"
    var btn = document.querySelector('[data-tooltip-id="history-tooltip"]');
    if (btn) {
        btn.click();
        return { success: true, method: 'tooltip-id', tag: btn.tagName };
    }

    // 戦略1: data-past-conversations-toggle 属性
    var toggle = document.querySelector('[data-past-conversations-toggle]');
    if (toggle) {
        toggle.click();
        return { success: true, method: 'past-conversations-toggle', tag: toggle.tagName };
    }

    // 戦略2: テキスト/アイコンベースのフォールバック
    var anchors = document.querySelectorAll('a');
    for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var rect = a.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            var svg = a.querySelector('svg');
            if (svg && a.closest('[class*="header"]')) {
                // ヘッダー内の SVG アイコン付きリンクをヒューリスティックに検出
                var tooltipId = a.getAttribute('data-tooltip-id') || '';
                if (tooltipId.indexOf('history') >= 0) {
                    a.click();
                    return { success: true, method: 'heuristic-header-link', tooltipId: tooltipId };
                }
            }
        }
    }

    return { success: false, error: 'History button not found' };
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
    var result = { success: false, items: [], debugInfo: {} };

    // 戦略0: delete-conversation tooltip-id を持つ SVG の親 BUTTON を探す
    var deleteIcons = document.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
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
                // タイトル DIV 内のテキスト（P タグの時間テキストを除外）
                var spans = titleEl.querySelectorAll('span, p');
                var parts = [];
                for (var k = 0; k < spans.length; k++) {
                    var span = spans[k];
                    // P.text-nowrap は時間表示 → timeAgo に格納
                    if (span.tagName === 'P' && (span.className || '').indexOf('text-nowrap') >= 0) {
                        timeAgo = (span.textContent || '').trim();
                        continue;
                    }
                    // hidden な削除ボタンの P もスキップ
                    if (span.tagName === 'P' && (span.className || '').indexOf('hidden') >= 0) continue;
                    var t = (span.textContent || '').trim();
                    if (t) parts.push(t);
                }
                text = parts.join(' ').trim();
            }
            if (!text) {
                // フォールバック: BUTTON の直接テキストから時間表記を除外
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
    var groupButtons = document.querySelectorAll('button.group[class*="cursor-pointer"][class*="flex-row"]');
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

    result.debugInfo.error = 'No conversation items found';
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
    if (window.__historyCaptureObserver) {
        try { window.__historyCaptureObserver.disconnect(); } catch(e) {}
    }
    window.__historyCapture = { items: [], captured: false, events: 0, diag: [] };

    function scrapeConversations() {
        // delete-conversation tooltip-id を持つ SVG の親 BUTTON から会話を取得
        var deleteIcons = document.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
        if (deleteIcons.length === 0) {
            window.__historyCapture.diag.push('no_delete_icons');
            return;
        }

        var buttons = [];
        for (var i = 0; i < deleteIcons.length; i++) {
            var btn = deleteIcons[i].closest('button');
            if (btn && buttons.indexOf(btn) === -1) {
                buttons.push(btn);
            }
        }

        if (buttons.length === 0) {
            window.__historyCapture.diag.push('no_parent_buttons');
            return;
        }

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
        }
    }

    var observer = new MutationObserver(function() {
        window.__historyCapture.events++;
        scrapeConversations();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'aria-hidden']
    });
    window.__historyCaptureObserver = observer;

    // 初回スキャン
    scrapeConversations();

    return { success: true };
})()
    `.trim();

    try {
        await ops.evaluateInCascade(INSTALL_OBSERVER);
        logDebug('CDP: openHistoryAndGetList — installed MutationObserver in cascade');
    } catch (e) {
        logWarn(`CDP: openHistoryAndGetList — failed to install observer: ${e instanceof Error ? e.message : e}`);
    }

    // --- Step 2: 履歴ボタンをクリック ---
    const CLICK_HISTORY = `
(function() {
    var btn = document.querySelector('[data-tooltip-id="history-tooltip"]');
    if (btn) {
        btn.click();
        return { success: true, method: 'tooltip-id', tag: btn.tagName };
    }
    var toggle = document.querySelector('[data-past-conversations-toggle]');
    if (toggle) {
        toggle.click();
        return { success: true, method: 'past-conversations-toggle', tag: toggle.tagName };
    }
    return { success: false, error: 'History button not found' };
})()
    `.trim();

    try {
        const clickResult = await ops.evaluateInCascade(CLICK_HISTORY) as {
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
    var c = window.__historyCapture || { items: [], captured: false, events: 0, diag: [] };
    var deleteIcons = document.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
    return {
        captured: c.captured,
        items: c.items,
        events: c.events,
        diag: c.diag,
        deleteIconCount: deleteIcons.length,
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
    var deleteIcons = document.querySelectorAll('[data-tooltip-id*="delete-conversation"]');
    if (deleteIcons.length === 0) {
        return { success: false, error: 'No conversation items found (no delete icons)' };
    }

    // 各 delete icon の親 BUTTON を取得（重複排除）
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
    // BUTTON をクリック
    var rect = target.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));

    return { success: true, index: targetIndex, total: buttons.length };
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

    // 戦略0: history-tooltip を再クリックしてトグル
    const TOGGLE_CLOSE = `
(function() {
    var btn = document.querySelector('[data-tooltip-id="history-tooltip"]');
    if (btn) {
        btn.click();
        return { success: true, method: 'tooltip-toggle' };
    }
    return { success: false };
})()
    `.trim();

    try {
        const result = await ops.evaluateInCascade(TOGGLE_CLOSE) as {
            success: boolean;
            method?: string;
        };

        if (result?.success) {
            logDebug(`CDP: closePopup — closed via ${result.method}`);
            await ops.sleep(300);
            return;
        }
    } catch (e) {
        logDebug(`CDP: closePopup — toggle failed: ${e instanceof Error ? e.message : e}`);
    }

    // 戦略1: Escape キーでフォールバック
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
        logDebug('CDP: closePopup — sent Escape (fallback)');
    } catch (e) {
        logWarn(`CDP: closePopup — Escape fallback failed: ${e instanceof Error ? e.message : e}`);
    }

    await ops.sleep(300);
}
