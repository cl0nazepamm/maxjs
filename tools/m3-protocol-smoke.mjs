#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../web/node_modules/three/build/three.module.js';
import {
    COMMAND_TYPES,
    DELTA_FRAME_MAGIC,
    DELTA_FRAME_VERSION,
    applyDeltaFrame,
    captureRetainedDeltaFrame,
} from '../web/js/protocol.js';
import {
    attachSkinAttributes,
    binInRange,
    geometryFromNodeBinary,
    typedArrayCanStore,
    updateFloatGeometryAttribute,
} from '../web/js/scene_binary.js';
import { applySceneBin } from '../web/js/scene_applier.js';
import { createInstanceBuckets } from '../web/js/instance_buckets.js';
import { analyzeSnapshotPayload } from '../web/js/snapshot_diagnostics.js';
import {
    fetchSnapshotScenePayload,
    snapshotScenePayloadCandidates,
    snapshotInstanceBucketExcludedHandles,
    validateM3Metadata,
    validateSnapshotScenePayloadName,
} from '../web/js/snapshot_boot.js';

const FRAME_ID = 0x12345678;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];

function setFloatArray(view, offset, values) {
    values.forEach((value, index) => view.setFloat32(offset + index * 4, value, true));
}

function command(type, size, write = () => {}) {
    return { type, size, write };
}

function buildFrame(commands, frameId = FRAME_ID) {
    const byteLength = 16 + commands.reduce((sum, entry) => sum + entry.size, 0);
    const buffer = new ArrayBuffer(byteLength);
    const view = new DataView(buffer);
    view.setUint32(0, DELTA_FRAME_MAGIC, true);
    view.setUint16(4, DELTA_FRAME_VERSION, true);
    view.setUint16(6, 0, true);
    view.setUint32(8, frameId, true);
    view.setUint32(12, commands.length, true);
    const offsets = [];
    let offset = 16;
    for (const entry of commands) {
        offsets.push(offset);
        view.setUint16(offset, entry.type, true);
        view.setUint16(offset + 2, entry.size, true);
        entry.write(view, offset + 4);
        offset += entry.size;
    }
    return { buffer, offsets };
}

function allOpcodeFrame() {
    const commands = [
        command(COMMAND_TYPES.BeginFrame, 8, (view, o) => view.setUint32(o, FRAME_ID, true)),
        command(COMMAND_TYPES.UpdateTransform, 72, (view, o) => {
            view.setUint32(o, 7, true);
            setFloatArray(view, o + 4, IDENTITY);
        }),
        command(COMMAND_TYPES.UpdateMaterialScalar, 32, (view, o) => {
            view.setUint32(o, 8, true);
            setFloatArray(view, o + 4, [0.1, 0.2, 0.3]);
            setFloatArray(view, o + 16, [0.4, 0.5, 0.6]);
        }),
        command(COMMAND_TYPES.UpdateSelection, 12, (view, o) => {
            view.setUint32(o, 9, true);
            view.setUint32(o + 4, 1, true);
        }),
        command(COMMAND_TYPES.UpdateVisibility, 12, (view, o) => {
            view.setUint32(o, 10, true);
            view.setUint32(o + 4, 0, true);
        }),
        command(COMMAND_TYPES.UpdateCamera, 68, (view, o) => {
            setFloatArray(view, o, [1, 2, 3, 4, 5, 6, 0, 1, 0]);
            view.setFloat32(o + 36, 55, true);
            view.setUint32(o + 40, 1, true);
            view.setFloat32(o + 44, 12, true);
            view.setUint32(o + 48, 1, true);
            setFloatArray(view, o + 52, [25, 50, 2]);
        }),
        command(COMMAND_TYPES.UpdateLight, 152, (view, o) => {
            view.setUint32(o, 11, true);
            setFloatArray(view, o + 4, IDENTITY);
            view.setUint32(o + 68, 1, true);
            view.setUint32(o + 72, 2, true);
            setFloatArray(view, o + 76, [0.7, 0.8, 0.9, 100, 200, 2, 0.5, 0.25, 3, 4, 0.1, 0.2, 0.3]);
            view.setUint32(o + 128, 1, true);
            view.setFloat32(o + 132, -0.001, true);
            view.setFloat32(o + 136, 2.5, true);
            view.setUint32(o + 140, 2048, true);
            view.setFloat32(o + 144, 0.75, true);
        }),
        command(COMMAND_TYPES.UpdateAudio, 76, (view, o) => {
            view.setUint32(o, 12, true);
            setFloatArray(view, o + 4, IDENTITY);
            view.setUint32(o + 68, 1, true);
        }),
        command(COMMAND_TYPES.UpdateTime, 16, (view, o) => {
            view.setInt32(o, -240, true);
            view.setInt32(o + 4, 160, true);
            view.setUint8(o + 8, 1);
        }),
        command(COMMAND_TYPES.UpdateGLTF, 76, (view, o) => {
            view.setUint32(o, 13, true);
            setFloatArray(view, o + 4, IDENTITY);
            view.setUint32(o + 68, 0, true);
        }),
        command(COMMAND_TYPES.UpdateWebApp, 76, (view, o) => {
            view.setUint32(o, 14, true);
            setFloatArray(view, o + 4, IDENTITY);
            view.setUint32(o + 68, 1, true);
        }),
        command(COMMAND_TYPES.EndFrame, 4),
    ];
    return { ...buildFrame(commands), commands };
}

