import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { RelayClient } from '../web/js/relay_client.js';
import { RELAY_FRAME_LIMITS, RELAY_PROTOCOL_VERSION, encodeRelayFrame } from '../web/js/relay_frame.mjs';
import { maxjsRelay } from './maxjs-relay-vite.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await delay(15);
    }
    throw new Error(`timed out waiting for ${label}`);
}

const temp = await mkdtemp(path.join(tmpdir(), 'maxjs-relay-smoke-'));
const assetRoot = path.join(temp, 'assets');
const outsideFile = path.join(temp, 'outside.png');
await mkdir(assetRoot);
await writeFile(path.join(assetRoot, 'inside.png'), Uint8Array.from([1, 2, 3]));
await writeFile(path.join(assetRoot, 'inside.txt'), 'denied');
await writeFile(outsideFile, Uint8Array.from([9, 9, 9]));

const httpServer = createServer((_request, response) => {
    response.writeHead(404);
    response.end('vite fallback');
});
const watcher = new EventEmitter();
maxjsRelay({
    streamId: 'default',
    limits: {
        maxJsonBytes: 512,
        maxMetaBytes: 4096,
        maxPayloadBytes: 4096,
        maxFrameBytes: 8192,
        maxConsumerQueueFrames: 32,
        maxConsumerQueueBytes: 8192,
        maxResyncRequests: 4,
        resyncWindowMs: 60_000,
    },
    assetProxy: {
        roots: [assetRoot],
        extensions: ['.png'],
        maxBytes: 1024,
    },
}).configureServer({
    httpServer,
    watcher,
    config: {
        server: { host: '127.0.0.1' },
        logger: { info() {} },
    },
});

await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
});
const address = httpServer.address();
const httpBase = `http://127.0.0.1:${address.port}`;
const wsUrl = `ws://127.0.0.1:${address.port}/maxjs-relay`;
const rawConsumerUrl = `${wsUrl}?role=consumer&streamId=default&version=1`;
const ingestUrl = `${httpBase}/maxjs-relay-in`;

const identity = {
    version: RELAY_PROTOCOL_VERSION,
    streamId: 'default',
    producerId: 'max-smoke',
    sessionId: 'session-1',
};

async function postJson(body) {
    const response = await fetch(ingestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const status = await response.json();
    return { response, status };
}

async function postBinary(body) {
    const response = await fetch(ingestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
    });
    const status = await response.json();
    return { response, status };
}

