// ---------------------------------------------------------------------------
// cdpModes.ts — CDP 経由でモードドロップダウンを操作
// ---------------------------------------------------------------------------
// DOM 構造 (Antigravity cascade-panel):
//
// モードボタン（チャット入力欄の下、モデルボタンの左隣）:
//   textbox 親を辿り、siblings から button 群を見つけ、
//   モデルボタンより前（左）にあるボタンをモードボタンとして検出。
//
// ドロップダウン（モードボタンクリック後に出現）:
//   div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]
//     → "Mode" ヘッダー (div[class*="opacity-80"])
//     → 各モード: p[class*="text-ellipsis"][class*="whitespace-nowrap"]
//     → クリック先: div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]
// ---------------------------------------------------------------------------

import { CdpBridgeOps } from './cdpHistory';
import { logDebug, logWarn } from './logger';

// -----------------------------------------------------------------------
// 共通: モードボタンを見つける JS スニペット
// -----------------------------------------------------------------------
// モードボタンはモデルボタンの左に位置する。
// textbox から親方向に辿り、ボタン群のうちモデルボタンより前にある
// p タグを持つ button をモードボタンとして検出する。
// -----------------------------------------------------------------------

const FIND_MODE_BUTTON = `
    var modeBtn = null;
    var _findDebug = { textboxFound: false, levelsSearched: 0, siblingsChecked: 0, buttonsFound: 0, found: false, allBtnTexts: [], inIframe: false };

    // getTargetDoc: メインフレームから実行されても cascade iframe 内の document を取得
    function getTargetDoc() {
        var iframes = document.querySelectorAll('iframe');
        for (var fi = 0; fi < iframes.length; fi++) {
            try {
                if (iframes[fi].src && iframes[fi].src.includes('cascade-panel') && iframes[fi].contentDocument) {
                    return iframes[fi].contentDocument;
                }
            } catch(e) { /* cross-origin は無視 */ }
        }
        return document;
    }
    var doc = getTargetDoc();
    _findDebug.inIframe = (doc !== document);

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

    // ボタンのテキストを安全に取得（textContent 優先 — innerText はレイアウト依存で iframe 内で空を返す）
    function getBtnText(el) {
        var t = (el.textContent || '').trim();
        if (t) return t;
        // aria-label フォールバック
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel.trim();
        // title フォールバック
        var title = el.getAttribute('title');
        if (title) return title.trim();
        return '';
    }

    var textbox = findFirstInTree(doc, function(el) {
        return el.tagName === 'DIV' && el.getAttribute('role') === 'textbox';
    });

    if (textbox) {
        _findDebug.textboxFound = true;
        var container = textbox.parentElement;

        for (var d = 0; d < 5; d++) {
            if (!container) break;
            _findDebug.levelsSearched = d + 1;

            var allBtns = [];

            // 兄弟要素(前方)を探索
            var sibling = container.previousElementSibling;
            while (sibling) {
                _findDebug.siblingsChecked++;
                var btns2 = findAllInTree(sibling, function(el) {
                    var tag = el.tagName.toLowerCase();
                    return tag === 'button' || tag === 'vscode-button' || el.getAttribute('role') === 'button';
                });
                for (var b2 = 0; b2 < btns2.length; b2++) {
                    var btnText2 = getBtnText(btns2[b2]);
                    if (btnText2.length > 0) {
                        allBtns.unshift({ el: btns2[b2], text: btnText2 });
                    }
                }
                sibling = sibling.previousElementSibling;
            }

            // 兄弟要素(後方)を探索
            sibling = container.nextElementSibling;
            while (sibling) {
                _findDebug.siblingsChecked++;
                var btns = findAllInTree(sibling, function(el) {
                    var tag = el.tagName.toLowerCase();
                    return tag === 'button' || tag === 'vscode-button' || el.getAttribute('role') === 'button';
                });
                for (var b = 0; b < btns.length; b++) {
                    var btnText = getBtnText(btns[b]);
                    if (btnText.length > 0) {
                        allBtns.push({ el: btns[b], text: btnText });
                    }
                }
                sibling = sibling.nextElementSibling;
            }

            // 見つかったテキストボタンの最初のものをモードボタンとする
            if (allBtns.length > 0) {
                _findDebug.buttonsFound = allBtns.length;
                _findDebug.allBtnTexts = allBtns.map(function(b) { return b.text; });
                modeBtn = allBtns[0].el;
                _findDebug.found = true;
                break;
            }
            container = container.parentElement;
        }
    }
`;


