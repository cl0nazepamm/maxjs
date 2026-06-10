// Minimal CDP Runtime.evaluate harness for the max.js WebView panel.
// Usage: node test/cdp_eval.js "<js expression>"   (run from repo root)
// Requires MAXJS_DEBUG_PORT=9222 in the Max process environment.
const WebSocket = require('ws');
const http = require('http');

const expr = process.argv[2] || '1+1';

http.get('http://127.0.0.1:9222/json', (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
        const pages = JSON.parse(body);
        const page = pages.find((p) => p.url?.includes('maxjs.local')) || pages[0];
        if (!page) { console.error('no page'); process.exit(1); }
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true },
            }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id === 1) {
                if (msg.result?.exceptionDetails) {
                    console.error('EXCEPTION:', JSON.stringify(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails, null, 2));
                } else {
                    console.log(typeof msg.result?.result?.value === 'string'
                        ? msg.result.result.value
                        : JSON.stringify(msg.result?.result?.value, null, 2));
                }
                ws.close();
                process.exit(0);
            }
        });
        ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
        setTimeout(() => { console.error('timeout'); process.exit(1); }, 20000);
    });
}).on('error', (e) => { console.error(e.message); process.exit(1); });
