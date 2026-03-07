// ---------------------------------------------------------------------------
// cdpModeScripts.ts — モードボタン検出用 JS スニペット
// ---------------------------------------------------------------------------
// cdpModes.ts から分離。CDP 経由で DOM 内のモードボタンを見つけるための
// JavaScript 文字列定数を管理する。
// ---------------------------------------------------------------------------

// -----------------------------------------------------------------------
// 共通: モードボタンを見つける JS スニペット
// -----------------------------------------------------------------------
// モードボタンはモデルボタンの左に位置する。
// textbox から親方向に辿り、ボタン群のうちモデルボタンより前にある
// p タグを持つ button をモードボタンとして検出する。
// -----------------------------------------------------------------------

export const FIND_MODE_BUTTON = `
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
                for (var b = 0; b < btns.length; b++) {
                    var btnText = getBtnText(btns[b]);
                    if (btnText.length > 0) {
                        allBtns.push({ el: btns[b], text: btnText });
                    }
                }
                sibling = sibling.nextElementSibling;
            }

            // モードボタン検出（フィルタリング付き）
            if (allBtns.length > 0) {
                _findDebug.buttonsFound = allBtns.length;
                _findDebug.allBtnTexts = allBtns.map(function(b) { return b.text; });

                // アクションボタン除外キーワード
                var ACTION_EXCLUDE = ['submit', 'cancel', 'stop', '中止', 'send', 'record', 'voice', 'memo'];
                // モードキーワード（優先検出）
                var MODE_KW = ['planning', 'fast'];

                // 戦略1: モードキーワードを含むボタンを優先
                for (var mk = 0; mk < allBtns.length; mk++) {
                    var mkLower = allBtns[mk].text.toLowerCase();
                    for (var mki = 0; mki < MODE_KW.length; mki++) {
                        if (mkLower === MODE_KW[mki] || mkLower.indexOf(MODE_KW[mki]) >= 0) {
                            modeBtn = allBtns[mk].el;
                            _findDebug.matchMethod = 'mode-keyword';
                            _findDebug.found = true;
                            break;
                        }
                    }
                    if (modeBtn) break;
                }

                // 戦略2: アクションボタンを除外し、かつモードキーワードに一致するボタン
                // 注意: 単に「最初のボタン」を拾うと Review 等の無関係なUIテキストを誤検出するため、
                //       MODE_KW に一致するもののみ採用する
                if (!modeBtn) {
                    for (var fb = 0; fb < allBtns.length; fb++) {
                        var fbLower = allBtns[fb].text.toLowerCase();
                        var isAction = false;
                        for (var ai = 0; ai < ACTION_EXCLUDE.length; ai++) {
                            if (fbLower === ACTION_EXCLUDE[ai] || fbLower.indexOf(ACTION_EXCLUDE[ai]) >= 0) {
                                isAction = true;
                                break;
                            }
                        }
                        if (isAction) continue;
                        // モードキーワードに一致するかチェック（一致しないボタンは無視）
                        var isModeKw = false;
                        for (var vk = 0; vk < MODE_KW.length; vk++) {
                            if (fbLower === MODE_KW[vk] || fbLower.indexOf(MODE_KW[vk]) >= 0) {
                                isModeKw = true;
                                break;
                            }
                        }
                        if (isModeKw && allBtns[fb].text.length > 1) {
                            modeBtn = allBtns[fb].el;
                            _findDebug.matchMethod = 'keyword-validated-non-action';
                            _findDebug.found = true;
                            break;
                        }
                    }
                }

                if (modeBtn) break;
            }
            container = container.parentElement;
        }
    }

    // 戦略B: ドキュメント全体からモード名キーワードでボタンを検索（textbox親探索で見つからなかった場合）
    if (!modeBtn) {
        _findDebug.fallbackUsed = true;
        var MODE_KW_SEARCH = ['planning', 'fast'];
        var MODEL_EXCLUDE = ['claude', 'gpt', 'gemini', 'sonnet', 'opus', 'haiku', 'o1', 'o3', 'deepseek', 'llama', 'mistral', 'codestral'];
        var allDocBtns = doc.querySelectorAll('button');
        var fallbackCandidates = [];
        for (var fb = 0; fb < allDocBtns.length; fb++) {
            var fbText = getBtnText(allDocBtns[fb]).toLowerCase();
            if (fbText.length < 2 || fbText.length > 40) continue;
            var hasModeKw = false;
            for (var mkw = 0; mkw < MODE_KW_SEARCH.length; mkw++) {
                if (fbText === MODE_KW_SEARCH[mkw] || fbText.indexOf(MODE_KW_SEARCH[mkw]) >= 0) { hasModeKw = true; break; }
            }
            if (!hasModeKw) continue;
            var hasModelExclude = false;
            for (var mex = 0; mex < MODEL_EXCLUDE.length; mex++) {
                if (fbText.indexOf(MODEL_EXCLUDE[mex]) >= 0) { hasModelExclude = true; break; }
            }
            if (!hasModelExclude) {
                fallbackCandidates.push({ el: allDocBtns[fb], text: fbText });
            }
        }
        _findDebug.fallbackCandidates = fallbackCandidates.length;
        if (fallbackCandidates.length > 0) {
            modeBtn = fallbackCandidates[0].el;
            _findDebug.matchMethod = 'doc-wide-keyword';
            _findDebug.fallbackBtnText = fallbackCandidates[0].text;
            _findDebug.found = true;
        }
    }
`;
