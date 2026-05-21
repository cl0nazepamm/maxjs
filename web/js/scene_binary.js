// scene_binary.js — pure helpers for parsing the maxjs binary scene
// payload (`scene.bin`) into Three.js objects.
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
 * Range check for a [Float32 / Int32] buffer view of `n` elements at
 * byte offset `off`. Assumes the payload aligns to 4-byte boundaries (the
 * producer guarantees this).
 */
export function binInRange(buffer, off, n, bytesPerElement = 4) {
    const bytes = Number.isInteger(bytesPerElement) && bytesPerElement > 0 ? bytesPerElement : 4;
    return (
        Number.isInteger(off) &&
        Number.isInteger(n) &&
        off >= 0 &&
        n >= 0 &&
        (off % Math.min(bytes, 4)) === 0 &&
        (off + n * bytes) <= buffer.byteLength
    );
}

export function indexBytesForType(type) {
    const normalized = String(type ?? '').trim().toLowerCase();
    return normalized === 'u16' || normalized === 'uint16' ? 2 : 4;
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
    const source = new Int32Array(buffer, off, n);
    return copy ? new Uint32Array(source) : source;
}

function scalarBytesForType(type) {
    const normalized = String(type ?? '').trim().toLowerCase();
    if (normalized === 'u8' || normalized === 'uint8' || normalized === 'u8n' || normalized === 'uint8n') return 1;
    if (normalized === 'u16' || normalized === 'uint16' || normalized === 'u16n' || normalized === 'uint16n') return 2;
    if (normalized === 'i16' || normalized === 'int16' || normalized === 'i16n' || normalized === 'int16n') return 2;
    return 4;
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
    const normalize = normalized === 'i16n' || normalized === 'int16n';
    return new THREE.BufferAttribute(data, 3, normalize);
}

export function typedArrayCanStore(array, expectedLength) {
    try {
        return !!array
            && array.length >= expectedLength
            && array.buffer
            && array.buffer.byteLength >= array.byteOffset + expectedLength * array.BYTES_PER_ELEMENT;
    } catch {
        return false;
    }
}

export function updateFloatGeometryAttribute(geometry, name, buffer, off, n, itemSize) {
    if (!binInRange(buffer, off, n) || n % itemSize !== 0) {
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
 * Builds a `BufferGeometry` from a node descriptor + scene.bin buffer.
 *
 * Returns `null` if the descriptor's offsets are out of range. The caller
 * is responsible for material assignment, group additions, vertex-color
 * attribute updates, and skin attribute attachment — those have wider
 * dependencies that don't belong in a pure binary parser.
 */
export function geometryFromNodeBinary(nd, buffer) {
    const geo = nd?.geo;
    if (!geo) return null;
    if (!binInRange(buffer, geo.vOff, geo.vN) ||
        !binInRange(buffer, geo.iOff, geo.iN, indexBytesForType(geo.iType))) {
        console.warn('[scene_binary] Invalid vertex/index range for', nd.n);
        return null;
    }
    if (geo.uvOff != null && !binInRange(buffer, geo.uvOff, geo.uvN || 0, uvBytesForType(geo.uvType))) {
        console.warn('[scene_binary] Invalid UV range for', nd.n);
        return null;
    }
    if (geo.uv2Off != null && !binInRange(buffer, geo.uv2Off, geo.uv2N || 0, uvBytesForType(geo.uv2Type))) {
        console.warn('[scene_binary] Invalid UV2 range for', nd.n);
        return null;
    }

    // Defensive copy. Both views go through their typed-array constructors
    // a second time so the resulting buffers do not alias scene.bin (the
    // backing buffer outlives the geometry only when the snapshot file is
    // kept around — usually fine, but we want geometries to own their data).
    const verts = new Float32Array(new Float32Array(buffer, geo.vOff, geo.vN));
    const idx = indexArrayFromBinary(buffer, geo.iOff, geo.iN, geo.iType, { copy: true, label: `${nd.n || 'node'} index` });
    if (!idx) return null;

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));

    if (geo.uvOff != null && geo.uvN) {
        const uvAttr = uvAttributeFromBinary(buffer, geo.uvOff, geo.uvN, geo.uvType, `${nd.n || 'node'} uv`);
        if (uvAttr) out.setAttribute('uv', uvAttr);
    }
    if (geo.uv2Off != null && geo.uv2N) {
        const uv2Attr = uvAttributeFromBinary(buffer, geo.uv2Off, geo.uv2N, geo.uv2Type, `${nd.n || 'node'} uv2`);
        // three r184 lightMap samples geometry attribute "uv1".
        // Keep "uv2" as a compatibility/debug alias for Max map channel 2.
        if (uv2Attr) {
            out.setAttribute('uv1', uv2Attr);
            out.setAttribute('uv2', uv2Attr);
        }
    }
    if (geo.nOff != null && binInRange(buffer, geo.nOff, geo.nN || 0, normalBytesForType(geo.nType))) {
        const normalAttr = normalAttributeFromBinary(buffer, geo.nOff, geo.nN, geo.nType, `${nd.n || 'node'} normal`);
        if (normalAttr) out.setAttribute('normal', normalAttr);
    } else if (!nd.spline) {
        out.computeVertexNormals();
    }

    return out;
}

/**
 * Attaches skin (skinWeight + skinIndex) and morph-target attributes to a
 * geometry already built by `geometryFromNodeBinary`. Splines never carry
 * skin — caller should guard.
 */
export function attachSkinAttributes(geom, nd, buffer) {
    if (!geom || !nd?.skin || nd.spline) return;
    const sk = nd.skin;
    if (Number.isInteger(sk.wOff) && Number.isInteger(sk.wN) &&
        Number.isInteger(sk.iOff) && Number.isInteger(sk.iN)) {
        const weightAttr = skinWeightAttributeFromBinary(buffer, sk.wOff, sk.wN, sk.wType);
        const indexAttr = skinIndexAttributeFromBinary(buffer, sk.iOff, sk.iN, sk.iType);
        if (weightAttr && indexAttr) {
            geom.setAttribute('skinWeight', weightAttr);
            geom.setAttribute('skinIndex', indexAttr);
        }
    }
    if (nd.morph?.dOff?.length && nd.morph?.dN?.length && nd.morph?.names?.length) {
        geom.morphAttributes = { position: [] };
        for (let mi = 0; mi < nd.morph.names.length; mi++) {
            const off = nd.morph.dOff[mi];
            const cnt = nd.morph.dN[mi];
            if (!binInRange(buffer, off, cnt)) continue;
            const d = new Float32Array(new Float32Array(buffer, off, cnt));
            const attr = new THREE.BufferAttribute(d, 3);
            attr.name = String(nd.morph.names[mi] ?? `morph_${mi}`);
            geom.morphAttributes.position.push(attr);
        }
        if (geom.morphAttributes.position.length > 0) {
            geom.morphTargetRelative = true;
        }
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
    if (!nB || !geom) return null;

    const bones = [];
    for (let i = 0; i < nB; i++) {
        const bone = new THREE.Bone();
        bone.name = `bone_${i}`;
        const bo = sk.bindOff + i * 16 * 4;
        if (binInRange(buffer, bo, 16)) {
            bone.matrix.fromArray(new Float32Array(buffer, bo, 16));
            bone.matrix.decompose(bone.position, bone.quaternion, bone.scale);
        }
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
