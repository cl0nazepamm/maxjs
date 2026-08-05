#!/usr/bin/env node
// split_smoke_server.mjs — serves web/ with the smoke shim injected into
// index.html, so the full editor boots in a plain browser exactly as it would
// under the WebView2 host (same trick as maxjs-blender's webview2_shim.js).
// The per-extraction gate for the index.html split: load http://127.0.0.1:PORT/
// and assert window.__SMOKE ends up { ready: true, pageErrors: [] }.
//
// Usage: node tools/split_smoke_server.mjs [port]   (default 8901)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.argv[2]) || 8901;
const SHIM = readFileSync(join(ROOT, 'tools', 'split_smoke_shim.js'), 'utf8');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.m3': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const server = createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = normalize(join(WEB, rel));
    if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404); res.end('not found: ' + rel); return;
    }
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    let body = readFileSync(file);
    if (rel === '/index.html') {
        // inject the shim as the very first thing in <head>, before the
        // standalone-redirect bootstrap can observe a missing host
        body = Buffer.from(
            body.toString('utf8').replace('<head>', '<head>\n<script>' + SHIM + '</script>'),
            'utf8');
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`split smoke: serving ${WEB} (shimmed index.html) at http://127.0.0.1:${PORT}/`);
});
