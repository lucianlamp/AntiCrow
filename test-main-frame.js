const http = require('http');
const WebSocket = require('ws');

http.get('http://127.0.0.1:9333/json', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const targets = JSON.parse(data);
        const target = targets.find(t => t.type === 'page' && t.url.includes('workbench.html') && !t.url.includes('jetski-agent'));
        
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        ws.on('open', () => {
            const expr = document.querySelector('div[role="textbox"]') !== null;
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: expr, returnByValue: true }
            }));
        });
        ws.on('message', (msg) => {
            const res = JSON.parse(msg);
            if (res.id === 1) {
                console.log('Textbox exists:', res.result.result.value);
                process.exit(0);
            }
        });
    });
});
