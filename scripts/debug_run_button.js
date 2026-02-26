const fs = require('fs');
const CDP = require('chrome-remote-interface');
const path = require('path');

async function main() {
    let client;
    try {
        // Ports from 9333 to 9350
        const ports = Array.from({ length: 18 }, (_, i) => 9333 + i);
        let targetPort = null;
        let targetWs = null;

        for (const port of ports) {
            try {
                const list = await CDP.List({ port, host: '127.0.0.1' });
                fs.writeFileSync(path.join(__dirname, 'targets_dump.json'), JSON.stringify(list, null, 2));
                console.log("Dumped list to targets_dump.json");

                const targets = list.filter(t => t.url.includes('workbench.html') && !t.url.includes('jetski-agent') && t.type === 'page');

                if (targets.length > 0) {
                    for (const target of targets) {
                        const client = await CDP({ target: target.webSocketDebuggerUrl });
                        const { Runtime } = client;

                        const EXAMINE_SCRIPT = `
                             (function() {
                                 function dumpAllText(root) {
                                     const results = [];
                                     const walker = document.createTreeWalker(
                                         root,
                                         NodeFilter.SHOW_ELEMENT,
                                         null,
                                         false
                                     );
                                     
                                     let node;
                                     while ((node = walker.nextNode())) {
                                         if (node.shadowRoot) {
                                             results.push(...dumpAllText(node.shadowRoot));
                                         }
                                         
                                         const tag = node.tagName;
                                         if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'LINK') continue;
                                         
                                         // Handle iframes
                                         if (tag === 'IFRAME') {
                                             try {
                                                 if (node.contentDocument && node.contentDocument.body) {
                                                     results.push(...dumpAllText(node.contentDocument.body));
                                                 }
                                             } catch(e) {}
                                         }
                                         
                                         const text = (node.innerText || node.textContent || '').trim();
                                         const ariaLabel = node.getAttribute('aria-label') || '';
                                         const title = node.title || '';
                                         
                                         if (text.length > 0 || ariaLabel.length > 0 || title.length > 0) {
                                             results.push({
                                                 tag,
                                                 id: node.id,
                                                 className: typeof node.className === 'string' ? node.className : '',
                                                 text: text.substring(0, 80), // Trucate for readability
                                                 ariaLabel,
                                                 title
                                             });
                                         }
                                     }
                                     return results;
                                 }
                                 
                                 return JSON.stringify(dumpAllText(document.body), null, 2);
                             })();
                         `;

                        const evalResult = await Runtime.evaluate({
                            expression: EXAMINE_SCRIPT,
                            returnByValue: true
                        });

                        if (evalResult.result && evalResult.result.value) {
                            fs.writeFileSync(path.join(__dirname, `run_buttons_dump_${target.id}.json`), evalResult.result.value);
                            console.log(`Dumped to run_buttons_dump_${target.id}.json`);
                        } else {
                            console.log(`Error or no results for ${target.id}:`, evalResult);
                        }

                        await client.close();
                    }
                    break; // Exit port loop since we found targets
                }
            } catch (e) {
                // Ignore refused connections
            }
        }
    } catch (err) {
        console.error('Error:', err);
    }
}

main();