function cloneWithExtraBytes(buffer, extraBytes) {
    const out = new ArrayBuffer(buffer.byteLength + extraBytes);
    new Uint8Array(out).set(new Uint8Array(buffer));
    return out;
}

function protocolGoldenSmoke() {
    const { buffer, offsets } = allOpcodeFrame();
    const calls = [];
    const result = applyDeltaFrame(buffer, {
        onBeginFrame: id => calls.push(['begin', id]),
        onTransform: (handle, matrix) => calls.push(['transform', handle, Array.from(matrix)]),
        onMaterialScalar: (handle, data) => calls.push(['material', handle, Array.from(data.color), data]),
        onSelection: (handle, selected) => calls.push(['selection', handle, selected]),
        onVisibility: (handle, visible) => calls.push(['visibility', handle, visible]),
        onCamera: data => calls.push(['camera', data]),
        onLight: (handle, data) => calls.push(['light', handle, data]),
        onAudio: (handle, matrix, visible) => calls.push(['audio', handle, Array.from(matrix), visible]),
        onTime: data => calls.push(['time', data]),
        onGLTF: (handle, matrix, visible) => calls.push(['gltf', handle, Array.from(matrix), visible]),
        onWebApp: (handle, matrix, visible) => calls.push(['webapp', handle, Array.from(matrix), visible]),
        onEndFrame: id => calls.push(['end', id]),
    });

    assert.equal(result.frameId, FRAME_ID);
    assert.equal(result.commandCount, Object.keys(COMMAND_TYPES).length);
    assert.equal(result.bytes, buffer.byteLength);
    assert.deepEqual(calls.map(call => call[0]), [
        'begin', 'transform', 'material', 'selection', 'visibility', 'camera',
        'light', 'audio', 'time', 'gltf', 'webapp', 'end',
    ]);
    assert.deepEqual(calls.find(call => call[0] === 'transform').slice(1), [7, IDENTITY]);
    assert.deepEqual(calls.find(call => call[0] === 'selection').slice(1), [9, true]);
    assert.deepEqual(calls.find(call => call[0] === 'visibility').slice(1), [10, false]);
    assert.equal(calls.find(call => call[0] === 'camera')[1].dofEnabled, true);
    assert.equal(calls.find(call => call[0] === 'light')[2].shadowMapSize, 2048);
    assert.deepEqual(calls.find(call => call[0] === 'time')[1], { ticks: -240, tpf: 160, stateFlags: 1 });
    assert.deepEqual(calls.find(call => call[0] === 'gltf').slice(1, 2), [13]);

    // Legacy v1 camera payload (without DOF) remains readable.
    const legacyCamera = buildFrame([
        command(COMMAND_TYPES.UpdateCamera, 52, (view, o) => {
            setFloatArray(view, o, [1, 2, 3, 4, 5, 6, 0, 1, 0]);
            view.setFloat32(o + 36, 45, true);
            view.setUint32(o + 40, 1, true);
            view.setFloat32(o + 44, 8, true);
        }),
    ]).buffer;
    let legacyValue = null;
    applyDeltaFrame(legacyCamera, { onCamera: value => { legacyValue = value; } });
    assert.equal(legacyValue.dofEnabled, undefined);

    assert.throws(() => applyDeltaFrame(new ArrayBuffer(15)), /Truncated delta frame header/);
    assert.throws(() => applyDeltaFrame(new DataView(buffer)), /must be an ArrayBuffer/);
    assert.throws(() => applyDeltaFrame(cloneWithExtraBytes(buffer, 4)), /length mismatch/);
    const retainedPlaybackBuffer = cloneWithExtraBytes(buffer, 4096);
    const retainedResult = applyDeltaFrame(retainedPlaybackBuffer, {}, buffer.byteLength);
    assert.equal(retainedResult.bytes, buffer.byteLength);

    // A retained slot can be overwritten before an older queued WebView event
    // runs. Its producerBytes then describes the old frame while the shared
    // memory contains a newer, shorter frame plus the old tail.
    const olderRetainedFrame = buildFrame([
        command(COMMAND_TYPES.BeginFrame, 8, (view, o) => view.setUint32(o, FRAME_ID, true)),
        command(COMMAND_TYPES.UpdateTransform, 72, (view, o) => {
            view.setUint32(o, 21, true);
            setFloatArray(view, o + 4, IDENTITY);
        }),
        command(COMMAND_TYPES.UpdateTransform, 72, (view, o) => {
            view.setUint32(o, 22, true);
            setFloatArray(view, o + 4, IDENTITY);
        }),
        command(COMMAND_TYPES.EndFrame, 4),
    ], FRAME_ID).buffer;
    const currentFrameId = FRAME_ID + 1;
    const currentRetainedFrame = buildFrame([
        command(COMMAND_TYPES.BeginFrame, 8, (view, o) => view.setUint32(o, currentFrameId, true)),
        command(COMMAND_TYPES.UpdateTransform, 72, (view, o) => {
            view.setUint32(o, 23, true);
            setFloatArray(view, o + 4, IDENTITY);
        }),
        command(COMMAND_TYPES.EndFrame, 4),
    ], currentFrameId).buffer;
    const reusedSlot = cloneWithExtraBytes(olderRetainedFrame, 256);
    new Uint8Array(reusedSlot).set(new Uint8Array(currentRetainedFrame));
    assert.throws(
        () => applyDeltaFrame(reusedSlot, {}, olderRetainedFrame.byteLength),
        /length mismatch/,
        'stale per-post metadata reproduces the retained-slot failure',
    );
    const captured = captureRetainedDeltaFrame(reusedSlot, olderRetainedFrame.byteLength);
    assert.equal(captured.copied, true);
    assert.equal(captured.byteLength, currentRetainedFrame.byteLength);
    assert.equal(captured.frameId, currentFrameId);
    assert.equal(applyDeltaFrame(captured.buffer).bytes, currentRetainedFrame.byteLength);
    const busySlot = reusedSlot.slice(0);
    new DataView(busySlot).setUint32(0, 0, true);
    assert.equal(captureRetainedDeltaFrame(busySlot, olderRetainedFrame.byteLength), null);

    assert.throws(() => applyDeltaFrame(retainedPlaybackBuffer, {}, -1), /non-negative safe integer/);
    assert.throws(
        () => applyDeltaFrame(retainedPlaybackBuffer, {}, retainedPlaybackBuffer.byteLength + 1),
        /exceeds buffer capacity/,
    );
    assert.throws(() => applyDeltaFrame(buffer.slice(0, -1)), /Truncated|exceeds frame bounds/);

    const badSize = buffer.slice(0);
    new DataView(badSize).setUint16(offsets[0] + 2, 4, true);
    assert.throws(() => applyDeltaFrame(badSize), /Unexpected command size for BeginFrame/);

    const retiredOpcode = buffer.slice(0);
    new DataView(retiredOpcode).setUint16(offsets[1], 9, true);
    assert.throws(() => applyDeltaFrame(retiredOpcode), /Unknown delta command type: 9/);

    const mismatchedBegin = buffer.slice(0);
    new DataView(mismatchedBegin).setUint32(offsets[0] + 4, FRAME_ID + 1, true);
    assert.throws(() => applyDeltaFrame(mismatchedBegin), /does not match frame header/);

    const impossibleCount = buffer.slice(0);
    new DataView(impossibleCount).setUint32(12, 0xffffffff, true);
    assert.throws(() => applyDeltaFrame(impossibleCount), /command count .* exceeds available bytes/);

    // A malformed command near the tail must be caught before an early handler runs.
    const invalidTail = buffer.slice(0);
    const webAppOffset = offsets[offsets.length - 2];
    new DataView(invalidTail).setUint32(webAppOffset + 4 + 68, 2, true);
    let applied = 0;
    assert.throws(() => applyDeltaFrame(invalidTail, { onBeginFrame: () => applied++ }), /Invalid UpdateWebApp.visible/);
    assert.equal(applied, 0);
}

