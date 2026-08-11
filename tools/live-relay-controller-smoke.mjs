import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    DEFAULT_RELAY_URL,
    RELAY_STATES,
    createLiveRelayController,
    validateRelayEndpoint,
} from '../web/js/live_relay_tap.js';
import { decodeRelayFrame } from '../web/js/relay_frame.mjs';

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const relaySource = await readFile(new URL('../web/js/live_relay_tap.js', import.meta.url), 'utf8');
const bootSource = await readFile(new URL('../web/js/editor/boot.js', import.meta.url), 'utf8');
const syncEntrySource = await readFile(new URL('../src/maxjs_panel_sync_entry.inl', import.meta.url), 'utf8');
assert.doesNotMatch(relaySource, /window\.chrome|chrome\.webview/);
assert.doesNotMatch(relaySource, /window\.(?:requestAnimationFrame|cancelAnimationFrame)\s*=/);
assert.doesNotMatch(relaySource, /maxjsRelayEmit/);
assert.match(bootSource, /renderer\.setAnimationLoop\(null\)/);
assert.match(bootSource, /inlineTimer\.reset\(\)/);
assert.match(bootSource, /localStorage\.removeItem\('maxjs\.liveRelayUrl'\)/);
assert.match(bootSource, /maxjs\.liveRelayEnabled/);
assert.match(bootSource, /if \(relayEnabledPreference\) setRelayEnabled\(true\)/);

