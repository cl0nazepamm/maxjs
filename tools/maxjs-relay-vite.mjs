import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
    RELAY_FRAME_LIMITS,
    RELAY_PROTOCOL_VERSION,
    RelayProtocolError,
    assertRelayMetadata,
    decodeRelayFrame,
    isSceneFrame,
} from '../web/js/relay_frame.mjs';

// Resolve the server dependency from the receiving Vite project, even when
// this plugin is imported from a sibling max.js checkout.
const requireFromProject = createRequire(path.join(process.cwd(), 'package.json'));
const { WebSocket, WebSocketServer } = requireFromProject('ws');

// Producers use CORS/PNA-capable HTTP POST; same-origin project consumers use
// WebSocket. The ingest endpoint is claimed at the HTTP-server listener level
// so Vite's own CORS middleware cannot answer the private-network preflight
// first. Everything remains on the project's existing loopback dev server.

export const DEFAULT_RELAY_STREAM_ID = 'default';
export const DEFAULT_RELAY_INGEST_PATH = '/maxjs-relay-in';
export const DEFAULT_RELAY_CONSUMER_PATH = '/maxjs-relay';

const DEFAULT_ASSET_PATH = '/maxjs-assets/';
const MIME_TYPES = Object.freeze({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.ktx2': 'image/ktx2',
    '.dds': 'application/octet-stream',
    '.tga': 'application/octet-stream',
    '.hdr': 'application/octet-stream',
    '.exr': 'application/octet-stream',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
});

function protocolError(code, message) {
    throw new RelayProtocolError(code, message);
}

function positiveInteger(value, fallback, name, { allowZero = false } = {}) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || (allowZero ? resolved < 0 : resolved <= 0)) {
        throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
    }
    return resolved;
}

function normalizePath(value, fallback, trailingSlash = false) {
    const result = value ?? fallback;
    if (typeof result !== 'string' || !result.startsWith('/') || result.includes('?') || result.includes('#')) {
        throw new TypeError('relay endpoint paths must be absolute URL paths');
    }
    if (trailingSlash && !result.endsWith('/')) return `${result}/`;
    return result;
}

function relayIdentity(value) {
    const relay = {
        version: value?.version,
        streamId: value?.streamId,
        producerId: value?.producerId,
        sessionId: value?.sessionId,
        sceneRevision: value?.sceneRevision ?? 0,
        sequence: value?.sequence ?? 0,
    };
    return assertRelayMetadata({ relay });
}

function isLoopbackAddress(address) {
    if (!address) return false;
    const normalized = address.toLowerCase().split('%')[0];
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized.startsWith('127.');
}

function assertLoopbackViteHost(host) {
    if (host === undefined || host === false || host === 'localhost' || host === '127.0.0.1' || host === '::1') return;
    throw new Error('max.js relay requires Vite server.host to be loopback (127.0.0.1, ::1, or localhost)');
}

function isIpv4LoopbackHostname(hostname) {
    const parts = String(hostname ?? '').split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isTrustedBrowserHostname(hostname) {
    const normalized = String(hostname ?? '').toLowerCase();
    return normalized === 'maxjs.local'
        || normalized === 'localhost'
        || normalized === 'localhost.'
        || normalized === '127.0.0.1'
        || normalized === '[::1]'
        || normalized === '::1'
        || isIpv4LoopbackHostname(normalized);
}

function loopbackHostAllowed(host) {
    if (typeof host !== 'string' || !host) return false;
    try {
        const url = new URL(`http://${host}`);
        const normalized = url.hostname.toLowerCase();
        return normalized === 'localhost'
            || normalized === 'localhost.'
            || normalized === '[::1]'
            || normalized === '::1'
            || normalized === '127.0.0.1'
            || isIpv4LoopbackHostname(normalized);
    } catch {
        return false;
    }
}

function originAllowed(origin, additionalOrigins) {
    if (!origin) return true;
    if (origin === 'null') return false;
    if (additionalOrigins.has(origin)) return true;
    try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && isTrustedBrowserHostname(url.hostname);
    } catch {
        return false;
    }
}

function consumerOriginAllowed(request, additionalOrigins) {
    const origin = request.headers.origin;
    if (!origin) return true; // native/test clients do not send browser Origin
    if (origin === 'null' || !request.headers.host) return false;
    if (additionalOrigins.has(origin)) return true;
    try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && isTrustedBrowserHostname(url.hostname)
            && url.host.toLowerCase() === String(request.headers.host).toLowerCase();
    } catch {
        return false;
    }
}

