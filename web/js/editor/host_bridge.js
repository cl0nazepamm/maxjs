// host_bridge.js — the max.js host seam. Everything the editor knows about its
// host (3ds Max WebView2, the Blender webview2_shim, a future standalone app)
// goes through here; nothing else in web/ may touch window.chrome.webview.
//
// A host provides `window.chrome.webview` BEFORE the index.html head bootstrap
// runs, with:
//   addEventListener('message')              JSON control messages in
//   addEventListener('sharedbufferreceived') binary payloads in (scene_bin,
//                                            delta_bin, geo_fast, gi_*_bin)
//   postMessage(obj)                         viewer -> host, {type, ...} objects
//   releaseBuffer(buf)                       may be a no-op
// The viewer opens with a `{type:'ready', contractVersion}` handshake and
// retries once a second until the first scene payload arrives.
// Full contract: web/HOST_CONTRACT.md.

const HOST_CONTRACT_VERSION = 1;

function createHostBridge({ setInfoText, onFirstSync, onBeforeReady } = {}) {
    const bridge = {
        send(type, data = {}) { window.chrome?.webview?.postMessage({ type, ...data }); },
        handlers: {},
        on(type, fn) { (this.handlers[type] ??= []).push(fn); },
        dispatch(msg) { (this.handlers[msg.type] || []).forEach(fn => fn(msg)); }
    };
    const pendingHostActions = new Map();
    let nextHostActionId = 1;
    let hasInitialSync = false;
    let resolveInitialSync = null;
    const initialSyncPromise = new Promise(resolve => {
        resolveInitialSync = resolve;
    });
    let readyRetryTimer = 0;
    const sharedBufferHandlers = new Map(); // meta.type -> (buf, meta) => void
    let sharedBufferFallback = null;        // scene_bin & anything untyped

    function toBase64Utf8(text) {
        const bytes = new TextEncoder().encode(String(text ?? ''));
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    function requestHostAction(action, data = {}, timeoutMs = 60000) {
        if (!window.chrome?.webview) {
            return Promise.reject(new Error(`${action} requires the 3ds Max host`));
        }
        const requestId = `host_${Date.now()}_${nextHostActionId++}`;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingHostActions.delete(requestId);
                reject(new Error(`${action} timed out`));
            }, timeoutMs);
            pendingHostActions.set(requestId, { action, resolve, reject, timeout });
            bridge.send(action, { requestId, ...data });
        });
    }

    // Response half of requestHostAction. Registered here at creation time so
    // it runs before any subsystem 'host_action_result' handlers boot adds.
    bridge.on('host_action_result', msg => {
        const pending = pendingHostActions.get(msg.requestId);
        if (pending && (!msg.action || msg.action === pending.action)) {
            pendingHostActions.delete(msg.requestId);
            clearTimeout(pending.timeout);
            if (msg.ok) pending.resolve(msg);
            else pending.reject(new Error(msg.error || `${pending.action} failed`));
        }
    });

    function scheduleReadyRetry() {
        if (!window.chrome?.webview || readyRetryTimer) return;
        readyRetryTimer = setInterval(() => {
            if (hasInitialSync) {
                clearInterval(readyRetryTimer);
                readyRetryTimer = 0;
                return;
            }
            bridge.send('ready', { contractVersion: HOST_CONTRACT_VERSION });
        }, 1000);
    }

    function stopReadyRetry() {
        if (!readyRetryTimer) return;
        clearInterval(readyRetryTimer);
        readyRetryTimer = 0;
    }

    function markInitialSync() {
        if (hasInitialSync) return;
        hasInitialSync = true;
        stopReadyRetry();
        resolveInitialSync?.();
        resolveInitialSync = null;
        onFirstSync?.();
    }

    function whenInitialSync() {
        return hasInitialSync ? Promise.resolve() : initialSyncPromise;
    }

    function startBridgeHandshake() {
        if (!window.chrome?.webview) return;
        setInfoText?.('max.js - connected, waiting for sync...');
        onBeforeReady?.();
        bridge.send('ready', { contractVersion: HOST_CONTRACT_VERSION });
        scheduleReadyRetry();
    }

    function reportBridgeError(prefix, err) {
        const message = err?.message || String(err);
        console.error(`[max.js ${prefix}]`, err);
        setInfoText?.(`max.js - ${prefix}: ${message}`);
    }

    function onSharedBuffer(type, fn) {
        sharedBufferHandlers.set(type, fn);
    }

    function onSharedBufferFallback(fn) {
        sharedBufferFallback = fn;
    }

    // Installs the window/host event wiring. Returns true when a host is
    // present, false in standalone mode. Call once, after all bridge.on /
    // onSharedBuffer registrations.
    function installHostWiring() {
        window.addEventListener('error', e => {
            reportBridgeError('runtime error', e.error || e.message);
        });
        window.addEventListener('unhandledrejection', e => {
            reportBridgeError('promise error', e.reason);
        });

        if (!window.chrome?.webview) {
            setInfoText?.('max.js - no bridge (standalone mode)');
            return false;
        }

        window.chrome.webview.addEventListener('message', e => {
            try { bridge.dispatch(e.data); }
            catch (err) { reportBridgeError('message error', err); }
        });

        // Binary shared buffer router (zero-copy geometry). The buffer is only
        // valid inside the handler — released in finally.
        window.chrome.webview.addEventListener('sharedbufferreceived', e => {
            let buf = null;
            try {
                buf = e.getBuffer();
                const meta = typeof e.additionalData === 'string'
                    ? JSON.parse(e.additionalData) : e.additionalData;
                const handler = sharedBufferHandlers.get(meta?.type) || sharedBufferFallback;
                if (handler) handler(buf, meta);
            } catch (err) { reportBridgeError('binary sync error', err); }
            finally {
                if (buf) window.chrome.webview.releaseBuffer(buf);
            }
        });
        return true;
    }

    return {
        bridge,
        requestHostAction,
        toBase64Utf8,
        bytesToBase64,
        scheduleReadyRetry,
        stopReadyRetry,
        markInitialSync,
        startBridgeHandshake,
        reportBridgeError,
        onSharedBuffer,
        onSharedBufferFallback,
        installHostWiring,
        hasInitialSync: () => hasInitialSync,
        whenInitialSync,
    };
}

export { createHostBridge, HOST_CONTRACT_VERSION };
