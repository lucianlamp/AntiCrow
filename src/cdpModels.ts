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
    var _findDebug = { textboxFound: false, levelsSearched: 0, siblingsChecked: 0, fallbackUsed: false, buttonsFound: 0, allBtnTexts: [], inIframe: false, matchMethod: '' };

    // モデル名キーワード — ボタンテキストにこれらが含まれていればモデルボタン
    var MODEL_KEYWORDS = ['claude', 'gemini', 'gpt', 'sonnet', 'haiku', 'opus'];

    function isModelText(text) {
        var lower = text.toLowerCase();
        for (var ki = 0; ki < MODEL_KEYWORDS.length; ki++) {
            if (lower.indexOf(MODEL_KEYWORDS[ki]) >= 0) return true;
        }
        return false;
    }

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

    // 全 textbox を列挙し、チャットパネルのものだけ使用
    var allTextboxes = findAllInTree(doc, function(el) {
        return el.tagName === 'DIV' && el.getAttribute('role') === 'textbox';
    });
    _findDebug.textboxCount = allTextboxes.length;

    for (var ti = 0; ti < allTextboxes.length; ti++) {
        var textbox = allTextboxes[ti];

        // 出力パネル除外: 祖先に output 系の要素があるかチェック
        var isOutputPanel = false;
        var ancestor = textbox.parentElement;
        for (var anc = 0; anc < 15; anc++) {
            if (!ancestor) break;
            var ancClass = typeof ancestor.className === 'string' ? ancestor.className : '';
            var ancId = ancestor.id || '';
            // 出力パネル・ターミナル・問題パネル等を除外
            if (ancClass.indexOf('output') >= 0 || ancId.indexOf('output') >= 0 ||
                ancClass.indexOf('terminal') >= 0 || ancId.indexOf('terminal') >= 0 ||
                ancClass.indexOf('problems') >= 0 || ancId.indexOf('problems') >= 0 ||
                ancClass.indexOf('debug-console') >= 0 || ancId.indexOf('debug-console') >= 0) {
                isOutputPanel = true;
                break;
            }
            ancestor = ancestor.parentElement;
        }
        if (isOutputPanel) {
            _findDebug.skippedOutputTextbox = ((_findDebug.skippedOutputTextbox || 0) + 1);
            continue;
        }

        _findDebug.textboxFound = true;
        _findDebug.textboxIndex = ti;
        var container = textbox.parentElement;

        var foundInThisTextbox = false;
        for (var d = 0; d < 8; d++) {
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
                _findDebug.buttonsFound += btns.length;
                for (var b = 0; b < btns.length; b++) {
                    var btnText = getBtnText(btns[b]);
                    if (btnText.length > 0) {
                        allBtns.push({ el: btns[b], text: btnText });
                    }
                }
                sibling = sibling.nextElementSibling;
            }

            if (allBtns.length > 0) {
                _findDebug.allBtnTexts = allBtns.map(function(b) { return b.text; });
                _findDebug.buttonsFound = allBtns.length;

                // 戦略1: テキストにモデル名キーワードが含まれるボタンを優先
                for (var mi = 0; mi < allBtns.length; mi++) {
                    if (isModelText(allBtns[mi].text)) {
                        modelBtn = allBtns[mi].el;
                        _findDebug.matchMethod = 'keyword';
                        break;
                    }
                }

                // 戦略2: aria-expanded 属性を持ち、モデル名キーワードを含むボタン
                if (!modelBtn) {
                    for (var ai = 0; ai < allBtns.length; ai++) {
                        if (allBtns[ai].el.hasAttribute('aria-expanded') && isModelText(allBtns[ai].text)) {
                            modelBtn = allBtns[ai].el;
                            _findDebug.matchMethod = 'aria-expanded+keyword';
                            break;
                        }
                    }
                }

                // 戦略3: モードキーワード（Planning, Fast 等）でないボタンを選択
                if (!modelBtn) {
                    var MODE_KEYWORDS = ['planning', 'fast', 'normal', 'agent', 'ask', 'edit', 'chat'];
                    var UI_KEYWORDS = ['閉じる', 'close', 'その他の操作', '次に進む', '前に戻る', 'エディター', 'editor', 'コミット', 'commit', '破棄', 'discard', '受け入れる', 'accept', 'pencil', '分割', 'split', '検索', 'search', '置換', 'replace', '保存', 'save', '実行', 'run', 'debug', 'undo', 'redo', '元に戻す', 'やり直し', 'toggle', 'view', 'open', 'explorer', 'terminal', 'problems', 'output', 'extension',
                        // 追加: 出力パネル・クリア系ボタンの誤検出防止
                        '出力', 'クリア', 'clear', 'anticrow', 'antigravity', 'crash', 'quota', 'devtools', 'git', 'github', 'json', 'typescript', 'remote', 'renderer', 'pty', 'ホスト', 'タスク', 'メイン', 'トンネル', '拡張機能', '設定', '同期', 'interactive', 'artifacts', 'auth', 'cloudcode', 'perf', 'ウィンドウ', 'ターミナル', '共有',
                        'record', 'send', 'voice', 'memo', 'submit', 'cancel', 'stop', '中止'];
                    for (var ni = 0; ni < allBtns.length; ni++) {
                        var btnLower = allBtns[ni].text.toLowerCase();
                        // テキスト長が30文字超はUI操作系と判定し除外（モデル名は通常30文字未満）
                        if (allBtns[ni].text.length > 30) continue;
                        var isMode = false;
                        for (var mk = 0; mk < MODE_KEYWORDS.length; mk++) {
                            if (btnLower === MODE_KEYWORDS[mk] || btnLower.indexOf(MODE_KEYWORDS[mk]) >= 0) {
                                isMode = true;
                                break;
                            }
                        }
                        if (isMode) continue;
                        var isUI = false;
                        for (var uk = 0; uk < UI_KEYWORDS.length; uk++) {
                            if (btnLower.indexOf(UI_KEYWORDS[uk].toLowerCase()) >= 0) {
                                isUI = true;
                                break;
                            }
                        }
                        if (!isUI && allBtns[ni].text.length > 2) {
                            modelBtn = allBtns[ni].el;
                            _findDebug.matchMethod = 'not-mode';
                            break;
                        }
                    }
                }

                // このtextboxからモデルボタンが見つかった場合 → 採用
                if (modelBtn) {
                    foundInThisTextbox = true;
                    break;
                }

                // モデルボタンが見つからない場合、このtextboxはチャットパネルではない可能性
                // → 次のtextboxを試行（最終フォールバックは使わない）
                _findDebug.rejectedTextbox = ti;
                break;
            }
            container = container.parentElement;
        }
        if (foundInThisTextbox) break;
    }

    // 戦略B: ドキュメント全体からモデル名キーワードでボタンを検索（textbox親探索で見つからなかった場合）
    if (!modelBtn) {
        _findDebug.fallbackUsed = true;
        var MODEL_KW = ['claude', 'gemini', 'gpt', 'sonnet', 'haiku', 'opus'];
        var EXCLUDE_KW = ['planning', 'fast', 'normal', 'agent', 'ask', 'edit', 'chat', 'submit', 'cancel', 'close', 'save', 'send'];
        var allDocBtns = doc.querySelectorAll('button');
        var fallbackCandidates = [];
        for (var fb = 0; fb < allDocBtns.length; fb++) {
            var fbText = getBtnText(allDocBtns[fb]).toLowerCase();
            if (fbText.length < 2 || fbText.length > 60) continue;
            var hasModelKw = false;
            for (var mkw = 0; mkw < MODEL_KW.length; mkw++) {
                if (fbText.indexOf(MODEL_KW[mkw]) >= 0) { hasModelKw = true; break; }
            }
            if (!hasModelKw) continue;
            var hasExclude = false;
            for (var ekw = 0; ekw < EXCLUDE_KW.length; ekw++) {
                if (fbText === EXCLUDE_KW[ekw]) { hasExclude = true; break; }
            }
            if (!hasExclude) {
                fallbackCandidates.push({ el: allDocBtns[fb], text: fbText });
            }
        }
        _findDebug.fallbackCandidates = fallbackCandidates.length;
        if (fallbackCandidates.length > 0) {
            modelBtn = fallbackCandidates[0].el;
            _findDebug.matchMethod = 'doc-wide-keyword';
            _findDebug.fallbackBtnText = fallbackCandidates[0].text;
        }
    }

    // 戦略C: role='button' や role='option' 等の非 button 要素も検索
    if (!modelBtn) {
        var MODEL_KW_C = ['claude', 'gemini', 'gpt', 'sonnet', 'haiku', 'opus'];
        var roleEls = doc.querySelectorAll('[role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"]');
        _findDebug.roleElementsFound = roleEls.length;
        for (var rb = 0; rb < roleEls.length; rb++) {
            var rbText = getBtnText(roleEls[rb]).toLowerCase();
            if (rbText.length < 2 || rbText.length > 60) continue;
            for (var mkw = 0; mkw < MODEL_KW_C.length; mkw++) {
                if (rbText.indexOf(MODEL_KW_C[mkw]) >= 0) {
                    modelBtn = roleEls[rb];
                    _findDebug.matchMethod = 'role-element-keyword';
                    _findDebug.fallbackBtnText = rbText;
                    break;
                }
            }
            if (modelBtn) break;
        }
    }

    // デバッグ: ドキュメント内の全ボタンテキスト一覧を出力（最大30個）
    var allDocBtnTexts = [];
    var allBtnsDoc = doc.querySelectorAll('button');
    for (var di = 0; di < allBtnsDoc.length && di < 30; di++) {
        allDocBtnTexts.push(getBtnText(allBtnsDoc[di]).substring(0, 50));
    }
    _findDebug.allDocBtnTexts = allDocBtnTexts;
    _findDebug.totalDocButtons = allBtnsDoc.length;
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
    if (!modelBtn) return { text: null, debug: _findDebug };
    var rawText = getBtnText(modelBtn);
    // 末尾の「New」バッジテキストを除去
    var cleanText = rawText.replace(/\s*New\s*$/, '').replace(/New$/, '').trim();
    return { text: cleanText, debug: _findDebug };
})()
        `.trim();

        // 1. cascade コンテキストで試行
        const result = await ops.evaluateInCascade(script) as { text: string | null; debug: Record<string, unknown> } | string | null;

        if (result && typeof result === 'object' && 'debug' in result) {
            logDebug(`cdpModels: getCurrentModel cascade debug=${JSON.stringify(result.debug)}`);
            if (typeof result.text === 'string' && result.text.length > 0) {
                logDebug(`cdpModels: getCurrentModel = "${result.text}" (cascade)`);
                return result.text;
            }
        } else if (typeof result === 'string' && result.length > 0) {
            logDebug(`cdpModels: getCurrentModel = "${result}" (cascade/legacy)`);
            return result;
        }

        // 2. メインフレームフォールバック
        logDebug('cdpModels: getCurrentModel — cascade failed, trying main frame');
        try {
            const mainResult = await ops.conn.evaluate(script) as { text: string | null; debug: Record<string, unknown> } | string | null;
            if (mainResult && typeof mainResult === 'object' && 'debug' in mainResult) {
                logDebug(`cdpModels: getCurrentModel main debug=${JSON.stringify(mainResult.debug)}`);
                if (typeof mainResult.text === 'string' && mainResult.text.length > 0) {
                    logDebug(`cdpModels: getCurrentModel = "${mainResult.text}" (main)`);
                    return mainResult.text;
                }
            } else if (typeof mainResult === 'string' && mainResult.length > 0) {
                logDebug(`cdpModels: getCurrentModel = "${mainResult}" (main/legacy)`);
                return mainResult;
            }
        } catch (mainErr) {
            logDebug(`cdpModels: getCurrentModel main frame fallback failed: ${mainErr instanceof Error ? mainErr.message : mainErr}`);
        }

        logDebug('cdpModels: getCurrentModel — not found in cascade or main frame');
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

        // currentModel 検証: モデル名キーワードが含まれるかチェック
        // 含まれない場合は出力パネル等の誤検出 → Escape で閉じて cascade リセット → 再試行
        const MODEL_VERIFY_KW = ['claude', 'gemini', 'gpt', 'sonnet', 'haiku', 'opus'];
        const isValidModel = currentModel && MODEL_VERIFY_KW.some(kw => currentModel!.toLowerCase().includes(kw));

        if (!isValidModel && currentModel) {
            log('model_verify', false, `currentModel="${currentModel}" does not contain model keywords — likely output panel misdetection`);
            logWarn(`cdpModels: getAvailableModels — currentModel "${currentModel}" looks invalid, retrying...`);

            // 誤クリックしたドロップダウンを閉じる
            try {
                await ops.conn.send('Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    windowsVirtualKeyCode: 27,
                    code: 'Escape',
                    key: 'Escape',
                });
            } catch { /* ignore */ }
            await ops.sleep(300);

            // cascade リセットして再試行
            ops.resetCascadeContext();
            await ops.sleep(300);

            try {
                logDebug('cdpModels: getAvailableModels — retry after model verification failure');
                openResult = await ops.evaluateInCascade(openScript) as OpenResult;
                log('cascade_eval_retry', true, `result=${JSON.stringify(openResult)}`);

                if (openResult?.success) {
                    const retryModel = openResult.currentModel || null;
                    const retryValid = retryModel && MODEL_VERIFY_KW.some(kw => retryModel.toLowerCase().includes(kw));
                    if (retryValid) {
                        currentModel = retryModel;
                        log('model_verify_retry', true, `currentModel="${currentModel}" verified on retry`);
                    } else {
                        log('model_verify_retry', false, `retry currentModel="${retryModel}" still invalid`);
                        logWarn(`cdpModels: getAvailableModels — retry also returned invalid model "${retryModel}"`);
                        // 閉じてから終了
                        try {
                            await ops.conn.send('Input.dispatchKeyEvent', {
                                type: 'keyDown',
                                windowsVirtualKeyCode: 27,
                                code: 'Escape',
                                key: 'Escape',
                            });
                        } catch { /* ignore */ }
                        return { models: [], current: null, debugLog };
                    }
                } else {
                    log('cascade_eval_retry', false, `error=${openResult?.error}`);
                    return { models: [], current: null, debugLog };
                }
            } catch (retryErr) {
                const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                log('cascade_eval_retry', false, `error=${msg}`);
                return { models: [], current: null, debugLog };
            }
        } else if (isValidModel) {
            log('model_verify', true, `currentModel="${currentModel}" verified`);
        }

        // Step 3: ドロップダウン待機（少し長めに）
        await ops.sleep(800);
        log('dropdown_wait', true, 'waited 800ms');

        // Step 4: モデル名取得
        const listScript = `