function corsHeaders(request, additionalOrigins) {
    const origin = request.headers.origin;
    if (!originAllowed(origin, additionalOrigins)) return null;
    return {
        'access-control-allow-origin': origin || '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'accept, content-type',
        'access-control-allow-private-network': 'true',
        vary: 'Origin',
        'cache-control': 'no-store',
    };
}

function writeJson(response, statusCode, body, headers = {}) {
    if (response.writableEnded) return;
    const text = JSON.stringify(body);
    response.writeHead(statusCode, {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
    });
    response.end(text);
}

function rejectUpgrade(socket, statusCode, reason) {
    if (!socket.destroyed) {
        socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
    }
}

function makeAssetProxy(options) {
    if (!options) return null;
    if (!Array.isArray(options.roots) || options.roots.length === 0) {
        throw new TypeError('assetProxy.roots must explicitly list at least one directory');
    }
    if (!Array.isArray(options.extensions) || options.extensions.length === 0) {
        throw new TypeError('assetProxy.extensions must explicitly list allowed extensions');
    }
    const roots = options.roots.map((root) => {
        if (typeof root !== 'string' || !path.isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) {
            throw new TypeError(`assetProxy root must be an existing absolute directory: ${root}`);
        }
        return realpathSync(root);
    });
    const extensions = new Set(options.extensions.map((extension) => {
        if (typeof extension !== 'string' || !/^\.[a-z0-9]+$/i.test(extension)) {
            throw new TypeError(`invalid assetProxy extension: ${extension}`);
        }
        return extension.toLowerCase();
    }));
    const route = normalizePath(options.path, DEFAULT_ASSET_PATH, true);
    const maxBytes = positiveInteger(options.maxBytes, 256 * 1024 * 1024, 'assetProxy.maxBytes');
    return { roots, extensions, route, maxBytes };
}

function containedBy(filePath, root) {
    const relative = path.relative(root, filePath);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveAsset(proxy, encodedPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(encodedPath);
    } catch {
        protocolError('invalid_asset_path', 'asset path is not valid URL encoding');
    }
    if (decoded.includes('\0')) protocolError('invalid_asset_path', 'asset path contains a null byte');
    const extension = path.extname(decoded).toLowerCase();
    if (!proxy.extensions.has(extension)) protocolError('asset_extension_denied', 'asset extension is not allowed');

    const candidates = path.isAbsolute(decoded)
        ? [path.normalize(decoded)]
        : proxy.roots.map((root) => path.resolve(root, decoded));
    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        let real;
        try { real = realpathSync(candidate); } catch { continue; }
        if (!proxy.roots.some((root) => containedBy(real, root))) continue;
        if (path.extname(real).toLowerCase() !== extension) continue;
        const stat = statSync(real);
        if (!stat.isFile() || stat.size > proxy.maxBytes) continue;
        return { filePath: real, size: stat.size, extension };
    }
    return null;
}

function serveAsset(request, response, proxy) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return;
    }
    const url = new URL(request.url ?? '/', 'http://relay.local');
    const encodedPath = url.pathname.slice(proxy.route.length);
    let asset;
    try { asset = resolveAsset(proxy, encodedPath); } catch { asset = null; }
    if (!asset) {
        response.writeHead(404, { 'cache-control': 'no-store' });
        response.end();
        return;
    }
    response.writeHead(200, {
        'content-type': MIME_TYPES[asset.extension] ?? 'application/octet-stream',
        'content-length': asset.size,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
    });
    if (request.method === 'HEAD') {
        response.end();
        return;
    }
    const input = createReadStream(asset.filePath);
    input.on('error', () => {
        if (!response.headersSent) response.writeHead(500);
        response.destroy();
    });
    input.pipe(response);
}

function createConsumer(socket, streamId, limits) {
    return {
        socket,
        streamId,
        ready: false,
        baselineSent: false,
        producerId: null,
        sessionId: null,
        sceneRevision: null,
        sceneRequestId: null,
        queue: [],
        queueBytes: 0,
        sending: false,
        resyncWindowStarted: 0,
        resyncRequests: 0,
        limits,
    };
}

function payloadSize(data) {
    return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
}

