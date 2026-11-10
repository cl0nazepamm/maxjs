// relay_frame.mjs - strict framing shared by relay producers, brokers, and clients.
//
// Binary envelope (kept wire-compatible with the original relay proof of concept):
//   [u32 metadata byte length, little-endian][UTF-8 JSON metadata][payload]

// The envelope is deliberately small. Stream/session/revision semantics live in
// metadata.relay so the scene payload stays the same max.js binary contract.

export const RELAY_PROTOCOL_VERSION = 1;

export const RELAY_FRAME_LIMITS = Object.freeze({
    maxMetaBytes: 16 * 1024 * 1024,
    maxPayloadBytes: 512 * 1024 * 1024,
    maxFrameBytes: 528 * 1024 * 1024 + 4,
});

const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class RelayProtocolError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RelayProtocolError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new RelayProtocolError(code, message);
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('invalid_object', `${label} must be an object`);
    }
}

function assertId(value, name) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
        fail('invalid_identity', `relay.${name} must be a 1-${MAX_ID_LENGTH} character identifier`);
    }
}

function assertCounter(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        fail('invalid_counter', `relay.${name} must be a non-negative safe integer`);
    }
}

function resolveLimits(options = {}) {
    const limits = {
        maxMetaBytes: options.maxMetaBytes ?? RELAY_FRAME_LIMITS.maxMetaBytes,
        maxPayloadBytes: options.maxPayloadBytes ?? RELAY_FRAME_LIMITS.maxPayloadBytes,
        maxFrameBytes: options.maxFrameBytes ?? RELAY_FRAME_LIMITS.maxFrameBytes,
    };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 0) {
            fail('invalid_limit', `${name} must be a non-negative safe integer`);
        }
    }
    if (limits.maxFrameBytes < 4) {
        fail('invalid_limit', 'maxFrameBytes must allow the four-byte envelope header');
    }
    return limits;
}

function asBytes(value, label) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    fail('invalid_bytes', `${label} must be an ArrayBuffer or an ArrayBuffer view`);
}

/**
 * Validate and return the required relay identity block.
 */
export function assertRelayMetadata(meta, options = {}) {
    assertPlainObject(meta, 'frame metadata');
    const relay = meta.relay;
    assertPlainObject(relay, 'metadata.relay');
    if (relay.version !== RELAY_PROTOCOL_VERSION) {
        fail('unsupported_version', `relay.version must be ${RELAY_PROTOCOL_VERSION}`);
    }
    assertId(relay.streamId, 'streamId');
    assertId(relay.producerId, 'producerId');
    assertId(relay.sessionId, 'sessionId');
    assertCounter(relay.sceneRevision, 'sceneRevision');
    assertCounter(relay.sequence, 'sequence');
    if (relay.sceneRequestId !== undefined) assertCounter(relay.sceneRequestId, 'sceneRequestId');
    if (options.requireSceneRequestId && isSceneFrame(meta) && relay.sceneRequestId === undefined) {
        fail('missing_scene_request', 'full-scene frames must include relay.sceneRequestId');
    }
    return relay;
}

/** Return true for the host contract's full-scene frame (typed or legacy-untyped). */
export function isSceneFrame(frameOrMeta) {
    if (frameOrMeta?.kind === 'scene') return true;
    const meta = frameOrMeta?.meta ?? frameOrMeta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
    return meta.type === undefined || meta.type === null || meta.type === '' || meta.type === 'scene_bin';
}

/**
 * Encode one relay frame. Returns an exact-length Uint8Array suitable for
 * fetch(), WebSocket.send(), or Buffer.from() without another framing step.
 */
export function encodeRelayFrame(meta, payload, options = {}) {
    assertRelayMetadata(meta, { requireSceneRequestId: options.requireSceneRequestId === true });
    const limits = resolveLimits(options);
    const payloadBytes = asBytes(payload, 'payload');
    if (payloadBytes.byteLength > limits.maxPayloadBytes) {
        fail('payload_too_large', `payload exceeds ${limits.maxPayloadBytes} bytes`);
    }

    let json;
    try {
        json = JSON.stringify(meta);
    } catch (error) {
        fail('invalid_metadata_json', `frame metadata is not JSON-serializable: ${error?.message ?? error}`);
    }
    if (typeof json !== 'string') fail('invalid_metadata_json', 'frame metadata did not serialize to JSON');
    const metaBytes = encoder.encode(json);
    if (metaBytes.byteLength === 0) fail('empty_metadata', 'frame metadata cannot be empty');
    if (metaBytes.byteLength > limits.maxMetaBytes) {
        fail('metadata_too_large', `metadata exceeds ${limits.maxMetaBytes} bytes`);
    }

    const frameLength = 4 + metaBytes.byteLength + payloadBytes.byteLength;
    if (!Number.isSafeInteger(frameLength) || frameLength > limits.maxFrameBytes) {
        fail('frame_too_large', `frame exceeds ${limits.maxFrameBytes} bytes`);
    }

    const output = new Uint8Array(frameLength);
    new DataView(output.buffer).setUint32(0, metaBytes.byteLength, true);
    output.set(metaBytes, 4);
    output.set(payloadBytes, 4 + metaBytes.byteLength);
    return output;
}

/**
 * Decode and validate one relay frame.
 *
 * copyPayload defaults to true so payload.byteOffset is zero and consumers can
 * safely pass payload.buffer to existing max.js parsers whose offsets are
 * relative to the payload. Brokers should pass copyPayload:false when they only
 * need to inspect metadata before forwarding the original frame.
 */
export function decodeRelayFrame(frame, options = {}) {
    const limits = resolveLimits(options);
    const bytes = asBytes(frame, 'frame');
    if (bytes.byteLength < 4) fail('truncated_header', 'relay frame is shorter than its four-byte header');
    if (bytes.byteLength > limits.maxFrameBytes) {
        fail('frame_too_large', `frame exceeds ${limits.maxFrameBytes} bytes`);
    }

    const metaLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    if (metaLength === 0) fail('empty_metadata', 'relay frame metadata cannot be empty');
    if (metaLength > limits.maxMetaBytes) {
        fail('metadata_too_large', `metadata exceeds ${limits.maxMetaBytes} bytes`);
    }
    const payloadOffset = 4 + metaLength;
    if (payloadOffset > bytes.byteLength) fail('truncated_metadata', 'relay frame metadata length exceeds the frame');
    const payloadLength = bytes.byteLength - payloadOffset;
    if (payloadLength > limits.maxPayloadBytes) {
        fail('payload_too_large', `payload exceeds ${limits.maxPayloadBytes} bytes`);
    }

    let metaText;
    try {
        metaText = decoder.decode(bytes.subarray(4, payloadOffset));
    } catch {
        fail('invalid_utf8', 'relay frame metadata is not valid UTF-8');
    }
    let meta;
    try {
        meta = JSON.parse(metaText);
    } catch {
        fail('invalid_metadata_json', 'relay frame metadata is not valid JSON');
    }
    const relay = assertRelayMetadata(meta, { requireSceneRequestId: options.requireSceneRequestId === true });

    const view = bytes.subarray(payloadOffset);
    const payload = options.copyPayload === false ? view : Uint8Array.from(view);
    return { meta, relay, payload, byteLength: bytes.byteLength };
}
