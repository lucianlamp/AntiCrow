// ---------------------------------------------------------------------------
// cdpUI.ts — UI要素のクリック・検出操作
// ---------------------------------------------------------------------------
// cdpBridge.ts から抽出。DOM スクリプトの注入でブラウザ内の
// 要素クリック・存在確認・待機を行う。
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { logDebug, logInfo } from './logger';
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
                var fast = root.querySelector(selectorToFind);
                if (fast && isVisible(fast) && predicate(fast)) return fast;
            } catch(e) {}
        }
        if (root.nodeType === 1 && predicate(root)) return root;
        var walker = document.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */, null, false);
        var el;
        while ((el = walker.nextNode())) {
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
                if (tag === 'button' || tag === 'vscode-button' || tag === 'a' || parent.getAttribute('role') === 'button' || parent.onclick) {
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
                if (tag2 === 'button' || tag2 === 'vscode-button' || tag2 === 'a' || parent2.getAttribute('role') === 'button') {
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
        if (root.nodeType === 1 && predicate(root)) return root;
        var walker = document.createTreeWalker(root, 1, null, false);
        var el;
        while ((el = walker.nextNode())) {
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

    function findFirstInTree(root, predicate) {
        if (!root) return null;
        if (root.nodeType === 1 && predicate(root)) return root;
        var walker = document.createTreeWalker(root, 1, null, false);
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

    function findAllInTree(root, predicate) {
        if (!root) return [];
        var matches = [];
        if (root.nodeType === 1 && predicate(root)) matches.push(root);
        var walker = document.createTreeWalker(root, 1, null, false);
        var el;
        while ((el = walker.nextNode())) {
            if (predicate(el)) matches.push(el);
            if (el.shadowRoot) {
                matches = matches.concat(findAllInTree(el.shadowRoot, predicate));
            }
        }
        return matches;
    }

    // 優先: "Scroll to bottom" ボタンをクリック（最も確実）
    // Shadow DOM内部にある可能性も考慮
    var scrollBtn = findFirstInTree(document, function(el) {
        var tag = el.tagName.toLowerCase();
        return (tag === 'button' || tag === 'vscode-button' || el.getAttribute('role') === 'button') && 
               el.getAttribute('aria-label') === 'Scroll to bottom';
    });
    
    if (scrollBtn) {
        try {
            scrollBtn.click();
            scrolled = true;
        } catch(e) {}
    }

    // フォールバック: overflow-y-auto コンテナを最下部にスクロール
    if (!scrolled) {
        var containers = findAllInTree(document, function(el) {
            var className = el.className;
            return typeof className === 'string' && className.indexOf('overflow-y-auto') >= 0;
        });
        
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
// dismissPermissionDialog — 権限確認ダイアログを自動承認
// -----------------------------------------------------------------------

export async function dismissPermissionDialog(
    ops: CdpBridgeOps,
): Promise<boolean> {
    const PERMISSION_SCRIPT = `
(function() {
    function findAllInTree(root, predicate) {
        if (!root) return [];
        var matches = [];
        if (root.nodeType === 1 && predicate(root)) matches.push(root);
        var walker = document.createTreeWalker(root, 1, null, false);
        var el;
        while ((el = walker.nextNode())) {
            if (predicate(el)) matches.push(el);
            if (el.shadowRoot) {
                matches = matches.concat(findAllInTree(el.shadowRoot, predicate));
            }
        }
        return matches;
    }

    var allElements = findAllInTree(document, function(el) {
        var tag = el.tagName.toLowerCase();
        return tag === 'button' || tag === 'vscode-button' || tag === 'a' || tag === 'div' || el.getAttribute('role') === 'button';
    });
    var allowed = 0;
    for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        var textLower = text.toLowerCase();

        // URL 許可ダイアログ: Allow / Always Allow / Always allow / Allow this conversation / Allow once
        if (textLower === 'allow' ||
            textLower === 'always allow' ||
            textLower === 'allow this conversation' ||
            textLower === 'allow once') {
            // 可視性チェック
            var rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            try {
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                allowed++;
            } catch(e) {}
        }
    }
    return { allowed: allowed };
})()
`;

    try {
        const result = await ops.evaluateInCascade(PERMISSION_SCRIPT) as { allowed: number } | null;
        if (result && result.allowed > 0) {
            logDebug(`CDP: dismissPermissionDialog — allowed ${result.allowed} permission dialog(s)`);
            return true;
        }
    } catch (e) {
        logDebug(`CDP: dismissPermissionDialog failed — ${e instanceof Error ? e.message : e}`);
    }

    return false;
}

// -----------------------------------------------------------------------
// autoApprove — VSCode コマンド優先 + DOM フォールバックの自動承認ロジック
// -----------------------------------------------------------------------

/**
 * セーフティチェック結果（autoModeController.ts の SafetyCheckResult と同じ構造）
 */
export interface AutoApproveSafetyResult {
    safe: boolean;
    reason?: string;
    severity?: 'block' | 'warn';
    pattern?: string;
}

/**
 * レイヤーC: autoApprove ブラックリスト。
 * ダイアログテキストに DANGEROUS_PATTERNS がマッチした場合にブロックする。
 * DANGEROUS_PATTERNS は autoModeController.ts から動的にインポートして再利用する。
 * autoModeController.ts がまだ存在しない場合はチェックをスキップする。
 */
let _dangerousPatterns: Array<{ pattern: RegExp; reason: string; severity: 'block' | 'warn' }> | null = null;
let _dangerousPatternsLoaded = false;

async function loadDangerousPatterns(): Promise<Array<{ pattern: RegExp; reason: string; severity: 'block' | 'warn' }>> {
    if (_dangerousPatternsLoaded) { return _dangerousPatterns || []; }
    try {
        const { DANGEROUS_PATTERNS } = await import('./autoModeController');
        _dangerousPatterns = DANGEROUS_PATTERNS;
        _dangerousPatternsLoaded = true;
        logDebug('CDP: shouldBlockAutoApprove — loaded DANGEROUS_PATTERNS from autoModeController');
    } catch {
        // autoModeController.ts がまだ存在しない場合はスキップ
        _dangerousPatternsLoaded = true;
        logDebug('CDP: shouldBlockAutoApprove — autoModeController not found, skipping safety check');
    }
    return _dangerousPatterns || [];
}

/**
 * autoApprove 前のセーフティチェック（レイヤーC）。
 * ダイアログテキストに DANGEROUS_PATTERNS がマッチしたらブロックを返す。
 */
export async function shouldBlockAutoApprove(dialogText: string): Promise<AutoApproveSafetyResult> {
    const patterns = await loadDangerousPatterns();
    for (const { pattern, reason, severity } of patterns) {
        if (pattern.test(dialogText)) {
            logInfo(`CDP: shouldBlockAutoApprove — BLOCKED: ${reason} (pattern=${pattern.source})`);
            return { safe: false, reason, severity, pattern: pattern.source };
        }
    }
    return { safe: true };
}

/**
 * VSCode コマンドによる自動承認リスト。
 * メインフレームの conn.evaluate 内で vscode.commands.executeCommand を呼び出す。
 * Antigravity の Electron メインウィンドウでは vscode グローバルが利用可能。
 */
const APPROVE_COMMANDS = [
    'antigravity.agent.acceptAgentStep',    // Agent ステップ承認
    'antigravity.terminalCommand.accept',   // ターミナルコマンド承認（Run ボタン）
    'antigravity.command.accept',           // コマンド承認
    'antigravity.prioritized.agentAcceptAllInFile', // ファイル変更の一括承認
];

/**
 * DOM フォールバックで検出する承認ボタンのテキストパターン。
 * 大文字小文字を区別しない完全一致で照合する。
 */
const APPROVE_BUTTON_TEXTS = [
    'run', 'allow', 'always allow', 'continue', 'proceed',
    'accept', 'confirm', 'yes', 'ok', 'retry',
    'always run', 'allow once', 'allow this conversation',
];

/** クリック済みボタンの cooldown 管理（テキスト → 最終クリック時刻） */
const clickCooldownMap = new Map<string, number>();
/** 同一ボタンへの連続クリックを防止する cooldown（ミリ秒） */
const CLICK_COOLDOWN_MS = 5_000;
/** cooldown エントリの自動クリーンアップ閾値（ミリ秒） */
const COOLDOWN_CLEANUP_MS = 30_000;

export async function autoApprove(
    ops: CdpBridgeOps
): Promise<{ clicked: number }> {
    let totalClicked = 0;
    logDebug('CDP: autoApprove — tick');


    // =================================================================
    // 第1層: VSCode コマンドによる自動承認（メインフレームで実行）
    // Antigravity の Electron ウィンドウ内で vscode.commands.executeCommand を呼ぶ。
    // CDP evaluate はターゲットウィンドウ内で実行されるため、
    // 複数ワークスペースでもクロスWS誤爆しない。
    // =================================================================
    for (const cmd of APPROVE_COMMANDS) {
        try {
            const evalJs = `
    (async () => {
        if (typeof vscode !== 'undefined' && vscode.commands) {
            await vscode.commands.executeCommand('${cmd}');
            return true;
        }
        return false;
    })()
            `;
            const executed = await ops.conn.evaluate(evalJs);
            if (executed) {
                logInfo(`CDP: autoApprove — executed VSCode command: ${cmd} `);
                totalClicked++;
            }
        } catch { /* コマンドが存在しない/対象なしは無視 */ }
    }

    // =================================================================
    // 第2層: DOM ベースのボタンクリック（フォールバック）
    // VSCode コマンドでカバーできない UI 要素（Allow ダイアログ等）に対応。
    // TreeWalker + Shadow DOM 再帰探索で承認系ボタンを検出してクリックする。
    // =================================================================
    const DOM_APPROVE_SCRIPT = `
    (function () {
        var TEXTS = ${JSON.stringify(APPROVE_BUTTON_TEXTS)
        };
var clicked = 0;
var clickedTexts = [];

// getTargetDoc: メインフレームから実行されても cascade iframe 内の document を取得
// (CANCEL_BUTTON_JS と同じパターン)
function getTargetDoc() {
    var iframes = document.querySelectorAll('iframe');
    for (var fi = 0; fi < iframes.length; fi++) {
        try {
            if (iframes[fi].src && iframes[fi].src.includes('cascade-panel') && iframes[fi].contentDocument) {
                return iframes[fi].contentDocument;
            }
        } catch (e) { /* cross-origin は無視 */ }
    }
    return document;
}

// 探索対象: cascade iframe があればその中、なければメインフレーム
var docs = [];
var cascadeDoc = getTargetDoc();
docs.push(cascadeDoc);
// cascade iframe が見つかった場合はメインフレームも追加（ダイアログが iframe 外にある場合）
if (cascadeDoc !== document) {
    docs.push(document);
}

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

function isVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
        try {
            var style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'sticky') return false;
        } catch (e) { return false; }
    }
    return true;
}

function clickEl(el) {
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { }
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var opts = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView || window, clientX: cx, clientY: cy };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    try {
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
    } catch (e) { }
}

// 短いテキスト（完全一致のみ）と長いテキスト（部分一致OK）を分離
var SHORT_TEXTS = ['run', 'ok', 'yes', 'allow', 'accept', 'retry', 'confirm', 'proceed'];
var LONG_TEXTS = ['always allow', 'continue', 'always run', 'allow once', 'allow this conversation'];

function isExcluded(el) {
    if (el.closest('[id*="statusbar"], [class*="statusbar"]')) return true;
    if (el.closest('[class*="menubar"], [role="menubar"]')) return true;
    if (el.closest('[class*="titlebar"]')) return true;
    if (el.closest('[data-headlessui-state], [role="listbox"], [role="option"], [role="combobox"], [class*="dropdown"], [class*="select-box"], [class*="popover"]')) return true;
    if (el.tagName === 'DIV' && el.getAttribute('data-tooltip-id')) return true;
    var label = (el.getAttribute('aria-label') || '').toLowerCase();
    if (label.indexOf('model') >= 0 || label.indexOf('cascade') >= 0 || label.indexOf('agent mode') >= 0) return true;
    return false;
}

// ショートカットキー修飾を除去する関数（"Run Alt+↵" → "Run"）
function cleanText(t) {
    return t.replace(/\s*(alt|ctrl|shift|cmd|\u2318|\u2325|\u21e7)[+\s]*.{0,3}$/i, '')
        .replace(/[\u21b5\u23ce\u21a9]/g, '')
        .replace(/\s+/g, ' ').trim();
}

function isClickable(el) {
    var tag = el.tagName.toLowerCase();
    return tag === 'button' || tag === 'vscode-button' || tag === 'a' ||
        el.getAttribute('role') === 'button' ||
        (tag === 'div' && !el.getAttribute('data-tooltip-id') && (el.getAttribute('aria-label') || el.classList.contains('action-label')));
}

// 各 document を順に探索（cascade iframe → メインフレーム）
for (var di = 0; di < docs.length; di++) {
    var doc = docs[di];
    var actionElements = findAllInTree(doc, isClickable);

    for (var i = 0; i < actionElements.length; i++) {
        var el = actionElements[i];
        if (!isVisible(el)) continue;
        if (isExcluded(el)) continue;

        var rawText = cleanText((el.innerText || el.textContent || '')).toLowerCase();
        var ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();

        var isApproveBtn = false;
        for (var s = 0; s < SHORT_TEXTS.length; s++) {
            if (rawText === SHORT_TEXTS[s] || ariaLabel === SHORT_TEXTS[s]) {
                isApproveBtn = true;
                break;
            }
        }
        if (!isApproveBtn) {
            for (var l = 0; l < LONG_TEXTS.length; l++) {
                if (rawText === LONG_TEXTS[l] || rawText.indexOf(LONG_TEXTS[l]) >= 0 ||
                    ariaLabel === LONG_TEXTS[l] || ariaLabel.indexOf(LONG_TEXTS[l]) >= 0) {
                    isApproveBtn = true;
                    break;
                }
            }
        }

        if (isApproveBtn) {
            clickEl(el);
            clicked++;
            clickedTexts.push(rawText || ariaLabel);
        }
    }
}

return { clicked: clicked, clickedTexts: clickedTexts };
}) ()
`.trim();

    // cooldown エントリのクリーンアップ（30秒以上前のエントリを削除）
    const now = Date.now();
    for (const [key, ts] of clickCooldownMap) {
        if (now - ts > COOLDOWN_CLEANUP_MS) {
            clickCooldownMap.delete(key);
        }
    }

    try {
        // メインフレームで実行（ダイアログは cascade iframe 外にある）
        const result = await ops.conn.evaluate(DOM_APPROVE_SCRIPT) as { clicked: number; clickedTexts?: string[] } | null;
        if (result && result.clicked > 0 && result.clickedTexts) {
            let effectiveClicks = 0;
            for (const text of result.clickedTexts) {
                const lastClick = clickCooldownMap.get(text);
                if (lastClick && now - lastClick < CLICK_COOLDOWN_MS) {
                    logDebug(`CDP: autoApprove — skipped(cooldown): "${text}"`);
                    continue;
                }
                clickCooldownMap.set(text, now);
                effectiveClicks++;
            }
            if (effectiveClicks > 0) {
                logInfo(`CDP: autoApprove DOM fallback — clicked ${effectiveClicks} approval button(s)`);
                totalClicked += effectiveClicks;
            }
        }
    } catch (e) {
        logInfo(`CDP: autoApprove DOM fallback failed — ${e instanceof Error ? e.message : e} `);
    }

    // cascade iframe 内でも同じスクリプトを実行（iframe 内のダイアログ対応）
    try {
        const cascadeResult = await ops.evaluateInCascade(DOM_APPROVE_SCRIPT) as { clicked: number; clickedTexts?: string[] } | null;
        if (cascadeResult && cascadeResult.clicked > 0 && cascadeResult.clickedTexts) {
            let effectiveClicks = 0;
            const nowCascade = Date.now();
            for (const text of cascadeResult.clickedTexts) {
                const lastClick = clickCooldownMap.get(text);
                if (lastClick && nowCascade - lastClick < CLICK_COOLDOWN_MS) {
                    logDebug(`CDP: autoApprove(cascade) — skipped(cooldown): "${text}"`);
                    continue;
                }
                clickCooldownMap.set(text, nowCascade);
                effectiveClicks++;
            }
            if (effectiveClicks > 0) {
                logInfo(`CDP: autoApprove DOM fallback(cascade) — clicked ${effectiveClicks} approval button(s)`);
                totalClicked += effectiveClicks;
            }
        }
    } catch {
        // cascade iframe がない場合は無視
    }

    if (totalClicked > 0) {
        logInfo(`CDP: autoApprove — total clicked: ${totalClicked} `);
    }
    return { clicked: totalClicked };
}

// -----------------------------------------------------------------------
// isAgentRunning — エージェント実行中かどうかを検出
// -----------------------------------------------------------------------

/**
 * エージェントパネル上のストップボタンの存在を検出して、
 * エージェントが実行中かどうかを判定する。
 * ストップボタンが見つかれば true（実行中）、なければ false（アイドル）。
 */
export async function isAgentRunning(
    ops: CdpBridgeOps,
): Promise<boolean> {
    // clickCancelButton (cdpBridge.ts) と同じ検出ロジックを使用。
    // 以前の一般的な aria-label/title/class ベースの TreeWalker は
    // Antigravity の実際のUI構造（data-tooltip-id, SVG rect）にマッチしなかった。
    const DETECT_SCRIPT = `
    (function () {
        // getTargetDoc パターン — iframe 内外を透過的に検索
        function getTargetDoc() {
            var iframes = document.querySelectorAll('iframe');
            for (var fi = 0; fi < iframes.length; fi++) {
                try {
                    if (iframes[fi].src && iframes[fi].src.includes('cascade-panel') && iframes[fi].contentDocument) {
                        return iframes[fi].contentDocument;
                    }
                } catch (e) { /* cross-origin */ }
            }
            return document;
        }
        var doc = getTargetDoc();
        var inIframe = doc !== document;

        // 検出1: data-tooltip-id でキャンセルボタンを検出（最も信頼性が高い）
        var cancelByTooltip = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancelByTooltip) {
            return { running: true, matchedBy: 'tooltip-id:cancel', inIframe: inIframe };
        }

        // 検出2: data-tooltip-id 部分一致（Antigravity アップデート対応）
        var cancelPartial = doc.querySelector('[data-tooltip-id*="cancel"]');
        if (cancelPartial) {
            return { running: true, matchedBy: 'tooltip-id-partial:' + cancelPartial.getAttribute('data-tooltip-id'), inIframe: inIframe };
        }

        // 検出3: button innerText が Stop / 停止
        var buttons = doc.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
            var txt = (buttons[i].innerText || '').trim().toLowerCase();
            if (txt === 'stop' || txt === '停止') {
                return { running: true, matchedBy: 'button-text:' + txt, inIframe: inIframe };
            }
        }

        // 検出4: textbox 近辺の SVG rect を持つ要素（ストップアイコン）
        var textbox = doc.querySelector('div[role="textbox"]');
        if (textbox) {
            var container = textbox.closest('form') || textbox.parentElement?.parentElement?.parentElement;
            if (container) {
                var CLICKABLE = 'button, div[data-tooltip-id], div[role="button"], div[aria-label], [data-tooltip-id]';
                var clickables = container.querySelectorAll(CLICKABLE);
                for (var j = 0; j < clickables.length; j++) {
                    var btn = clickables[j];
                    var tid = btn.getAttribute('data-tooltip-id') || '';
                    if (tid === 'audio-tooltip' || tid === 'input-send-button-send-tooltip') continue;
                    if ((btn.getAttribute('aria-label') || '').toLowerCase().includes('record')) continue;
                    var hasSvgRect = btn.querySelector('svg rect') !== null;
                    var hasSvgStop = btn.querySelector('svg [data-icon="stop"]') !== null;
                    var ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                    if (hasSvgRect || hasSvgStop || ariaLabel.includes('stop') || ariaLabel.includes('cancel')) {
                        return { running: true, matchedBy: 'svg-rect:' + (tid || ariaLabel || btn.tagName), inIframe: inIframe };
                    }
                }
            }
        }

        // 検出5: aria-label/title ベースのフォールバック
        var CLICKABLE_ALL = 'button, div[data-tooltip-id], div[role="button"], [data-tooltip-id], [aria-label]';
        var allClickable = doc.querySelectorAll(CLICKABLE_ALL);
        for (var k = 0; k < allClickable.length; k++) {
            var el = allClickable[k];
            var label = (el.getAttribute('aria-label') || '').toLowerCase();
            var title = (el.getAttribute('title') || '').toLowerCase();
            if (label.includes('stop') || label.includes('cancel') || title.includes('stop') || title.includes('cancel')) {
                var elTid = el.getAttribute('data-tooltip-id') || '';
                if (elTid === 'audio-tooltip' || elTid === 'input-send-button-send-tooltip') continue;
                return { running: true, matchedBy: 'aria:' + (label || title), inIframe: inIframe };
            }
        }

        return { running: false, matchedBy: '', inIframe: inIframe, buttonCount: buttons.length, textboxFound: !!textbox };
    })()
`.trim();

    // evaluateInCascade 呼び出し前にコンテキストをリセット（汚染防止）
    ops.resetCascadeContext();

    try {
        // cascade iframe 内で検出（エージェントチャットパネル）
        const cascadeResult = await ops.evaluateInCascade(DETECT_SCRIPT) as { running: boolean; matchedBy?: string; inIframe?: boolean } | null;
        if (cascadeResult?.running) {
            logDebug(`CDP: isAgentRunning — detected in cascade(${cascadeResult.matchedBy})`);
            return true;
        }
        // cascade でスクリプト実行成功したが running=false の場合、cascade の getTargetDoc が
        // すでに iframe 内 document を返しているはずなので、メインフレーム検出は不要
        if (cascadeResult && !cascadeResult.running) {
            return false;
        }
    } catch (e) {
        logDebug(`CDP: isAgentRunning — cascade eval failed: ${e instanceof Error ? e.message : e} `);
    }

    try {
        // メインフレームでも検出（cascade iframe がない / エラーの場合のフォールバック）
        // getTargetDoc() により、メインフレームから iframe 内の document にもアクセスする
        const mainResult = await ops.conn.evaluate(DETECT_SCRIPT) as { running: boolean; matchedBy?: string; inIframe?: boolean } | null;
        if (mainResult?.running) {
            logDebug(`CDP: isAgentRunning — detected in main frame(${mainResult.matchedBy}, inIframe = ${mainResult.inIframe})`);
            return true;
        }
    } catch (e) {
        logDebug(`CDP: isAgentRunning — main frame eval failed: ${e instanceof Error ? e.message : e} `);
    }

    return false;
}

// -----------------------------------------------------------------------
// autoFollowOutput — AI出力追従（スクロール + 展開 + 権限承認）
// -----------------------------------------------------------------------

export async function autoFollowOutput(
    ops: CdpBridgeOps,
): Promise<void> {
    // NOTE: isAgentRunning チェックは UIWatcher 側でステータスバー更新専用に使用。
    // autoFollowOutput 自体はゲーティングしない（ダイアログ表示中にストップボタンが
    // 非表示になり、承認ボタンがクリックされなくなる問題を防止）。

    // 1. チャットエリアを最下部にスクロール（まずスクロールして新しいコンテンツを表示）
    await scrollToBottom(ops);

    // 2. 折りたたまれたセクションを展開（承認ボタンが見えるように先に展開）
    await clickExpandAll(ops);

    // 3. スクロール＆展開で出てきた承認ボタンを自動クリック（VSCodeコマンド + DOM探索）
    await autoApprove(ops);

    // 4. 権限確認ダイアログを自動承認
    await dismissPermissionDialog(ops);

    logDebug('CDP: autoFollowOutput completed');
}
