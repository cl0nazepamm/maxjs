import {
    RELAY_FRAME_LIMITS,
    RELAY_PROTOCOL_VERSION,
    RelayProtocolError,
    assertRelayMetadata,
    decodeRelayFrame,
    isSceneFrame,
} from './relay_frame.mjs';

const DEFAULT_STREAM_ID = 'default';
const DEFAULT_CONSUMER_PATH = '/maxjs-relay';
const DEFAULT_CALLBACK_TIMEOUT_MS = 60_000;
const textEncoder = new TextEncoder();

function noOp() {}

function messageOf(error) {
    try {
        if (error && typeof error.message === 'string') return error.message;
        return String(error);
    } catch {
        return 'unprintable relay error';
    }
}

function byteLengthOf(data) {
    if (typeof data === 'string') return textEncoder.encode(data).byteLength;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
    return 0;
}

function makeRelayUrl(value, streamId) {
    let url;
    if (value) {
        if (/^wss?:/i.test(value)) url = new URL(value);
        else if (typeof location !== 'undefined') url = new URL(value, location.href);
        else throw new Error('RelayClient needs an absolute WebSocket URL outside a browser');
    } else {
        if (typeof location === 'undefined') throw new Error('RelayClient needs url outside a browser');
        url = new URL(DEFAULT_CONSUMER_PATH, location.href);
    }
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error(`RelayClient URL must use ws or wss, got ${url.protocol}`);
    }
    url.searchParams.set('role', 'consumer');
    url.searchParams.set('streamId', streamId);
    url.searchParams.set('version', String(RELAY_PROTOCOL_VERSION));
    return url.href;
}

function controlRelay(envelope) {
    return assertRelayMetadata({ relay: envelope?.relay });
}

/**
 * Ordered browser consumer for max.js relay streams.
 *
 * Callbacks are awaited one at a time. onScene resolves the full baseline;
 * only then does the client announce baseline_ready to the broker.
 */