function m3RangeSmoke() {
    const buffer = new ArrayBuffer(48);
    const view = new DataView(buffer);
    [-1, -1, 0, 1, -1, 0, 0, 1, 0]
        .forEach((value, index) => view.setFloat32(index * 4, value, true));
    [0, 1, 2].forEach((value, index) => view.setInt32(36 + index * 4, value, true));

    assert.equal(binInRange(buffer, 0, 9), true);
    assert.equal(binInRange(buffer, 2, 1, 4), false, 'misaligned f32 offset rejected');
    assert.equal(binInRange(buffer, Number.MAX_SAFE_INTEGER, 1), false);
    assert.equal(binInRange(buffer, 0, Number.MAX_SAFE_INTEGER, 4), false);
    assert.equal(binInRange({ byteLength: 48 }, 0, 1), false, 'forged buffer rejected');
    assert.equal(typedArrayCanStore(new Float32Array(3), 3), true);
    assert.equal(typedArrayCanStore(new Float32Array(3), Number.MAX_SAFE_INTEGER), false);

    const descriptor = {
        h: 1,
        n: 'Triangle',
        geo: { vOff: 0, vN: 9, iOff: 36, iN: 3, iType: 'u32' },
    };
    const geometry = geometryFromNodeBinary(descriptor, buffer);
    assert.ok(geometry?.isBufferGeometry);
    assert.equal(geometry.getAttribute('position').count, 3);
    assert.deepEqual(Array.from(geometry.getIndex().array), [0, 1, 2]);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
        assert.equal(geometryFromNodeBinary({ ...descriptor, geo: { ...descriptor.geo, vN: 8 } }, buffer), null);
        assert.equal(geometryFromNodeBinary({ ...descriptor, geo: { ...descriptor.geo, iN: 2 } }, buffer), null);
        assert.equal(geometryFromNodeBinary({
            ...descriptor,
            geo: { ...descriptor.geo, iType: 'mystery-index' },
        }, buffer), null);
        assert.equal(geometryFromNodeBinary({
            ...descriptor,
            geo: { ...descriptor.geo, uvOff: 0, uvN: 5 },
        }, buffer), null);
        assert.equal(geometryFromNodeBinary({
            ...descriptor,
            geo: { ...descriptor.geo, uvOff: 0, uvN: 6, uvType: 'mystery-uv' },
        }, buffer), null);
        const destination = geometry.clone();
        assert.equal(updateFloatGeometryAttribute(destination, 'position', buffer, 0, 9, 0), false);
        attachSkinAttributes(destination, {
            ...descriptor,
            skin: { wOff: 0, wN: 3, iOff: 0, iN: 3 },
        }, buffer);
        assert.equal(destination.getAttribute('skinWeight'), undefined);
    } finally {
        console.warn = originalWarn;
        geometry.dispose();
    }
    assert.ok(warnings.length >= 7);
}

