import { CdpPool } from '../src/cdpPool';
import { CdpBridgeOps } from '../src/cdpHistory';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../.env') });

const DOM_SCRIPT = `
(function() {
    var modeBtn = null;
    var _findDebug = { textboxFound: false, levelsSearched: 0, siblingsChecked: 0, buttonsFound: 0, found: false, allBtnTexts: [] };

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

    var textbox = findFirstInTree(document, function(el) {
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
                    var text = (btns2[b2].textContent || '').trim();
                    if (text.length > 0 && typeof btns2[b2].className === 'string') {
                        allBtns.unshift({ el: btns2[b2], text: text, class: btns2[b2].className });
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
                    var text = (btns[b].textContent || '').trim();
                    if (text.length > 0 && typeof btns[b].className === 'string') {
                        allBtns.push({ el: btns[b], text: text, class: btns[b].className });
                    }
                }
                sibling = sibling.nextElementSibling;
            }

            if (allBtns.length > 0) {
                _findDebug.buttonsFound = allBtns.length;
                _findDebug.allBtnTexts = allBtns.map(b => b.text + ' (' + b.class + ')');
                modeBtn = allBtns[0].el;
                _findDebug.found = true;
                break;
            }
            container = container.parentElement;
        }
    }
    
    return _findDebug;
})()
`;

async function run() {
    const pool = new CdpPool();
    const cdp = await pool.acquire('__default__');

    try {
        await cdp.connect();

        console.log('Sending cascade evaluate...');
        // @ts-ignore
        const result = await cdp.evaluateInCascade(DOM_SCRIPT);
        console.log('Cascade result:', JSON.stringify(result, null, 2));

    } catch (e) {
        console.error('Error:', e);
    } finally {
        cdp.fullDisconnect();
        process.exit(0);
    }
}

run();
