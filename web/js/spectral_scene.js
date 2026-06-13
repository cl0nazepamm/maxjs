// spectral_scene.js — CPU build pipeline for the WebGPU spectral path tracer.
//
// Flattens the visible scene (meshes + InstancedMesh instances) into ONE
// world-space indexed triangle soup, dedupes materials into a flat uber
// table, builds a CPU MeshBVH (three-mesh-bvh), and re-flattens the BVH to a
// STACKLESS threaded layout (each node carries a single "miss"/escape index)
// so the GPU traversal is one loop with no traversal stack.
//
// Output is plain typed arrays + counts; spectral_kernel turns them into
// StorageBufferAttributes. Nothing here touches the GPU.
//
// Accuracy is explicitly not a goal — see who-cares-man plan. Materials are
// read as scalar PBR fields off the live material (works for every
// Standard/Physical/Lambert/Phong/Basic node material; TSL/MaterialX graphs
// fall back to their scalar values, same limitation as the old WebGL tracer).

import { MeshBVH } from 'three-mesh-bvh';

const NODE_STRIDE_U32 = 8;     // bvhNodes: 6 aabb floats + miss + payload
const MAT_STRIDE = 12;         // materials: see layout below
const LIGHT_STRIDE = 16;       // lights: see layout below
const VERT_STRIDE = 3;         // vertexPos: tightly packed xyz (flat f32 storage, read by offset; also fed to MeshBVH which assumes stride 3)
const BYTES_PER_BVH_NODE = 32; // three-mesh-bvh BYTES_PER_NODE (8 x u32)

const SKY_NAMES = new Set(['__maxjs_sky__']);