function m3AliasedRangeDiagnosticsSmoke() {
    const sharedGeo = { vOff: 0, vN: 9, iOff: 36, iN: 3, iType: 'u32' };
    const report = analyzeSnapshotPayload({
        snapshotJson: {
            nodes: [
                { h: 1, n: 'Tree001', geo: sharedGeo },
                { h: 2, n: 'Tree002', geo: { ...sharedGeo } },
            ],
        },
        files: { sceneBinBytes: 48 },
    });
    assert.equal(report.overlap, 0, 'exact M3 aliases are not corruption overlaps');
    assert.equal(report.accounted, 48, 'physical bytes are counted once');
    assert.equal(report.logicalAccounted, 96, 'logical node bytes include both meshes');
    assert.deepEqual(report.aliases, { references: 2, bytesReused: 48 });

    const invalid = analyzeSnapshotPayload({
        snapshotJson: {
            nodes: [
                { h: 1, n: 'Mesh001', geo: { vOff: 0, vN: 9, iOff: 36, iN: 3, iType: 'u32' } },
                { h: 2, n: 'Mesh002', geo: { vOff: 4, vN: 9, iOff: 48, iN: 3, iType: 'u32' } },
            ],
        },
        files: { sceneBinBytes: 60 },
    });
    assert.ok(invalid.overlap > 0, 'partial M3 overlaps remain visible as corruption');
    assert.equal(invalid.aliases.references, 0);
}

