// ---------------------------------------------------------------------------
// cdpModels.ts — CDP 経由でモデルドロップダウンを操作
// ---------------------------------------------------------------------------
// DOM 構造 (Antigravity cascade-panel):
//
// モデルボタン（チャット入力欄の下）:
//   textbox 親を辿り、siblings から button[class*="relative"][class*="flex"]
//
// ドロップダウン（モデルボタンクリック後に出現）:
//   div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]
//     → "Model" ヘッダー (div[class*="opacity-80"])
//     → 各モデル: p[class*="text-ellipsis"][class*="whitespace-nowrap"]
//     → クリック先: div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]
// ---------------------------------------------------------------------------

import { CdpBridgeOps } from './cdpHistory';
import { logDebug, logWarn } from './logger';

// -----------------------------------------------------------------------
// 共通: モデルボタンを見つける JS スニペット
// -----------------------------------------------------------------------

const FIND_MODEL_BUTTON = `
    var modelBtn = null;
    var _findDebug = { textboxFound: false, levelsSearched: 0, siblingsChecked: 0, fallbackUsed: false, buttonsFound: 0, allBtnTexts: [], inIframe: false };

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

        // primary: textbox 兄弟方向(後方)で button/vscode-button/role=button を探す
        for (var d = 0; d < 5; d++) {
            if (!container) break;
            _findDebug.levelsSearched = d + 1;

            var allBtns = [];

            var sibling = container.nextElementSibling;
            while (sibling) {
                _findDebug.siblingsChecked++;
                var btns = findAllInTree(sibling, function(el) {
                    var tag = el.tagName.toLowerCase();
                    return tag === 'button' || tag === 'vscode-button' || el.getAttribute('role') === 'button';
                });
                _findDebug.buttonsFound += btns.length;
                for (var b = 0; b < btns.length; b++) {
                    var btnText = getBtnText(btns[b]);
                    if (btnText.length > 0) {
                        allBtns.push({ el: btns[b], text: btnText });
                    }
                }
                if (allBtns.length > 0) break;
                sibling = sibling.nextElementSibling;
            }

            // フォールバック: previousElementSibling 方向も探す
            if (allBtns.length === 0) {
                _findDebug.fallbackUsed = true;
                sibling = container.previousElementSibling;
                while (sibling) {
                    _findDebug.siblingsChecked++;
                    var btns2 = findAllInTree(sibling, function(el) {
                        var tag = el.tagName.toLowerCase();
                        return tag === 'button' || tag === 'vscode-button' || el.getAttribute('role') === 'button';
                    });
                    _findDebug.buttonsFound += btns2.length;
                    for (var b2 = 0; b2 < btns2.length; b2++) {
                        var btnText2 = getBtnText(btns2[b2]);
                        if (btnText2.length > 0) {
                            allBtns.push({ el: btns2[b2], text: btnText2 });
                        }
                    }
                    if (allBtns.length > 0) break;
                    sibling = sibling.previousElementSibling;
                }
            }

            if (allBtns.length > 0) {
                _findDebug.allBtnTexts = allBtns.map(function(b) { return b.text; });
                // モデルボタンは最後のテキスト付きボタン（モードが先、モデルが後）
                modelBtn = allBtns[allBtns.length - 1].el;
                break;
            }
            container = container.parentElement;
        }
    }
`;

// -----------------------------------------------------------------------
// getCurrentModel — 現在選択中のモデル名を取得
// -----------------------------------------------------------------------