export class RelayClient {
    constructor(options = {}) {
        for (const name of ['onScene', 'onFrame', 'onMessage', 'onControl', 'onStatus', 'webSocketFactory']) {
            if (options[name] !== undefined && typeof options[name] !== 'function') {
                throw new TypeError(`RelayClient ${name} must be a function`);
            }
        }
        this.streamId = options.streamId ?? DEFAULT_STREAM_ID;
        assertRelayMetadata({
            relay: {
                version: RELAY_PROTOCOL_VERSION,
                streamId: this.streamId,
                producerId: 'consumer',
                sessionId: 'consumer',
                sceneRevision: 0,
                sequence: 0,
            },
        });
        this.url = makeRelayUrl(options.url, this.streamId);
        this.onScene = options.onScene ?? noOp;
        this.onFrame = options.onFrame ?? noOp;
        this.onMessage = options.onMessage ?? noOp;
        this.onControl = options.onControl ?? noOp;
        this.onStatus = options.onStatus ?? noOp;
        this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));

        this.maxQueueFrames = options.maxQueueFrames ?? 256;
        // Count the frame currently being applied. Two legal maximum frames
        // allow one baseline plus one ordered continuation without false overflow.
        this.maxQueueBytes = options.maxQueueBytes ?? (RELAY_FRAME_LIMITS.maxFrameBytes * 2);
        this.maxMetaBytes = options.maxMetaBytes ?? RELAY_FRAME_LIMITS.maxMetaBytes;
        this.maxPayloadBytes = options.maxPayloadBytes ?? RELAY_FRAME_LIMITS.maxPayloadBytes;
        this.maxFrameBytes = options.maxFrameBytes ?? RELAY_FRAME_LIMITS.maxFrameBytes;
        this.reconnectMinMs = options.reconnectMinMs ?? 500;
        this.reconnectMaxMs = options.reconnectMaxMs ?? 8000;
        this.callbackTimeoutMs = options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
        this.AbortControllerImpl = options.AbortControllerImpl ?? globalThis.AbortController;

        for (const [name, value] of [
            ['maxQueueFrames', this.maxQueueFrames],
            ['maxQueueBytes', this.maxQueueBytes],
            ['reconnectMinMs', this.reconnectMinMs],
            ['reconnectMaxMs', this.reconnectMaxMs],
            ['callbackTimeoutMs', this.callbackTimeoutMs],
        ]) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
        }
        for (const [name, value] of [
            ['maxMetaBytes', this.maxMetaBytes],
            ['maxPayloadBytes', this.maxPayloadBytes],
            ['maxFrameBytes', this.maxFrameBytes],
        ]) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
        }

        this.socket = null;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.queue = [];
        this.queueBytes = 0;
        this.currentFrameBytes = 0;
        this.activeCallbackController = null;
        this.processing = false;
        this.disposed = false;
        this.syncEpoch = 0;
        this.state = 'idle';
        this.connected = false;
        this.ready = false;
        this.relayId = null;
        this.producerId = null;
        this.sessionId = null;
        this.sceneRevision = null;
        this.expectedSequence = null;
        this.lastError = null;

        if (options.autoConnect !== false) this.connect();
    }

    get status() {
        return Object.freeze({
            state: this.state,
            connected: this.connected,
            ready: this.ready,
            streamId: this.streamId,
            relayId: this.relayId,
            producerId: this.producerId,
            sessionId: this.sessionId,
            sceneRevision: this.sceneRevision,
            expectedSequence: this.expectedSequence,
            queuedFrames: this.queue.length + (this.currentFrameBytes > 0 ? 1 : 0),
            queuedBytes: this.queueBytes + this.currentFrameBytes,
            reconnectAttempt: this.reconnectAttempt,
            lastError: this.lastError,
            disposed: this.disposed,
        });
    }

    connect() {
        if (this.disposed || this.socket) return;
        this._setState('connecting');
        let socket;
        try {
            socket = this.webSocketFactory(this.url);
        } catch (error) {
            this.lastError = messageOf(error);
            this._scheduleReconnect();
            return;
        }
        this.socket = socket;
        try { socket.binaryType = 'arraybuffer'; } catch { /* implementation may be fixed */ }

        socket.onopen = () => {
            if (this.socket !== socket || this.disposed) return;
            this.connected = true;
            this.reconnectAttempt = 0;
            this._setState('waiting_baseline');
            this._requestResync('reconnect', { clearQueue: false });
        };
        socket.onmessage = (event) => {
            if (this.socket !== socket || this.disposed) return;
            this._enqueue(event.data);
        };
        socket.onerror = () => {
            // close is authoritative and schedules reconnect
        };
        socket.onclose = () => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.connected = false;
            this.ready = false;
            this.relayId = null;
            this.producerId = null;
            this.sessionId = null;
            this.sceneRevision = null;
            this.expectedSequence = null;
            this.syncEpoch += 1;
            this._cancelActiveCallback('relay socket closed');
            this._clearQueue();
            if (!this.disposed) this._scheduleReconnect();
        };
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.syncEpoch += 1;
        this._cancelActiveCallback('relay client disposed');
        this.ready = false;
        this.connected = false;
        this._clearQueue();
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
            try { socket.close(1000, 'relay client disposed'); } catch { /* already closed */ }
        }
        this._setState('disposed');
    }

    requestResync(reason = 'consumer_request') {
        if (this.disposed) return;
        this._requestResync(reason, { clearQueue: true });
    }

    _setState(state) {
        this.state = state;
        try { this.onStatus(this.status); } catch { /* status observers cannot break transport */ }
    }

    _scheduleReconnect() {
        if (this.disposed || this.reconnectTimer !== null) return;
        const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** this.reconnectAttempt));
        this.reconnectAttempt += 1;
        this._setState('reconnecting');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    _send(value) {
        const socket = this.socket;
        if (!socket || socket.readyState !== 1) return false;
        try {
            socket.send(JSON.stringify(value));
            return true;
        } catch (error) {
            this.lastError = messageOf(error);
            return false;
        }
    }

    _requestResync(reason, { clearQueue }) {
        this.syncEpoch += 1;
        this._cancelActiveCallback(`relay resync: ${reason}`);
        this.ready = false;
        this.expectedSequence = null;
        if (clearQueue) this._clearQueue();
        this._setState(this.connected ? 'resyncing' : 'waiting_baseline');
        this._send({
            kind: 'resync_request',
            version: RELAY_PROTOCOL_VERSION,
            relayId: this.relayId,
            streamId: this.streamId,
            producerId: this.producerId,
            sessionId: this.sessionId,
            sceneRevision: this.sceneRevision,
            reason: messageOf(reason).slice(0, 160),
        });
    }

    _clearQueue() {
        this.queue.length = 0;
        this.queueBytes = 0;
    }

    _cancelActiveCallback(reason) {
        const controller = this.activeCallbackController;
        if (!controller) return;
        this.activeCallbackController = null;
        try { controller.abort(reason); } catch { controller.abort(); }
    }

    async _invokeCallback(name, callback, args, epoch) {
        if (typeof this.AbortControllerImpl !== 'function') {
            throw new RelayProtocolError('callback_abort_unavailable',
                'RelayClient requires AbortController for bounded callbacks');
        }
        const controller = new this.AbortControllerImpl();
        this.activeCallbackController = controller;
        let deadline = null;
        const context = Object.freeze({
            signal: controller.signal,
            epoch,
            deadlineMs: this.callbackTimeoutMs,
            requestResync: (reason = 'consumer_request') => this.requestResync(reason),
        });
        try {
            const callbackPromise = Promise.resolve().then(() => callback(...args, context));
            const abortPromise = new Promise((_, reject) => {
                controller.signal.addEventListener('abort', () => reject(new RelayProtocolError(
                    'callback_aborted',
                    `${name} was cancelled by a newer relay epoch`,
                )), { once: true });
            });
            const timeoutPromise = new Promise((_, reject) => {
                deadline = setTimeout(() => {
                    reject(new RelayProtocolError(
                        'callback_timeout',
                        `${name} did not settle within ${this.callbackTimeoutMs} ms`,
                    ));
                    try { controller.abort(`${name} timed out`); } catch { controller.abort(); }
                }, this.callbackTimeoutMs);
            });
            await Promise.race([callbackPromise, abortPromise, timeoutPromise]);
        } finally {
            if (deadline !== null) clearTimeout(deadline);
            if (this.activeCallbackController === controller) this.activeCallbackController = null;
        }
    }

    _enqueue(data) {
        const bytes = byteLengthOf(data);
        const retainedFrames = this.queue.length + (this.currentFrameBytes > 0 ? 1 : 0);
        const retainedBytes = this.queueBytes + this.currentFrameBytes;
        if (retainedFrames + 1 > this.maxQueueFrames || retainedBytes + bytes > this.maxQueueBytes) {
            this.lastError = 'relay receive queue overflow';
            this._requestResync('queue_overflow', { clearQueue: true });
            return;
        }
        this.queue.push({ data, bytes });
        this.queueBytes += bytes;
        void this._drain();
    }

    async _drain() {
        if (this.processing || this.disposed) return;
        this.processing = true;
        try {
            while (this.queue.length && !this.disposed) {
                const item = this.queue.shift();
                this.queueBytes -= item.bytes;
                this.currentFrameBytes = item.bytes;
                try {
                    await this._process(item.data);
                } catch (error) {
                    this.lastError = messageOf(error);
                    if (error instanceof RelayProtocolError && error.code === 'callback_aborted') {
                        continue;
                    }
                    this._requestResync(
                        error instanceof RelayProtocolError ? error.code : 'consumer_apply_error',
                        { clearQueue: true },
                    );
                } finally {
                    this.currentFrameBytes = 0;
                }
            }
        } finally {
            this.processing = false;
        }
    }

    async _process(data) {
        if (typeof Blob !== 'undefined' && data instanceof Blob) data = await data.arrayBuffer();
        if (typeof data === 'string') {
            let envelope;
            try {
                envelope = JSON.parse(data);
            } catch {
                throw new RelayProtocolError('invalid_control_json', 'relay control frame is not valid JSON');
            }
            await this._processControl(envelope);
            return;
        }
        const decoded = decodeRelayFrame(data, {
            maxMetaBytes: this.maxMetaBytes,
            maxPayloadBytes: this.maxPayloadBytes,
            maxFrameBytes: this.maxFrameBytes,
            requireSceneRequestId: true,
        });
        if (decoded.relay.streamId !== this.streamId) {
            throw new RelayProtocolError('stream_mismatch', 'relay binary frame belongs to another stream');
        }
        if (isSceneFrame(decoded.meta)) {
            await this._applyScene({ kind: 'scene', format: 'binary', ...decoded });
            return;
        }
        if (!this._assertContinuation(decoded.relay)) return;
        const epoch = this.syncEpoch;
        await this._invokeCallback(
            'onFrame', this.onFrame, [{ kind: 'frame', format: 'binary', ...decoded }], epoch);
        if (this.disposed || epoch !== this.syncEpoch) return;
        this.expectedSequence += 1;
    }

    async _processControl(envelope) {
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
            throw new RelayProtocolError('invalid_control', 'relay control frame must be an object');
        }
        if (envelope.kind === 'relay_hello') {
            if (envelope.version !== RELAY_PROTOCOL_VERSION || envelope.streamId !== this.streamId || typeof envelope.relayId !== 'string') {
                throw new RelayProtocolError('invalid_relay_hello', 'relay hello identity or version is invalid');
            }
            if (this.relayId && this.relayId !== envelope.relayId) {
                this.relayId = envelope.relayId;
                this._requestResync('relay_restart', { clearQueue: false });
            } else {
                this.relayId = envelope.relayId;
            }
            await this._invokeCallback('onControl', this.onControl, [envelope], this.syncEpoch);
            return;
        }
        if (envelope.kind === 'resync_required') {
            if (envelope.version !== RELAY_PROTOCOL_VERSION || envelope.streamId !== this.streamId) {
                throw new RelayProtocolError('invalid_resync', 'relay resync control identity is invalid');
            }
            if ((this.relayId && envelope.relayId !== this.relayId)
                || !Number.isSafeInteger(envelope.sceneRequestId)
                || envelope.sceneRequestId < 0) {
                throw new RelayProtocolError('invalid_resync', 'relay resync request id or instance is invalid');
            }
            this._requestResync(envelope.reason ?? 'broker_request', { clearQueue: false });
            await this._invokeCallback('onControl', this.onControl, [envelope], this.syncEpoch);
            return;
        }
        if (envelope.kind === 'scene') {
            const relay = controlRelay(envelope);
            if (relay.streamId !== this.streamId) throw new RelayProtocolError('stream_mismatch', 'JSON scene belongs to another stream');
            await this._applyScene({ kind: 'scene', format: 'json', relay, data: envelope.data, envelope });
            return;
        }

        if (envelope.relay) {
            const relay = controlRelay(envelope);
            if (relay.streamId !== this.streamId) throw new RelayProtocolError('stream_mismatch', 'relay control belongs to another stream');
            if (!this._assertContinuation(relay)) return;
            const epoch = this.syncEpoch;
            if (envelope.kind === 'msg') {
                await this._invokeCallback(
                    'onMessage', this.onMessage, [envelope.data, envelope], epoch);
            } else {
                await this._invokeCallback('onControl', this.onControl, [envelope], epoch);
            }
            if (this.disposed || epoch !== this.syncEpoch) return;
            this.expectedSequence += 1;
            return;
        }
        await this._invokeCallback('onControl', this.onControl, [envelope], this.syncEpoch);
    }

    _assertContinuation(relay) {
        if (!this.ready || this.expectedSequence === null || this.sceneRevision === null) {
            // A resync control and its replacement scene share the same ordered
            // socket. Discard old continuations while waiting without clearing
            // a fresh baseline that may already be queued behind them.
            return false;
        }
        if (relay.producerId !== this.producerId || relay.sessionId !== this.sessionId) {
            throw new RelayProtocolError('session_mismatch', 'relay producer session changed without a baseline');
        }
        if (relay.sceneRevision !== this.sceneRevision) {
            throw new RelayProtocolError('revision_mismatch', 'relay continuation scene revision does not match the baseline');
        }
        if (relay.sequence !== this.expectedSequence) {
            throw new RelayProtocolError('sequence_gap', `expected relay sequence ${this.expectedSequence}, got ${relay.sequence}`);
        }
        return true;
    }

    async _applyScene(frame) {
        const relay = frame.relay;
        if (relay.sequence !== 0) {
            throw new RelayProtocolError('invalid_scene_sequence', 'full-scene relay sequence must be zero');
        }
        if (relay.sceneRequestId === undefined) {
            throw new RelayProtocolError('missing_scene_request', 'full-scene relay frame is missing sceneRequestId');
        }
        const sameSession = relay.producerId === this.producerId && relay.sessionId === this.sessionId;
        if (sameSession && this.sceneRevision !== null && relay.sceneRevision <= this.sceneRevision) {
            throw new RelayProtocolError('stale_scene', 'relay baseline revision did not advance');
        }

        const epoch = this.syncEpoch;
        this.ready = false;
        this._setState('applying_baseline');
        await this._invokeCallback('onScene', this.onScene, [frame], epoch);
        if (this.disposed || epoch !== this.syncEpoch) return;

        this.producerId = relay.producerId;
        this.sessionId = relay.sessionId;
        this.sceneRevision = relay.sceneRevision;
        this.expectedSequence = 1;
        this.ready = true;
        this.lastError = null;
        this._setState('ready');
        this._send({
            kind: 'baseline_ready',
            version: RELAY_PROTOCOL_VERSION,
            relayId: this.relayId,
            streamId: this.streamId,
            producerId: this.producerId,
            sessionId: this.sessionId,
            sceneRevision: this.sceneRevision,
            sceneRequestId: relay.sceneRequestId,
        });
    }
}

export default RelayClient;
