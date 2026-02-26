const http = require('http');
const WebSocket = require('ws');

async function debugRunButtonDom() {
    const port = 9333;

    // 1. Fetch available targets
    const response = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });

    const target = response.find(t => t.type === 'page' && t.url && t.url.includes('workbench.html')) || response[0];

    if (!target) {
        console.error('No suitable CDP target found');
        return;
    }

    // 2. Connect via WebSocket
    const ws = new WebSocket(target.webSocketDebuggerUrl);

    ws.on('open', () => {
        let msgId = 1;

        const evaluate = (expression) => {
            return new Promise((resolve) => {
                const id = msgId++;
                const handler = (msg) => {
                    const data = JSON.parse(msg);
                    if (data.id === id) {
                        ws.off('message', handler);
                        resolve(data.result.result);
                    }
                };
                ws.on('message', handler);
                ws.send(JSON.stringify({
                    id,
                    method: 'Runtime.evaluate',
                    params: { expression, returnByValue: true }
                }));
            });
        };

        (async () => {
            console.log(`Connecting to: ${target.webSocketDebuggerUrl}`);
            try {
                // Find potential run buttons or accept buttons by traversing the shadow DOM
                const res = await evaluate(`
                    (function() {
                        function findInTree(root, predicate) {
                            if (!root) return [];
                            var elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
                            var matches = [];
                            for (var i = 0; i < elements.length; i++) {
                                var el = elements[i];
                                if (predicate(el)) matches.push(el);
                                if (el.shadowRoot) {
                                    matches = matches.concat(findInTree(el.shadowRoot, predicate));
                                }
                            }
                            return matches;
                        }

                        // Look for any button
                        var buttons = findInTree(document, function(el) {
                            var tag = el.tagName.toLowerCase();
                            var role = el.getAttribute('role');
                            return (tag === 'button' || tag === 'vscode-button' || role === 'button');
                        });

                        return buttons.map(function(b) {
                            return {
                                tag: b.tagName,
                                text: b.innerText || b.textContent || '',
                                title: b.getAttribute('title'),
                                ariaLabel: b.getAttribute('aria-label'),
                                classes: typeof b.className === 'string' ? b.className : '',
                                isVisible: b.offsetParent !== null
                            };
                        });
                    })()
                `);

                console.log('--- Run/Accept Button Candidates Analysis ---');
                console.log(JSON.stringify(res.value, null, 2));

            } catch (e) {
                console.error(e);
            } finally {
                ws.close();
            }
        })();
    });
}

debugRunButtonDom().catch(console.error);
