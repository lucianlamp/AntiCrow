import CDP from 'chrome-remote-interface';
import * as http from 'http';

function fetchTargets(port: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/json`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', err => reject(err));
        req.setTimeout(500, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function runTest() {
    let targetPort = 0;
    let pageTarget = null;

    console.log('Scanning CDP ports (9222-9230) on localhost...');
    for (let port = 9222; port <= 9230; port++) {
        try {
            const targets = await fetchTargets(port);
            if (targets && targets.length > 0) {
                console.log(`Port ${port} has targets`);
                for (const t of targets) {
                    if (t.type === 'page' && t.title.includes('Antigravity') && !t.url.includes('devtools://')) {
                        console.log(`Found target: ${t.title}`);
                        targetPort = port;
                        pageTarget = t;
                        break; // exit inner loop
                    }
                }
            }
            if (pageTarget) break; // exit outer loop
        } catch (e) { /* ignore */ }
    }

    if (!pageTarget) {
        console.error('No Antigravity target found.');
        return;
    }

    console.log(`Connecting to port ${targetPort}, target: ${pageTarget.title}`);
    let client;
    try {
        client = await CDP({ target: pageTarget, port: targetPort });
    } catch (e) {
        console.error('Failed to attach:', (e as Error).message);
        return;
    }

    const { Runtime } = client;

    async function evaluateCommand(cmd: string) {
        console.log(`Executing VS Code command: ${cmd}`);
        const expression = `
            (async () => {
                if (typeof vscode === 'undefined' || !vscode.commands) return 'Error: vscode not found';
                try {
                    await vscode.commands.executeCommand('${cmd}');
                    return 'Success';
                } catch(e) {
                    return 'Error: ' + e.message;
                }
            })()
        `;
        try {
            const res = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
            console.log('Result:', res.result?.value || res);
        } catch (e) {
            console.log('Error:', e);
        }
    }

    await evaluateCommand('workbench.action.terminal.chat.runCommand');
    await evaluateCommand('antigravity.prioritized.agentAcceptAllInFile');
    await evaluateCommand('workbench.panel.chatSidebar.focus');

    await client.close();
}

runTest();