/** Reusable Vite relay plugin; one registration may allow one or more named streams. */
export function maxjsRelay(options = {}) {
    const primaryStreamId = options.streamId ?? DEFAULT_RELAY_STREAM_ID;
    relayIdentity({
        version: RELAY_PROTOCOL_VERSION,
        streamId: primaryStreamId,
        producerId: 'registration',
        sessionId: 'registration',
    });
    const allowedStreams = new Set(options.allowedStreams ?? [primaryStreamId]);
    allowedStreams.add(primaryStreamId);
    for (const streamId of allowedStreams) {
        relayIdentity({
            version: RELAY_PROTOCOL_VERSION,
            streamId,
            producerId: 'registration',
            sessionId: 'registration',
        });
    }

    const ingestPath = normalizePath(options.ingestPath, DEFAULT_RELAY_INGEST_PATH);
    const consumerPath = normalizePath(options.consumerPath, DEFAULT_RELAY_CONSUMER_PATH);
    const assetProxy = makeAssetProxy(options.assetProxy);
    const additionalOrigins = new Set(options.allowedOrigins ?? []);
    const limits = Object.freeze({
        maxJsonBytes: positiveInteger(options.limits?.maxJsonBytes, 16 * 1024 * 1024, 'limits.maxJsonBytes'),
        maxMetaBytes: positiveInteger(options.limits?.maxMetaBytes, RELAY_FRAME_LIMITS.maxMetaBytes, 'limits.maxMetaBytes'),
        maxPayloadBytes: positiveInteger(options.limits?.maxPayloadBytes, RELAY_FRAME_LIMITS.maxPayloadBytes, 'limits.maxPayloadBytes'),
        maxFrameBytes: positiveInteger(options.limits?.maxFrameBytes, RELAY_FRAME_LIMITS.maxFrameBytes, 'limits.maxFrameBytes'),
        maxConcurrentRequests: positiveInteger(options.limits?.maxConcurrentRequests, 4, 'limits.maxConcurrentRequests'),
        maxConsumerQueueFrames: positiveInteger(options.limits?.maxConsumerQueueFrames, 128, 'limits.maxConsumerQueueFrames'),
        maxConsumerQueueBytes: positiveInteger(options.limits?.maxConsumerQueueBytes, RELAY_FRAME_LIMITS.maxFrameBytes, 'limits.maxConsumerQueueBytes'),
        requestTimeoutMs: positiveInteger(options.limits?.requestTimeoutMs, 15_000, 'limits.requestTimeoutMs'),
        maxControlBytes: positiveInteger(options.limits?.maxControlBytes, 64 * 1024, 'limits.maxControlBytes'),
        maxConsumers: positiveInteger(options.limits?.maxConsumers, 8, 'limits.maxConsumers'),
        maxResyncRequests: positiveInteger(options.limits?.maxResyncRequests, 8, 'limits.maxResyncRequests'),
        resyncWindowMs: positiveInteger(options.limits?.resyncWindowMs, 5_000, 'limits.resyncWindowMs'),
        maxReleasedSessions: positiveInteger(options.limits?.maxReleasedSessions, 64, 'limits.maxReleasedSessions'),
    });
    const producerLeaseMs = positiveInteger(options.producerLeaseMs, 15_000, 'producerLeaseMs');
    const relayId = randomUUID();

    return {
        name: 'maxjs-relay',
        configureServer(server) {
            assertLoopbackViteHost(server.config.server.host);
            const httpServer = server.httpServer;
            if (!httpServer) throw new Error('max.js relay requires Vite HTTP server');
            const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxControlBytes });
            const streams = new Map();
            let activeRequests = 0;
            let closed = false;

            const log = (message) => server.config.logger?.info?.(`[maxjs-relay] ${message}`, { timestamp: true });
            const streamFor = (streamId) => {
                if (!allowedStreams.has(streamId)) protocolError('unknown_stream', `relay stream is not registered: ${streamId}`);
                let stream = streams.get(streamId);
                if (!stream) {
                    stream = {
                        streamId,
                        producer: null,
                        consumers: new Set(),
                        sceneRequestId: 0,
                        fulfilledSceneRequestId: 0,
                        lastRequestReason: null,
                        resyncWindowStarted: 0,
                        resyncRequests: 0,
                        releasedSessions: new Map(),
                    };
                    streams.set(streamId, stream);
                }
                return stream;
            };

            const producerExpired = (stream) => stream.producer
                && Date.now() - stream.producer.lastSeen > producerLeaseMs;

            const releasedSessionKey = (identity) => `${identity.producerId}\0${identity.sessionId}`;
            const pruneReleasedSessions = (stream) => {
                const now = Date.now();
                for (const [key, expiresAt] of stream.releasedSessions) {
                    if (expiresAt <= now) stream.releasedSessions.delete(key);
                }
            };
            const releaseSession = (stream, identity) => {
                pruneReleasedSessions(stream);
                const key = releasedSessionKey(identity);
                stream.releasedSessions.delete(key);
                stream.releasedSessions.set(key, Date.now() + producerLeaseMs);
                while (stream.releasedSessions.size > limits.maxReleasedSessions) {
                    stream.releasedSessions.delete(stream.releasedSessions.keys().next().value);
                }
            };
            const sessionWasReleased = (stream, identity) => {
                pruneReleasedSessions(stream);
                return stream.releasedSessions.has(releasedSessionKey(identity));
            };

            const readyConsumers = (stream) => {
                const producer = stream.producer;
                if (!producer) return 0;
                let count = 0;
                for (const consumer of stream.consumers) {
                    if (consumer.ready
                        && consumer.producerId === producer.producerId
                        && consumer.sessionId === producer.sessionId
                        && consumer.sceneRevision === producer.sceneRevision) count += 1;
                }
                return count;
            };

            const statusFor = (stream, producer = stream.producer) => ({
                kind: 'relay_status',
                version: RELAY_PROTOCOL_VERSION,
                relayId,
                streamId: stream.streamId,
                producerId: producer?.producerId ?? null,
                sessionId: producer?.sessionId ?? null,
                consumers: stream.consumers.size,
                readyConsumers: readyConsumers(stream),
                needScene: stream.consumers.size > 0 && stream.sceneRequestId > stream.fulfilledSceneRequestId,
                sceneRequestId: stream.sceneRequestId,
                sceneRevision: producer?.sceneRevision ?? 0,
            });

            const closeSlowConsumer = (consumer) => {
                consumer.queue.length = 0;
                consumer.queueBytes = 0;
                try { consumer.socket.close(1013, 'relay consumer queue overflow'); } catch { consumer.socket.terminate(); }
            };

            const drainConsumer = (consumer) => {
                if (consumer.sending || consumer.socket.readyState !== WebSocket.OPEN) return;
                const item = consumer.queue.shift();
                if (!item) return;
                consumer.queueBytes -= item.bytes;
                consumer.sending = true;
                consumer.socket.send(item.data, { binary: item.binary }, (error) => {
                    consumer.sending = false;
                    if (error) {
                        try { consumer.socket.terminate(); } catch { /* already closed */ }
                        return;
                    }
                    drainConsumer(consumer);
                });
            };

            const sendConsumer = (consumer, value, binary = false) => {
                if (consumer.socket.readyState !== WebSocket.OPEN) return false;
                const data = binary ? value : (typeof value === 'string' ? value : JSON.stringify(value));
                const bytes = payloadSize(data);
                if (consumer.queue.length + 1 > limits.maxConsumerQueueFrames
                    || consumer.queueBytes + bytes > limits.maxConsumerQueueBytes) {
                    closeSlowConsumer(consumer);
                    return false;
                }
                consumer.queue.push({ data, binary, bytes });
                consumer.queueBytes += bytes;
                drainConsumer(consumer);
                return true;
            };

            const allowStreamResync = (stream) => {
                const now = Date.now();
                if (!stream.resyncWindowStarted
                    || now - stream.resyncWindowStarted >= limits.resyncWindowMs) {
                    stream.resyncWindowStarted = now;
                    stream.resyncRequests = 0;
                }
                stream.resyncRequests += 1;
                return stream.resyncRequests <= limits.maxResyncRequests;
            };

            const requireFreshScene = (stream, reason, { rateLimit = false } = {}) => {
                const alreadyPending = stream.sceneRequestId > stream.fulfilledSceneRequestId;
                // One authoritative baseline satisfies every consumer currently
                // attached. Never amplify joins/errors while that request is live.
                if (alreadyPending) return stream.sceneRequestId;
                if (rateLimit && !allowStreamResync(stream)) return null;
                stream.sceneRequestId += 1;
                stream.lastRequestReason = reason;
                for (const consumer of stream.consumers) {
                    consumer.ready = false;
                    consumer.baselineSent = false;
                    sendConsumer(consumer, {
                        kind: 'resync_required',
                        version: RELAY_PROTOCOL_VERSION,
                        relayId,
                        streamId: stream.streamId,
                        sceneRequestId: stream.sceneRequestId,
                        reason,
                    });
                }
                return stream.sceneRequestId;
            };

            const allowConsumerResync = (consumer) => {
                const now = Date.now();
                if (!consumer.resyncWindowStarted
                    || now - consumer.resyncWindowStarted >= limits.resyncWindowMs) {
                    consumer.resyncWindowStarted = now;
                    consumer.resyncRequests = 0;
                }
                consumer.resyncRequests += 1;
                if (consumer.resyncRequests <= limits.maxResyncRequests) return true;
                consumer.socket.close(1008, 'too many relay resync requests');
                return false;
            };

            const expireProducerIfNeeded = (stream) => {
                if (!producerExpired(stream)) return false;
                stream.producer = null;
                requireFreshScene(stream, 'producer_timeout');
                return true;
            };

            const assertActiveProducer = (stream, relay) => {
                expireProducerIfNeeded(stream);
                const producer = stream.producer;
                if (!producer) protocolError('producer_not_registered', 'producer must complete producer_hello first');
                if (relay.producerId !== producer.producerId || relay.sessionId !== producer.sessionId) {
                    protocolError('producer_identity_mismatch', 'producer identity does not match the active handshake');
                }
                producer.lastSeen = Date.now();
                return producer;
            };

            const broadcastScene = (stream, data, binary, relay) => {
                for (const consumer of stream.consumers) {
                    consumer.ready = false;
                    consumer.baselineSent = sendConsumer(consumer, data, binary);
                    consumer.producerId = relay.producerId;
                    consumer.sessionId = relay.sessionId;
                    consumer.sceneRevision = relay.sceneRevision;
                    consumer.sceneRequestId = relay.sceneRequestId;
                }
            };

            const broadcastContinuation = (stream, data, binary) => {
                for (const consumer of stream.consumers) {
                    if (consumer.baselineSent) sendConsumer(consumer, data, binary);
                }
            };

            const acceptScene = (stream, producer, relay, data, binary) => {
                if (relay.sequence !== 0) protocolError('invalid_scene_sequence', 'full-scene sequence must be zero');
                if (!Number.isSafeInteger(relay.sceneRequestId) || relay.sceneRequestId < 0) {
                    protocolError('missing_scene_request', 'full-scene frame must echo relay.sceneRequestId');
                }
                if (relay.sceneRequestId !== stream.sceneRequestId) {
                    protocolError('stale_scene_request', 'full-scene frame must echo the current scene request id');
                }
                if (producer.sceneRevision !== null && relay.sceneRevision <= producer.sceneRevision) {
                    protocolError('stale_scene_revision', 'full-scene revision must advance');
                }
                producer.sceneRevision = relay.sceneRevision;
                producer.expectedSequence = 1;
                stream.fulfilledSceneRequestId = Math.max(stream.fulfilledSceneRequestId, relay.sceneRequestId);
                broadcastScene(stream, data, binary, relay);
            };

            const acceptContinuation = (stream, producer, relay, data, binary) => {
                if (producer.sceneRevision === null || producer.expectedSequence === null) {
                    protocolError('baseline_missing', 'producer continuation arrived before a full scene');
                }
                if (relay.sceneRevision !== producer.sceneRevision) {
                    protocolError('revision_mismatch', 'producer continuation revision does not match baseline');
                }
                if (relay.sequence !== producer.expectedSequence) {
                    protocolError('sequence_gap', `expected producer sequence ${producer.expectedSequence}, got ${relay.sequence}`);
                }
                producer.expectedSequence += 1;
                broadcastContinuation(stream, data, binary);
            };

            const handleProducerHello = (body) => {
                const identity = relayIdentity(body);
                const stream = streamFor(identity.streamId);
                if (sessionWasReleased(stream, identity)) {
                    const error = new RelayProtocolError(
                        'producer_session_released',
                        'producer session was already released; enable relay with a new session',
                    );
                    error.relayStream = stream;
                    throw error;
                }
                expireProducerIfNeeded(stream);
                const active = stream.producer;
                if (active && active.producerId !== identity.producerId) {
                    protocolError('producer_conflict', 'another producer currently owns this stream');
                }
                const sameSession = active
                    && active.producerId === identity.producerId
                    && active.sessionId === identity.sessionId;
                if (!sameSession) {
                    stream.producer = {
                        producerId: identity.producerId,
                        sessionId: identity.sessionId,
                        sceneRevision: null,
                        expectedSequence: null,
                        lastSeen: Date.now(),
                    };
                    if (stream.consumers.size > 0) requireFreshScene(stream, active ? 'producer_restart' : 'producer_connected');
                    log(`${identity.producerId} owns stream ${identity.streamId}`);
                } else {
                    active.lastSeen = Date.now();
                }
                return stream;
            };

            const handleJson = (body, rawText) => {
                if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.kind !== 'string') {
                    protocolError('invalid_control', 'producer JSON body must be a control object');
                }
                if (body.kind === 'producer_hello') return handleProducerHello(body);
                if (body.kind === 'producer_ping') {
                    const identity = relayIdentity(body);
                    const stream = streamFor(identity.streamId);
                    assertActiveProducer(stream, identity);
                    return stream;
                }
                if (body.kind === 'producer_goodbye') {
                    const identity = relayIdentity(body);
                    const stream = streamFor(identity.streamId);
                    releaseSession(stream, identity);
                    const active = stream.producer;
                    if (active
                        && active.producerId === identity.producerId
                        && active.sessionId === identity.sessionId) {
                        stream.producer = null;
                        requireFreshScene(stream, 'producer_disconnected');
                        log(`${identity.producerId} released stream ${identity.streamId}`);
                    }
                    return stream;
                }
                if (body.kind !== 'msg' && body.kind !== 'scene') {
                    protocolError('invalid_control_kind', `unsupported producer control kind: ${body.kind}`);
                }
                const relay = assertRelayMetadata({ relay: body.relay });
                const stream = streamFor(relay.streamId);
                const producer = assertActiveProducer(stream, relay);
                try {
                    if (body.kind === 'scene') acceptScene(stream, producer, relay, rawText, false);
                    else acceptContinuation(stream, producer, relay, rawText, false);
                } catch (error) {
                    error.relayStream = stream;
                    throw error;
                }
                return stream;
            };

            const handleBinary = (data) => {
                const decoded = decodeRelayFrame(data, {
                    copyPayload: false,
                    requireSceneRequestId: true,
                    maxMetaBytes: limits.maxMetaBytes,
                    maxPayloadBytes: limits.maxPayloadBytes,
                    maxFrameBytes: limits.maxFrameBytes,
                });
                const stream = streamFor(decoded.relay.streamId);
                const producer = assertActiveProducer(stream, decoded.relay);
                try {
                    if (isSceneFrame(decoded.meta)) acceptScene(stream, producer, decoded.relay, data, true);
                    else acceptContinuation(stream, producer, decoded.relay, data, true);
                } catch (error) {
                    error.relayStream = stream;
                    throw error;
                }
                return stream;
            };

            const errorStatus = (error, stream = null) => ({
                kind: 'relay_status',
                version: RELAY_PROTOCOL_VERSION,
                relayId,
                streamId: stream?.streamId ?? null,
                producerId: stream?.producer?.producerId ?? null,
                sessionId: stream?.producer?.sessionId ?? null,
                consumers: stream?.consumers.size ?? 0,
                readyConsumers: stream ? readyConsumers(stream) : 0,
                needScene: stream
                    ? stream.consumers.size > 0
                        && stream.sceneRequestId > stream.fulfilledSceneRequestId
                    : false,
                sceneRequestId: stream?.sceneRequestId ?? 0,
                sceneRevision: stream?.producer?.sceneRevision ?? 0,
                error: {
                    code: error instanceof RelayProtocolError ? error.code : 'relay_error',
                    message: error instanceof Error ? error.message : String(error),
                },
            });

            const readRequest = (request, response, maxBytes, headers, onComplete) => {
                const advertised = Number(request.headers['content-length']);
                if (Number.isFinite(advertised) && advertised > maxBytes) {
                    activeRequests -= 1;
                    writeJson(response, 413, errorStatus(new RelayProtocolError('body_too_large', `request exceeds ${maxBytes} bytes`)), headers);
                    request.resume();
                    return;
                }
                let size = 0;
                let finished = false;
                const chunks = [];
                const finish = () => {
                    if (finished) return false;
                    finished = true;
                    activeRequests -= 1;
                    clearTimeout(deadline);
                    return true;
                };
                const deadline = setTimeout(() => {
                    if (!finish()) return;
                    writeJson(response, 408, errorStatus(new RelayProtocolError('request_timeout', 'relay request timed out')), headers);
                    request.resume();
                }, limits.requestTimeoutMs);
                deadline.unref?.();
                request.on('data', (chunk) => {
                    if (finished) return;
                    size += chunk.byteLength;
                    if (size > maxBytes) {
                        finish();
                        chunks.length = 0;
                        writeJson(response, 413, errorStatus(new RelayProtocolError('body_too_large', `request exceeds ${maxBytes} bytes`)), headers);
                        request.resume();
                        return;
                    }
                    chunks.push(chunk);
                });
                request.on('end', () => {
                    if (!finish()) return;
                    onComplete(Buffer.concat(chunks, size));
                });
                request.on('aborted', finish);
                request.on('error', finish);
            };

            const handleIngest = (request, response) => {
                const headers = corsHeaders(request, additionalOrigins);
                if (!headers) {
                    writeJson(response, 403, errorStatus(new RelayProtocolError('origin_denied', 'producer origin is not allowed')));
                    return;
                }
                if (!isLoopbackAddress(request.socket.remoteAddress)
                    || !loopbackHostAllowed(request.headers.host)) {
                    writeJson(response, 403, errorStatus(new RelayProtocolError('remote_denied', 'relay accepts loopback producers only')), headers);
                    return;
                }
                if (request.method === 'OPTIONS') {
                    response.writeHead(204, headers);
                    response.end();
                    return;
                }
                if (request.method !== 'POST') {
                    writeJson(response, 405, errorStatus(new RelayProtocolError('method_not_allowed', 'relay ingest requires POST')), { ...headers, allow: 'POST, OPTIONS' });
                    return;
                }
                if (activeRequests >= limits.maxConcurrentRequests) {
                    writeJson(response, 503, errorStatus(new RelayProtocolError('request_limit', 'too many concurrent relay requests')), { ...headers, 'retry-after': '1' });
                    request.resume();
                    return;
                }
                const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
                const isJson = contentType === 'application/json';
                if (!isJson && contentType !== 'application/octet-stream') {
                    writeJson(response, 415, errorStatus(new RelayProtocolError('unsupported_media_type', 'use application/json or application/octet-stream')), headers);
                    request.resume();
                    return;
                }
                activeRequests += 1;
                readRequest(request, response, isJson ? limits.maxJsonBytes : limits.maxFrameBytes, headers, (data) => {
                    let stream = null;
                    try {
                        if (isJson) {
                            const text = data.toString('utf8');
                            let body;
                            try { body = JSON.parse(text); } catch { protocolError('invalid_control_json', 'producer JSON body is malformed'); }
                            stream = handleJson(body, text);
                        } else {
                            stream = handleBinary(data);
                        }
                        writeJson(response, 200, statusFor(stream), headers);
                    } catch (error) {
                        stream = error?.relayStream ?? stream;
                        const statusOnlyError = error?.code === 'producer_conflict'
                            || error?.code === 'producer_identity_mismatch'
                            || error?.code === 'producer_session_released';
                        if (stream && !statusOnlyError) {
                            requireFreshScene(stream, error?.code ?? 'producer_error');
                        }
                        const conflict = error?.code === 'producer_conflict'
                            || error?.code === 'producer_identity_mismatch'
                            || error?.code === 'producer_session_released';
                        const recoveryConflict = ['sequence_gap', 'revision_mismatch', 'baseline_missing', 'stale_scene_request', 'stale_scene_revision'].includes(error?.code);
                        const statusCode = conflict || recoveryConflict ? 409 : (error?.code === 'unknown_stream' ? 404 : 400);
                        writeJson(response, statusCode, errorStatus(error, stream), headers);
                    }
                });
            };

            const registerConsumer = (socket, stream) => {
                const consumer = createConsumer(socket, stream.streamId, limits);
                stream.consumers.add(consumer);
                socket.on('close', () => {
                    stream.consumers.delete(consumer);
                    consumer.queue.length = 0;
                    consumer.queueBytes = 0;
                });
                socket.on('error', () => { /* close performs cleanup */ });
                sendConsumer(consumer, {
                    kind: 'relay_hello',
                    version: RELAY_PROTOCOL_VERSION,
                    relayId,
                    streamId: stream.streamId,
                    sceneRequestId: stream.sceneRequestId,
                });
                if (requireFreshScene(stream, 'consumer_join', { rateLimit: true }) === null) {
                    stream.consumers.delete(consumer);
                    socket.close(1008, 'too many relay resync requests for stream');
                    return;
                }
                log(`consumer joined ${stream.streamId} (${stream.consumers.size})`);

                const handleConsumerMessage = (data, isBinary) => {
                    if (isBinary || data.byteLength > limits.maxControlBytes) {
                        socket.close(1008, 'control frames must be bounded JSON');
                        return;
                    }
                    let body;
                    try { body = JSON.parse(data.toString('utf8')); } catch {
                        socket.close(1008, 'malformed relay control');
                        return;
                    }
                    if (!body || body.version !== RELAY_PROTOCOL_VERSION || body.streamId !== stream.streamId) {
                        socket.close(1008, 'relay control identity mismatch');
                        return;
                    }
                    if (body.relayId != null && body.relayId !== relayId) {
                        socket.close(1008, 'relay instance mismatch');
                        return;
                    }
                    if (body.kind === 'resync_request') {
                        if (body.reason != null && typeof body.reason !== 'string') {
                            socket.close(1008, 'relay resync reason must be a string');
                            return;
                        }
                        const reason = (body.reason ?? 'consumer_request').slice(0, 160);
                        // The client's mandatory reconnect request can cross the
                        // freshly-sent baseline on the separate HTTP/WS paths.
                        // It is an acknowledgement of the join request, not a
                        // reason to throw that new baseline away.
                        const duplicateBootstrap = consumer.baselineSent
                            && !consumer.ready
                            && (reason === 'reconnect' || reason === 'consumer_join');
                        if (duplicateBootstrap) return;
                        if (!allowConsumerResync(consumer)) return;
                        if (requireFreshScene(stream, reason, { rateLimit: true }) === null) {
                            socket.close(1008, 'too many relay resync requests for stream');
                        }
                        return;
                    }
                    if (body.kind === 'baseline_ready') {
                        if (!consumer.baselineSent
                            || body.producerId !== consumer.producerId
                            || body.sessionId !== consumer.sessionId
                            || body.sceneRevision !== consumer.sceneRevision
                            || body.sceneRequestId !== consumer.sceneRequestId) {
                            if (!allowConsumerResync(consumer)) return;
                            if (requireFreshScene(stream, 'invalid_baseline_ready', { rateLimit: true }) === null) {
                                socket.close(1008, 'too many relay resync requests for stream');
                            }
                            return;
                        }
                        consumer.ready = true;
                        sendConsumer(consumer, {
                            kind: 'consumer_status',
                            version: RELAY_PROTOCOL_VERSION,
                            relayId,
                            streamId: stream.streamId,
                            ready: true,
                            sceneRevision: consumer.sceneRevision,
                            readyConsumers: readyConsumers(stream),
                        });
                        return;
                    }
                    socket.close(1008, 'unknown relay control');
                };
                socket.on('message', (data, isBinary) => {
                    try {
                        handleConsumerMessage(data, isBinary);
                    } catch {
                        socket.close(1008, 'invalid relay control');
                    }
                });
            };

            const upgradeHandler = (request, socket, head) => {
                if (closed) return;
                let url;
                try { url = new URL(request.url ?? '/', 'http://relay.local'); } catch { return; }
                if (url.pathname !== consumerPath) return;
                if (!isLoopbackAddress(request.socket.remoteAddress)
                    || !loopbackHostAllowed(request.headers.host)) {
                    rejectUpgrade(socket, 403, 'Forbidden');
                    return;
                }
                if (!consumerOriginAllowed(request, additionalOrigins)) {
                    rejectUpgrade(socket, 403, 'Forbidden');
                    return;
                }
                if (url.searchParams.get('role') !== 'consumer'
                    || Number(url.searchParams.get('version')) !== RELAY_PROTOCOL_VERSION) {
                    rejectUpgrade(socket, 400, 'Bad Request');
                    return;
                }
                let stream;
                try { stream = streamFor(url.searchParams.get('streamId') ?? primaryStreamId); } catch {
                    rejectUpgrade(socket, 404, 'Not Found');
                    return;
                }
                if (stream.consumers.size >= limits.maxConsumers) {
                    rejectUpgrade(socket, 503, 'Service Unavailable');
                    return;
                }
                wss.handleUpgrade(request, socket, head, (client) => registerConsumer(client, stream));
            };

            const originalRequestListeners = httpServer.listeners('request');
            httpServer.removeAllListeners('request');
            const requestHandler = (request, response) => {
                let url;
                try { url = new URL(request.url ?? '/', 'http://relay.local'); } catch { url = null; }
                if (url?.pathname === ingestPath) {
                    handleIngest(request, response);
                    return;
                }
                if (assetProxy && url?.pathname.startsWith(assetProxy.route)) {
                    if (!isLoopbackAddress(request.socket.remoteAddress)
                        || !loopbackHostAllowed(request.headers.host)) {
                        response.writeHead(403);
                        response.end();
                        return;
                    }
                    serveAsset(request, response, assetProxy);
                    return;
                }
                for (const listener of originalRequestListeners) listener.call(httpServer, request, response);
            };
            httpServer.on('request', requestHandler);
            httpServer.on('upgrade', upgradeHandler);

            const cleanup = () => {
                if (closed) return;
                closed = true;
                server.watcher?.off?.('close', cleanup);
                httpServer.off('upgrade', upgradeHandler);
                httpServer.off('request', requestHandler);
                for (const stream of streams.values()) {
                    for (const consumer of stream.consumers) {
                        try {
                            consumer.socket.close(1001, 'relay server stopped');
                            const terminateTimer = setTimeout(() => {
                                if (consumer.socket.readyState !== WebSocket.CLOSED) consumer.socket.terminate();
                            }, 250);
                            terminateTimer.unref?.();
                        } catch {
                            consumer.socket.terminate();
                        }
                    }
                    stream.consumers.clear();
                }
                try { wss.close(); } catch { /* already closed */ }
            };
            server.watcher?.once?.('close', cleanup);
            httpServer.once('close', cleanup);
        },
    };
}

export const maxjsRelayVite = maxjsRelay;
export default maxjsRelay;