async function m3AliasedGeometryReuseSmoke() {
    const buffer = new ArrayBuffer(48);
    const view = new DataView(buffer);
    [-1, -1, 0, 1, -1, 0, 0, 1, 0]
        .forEach((value, index) => view.setFloat32(index * 4, value, true));
    [0, 1, 2].forEach((value, index) => view.setInt32(36 + index * 4, value, true));

    const geo = { vOff: 0, vN: 9, iOff: 36, iN: 3, iType: 'u32' };
    const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const nodeMap = new Map();
    const maxRoot = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(maxRoot);

    const result = await applySceneBin({
        buffer,
        meta: {
            type: 'scene_bin',
            nodes: [
                { h: 1, n: 'Tree001', t: transform, geo },
                { h: 2, n: 'Tree002', t: transform, geo: { ...geo } },
            ],
        },
        ctx: { nodeMap, maxRoot, scene },
    });

    const first = nodeMap.get(1);
    const second = nodeMap.get(2);
    assert.ok(first?.isMesh && second?.isMesh);
    assert.notEqual(first.isInstancedMesh, true);
    assert.notEqual(second.isInstancedMesh, true);
    assert.notEqual(first, second, 'ordinary mesh nodes remain distinct objects');
    assert.equal(first.geometry, second.geometry,
        'aliased M3 ranges reuse one decoded BufferGeometry and typed arrays');
    assert.equal(first.geometry.getAttribute('position').array,
        second.geometry.getAttribute('position').array,
        'aliased ordinary meshes do not allocate a second Float32Array');
    assert.equal(first.geometry.index.array, second.geometry.index.array,
        'aliased ordinary meshes do not allocate a second index array');
    assert.equal(result.reusedM3GeometryCount, 1);
}

