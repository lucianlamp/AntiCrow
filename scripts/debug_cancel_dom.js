// Cancel button DOM debug script
// CDP 経由で Antigravity の DOM を調査する
const http = require('http');
const WebSocket = require('ws');

const PORTS = [56201];

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
            // anti-crow ワークスペースウィンドウを優先検索
            const anticrow = targets.find(t => t.type === 'page' && t.title && t.title.includes('anti-crow') && t.webSocketDebuggerUrl);
            if (anticrow) {
                console.log(`Found anti-crow target on port ${port}: ${anticrow.title}`);
                return { port, target: anticrow };
            }
            const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl && t.title && t.title.includes('Antigravity'));
            if (page) {
                console.log(`Found Antigravity target on port ${port}: ${page.title}`);
                return { port, target: page };
            }
        } catch {
            // port not available
        }
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
    const params = {
        expression,
        returnByValue: true,
        awaitPromise: true,
    };
    if (contextId !== undefined) {
        params.contextId = contextId;
    }
    const result = await cdpSend(ws, 'Runtime.evaluate', params);
    if (result.result && result.result.value !== undefined) {
        return result.result.value;
    }
    if (result.exceptionDetails) {
        throw new Error(`JS error: ${JSON.stringify(result.exceptionDetails)}`);
    }
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
    // 1. data-tooltip-id を持つ全要素
    var tooltipEls = document.querySelectorAll('[data-tooltip-id]');
    var tooltipInfo = [];
    for (var i = 0; i < tooltipEls.length; i++) {
        var el = tooltipEls[i];
        tooltipInfo.push({
            tooltipId: el.getAttribute('data-tooltip-id'),
            tag: el.tagName,
            ariaLabel: el.getAttribute('aria-label'),
            visible: el.offsetParent !== null,
            classes: (el.className || '').toString().substring(0, 100),
            innerHTML: el.innerHTML.substring(0, 200),
        });
    }
    
    // 2. textbox 周辺のボタン
    var textbox = document.querySelector('div[role="textbox"]');
    var nearbyButtons = [];
    if (textbox) {
        // Try multiple container strategies
        var containers = [
            textbox.closest('form'),
            textbox.parentElement,
            textbox.parentElement && textbox.parentElement.parentElement,
            textbox.parentElement && textbox.parentElement.parentElement && textbox.parentElement.parentElement.parentElement,
            textbox.parentElement && textbox.parentElement.parentElement && textbox.parentElement.parentElement.parentElement && textbox.parentElement.parentElement.parentElement.parentElement,
            textbox.parentElement && textbox.parentElement.parentElement && textbox.parentElement.parentElement.parentElement && textbox.parentElement.parentElement.parentElement.parentElement && textbox.parentElement.parentElement.parentElement.parentElement.parentElement,
        ].filter(Boolean);
        
        // Use widest container
        var container = containers[containers.length - 1] || textbox.parentElement;
        if (container) {
            var containerButtons = container.querySelectorAll('button');
            for (var j = 0; j < containerButtons.length; j++) {
                var btn = containerButtons[j];
                nearbyButtons.push({
                    index: j,
                    ariaLabel: btn.getAttribute('aria-label'),
                    title: btn.getAttribute('title'),
                    text: (btn.textContent || '').trim().substring(0, 50),
                    visible: btn.offsetParent !== null,
                    classes: (btn.className || '').toString().substring(0, 100),
                    tooltipId: btn.getAttribute('data-tooltip-id'),
                    dataAttrs: Array.from(btn.attributes).filter(function(a) { return a.name.startsWith('data-'); }).map(function(a) { return a.name + '=' + a.value; }).join(', '),
                    hasSvg: btn.querySelector('svg') !== null,
                    hasSvgRect: btn.querySelector('svg rect') !== null,
                    hasSvgPath: btn.querySelector('svg path') !== null,
                    hasSvgCircle: btn.querySelector('svg circle') !== null,
                    outerHTML: btn.outerHTML.substring(0, 500),
                });
            }
        }
    }
    
    // 3. 全ドキュメントのボタン概要
    var allButtons = document.querySelectorAll('button');
    var allButtonInfo = [];
    for (var k = 0; k < allButtons.length && k < 40; k++) {
        var b = allButtons[k];
        allButtonInfo.push({
            index: k,
            ariaLabel: b.getAttribute('aria-label'),
            tooltipId: b.getAttribute('data-tooltip-id'),
            title: b.getAttribute('title'),
            visible: b.offsetParent !== null,
            hasSvg: b.querySelector('svg') !== null,
            hasSvgRect: b.querySelector('svg rect') !== null,
            text: (b.textContent || '').trim().substring(0, 50),
            classes: (b.className || '').toString().substring(0, 80),
            dataAttrs: Array.from(b.attributes).filter(function(a) { return a.name.startsWith('data-'); }).map(function(a) { return a.name + '=' + a.value; }).join(', '),
        });
    }
    
    // 4. input-send 周辺のボタン（tooltip-id ベースで親をたどる）
    var sendBtn = document.querySelector('[data-tooltip-id="input-send-button-send-tooltip"]');
    var sendAreaButtons = [];
    if (sendBtn) {
        var sendParent = sendBtn.parentElement;
        while (sendParent && sendParent !== document.body) {
            var siblings = sendParent.querySelectorAll('button');
            if (siblings.length > 1) {
                for (var s = 0; s < siblings.length; s++) {
                    sendAreaButtons.push({
                        index: s,
                        ariaLabel: siblings[s].getAttribute('aria-label'),
                        tooltipId: siblings[s].getAttribute('data-tooltip-id'),
                        visible: siblings[s].offsetParent !== null,
                        outerHTML: siblings[s].outerHTML.substring(0, 500),
                    });
                }
                break;
            }
            sendParent = sendParent.parentElement;
        }
    }
    
    return {
        tooltipElements: tooltipInfo,
        nearbyButtons: nearbyButtons,
        allButtons: allButtonInfo,
        sendAreaButtons: sendAreaButtons,
        textboxFound: !!textbox,
        sendBtnFound: !!sendBtn,
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
    console.log('WebSocket connected');

    // Enable Runtime
    await cdpSend(ws, 'Runtime.enable');

    const results = { cascadeIdle: null, mainIdle: null, cascadeFrameId: null };

    // 1. Find cascade-panel iframe
    const frameTreeResult = await cdpSend(ws, 'Page.getFrameTree');
    const cascadeFrameId = findCascadeFrame(frameTreeResult.frameTree);
    results.cascadeFrameId = cascadeFrameId;
    console.log(`Cascade frame ID: ${cascadeFrameId || 'NOT FOUND'}`);

    // 2. Evaluate in cascade iframe (idle)
    if (cascadeFrameId) {
        const world = await cdpSend(ws, 'Page.createIsolatedWorld', {
            frameId: cascadeFrameId,
            grantUniversalAccess: true,
        });
        const contextId = world.executionContextId;
        console.log(`Cascade context ID: ${contextId}`);

        try {
            results.cascadeIdle = await evaluate(ws, DOM_INSPECT_JS, contextId);
            console.log('Cascade iframe DOM inspection complete');
        } catch (e) {
            console.error(`Cascade iframe error: ${e.message}`);
            results.cascadeIdle = { error: e.message };
        }
    }

    // 3. Evaluate in main frame (idle)
    try {
        results.mainIdle = await evaluate(ws, DOM_INSPECT_JS);
        console.log('Main frame DOM inspection complete');
    } catch (e) {
        console.error(`Main frame error: ${e.message}`);
        results.mainIdle = { error: e.message };
    }

    // Write results
    const fs = require('fs');
    const outPath = 'c:\\Users\\ysk41\\dev\\anti-crow\\tmp_dom_debug.json';
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`Results written to ${outPath}`);

    ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
