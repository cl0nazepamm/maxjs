// webview2_shim.js — impersonate the 3ds Max WebView2 host so the REAL max.js
// editor (web/index.html, full post-FX / IPR viewport) runs in a browser,
// driven by Blender. Served + injected by the add-on; web/ is NEVER modified.
//
// index.html already speaks one protocol to its host: it postMessages
// {type:'ready'} and then consumes `scene_bin` + `delta_bin` shared buffers via
// `chrome.webview` `sharedbufferreceived` events, applying them with its own
// handleBinaryScene / handleBinaryDelta (the same code the C++ host drives).
// So all we do is provide that host:
//   • define window.chrome.webview BEFORE index.html's standalone check (line ~9)
//   • on the 'ready' handshake, push snapshot.json + scene.bin as `scene_bin`
//   • stream MXJB delta frames (SSE /maxjs/stream) as `delta_bin`
// No scene/apply logic here — index.html does all of it natively.

(function () {
    if (window.chrome && window.chrome.webview) return; // real WebView2 host — leave it

    const listeners = { message: [], sharedbufferreceived: [] };
    let booted = false;
    let frames = 0;

    function dispatchShared(buffer, meta) {
        const ev = { getBuffer: () => buffer, additionalData: meta, data: meta };
        for (const fn of listeners.sharedbufferreceived.slice()) {
            try { fn(ev); } catch (e) { console.error("[maxjs shim] shared handler", e); }
        }
    }

    function b64ToArrayBuffer(b64) {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8.buffer; // fresh buffer at offset 0 → frame views stay 4-aligned
    }

    function badge(text, ok) {
        if (!document.body) return;
        let el = document.getElementById("maxjs-ipr-badge");
        if (!el) {
            el = document.createElement("div");
            el.id = "maxjs-ipr-badge";
            el.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:99999;" +
                "font:12px/1.4 system-ui,sans-serif;padding:4px 9px;border-radius:6px;" +
                "background:rgba(0,0,0,.6);color:#fff;pointer-events:none;backdrop-filter:blur(4px)";
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.style.color = ok ? "#7CFC9B" : "#FFB454";
    }

    async function bootScene() {
        if (booted) return;
        booted = true;
        try {
            const meta = await fetch("/snapshot.json", { cache: "no-store" }).then((r) => r.json());
            const buffer = await fetch("/" + (meta.bin || "scene.bin"), { cache: "no-store" })
                .then((r) => r.arrayBuffer());
            dispatchShared(buffer, meta); // meta.type === 'scene_bin' → handleBinaryScene
        } catch (e) {
            console.error("[maxjs shim] initial scene load failed", e);
            booted = false;
            return;
        }
        const es = new EventSource("/maxjs/stream");
        es.onmessage = (ev) => {
            try {
                dispatchShared(b64ToArrayBuffer(ev.data), { type: "delta_bin" });
                frames++;
                badge("max.js IPR ● live · " + frames + " frames", true);
            } catch (e) {
                console.error("[maxjs shim] delta apply failed", e);
            }
        };
        es.addEventListener("sharedbuffer", (ev) => {
            try {
                const payload = JSON.parse(ev.data);
                dispatchShared(b64ToArrayBuffer(payload.data), payload.meta);
                frames++;
                const kind = payload?.meta?.type || "buffer";
                badge("max.js IPR ● live · " + frames + " frames · " + kind, true);
            } catch (e) {
                console.error("[maxjs shim] shared buffer apply failed", e);
            }
        });
        es.onopen = () => badge("max.js IPR ● live", true);
        es.onerror = () => badge("max.js IPR ○ reconnecting…", false);
    }

    window.chrome = window.chrome || {};
    window.chrome.webview = {
        addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
        removeEventListener(type, fn) {
            const a = listeners[type];
            if (!a) return;
            const i = a.indexOf(fn);
            if (i >= 0) a.splice(i, 1);
        },
        postMessage(msg) {
            // index.html → host. The only one we must honor is the readiness
            // handshake and camera lock. Other host calls (gpu_normals,
            // path-tracing state, snapshot export, file dialogs…) are safe to
            // ignore in the browser.
            if (msg && msg.type === "ready") bootScene();
            if (msg && msg.type === "lock_camera") {
                fetch("/maxjs/host", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(msg),
                    cache: "no-store",
                }).catch((e) => console.warn("[maxjs shim] lock_camera failed", e));
            }
        },
        postMessageWithAdditionalObjects() {},
        releaseBuffer() {},
    };
})();
