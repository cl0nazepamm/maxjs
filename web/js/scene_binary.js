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
export function binInRange(buffer, off, n) {
    return (
        Number.isInteger(off) &&
        Number.isInteger(n) &&
        off >= 0 &&
        n >= 0 &&
        (off % 4) === 0 &&
        (off + n * 4) <= buffer.byteLength
    );
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

export function updateGeometryIndexAttribute(geometry, buffer, off, n) {
    if (!binInRange(buffer, off, n)) {
        console.warn('[max.js binary] Invalid index range');
        return false;
    }
    const source = new Int32Array(buffer, off, n);
    const current = geometry.getIndex();
    if (current && current.count === n && typedArrayCanStore(current.array, n)) {
        current.array.set(source);
        current.needsUpdate = true;
        return true;
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(source), 1));
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
    if (!binInRange(buffer, geo.vOff, geo.vN) || !binInRange(buffer, geo.iOff, geo.iN)) {
        console.warn('[scene_binary] Invalid vertex/index range for', nd.n);
        return null;
    }
    if (geo.uvOff != null && !binInRange(buffer, geo.uvOff, geo.uvN || 0)) {
        console.warn('[scene_binary] Invalid UV range for', nd.n);
        return null;
    }
    if (geo.uv2Off != null && !binInRange(buffer, geo.uv2Off, geo.uv2N || 0)) {
        console.warn('[scene_binary] Invalid UV2 range for', nd.n);
        return null;
    }

    // Defensive copy. Both views go through their typed-array constructors
    // a second time so the resulting buffers do not alias scene.bin (the
    // backing buffer outlives the geometry only when the snapshot file is
    // kept around — usually fine, but we want geometries to own their data).
    const verts = new Float32Array(new Float32Array(buffer, geo.vOff, geo.vN));
    const idx   = new Uint32Array(new Int32Array(buffer, geo.iOff, geo.iN));

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));

    if (geo.uvOff != null && geo.uvN) {
        const uvs = new Float32Array(new Float32Array(buffer, geo.uvOff, geo.uvN));
        out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }
    if (geo.uv2Off != null && geo.uv2N) {
        const uv2 = new Float32Array(new Float32Array(buffer, geo.uv2Off, geo.uv2N));
        // three r184 lightMap samples geometry attribute "uv1".
        // Keep "uv2" as a compatibility/debug alias for Max map channel 2.
        const attr = new THREE.BufferAttribute(uv2, 2);
        out.setAttribute('uv1', attr);
        out.setAttribute('uv2', attr);
    }
    if (geo.nOff != null && binInRange(buffer, geo.nOff, geo.nN || 0)) {
        const norms = new Float32Array(new Float32Array(buffer, geo.nOff, geo.nN));
        out.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
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
    if (binInRange(buffer, sk.wOff, sk.wN) && binInRange(buffer, sk.iOff, sk.iN)) {
        const w = new Float32Array(new Float32Array(buffer, sk.wOff, sk.wN));
        const i = new Float32Array(new Float32Array(buffer, sk.iOff, sk.iN));
        geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
        geom.setAttribute('skinIndex',  new THREE.Float32BufferAttribute(i, 4));
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
