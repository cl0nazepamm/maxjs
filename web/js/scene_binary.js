// scene_binary.js — pure helpers for parsing the max.js M3 scene payload
// (`scene.m3`; legacy snapshots may call the same bytes `scene.bin`) into
// Three.js objects.
//
// Lifted from inline code in web/index.html so both the live applier
// (`handleBinaryScene` in index.html) and the snapshot applier (future
// `js/scene_applier.js`) can share one canonical implementation.
//
// Scope: pure shared-buffer geometry pieces only. Scene ownership,
// vertex-color descriptors, and material building stay in the caller because
// they depend on live viewer registries and layer state.

import * as THREE from 'three';

/**
 * Range check for a typed buffer view of `n` elements at byte offset `off`.
 * Rejects unsafe integers and arithmetic overflow before a TypedArray
 * constructor can observe the descriptor.
 */
export function binInRange(buffer, off, n, bytesPerElement = 4) {
    if (!Number.isSafeInteger(off) || off < 0 ||
        !Number.isSafeInteger(n) || n < 0 ||
        !Number.isSafeInteger(bytesPerElement) || bytesPerElement <= 0) {
        return false;
    }

    let byteLength;
    try {
        // DataView performs the platform's real ArrayBuffer/SharedArrayBuffer
        // brand check; a plain object with a forged byteLength is not enough.
        byteLength = new DataView(buffer).byteLength;
    } catch {
        return false;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return false;

    const byteCount = n * bytesPerElement;
    if (!Number.isSafeInteger(byteCount)) return false;
    const end = off + byteCount;
    if (!Number.isSafeInteger(end)) return false;

    const alignment = Math.min(bytesPerElement, 4);
    return off % alignment === 0 && end <= byteLength;
}

export function indexBytesForType(type) {
    const normalized = String(type ?? '').trim().toLowerCase();
    if (normalized === 'u16' || normalized === 'uint16') return 2;
    if (!normalized || normalized === 'i32' || normalized === 'int32' ||
        normalized === 'u32' || normalized === 'uint32') return 4;
    return 0;
}

export function indexArrayFromBinary(buffer, off, n, type = '', { copy = true, label = 'index' } = {}) {
    const bytes = indexBytesForType(type);
    if (!binInRange(buffer, off, n, bytes)) {
        console.warn(`[max.js binary] Invalid ${label} range`);
        return null;
    }
    if (bytes === 2) {
        const source = new Uint16Array(buffer, off, n);
        return copy ? new Uint16Array(source) : source;
    }
    const unsigned = normalizedIndexType(type) === 'u32';
    const source = unsigned ? new Uint32Array(buffer, off, n) : new Int32Array(buffer, off, n);
    if (!copy) return source;
    return new Uint32Array(source);
}

function normalizedIndexType(type) {
    const normalized = String(type ?? '').trim().toLowerCase();
    if (normalized === 'u16' || normalized === 'uint16') return 'u16';
    if (normalized === 'u32' || normalized === 'uint32') return 'u32';
    return 'i32';
}

function scalarBytesForType(type) {
    const normalized = String(type ?? '').trim().toLowerCase();
    if (normalized === 'u8' || normalized === 'uint8' || normalized === 'u8n' || normalized === 'uint8n') return 1;
    if (normalized === 'u16' || normalized === 'uint16' || normalized === 'u16n' || normalized === 'uint16n') return 2;
    if (normalized === 'i16' || normalized === 'int16' || normalized === 'i16n' || normalized === 'int16n') return 2;
    if (!normalized || normalized === 'f32' || normalized === 'float32') return 4;
    return 0;
}

function scalarArrayFromBinary(buffer, off, n, type = '', { copy = true, label = 'attribute' } = {}) {
    const normalized = String(type ?? '').trim().toLowerCase();
    const bytes = scalarBytesForType(normalized);
    if (!binInRange(buffer, off, n, bytes)) {
        console.warn(`[max.js binary] Invalid ${label} range`);
        return null;
    }
    if (bytes === 1) {
        const source = new Uint8Array(buffer, off, n);
        return copy ? new Uint8Array(source) : source;
    }
    if (bytes === 2) {
        const signed = normalized === 'i16' || normalized === 'int16' ||
            normalized === 'i16n' || normalized === 'int16n';
        if (signed) {
            const source = new Int16Array(buffer, off, n);
            return copy ? new Int16Array(source) : source;
        }
        const source = new Uint16Array(buffer, off, n);
        return copy ? new Uint16Array(source) : source;
    }
    const source = new Float32Array(buffer, off, n);
    return copy ? new Float32Array(source) : source;
}

function normalizedInt16ToFloat32(source) {
    const out = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) {
        out[i] = Math.max(-1, source[i] / 32767);
    }
    return out;
}

