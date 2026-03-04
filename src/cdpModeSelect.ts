// ---------------------------------------------------------------------------
// cdpModeSelect.ts — モード選択操作
// ---------------------------------------------------------------------------
// cdpModes.ts から分離。CDP 経由でモードドロップダウン内の
// 指定モードをクリックして選択する機能を提供する。
// ---------------------------------------------------------------------------

import { CdpBridgeOps } from './cdpHistory';
import { logDebug, logWarn } from './logger';
import { FIND_MODE_BUTTON } from './cdpModeScripts';

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
