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
import { logInfo, logDebug, logWarn } from './logger';

// -----------------------------------------------------------------------
// 共通: モードボタンを見つける JS スニペット
// -----------------------------------------------------------------------
// モードボタンはモデルボタンの左に位置する。
// textbox から親方向に辿り、ボタン群のうちモデルボタンより前にある
// p タグを持つ button をモードボタンとして検出する。
// -----------------------------------------------------------------------

const FIND_MODE_BUTTON = `
    var modeBtn = null;
    var _findDebug = { textboxFound: false, levelsSearched: 0, siblingsChecked: 0, buttonsWithP: 0, buttonsWithSpan: 0, found: false };
    var textbox = document.querySelector('div[role="textbox"]');
    if (textbox) {
        _findDebug.textboxFound = true;
        var container = textbox.parentElement;

        for (var d = 0; d < 5; d++) {
            if (!container) break;
            _findDebug.levelsSearched = d + 1;

            // このコンテナの兄弟を全て走査し、テキストを持つ button を全て収集
            var allBtns = [];
            var sibling = container.nextElementSibling;
            while (sibling) {
                _findDebug.siblingsChecked++;
                var btns = sibling.querySelectorAll('button');
                for (var b = 0; b < btns.length; b++) {
                    var pEl = btns[b].querySelector('p');
                    var spanEl = btns[b].querySelector('span');
                    var hasPText = pEl && (pEl.textContent || '').trim().length > 0;
                    var hasSpanText = spanEl && (spanEl.textContent || '').trim().length > 0;
                    if (hasPText) _findDebug.buttonsWithP++;
                    if (hasSpanText) _findDebug.buttonsWithSpan++;
                    if (hasPText || hasSpanText) {
                        allBtns.push({ el: btns[b], hasP: !!hasPText, hasSpan: !!hasSpanText });
                    }
                }
                sibling = sibling.nextElementSibling;
            }
            // previousElementSibling 方向も探索
            sibling = container.previousElementSibling;
            while (sibling) {
                _findDebug.siblingsChecked++;
                var btns2 = sibling.querySelectorAll('button');
                for (var b2 = 0; b2 < btns2.length; b2++) {
                    var pEl2 = btns2[b2].querySelector('p');
                    var spanEl2 = btns2[b2].querySelector('span');
                    var hasPText2 = pEl2 && (pEl2.textContent || '').trim().length > 0;
                    var hasSpanText2 = spanEl2 && (spanEl2.textContent || '').trim().length > 0;
                    if (hasPText2) _findDebug.buttonsWithP++;
                    if (hasSpanText2) _findDebug.buttonsWithSpan++;
                    if (hasPText2 || hasSpanText2) {
                        allBtns.unshift({ el: btns2[b2], hasP: !!hasPText2, hasSpan: !!hasSpanText2 }); // 前方に追加
                    }
                }
                sibling = sibling.previousElementSibling;
            }

            // モードボタンを識別:
            // - モデルボタン（p タグ有り）が存在し、その前に span タグ有りのボタンがあればそれがモードボタン
            // - 2つ以上の p ボタンがある場合は従来通り最初のボタンがモードボタン
            var modelBtnIdx = allBtns.findIndex(function(b) { return b.hasP; });
            if (modelBtnIdx > 0) {
                // モデルボタンより前にあるテキストボタン（span）をモードボタンとする
                modeBtn = allBtns[modelBtnIdx - 1].el;
                _findDebug.found = true;
                break;
            }
            if (allBtns.length >= 2) {
                // フォールバック: 2つ以上のテキストボタンがあれば最初のものがモードボタン
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
    var p = modeBtn.querySelector('p');
    var sp = modeBtn.querySelector('span');
    var textEl = p || sp;
    return textEl ? (textEl.textContent || '').trim() : (modeBtn.innerText || '').trim();
})()
        `.trim();

        const result = await ops.evaluateInCascade(script);
        if (typeof result === 'string' && result.length > 0) {
            logInfo(`cdpModes: getCurrentMode = "${result}"`);
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

    var p = modeBtn.querySelector('p');
    var sp = modeBtn.querySelector('span');
    var textEl = p || sp;
    var curMode = textEl ? (textEl.textContent || '').trim() : (modeBtn.innerText || '').trim();

    modeBtn.click();
    return { success: true, currentMode: curMode, findDebug: _findDebug };
})()
        `.trim();

        type OpenResult = { success: boolean; currentMode?: string; error?: string; findDebug?: any };

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
    var debugInfo = { dropdownsFound: 0, headerFound: false, labelsFound: 0, fallbackUsed: false, newSelectorUsed: false };

    // 新しい UI 構造: z-50 rounded-md border shadow-md のドロップダウン
    // モード項目は div.cursor-pointer > div.font-medium にテキスト
    var ddNew = document.querySelectorAll('div[class*="z-50"][class*="rounded-md"][class*="border"][class*="shadow-md"]');
    for (var dn = 0; dn < ddNew.length; dn++) {
        var modeRows = ddNew[dn].querySelectorAll('div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]');
        for (var mr = 0; mr < modeRows.length; mr++) {
            var fontMedium = modeRows[mr].querySelector('div[class*="font-medium"]');
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
        var dropdowns = document.querySelectorAll('div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]');
        debugInfo.dropdownsFound = dropdowns.length;
        var ddRoot = null;
        for (var d = 0; d < dropdowns.length; d++) {
            var headerCheck = dropdowns[d].querySelector('div[class*="opacity-80"]');
            if (headerCheck && (headerCheck.textContent || '').trim() === 'Mode') {
                ddRoot = dropdowns[d];
                debugInfo.headerFound = true;
                break;
            }
        }
        if (ddRoot) {
            var modeLabels = ddRoot.querySelectorAll('p[class*="overflow-hidden"][class*="text-ellipsis"][class*="whitespace-nowrap"]');
            debugInfo.labelsFound = modeLabels.length;
            for (var i = 0; i < modeLabels.length; i++) {
                var t = (modeLabels[i].textContent || '').trim();
                if (t.length > 0 && t.length < 100) items.push(t);
            }
        }
    }

    return { items: items, debug: debugInfo };
})()
        `.trim();

        const listResult = await ops.evaluateInCascade(listScript) as { items: string[]; debug: any } | string[];

        let modes: string[];
        if (Array.isArray(listResult)) {
            modes = listResult;
            log('mode_list', true, `count=${modes.length} (legacy format)`);
        } else if (listResult && typeof listResult === 'object' && 'items' in listResult) {
            modes = listResult.items || [];
            log('mode_list', modes.length > 0, `count=${modes.length}, debug=${JSON.stringify(listResult.debug)}`);
        } else {
            modes = [];
            log('mode_list', false, `unexpected result type: ${typeof listResult}, value=${JSON.stringify(listResult)}`);
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
        logInfo(`cdpModes: getAvailableModes — found ${modeList.length} modes, current="${currentMode}"`);

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
        logWarn(`cdpModes: getAvailableModes failed — ${msg}`);
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
(function() {
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
(function() {
    var targetMode = ${JSON.stringify(modeName)};
    var targetLower = targetMode.toLowerCase();

    // 新しい UI 構造: z-50 rounded-md border shadow-md
    var ddNew = document.querySelectorAll('div[class*="z-50"][class*="rounded-md"][class*="border"][class*="shadow-md"]');
    for (var dn = 0; dn < ddNew.length; dn++) {
        var modeRows = ddNew[dn].querySelectorAll('div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]');
        for (var i = 0; i < modeRows.length; i++) {
            var fontMedium = modeRows[i].querySelector('div[class*="font-medium"]');
            if (!fontMedium) continue;
            var mText = (fontMedium.textContent || '').trim().toLowerCase();
            if (mText === targetLower || mText.includes(targetLower) || targetLower.includes(mText)) {
                modeRows[i].click();
                return { success: true, selected: (fontMedium.textContent || '').trim() };
            }
        }
    }

    // フォールバック: 旧 UI 構造
    var dropdowns = document.querySelectorAll('div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]');
    var ddRoot = null;
    for (var d = 0; d < dropdowns.length; d++) {
        var headerCheck = dropdowns[d].querySelector('div[class*="opacity-80"]');
        if (headerCheck && (headerCheck.textContent || '').trim() === 'Mode') {
            ddRoot = dropdowns[d];
            break;
        }
    }
    if (ddRoot) {
        var oldRows = ddRoot.querySelectorAll('div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]');
        for (var j = 0; j < oldRows.length; j++) {
            var p = oldRows[j].querySelector('p[class*="text-ellipsis"]');
            if (!p) continue;
            var pText = (p.textContent || '').trim().toLowerCase();
            if (pText === targetLower || pText.includes(targetLower) || targetLower.includes(pText)) {
                oldRows[j].click();
                return { success: true, selected: (p.textContent || '').trim() };
            }
        }
    }

    return { success: false, error: 'mode not found in dropdown' };
})()
        `.trim();

        const selectResult = await ops.evaluateInCascade(selectScript) as {
            success: boolean;
            selected?: string;
            error?: string;
        };

        if (selectResult?.success) {
            logInfo(`cdpModes: selectMode — selected "${selectResult.selected}"`);
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

        logWarn(`cdpModes: selectMode — mode "${modeName}" not found: ${selectResult?.error}`);
        return false;
    } catch (e) {
        logWarn(`cdpModes: selectMode failed — ${e instanceof Error ? e.message : e}`);
        return false;
    }
}
