const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Port discovery
function findCdpPort() {
    const portsDir = "c:\\Users\\ysk41\\AppData\\Roaming\\Antigravity\\User\\globalStorage\\lucianlamp.anti-crow\\cdp_ports";
    if (fs.existsSync(portsDir)) {
        const files = fs.readdirSync(portsDir);
        for (const file of files) {
            if (file.startsWith('port_')) {
                const port = fs.readFileSync(path.join(portsDir, file), 'utf8').trim();
                return parseInt(port, 10);
            }
        }
    }
    return null;
}

const PORT = findCdpPort() || 9333;
console.log(`Connecting to CDP on port ${PORT}...`);

http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const targets = JSON.parse(data);
        console.log(`Found ${targets.length} targets`);

        let wsUrl = null;
        for (const target of targets) {
            console.log(`Target: ${target.title} (${target.url})`);
            if (target.title.includes("anti-crow") || target.url.includes("cascade-panel.html")) {
                wsUrl = target.webSocketDebuggerUrl;
                if (target.url.includes("cascade-panel.html")) {
                    console.log("Found cascade-panel!");
                    break;
                }
            }
        }

        if (!wsUrl && targets.length > 0) {
            wsUrl = targets[0].webSocketDebuggerUrl; // Fallback
            console.log("Fallback to first target.");
        }

        if (wsUrl) {
            console.log(`\nConnecting to: ${wsUrl}`);
            connectAndQuery(wsUrl);
        } else {
            console.log('No valid CDP target found.');
        }
    });
}).on('error', err => {
    console.error(`HTTP GET failed: ${err.message}`);
});

function connectAndQuery(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let id = 1;

    ws.on('open', () => {
        const SCROLL_DEBUG_SCRIPT = `
        (function() {
            var results = {
                scrollButtons: [],
                scrollContainers: []
            };

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

            // 1. スクロールボタンを探す
            var scrollBtns = findInTree(document, function(el) {
                var label = (el.getAttribute('aria-label') || '').toLowerCase();
                var title = (el.getAttribute('title') || '').toLowerCase();
                var role = el.getAttribute('role');
                return label.includes('scroll') || title.includes('scroll') ||
                       el.classList.contains('codicon-arrow-down') ||
                       (el.className && typeof el.className === 'string' && el.className.includes('codicon-arrow-down'));
            });

            for (var i = 0; i < scrollBtns.length; i++) {
                var el = scrollBtns[i];
                var rect = el.getBoundingClientRect();
                results.scrollButtons.push({
                    tag: el.tagName,
                    classes: el.className,
                    id: el.id,
                    ariaLabel: el.getAttribute('aria-label'),
                    title: el.getAttribute('title'),
                    role: el.getAttribute('role'),
                    text: el.innerText ? el.innerText.trim() : '',
                    visible: rect.width > 0 && rect.height > 0
                });
            }

            // 2. スクロール可能なコンテナを探す
            var containers = findInTree(document, function(el) {
                var className = el.className;
                return typeof className === 'string' && className.includes('overflow-y-auto');
            });
            
            for (var j = 0; j < containers.length; j++) {
                var c = containers[j];
                results.scrollContainers.push({
                    tag: c.tagName,
                    classes: c.className,
                    scrollHeight: c.scrollHeight,
                    clientHeight: c.clientHeight,
                    scrollTop: c.scrollTop,
                    hasScrollableContent: c.scrollHeight > c.clientHeight
                });
            }

            return results;
        })()
        `;

        ws.send(JSON.stringify({
            id: id++,
            method: 'Runtime.evaluate',
            params: {
                expression: SCROLL_DEBUG_SCRIPT,
                returnByValue: true
            }
        }));
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);
        if (response.result && response.result.result) {
            console.log("\n--- Scroll Elements Analysis ---");
            console.log(JSON.stringify(response.result.result.value, null, 2));
            ws.close();
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket Error:', err);
    });
}
