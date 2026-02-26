const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORTS = [9333, 56201];

async function fetchJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

async function findTarget() {
    for (const port of PORTS) {
        try {
            const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
            const anticrow = targets.find(t => t.type === 'page' && t.title && t.title.includes('anti-crow') && t.webSocketDebuggerUrl);
            if (anticrow) return { port, target: anticrow };
            const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl && t.title && t.title.includes('Antigravity'));
            if (page) return { port, target: page };
        } catch { }
    }
    throw new Error('No Antigravity CDP target found');
}

async function cdpSend(ws, method, params = {}) {
    const id = Math.floor(Math.random() * 100000);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
        const handler = (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === id) {
                clearTimeout(timeout);
                ws.removeListener('message', handler);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(ws, expression, contextId) {
    const params = { expression, returnByValue: true, awaitPromise: true };
    if (contextId !== undefined) params.contextId = contextId;
    const result = await cdpSend(ws, 'Runtime.evaluate', params);
    if (result.result && result.result.value !== undefined) return result.result.value;
    if (result.exceptionDetails) throw new Error(`JS error: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result;
}

function findCascadeFrame(frameTree) {
    const frame = frameTree.frame;
    if (frame.name === 'antigravity.agentPanel' || (frame.url && frame.url.includes('cascade-panel.html'))) {
        return frame.id;
    }
    if (frameTree.childFrames) {
        for (const child of frameTree.childFrames) {
            const found = findCascadeFrame(child);
            if (found) return found;
        }
    }
    return null;
}

const DOM_INSPECT_JS = `(function() {
    var results = [];
    
    function traverse(root) {
        if (!root) return;
        var elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            var text = (el.textContent || '').trim();
            var textLower = text.toLowerCase();
            
            if (textLower.includes('allow') || textLower.includes('always') || textLower.includes('continue')) {
                var isVisible = false;
                try {
                    var rect = el.getBoundingClientRect();
                    isVisible = rect.width > 0 && rect.height > 0;
                } catch(e) {}
                
                if (text.length < 50 && isVisible) {
                    var attrs = Array.from(el.attributes || []).map(function(a) { return a.name + '=' + a.value; }).join(', ');
                    results.push({
                        tag: el.tagName,
                        text: text,
                        visible: isVisible,
                        classes: el.className ? el.className.toString() : '',
                        attributes: attrs,
                        hasParentButton: !!el.closest && !!el.closest('button, vscode-button'),
                        role: el.getAttribute ? el.getAttribute('role') : null,
                        inShadow: root !== document
                    });
                }
            }
            if (el.shadowRoot) {
                traverse(el.shadowRoot);
            }
        }
    }
    
    traverse(document);
    
    // Deduplicate
    var uniqueResults = [];
    var seen = new Set();
    for(var item of results) {
       var key = item.tag + item.text + item.classes + item.inShadow;
       if(!seen.has(key)) {
           seen.add(key);
           uniqueResults.push(item);
       }
    }

    return {
        matches: uniqueResults,
        timestamp: new Date().toISOString()
    };
})()`;

async function main() {
    const { port, target } = await findTarget();
    console.log(`Connecting to ${target.webSocketDebuggerUrl}`);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    await cdpSend(ws, 'Runtime.enable');
    const results = { cascadeIdle: null, mainIdle: null };

    const frameTreeResult = await cdpSend(ws, 'Page.getFrameTree');
    const cascadeFrameId = findCascadeFrame(frameTreeResult.frameTree);

    if (cascadeFrameId) {
        const world = await cdpSend(ws, 'Page.createIsolatedWorld', { frameId: cascadeFrameId, grantUniversalAccess: true });
        try {
            results.cascadeIdle = await evaluate(ws, DOM_INSPECT_JS, world.executionContextId);
        } catch (e) { results.cascadeIdle = { error: e.message }; }
    }

    try {
        results.mainIdle = await evaluate(ws, DOM_INSPECT_JS);
    } catch (e) { results.mainIdle = { error: e.message }; }

    const outPath = 'c:\\Users\\ysk41\\dev\\anti-crow\\tmp_dom_debug_auto_accept.json';
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`Results written to ${outPath}`);
    ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
