// Dispatch a trusted mouse click into the max.js WebView at client (x, y).
// Usage: node test/cdp_click.js <x> <y>
const WebSocket = require('ws');
const http = require('http');

const x = Number(process.argv[2]);
const y = Number(process.argv[3]);
if (!Number.isFinite(x) || !Number.isFinite(y)) { console.error('usage: cdp_click.js x y'); process.exit(1); }

http.get('http://127.0.0.1:9222/json', (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
        const pages = JSON.parse(body);
        const page = pages.find((p) => p.url?.includes('maxjs.local')) || pages[0];
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' } }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id === 1) {
                ws.send(JSON.stringify({ id: 2, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' } }));
            }
            if (msg.id === 2) { console.log('clicked', x, y); ws.close(); process.exit(0); }
        });
        ws.on('error', (e) => { console.error(e.message); process.exit(1); });
        setTimeout(() => { console.error('timeout'); process.exit(1); }, 10000);
    });
}).on('error', (e) => { console.error(e.message); process.exit(1); });