function meshMaterials(mesh) {
    if (!mesh?.material) return [];
    return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function isTraceableGeometry(geometry) {
    const pos = geometry?.attributes?.position;
    return !!(pos && pos.count >= 3 && pos.itemSize >= 3 && pos.array);
}

function isTraceableMesh(object) {
    if (!object?.isMesh && !object?.isInstancedMesh) return false;
    if (object.isSkinnedMesh) return false; // bind-pose only; skip for now
    if (SKY_NAMES.has(object.name)) return false;
    if (!object.visible) return false;
    if (!isTraceableGeometry(object.geometry)) return false;
    return meshMaterials(object).length > 0;
}

// ── Uber material mapping ──────────────────────────────────────────
// One flat record maps every material model to: baseColor, roughness,
// metalness, transmission, ior, emissive*intensity, opacity, dispersionB.
// Reads linear-space color components directly (Three stores working-space).

function emissiveScaled(material, out) {
    const e = material.emissive;
    const k = Number.isFinite(material.emissiveIntensity) ? material.emissiveIntensity : 1;
    if (e?.isColor) { out[0] = e.r * k; out[1] = e.g * k; out[2] = e.b * k; }
    else { out[0] = 0; out[1] = 0; out[2] = 0; }
    return out;
}

function materialToUber(material) {
    const color = material.color;
    const r = color?.isColor ? color.r : 1;
    const g = color?.isColor ? color.g : 1;
    const b = color?.isColor ? color.b : 1;

    // Roughness/metalness exist on Standard/Physical; derive sane values for
    // the rest. Phong shininess → roughness; Basic/Lambert → fully diffuse.
    let roughness = Number.isFinite(material.roughness) ? material.roughness : null;
    let metalness = Number.isFinite(material.metalness) ? material.metalness : 0;
    if (roughness == null) {
        if (Number.isFinite(material.shininess)) {
            const s = Math.max(0, material.shininess);
            roughness = Math.sqrt(2 / (s + 2)); // Phong exponent → roughness
        } else {
            roughness = 1;
        }
    }
    const transmission = Number.isFinite(material.transmission) ? material.transmission : 0;
    const ior = Number.isFinite(material.ior) ? material.ior : 1.5;
    const opacity = Number.isFinite(material.opacity) ? material.opacity : 1;
    const em = emissiveScaled(material, [0, 0, 0]);
    // Dispersion strength: the kernel reads this as the per-wavelength IOR
    // spread n(λ) = ior ± dispersionB across the visible band. three's
    // MeshPhysicalMaterial.dispersion drives it (0 = none).
    const dispersionB = Number.isFinite(material.dispersion) ? material.dispersion : 0;

    return [r, g, b,
        Math.min(1, Math.max(0.02, roughness)),
        Math.min(1, Math.max(0, metalness)),
        Math.min(1, Math.max(0, transmission)),
        Math.max(1, ior),
        em[0], em[1], em[2],
        Math.min(1, Math.max(0, opacity)),
        dispersionB];
}

function uberKey(rec) {
    let k = '';
    for (let i = 0; i < MAT_STRIDE; i++) k += Math.round(rec[i] * 1000) + ':';
    return k;
}

// ── Threaded (stackless) BVH re-flatten ────────────────────────────
// three-mesh-bvh node layout (BYTES_PER_NODE = 32, addressed in 32-bit
// words): bounds = float bits [n32+0..5]; leaf test u16[n32*2+15]===0xFFFF;
// leaf: triOffset=u32[n32+6] (tri units), triCount=u16[n32*2+14]; internal:
// left child = n32+8 (contiguous in source), right child word = u32[n32+6].
// We re-emit DFS so the LEFT child is contiguous (idx+1) in the output and
// every node gets a single escape/miss index = first node after its subtree.

function flattenBVHRoot(rootBuffer) {
    const f32 = new Float32Array(rootBuffer);
    const u16 = new Uint16Array(rootBuffer);
    const u32 = new Uint32Array(rootBuffer);

    const records = []; // { bx[6], leaf, triOffset, triCount, miss }

    // Iterative DFS with an explicit worklist so deep/unbalanced trees can't
    // overflow the JS call stack. We need each node's miss index to equal the
    // output position immediately AFTER its whole subtree, so we record a
    // node, push a "finalize" marker, then push its children (right first so
    // left is processed next → contiguous idx+1).
    const work = [{ n32: 0, kind: 'visit' }];

    while (work.length > 0) {
        const item = work.pop();
        if (item.kind === 'finalize') {
            records[item.idx].miss = records.length;
            continue;
        }
        const n32 = item.n32;
        const isLeaf = u16[n32 * 2 + 15] === 0xFFFF;
        const idx = records.length;
        const rec = {
            bx: [f32[n32], f32[n32 + 1], f32[n32 + 2], f32[n32 + 3], f32[n32 + 4], f32[n32 + 5]],
            leaf: isLeaf,
            triOffset: 0,
            triCount: 0,
            miss: 0,
        };
        records.push(rec);
        if (isLeaf) {
            rec.triOffset = u32[n32 + 6];
            rec.triCount = u16[n32 * 2 + 14];
            rec.miss = records.length; // escape = next slot
        } else {
            const leftN32 = n32 + 8;
            const rightN32 = u32[n32 + 6];
            // finalize sets miss AFTER both children are flattened
            work.push({ kind: 'finalize', idx });
            work.push({ kind: 'visit', n32: rightN32 });
            work.push({ kind: 'visit', n32: leftN32 });
        }
    }

    // Serialize to one Uint32Array (bounds stored as float bits).
    const nodeCount = records.length;
    const buf = new ArrayBuffer(nodeCount * NODE_STRIDE_U32 * 4);
    const outF = new Float32Array(buf);
    const outU = new Uint32Array(buf);
    for (let i = 0; i < nodeCount; i++) {
        const base = i * NODE_STRIDE_U32;
        const rec = records[i];
        outF[base + 0] = rec.bx[0]; outF[base + 1] = rec.bx[1]; outF[base + 2] = rec.bx[2];
        outF[base + 3] = rec.bx[3]; outF[base + 4] = rec.bx[4]; outF[base + 5] = rec.bx[5];
        outU[base + 6] = rec.miss >>> 0;
        outU[base + 7] = rec.leaf
            ? (((rec.triCount & 0xFF) << 24) | (rec.triOffset & 0x00FFFFFF)) >>> 0
            : 0xFFFFFFFF;
    }
    return { nodes: outU, nodeCount };
}

// ── Light extraction ───────────────────────────────────────────────
// Layout (stride 16 floats): [0] type(0 dir/1 point/2 spot/3 rect),
// [1..3] worldPos, [4..6] worldDir (toward target), [7..9] color*intensity,
// [10] range, [11] decay, [12] cosAngle, [13] cosPenumbra, [14] w, [15] h.

function collectLights(THREE, scene) {
    const out = [];
    const pos = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const tgt = new THREE.Vector3();
    scene.traverseVisible((obj) => {
        if (!obj.isLight) return;
        if (obj.isAmbientLight || obj.isHemisphereLight) return; // folded into env
        obj.updateWorldMatrix(true, false);
        obj.getWorldPosition(pos);
        const c = obj.color, k = Number.isFinite(obj.intensity) ? obj.intensity : 1;
        const cr = (c?.isColor ? c.r : 1) * k;
        const cg = (c?.isColor ? c.g : 1) * k;
        const cb = (c?.isColor ? c.b : 1) * k;
        let type = 1, range = 0, decay = 2, cosAngle = -1, cosPen = -1, w = 0, h = 0;
        dir.set(0, 0, -1);
        if (obj.isDirectionalLight || obj.isSpotLight) {
            type = obj.isSpotLight ? 2 : 0;
            obj.target?.updateWorldMatrix?.(true, false);
            obj.target?.getWorldPosition(tgt);
            dir.copy(tgt).sub(pos).normalize();
            if (obj.isSpotLight) {
                const angle = Number.isFinite(obj.angle) ? obj.angle : Math.PI / 4;
                const pen = Number.isFinite(obj.penumbra) ? obj.penumbra : 0;
                cosAngle = Math.cos(angle);
                cosPen = Math.cos(angle * (1 - pen));
                range = obj.distance || 0;
                decay = Number.isFinite(obj.decay) ? obj.decay : 2;
            }
        } else if (obj.isPointLight) {
            type = 1;
            range = obj.distance || 0;
            decay = Number.isFinite(obj.decay) ? obj.decay : 2;
        } else if (obj.isRectAreaLight) {
            // Phase 1: treat as a point light at its center (orientation deferred).
            type = 1;
            w = obj.width || 0; h = obj.height || 0;
        } else {
            return;
        }
        out.push([type, pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, cr, cg, cb, range, decay, cosAngle, cosPen, w, h]);
    });
    return out;
}

// ── Main build ─────────────────────────────────────────────────────

export function buildSpectralScene({ THREE, scene, maxTriangles = 4_000_000 } = {}) {
    if (!scene) return null;
    scene.updateMatrixWorld(true);

    // Pass 1: gather eligible (mesh, matrixWorld, materialUberIndex-per-group)
    // and count verts/tris so we can allocate once.
    const uberList = [];
    const uberMap = new Map();
    function internMaterial(material) {
        const rec = materialToUber(material || {});
        const key = uberKey(rec);
        let idx = uberMap.get(key);
        if (idx === undefined) { idx = uberList.length; uberList.push(rec); uberMap.set(key, idx); }
        return idx;
    }

    const draws = []; // { geometry, matrices: Mat4[], groupMats: Uint32 per-source-tri material }
    let totalVerts = 0;
    let totalTris = 0;

    const mat4Scratch = new THREE.Matrix4();
    scene.traverseVisible((obj) => {
        if (!isTraceableMesh(obj)) return;
        const geom = obj.geometry;
        const pos = geom.attributes.position;
        const index = geom.index;
        const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
        if (triCount <= 0) return;

        const mats = meshMaterials(obj);
        // Per-source-triangle uber index (handles Multi/Sub via geometry groups).
        const triMat = new Uint32Array(triCount);
        const baseUber = internMaterial(mats[0]);
        triMat.fill(baseUber);
        const groups = Array.isArray(geom.groups) ? geom.groups : [];
        if (groups.length > 0 && mats.length > 1) {
            for (const grp of groups) {
                const slot = Math.min(mats.length - 1, Math.max(0, grp.materialIndex | 0));
                const uber = internMaterial(mats[slot]);
                const t0 = Math.floor((grp.start | 0) / 3);
                const t1 = Math.min(triCount, t0 + Math.floor((grp.count | 0) / 3));
                for (let t = t0; t < t1; t++) triMat[t] = uber;
            }
        }

        const matrices = [];
        if (obj.isInstancedMesh) {
            const count = obj.count | 0;
            for (let i = 0; i < count; i++) {
                const m = new THREE.Matrix4();
                obj.getMatrixAt(i, m);
                m.premultiply(obj.matrixWorld);
                matrices.push(m);
            }
        } else {
            matrices.push(obj.matrixWorld.clone());
        }
        if (matrices.length === 0) return;

        totalVerts += pos.count * matrices.length;
        totalTris += triCount * matrices.length;
        draws.push({ geom, pos, index, triCount, matrices, triMat });
    });

    if (totalTris === 0 || totalVerts === 0) return null;
    if (totalTris > maxTriangles) {
        // Hard cap: refuse to build rather than blow the storage-buffer ceiling.
        return { error: `scene too large for path tracer: ${totalTris} tris > ${maxTriangles} cap` };
    }

    // Pass 2: allocate and fill the world-space indexed soup. vertexMaterial
    // is stamped per triangle (last writer wins for verts shared across
    // material groups — acceptable under the no-accuracy goal) so the final
    // per-triangle material survives the BVH index permutation.
    const vertexPos = new Float32Array(totalVerts * VERT_STRIDE);
    const triIndex = new Uint32Array(totalTris * 3);
    const vertexMaterial = new Uint32Array(totalVerts);
    let vCursor = 0; // vertex count written
    let tCursor = 0; // triangle count written

    const v = new THREE.Vector3();
    for (const d of draws) {
        const { pos, index, triCount, matrices, triMat } = d;
        const vCount = pos.count;
        for (const m of matrices) {
            const vBase = vCursor;
            for (let i = 0; i < vCount; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(m);
                const o = (vBase + i) * VERT_STRIDE;
                vertexPos[o] = v.x; vertexPos[o + 1] = v.y; vertexPos[o + 2] = v.z;
            }
            for (let t = 0; t < triCount; t++) {
                const a = vBase + (index ? index.getX(t * 3) : t * 3);
                const b = vBase + (index ? index.getX(t * 3 + 1) : t * 3 + 1);
                const c = vBase + (index ? index.getX(t * 3 + 2) : t * 3 + 2);
                const to = (tCursor + t) * 3;
                triIndex[to] = a;
                triIndex[to + 1] = b;
                triIndex[to + 2] = c;
                const um = triMat[t];
                vertexMaterial[a] = um;
                vertexMaterial[b] = um;
                vertexMaterial[c] = um;
            }
            vCursor += vCount;
            tCursor += triCount;
        }
    }

    // Build a real BufferGeometry for MeshBVH (single root → clear groups).
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertexPos, VERT_STRIDE));
    geometry.setIndex(new THREE.BufferAttribute(triIndex, 1));
    geometry.clearGroups();
    geometry.computeBoundingBox();

    const bvh = new MeshBVH(geometry, { maxLeafTris: 8, indirect: false });
    const roots = bvh._roots;
    if (!Array.isArray(roots) || roots.length === 0) return { error: 'BVH build produced no root' };
    const { nodes: bvhNodes, nodeCount } = flattenBVHRoot(roots[0]);

    // MeshBVH permuted triIndex in place (whole triangles). Per-triangle
    // material in BVH order = material of the triangle's first vertex, which
    // vertexMaterial carries through the permutation.
    const triMaterial = new Uint32Array(totalTris);
    for (let t = 0; t < totalTris; t++) {
        triMaterial[t] = vertexMaterial[triIndex[t * 3]] >>> 0;
    }

    // Materials buffer
    const materials = new Float32Array(uberList.length * MAT_STRIDE);
    for (let i = 0; i < uberList.length; i++) {
        materials.set(uberList[i], i * MAT_STRIDE);
    }

    // Lights
    const lightRecords = collectLights(THREE, scene);
    const lights = new Float32Array(Math.max(1, lightRecords.length) * LIGHT_STRIDE);
    for (let i = 0; i < lightRecords.length; i++) lights.set(lightRecords[i], i * LIGHT_STRIDE);

    // Environment (equirect)
    const env = scene.userData?.maxjsPathTraceEnvironment?.isTexture
        ? scene.userData.maxjsPathTraceEnvironment
        : (scene.environment?.isTexture ? scene.environment : null);

    geometry.dispose?.();

    return {
        error: null,
        bvhNodes, nodeCount,
        triIndex, triCount: totalTris,
        vertexPos, vertexCount: totalVerts,
        triMaterial,
        materials, materialCount: uberList.length,
        lights, lightCount: lightRecords.length,
        env,
        strides: { NODE_STRIDE_U32, MAT_STRIDE, LIGHT_STRIDE, VERT_STRIDE },
    };
}

export { NODE_STRIDE_U32, MAT_STRIDE, LIGHT_STRIDE, VERT_STRIDE, BYTES_PER_BVH_NODE };
