// Hard-reload the max.js WebView bypassing the HTTP cache (module files are
// served from maxjs.local without cache-busting query params).
const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9222/json', (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
        const pages = JSON.parse(body);
        const page = pages.find((p) => p.url?.includes('maxjs.local')) || pages[0];
        if (!page) { console.error('no page'); process.exit(1); }
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
            ws.send(JSON.stringify({ id: 2, method: 'Network.clearBrowserCache' }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id === 2) {
                ws.send(JSON.stringify({ id: 3, method: 'Page.reload', params: { ignoreCache: true } }));
            }
            if (msg.id === 3) {
                console.log('cache cleared + hard reload issued');
                ws.close();
                process.exit(0);
            }
        });
        ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
        setTimeout(() => { console.error('timeout'); process.exit(1); }, 15000);
    });
}).on('error', (e) => { console.error(e.message); process.exit(1); });