function skinWeightAttributeFromBinary(buffer, off, n, type = '') {
    const normalized = String(type ?? '').trim().toLowerCase();
    const data = scalarArrayFromBinary(buffer, off, n, normalized, { copy: true, label: 'skin weight' });
    if (!data) return null;
    const normalize = normalized === 'u8n' || normalized === 'uint8n' ||
        normalized === 'u16n' || normalized === 'uint16n';
    return new THREE.BufferAttribute(data, 4, normalize);
}

function skinIndexAttributeFromBinary(buffer, off, n, type = '') {
    const data = scalarArrayFromBinary(buffer, off, n, type, { copy: true, label: 'skin index' });
    return data ? new THREE.BufferAttribute(data, 4) : null;
}

export function normalBytesForType(type) {
    return scalarBytesForType(type);
}

export function uvBytesForType(type) {
    return scalarBytesForType(type);
}

export function uvAttributeFromBinary(buffer, off, n, type = '', label = 'uv') {
    const normalized = String(type ?? '').trim().toLowerCase();
    const data = scalarArrayFromBinary(buffer, off, n, normalized, { copy: true, label });
    if (!data) return null;
    const normalize = normalized === 'u16n' || normalized === 'uint16n';
    return new THREE.BufferAttribute(data, 2, normalize);
}

export function normalAttributeFromBinary(buffer, off, n, type = '', label = 'normal') {
    const normalized = String(type ?? '').trim().toLowerCase();
    const data = scalarArrayFromBinary(buffer, off, n, normalized, { copy: true, label });
    if (!data) return null;
    if (normalized === 'i16n' || normalized === 'int16n') {
        // WebGPU rejects 3-component Int16 vertex attributes because the
        // resulting 6-byte stride is not 4-byte aligned. Expand packed normals
        // to Float32 while preserving the same normalized values.
        return new THREE.BufferAttribute(normalizedInt16ToFloat32(data), 3);
    }
    const normalize = false;
    return new THREE.BufferAttribute(data, 3, normalize);
}

export function typedArrayCanStore(array, expectedLength) {
    try {
        if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 ||
            !Number.isSafeInteger(array?.BYTES_PER_ELEMENT) || array.BYTES_PER_ELEMENT <= 0 ||
            !Number.isSafeInteger(array?.byteOffset) || array.byteOffset < 0) {
            return false;
        }
        const expectedBytes = expectedLength * array.BYTES_PER_ELEMENT;
        if (!Number.isSafeInteger(expectedBytes)) return false;
        const end = array.byteOffset + expectedBytes;
        return !!array
            && array.length >= expectedLength
            && array.buffer
            && Number.isSafeInteger(end)
            && array.buffer.byteLength >= end;
    } catch {
        return false;
    }
}

export function updateFloatGeometryAttribute(geometry, name, buffer, off, n, itemSize) {
    if (!Number.isSafeInteger(itemSize) || itemSize <= 0 ||
        !binInRange(buffer, off, n) || n % itemSize !== 0) {
        console.warn('[max.js binary] Invalid attribute range for', name);
        return false;
    }
    const source = new Float32Array(buffer, off, n);
    const count = n / itemSize;
    const current = geometry.getAttribute(name);
    if (
        current
        && current.itemSize === itemSize
        && current.count === count
        && typedArrayCanStore(current.array, n)
    ) {
        current.array.set(source);
        current.needsUpdate = true;
        return true;
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(source), itemSize));
    return true;
}