export async function getCurrentModel(
    ops: CdpBridgeOps,
): Promise<string | null> {
    try {
        await ops.conn.connect();

        const script = `
(function() {
    ${FIND_MODEL_BUTTON}
    if (!modelBtn) return null;
    return getBtnText(modelBtn);
})()
        `.trim();

        const result = await ops.evaluateInCascade(script);
        if (typeof result === 'string' && result.length > 0) {
            logDebug(`cdpModels: getCurrentModel = "${result}"`);
            return result;
        }

        logDebug('cdpModels: getCurrentModel — model selector not found');
        return null;
    } catch (e) {
        logWarn(`cdpModels: getCurrentModel failed — ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

// -----------------------------------------------------------------------
// getAvailableModels — ドロップダウンを開いて選択肢を取得
// -----------------------------------------------------------------------

/** デバッグログエントリ */
export interface ModelDebugEntry {
    step: string;
    success: boolean;
    detail: string;
    timestamp: string;
}

export async function getAvailableModels(
    ops: CdpBridgeOps,
): Promise<{ models: string[]; current: string | null; debugLog: ModelDebugEntry[] }> {
    const debugLog: ModelDebugEntry[] = [];
    const log = (step: string, success: boolean, detail: string) => {
        debugLog.push({ step, success, detail, timestamp: new Date().toISOString() });
    };

    logDebug('cdpModels: getAvailableModels — start');

    // Step 1: CDP 接続
    try {
        await ops.conn.connect();
        log('connect', true, 'connected successfully');
        logDebug('cdpModels: getAvailableModels — connected');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('connect', false, msg);
        logWarn(`cdpModels: getAvailableModels — connect failed: ${msg}`);
        return { models: [], current: null, debugLog };
    }

    let currentModel: string | null = null;

    try {
        // Step 2: cascade コンテキスト + モデルボタンクリック
        const openScript = `
(function() {
    ${FIND_MODEL_BUTTON}
    if (!modelBtn) return { success: false, error: 'model button not found', findDebug: _findDebug };

    var curModel = getBtnText(modelBtn);

    modelBtn.click();
    return { success: true, currentModel: curModel, findDebug: _findDebug };
})()
        `.trim();

        type OpenResult = { success: boolean; currentModel?: string; error?: string; findDebug?: Record<string, unknown> };

        let openResult: OpenResult | null = null;

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                logDebug(`cdpModels: getAvailableModels — evaluateInCascade attempt ${attempt + 1}`);
                openResult = await ops.evaluateInCascade(openScript) as OpenResult;
                log('cascade_eval', true, `attempt=${attempt + 1}, result=${JSON.stringify(openResult)}`);
                break;
            } catch (cascadeErr) {
                const msg = cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr);
                log('cascade_eval', false, `attempt=${attempt + 1}, error=${msg}`);
                logWarn(`cdpModels: getAvailableModels — cascade attempt ${attempt + 1} failed: ${msg}`);
                if (attempt === 0) {
                    ops.resetCascadeContext();
                    await ops.sleep(300);
                } else {
                    throw cascadeErr;
                }
            }
        }

        if (!openResult?.success) {
            log('model_button', false, `error=${openResult?.error || 'unknown'}, findDebug=${JSON.stringify(openResult?.findDebug)}`);
            logWarn(`cdpModels: getAvailableModels — open failed: ${openResult?.error}, findDebug=${JSON.stringify(openResult?.findDebug)}`);
            return { models: [], current: null, debugLog };
        }

        log('model_button', true, `currentModel="${openResult.currentModel || ''}", findDebug=${JSON.stringify(openResult.findDebug)}`);
        currentModel = openResult.currentModel || null;

        // Step 3: ドロップダウン待機
        await ops.sleep(500);
        log('dropdown_wait', true, 'waited 500ms');

        // Step 4: モデル名取得
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
    var ddNew = findAllInTree(doc, function(el) {
        if (el.tagName !== 'DIV') return false;
        var c = typeof el.className === 'string' ? el.className : '';
        return c.indexOf('z-50') >= 0 && c.indexOf('rounded-md') >= 0 && c.indexOf('border') >= 0 && c.indexOf('shadow-md') >= 0;
    });
    for (var dn = 0; dn < ddNew.length; dn++) {
        var modelRows = findAllInTree(ddNew[dn], function(el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
        });
        for (var mr = 0; mr < modelRows.length; mr++) {
            var fontMedium = findFirstInTree(modelRows[mr], function(el) {
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

    // フォールバック: 旧 UI 構造 (absolute + overflow-y-auto + "Model" ヘッダー)
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
            if (headerCheck && (headerCheck.textContent || '').trim() === 'Model') {
                ddRoot = dropdowns[d];
                debugInfo.headerFound = true;
                break;
            }
        }
        if (ddRoot) {
            var modelLabels = findAllInTree(ddRoot, function(el) {
                if (el.tagName !== 'P') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('overflow-hidden') >= 0 && c.indexOf('text-ellipsis') >= 0 && c.indexOf('whitespace-nowrap') >= 0;
            });
            debugInfo.labelsFound = modelLabels.length;
            for (var i = 0; i < modelLabels.length; i++) {
                var t = (modelLabels[i].textContent || '').trim();
                if (t.length > 0 && t.length < 100) items.push(t);
            }
        }
    }

    return { items: items, debug: debugInfo };
})()
        `.trim();

        const listResult = await ops.evaluateInCascade(listScript) as { items: string[]; debug: Record<string, unknown> } | string[];

        let models: string[];
        if (Array.isArray(listResult)) {
            // 古い形式（互換性）
            models = listResult;
            log('model_list', true, `count=${models.length} (legacy format)`);
        } else if (listResult && typeof listResult === 'object' && 'items' in listResult) {
            models = listResult.items || [];
            log('model_list', models.length > 0, `count=${models.length}, debug=${JSON.stringify(listResult.debug)}`);
        } else {
            models = [];
            log('model_list', false, `unexpected result type: ${typeof listResult}, value=${JSON.stringify(listResult)}`);
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

        const modelList = Array.isArray(models) ? models : [];
        logDebug(`cdpModels: getAvailableModels — found ${modelList.length} models, current="${currentModel}"`);

        return {
            models: modelList,
            current: currentModel,
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
        logWarn(`cdpModels: getAvailableModels failed — ${msg}`);
        return { models: [], current: currentModel, debugLog };
    }
}

// -----------------------------------------------------------------------
// selectModel — 指定モデルを選択
// -----------------------------------------------------------------------

export async function selectModel(
    ops: CdpBridgeOps,
    modelName: string,
): Promise<boolean> {
    try {
        await ops.conn.connect();

        // 1. モデルボタンをクリックしてドロップダウンを開く
        const openScript = `
(function() {
    ${FIND_MODEL_BUTTON}
    if (!modelBtn) return false;
    modelBtn.click();
    return true;
})()
        `.trim();

        const opened = await ops.evaluateInCascade(openScript);
        if (!opened) {
            logWarn('cdpModels: selectModel — could not open dropdown');
            return false;
        }

        await ops.sleep(500);

        // 2. ドロップダウン内で目的のモデルをクリック
        const selectScript = `
(function() {
    var targetModel = ${JSON.stringify(modelName)};
    var targetLower = targetModel.toLowerCase();

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
    var ddNew = findAllInTree(doc, function(el) {
        if (el.tagName !== 'DIV') return false;
        var c = typeof el.className === 'string' ? el.className : '';
        return c.indexOf('z-50') >= 0 && c.indexOf('rounded-md') >= 0 && c.indexOf('border') >= 0 && c.indexOf('shadow-md') >= 0;
    });
    for (var dn = 0; dn < ddNew.length; dn++) {
        var modelRows = findAllInTree(ddNew[dn], function(el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
        });
        for (var i = 0; i < modelRows.length; i++) {
            var fontMedium = findFirstInTree(modelRows[i], function(el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('font-medium') >= 0;
            });
            if (!fontMedium) continue;
            var mText = (fontMedium.textContent || '').trim().toLowerCase();
            if (mText === targetLower || mText.includes(targetLower) || targetLower.includes(mText)) {
                modelRows[i].click();
                return { success: true, selected: (fontMedium.textContent || '').trim() };
            }
        }
    }

    // フォールバック: 旧 UI 構造
    var dropdowns = findAllInTree(doc, function(el) {
        if (el.tagName !== 'DIV') return false;
        var c = typeof el.className === 'string' ? el.className : '';
        return c.indexOf('absolute') >= 0 && c.indexOf('overflow-y-auto') >= 0 && c.indexOf('rounded-lg') >= 0 && c.indexOf('border') >= 0;
    });
    var ddRoot = null;
    for (var d = 0; d < dropdowns.length; d++) {
        var headerCheck = findFirstInTree(dropdowns[d], function(el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('opacity-80') >= 0;
        });
        if (headerCheck && (headerCheck.textContent || '').trim() === 'Model') {
            ddRoot = dropdowns[d];
            break;
        }
    }
    if (ddRoot) {
        var oldRows = findAllInTree(ddRoot, function(el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
        });
        for (var j = 0; j < oldRows.length; j++) {
            var p = findFirstInTree(oldRows[j], function(el) {
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

    return { success: false, error: 'model not found in dropdown' };
})()
        `.trim();

        const selectResult = await ops.evaluateInCascade(selectScript) as {
            success: boolean;
            selected?: string;
            error?: string;
        };

        if (selectResult?.success) {
            logDebug(`cdpModels: selectModel — selected "${selectResult.selected}"`);
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

        logWarn(`cdpModels: selectModel — model "${modelName}" not found: ${selectResult?.error}`);
        return false;
    } catch (e) {
        logWarn(`cdpModels: selectModel failed — ${e instanceof Error ? e.message : e}`);
        return false;
    }
}