const fullSceneRepairBody = /    void RequestFullSceneRepair\(\) \{([\s\S]*?)\n    \}/.exec(syncEntrySource)?.[1];
assert.ok(fullSceneRepairBody, 'native full-scene repair handler must remain present');
assert.match(fullSceneRepairBody,
    /if \(slowJsonSyncMode_\) \{[\s\S]*?dirty_ = true;[\s\S]*?dirtyStamp_ = 0;/,
    'relay_resync must schedule a full baseline even when SLOW mode gates SetDirtyImmediate');

// Scene bytes may only be posted directly to an explicit loopback HTTP
// endpoint. Reject remote hosts, URL credentials, fragments, and TLS URLs.
assert.equal(validateRelayEndpoint(DEFAULT_RELAY_URL), DEFAULT_RELAY_URL);
assert.equal(validateRelayEndpoint('http://localhost:8080/ingest'), 'http://localhost:8080/ingest');
assert.equal(validateRelayEndpoint('http://127.22.3.4:8080/ingest'), 'http://127.22.3.4:8080/ingest');
assert.equal(validateRelayEndpoint('http://[::1]:8080/ingest'), 'http://[::1]:8080/ingest');
for (const unsafeEndpoint of [
    'https://127.0.0.1:5173/maxjs-relay-in',
    'http://relay.example/maxjs-relay-in',
    'http://user:secret@127.0.0.1:5173/maxjs-relay-in',
    'http://127.0.0.1:5173/maxjs-relay-in#remote',
]) {
    assert.throws(() => validateRelayEndpoint(unsafeEndpoint), /relay endpoint/i);
}

async function waitFor(predicate, label, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await delay(5);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function fakeHostBridge() {
    let observer = null;
    return {
        observeTransport(fn) {
            observer = fn;
            return () => { if (observer === fn) observer = null; };
        },
        shared(buffer, meta) { observer?.({ kind: 'shared-buffer', buffer, meta }); },
        message(data) { observer?.({ kind: 'message', data }); },
    };
}

function fakeResponse(status) {
    return {
        ok: true,
        status: 200,
        async json() { return { ...status }; },
    };
}

// host_bridge must notify observers synchronously before the shared buffer is
// released, while keeping the editor's own handler in the same dispatch.
{
    const webviewListeners = new Map();
    const order = [];
    let copied = null;
    globalThis.window = {
        chrome: {
            webview: {
                addEventListener(type, fn) { webviewListeners.set(type, fn); },
                postMessage() {},
                releaseBuffer(buffer) {
                    order.push('release');
                    new Uint8Array(buffer).fill(0);
                },
            },
        },
        addEventListener() {},
    };
    const { createHostBridge } = await import(`../web/js/editor/host_bridge.js?relay-smoke=${Date.now()}`);
    const bridge = createHostBridge();
    bridge.observeTransport((event) => {
        if (event.kind !== 'shared-buffer') return;
        order.push('observer');
        copied = Uint8Array.from(new Uint8Array(event.buffer));
    });
    bridge.onSharedBuffer('scene_bin', () => order.push('editor'));
    bridge.installHostWiring();
    const source = Uint8Array.from([7, 8, 9]).buffer;
    webviewListeners.get('sharedbufferreceived')({
        getBuffer: () => source,
        additionalData: JSON.stringify({ type: 'scene_bin' }),
    });
    assert.deepEqual(order, ['observer', 'editor', 'release']);
    assert.deepEqual([...copied], [7, 8, 9]);
    assert.deepEqual([...new Uint8Array(source)], [0, 0, 0]);
    delete globalThis.window;
}

// Controller handshake, cycle-scoped host replay, persistent panel replay,
// strict sequence metadata, and first-ready render gating.
{
    const host = fakeHostBridge();
    const posts = [];
    const resyncs = [];
    const readyCounts = [];
    let identity = null;
    let relayStatus = {
        kind: 'relay_status',
        version: 1,
        relayId: 'relay-smoke',
        streamId: 'default',
        producerId: '',
        sessionId: '',
        consumers: 0,
        readyConsumers: 0,
        needScene: false,
        sceneRequestId: 0,
        sceneRevision: 0,
    };
    let reportFirstReady = false;

    const fetchImpl = async (_url, init) => {
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        const isBinary = init.headers['content-type'] === 'application/octet-stream';
        let decoded = null;
        let json = null;
        if (isBinary) {
            decoded = decodeRelayFrame(init.body, { requireSceneRequestId: true });
        } else {
            json = JSON.parse(init.body);
        }
        posts.push({ isBinary, decoded, json });

        if (json?.kind === 'producer_hello') {
            identity = json;
            relayStatus.producerId = identity.producerId;
            relayStatus.sessionId = identity.sessionId;
        } else if (decoded?.relay.sequence === 0) {
            relayStatus.sceneRevision = decoded.relay.sceneRevision;
            relayStatus.needScene = false;
            // Broadcasting a baseline makes the consumer wait for its ack.
            if (relayStatus.consumers) relayStatus.readyConsumers = 0;
        } else if (json?.kind === 'scene') {
            relayStatus.sceneRevision = json.relay.sceneRevision;
            relayStatus.needScene = false;
            if (relayStatus.consumers) relayStatus.readyConsumers = 0;
        }

        if (reportFirstReady && (decoded?.relay.sequence ?? json?.relay?.sequence) > 0) {
            reportFirstReady = false;
            relayStatus.consumers = 1;
            relayStatus.readyConsumers = 1;
        }
        return fakeResponse(relayStatus);
    };

    const controller = createLiveRelayController({
        hostBridge: host,
        fetchImpl,
        producerId: 'producer-smoke',
        createSessionId: () => 'session-smoke',
        requestScene: (details) => resyncs.push(details),
        onReadyConsumersChange: (count) => readyCounts.push(count),
        heartbeatMs: 10000,
    });

    assert.equal(controller.state, RELAY_STATES.OFF);
    controller.enable();
    // This viewer-owned state is cached while producer_hello is in flight.
    controller.emit({ type: 'speedballGiSettings', settings: { intensity: 2 } });
    await waitFor(() => resyncs.length === 1, 'initial relay_resync');
    assert.equal(controller.state, RELAY_STATES.RECOVERING);
    assert.equal(resyncs[0].reason, 'relay-enabled');
    // This host update lands during the resync window and must follow the
    // baseline once, but must never survive into a later scene revision.
    host.message({ type: 'env_update', exposure: 3 });

    host.shared(Uint8Array.from([1, 2, 3, 4]).buffer, { type: 'scene_bin', frame: 4 });
    await waitFor(() => posts.filter((entry) => entry.isBinary || entry.json?.kind === 'msg').length >= 3,
        'scene plus cached panel and current-cycle host state');

    const baseline = posts.find((entry) => entry.isBinary)?.decoded;
    const speedball = posts.find((entry) => entry.json?.data?.type === 'speedballGiSettings')?.json;
    const env = posts.find((entry) => entry.json?.data?.type === 'env_update')?.json;
    assert.ok(baseline);
    assert.equal(baseline.meta.type, 'scene_bin');
    assert.equal(baseline.relay.streamId, 'default');
    assert.equal(baseline.relay.producerId, 'producer-smoke');
    assert.equal(baseline.relay.sessionId, 'session-smoke');
    assert.equal(baseline.relay.sceneRequestId, 0);
    assert.equal(baseline.relay.sceneRevision, 1);
    assert.equal(baseline.relay.sequence, 0);
    assert.deepEqual([...baseline.payload], [1, 2, 3, 4]);
    assert.equal(speedball.relay.sceneRevision, 1);
    assert.equal(speedball.relay.sequence, 1);
    assert.equal(env.relay.sceneRevision, 1);
    assert.equal(env.relay.sequence, 2);
    await waitFor(() => controller.state === RELAY_STATES.STREAMING, 'streaming state');

    reportFirstReady = true;
    host.shared(Uint8Array.from([5, 0, 0, 0]).buffer, {
        type: 'delta_bin',
        frame: 5,
        stats: { producerBytes: 1 },
    });
    await waitFor(() => readyCounts.includes(1), 'first-ready consumer status');
    const firstDelta = await waitFor(
        () => posts.find((entry) => entry.isBinary && entry.decoded.meta.frame === 5)?.decoded,
        'retained-buffer delta forwarded',
    );
    assert.deepEqual([...firstDelta.payload], [5]);
    assert.deepEqual(readyCounts, [1]);
    assert.equal(resyncs.length, 1, 'first-ready acknowledgement must not request a second baseline');
    assert.equal(controller.state, RELAY_STATES.STREAMING);

    // Every sync lane the viewer consumes is forwarded: native GI packets ride
    // as ordered binary continuations, clay mode as an ordered JSON message.
    host.shared(Uint8Array.from([9, 9]).buffer, { type: 'gi_surface_bin', probeCount: 1 });
    host.shared(Uint8Array.from([9]).buffer, { type: 'gi_light_bin', lightCount: 1 });
    host.message({ type: 'clay_mode', enabled: true });
    const giSurface = await waitFor(
        () => posts.find((entry) => entry.isBinary && entry.decoded.meta.type === 'gi_surface_bin')?.decoded,
        'gi_surface_bin forwarded');
    await waitFor(() => posts.some((entry) => entry.isBinary && entry.decoded.meta.type === 'gi_light_bin'),
        'gi_light_bin forwarded');
    const clay = await waitFor(
        () => posts.find((entry) => entry.json?.data?.type === 'clay_mode')?.json,
        'clay_mode forwarded');
    assert.equal(giSurface.relay.sceneRevision, 1);
    assert.ok(giSurface.relay.sequence > 0);
    assert.deepEqual([...giSurface.payload], [9, 9]);
    assert.equal(clay.data.enabled, true);
    assert.equal(clay.relay.sceneRevision, 1);

    relayStatus.needScene = true;
    relayStatus.sceneRequestId = 1;
    relayStatus.readyConsumers = 0;
    host.shared(Uint8Array.from([6]).buffer, { type: 'delta_bin', frame: 6 });
    await waitFor(() => resyncs.some((entry) => entry.reason === 'scene-request-changed'),
        'broker-requested second baseline');
    host.shared(Uint8Array.from([7, 8]).buffer, { type: 'scene_bin', frame: 7 });
    await waitFor(() => posts.filter((entry) => entry.isBinary && entry.decoded.relay.sequence === 0).length === 2,
        'second baseline');
    const secondBaseline = posts.filter((entry) => entry.isBinary && entry.decoded.relay.sequence === 0)[1].decoded;
    assert.equal(secondBaseline.relay.sceneRevision, 2);
    assert.equal(secondBaseline.relay.sceneRequestId, 1);
    assert.equal(secondBaseline.relay.sequence, 0);
    await waitFor(() => posts.filter((entry) => entry.json?.data?.type === 'speedballGiSettings').length === 2,
        'persistent panel state replay');
    assert.equal(posts.filter((entry) => entry.json?.data?.type === 'env_update').length, 1,
        'old host state must not overwrite a later baseline');
    await waitFor(() => controller.state === RELAY_STATES.STREAMING, 'second streaming state');

    controller.disable();
    assert.equal(controller.state, RELAY_STATES.OFF);
    assert.deepEqual(readyCounts, [1, 0]);
    await waitFor(() => posts.some((entry) => entry.json?.kind === 'producer_goodbye'),
        'producer ownership release');
    controller.dispose();
}

// Queue caps fail closed and request a new authoritative baseline.
{
    const host = fakeHostBridge();
    const resyncs = [];
    let identity = null;
    const status = {
        kind: 'relay_status', version: 1, relayId: 'relay-overflow', streamId: 'default',
        producerId: '', sessionId: '', consumers: 0, readyConsumers: 0,
        needScene: false, sceneRequestId: 0, sceneRevision: 0,
    };
    const controller = createLiveRelayController({
        hostBridge: host,
        producerId: 'producer-overflow',
        createSessionId: () => 'session-overflow',
        queueMaxBytes: 8,
        requestScene: (details) => resyncs.push(details),
        heartbeatMs: 10000,
        fetchImpl: async (_url, init) => {
            const json = JSON.parse(init.body);
            if (json.kind === 'producer_hello') {
                identity = json;
                status.producerId = identity.producerId;
                status.sessionId = identity.sessionId;
            }
            return fakeResponse(status);
        },
    });
    controller.enable();
    await waitFor(() => resyncs.length === 1, 'overflow controller handshake');
    host.shared(Uint8Array.from([1]).buffer, { type: 'scene_bin' });
    await waitFor(() => resyncs.some((entry) => entry.reason === 'queue-overflow'), 'queue overflow recovery');
    assert.equal(controller.state, RELAY_STATES.RECOVERING);
    controller.dispose();
}

// A relay_resync the host drops must not park the relay in RECOVERING until a
// manual reload: while the baseline is missing the request is re-issued on
// resyncRetryMs, and the retries stop once a baseline streams.
{
    const host = fakeHostBridge();
    const resyncs = [];
    const status = {
        kind: 'relay_status', version: 1, relayId: 'relay-retry', streamId: 'default',
        producerId: '', sessionId: '', consumers: 1, readyConsumers: 0,
        needScene: true, sceneRequestId: 3, sceneRevision: 0,
    };
    const controller = createLiveRelayController({
        hostBridge: host,
        producerId: 'producer-retry',
        createSessionId: () => 'session-retry',
        heartbeatMs: 15,
        resyncRetryMs: 40,
        requestScene: (details) => resyncs.push(details),
        fetchImpl: async (_url, init) => {
            if (init.headers['content-type'] === 'application/octet-stream') {
                const decoded = decodeRelayFrame(init.body, { requireSceneRequestId: true });
                if (decoded.relay.sequence === 0) {
                    status.sceneRevision = decoded.relay.sceneRevision;
                    status.needScene = false;
                }
            } else {
                const json = JSON.parse(init.body);
                if (json.kind === 'producer_hello') {
                    status.producerId = json.producerId;
                    status.sessionId = json.sessionId;
                }
            }
            return fakeResponse(status);
        },
    });
    controller.enable();
    await waitFor(() => resyncs.length >= 3, 'host resync re-issued while the baseline is missing', 4000);
    assert.equal(controller.state, RELAY_STATES.RECOVERING);
    assert.ok(resyncs.every((entry) => entry.sceneRequestId === 3),
        'retries must keep the broker\'s outstanding scene request id');

    host.shared(Uint8Array.from([1, 2]).buffer, { type: 'scene_bin' });
    await waitFor(() => controller.state === RELAY_STATES.STREAMING, 'baseline ends recovery');
    const settled = resyncs.length;
    await delay(150);
    assert.equal(resyncs.length, settled, 'retries must stop once the baseline streamed');
    assert.equal(controller.state, RELAY_STATES.STREAMING);
    controller.dispose();
}

// Sync traffic arriving while the baseline is missing must itself re-arm the
// rate-limited host resync: a host that is clearly alive (streaming deltas)
// but missed the request gets nudged without waiting for a heartbeat.
{
    const host = fakeHostBridge();
    const resyncs = [];
    const status = {
        kind: 'relay_status', version: 1, relayId: 'relay-nudge', streamId: 'default',
        producerId: '', sessionId: '', consumers: 1, readyConsumers: 0,
        needScene: true, sceneRequestId: 7, sceneRevision: 0,
    };
    const controller = createLiveRelayController({
        hostBridge: host,
        producerId: 'producer-nudge',
        createSessionId: () => 'session-nudge',
        heartbeatMs: 10000,
        resyncRetryMs: 30,
        requestScene: (details) => resyncs.push(details),
        fetchImpl: async (_url, init) => {
            const json = JSON.parse(init.body);
            if (json.kind === 'producer_hello') {
                status.producerId = json.producerId;
                status.sessionId = json.sessionId;
            }
            return fakeResponse(status);
        },
    });
    controller.enable();
    await waitFor(() => resyncs.length === 1, 'nudge scenario handshake');
    for (let index = 0; index < 20 && resyncs.length < 3; index++) {
        host.shared(Uint8Array.from([index]).buffer, { type: 'delta_bin', frame: index });
        host.message({ type: 'env_update', exposure: index });
        await delay(10);
    }
    assert.ok(resyncs.length >= 3,
        'host sync traffic while awaiting the baseline must re-arm the resync request');
    assert.ok(resyncs.every((entry) => entry.sceneRequestId === 7));
    controller.dispose();
}

// Every request has an AbortController deadline; a hung handshake reaches the
// explicit error state and leaves the renderer consumer count at zero.
{
    const host = fakeHostBridge();
    let aborted = false;
    const postKinds = [];
    const controller = createLiveRelayController({
        hostBridge: host,
        producerId: 'producer-timeout',
        createSessionId: () => 'session-timeout',
        requestTimeoutMs: 15,
        heartbeatMs: 10000,
        fetchImpl: async (_url, init) => {
            const body = JSON.parse(init.body);
            postKinds.push(body.kind);
            if (body.kind === 'producer_goodbye') return fakeResponse({});
            return new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(new DOMException('aborted', 'AbortError'));
                }, { once: true });
            });
        },
    });
    controller.enable();
    await waitFor(() => controller.state === RELAY_STATES.ERROR, 'deadline error state');
    assert.equal(aborted, true);
    assert.match(controller.getState().lastError, /timed out/i);
    assert.equal(controller.readyConsumers, 0);
    controller.dispose();
    await waitFor(() => postKinds.includes('producer_goodbye'),
        'goodbye after ambiguous or aborted hello');
}

console.log('live relay controller smoke passed');
