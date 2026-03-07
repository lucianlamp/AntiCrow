// ---------------------------------------------------------------------------
// cdpModeQuery.ts — モード情報の取得（getCurrentMode, getAvailableModes）
// ---------------------------------------------------------------------------
// cdpModes.ts から分離。CDP 経由で現在のモード名の取得と、
// ドロップダウンを開いてモード一覧を取得する機能を提供する。
// ---------------------------------------------------------------------------

import { CdpBridgeOps } from './cdpHistory';
import { logDebug, logWarn } from './logger';
import { FIND_MODE_BUTTON } from './cdpModeScripts';

// -----------------------------------------------------------------------
// getCurrentMode — 現在選択中のモード名を取得
// -----------------------------------------------------------------------

// 既知のモード名（小文字）。ここに含まれないテキストはモードと見なさない。
const KNOWN_MODES = ['planning', 'fast'];

/** 取得したテキストが既知のモード名に一致するか検証 */
function isKnownMode(text: string): boolean {
    const lower = text.toLowerCase();
    return KNOWN_MODES.some(m => lower === m || lower.includes(m));
}

export async function getCurrentMode(
    ops: CdpBridgeOps,
): Promise<string | null> {
    try {
        await ops.conn.connect();

        const script = `
(function() {
    ${FIND_MODE_BUTTON}
    if (!modeBtn) return { text: null, debug: _findDebug };
    var p = findFirstInTree(modeBtn, function(el) { return el.tagName === 'P'; });
    var sp = findFirstInTree(modeBtn, function(el) { return el.tagName === 'SPAN'; });
    var textEl = p || sp;
    var btnText = textEl ? (textEl.textContent || '').trim() : (modeBtn.innerText || modeBtn.textContent || '').trim();
    return { text: btnText, debug: _findDebug };
})()
        `.trim();

        // 1. cascade コンテキストで試行
        const result = await ops.evaluateInCascade(script) as { text: string | null; debug: Record<string, unknown> } | string | null;

        if (result && typeof result === 'object' && 'debug' in result) {
            logDebug(`cdpModes: getCurrentMode cascade debug=${JSON.stringify(result.debug)}`);
            if (typeof result.text === 'string' && result.text.length > 0) {
                if (!isKnownMode(result.text)) {
                    logWarn(`cdpModes: getCurrentMode — unexpected mode text "${result.text}" (not in KNOWN_MODES), returning null`);
                    return null;
                }
                logDebug(`cdpModes: getCurrentMode = "${result.text}" (cascade)`);
                return result.text;
            }
        } else if (typeof result === 'string' && result.length > 0) {
            if (!isKnownMode(result)) {
                logWarn(`cdpModes: getCurrentMode — unexpected mode text "${result}" (not in KNOWN_MODES), returning null`);
                return null;
            }
            logDebug(`cdpModes: getCurrentMode = "${result}" (cascade/legacy)`);
            return result;
        }

        // 2. メインフレームフォールバック
        logDebug('cdpModes: getCurrentMode — cascade failed, trying main frame');
        try {
            const mainResult = await ops.conn.evaluate(script) as { text: string | null; debug: Record<string, unknown> } | string | null;
            if (mainResult && typeof mainResult === 'object' && 'debug' in mainResult) {
                logDebug(`cdpModes: getCurrentMode main debug=${JSON.stringify(mainResult.debug)}`);
                if (typeof mainResult.text === 'string' && mainResult.text.length > 0) {
                    if (!isKnownMode(mainResult.text)) {
                        logWarn(`cdpModes: getCurrentMode — unexpected mode text "${mainResult.text}" from main frame (not in KNOWN_MODES), returning null`);
                        return null;
                    }
                    logDebug(`cdpModes: getCurrentMode = "${mainResult.text}" (main)`);
                    return mainResult.text;
                }
            } else if (typeof mainResult === 'string' && mainResult.length > 0) {
                if (!isKnownMode(mainResult)) {
                    logWarn(`cdpModes: getCurrentMode — unexpected mode text "${mainResult}" from main frame (not in KNOWN_MODES), returning null`);
                    return null;
                }
                logDebug(`cdpModes: getCurrentMode = "${mainResult}" (main/legacy)`);
                return mainResult;
            }
        } catch (mainErr) {
            logDebug(`cdpModes: getCurrentMode main frame fallback failed: ${mainErr instanceof Error ? mainErr.message : mainErr}`);
        }

        logDebug('cdpModes: getCurrentMode — not found in cascade or main frame');
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

    // 重複排除（findAllInTree が shadowRoot を含む再帰的トラバースで同一要素を複数回収集する場合がある）
    var uniqueItems = [];
    var seen = {};
    for (var ui = 0; ui < items.length; ui++) {
        if (!seen[items[ui]]) {
            seen[items[ui]] = true;
            uniqueItems.push(items[ui]);
        }
    }
    return { items: uniqueItems, debug: debugInfo, activeMode: activeMode };
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

        const modeList = Array.isArray(modes) ? [...new Set(modes)] : [];
        logDebug(`cdpModes: getAvailableModes — found ${modeList.length} modes (deduped), current = "${currentMode}"`);

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
