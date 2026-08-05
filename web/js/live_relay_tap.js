// live_relay_tap.js - opt-in producer controller for the max.js live relay.
//
// Host traffic is observed through host_bridge. Shared buffers are framed
// synchronously inside that observer, before WebView2 releases them. The relay
// never installs a second WebView listener and never patches requestAnimationFrame.

import {
    encodeRelayFrame,
    RELAY_FRAME_LIMITS,
    RELAY_PROTOCOL_VERSION,
} from './relay_frame.mjs';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:5173/maxjs-relay-in';
const DEFAULT_STREAM_ID = 'default';
// Ready/disconnect state is learned through producer status responses. Keep
// render suspension/resume responsive without turning the loopback broker into
// a busy poller.
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3500;
const DEFAULT_FRAME_TIMEOUT_MS = 15000;
const DEFAULT_QUEUE_MAX_COUNT = 512;
// A legal maximum-size relay frame must fit by itself. The cap remains finite,
// and a backed-up stream trips recovery instead of growing without bound.
const DEFAULT_QUEUE_MAX_BYTES = RELAY_FRAME_LIMITS.maxFrameBytes + (16 * 1024 * 1024);

const RELAY_STATES = Object.freeze({
    OFF: 'off',
    CONNECTING: 'connecting',
    STREAMING: 'streaming',
    RECOVERING: 'recovering',
    ERROR: 'error',
});

const BINARY_FORWARD_TYPES = new Set(['scene_bin', 'delta_bin', 'geo_fast']);
const JSON_FORWARD_TYPES = new Set([
    'scene',       // SLOW/full JSON baseline
    'geo_fast',    // JSON geometry fallback
    'xform',       // SLOW transforms/material scalars/lights
    'hair_fast',
    'cam',
    'audio_update',
    'gltf_update',
    'webapp_update',
    'env_update',
    'probeGrids',
]);

