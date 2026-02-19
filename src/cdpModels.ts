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
    var _findDebug = { textboxFound: false, levelsSearched: 0, siblingsChecked: 0, fallbackUsed: false, buttonsFound: 0 };
    var textbox = document.querySelector('div[role="textbox"]');
    if (textbox) {
        _findDebug.textboxFound = true;
        var container = textbox.parentElement;
        for (var d = 0; d < 5; d++) {
            if (!container) break;
            _findDebug.levelsSearched = d + 1;
            var sibling = container.nextElementSibling;
            while (sibling) {
                _findDebug.siblingsChecked++;
                var _btn = sibling.querySelector('button[class*="relative"][class*="flex"][class*="cursor-pointer"]');
                if (_btn) { modelBtn = _btn; break; }
                sibling = sibling.nextElementSibling;
            }
            if (modelBtn) break;
            container = container.parentElement;
        }

        // フォールバック: セレクタが合わない場合、textbox 近傍の button で p タグを持つものを探す
        if (!modelBtn) {
            _findDebug.fallbackUsed = true;
            container = textbox.parentElement;
            for (var d2 = 0; d2 < 5; d2++) {
                if (!container) break;
                var sibling2 = container.nextElementSibling;
                while (sibling2) {
                    var btns = sibling2.querySelectorAll('button');
                    _findDebug.buttonsFound += btns.length;
                    for (var b = 0; b < btns.length; b++) {
                        var pEl = btns[b].querySelector('p');
                        if (pEl && (pEl.textContent || '').trim().length > 0) {
                            modelBtn = btns[b];
                            break;
                        }
                    }
                    if (modelBtn) break;
                    sibling2 = sibling2.nextElementSibling;
                }
                if (modelBtn) break;
                container = container.parentElement;
            }
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
    var p = modelBtn.querySelector('p');
    return p ? (p.textContent || '').trim() : (modelBtn.innerText || '').trim();
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

    var p = modelBtn.querySelector('p');
    var curModel = p ? (p.textContent || '').trim() : (modelBtn.innerText || '').trim();

    modelBtn.click();
    return { success: true, currentModel: curModel, findDebug: _findDebug };
})()
        `.trim();

        type OpenResult = { success: boolean; currentModel?: string; error?: string; findDebug?: any };

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
    var debugInfo = { dropdownsFound: 0, headerFound: false, labelsFound: 0, fallbackUsed: false };

    var dropdowns = document.querySelectorAll('div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]');
    debugInfo.dropdownsFound = dropdowns.length;
    var ddRoot = null;
    for (var d = 0; d < dropdowns.length; d++) {
        var headerCheck = dropdowns[d].querySelector('div[class*="opacity-80"]');
        if (headerCheck && (headerCheck.textContent || '').trim() === 'Model') {
            ddRoot = dropdowns[d];
            debugInfo.headerFound = true;
            break;
        }
    }

    if (ddRoot) {
        var modelLabels = ddRoot.querySelectorAll('p[class*="overflow-hidden"][class*="text-ellipsis"][class*="whitespace-nowrap"]');
        debugInfo.labelsFound = modelLabels.length;
        for (var i = 0; i < modelLabels.length; i++) {
            var text = (modelLabels[i].textContent || '').trim();
            if (text.length > 0 && text.length < 100) {
                items.push(text);
            }
        }
    }

    if (items.length === 0) {
        debugInfo.fallbackUsed = true;
        var allDivs = document.querySelectorAll('div');
        for (var j = 0; j < allDivs.length; j++) {
            var directText = '';
            for (var c = 0; c < allDivs[j].childNodes.length; c++) {
                if (allDivs[j].childNodes[c].nodeType === 3) directText += allDivs[j].childNodes[c].textContent;
            }
            if (directText.trim() === 'Model' && allDivs[j].className.includes('opacity-80')) {
                var listContainer = allDivs[j].nextElementSibling;
                if (listContainer) {
                    var labels = listContainer.querySelectorAll('p[class*="text-ellipsis"]');
                    for (var l = 0; l < labels.length; l++) {
                        var lText = (labels[l].textContent || '').trim();
                        if (lText.length > 0 && lText.length < 100) items.push(lText);
                    }
                }
                break;
            }
        }
    }

    return { items: items, debug: debugInfo };
})()
        `.trim();

        const listResult = await ops.evaluateInCascade(listScript) as { items: string[]; debug: any } | string[];

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

    // ドロップダウンルートを特定
    var dropdowns = document.querySelectorAll('div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]');
    var ddRoot = null;
    for (var d = 0; d < dropdowns.length; d++) {
        var headerCheck = dropdowns[d].querySelector('div[class*="opacity-80"]');
        if (headerCheck && (headerCheck.textContent || '').trim() === 'Model') {
            ddRoot = dropdowns[d];
            break;
        }
    }

    if (!ddRoot) return { success: false, error: 'dropdown not found' };

    // cursor-pointer を持つモデル行を検索
    var modelRows = ddRoot.querySelectorAll('div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]');
    for (var i = 0; i < modelRows.length; i++) {
        var p = modelRows[i].querySelector('p[class*="text-ellipsis"]');
        if (!p) continue;
        var pText = (p.textContent || '').trim().toLowerCase();
        if (pText === targetLower || pText.includes(targetLower) || targetLower.includes(pText)) {
            modelRows[i].click();
            return { success: true, selected: (p.textContent || '').trim() };
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