async function m3AliasInstanceBucketSmoke() {
    const buffer = new ArrayBuffer(48);
    const view = new DataView(buffer);
    [-1, -1, 0, 1, -1, 0, 0, 1, 0]
        .forEach((value, index) => view.setFloat32(index * 4, value, true));
    [0, 1, 2].forEach((value, index) => view.setInt32(36 + index * 4, value, true));

    const geo = { vOff: 0, vN: 9, iOff: 36, iN: 3, iType: 'u32' };
    const groups = [[0, 3, 0]];
    const mats = [{ name: 'Bark' }];
    const nodes = [1, 2, 3, 4].map((h) => ({
        h,
        n: `Tree${h}`,
        t: [...IDENTITY.slice(0, 12), h * 2, 0, 0, 1],
        vis: 1,
        geo: { ...geo },
        groups,
        mats,
        matRefs: [7],
    }));
    const nodeMap = new Map();
    const maxRoot = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(maxRoot);
    const buckets = createInstanceBuckets({
        nodeMap,
        root: maxRoot,
        threshold: 4,
        materialKey: (nd) => `refs:${nd.matRefs.join(',')}`,
        buildMaterial: ({ nd }) => nd.mats.map(() => new THREE.MeshBasicMaterial()),
    });
    const bucketPlan = buckets.plan(nodes);
    assert.equal(bucketPlan.groups.size, 1, 'exact M3 aliases form one draw bucket candidate');

    await applySceneBin({
        buffer,
        meta: { type: 'scene_bin', nodes },
        ctx: { nodeMap, maxRoot, scene },
        hooks: {
            planInstanceBuckets: () => bucketPlan,
            getInstanceBucketFor: (handle) => buckets.getBucketFor(handle),
            updateInstanceBucketNode: (handle, nd) => buckets.updateNode(handle, nd),
        },
    });
    assert.equal(nodeMap.get(1).geometry, nodeMap.get(4).geometry,
        'draw promotion reuses the already decoded BufferGeometry');
    assert.equal(buckets.build(nodes, bucketPlan), true);
    assert.deepEqual(buckets.stats(), { buckets: 1, instances: 4 });
    const instanced = maxRoot.children.find((child) => child.isInstancedMesh);
    assert.ok(instanced, 'eligible aliases promote to a real THREE.InstancedMesh');
    assert.equal(instanced.count, 4);
    assert.equal(instanced.geometry, nodeMap.get(1).geometry);
    assert.ok(Array.isArray(instanced.material), 'multi-material aliases remain bucketable');
    assert.equal(instanced.material.length, 1);
    for (const nd of nodes) assert.equal(nodeMap.get(nd.h).visible, false);

    buckets.dispose();
    assert.equal(instanced.parent, null);
    for (const nd of nodes) assert.equal(nodeMap.get(nd.h).visible, true);

    // Live instOf keeps its source as a separately visible renderable; only
    // referrers are draw-substituted. This is distinct from static M3 aliases.
    const explicitRoot = new THREE.Group();
    const explicitMap = new Map();
    const sharedGeometry = new THREE.BufferGeometry();
    sharedGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
    ], 3));
    sharedGeometry.setIndex([0, 1, 2]);
    for (const h of [10, 11, 12]) {
        const original = new THREE.Mesh(sharedGeometry, new THREE.MeshBasicMaterial());
        explicitMap.set(h, original);
        explicitRoot.add(original);
    }
    const referrerGeometry = sharedGeometry.clone();
    referrerGeometry.clearGroups();
    referrerGeometry.addGroup(0, 3, 0);
    explicitMap.get(11).geometry = referrerGeometry;
    explicitMap.get(12).geometry = referrerGeometry;
    const explicitNodes = [
        { h: 10, t: IDENTITY, groups, mats },
        { h: 11, instOf: 10, t: IDENTITY, groups, mats },
        { h: 12, instOf: 10, t: IDENTITY, groups, mats },
    ];
    const explicitBuckets = createInstanceBuckets({
        nodeMap: explicitMap,
        root: explicitRoot,
        threshold: 2,
        materialKey: () => 'bark',
        buildMaterial: ({ nd }) => nd.mats.map(() => new THREE.MeshBasicMaterial()),
    });
    explicitBuckets.build(explicitNodes);
    const explicitInstanced = explicitRoot.children.find((child) => child.isInstancedMesh);
    assert.equal(explicitInstanced.geometry, referrerGeometry,
        'multi-material instOf buckets use the referrer group-table geometry');
    assert.equal(explicitMap.get(10).visible, true, 'live instOf source stays visible');
    assert.equal(explicitMap.get(11).visible, false);
    assert.equal(explicitMap.get(12).visible, false);
    explicitBuckets.dispose();
    sharedGeometry.dispose();
    referrerGeometry.dispose();
    for (const mesh of explicitMap.values()) mesh.material.dispose();

    assert.deepEqual(
        [...snapshotInstanceBucketExcludedHandles({
            animations: { clips: [{ targets: [{ target: 'handle:2', tracks: [] }] }] },
            runtimeScene: {
                hideMaxSyncHandles: [3],
                transformOverrides: [{ handle: 4 }],
            },
        })].sort((a, b) => a - b),
        [2, 3, 4],
        'handle-targeted snapshot behavior stays outside draw buckets',
    );
}

