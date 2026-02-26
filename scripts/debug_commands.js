const http = require('http');
const WebSocket = require('ws');

async function getAvailableCommands() {
    const port = 9333; // Default CDP port used by Antigravity extension

    // 1. Fetch available targets
    const response = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });

    // 2. Find a page target (usually index.html or workbench.html for VSCode)
    const target = response.find(t => t.type === 'page' && t.url && t.url.includes('workbench.html')) || response[0];

    if (!target) {
        console.error('No suitable CDP target found');
        return;
    }

    // 3. Connect via WebSocket
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
                    params: { expression, returnByValue: true, awaitPromise: true }
                }));
            });
        };

        (async () => {
            console.log('Connected to CDP. Evaluating...');
            try {
                // Get all registered commands (this works in VS Code / Antigravity)
                const res = await evaluate(`
                    (async () => {
                        try {
                            const cmds = await vscode.commands.getCommands(true);
                            return JSON.stringify(cmds);
                        } catch(e) {
                            return "Error: " + e.message;
                        }
                    })()
                `);

                console.log('Available Commands:', res.value);
                ws.close();

            } catch (e) {
                console.error(e);
                ws.close();
            }
        })();
    });
}

getAvailableCommands().catch(console.error);
