import { WebSocket } from 'ws';
import * as http from 'http';

async function getWsUrl(port: number): Promise<string | null> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const targets = JSON.parse(data);
                    const target = targets.find((t: any) =>
                        t.type === 'page' &&
                        t.url.includes('workbench.html') &&
                        !t.url.includes('jetski-agent')
                    );
                    resolve(target ? target.webSocketDebuggerUrl : null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
    });
}

async function testCdp() {
    const port = 9333;
    const wsUrl = await getWsUrl(port);
    if (!wsUrl) {
        console.log(`Failed to get WebSocket URL for port ${port}`);
        return;
    }
    console.log(`Connected to ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    let msgId = 1;

    const send = (method: string, params: any) => {
        return new Promise((resolve) => {
            const id = msgId++;
            const listener = (data: any) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === id) {
                    ws.removeListener('message', listener);
                    resolve(msg.result);
                }
            };
            ws.on('message', listener);
            ws.send(JSON.stringify({ id, method, params }));
        });
    };

    ws.on('open', async () => {
        console.log('WebSocket open');

        try {
            const dumpJs = `
            (() => {
                function isVisible(el) {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
                    if (el.offsetParent === null && style.position !== 'fixed') return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                }

                const allEls = Array.from(document.querySelectorAll('div[role="textbox"]'));
                return allEls.map((el, i) => ({
                    index: i,
                    className: el.className,
                    isVisible: isVisible(el),
                    text: el.textContent
                }));
            })();
            `;

            const res: any = await send('Runtime.evaluate', {
                expression: dumpJs,
                returnByValue: true
            });
            console.log('All textboxes in main document:', JSON.stringify(res.result?.value, null, 2));

        } catch (e) {
            console.error('Error during CDP test:', e);
        } finally {
            ws.close();
        }
    });

    ws.on('error', (err) => console.error('WebSocket Error:', err));
}

testCdp();
