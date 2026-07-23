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
// Headless mode: while the relay reports at least one connected game
// consumer, the viewer's requestAnimationFrame is throttled to ~4 fps so the
// scene is not rendered twice — sync ingestion is event-driven and stays at
// full rate. Focusing the viewer restores full speed instantly (so editing
// in the max.js viewport is never sluggish); closing the game tab restores
// it within one heartbeat.
//
// Config (localStorage):
//   maxjs.liveRelay      'off' disables the tap entirely
//   maxjs.liveRelayUrl   override, default http://127.0.0.1:5173/maxjs-relay-in
//   maxjs.headlessAuto   'off' disables render throttling while a game runs
(() => {
    'use strict';
    const wv = window.chrome?.webview;
    if (!wv?.addEventListener) return;

    let disabled = false;
    let ingestUrl = '';
    let headlessAuto = true;
    try {
        disabled = localStorage.getItem('maxjs.liveRelay') === 'off';
        ingestUrl = localStorage.getItem('maxjs.liveRelayUrl') || '';
        headlessAuto = localStorage.getItem('maxjs.headlessAuto') !== 'off';
    } catch { /* storage unavailable — keep defaults */ }
    if (disabled) return;
    if (!ingestUrl) ingestUrl = 'http://127.0.0.1:5173/maxjs-relay-in';

    // ── Headless render throttle ───────────────────────────────────────
    // Must be installed before any viewer module captures rAF, which is why
    // this file stays a classic <head> script. Shim ids are private to the
    // map so cancelAnimationFrame keeps working for throttled callbacks.
    const HEADLESS_FRAME_MS = 250;
    let gameConsumers = 0;
    let headlessAnnounced = false;
    const nativeRaf = window.requestAnimationFrame.bind(window);
    const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
    const rafHandles = new Map(); // shimId -> { t?: timeoutId, r?: nativeRafId }
    let nextRafId = 1;

    function headlessActive() {
        return headlessAuto && gameConsumers > 0 && !document.hasFocus();
    }

    window.requestAnimationFrame = (callback) => {
        const id = nextRafId++;
        const fire = () => {
            const r = nativeRaf((timestamp) => {
                rafHandles.delete(id);
                callback(timestamp);
            });
            rafHandles.set(id, { r });
        };
        if (headlessActive()) {
            const t = setTimeout(fire, HEADLESS_FRAME_MS);
            rafHandles.set(id, { t });
        } else {
            fire();
        }
        return id;
    };
    window.cancelAnimationFrame = (id) => {
        const handle = rafHandles.get(id);
        if (!handle) return;
        rafHandles.delete(id);
        if (handle.t !== undefined) clearTimeout(handle.t);
        if (handle.r !== undefined) nativeCancelRaf(handle.r);
    };

    function setGameConsumers(count) {
        gameConsumers = count;
        const active = headlessAuto && gameConsumers > 0;
        if (active !== headlessAnnounced) {
            headlessAnnounced = active;
            console.info(active
                ? '[live_relay_tap] game connected — viewer rendering throttled (focus viewer for full speed)'
                : '[live_relay_tap] game disconnected — viewer rendering resumed');
        }
    }

    const JSON_FORWARD_TYPES = new Set(['env_update']);
    const SKIP_BUFFER_TYPES = new Set(['gi_surface_bin', 'gi_light_bin']);
    const PING_MS = 4000;
    const encoder = new TextEncoder();

    const queue = [];          // { key, body, contentType }
    let pumping = false;
    let needSceneResync = true; // relay may have (re)started with an empty cache
    let lastSceneFrame = null;  // framed copy of the latest full scene payload
    // Relay-absent gate. Anything can squat on the relay port (5173 is also
    // Vite's default): a non-relay server accepts the full POST body and only
    // then 404s, so a playback-rate delta stream turns into a full-scene
    // upload + drop loop every few hundred ms — a main-thread hitch machine
    // (2026-07-24). One failed POST flips this false, which silences ALL
    // mirroring (not even buffer copies) until the heartbeat gets a
    // well-formed relay answer back. scene_bin stays exempt so the resync
    // cache tracks the newest map while the relay is away.
    let relayAlive = null;     // null = unprobed, first contact is optimistic

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
        relayAlive = true;
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
            // Relay down, restarting, or not a relay at all: drop the backlog
            // (a fresh scene frame is replayed on the next successful contact)
            // and go silent until the heartbeat proves the relay is back.
            queue.length = 0;
            needSceneResync = true;
            relayAlive = false;
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
            const isScene = !type || type === 'scene_bin';
            // No relay: streams at playback rate must cost nothing — skip
            // before the copy. Scene frames are rare and keep resync working.
            if (relayAlive === false && !isScene) return;
            // Copy out of the shared buffer NOW — the editor's own handler
            // releases it after this dispatch.
            const framed = frame(meta, e.getBuffer());
            let key = null;
            if (isScene) {
                lastSceneFrame = framed;
                key = 'scene';
                if (relayAlive === false) return; // cached for the heartbeat resync
            } else if (type === 'geo_fast' && meta.h != null) {
                key = `geo:${meta.h}`;
            }
            enqueue(key, framed, 'application/octet-stream');
        } catch { /* never break the editor over relay problems */ }
    });

    wv.addEventListener('message', (e) => {
        try {
            if (relayAlive === false) return;
            const data = e?.data;
            if (!data || !JSON_FORWARD_TYPES.has(data.type)) return;
            enqueue(`msg:${data.type}`, JSON.stringify({ kind: 'msg', data }), 'application/json');
        } catch { /* ignore */ }
    });

    // Heartbeat: a relay that restarted while this tap was idle has an empty
    // scene cache but never sees a failed POST here, so edits after that
    // would stream deltas for nodes the consumers don't have. Ping and
    // re-upload the scene when the relay says it lost it — this is what lets
    // a game tab open before/after a dev-server restart get the map without
    // restarting the max.js panel.
    setInterval(async () => {
        if (pumping || queue.length) return;
        try {
            const response = await fetch(ingestUrl, {
                method: 'POST',
                body: JSON.stringify({ kind: 'ping' }),
                headers: { 'content-type': 'application/json' },
                cache: 'no-store',
            });
            if (!response.ok) { relayAlive = false; setGameConsumers(0); return; }
            const status = await response.json();
            // A well-formed relay answer is the ONLY thing that revives
            // mirroring after a failure — a squatter on the port never will.
            if (!status || typeof status !== 'object' || !('consumers' in status)) {
                relayAlive = false;
                setGameConsumers(0);
                return;
            }
            relayAlive = true;
            setGameConsumers(Number(status?.consumers) || 0);
            if (status?.needScene && lastSceneFrame) {
                enqueue('scene', lastSceneFrame, 'application/octet-stream');
            }
        } catch {
            // Relay down: no game is consuming — never leave the viewer stuck
            // in headless against a dead relay.
            relayAlive = false;
            setGameConsumers(0);
        }
    }, PING_MS);
})();
