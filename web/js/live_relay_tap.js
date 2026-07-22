// live_relay_tap.js — mirrors host→viewer sync payloads (scene_bin, delta_bin,
// geo_fast shared buffers + env_update JSON) to a local dev relay so an
// external consumer (e.g. a game dev server) can apply the same scene live.
//
// Passive by design: registers its own chrome.webview listeners, never posts
// to the host, never touches the viewer DOM or editor state. Must stay a
// classic <head> script (NOT a module): it has to run before host_bridge
// installs its wiring so this tap's listeners fire first and can copy each
// shared buffer before the editor releases it.
//
// Transport is HTTP POST, not WebSocket, on purpose: the viewer origin
// (https://maxjs.local) counts as a public site talking to the local network,
// and Chromium's Private Network Access rules only admit requests that can
// carry a CORS preflight — fetch can, WebSocket handshakes cannot (they hang
// with no error). The relay answers the preflight with
// Access-Control-Allow-Private-Network. Frames are queued and sent strictly
// one at a time so ordering is preserved; per-key coalescing keeps only the
// newest scene / per-node geometry frame when the queue backs up.
//
// Wire framing (shared with the relay + game consumer):
//   binary POST body: [u32 metaLen LE][metaLen bytes of meta JSON][payload]
//   JSON POST body:   {"kind":"msg","data":{...}}
//
// Config (localStorage):
//   maxjs.liveRelay      'off' disables the tap entirely
//   maxjs.liveRelayUrl   override, default http://127.0.0.1:5173/maxjs-relay-in
(() => {
    'use strict';
    const wv = window.chrome?.webview;
    if (!wv?.addEventListener) return;

    let disabled = false;
    let ingestUrl = '';
    try {
        disabled = localStorage.getItem('maxjs.liveRelay') === 'off';
        ingestUrl = localStorage.getItem('maxjs.liveRelayUrl') || '';
    } catch { /* storage unavailable — keep defaults */ }
    if (disabled) return;
    if (!ingestUrl) ingestUrl = 'http://127.0.0.1:5173/maxjs-relay-in';

    const JSON_FORWARD_TYPES = new Set(['env_update']);
    const SKIP_BUFFER_TYPES = new Set(['gi_surface_bin', 'gi_light_bin']);
    const encoder = new TextEncoder();

    const queue = [];          // { key, body, contentType }
    let pumping = false;
    let needSceneResync = true; // relay may have (re)started with an empty cache
    let lastSceneFrame = null;  // framed copy of the latest full scene payload

    function frame(meta, buffer) {
        const metaBytes = encoder.encode(JSON.stringify(meta ?? {}));
        const out = new Uint8Array(4 + metaBytes.byteLength + buffer.byteLength);
        new DataView(out.buffer).setUint32(0, metaBytes.byteLength, true);
        out.set(metaBytes, 4);
        out.set(new Uint8Array(buffer), 4 + metaBytes.byteLength);
        return out;
    }

    function enqueue(key, body, contentType) {
        if (key) {
            for (let i = queue.length - 1; i >= 0; i--) {
                if (queue[i].key === key) queue.splice(i, 1);
            }
        }
        queue.push({ key, body, contentType });
        void pump();
    }

    async function post(body, contentType) {
        const response = await fetch(ingestUrl, {
            method: 'POST',
            body,
            headers: { 'content-type': contentType },
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`relay ingest ${response.status}`);
    }

    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (queue.length) {
                if (needSceneResync && lastSceneFrame && queue[0].body !== lastSceneFrame) {
                    await post(lastSceneFrame, 'application/octet-stream');
                    needSceneResync = false;
                }
                const item = queue[0];
                await post(item.body, item.contentType);
                if (item.body === lastSceneFrame) needSceneResync = false;
                queue.shift();
            }
        } catch {
            // Relay down or restarting: drop the backlog (a fresh scene frame
            // is replayed on the next successful contact) and stay quiet.
            queue.length = 0;
            needSceneResync = true;
        } finally {
            pumping = false;
        }
    }

    wv.addEventListener('sharedbufferreceived', (e) => {
        try {
            const meta = typeof e.additionalData === 'string'
                ? JSON.parse(e.additionalData)
                : (e.additionalData ?? {});
            const type = meta?.type;
            if (SKIP_BUFFER_TYPES.has(type)) return;
            // Copy out of the shared buffer NOW — the editor's own handler
            // releases it after this dispatch.
            const framed = frame(meta, e.getBuffer());
            let key = null;
            if (!type || type === 'scene_bin') {
                lastSceneFrame = framed;
                key = 'scene';
            } else if (type === 'geo_fast' && meta.h != null) {
                key = `geo:${meta.h}`;
            }
            enqueue(key, framed, 'application/octet-stream');
        } catch { /* never break the editor over relay problems */ }
    });

    wv.addEventListener('message', (e) => {
        try {
            const data = e?.data;
            if (!data || !JSON_FORWARD_TYPES.has(data.type)) return;
            enqueue(`msg:${data.type}`, JSON.stringify({ kind: 'msg', data }), 'application/json');
        } catch { /* ignore */ }
    });
})();
