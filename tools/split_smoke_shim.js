// split_smoke_shim.js — minimal fake WebView2 host for the index.html boot
// smoke test (see tools/split_smoke_server.mjs). Injected BEFORE the head
// bootstrap so the standalone redirect never fires. Sends NO scene — the gate
// is "the full editor module graph evaluates, reaches the ready handshake, and
// throws nothing", which is exactly what extraction steps can break.
// Results land on window.__SMOKE for the driver to poll.
(function () {
    const S = window.__SMOKE = { pageErrors: [], posts: [], ready: false };
    window.addEventListener('error', (e) => {
        S.pageErrors.push(String((e.error && e.error.stack) || e.message || e));
    });
    window.addEventListener('unhandledrejection', (e) => {
        S.pageErrors.push('unhandledrejection: ' + String((e.reason && e.reason.stack) || e.reason));
    });

    if (window.chrome && window.chrome.webview) return; // real host — never shadow it
    const listeners = { message: [], sharedbufferreceived: [] };
    window.chrome = window.chrome || {};
    window.chrome.webview = {
        addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
        removeEventListener(type, fn) {
            const arr = listeners[type];
            if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
        },
        postMessage(msg) {
            S.posts.push(msg && msg.type ? msg.type : String(msg));
            if (msg && msg.type === 'ready') S.ready = true;
        },
        postMessageWithAdditionalObjects() {},
        releaseBuffer() {},
    };
})();