export function updateGeometryIndexAttribute(geometry, buffer, off, n, type = '') {
    const source = indexArrayFromBinary(buffer, off, n, type, { copy: false, label: 'index' });
    if (!source) return false;
    const current = geometry.getIndex();
    if (
        current &&
        current.count === n &&
        typedArrayCanStore(current.array, n) &&
        current.array.BYTES_PER_ELEMENT >= source.BYTES_PER_ELEMENT
    ) {
        // Deform settle packets re-send an unchanged index. Bumping the
        // attribute version there re-uploads the buffer AND reads as a
        // connectivity change to every structural change-detector downstream
        // (HALO-GI/PT geoSignature → full MeshBVH rebuild + kernel recompile
        // on scrub release). Byte-identical indices must be a no-op.
        const dst = current.array;
        let changed = false;
        for (let i = 0; i < n; i++) {
            if (dst[i] !== source[i]) { changed = true; break; }
        }
        if (!changed) return 'unchanged';
        current.array.set(source);
        current.needsUpdate = true;
        return true;
    }
    const owned = indexArrayFromBinary(buffer, off, n, type, { copy: true, label: 'index' });
    if (!owned) return false;
    geometry.setIndex(new THREE.BufferAttribute(owned, 1));
    return true;
}

/**
 * Builds a `BufferGeometry` from a node descriptor + M3 buffer.
 *
 * Returns `null` if the descriptor's offsets are out of range. The caller
 * is responsible for material assignment, group additions, vertex-color
 * attribute updates, and skin attribute attachment — those have wider
 * dependencies that don't belong in a pure binary parser.
 */
export function geometryFromNodeBinary(nd, buffer) {
    const geo = nd?.geo;
    if (!geo) return null;
    const primitiveSize = nd.spline ? 2 : 3;
    if (!Number.isSafeInteger(geo.vN) || geo.vN % 3 !== 0 ||
        !Number.isSafeInteger(geo.iN) || geo.iN % primitiveSize !== 0 ||
        !binInRange(buffer, geo.vOff, geo.vN) ||
        !binInRange(buffer, geo.iOff, geo.iN, indexBytesForType(geo.iType))) {
        console.warn('[scene_binary] Invalid vertex/index range for', nd.n);
        return null;
    }
    if (geo.uvOff != null &&
        (!Number.isSafeInteger(geo.uvN) || geo.uvN % 2 !== 0 ||
         geo.uvN / 2 !== geo.vN / 3 ||
         !binInRange(buffer, geo.uvOff, geo.uvN, uvBytesForType(geo.uvType)))) {
        console.warn('[scene_binary] Invalid UV range for', nd.n);
        return null;
    }
    if (geo.uv2Off != null &&
        (!Number.isSafeInteger(geo.uv2N) || geo.uv2N % 2 !== 0 ||
         geo.uv2N / 2 !== geo.vN / 3 ||
         !binInRange(buffer, geo.uv2Off, geo.uv2N, uvBytesForType(geo.uv2Type)))) {
        console.warn('[scene_binary] Invalid UV2 range for', nd.n);
        return null;
    }
    if (geo.nOff != null &&
        (!Number.isSafeInteger(geo.nN) || geo.nN % 3 !== 0 ||
         geo.nN !== geo.vN ||
         !binInRange(buffer, geo.nOff, geo.nN, normalBytesForType(geo.nType)))) {
        console.warn('[scene_binary] Invalid normal range for', nd.n);
        return null;
    }

    // Defensive copy. Both views go through their typed-array constructors
    // a second time so the resulting buffers do not alias scene.m3 (the
    // backing buffer outlives the geometry only when the snapshot file is
    // kept around — usually fine, but we want geometries to own their data).
    const verts = new Float32Array(new Float32Array(buffer, geo.vOff, geo.vN));
    const idx = indexArrayFromBinary(buffer, geo.iOff, geo.iN, geo.iType, { copy: true, label: `${nd.n || 'node'} index` });
    if (!idx) return null;
    const vertexCount = geo.vN / 3;
    for (let i = 0; i < idx.length; i++) {
        if (idx[i] >= vertexCount) {
            console.warn('[scene_binary] Index exceeds vertex count for', nd.n);
            return null;
        }
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));

    if (geo.uvOff != null && geo.uvN) {
        const uvAttr = uvAttributeFromBinary(buffer, geo.uvOff, geo.uvN, geo.uvType, `${nd.n || 'node'} uv`);
        if (uvAttr) out.setAttribute('uv', uvAttr);
    }
    if (geo.uv2Off != null && geo.uv2N) {
        const uv2Attr = uvAttributeFromBinary(buffer, geo.uv2Off, geo.uv2N, geo.uv2Type, `${nd.n || 'node'} uv2`);
        // three r185 lightMap samples geometry attribute "uv1".
        // Keep "uv2" as a compatibility/debug alias for Max map channel 2.
        if (uv2Attr) {
            out.setAttribute('uv1', uv2Attr);
            out.setAttribute('uv2', uv2Attr);
        }
    }
    if (geo.nOff != null && geo.nN > 0) {
        const normalAttr = normalAttributeFromBinary(buffer, geo.nOff, geo.nN, geo.nType, `${nd.n || 'node'} normal`);
        if (normalAttr) out.setAttribute('normal', normalAttr);
    } else if (!nd.spline) {
        out.computeVertexNormals();
    }

    return out;
}