(function() {
    var items = [];
    var debugInfo = { dropdownsFound: 0, headerFound: false, labelsFound: 0, fallbackUsed: false, newSelectorUsed: false, inIframe: false, allCandidateTexts: [] };

    // モデル名正規化: 末尾の「New」バッジテキストを除去
    function normalizeModelName(text) {
        return text.replace(/\s*New\s*$/, '').replace(/New$/, '').trim();
    }

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

    // モデル名キーワード — ドロップダウン項目がモデル名かの判定に使用
    var MODEL_KEYWORDS = ['claude', 'gemini', 'gpt', 'sonnet', 'haiku', 'opus'];
    function isModelItem(text) {
        var lower = text.toLowerCase();
        for (var ki = 0; ki < MODEL_KEYWORDS.length; ki++) {
            if (lower.indexOf(MODEL_KEYWORDS[ki]) >= 0) return true;
        }
        return false;
    }

    // 検索対象の document リストを構築（メインフレーム + cascade iframe の両方）
    var docsToSearch = [doc];
    if (doc !== document) {
        docsToSearch.push(document);
    } else {
        var allIframes = document.querySelectorAll('iframe');
        for (var ifi = 0; ifi < allIframes.length; ifi++) {
            try {
                if (allIframes[ifi].contentDocument) {
                    docsToSearch.push(allIframes[ifi].contentDocument);
                }
            } catch(e) { /* cross-origin */ }
        }
    }
    debugInfo.searchedDocs = docsToSearch.length;

    // 各 document でドロップダウンを検索（複数戦略）
    for (var docIdx = 0; docIdx < docsToSearch.length; docIdx++) {
        var searchDoc = docsToSearch[docIdx];

        // === 戦略A: 厳密CSSセレクタ (z-50 rounded-md border shadow-md) ===
        var ddStrict = findAllInTree(searchDoc, function(el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('z-50') >= 0 && c.indexOf('rounded-md') >= 0 && c.indexOf('border') >= 0 && c.indexOf('shadow-md') >= 0;
        });
        debugInfo.dropdownsFound += ddStrict.length;

        for (var dn = 0; dn < ddStrict.length; dn++) {
            var modelRows = findAllInTree(ddStrict[dn], function(el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
            });
            var candidates = [];
            for (var mr = 0; mr < modelRows.length; mr++) {
                var fontMedium = findFirstInTree(modelRows[mr], function(el) {
                    if (el.tagName !== 'DIV') return false;
                    var c = typeof el.className === 'string' ? el.className : '';
                    return c.indexOf('font-medium') >= 0;
                });
                if (fontMedium) {
                    // 直接テキストノードのみ連結（「New」バッジ等の子要素テキストを除外）
                    var directText = '';
                    for (var cn = 0; cn < fontMedium.childNodes.length; cn++) {
                        if (fontMedium.childNodes[cn].nodeType === 3) {
                            directText += fontMedium.childNodes[cn].textContent;
                        }
                    }
                    var text = directText.trim();
                    // 直接テキストが空の場合のみ textContent にフォールバック
                    if (!text) text = (fontMedium.textContent || '').trim();
                    text = normalizeModelName(text);
                    if (text.length > 0 && text.length < 100) candidates.push(text);
                }
            }
            if (candidates.length > 0) {
                debugInfo.allCandidateTexts.push({ strategy: 'A-strict', docIdx: docIdx, dropdown: dn, texts: candidates });
                var hasModelKw = false;
                for (var ci = 0; ci < candidates.length; ci++) {
                    if (isModelItem(candidates[ci])) { hasModelKw = true; break; }
                }
                if (hasModelKw) {
                    items = candidates;
                    debugInfo.matchStrategy = 'A-strict';
                    debugInfo.labelsFound = items.length;
                    debugInfo.matchedDocIdx = docIdx;
                    break;
                }
            }
        }
        if (items.length > 0) break;

        // === 戦略B: 緩和CSSセレクタ (z-50 のみ) ===
        var ddRelaxed = findAllInTree(searchDoc, function(el) {
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('z-50') >= 0;
        });
        debugInfo.relaxedDropdownsFound = (debugInfo.relaxedDropdownsFound || 0) + ddRelaxed.length;

        for (var dr = 0; dr < ddRelaxed.length; dr++) {
            // z-50 要素内の全テキストノードを収集してモデルキーワードを含むか確認
            var allTexts = [];
            var textEls = findAllInTree(ddRelaxed[dr], function(el) {
                var tag = el.tagName;
                return tag === 'DIV' || tag === 'SPAN' || tag === 'P' || tag === 'LI' || tag === 'BUTTON';
            });
            for (var te = 0; te < textEls.length; te++) {
                // 直接のテキストコンテンツ（子要素のテキストは除外）
                var directText = '';
                for (var cn = 0; cn < textEls[te].childNodes.length; cn++) {
                    if (textEls[te].childNodes[cn].nodeType === 3) {
                        directText += textEls[te].childNodes[cn].textContent;
                    }
                }
                directText = directText.trim();
                // 直接テキストがない場合は textContent を使う（ただし子が少ない要素のみ）
                if (!directText && textEls[te].children.length <= 2) {
                    directText = (textEls[te].textContent || '').trim();
                }
                if (directText.length > 0 && directText.length < 100 && isModelItem(directText)) {
                    allTexts.push(normalizeModelName(directText));
                }
            }
            if (allTexts.length > 0) {
                debugInfo.allCandidateTexts.push({ strategy: 'B-relaxed', docIdx: docIdx, dropdown: dr, texts: allTexts });
                items = allTexts;
                debugInfo.matchStrategy = 'B-relaxed';
                debugInfo.labelsFound = items.length;
                debugInfo.matchedDocIdx = docIdx;
                break;
            }
        }
        if (items.length > 0) break;

        // === 戦略C: ARIA ロールベース検索 ===
        var ariaRoles = ['listbox', 'menu'];
        for (var ri = 0; ri < ariaRoles.length; ri++) {
            var containers = findAllInTree(searchDoc, function(el) {
                return el.getAttribute && el.getAttribute('role') === ariaRoles[ri];
            });
            debugInfo.ariaContainersFound = (debugInfo.ariaContainersFound || 0) + containers.length;

            for (var ac = 0; ac < containers.length; ac++) {
                var optionEls = findAllInTree(containers[ac], function(el) {
                    var r = el.getAttribute && el.getAttribute('role');
                    return r === 'option' || r === 'menuitem' || r === 'menuitemradio';
                });
                var ariaTexts = [];
                for (var oe = 0; oe < optionEls.length; oe++) {
                    var oText = normalizeModelName((optionEls[oe].textContent || '').trim());
                    if (oText.length > 0 && oText.length < 100 && isModelItem(oText)) {
                        ariaTexts.push(oText);
                    }
                }
                if (ariaTexts.length > 0) {
                    debugInfo.allCandidateTexts.push({ strategy: 'C-aria', docIdx: docIdx, role: ariaRoles[ri], texts: ariaTexts });
                    items = ariaTexts;
                    debugInfo.matchStrategy = 'C-aria';
                    debugInfo.labelsFound = items.length;
                    debugInfo.matchedDocIdx = docIdx;
                    break;
                }
            }
            if (items.length > 0) break;
        }
        if (items.length > 0) break;

        // === 戦略D: 旧 UI 構造 (absolute + overflow-y-auto + "Model" ヘッダー) ===
        var dropdowns = findAllInTree(searchDoc, function(el) {
            if (el.tagName !== 'DIV') return false;
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('absolute') >= 0 && c.indexOf('overflow-y-auto') >= 0 && c.indexOf('rounded-lg') >= 0 && c.indexOf('border') >= 0;
        });
        for (var d = 0; d < dropdowns.length; d++) {
            var headerCheck = findFirstInTree(dropdowns[d], function(el) {
                if (el.tagName !== 'DIV') return false;
                var c = typeof el.className === 'string' ? el.className : '';
                return c.indexOf('opacity-80') >= 0;
            });
            if (headerCheck && (headerCheck.textContent || '').trim() === 'Model') {
                debugInfo.headerFound = true;
                var modelLabels = findAllInTree(dropdowns[d], function(el) {
                    if (el.tagName !== 'P') return false;
                    var c = typeof el.className === 'string' ? el.className : '';
                    return c.indexOf('overflow-hidden') >= 0 && c.indexOf('text-ellipsis') >= 0 && c.indexOf('whitespace-nowrap') >= 0;
                });
                for (var i = 0; i < modelLabels.length; i++) {
                    var t = normalizeModelName((modelLabels[i].textContent || '').trim());
                    if (t.length > 0 && t.length < 100) items.push(t);
                }
                if (items.length > 0) {
                    debugInfo.matchStrategy = 'D-legacy';
                    debugInfo.labelsFound = items.length;
                    debugInfo.matchedDocIdx = docIdx;
                    break;
                }
            }
        }
        if (items.length > 0) break;
    }

    // === DOM 診断ダンプ（items が見つからなかった場合のみ） ===
    if (items.length === 0) {
        debugInfo.domDump = { z50Elements: [], ariaElements: [], visibleOverlays: [] };

        // z-50 を持つ全要素
        var z50All = findAllInTree(doc, function(el) {
            var c = typeof el.className === 'string' ? el.className : '';
            return c.indexOf('z-50') >= 0;
        });
        for (var z = 0; z < Math.min(z50All.length, 10); z++) {
            debugInfo.domDump.z50Elements.push({
                tag: z50All[z].tagName,
                className: (typeof z50All[z].className === 'string' ? z50All[z].className : '').substring(0, 200),
                text: (z50All[z].textContent || '').substring(0, 150),
                childCount: z50All[z].children ? z50All[z].children.length : 0
            });
        }

        // ARIA ロール要素
        var ariaAll = findAllInTree(doc, function(el) {
            var r = el.getAttribute && el.getAttribute('role');
            return r === 'listbox' || r === 'option' || r === 'menu' || r === 'menuitem' || r === 'menuitemradio';
        });
        for (var a = 0; a < Math.min(ariaAll.length, 10); a++) {
            debugInfo.domDump.ariaElements.push({
                tag: ariaAll[a].tagName,
                role: ariaAll[a].getAttribute('role'),
                text: (ariaAll[a].textContent || '').substring(0, 150)
            });
        }

        // body 直下の visible overlay（position: absolute/fixed で z-index > 0）
        var bodyChildren = doc.body ? doc.body.children : [];
        for (var bc = 0; bc < bodyChildren.length; bc++) {
            try {
                var style = (doc.defaultView || window).getComputedStyle(bodyChildren[bc]);
                var pos = style.position;
                if (pos === 'absolute' || pos === 'fixed') {
                    debugInfo.domDump.visibleOverlays.push({
                        tag: bodyChildren[bc].tagName,
                        className: (typeof bodyChildren[bc].className === 'string' ? bodyChildren[bc].className : '').substring(0, 200),
                        text: (bodyChildren[bc].textContent || '').substring(0, 150),
                        zIndex: style.zIndex
                    });
                }
            } catch(e) {}
        }
    }

    // 重複排除（findAllInTree が shadowRoot を含む再帰的トラバースで同一要素を複数回収集する場合がある）
    var uniqueItems = [];
    var seen = {};
    for (var ui = 0; ui < items.length; ui++) {
        if (!seen[items[ui]]) {
            seen[items[ui]] = true;
            uniqueItems.push(items[ui]);
        }
    }
    return { items: uniqueItems, debug: debugInfo };
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

        const modelList = Array.isArray(models) ? [...new Set(models)] : [];
        logDebug(`cdpModels: getAvailableModels — found ${modelList.length} models (deduped), current="${currentModel}"`);

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
    modelNameOrIndex: string | number,
): Promise<boolean> {
    try {
        await ops.conn.connect();
        logDebug(`cdpModels: selectModel — start, target=${modelNameOrIndex}`);

        // ★ cascade コンテキストをリセット（getAvailableModels 等の後に汚染されている）
        ops.resetCascadeContext();
        await ops.sleep(300);

        // 1. モデルボタンをクリックしてドロップダウンを開く
        //    selectMode と同じシンプルなパターン（1回試行）
        const openScript = `
            (function () {
    ${FIND_MODEL_BUTTON}
                if (!modelBtn) return { opened: false, debug: _findDebug };
                modelBtn.click();
                return { opened: true, debug: _findDebug };
            })()
            `.trim();

        const openResult = await ops.evaluateInCascade(openScript) as
            { opened: boolean; debug?: Record<string, unknown> } | boolean;

        const opened = typeof openResult === 'object' ? openResult.opened : openResult;
        if (typeof openResult === 'object') {
            logDebug(`cdpModels: selectModel — open debug=${JSON.stringify(openResult.debug)}`);
        }

        if (!opened) {
            logWarn('cdpModels: selectModel — could not open dropdown');
            return false;
        }

        await ops.sleep(500);

        // ★ 2回目の evaluateInCascade 前に cascade コンテキストをリセット
        //    1回目の呼び出しでコンテキストが汚染されるため
        ops.resetCascadeContext();
        await ops.sleep(200);

        // 2. ドロップダウン内で目的のモデルをクリック
        //    selectMode と同じパターン: textContent でマッチ、インデックスベースも対応
        const isIndexMode = typeof modelNameOrIndex === 'number';
        const targetIndex = isIndexMode ? modelNameOrIndex : -1;
        const targetName = isIndexMode ? '' : modelNameOrIndex;
        const selectScript = `
            (function () {
                var selectByIndex = ${isIndexMode};
                var targetIdx = ${targetIndex};
                var targetModel = ${JSON.stringify(targetName)};
            var targetLower = targetModel.toLowerCase();
            var _selectDebug = { inIframe: false, ddNewCount: 0, rowCount: 0, oldDdCount: 0, oldRowCount: 0, matchStrategy: 'none' };

            // モデル名キーワード — ドロップダウンがモデル一覧かの判定に使用
            var MODEL_KEYWORDS = ['claude', 'gemini', 'gpt', 'sonnet', 'haiku', 'opus'];
            function isModelItem(text) {
                var lower = text.toLowerCase();
                for (var ki = 0; ki < MODEL_KEYWORDS.length; ki++) {
                    if (lower.indexOf(MODEL_KEYWORDS[ki]) >= 0) return true;
                }
                return false;
            }

            // モデル名正規化: 末尾の「New」バッジテキストを除去
            function normalizeModelName(text) {
                return text.replace(/\\s*New\\s*$/, '').replace(/New$/, '').trim();
            }

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
            _selectDebug.inIframe = (doc !== document);

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

            // font-medium 内の直接テキストノードを取得（「New」バッジ等の子要素テキストを除外）
            function getDirectText(el) {
                var text = '';
                for (var cn = 0; cn < el.childNodes.length; cn++) {
                    if (el.childNodes[cn].nodeType === 3) {
                        text += el.childNodes[cn].textContent;
                    }
                }
                text = text.trim();
                if (!text) text = (el.textContent || '').trim();
                return normalizeModelName(text);
            }

            // modelRows からモデルキーワードを含む行があるか検証する
            function hasModelKeywordInRows(rows) {
                for (var r = 0; r < rows.length; r++) {
                    var fm = findFirstInTree(rows[r], function (el) {
                        if (el.tagName !== 'DIV') return false;
                        var c = typeof el.className === 'string' ? el.className : '';
                        return c.indexOf('font-medium') >= 0;
                    });
                    if (fm) {
                        var t = getDirectText(fm);
                        if (t.length > 0 && isModelItem(t)) return true;
                    }
                }
                return false;
            }

            // clickByIndex / clickByName: 行からモデルを選択する共通関数
            function clickByIndex(rows, idx) {
                if (idx >= 0 && idx < rows.length) {
                    rows[idx].click();
                    var fm = findFirstInTree(rows[idx], function (el) {
                        if (el.tagName !== 'DIV') return false;
                        var c = typeof el.className === 'string' ? el.className : '';
                        return c.indexOf('font-medium') >= 0;
                    });
                    return { success: true, selected: fm ? getDirectText(fm) : ('row#' + idx) };
                }
                return null;
            }

            function clickByName(rows, nameLower) {
                for (var i = 0; i < rows.length; i++) {
                    var fm = findFirstInTree(rows[i], function (el) {
                        if (el.tagName !== 'DIV') return false;
                        var c = typeof el.className === 'string' ? el.className : '';
                        return c.indexOf('font-medium') >= 0;
                    });
                    if (!fm) continue;
                    var mText = getDirectText(fm).toLowerCase();
                    if (mText === nameLower || mText.indexOf(nameLower) >= 0 || nameLower.indexOf(mText) >= 0) {
                        rows[i].click();
                        return { success: true, selected: getDirectText(fm) };
                    }
                }
                return null;
            }

            // 検索対象の document リストを構築（メインフレーム + cascade iframe の両方）
            var docsToSearch = [doc];
            if (doc !== document) {
                docsToSearch.push(document);
            } else {
                var allIframes = document.querySelectorAll('iframe');
                for (var ifi = 0; ifi < allIframes.length; ifi++) {
                    try {
                        if (allIframes[ifi].contentDocument) {
                            docsToSearch.push(allIframes[ifi].contentDocument);
                        }
                    } catch(e) { /* cross-origin */ }
                }
            }

            // === 戦略A: 厳密CSSセレクタ (z-50 rounded-md border shadow-md) + モデルキーワード検証 ===
            for (var docIdx = 0; docIdx < docsToSearch.length; docIdx++) {
                var searchDoc = docsToSearch[docIdx];

                var ddNew = findAllInTree(searchDoc, function (el) {
                    if (el.tagName !== 'DIV') return false;
                    var c = typeof el.className === 'string' ? el.className : '';
                    return c.indexOf('z-50') >= 0 && c.indexOf('rounded-md') >= 0 && c.indexOf('border') >= 0 && c.indexOf('shadow-md') >= 0;
                });
                _selectDebug.ddNewCount = ddNew.length;

                for (var dn = 0; dn < ddNew.length; dn++) {
                    var modelRows = findAllInTree(ddNew[dn], function (el) {
                        if (el.tagName !== 'DIV') return false;
                        var c = typeof el.className === 'string' ? el.className : '';
                        return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
                    });

                    // ★ モデルキーワード検証: このドロップダウンがモデル一覧か確認
                    if (!hasModelKeywordInRows(modelRows)) continue;

                    _selectDebug.rowCount = modelRows.length;
                    _selectDebug.matchStrategy = 'A-strict';

                    if (selectByIndex) {
                        var result = clickByIndex(modelRows, targetIdx);
                        if (result) return result;
                        return { success: false, error: 'index ' + targetIdx + ' out of range (total: ' + modelRows.length + ')', debug: _selectDebug };
                    } else {
                        var result = clickByName(modelRows, targetLower);
                        if (result) return result;
                    }
                }

                // === 戦略B: 緩和CSSセレクタ (z-50 のみ) + モデルキーワード検証 ===
                var ddRelaxed = findAllInTree(searchDoc, function (el) {
                    var c = typeof el.className === 'string' ? el.className : '';
                    return c.indexOf('z-50') >= 0;
                });

                for (var dr = 0; dr < ddRelaxed.length; dr++) {
                    var textEls = findAllInTree(ddRelaxed[dr], function (el) {
                        var tag = el.tagName;
                        return tag === 'DIV' || tag === 'SPAN' || tag === 'P' || tag === 'LI' || tag === 'BUTTON';
                    });
                    var hasModel = false;
                    for (var te = 0; te < textEls.length; te++) {
                        var directText = '';
                        for (var cn = 0; cn < textEls[te].childNodes.length; cn++) {
                            if (textEls[te].childNodes[cn].nodeType === 3) {
                                directText += textEls[te].childNodes[cn].textContent;
                            }
                        }
                        directText = directText.trim();
                        if (!directText && textEls[te].children.length <= 2) {
                            directText = (textEls[te].textContent || '').trim();
                        }
                        if (directText.length > 0 && isModelItem(directText)) { hasModel = true; break; }
                    }
                    if (!hasModel) continue;

                    // z-50 内の clickable 行を再取得
                    var relaxedRows = findAllInTree(ddRelaxed[dr], function (el) {
                        if (el.tagName !== 'DIV') return false;
                        var c = typeof el.className === 'string' ? el.className : '';
                        return c.indexOf('cursor-pointer') >= 0;
                    });
                    if (relaxedRows.length === 0) continue;

                    _selectDebug.rowCount = relaxedRows.length;
                    _selectDebug.matchStrategy = 'B-relaxed';

                    if (selectByIndex) {
                        var result = clickByIndex(relaxedRows, targetIdx);
                        if (result) return result;
                        return { success: false, error: 'index ' + targetIdx + ' out of range (total: ' + relaxedRows.length + ')', debug: _selectDebug };
                    } else {
                        var result = clickByName(relaxedRows, targetLower);
                        if (result) return result;
                    }
                }

                // === 戦略C: ARIA ロールベース検索 ===
                var ariaRoles = ['listbox', 'menu'];
                for (var ri = 0; ri < ariaRoles.length; ri++) {
                    var containers = findAllInTree(searchDoc, function (el) {
                        return el.getAttribute && el.getAttribute('role') === ariaRoles[ri];
                    });

                    for (var ac = 0; ac < containers.length; ac++) {
                        var optionEls = findAllInTree(containers[ac], function (el) {
                            var r = el.getAttribute && el.getAttribute('role');
                            return r === 'option' || r === 'menuitem' || r === 'menuitemradio';
                        });
                        var ariaHasModel = false;
                        for (var oe = 0; oe < optionEls.length; oe++) {
                            var oText = (optionEls[oe].textContent || '').trim();
                            if (oText.length > 0 && isModelItem(oText)) { ariaHasModel = true; break; }
                        }
                        if (!ariaHasModel) continue;

                        _selectDebug.rowCount = optionEls.length;
                        _selectDebug.matchStrategy = 'C-aria';

                        if (selectByIndex) {
                            if (targetIdx >= 0 && targetIdx < optionEls.length) {
                                optionEls[targetIdx].click();
                                return { success: true, selected: normalizeModelName((optionEls[targetIdx].textContent || '').trim()) };
                            }
                            return { success: false, error: 'index ' + targetIdx + ' out of range (total: ' + optionEls.length + ')', debug: _selectDebug };
                        } else {
                            for (var oi = 0; oi < optionEls.length; oi++) {
                                var oiText = normalizeModelName((optionEls[oi].textContent || '').trim()).toLowerCase();
                                if (oiText === targetLower || oiText.indexOf(targetLower) >= 0 || targetLower.indexOf(oiText) >= 0) {
                                    optionEls[oi].click();
                                    return { success: true, selected: normalizeModelName((optionEls[oi].textContent || '').trim()) };
                                }
                            }
                        }
                    }
                }

                // === 戦略D: 旧 UI 構造 (absolute + overflow-y-auto + "Model" ヘッダー) ===
                var dropdowns = findAllInTree(searchDoc, function (el) {
                    if (el.tagName !== 'DIV') return false;
                    var c = typeof el.className === 'string' ? el.className : '';
                    return c.indexOf('absolute') >= 0 && c.indexOf('overflow-y-auto') >= 0 && c.indexOf('rounded-lg') >= 0 && c.indexOf('border') >= 0;
                });
                _selectDebug.oldDdCount = dropdowns.length;
                var ddRoot = null;
                for (var d = 0; d < dropdowns.length; d++) {
                    var headerCheck = findFirstInTree(dropdowns[d], function (el) {
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
                    var oldRows = findAllInTree(ddRoot, function (el) {
                        if (el.tagName !== 'DIV') return false;
                        var c = typeof el.className === 'string' ? el.className : '';
                        return c.indexOf('cursor-pointer') >= 0 && c.indexOf('px-2') >= 0 && c.indexOf('py-1') >= 0;
                    });
                    _selectDebug.oldRowCount = oldRows.length;
                    _selectDebug.matchStrategy = 'D-legacy';

                    if (selectByIndex) {
                        if (targetIdx >= 0 && targetIdx < oldRows.length) {
                            oldRows[targetIdx].click();
                            return { success: true, selected: 'row#' + targetIdx };
                        }
                    } else {
                        for (var j = 0; j < oldRows.length; j++) {
                            var p = findFirstInTree(oldRows[j], function (el) {
                                if (el.tagName !== 'P') return false;
                                var c = typeof el.className === 'string' ? el.className : '';
                                return c.indexOf('text-ellipsis') >= 0;
                            });
                            if (!p) continue;
                            var pText = (p.textContent || '').trim().toLowerCase();
                            if (pText === targetLower || pText.indexOf(targetLower) >= 0 || targetLower.indexOf(pText) >= 0) {
                                oldRows[j].click();
                                return { success: true, selected: (p.textContent || '').trim() };
                            }
                        }
                    }
                }
            }

            return { success: false, error: 'model not found in dropdown', debug: _selectDebug };
        }) ()
        `.trim();

        const selectResult = await ops.evaluateInCascade(selectScript) as {
            success: boolean;
            selected?: string;
            error?: string;
            debug?: Record<string, unknown>;
        };

        if (selectResult?.success) {
            logDebug(`cdpModels: selectModel — selected "${selectResult.selected}"`);
            // 成功時もドロップダウンを確実に閉じる
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
            } catch { /* ドロップダウン閉じ失敗は無視 */ }
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

        logWarn(`cdpModels: selectModel — model "${modelNameOrIndex}" not found: ${selectResult?.error}, debug=${JSON.stringify(selectResult?.debug)}`);
        return false;
    } catch (e) {
        // エラー時もドロップダウンを閉じる試行
        try {
            await ops.conn.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                windowsVirtualKeyCode: 27,
                code: 'Escape',
                key: 'Escape',
            });
        } catch { /* ignore */ }

        logWarn(`cdpModels: selectModel failed — ${e instanceof Error ? e.message : e}`);
        return false;
    }
}