async function loaderCompatibilitySmoke() {
    assert.equal(validateM3Metadata({ type: 'scene_bin' }).type, 'scene_bin');
    assert.equal(validateM3Metadata({
        type: 'scene_bin',
        format: 'm3',
        formatVersion: 1,
        schemaVersion: 1,
        units: { label: 'cm', metersPerUnit: 0.01 },
    }).format, 'm3');
    assert.throws(() => validateM3Metadata({ format: 'm3', formatVersion: 2 }), /format version/);
    assert.throws(() => validateM3Metadata({ format: 'm3', units: { label: 'cm', metersPerUnit: 0 } }), /units/);
    assert.deepEqual(snapshotScenePayloadCandidates({}), ['scene.m3', 'scene.bin']);
    assert.deepEqual(snapshotScenePayloadCandidates({ bin: 'scene.bin' }), ['scene.bin']);
    assert.deepEqual(snapshotScenePayloadCandidates({ bin: 'custom/level.m3' }), ['custom/level.m3']);
    assert.equal(validateSnapshotScenePayloadName('custom/level.m3'), 'custom/level.m3');
    for (const unsafe of [
        '', '.', '../secret.m3', 'custom/../secret.m3', 'custom//scene.m3',
        'custom\\scene.m3', '/scene.m3', 'C:/scene.m3', 'https://host/scene.m3',
        'scene.m3?x=1', 'scene.m3#x', '%2e%2e/secret.m3', 'custom/%2fsecret.m3',
    ]) {
        assert.throws(() => validateSnapshotScenePayloadName(unsafe), /M3 scene payload name/);
    }

    const expected = new Uint8Array([1, 2, 3, 4]).buffer;
    const requests = [];
    const result = await fetchSnapshotScenePayload('/snapshot', {}, async (url) => {
        requests.push(url);
        if (url.endsWith('/scene.m3')) return { ok: false, status: 404 };
        return { ok: true, status: 200, arrayBuffer: async () => expected };
    });
    assert.deepEqual(requests, ['/snapshot/scene.m3', '/snapshot/scene.bin']);
    assert.equal(result.name, 'scene.bin');
    assert.deepEqual(new Uint8Array(result.buffer), new Uint8Array(expected));

    let customRequests = 0;
    await assert.rejects(
        fetchSnapshotScenePayload('/snapshot', { bin: 'custom.m3' }, async () => {
            customRequests++;
            return { ok: false, status: 404 };
        }),
        /custom\.m3/,
    );
    assert.equal(customRequests, 1, 'explicit custom filename must not silently fall back');
}

function sourceContractSmoke() {
    const snapshotSource = readFileSync(new URL('../src/maxjs_panel_snapshot_export.inl', import.meta.url), 'utf8');
    const fullSyncSource = readFileSync(new URL('../src/maxjs_panel_fullsync.inl', import.meta.url), 'utf8');
    const mimeSource = readFileSync(new URL('../src/maxjs_core_utils.h', import.meta.url), 'utf8');
    const extractorSource = readFileSync(new URL('../src/maxjs_scene_extractors.h', import.meta.url), 'utf8');
    for (const source of [snapshotSource, fullSyncSource]) {
        assert.match(source, /format\\\":\\\"m3/);
        assert.match(source, /formatVersion\\\":1/);
        assert.match(source, /schemaVersion\\\":1/);
        assert.match(source, /metersPerUnit\\\":0\.01/);
    }
    assert.match(snapshotSource, /bin\\\":\\\"scene\.m3/);
    assert.match(mimeSource, /L"\.m3"[\s\S]*application\/octet-stream/);
    assert.match(extractorSource, /GetSkinInitTM\(meshNode,\s*skinInitTM\)/,
        'snapshot skin roots use the official Skin bind basis');
    assert.match(extractorSource, /skin->GetRefFrame\(\)/,
        'broken Skin init TMs are checked against the Skin reference frame');
    assert.match(extractorSource, /referenceBasisMatches\s*>\s*skinBasisMatches/,
        'the legacy Daz world-basis fallback is evidence-gated');
    assert.match(snapshotSource, /IInstanceMgr::GetInstanceMgr\(\)/,
        'snapshot writer uses native Max instance truth for binary range aliasing');
    assert.match(snapshotSource, /SnapshotGeometryPayloadsEqual/,
        'snapshot writer verifies finalized geometry before aliasing M3 ranges');
    assert.match(snapshotSource, /binaryGeometryAlias/,
        'snapshot writer marks storage aliases without runtime instance metadata');
}

protocolGoldenSmoke();
m3RangeSmoke();
m3AliasedRangeDiagnosticsSmoke();
await m3AliasedGeometryReuseSmoke();
await m3AliasInstanceBucketSmoke();
await loaderCompatibilitySmoke();
sourceContractSmoke();
console.log('M3 + MXJB protocol smoke: PASS');