/**
 * Attaches skin (skinWeight + skinIndex) attributes to a geometry already built
 * by `geometryFromNodeBinary`. Splines never carry skin — caller should guard.
 * Morph targets are handled separately by `attachMorphAttributes` so plain
 * (non-skinned) meshes can carry them too.
 */
export function attachSkinAttributes(geom, nd, buffer) {
    if (!geom || !nd?.skin || nd.spline) return;
    const sk = nd.skin;
    const positionCount = geom.getAttribute('position')?.count;
    const expectedScalars = Number.isSafeInteger(positionCount) ? positionCount * 4 : -1;
    if (!Number.isSafeInteger(expectedScalars) || expectedScalars < 0 ||
        !Number.isSafeInteger(sk.wOff) || !Number.isSafeInteger(sk.wN) || sk.wN % 4 !== 0 ||
        !Number.isSafeInteger(sk.iOff) || !Number.isSafeInteger(sk.iN) || sk.iN % 4 !== 0 ||
        sk.wN !== sk.iN || sk.wN !== expectedScalars) {
        console.warn('[scene_binary] Invalid skin attribute descriptor for', nd.n);
        return;
    }
    const weightAttr = skinWeightAttributeFromBinary(buffer, sk.wOff, sk.wN, sk.wType);
    const indexAttr = skinIndexAttributeFromBinary(buffer, sk.iOff, sk.iN, sk.iType);
    if (weightAttr && indexAttr) {
        const boneCount = sk.bones?.length;
        if (!Number.isSafeInteger(boneCount) || boneCount <= 0) {
            console.warn('[scene_binary] Invalid skin bone table for', nd.n);
            return;
        }
        for (const index of indexAttr.array) {
            if (!Number.isSafeInteger(index) || index < 0 || index >= boneCount) {
                console.warn('[scene_binary] Skin index exceeds bone table for', nd.n);
                return;
            }
        }
        geom.setAttribute('skinWeight', weightAttr);
        geom.setAttribute('skinIndex', indexAttr);
    }
}

/**
 * Attaches Three.js morph-target attributes (relative position deltas) to a
 * geometry built by `geometryFromNodeBinary`. Skin-independent: any mesh whose
 * node descriptor carries `nd.morph` gets morph targets. No-op otherwise.
 */
export function attachMorphAttributes(geom, nd, buffer) {
    if (!geom || nd?.spline) return;
    if (!(nd.morph?.dOff?.length && nd.morph?.dN?.length && nd.morph?.names?.length)) return;
    const basePosition = geom.getAttribute('position');
    const expectedFloats = basePosition?.count * 3;
    if (!Number.isSafeInteger(expectedFloats) || expectedFloats <= 0 || expectedFloats % 3 !== 0) return;
    const channelCount = nd.morph.names.length;
    if (nd.morph.dOff.length < channelCount || nd.morph.dN.length < channelCount) return;
    const positions = [];
    for (let mi = 0; mi < channelCount; mi++) {
        const off = nd.morph.dOff[mi];
        const cnt = nd.morph.dN[mi];
        if (cnt !== expectedFloats || !binInRange(buffer, off, cnt)) {
            const label = nd.name || nd.n || nd.h || 'mesh';
            console.warn('[max.js] skipped malformed morph payload', {
                mesh: label,
                morph: nd.morph.names[mi],
                expectedFloats,
                gotFloats: cnt
            });
            return;
        }
        // Defensive copy so the attribute owns its data (does not alias scene.m3).
        const d = new Float32Array(new Float32Array(buffer, off, cnt));
        const attr = new THREE.BufferAttribute(d, 3);
        attr.name = String(nd.morph.names[mi] ?? `morph_${mi}`);
        positions.push(attr);
    }
    if (positions.length > 0) {
        geom.morphAttributes = { position: positions };
        // Exported deltas are relative to the base shape (Three.js spec property is
        // `morphTargetsRelative`, plural — the singular form is silently ignored).
        geom.morphTargetsRelative = true;
    }
}

