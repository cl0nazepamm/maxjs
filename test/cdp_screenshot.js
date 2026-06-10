// Capture the max.js WebView via CDP Page.captureScreenshot.
// Usage: node test/cdp_screenshot.js [outPath]
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const out = process.argv[2] || 'test/cdp_capture.png';

http.get('http://127.0.0.1:9222/json', (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
        const pages = JSON.parse(body);
        const page = pages.find((p) => p.url?.includes('maxjs.local')) || pages[0];
        if (!page) { console.error('no page'); process.exit(1); }
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
            ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 70 } }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id === 2) {
                if (msg.result?.data) {
                    fs.writeFileSync(out, Buffer.from(msg.result.data, 'base64'));
                    console.log('saved', out);
                } else {
                    console.error('capture failed', JSON.stringify(msg));
                }
                ws.close();
                process.exit(0);
            }
        });
        ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
        setTimeout(() => { console.error('timeout'); process.exit(1); }, 20000);
    });
}).on('error', (e) => { console.error(e.message); process.exit(1); });