// Change-only host lanes observed during one resync are replayed after that
// baseline only. Array lanes are keyed per authored handle; whole lanes replace
// their previous value. Panel-owned HALO/probe state has its own persistent map.
const KEYED_JSON_STATE = Object.freeze({
    audio_update: 'audios',
    gltf_update: 'gltfs',
    webapp_update: 'webapps',
});
const WHOLE_JSON_STATE = new Set(['cam', 'env_update', 'probeGrids', 'haloGiSettings']);
const PANEL_JSON_TYPES = new Set(['haloGiSettings', 'probeGrids']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const textEncoder = new TextEncoder();

function makeRelayId(prefix = 'relay') {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `${prefix}-${uuid}`;
    const random = Math.random().toString(36).slice(2);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function validRelayId(value, fallback) {
    const id = String(value ?? '').trim();
    return ID_PATTERN.test(id) ? id : fallback;
}

function finiteCounter(value, fallback = 0) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeErrorMessage(value) {
    try {
        if (value && typeof value.message === 'string') return value.message;
        return String(value);
    } catch {
        return 'unprintable relay error';
    }
}

function positiveLimit(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
    }
    return resolved;
}

function validateRelayEndpoint(value) {
    const raw = String(value ?? '').trim();
    if (!raw) throw new TypeError('relay endpoint is required');

    let endpoint;
    try {
        endpoint = new URL(raw);
    } catch {
        throw new TypeError('relay endpoint must be an absolute URL');
    }

    if (endpoint.protocol !== 'http:') {
        throw new TypeError('relay endpoint must use loopback HTTP');
    }
    if (endpoint.username || endpoint.password) {
        throw new TypeError('relay endpoint must not contain credentials');
    }
    // URL.hash is empty for a bare trailing '#', so check the source too.
    if (raw.includes('#')) {
        throw new TypeError('relay endpoint must not contain a fragment');
    }

    const hostname = endpoint.hostname.toLowerCase();
    const ipv4Parts = hostname.split('.');
    const isIpv4Loopback = ipv4Parts.length === 4
        && ipv4Parts[0] === '127'
        && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    const isLoopback = hostname === 'localhost'
        || hostname === 'localhost.'
        || hostname === '[::1]'
        || isIpv4Loopback;
    if (!isLoopback) {
        throw new TypeError('relay endpoint host must be localhost or a loopback IP');
    }

    return endpoint.href;
}

function createLiveRelayController(options = {}) {
    const hostBridge = options.hostBridge;
    if (!hostBridge?.observeTransport) {
        throw new TypeError('live relay requires hostBridge.observeTransport()');
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    const AbortControllerImpl = options.AbortControllerImpl ?? globalThis.AbortController;
    const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout?.bind(globalThis);
    const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout?.bind(globalThis);
    const setIntervalImpl = options.setIntervalImpl ?? globalThis.setInterval?.bind(globalThis);
    const clearIntervalImpl = options.clearIntervalImpl ?? globalThis.clearInterval?.bind(globalThis);
    if (!setTimeoutImpl || !clearTimeoutImpl || !setIntervalImpl || !clearIntervalImpl) {
        throw new Error('live relay requires timer functions');
    }

    const endpoint = validateRelayEndpoint(options.endpoint || DEFAULT_RELAY_URL);
    const streamId = validRelayId(options.streamId, DEFAULT_STREAM_ID);
    const producerId = validRelayId(options.producerId, makeRelayId('producer'));
    const createSessionId = options.createSessionId ?? (() => makeRelayId('session'));
    const heartbeatMs = positiveLimit(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, 'heartbeatMs');
    const requestTimeoutMs = positiveLimit(
        options.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        'requestTimeoutMs',
    );
    const frameTimeoutMs = positiveLimit(
        options.frameTimeoutMs,
        DEFAULT_FRAME_TIMEOUT_MS,
        'frameTimeoutMs',
    );
    const queueMaxCount = positiveLimit(
        options.queueMaxCount,
        DEFAULT_QUEUE_MAX_COUNT,
        'queueMaxCount',
    );
    const queueMaxBytes = positiveLimit(
        options.queueMaxBytes,
        DEFAULT_QUEUE_MAX_BYTES,
        'queueMaxBytes',
    );
    const requestScene = typeof options.requestScene === 'function' ? options.requestScene : () => {};
    const onReadyConsumersChange = typeof options.onReadyConsumersChange === 'function'
        ? options.onReadyConsumersChange
        : () => {};
    const logger = options.logger ?? console;

    const listeners = new Set();
    const panelJsonStateCache = new Map(); // HALO/probe state owned by this panel
    const resyncJsonStateCache = new Map(); // host updates observed in this resync only
    const queue = [];
    let queueBytes = 0;
    let state = RELAY_STATES.OFF;
    let enabled = false;
    let disposed = false;
    let handshakeReady = false;
    let everConnected = false;
    let pumping = false;
    let activeAbortController = null;
    let heartbeatTimer = 0;
    let reconnectTimer = 0;
    let sessionId = '';
    let relayId = '';
    let consumers = 0;
    let readyConsumers = 0;
    let sceneRequestId = 0;
    let lastStatusSceneRequestId = null;
    let sceneRevision = 0;
    let nextSequence = 0;
    let awaitingScene = false;
    let resyncCycle = 0;
    let resyncIssuedCycle = -1;
    let resyncReason = '';
    let lastError = '';
    let transportGeneration = 0;

    function snapshot() {
        return Object.freeze({
            state,
            enabled,
            endpoint,
            streamId,
            producerId,
            sessionId,
            relayId,
            consumers,
            readyConsumers,
            sceneRequestId,
            sceneRevision,
            sequence: Math.max(0, nextSequence - 1),
            awaitingScene,
            queueCount: queue.length,
            queueBytes,
            lastError,
        });
    }

    function publish() {
        const current = snapshot();
        for (const listener of listeners) {
            try { listener(current); }
            catch (error) { logger.warn?.('[max.js relay subscriber]', error); }
        }
    }

    function setState(next, error = '') {
        if (!Object.values(RELAY_STATES).includes(next)) throw new Error(`invalid relay state: ${next}`);
        const nextError = error ? safeErrorMessage(error) : '';
        if (state === next && lastError === nextError) return;
        state = next;
        lastError = nextError;
        publish();
    }

    function setReadyConsumers(nextCount, totalCount = consumers) {
        const nextReady = finiteCounter(nextCount);
        const nextTotal = finiteCounter(totalCount);
        const readyChanged = nextReady !== readyConsumers;
        const totalChanged = nextTotal !== consumers;
        readyConsumers = nextReady;
        consumers = nextTotal;
        if (readyChanged) {
            try { onReadyConsumersChange(readyConsumers, snapshot()); }
            catch (error) { logger.warn?.('[max.js relay render gate]', error); }
        }
        if (readyChanged || totalChanged) publish();
    }

    function relayIdentity({ revision = sceneRevision, sequence = nextSequence, requestId } = {}) {
        const relay = {
            version: RELAY_PROTOCOL_VERSION,
            streamId,
            producerId,
            sessionId,
            sceneRevision: revision,
            sequence,
        };
        if (requestId !== undefined) relay.sceneRequestId = requestId;
        return relay;
    }

    function clearQueue() {
        queue.length = 0;
        queueBytes = 0;
    }

    function removeQueuedItem(item) {
        const index = queue.indexOf(item);
        if (index < 0) return;
        queue.splice(index, 1);
        queueBytes = Math.max(0, queueBytes - item.byteLength);
    }

    function issueHostResync() {
        if (!enabled || !handshakeReady || resyncIssuedCycle === resyncCycle) return;
        resyncIssuedCycle = resyncCycle;
        try {
            requestScene({
                reason: resyncReason || 'relay-resync',
                sceneRequestId,
                streamId,
                producerId,
                sessionId,
                sceneRevision,
            });
        } catch (error) {
            setState(RELAY_STATES.ERROR, error);
        }
    }

    function beginResync(reason, requestId = sceneRequestId, { force = false, abortActive = false } = {}) {
        const normalizedRequestId = finiteCounter(requestId, sceneRequestId);
        const alreadyWaiting = awaitingScene && normalizedRequestId === sceneRequestId;
        if (!force && alreadyWaiting) {
            issueHostResync();
            return false;
        }

        transportGeneration += 1;
        resyncCycle += 1;
        resyncReason = String(reason || 'relay-resync');
        sceneRequestId = normalizedRequestId;
        awaitingScene = true;
        clearQueue();
        resyncJsonStateCache.clear();
        if (abortActive) activeAbortController?.abort();
        if (enabled) setState(RELAY_STATES.RECOVERING);
        issueHostResync();
        return true;
    }

    function enqueue(item) {
        if (!enabled || !handshakeReady) return false;
        if (item.byteLength > queueMaxBytes
            || queue.length + 1 > queueMaxCount
            || queueBytes + item.byteLength > queueMaxBytes) {
            beginResync('queue-overflow', sceneRequestId, { force: true, abortActive: true });
            return false;
        }
        queue.push(item);
        queueBytes += item.byteLength;
        void pump();
        return true;
    }

    function cacheWholeJson(cache, dataJson, type) {
        cache.delete(`state:${type}`);
        cache.set(`state:${type}`, dataJson);
    }

    function itemIdentity(item, index) {
        const candidate = item?.h ?? item?.handle ?? item?.id ?? item?.name ?? item?.n;
        return candidate == null ? `index:${index}` : String(candidate);
    }

    function cacheJsonState(cache, data, dataJson) {
        const type = data?.type;
        const arrayField = KEYED_JSON_STATE[type];
        if (arrayField) {
            const entries = Array.isArray(data[arrayField]) ? data[arrayField] : [];
            for (let index = 0; index < entries.length; index++) {
                const entry = entries[index];
                const replayData = { ...data, [arrayField]: [entry] };
                const replayJson = JSON.stringify(replayData);
                const key = `state:${type}:${itemIdentity(entry, index)}`;
                cache.delete(key);
                cache.set(key, replayJson);
            }
            return;
        }
        if (WHOLE_JSON_STATE.has(type)) cacheWholeJson(cache, dataJson, type);
    }

    function makeJsonItem(dataJson, { fullScene = false } = {}) {
        if (fullScene) {
            const revision = Math.max(sceneRevision, 0) + 1;
            sceneRevision = revision;
            nextSequence = 1;
            const relay = relayIdentity({ revision, sequence: 0, requestId: sceneRequestId });
            const body = `{"kind":"scene","relay":${JSON.stringify(relay)},"data":${dataJson}}`;
            return {
                body,
                byteLength: textEncoder.encode(body).byteLength,
                contentType: 'application/json',
                fullScene: true,
                sceneRequestId,
                cycle: resyncCycle,
                generation: transportGeneration,
            };
        }
        const relay = relayIdentity({ sequence: nextSequence++ });
        const body = `{"kind":"msg","relay":${JSON.stringify(relay)},"data":${dataJson}}`;
        return {
            body,
            byteLength: textEncoder.encode(body).byteLength,
            contentType: 'application/json',
            fullScene: false,
            sceneRequestId: null,
            cycle: resyncCycle,
            generation: transportGeneration,
        };
    }

    function replayCachedJsonState(cache) {
        for (const dataJson of cache.values()) {
            if (!enqueue(makeJsonItem(dataJson))) break;
        }
    }

    function handleJsonMessage(data, { panelOwned = false } = {}) {
        if (!enabled || !data || typeof data !== 'object' || typeof data.type !== 'string') return false;
        if (!panelOwned && !JSON_FORWARD_TYPES.has(data.type)) return false;
        if (panelOwned && !PANEL_JSON_TYPES.has(data.type)) return false;

        // Panel-owned state may be emitted while the handshake is in flight so
        // it is ready to replay with the first baseline. Host messages are not
        // serialized until the producer handshake has succeeded.
        if (!handshakeReady && !panelOwned) return false;
        let dataJson;
        try { dataJson = JSON.stringify(data); }
        catch { return false; }
        if (typeof dataJson !== 'string') return false;
        if (panelOwned) cacheJsonState(panelJsonStateCache, data, dataJson);
        else if (awaitingScene) cacheJsonState(resyncJsonStateCache, data, dataJson);
        if (!handshakeReady) return true;

        if (data.type === 'scene') {
            const item = makeJsonItem(dataJson, { fullScene: true });
            if (!enqueue(item)) return false;
            // The baseline is already first in the strict queue. Accept later
            // host packets behind it while the POST is in flight.
            awaitingScene = false;
            replayCachedJsonState(panelJsonStateCache);
            replayCachedJsonState(resyncJsonStateCache);
            resyncJsonStateCache.clear();
            return true;
        }
        if (awaitingScene) return true;
        return enqueue(makeJsonItem(dataJson));
    }

    function handleSharedBuffer(buffer, incomingMeta = {}) {
        if (!enabled || !handshakeReady || !buffer) return false;
        const meta = incomingMeta && typeof incomingMeta === 'object' ? incomingMeta : {};
        const type = meta.type || 'scene_bin';
        if (!BINARY_FORWARD_TYPES.has(type)) return false;
        const fullScene = type === 'scene_bin';
        if (awaitingScene && !fullScene) return false;

        let relay;
        if (fullScene) {
            const revision = Math.max(sceneRevision, 0) + 1;
            sceneRevision = revision;
            nextSequence = 1;
            relay = relayIdentity({ revision, sequence: 0, requestId: sceneRequestId });
        } else {
            relay = relayIdentity({ sequence: nextSequence++ });
        }

        let body;
        try {
            // encodeRelayFrame copies the shared payload synchronously. This
            // function is called by host_bridge before releaseBuffer().
            body = encodeRelayFrame({ ...meta, relay }, new Uint8Array(buffer), {
                requireSceneRequestId: fullScene,
            });
        } catch (error) {
            beginResync('binary-frame-error', sceneRequestId, { force: true, abortActive: true });
            logger.warn?.('[max.js relay binary frame]', error);
            return false;
        }

        const item = {
            body,
            byteLength: body.byteLength,
            contentType: 'application/octet-stream',
            fullScene,
            sceneRequestId: fullScene ? sceneRequestId : null,
            cycle: resyncCycle,
            generation: transportGeneration,
        };
        if (!enqueue(item)) return false;
        if (fullScene) {
            // The encoded copy is safely queued before WebView2 releases the
            // source buffer. Subsequent deltas can now line up behind it.
            awaitingScene = false;
            replayCachedJsonState(panelJsonStateCache);
            replayCachedJsonState(resyncJsonStateCache);
            resyncJsonStateCache.clear();
        }
        return true;
    }

    function observeTransport(event) {
        if (!enabled || !handshakeReady) return;
        if (event?.kind === 'shared-buffer') {
            handleSharedBuffer(event.buffer, event.meta);
        } else if (event?.kind === 'message') {
            handleJsonMessage(event.data);
        }
    }

    function validateRelayStatus(value) {
        if (!value || typeof value !== 'object' || value.kind !== 'relay_status') {
            throw new Error('relay endpoint did not return relay_status');
        }
        if (value.version !== RELAY_PROTOCOL_VERSION) {
            throw new Error(`relay protocol ${value.version} is incompatible with ${RELAY_PROTOCOL_VERSION}`);
        }
        if (value.streamId !== streamId || value.producerId !== producerId || value.sessionId !== sessionId) {
            throw new Error('relay status identity does not match this producer session');
        }
        if (typeof value.relayId !== 'string'
            || !ID_PATTERN.test(value.relayId)
            || typeof value.needScene !== 'boolean') {
            throw new Error('relay status identity or needScene flag is invalid');
        }
        if (!Number.isSafeInteger(value.consumers) || value.consumers < 0
            || !Number.isSafeInteger(value.readyConsumers) || value.readyConsumers < 0
            || value.readyConsumers > value.consumers
            || !Number.isSafeInteger(value.sceneRequestId) || value.sceneRequestId < 0
            || !Number.isSafeInteger(value.sceneRevision) || value.sceneRevision < 0) {
            throw new Error('relay status counters are invalid');
        }
        return value;
    }

    async function post(body, contentType, timeoutMs = requestTimeoutMs) {
        if (!fetchImpl || !AbortControllerImpl) throw new Error('fetch with AbortController is unavailable');
        const controller = new AbortControllerImpl();
        activeAbortController = controller;
        let timedOut = false;
        const deadline = setTimeoutImpl(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        try {
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                body,
                headers: {
                    accept: 'application/json',
                    'content-type': contentType,
                },
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`relay ingest returned HTTP ${response.status}`);
            return validateRelayStatus(await response.json());
        } catch (error) {
            if (timedOut) throw new Error(`relay request timed out after ${timeoutMs} ms`);
            throw error;
        } finally {
            clearTimeoutImpl(deadline);
            if (activeAbortController === controller) activeAbortController = null;
        }
    }

    function applyStatus(status) {
        const previousRelayId = relayId;
        const previousRequestId = lastStatusSceneRequestId;
        const restarted = !!previousRelayId && status.relayId !== previousRelayId;
        relayId = status.relayId;
        if (restarted) {
            sceneRevision = status.sceneRevision;
            nextSequence = 0;
        } else {
            sceneRevision = Math.max(sceneRevision, status.sceneRevision);
        }
        sceneRequestId = status.sceneRequestId;
        lastStatusSceneRequestId = status.sceneRequestId;
        setReadyConsumers(status.readyConsumers, status.consumers);

        const requestChanged = previousRequestId !== null
            && status.sceneRequestId !== previousRequestId;
        let reason = '';
        let force = false;
        if (restarted) { reason = 'relay-restart'; force = true; }
        else if (requestChanged) { reason = 'scene-request-changed'; force = true; }
        else if (status.needScene === true) reason = 'relay-needs-scene';

        if (reason) return beginResync(reason, status.sceneRequestId, { force });
        return false;
    }

    function scheduleReconnect() {
        if (!enabled || reconnectTimer) return;
        reconnectTimer = setTimeoutImpl(() => {
            reconnectTimer = 0;
            void connect();
        }, Math.min(heartbeatMs, 750));
    }

    function transportFailed(error, reason, { ambiguous = false } = {}) {
        if (!enabled) return;
        handshakeReady = false;
        setReadyConsumers(0, 0);
        beginResync(ambiguous ? 'ambiguous-failure' : reason, sceneRequestId, {
            force: true,
            abortActive: false,
        });
        setState(everConnected ? RELAY_STATES.RECOVERING : RELAY_STATES.ERROR, error);
        scheduleReconnect();
    }

    async function pump() {
        if (pumping || !enabled || !handshakeReady) return;
        pumping = true;
        try {
            while (enabled && handshakeReady && queue.length) {
                const item = queue[0];
                const generation = item.generation;
                let status;
                try {
                    status = await post(item.body, item.contentType, frameTimeoutMs);
                } catch (error) {
                    if (!enabled || generation !== transportGeneration) break;
                    transportFailed(error, 'stream-failure', { ambiguous: true });
                    break;
                }
                if (!enabled) break;
                removeQueuedItem(item);
                if (generation !== transportGeneration) continue;
                const resyncStarted = applyStatus(status);
                if (item.fullScene && item.cycle === resyncCycle && !resyncStarted) {
                    awaitingScene = false;
                    resyncReason = '';
                    setState(RELAY_STATES.STREAMING);
                }
            }
        } finally {
            pumping = false;
            if (enabled && handshakeReady && queue.length) void pump();
            else if (enabled && !handshakeReady) scheduleReconnect();
        }
    }

    async function connect() {
        if (!enabled || activeAbortController || pumping) return;
        const generation = transportGeneration;
        if (!everConnected && state !== RELAY_STATES.ERROR) setState(RELAY_STATES.CONNECTING);
        try {
            const status = await post(JSON.stringify({
                kind: 'producer_hello',
                version: RELAY_PROTOCOL_VERSION,
                streamId,
                producerId,
                sessionId,
            }), 'application/json');
            if (!enabled || generation !== transportGeneration) return;
            handshakeReady = true;
            everConnected = true;
            applyStatus(status);
            issueHostResync();
            if (awaitingScene) setState(RELAY_STATES.RECOVERING);
            else setState(RELAY_STATES.STREAMING);
            void pump();
        } catch (error) {
            if (!enabled || generation !== transportGeneration) return;
            transportFailed(error, 'connect-failure');
        }
    }

    async function heartbeat() {
        if (!enabled || pumping || activeAbortController || queue.length) return;
        if (!handshakeReady) {
            await connect();
            return;
        }
        const generation = transportGeneration;
        try {
            const status = await post(JSON.stringify({
                kind: 'producer_ping',
                version: RELAY_PROTOCOL_VERSION,
                streamId,
                producerId,
                sessionId,
            }), 'application/json');
            if (!enabled || generation !== transportGeneration) return;
            applyStatus(status);
            issueHostResync();
            if (!awaitingScene) setState(RELAY_STATES.STREAMING);
        } catch (error) {
            if (!enabled || generation !== transportGeneration) return;
            transportFailed(error, 'heartbeat-failure', { ambiguous: true });
        }
    }

    function sendGoodbye(goodbyeSessionId) {
        if (!fetchImpl || !goodbyeSessionId) return;
        const body = JSON.stringify({
            kind: 'producer_goodbye',
            version: RELAY_PROTOCOL_VERSION,
            streamId,
            producerId,
            sessionId: goodbyeSessionId,
        });
        try {
            const pending = fetchImpl(endpoint, {
                method: 'POST',
                body,
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                keepalive: true,
            });
            pending?.catch?.(() => {});
        } catch { /* lease expiry remains the fallback */ }
    }

    function enable() {
        if (disposed) throw new Error('live relay controller is disposed');
        if (enabled) return false;
        enabled = true;
        handshakeReady = false;
        everConnected = false;
        relayId = '';
        consumers = 0;
        readyConsumers = 0;
        sceneRequestId = 0;
        lastStatusSceneRequestId = null;
        sceneRevision = 0;
        nextSequence = 0;
        sessionId = validRelayId(createSessionId(), makeRelayId('session'));
        transportGeneration += 1;
        resyncCycle += 1;
        resyncIssuedCycle = -1;
        resyncReason = 'relay-enabled';
        awaitingScene = true;
        lastError = '';
        clearQueue();
        panelJsonStateCache.clear();
        resyncJsonStateCache.clear();
        setState(RELAY_STATES.CONNECTING);
        heartbeatTimer = setIntervalImpl(() => { void heartbeat(); }, heartbeatMs);
        void connect();
        return true;
    }

    function disable() {
        if (!enabled && state === RELAY_STATES.OFF) return false;
        // A hello may have reached the broker even if its response was aborted
        // or ambiguous. Releasing any enabled session is safe; an unknown
        // session simply receives a harmless rejection and the lease remains a
        // final fallback.
        const goodbyeSessionId = enabled ? sessionId : '';
        enabled = false;
        handshakeReady = false;
        transportGeneration += 1;
        if (heartbeatTimer) clearIntervalImpl(heartbeatTimer);
        if (reconnectTimer) clearTimeoutImpl(reconnectTimer);
        heartbeatTimer = 0;
        reconnectTimer = 0;
        activeAbortController?.abort();
        clearQueue();
        panelJsonStateCache.clear();
        resyncJsonStateCache.clear();
        awaitingScene = false;
        resyncReason = '';
        setReadyConsumers(0, 0);
        setState(RELAY_STATES.OFF);
        sendGoodbye(goodbyeSessionId);
        return true;
    }

    function toggle() {
        return enabled ? disable() : enable();
    }

    function emit(data) {
        return handleJsonMessage(data, { panelOwned: true });
    }

    function subscribe(listener, { immediate = true } = {}) {
        if (typeof listener !== 'function') throw new TypeError('relay subscriber must be a function');
        listeners.add(listener);
        if (immediate) listener(snapshot());
        return () => listeners.delete(listener);
    }

    function dispose() {
        if (disposed) return;
        disable();
        disposed = true;
        unobserveTransport();
        listeners.clear();
    }

    const unobserveTransport = hostBridge.observeTransport(observeTransport);

    return Object.freeze({
        enable,
        disable,
        toggle,
        emit,
        subscribe,
        dispose,
        getState: snapshot,
        get state() { return state; },
        get enabled() { return enabled; },
        get readyConsumers() { return readyConsumers; },
    });
}

export {
    BINARY_FORWARD_TYPES as RELAY_BINARY_FORWARD_TYPES,
    DEFAULT_RELAY_URL,
    DEFAULT_STREAM_ID,
    JSON_FORWARD_TYPES as RELAY_JSON_FORWARD_TYPES,
    RELAY_STATES,
    createLiveRelayController,
    validateRelayEndpoint,
};