/**
 * Assembles a `THREE.SkinnedMesh` from a node descriptor + bind-pose
 * matrices in the binary buffer. Lifts `buildSkinnedMeshFromNd` out of
 * index.html.
 *
 * `nodeMap` is required so the bones can be registered under their
 * scoped key (`${meshHandle}:${boneHandle}`) — the AnimationMixer
 * resolves bone targets through this map.
 */
export function buildSkinnedMeshFromNd({ nd, geom, material, buffer, nodeMap }) {
    const sk = nd?.skin;
    const nB = sk?.bones?.length ?? 0;
    if (!Number.isSafeInteger(nB) || nB <= 0 || !geom ||
        !geom.getAttribute('skinWeight') || !geom.getAttribute('skinIndex') ||
        !Array.isArray(sk.parent) || sk.parent.length !== nB ||
        !Number.isSafeInteger(sk.bindOff)) {
        return null;
    }
    const bindScalarCount = nB * 16;
    if (!Number.isSafeInteger(bindScalarCount) ||
        (sk.bindN != null && sk.bindN !== bindScalarCount) ||
        !binInRange(buffer, sk.bindOff, bindScalarCount)) {
        console.warn('[scene_binary] Invalid skin bind range for', nd.n);
        return null;
    }
    for (let i = 0; i < nB; i++) {
        const parentIndex = sk.parent[i];
        if (!Number.isSafeInteger(parentIndex) || parentIndex < -1 || parentIndex >= nB || parentIndex === i) {
            console.warn('[scene_binary] Invalid skin parent table for', nd.n);
            return null;
        }
    }
    for (let i = 0; i < nB; i++) {
        const parentIndex = sk.parent[i];
        let cursor = parentIndex;
        let depth = 0;
        while (cursor >= 0) {
            if (cursor === i || depth++ >= nB) {
                console.warn('[scene_binary] Cyclic skin parent table for', nd.n);
                return null;
            }
            cursor = sk.parent[cursor];
        }
    }

    const bones = [];
    for (let i = 0; i < nB; i++) {
        const bone = new THREE.Bone();
        bone.name = `bone_${i}`;
        const bo = sk.bindOff + i * 16 * 4;
        bone.matrix.fromArray(new Float32Array(buffer, bo, 16));
        bone.matrix.decompose(bone.position, bone.quaternion, bone.scale);
        bone.matrixAutoUpdate = false;
        bones.push(bone);
    }

    const skinned = new THREE.SkinnedMesh(geom, material);
    skinned.matrixAutoUpdate = false;

    // Wire parent → child according to sk.parent indices. Guard against
    // dependency cycles by capping iterations (same behavior as the
    // inline implementation; in practice nB * 4 is overkill).
    const pending = new Set(bones.map((_, i) => i));
    let guard = 0;
    while (pending.size > 0 && guard++ < nB * 4) {
        for (const i of [...pending]) {
            const pi = sk.parent[i];
            if (pi < 0) {
                skinned.add(bones[i]);
                pending.delete(i);
            } else if (!pending.has(pi)) {
                bones[pi].add(bones[i]);
                pending.delete(i);
            }
        }
    }
    for (const i of pending) skinned.add(bones[i]);

    skinned.bind(new THREE.Skeleton(bones));
    skinned.userData.maxjsSkinRig = true;

    if (nd.morph?.names?.length) {
        const nM = nd.morph.names.length;
        skinned.morphTargetInfluences = nd.morph.infl?.length === nM
            ? nd.morph.infl.slice()
            : new Array(nM).fill(0);
    }

    if (nodeMap) {
        for (let i = 0; i < nB; i++) {
            const h = sk.bones[i];
            if (h) {
                const scopedKey = `${nd.h}:${h}`;
                bones[i].userData.maxjsHandle = scopedKey;
                nodeMap.set(scopedKey, bones[i]);
            }
        }
    }

    return skinned;
}