// -----------------------------------------------------------------------
// getCurrentMode — 現在選択中のモード名を取得
// -----------------------------------------------------------------------

export async function getCurrentMode(
    ops: CdpBridgeOps,
): Promise<string | null> {
    try {
        await ops.conn.connect();

        const script = `
(function() {
    ${FIND_MODE_BUTTON}
    if (!modeBtn) return null;
    var p = findFirstInTree(modeBtn, function(el) { return el.tagName === 'P'; });
    var sp = findFirstInTree(modeBtn, function(el) { return el.tagName === 'SPAN'; });
    var textEl = p || sp;
    return textEl ? (textEl.textContent || '').trim() : (modeBtn.innerText || modeBtn.textContent || '').trim();
})()
        `.trim();

        const result = await ops.evaluateInCascade(script);
        if (typeof result === 'string' && result.length > 0) {
            logDebug(`cdpModes: getCurrentMode = "${result}"`);
            return result;
        }

        logDebug('cdpModes: getCurrentMode — mode selector not found');
        return null;
    } catch (e) {
        logWarn(`cdpModes: getCurrentMode failed — ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

// -----------------------------------------------------------------------
// getAvailableModes — ドロップダウンを開いてモード一覧を取得
// -----------------------------------------------------------------------

/** デバッグログエントリ */
export interface ModeDebugEntry {
    step: string;
    success: boolean;
    detail: string;
    timestamp: string;
}

export async function getAvailableModes(
    ops: CdpBridgeOps,
): Promise<{ modes: string[]; current: string | null; debugLog: ModeDebugEntry[] }> {
    const debugLog: ModeDebugEntry[] = [];
    const log = (step: string, success: boolean, detail: string) => {
        debugLog.push({ step, success, detail, timestamp: new Date().toISOString() });
    };

    logDebug('cdpModes: getAvailableModes — start');

    // Step 1: 接続
    try {
        await ops.conn.connect();
        log('connect', true, 'connected successfully');
        logDebug('cdpModes: getAvailableModes — connected');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('connect', false, msg);
        logWarn(`cdpModes: getAvailableModes — connect failed: ${msg}`);
        return { modes: [], current: null, debugLog };
    }

    let currentMode: string | null = null;

    try {
        // Step 2: モードボタンクリック
        const openScript = `
(function() {
    ${FIND_MODE_BUTTON}
    if (!modeBtn) return { success: false, error: 'mode button not found', findDebug: _findDebug };

    var p = findFirstInTree(modeBtn, function(el) { return el.tagName === 'P'; });
    var sp = findFirstInTree(modeBtn, function(el) { return el.tagName === 'SPAN'; });
    var textEl = p || sp;
    var curMode = textEl ? (textEl.textContent || '').trim() : (modeBtn.innerText || modeBtn.textContent || '').trim();

    modeBtn.click();
    return { success: true, currentMode: curMode, findDebug: _findDebug };
})()
        `.trim();

        type OpenResult = { success: boolean; currentMode?: string; error?: string; findDebug?: Record<string, unknown> };

        let openResult: OpenResult | null = null;

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                logDebug(`cdpModes: getAvailableModes — evaluateInCascade attempt ${attempt + 1}`);
                openResult = await ops.evaluateInCascade(openScript) as OpenResult;
                log('cascade_eval', true, `attempt=${attempt + 1}, result=${JSON.stringify(openResult)}`);
                break;
            } catch (cascadeErr) {
                const msg = cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr);
                log('cascade_eval', false, `attempt=${attempt + 1}, error=${msg}`);
                logWarn(`cdpModes: getAvailableModes — cascade attempt ${attempt + 1} failed: ${msg}`);
                if (attempt === 0) {
                    ops.resetCascadeContext();
                    await ops.sleep(300);
                } else {
                    throw cascadeErr;
                }
            }
        }

        if (!openResult?.success) {
            log('mode_button', false, `error=${openResult?.error || 'unknown'}, findDebug=${JSON.stringify(openResult?.findDebug)}`);
            logWarn(`cdpModes: getAvailableModes — open failed: ${openResult?.error}, findDebug=${JSON.stringify(openResult?.findDebug)}`);
            return { modes: [], current: null, debugLog };
        }

        log('mode_button', true, `currentMode="${openResult.currentMode || ''}", findDebug=${JSON.stringify(openResult.findDebug)}`);
        currentMode = openResult.currentMode || null;

        // Step 3: ドロップダウン待機
        await ops.sleep(500);
        log('dropdown_wait', true, 'waited 500ms');

        // Step 4: モード名取得
        const listScript = `
(function() {
    var items = [];
    var debugInfo = { dropdownsFound: 0, headerFound: false, labelsFound: 0, fallbackUsed: false, newSelectorUsed: false, inIframe: false };

    // getTargetDoc: cascade iframe 内の document を取得
    function getTargetDoc() {
        var iframes = document.querySelectorAll('iframe');
        for (var fi = 0; fi < iframes.length; fi++) {
            try {
                if (iframes[fi].src && iframes[fi].src.includes('cascade-panel') && iframes[fi].contentDocument) {
                    return iframes[fi].contentDocument;
                }
            } catch(e) { /* cross-origin */ }
        }
        return document;
    }
    var doc = getTargetDoc();
    debugInfo.inIframe = (doc !== document);

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

    // 新しい UI 構造: z-50 rounded-md border shadow-md のドロップダウン
    // モード項目は div.cursor-pointer > div.font-medium にテキスト
    var ddNew = findAllInTree(doc, function(el) {
        if (el.tagName !== 'DIV') return false;
        var c = typeof el.className === 'string' ? el.className : '';
        return c.indexOf('z-50') >= 0 && c.indexOf('rounded-md') >= 0 && c.indexOf('border') >= 0 && c.indexOf('shadow-md') >= 0;
    });

    for (var dn = 0; dn < ddNew.length; dn++) {
        var modeRows = findAllInTree(ddNew[dn], function(el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
        });

        for (var mr = 0; mr < modeRows.length; mr++) {
            var fontMedium = findFirstInTree(modeRows[mr], function(el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('font-medium') >= 0;
            });
            if (fontMedium) {
                var text = (fontMedium.textContent || '').trim();
                if (text.length > 0 && text.length < 100) {
                    items.push(text);
                }
            }
        }
        if (items.length > 0) {
            debugInfo.newSelectorUsed = true;
            debugInfo.dropdownsFound = ddNew.length;
            debugInfo.labelsFound = items.length;
            break;
        }
    }

    // フォールバック: 旧 UI 構造 (absolute + overflow-y-auto + "Mode" ヘッダー)
    if (items.length === 0) {
        debugInfo.fallbackUsed = true;
        var dropdowns = findAllInTree(doc, function(el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('absolute') >= 0 && c.indexOf('overflow-y-auto') >= 0 && c.indexOf('rounded-lg') >= 0 && c.indexOf('border') >= 0;
        });
        debugInfo.dropdownsFound = dropdowns.length;
        var ddRoot = null;
        for (var d = 0; d < dropdowns.length; d++) {
            var headerCheck = findFirstInTree(dropdowns[d], function(el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('opacity-80') >= 0;
            });
            if (headerCheck && (headerCheck.textContent || '').trim() === 'Mode') {
                ddRoot = dropdowns[d];
                debugInfo.headerFound = true;
                break;
            }
        }
        if (ddRoot) {
            var modeLabels = findAllInTree(ddRoot, function(el) {
                if (el.tagName !== 'P') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('overflow-hidden') >= 0 && c.indexOf('text-ellipsis') >= 0 && c.indexOf('whitespace-nowrap') >= 0;
            });
            debugInfo.labelsFound = modeLabels.length;
            for (var i = 0; i < modeLabels.length; i++) {
                var t = (modeLabels[i].textContent || '').trim();
                if (t.length > 0 && t.length < 100) items.push(t);
            }
        }
    }

    // アクティブモード検出: 背景色付きやチェックマーク付きの項目を検出
    var activeMode = null;
    // 新 UI: bg- クラスを持つアクティブな行のテキストを取得
    if (ddNew.length > 0) {
        for (var an = 0; an < ddNew.length; an++) {
            var activeRows = findAllInTree(ddNew[an], function(el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
            });
            for (var ar = 0; ar < activeRows.length; ar++) {
                var rowClass = typeof activeRows[ar].className === 'string' ? activeRows[ar].className : '';
                // アクティブ項目は bg- クラスを持つか、チェックマーク SVG/アイコンを含む
                var hasBg = rowClass.indexOf('bg-') >= 0;
                var hasCheck = findFirstInTree(activeRows[ar], function(el) {
                    return el.tagName === 'SVG' || (el.tagName === 'SPAN' && (el.textContent || '').indexOf('✓') >= 0);
                });
                if (hasBg || hasCheck) {
                    var activeFm = findFirstInTree(activeRows[ar], function(el) {
                        if (el.tagName !== 'DIV') return false;
                        var c2 = typeof el.className === 'string' ? el.className : '';
                        return c2.indexOf('font-medium') >= 0;
                    });
                    if (activeFm) {
                        activeMode = (activeFm.textContent || '').trim();
                    }
                    break;
                }
            }
            if (activeMode) break;
        }
    }
    debugInfo.activeMode = activeMode;

    return { items: items, debug: debugInfo, activeMode: activeMode };
})()
        `.trim();

        type ListResult = { items: string[]; debug: Record<string, unknown>; activeMode?: string | null } | string[];
        const listResult = await ops.evaluateInCascade(listScript) as ListResult;

        let modes: string[];
        let dropdownActiveMode: string | null = null;
        if (Array.isArray(listResult)) {
            modes = listResult;
            log('mode_list', true, `count=${modes.length} (legacy format)`);
        } else if (listResult && typeof listResult === 'object' && 'items' in listResult) {
            modes = listResult.items || [];
            dropdownActiveMode = listResult.activeMode || null;
            log('mode_list', modes.length > 0, `count=${modes.length}, activeMode="${dropdownActiveMode || ''}", debug=${JSON.stringify(listResult.debug)}`);
        } else {
            modes = [];
            log('mode_list', false, `unexpected result type: ${typeof listResult}, value=${JSON.stringify(listResult)}`);
        }

        // currentMode が取得できなかった場合、ドロップダウンのアクティブ項目をフォールバック
        if (!currentMode && dropdownActiveMode) {
            currentMode = dropdownActiveMode;
            log('mode_fallback', true, `using dropdown activeMode="${dropdownActiveMode}" as currentMode`);
            logDebug(`cdpModes: getAvailableModes — fallback: using activeMode="${dropdownActiveMode}"`);
        }

        // Step 5: ドロップダウンを閉じる
        try {
            await ops.conn.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                windowsVirtualKeyCode: 27,
                code: 'Escape',
                key: 'Escape',
            });
            await ops.sleep(200);
            await ops.conn.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                windowsVirtualKeyCode: 27,
                code: 'Escape',
                key: 'Escape',
            });
            log('dropdown_close', true, 'Escape sent');
        } catch (closeErr) {
            log('dropdown_close', false, `${closeErr instanceof Error ? closeErr.message : closeErr}`);
        }

        const modeList = Array.isArray(modes) ? modes : [];
        logDebug(`cdpModes: getAvailableModes — found ${modeList.length} modes, current = "${currentMode}"`);

        return {
            modes: modeList,
            current: currentMode,
            debugLog,
        };
    } catch (e) {
        // ドロップダウンを閉じる試行
        try {
            await ops.conn.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                windowsVirtualKeyCode: 27,
                code: 'Escape',
                key: 'Escape',
            });
        } catch { /* ignore */ }

        const msg = e instanceof Error ? e.message : String(e);
        log('fatal', false, msg);
        logWarn(`cdpModes: getAvailableModes failed — ${msg} `);
        return { modes: [], current: currentMode, debugLog };
    }
}

// -----------------------------------------------------------------------
// selectMode — 指定モードを選択
// -----------------------------------------------------------------------

export async function selectMode(
    ops: CdpBridgeOps,
    modeName: string,
): Promise<boolean> {
    try {
        await ops.conn.connect();

        // 1. モードボタンをクリックしてドロップダウンを開く
        const openScript = `
            (function () {
    ${FIND_MODE_BUTTON}
                if (!modeBtn) return false;
                modeBtn.click();
                return true;
            })()
            `.trim();

        const opened = await ops.evaluateInCascade(openScript);
        if (!opened) {
            logWarn('cdpModes: selectMode — could not open dropdown');
            return false;
        }

        await ops.sleep(500);

        // 2. ドロップダウン内で目的のモードをクリック
        const selectScript = `
            (function () {
                var targetMode = ${JSON.stringify(modeName)
            };
        var targetLower = targetMode.toLowerCase();

        // getTargetDoc: cascade iframe 内の document を取得
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

        // 新しい UI 構造: z-50 rounded-md border shadow-md
        var ddNew = findAllInTree(doc, function (el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('z-50') >= 0 && c.indexOf('rounded-md') >= 0 && c.indexOf('border') >= 0 && c.indexOf('shadow-md') >= 0;
        });

        for (var dn = 0; dn < ddNew.length; dn++) {
            var modeRows = findAllInTree(ddNew[dn], function (el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
            });
            for (var i = 0; i < modeRows.length; i++) {
                var fontMedium = findFirstInTree(modeRows[i], function (el) {
                    if (el.tagName !== 'DIV') return false;
                    var c = typeof el.className === 'string' ? el.className : '';
                    return c.indexOf('font-medium') >= 0;
                });
                if (!fontMedium) continue;
                var mText = (fontMedium.textContent || '').trim().toLowerCase();
                if (mText === targetLower || mText.includes(targetLower) || targetLower.includes(mText)) {
                    modeRows[i].click();
                    return { success: true, selected: (fontMedium.textContent || '').trim() };
                }
            }
        }

        // フォールバック: 旧 UI 構造
        var dropdowns = findAllInTree(doc, function (el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('absolute') >= 0 && c.indexOf('overflow-y-auto') >= 0 && c.indexOf('rounded-lg') >= 0 && c.indexOf('border') >= 0;
        });
        var ddRoot = null;
        for (var d = 0; d < dropdowns.length; d++) {
            var headerCheck = findFirstInTree(dropdowns[d], function (el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('opacity-80') >= 0;
            });
            if (headerCheck && (headerCheck.textContent || '').trim() === 'Mode') {
                ddRoot = dropdowns[d];
                break;
            }
        }
        if (ddRoot) {
            var oldRows = findAllInTree(ddRoot, function (el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
            });
            for (var j = 0; j < oldRows.length; j++) {
                var p = findFirstInTree(oldRows[j], function (el) {
                    if (el.tagName !== 'P') return false;
                    var c = typeof el.className === 'string' ? el.className : '';
                    return c.indexOf('text-ellipsis') >= 0;
                });
                if (!p) continue;
                var pText = (p.textContent || '').trim().toLowerCase();
                if (pText === targetLower || pText.includes(targetLower) || targetLower.includes(pText)) {
                    oldRows[j].click();
                    return { success: true, selected: (p.textContent || '').trim() };
                }
            }
        }

        return { success: false, error: 'mode not found in dropdown' };
    }) ()
        `.trim();

        const selectResult = await ops.evaluateInCascade(selectScript) as {
            success: boolean;
            selected?: string;
            error?: string;
        };

        if (selectResult?.success) {
            logDebug(`cdpModes: selectMode — selected "${selectResult.selected}"`);
            return true;
        }

        // 選択失敗 → ドロップダウンを閉じる
        try {
            await ops.conn.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                windowsVirtualKeyCode: 27,
                code: 'Escape',
                key: 'Escape',
            });
        } catch { /* ignore */ }

        logWarn(`cdpModes: selectMode — mode "${modeName}" not found: ${selectResult?.error} `);
        return false;
    } catch (e) {
        logWarn(`cdpModes: selectMode failed — ${e instanceof Error ? e.message : e} `);
        return false;
    }
}