async function requestStatusWithHost(url, host) {
    return new Promise((resolve, reject) => {
        const request = httpRequest(url, { headers: { host } }, (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
        request.end();
    });
}

async function rawUpgradeStatus(port, host, origin) {
    return new Promise((resolve, reject) => {
        const socket = connectTcp(port, '127.0.0.1');
        let response = '';
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.once('connect', () => {
            socket.write([
                'GET /maxjs-relay?role=consumer&streamId=default&version=1 HTTP/1.1',
                `Host: ${host}`,
                `Origin: ${origin}`,
                'Connection: Upgrade',
                'Upgrade: websocket',
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                '',
                '',
            ].join('\r\n'));
        });
        socket.on('data', (chunk) => {
            response += chunk;
            const match = /^HTTP\/1\.1 (\d{3})/i.exec(response);
            if (!match) return;
            socket.destroy();
            resolve(Number(match[1]));
        });
    });
}

async function producerStatus() {
    return (await postJson({ kind: 'producer_ping', ...identity })).status;
}

function binaryFrame(type, sceneRevision, sequence, payload, sceneRequestId) {
    const relay = { ...identity, sceneRevision, sequence };
    if (sceneRequestId !== undefined) relay.sceneRequestId = sceneRequestId;
    return encodeRelayFrame({ type, relay, nodes: type === 'scene_bin' ? [{ n: 'Cube' }] : undefined }, payload, {
        requireSceneRequestId: true,
        maxMetaBytes: 4096,
        maxPayloadBytes: 4096,
        maxFrameBytes: 8192,
    });
}

let client1 = null;
let client2 = null;
let isolatedClient = null;
let timeoutClient = null;
let hostileApplyClient = null;
let hostileControl = null;
let churnAllowed = null;
let churnDenied = null;
try {
    // PNA preflight and strict producer handshake.
    const preflight = await fetch(ingestUrl, {
        method: 'OPTIONS',
        headers: {
            origin: 'https://maxjs.local',
            'access-control-request-headers': 'accept, content-type',
            'access-control-request-private-network': 'true',
        },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    assert.match(preflight.headers.get('access-control-allow-headers'), /accept/i);
    assert.equal((await fetch(ingestUrl, {
        method: 'OPTIONS',
        headers: { origin: 'null' },
    })).status, 403, 'sandboxed browser origins must not reach producer ingest');

    const deniedOriginStatus = await new Promise((resolve, reject) => {
        const denied = new WebSocket(wsUrl, { origin: 'https://evil.example' });
        denied.once('unexpected-response', (_request, response) => {
            resolve(response.statusCode);
            response.resume();
        });
        denied.once('open', () => reject(new Error('cross-origin relay consumer unexpectedly opened')));
        denied.once('error', () => {});
    });
    assert.equal(deniedOriginStatus, 403);
    const reboundOriginStatus = await rawUpgradeStatus(
        address.port, 'evil.example', 'https://evil.example');
    assert.equal(reboundOriginStatus, 403);

    // Disable may race an in-flight hello. A goodbye that arrives first
    // tombstones that exact session so the late hello cannot take ownership.
    const releasedBeforeHello = {
        ...identity,
        producerId: 'max-racy-disable',
        sessionId: 'released-before-hello',
    };
    assert.equal((await postJson({ kind: 'producer_goodbye', ...releasedBeforeHello })).response.status, 200);
    const lateHello = await postJson({ kind: 'producer_hello', ...releasedBeforeHello });
    assert.equal(lateHello.response.status, 409);
    assert.equal(lateHello.status.error.code, 'producer_session_released');

    const hello = await postJson({ kind: 'producer_hello', ...identity });
    assert.equal(hello.response.status, 200);
    assert.equal(hello.status.version, RELAY_PROTOCOL_VERSION);
    assert.equal(hello.status.streamId, 'default');
    assert.equal(typeof hello.status.relayId, 'string');
    assert.equal(hello.status.needScene, false);

    const order = [];
    let releaseFirstScene;
    const firstSceneGate = new Promise((resolve) => { releaseFirstScene = resolve; });
    let sceneCount = 0;
    client1 = new RelayClient({
        url: wsUrl,
        streamId: 'default',
        webSocketFactory: (url) => new WebSocket(url),
        reconnectMinMs: 50,
        reconnectMaxMs: 100,
        onScene: async (frame) => {
            sceneCount += 1;
            order.push(`scene${frame.relay.sceneRevision}:start`);
            if (sceneCount === 1) await firstSceneGate;
            order.push(`scene${frame.relay.sceneRevision}:end`);
        },
        onFrame: async (frame) => {
            order.push(`frame${frame.relay.sceneRevision}:${frame.relay.sequence}`);
        },
        onMessage: async (_data, envelope) => {
            order.push(`msg${envelope.relay.sceneRevision}:${envelope.relay.sequence}`);
        },
    });

    const request1 = await waitFor(async () => {
        const status = await producerStatus();
        return status.needScene ? status.sceneRequestId : 0;
    }, 'first fresh-scene request');

    const baseline1 = binaryFrame('scene_bin', 1, 0, Uint8Array.from([11]), request1);
    assert.equal((await postBinary(baseline1)).response.status, 200);
    assert.equal((await postBinary(binaryFrame('delta_bin', 1, 1, Uint8Array.from([12])))).response.status, 200);
    assert.equal((await postJson({
        kind: 'msg',
        relay: { ...identity, sceneRevision: 1, sequence: 2 },
        data: { type: 'env_update' },
    })).response.status, 200);

    await waitFor(() => order.includes('scene1:start'), 'async scene callback start');
    assert.equal((await producerStatus()).readyConsumers, 0, 'baseline_ready must wait for scene callback');
    releaseFirstScene();
    await waitFor(() => order.includes('msg1:2'), 'ordered continuation callbacks');
    assert.deepEqual(order.slice(0, 4), ['scene1:start', 'scene1:end', 'frame1:1', 'msg1:2']);
    await waitFor(async () => (await producerStatus()).readyConsumers === 1, 'first ready consumer');
    const readyBeforeLateReleasedHello = await producerStatus();
    const delayedReleasedHello = await postJson({ kind: 'producer_hello', ...releasedBeforeHello });
    assert.equal(delayedReleasedHello.response.status, 409);
    assert.equal(delayedReleasedHello.status.needScene, false);
    const readyAfterLateReleasedHello = await producerStatus();
    assert.equal(readyAfterLateReleasedHello.sceneRequestId,
        readyBeforeLateReleasedHello.sceneRequestId);
    assert.equal(readyAfterLateReleasedHello.readyConsumers,
        readyBeforeLateReleasedHello.readyConsumers);

    // A late join gets no cached baseline. It forces a new scene from the producer.
    const client2Scenes = [];
    client2 = new RelayClient({
        url: wsUrl,
        streamId: 'default',
        webSocketFactory: (url) => new WebSocket(url),
        reconnectMinMs: 50,
        reconnectMaxMs: 100,
        onScene: async (frame) => { client2Scenes.push(frame.relay.sceneRevision); },
    });
    const request2 = await waitFor(async () => {
        const status = await producerStatus();
        return status.needScene && status.sceneRequestId > request1 ? status.sceneRequestId : 0;
    }, 'late-join fresh-scene request');
    await delay(75);
    assert.deepEqual(client2Scenes, [], 'broker must never replay an old cached scene');
    assert.equal((await producerStatus()).readyConsumers, 0);

    // Malformed control values close only their socket; they cannot throw out
    // of the ws EventEmitter and terminate the Vite process.
    hostileControl = new WebSocket(rawConsumerUrl);
    await new Promise((resolve, reject) => {
        hostileControl.once('open', resolve);
        hostileControl.once('error', reject);
    });
    const hostileClose = new Promise((resolve) => {
        hostileControl.once('close', (code) => resolve(code));
    });
    hostileControl.send(JSON.stringify({
        kind: 'resync_request',
        version: RELAY_PROTOCOL_VERSION,
        streamId: 'default',
        reason: { toString: 1, valueOf: 2 },
    }));
    assert.equal(await hostileClose, 1008);
    assert.equal((await producerStatus()).streamId, 'default');

    const baseline2Result = await postBinary(binaryFrame('scene_bin', 2, 0, Uint8Array.from([21]), request2));
    assert.equal(baseline2Result.response.status, 200, JSON.stringify(baseline2Result.status));
    await waitFor(async () => (await producerStatus()).readyConsumers === 2, 'both consumers ready on fresh baseline');
    assert.deepEqual(client2Scenes, [2]);
    assert.equal((await postBinary(binaryFrame('delta_bin', 2, 1, Uint8Array.from([22])))).response.status, 200);

    // A producer sequence gap is rejected, invalidates readiness, and asks for a new scene.
    const gap = await postBinary(binaryFrame('delta_bin', 2, 3, Uint8Array.from([99])));
    assert.equal(gap.response.status, 409);
    assert.equal(gap.status.error.code, 'sequence_gap');
    assert.equal(gap.status.needScene, true);
    assert.equal(gap.status.readyConsumers, 0);
    const request3 = gap.status.sceneRequestId;
    assert.equal((await postBinary(binaryFrame('scene_bin', 3, 0, Uint8Array.from([31]), request3))).response.status, 200);
    await waitFor(async () => (await producerStatus()).readyConsumers === 2, 'gap recovery baseline');
    assert.deepEqual(client2Scenes, [2, 3]);

    // Multiple consumers asking while one baseline is pending coalesce to one
    // request id instead of amplifying into repeated full-scene extraction.
    client1.requestResync('coalesce-a');
    const request4 = await waitFor(async () => {
        const status = await producerStatus();
        return status.needScene && status.sceneRequestId > request3 ? status.sceneRequestId : 0;
    }, 'coalesced consumer request');
    client1.requestResync('coalesce-b');
    client2.requestResync('coalesce-c');
    await delay(50);
    assert.equal((await producerStatus()).sceneRequestId, request4);
    assert.equal((await postBinary(binaryFrame('scene_bin', 4, 0, Uint8Array.from([41]), request4))).response.status, 200);
    await waitFor(async () => (await producerStatus()).readyConsumers === 2, 'coalesced recovery baseline');

    // Reconnecting consumers share a per-stream resync budget. Closing and
    // reopening a socket cannot bypass the full-scene extraction limit.
    churnAllowed = new WebSocket(rawConsumerUrl);
    await new Promise((resolve, reject) => {
        churnAllowed.once('open', resolve);
        churnAllowed.once('error', reject);
    });
    const request5 = await waitFor(async () => {
        const status = await producerStatus();
        return status.needScene && status.sceneRequestId > request4 ? status.sceneRequestId : 0;
    }, 'last allowed stream resync');
    assert.equal((await postBinary(binaryFrame('scene_bin', 5, 0, Uint8Array.from([51]), request5))).response.status, 200);
    await waitFor(async () => !(await producerStatus()).needScene, 'last allowed baseline');
    await new Promise((resolve) => {
        churnAllowed.once('close', resolve);
        churnAllowed.close(1000);
    });
    const requestBeforeDeniedChurn = (await producerStatus()).sceneRequestId;
    churnDenied = new WebSocket(rawConsumerUrl);
    const churnDeniedCode = await new Promise((resolve, reject) => {
        churnDenied.once('close', (code) => resolve(code));
        churnDenied.once('error', (error) => reject(error));
    });
    assert.equal(churnDeniedCode, 1008);
    assert.equal((await producerStatus()).sceneRequestId, requestBeforeDeniedChurn);

    // Request and body limits fail before buffering an unbounded producer body.
    const oversizedJson = await fetch(ingestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(2048) }),
    });
    assert.equal(oversizedJson.status, 413);
    const oversizedBinary = await fetch(ingestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(9000),
    });
    assert.equal(oversizedBinary.status, 413);

    // Asset proxy serves only explicit roots/extensions and blocks traversal.
    const inside = await fetch(`${httpBase}/maxjs-assets/inside.png`);
    assert.equal(inside.status, 200);
    assert.deepEqual(new Uint8Array(await inside.arrayBuffer()), Uint8Array.from([1, 2, 3]));
    assert.equal(await requestStatusWithHost(`${httpBase}/maxjs-assets/inside.png`, 'evil.example'), 403);
    assert.equal((await fetch(`${httpBase}/maxjs-assets/inside.txt`)).status, 404);
    assert.equal((await fetch(`${httpBase}/maxjs-assets/..%2Foutside.png`)).status, 404);
    assert.equal((await fetch(`${httpBase}/maxjs-assets/${encodeURIComponent(outsideFile)}`)).status, 404);

    // Intentional producer shutdown releases the stream immediately; switching
    // from Max to Blender never waits for the fallback lease timeout.
    assert.equal((await postJson({ kind: 'producer_goodbye', ...identity })).response.status, 200);
    const replacement = {
        ...identity,
        producerId: 'blender-smoke',
        sessionId: 'session-2',
    };
    const replacementHello = await postJson({ kind: 'producer_hello', ...replacement });
    assert.equal(replacementHello.response.status, 200);
    assert.equal(replacementHello.status.producerId, replacement.producerId);
    assert.equal(replacementHello.status.needScene, true);

    client1.dispose();
    client2.dispose();

    // Client-side sequence validation also requests resync if a broker sends a gap.
    class FakeSocket {
        constructor() { this.readyState = 0; this.sent = []; }
        send(value) { this.sent.push(JSON.parse(value)); }
        close() { this.readyState = 3; }
        open() { this.readyState = 1; this.onopen?.({}); }
        message(data) { this.onmessage?.({ data }); }
    }
    const fakeSocket = new FakeSocket();
    isolatedClient = new RelayClient({
        url: 'ws://127.0.0.1/maxjs-relay',
        autoConnect: false,
        webSocketFactory: () => fakeSocket,
        onScene: async () => {},
    });
    isolatedClient.connect();
    fakeSocket.open();
    fakeSocket.message(JSON.stringify({
        kind: 'relay_hello', version: 1, relayId: 'relay-smoke', streamId: 'default',
    }));
    fakeSocket.message(binaryFrame('scene_bin', 1, 0, Uint8Array.from([1]), 1));
    await waitFor(() => isolatedClient.status.ready, 'isolated client baseline');
    fakeSocket.message(binaryFrame('delta_bin', 1, 2, Uint8Array.from([2])));
    await waitFor(() => fakeSocket.sent.some((item) => item.kind === 'resync_request' && item.reason === 'sequence_gap'), 'client sequence-gap resync');
    isolatedClient.dispose();

    // Application callbacks are bounded and receive an AbortSignal. A consumer
    // that never settles cannot wedge the receive queue forever.
    const timeoutSocket = new FakeSocket();
    let callbackSignal = null;
    timeoutClient = new RelayClient({
        url: 'ws://127.0.0.1/maxjs-relay',
        autoConnect: false,
        callbackTimeoutMs: 20,
        webSocketFactory: () => timeoutSocket,
        onScene: async (_frame, context) => {
            callbackSignal = context.signal;
            await new Promise(() => {});
        },
    });
    timeoutClient.connect();
    timeoutSocket.open();
    timeoutSocket.message(JSON.stringify({
        kind: 'relay_hello', version: 1, relayId: 'relay-timeout', streamId: 'default',
    }));
    timeoutSocket.message(binaryFrame('scene_bin', 10, 0, Uint8Array.from([10]), 10));
    await waitFor(() => timeoutSocket.sent.some(
        (item) => item.kind === 'resync_request' && item.reason === 'callback_timeout'),
    'callback deadline resync');
    assert.equal(callbackSignal?.aborted, true);
    timeoutClient.dispose();

    // Non-Error callback rejections are formatted without coercion crashes;
    // the ordered drain requests recovery and accepts the next baseline.
    const hostileApplySocket = new FakeSocket();
    let hostileApplyCalls = 0;
    hostileApplyClient = new RelayClient({
        url: 'ws://127.0.0.1/maxjs-relay',
        autoConnect: false,
        webSocketFactory: () => hostileApplySocket,
        onScene: async () => {
            hostileApplyCalls += 1;
            if (hostileApplyCalls === 1) {
                throw { toString: 1, valueOf: 2 };
            }
        },
    });
    assert.equal(hostileApplyClient.maxQueueBytes, RELAY_FRAME_LIMITS.maxFrameBytes * 2);
    hostileApplyClient.connect();
    hostileApplySocket.open();
    hostileApplySocket.message(JSON.stringify({
        kind: 'relay_hello', version: 1, relayId: 'relay-hostile-apply', streamId: 'default',
    }));
    hostileApplySocket.message(binaryFrame('scene_bin', 20, 0, Uint8Array.from([20]), 20));
    await waitFor(() => hostileApplySocket.sent.some(
        (item) => item.kind === 'resync_request' && item.reason === 'consumer_apply_error'),
    'hostile callback rejection recovery');
    assert.equal(hostileApplyClient.status.lastError, 'unprintable relay error');
    hostileApplySocket.message(binaryFrame('scene_bin', 21, 0, Uint8Array.from([21]), 21));
    await waitFor(() => hostileApplySocket.sent.some(
        (item) => item.kind === 'baseline_ready' && item.sceneRevision === 21),
    'post-error baseline acknowledgement');
    assert.equal(hostileApplyClient.status.ready, true);
    hostileApplyClient.dispose();

    console.log('relay transport smoke: OK');
} finally {
    client1?.dispose();
    client2?.dispose();
    isolatedClient?.dispose();
    timeoutClient?.dispose();
    hostileApplyClient?.dispose();
    try { hostileControl?.close(); } catch { /* already closed */ }
    try { churnAllowed?.close(); } catch { /* already closed */ }
    try { churnDenied?.close(); } catch { /* already closed */ }
    watcher.emit('close');
    await new Promise((resolve) => httpServer.close(resolve));
    await rm(temp, { recursive: true, force: true });
}
