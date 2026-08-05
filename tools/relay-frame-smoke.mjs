import assert from 'node:assert/strict';

import {
    RELAY_PROTOCOL_VERSION,
    RelayProtocolError,
    decodeRelayFrame,
    encodeRelayFrame,
    isSceneFrame,
} from '../web/js/relay_frame.mjs';

const relay = {
    version: RELAY_PROTOCOL_VERSION,
    streamId: 'default',
    producerId: 'max',
    sessionId: 'session-1',
    sceneRevision: 1,
    sequence: 0,
    sceneRequestId: 7,
};
const meta = { type: 'scene_bin', nodes: [{ n: 'Cube' }], relay };
const payload = Uint8Array.from([0, 1, 2, 255]);
const encoded = encodeRelayFrame(meta, payload, { requireSceneRequestId: true });
const decoded = decodeRelayFrame(encoded, { requireSceneRequestId: true });
assert.deepEqual(decoded.meta, meta);
assert.deepEqual(decoded.payload, payload);
assert.equal(decoded.payload.byteOffset, 0);
assert.equal(isSceneFrame(decoded), true);
assert.equal(isSceneFrame({ type: 'delta_bin', relay: { ...relay, sequence: 1 } }), false);
assert.equal(isSceneFrame({ kind: 'scene' }), true);

function rejects(code, fn) {
    assert.throws(fn, (error) => error instanceof RelayProtocolError && error.code === code);
}

rejects('truncated_header', () => decodeRelayFrame(new Uint8Array(3)));

const truncatedMeta = Uint8Array.from([10, 0, 0, 0, 123]);
rejects('truncated_metadata', () => decodeRelayFrame(truncatedMeta));

const invalidUtf8 = Uint8Array.from([2, 0, 0, 0, 0xc3, 0x28]);
rejects('invalid_utf8', () => decodeRelayFrame(invalidUtf8));

const invalidJsonBytes = new TextEncoder().encode('{nope}');
const invalidJson = new Uint8Array(4 + invalidJsonBytes.length);
new DataView(invalidJson.buffer).setUint32(0, invalidJsonBytes.length, true);
invalidJson.set(invalidJsonBytes, 4);
rejects('invalid_metadata_json', () => decodeRelayFrame(invalidJson));

const arrayJsonBytes = new TextEncoder().encode('[]');
const arrayMeta = new Uint8Array(4 + arrayJsonBytes.length);
new DataView(arrayMeta.buffer).setUint32(0, arrayJsonBytes.length, true);
arrayMeta.set(arrayJsonBytes, 4);
rejects('invalid_object', () => decodeRelayFrame(arrayMeta));

rejects('unsupported_version', () => encodeRelayFrame({ ...meta, relay: { ...relay, version: 2 } }, payload));
rejects('invalid_identity', () => encodeRelayFrame({ ...meta, relay: { ...relay, streamId: '../bad' } }, payload));
rejects('missing_scene_request', () => encodeRelayFrame(
    { ...meta, relay: { ...relay, sceneRequestId: undefined } },
    payload,
    { requireSceneRequestId: true },
));
rejects('metadata_too_large', () => encodeRelayFrame(meta, payload, { maxMetaBytes: 8 }));
rejects('payload_too_large', () => encodeRelayFrame(meta, payload, { maxPayloadBytes: 3 }));
rejects('frame_too_large', () => decodeRelayFrame(encoded, { maxFrameBytes: encoded.byteLength - 1 }));

// A subarray with a non-zero backing-buffer offset must still decode correctly.
const padded = new Uint8Array(encoded.byteLength + 12);
padded.set(encoded, 6);
assert.deepEqual(decodeRelayFrame(padded.subarray(6, 6 + encoded.byteLength)).payload, payload);

console.log('relay frame smoke: OK');

