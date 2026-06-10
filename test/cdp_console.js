// Dump recent console messages + uncaught exceptions from the max.js WebView.
// Usage: node test/cdp_console.js [waitMs]
const WebSocket = require('ws');
const http = require('http');

const waitMs = Number(process.argv[2]) || 4000;

http.get('http://127.0.0.1:9222/json', (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
        const pages = JSON.parse(body);
        const page = pages.find((p) => p.url?.includes('maxjs.local')) || pages[0];
        if (!page) { console.error('no page'); process.exit(1); }
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const out = [];
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
            ws.send(JSON.stringify({ id: 2, method: 'Log.enable' }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.method === 'Runtime.consoleAPICalled') {
                const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
                out.push(`[console.${msg.params.type}] ${args}`);
            }
            if (msg.method === 'Runtime.exceptionThrown') {
                out.push(`[EXCEPTION] ${msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.exceptionDetails)}`);
            }
            if (msg.method === 'Log.entryAdded') {
                out.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`);
            }
        });
        setTimeout(() => {
            console.log(out.length ? out.slice(-60).join('\n') : '(no console output captured in window)');
            ws.close();
            process.exit(0);
        }, waitMs);
    });
}).on('error', (e) => { console.error(e.message); process.exit(1); });
