// GPU normal recompute for position-only geo_fast updates (WebGPU backend only).
//
// During deform playback the C++ side streams positions without normals for
// oversized meshes (compactChannels) and the viewer used to keep the stale
// normal buffer until idle resync. Render vertices are already split per
// smoothing group / UV seam by the exporter, so an indexed face-normal
// accumulation over a prebuilt vertex→triangle CSR adjacency reproduces the
// CPU smoothing result on the GPU in two compute passes — zero extra wire
// bandwidth and zero CPU cost in Max. Explicit (Edit Normals) normals are
// approximated until the next idle full sync restores the exact values.
//
// State is keyed by BufferGeometry in a WeakMap; topology rebuilds create a
// new geometry object and naturally drop the cached adjacency. Any runtime
// failure latches the feature off and the viewer falls back to the previous
// frozen-normal behavior.

import * as THREE from 'three';
import { Fn, If, Loop, Return, float, instanceIndex, storage, uint, vec3 } from 'three/tsl';

// HARD-DISABLED: three r185's WebGPU backend MUTATES itemSize-3 attributes
// used as storage buffers (pads the array vec3→vec4 and rewrites
// attribute.itemSize/array in place — see createAttribute /
// _force3to4BytesAlignment in three.webgpu.js). That fights
// updateFloatGeometryAttribute's itemSize check every tick, causing
// perpetual attribute replacement + pipeline churn = mesh corruption and
// severe lag. Re-enabling requires geometries created with storage
// attributes from birth and a padded-aware CPU update path — do NOT flip
// this back without that redesign.
const GPU_NORMALS_HARD_DISABLED = true;

const states = new WeakMap();
let disabledByError = false;

function disable(err) {
    disabledByError = true;
    console.warn('max.js: GPU normal recompute disabled —', err);
}

function toStorageAttribute(geometry, name) {
    const attr = geometry.getAttribute(name);
    if (!attr) return null;
    if (attr.isStorageBufferAttribute) return attr;
    // Same backing array — CPU-side updateFloatGeometryAttribute keeps
    // writing into it and flagging needsUpdate exactly as before.
    const sb = new THREE.StorageBufferAttribute(attr.array, attr.itemSize);
    geometry.setAttribute(name, sb);
    return sb;
}

function buildState(geometry) {
    if (typeof THREE.StorageBufferAttribute !== 'function') return null;
    const indexAttr = geometry.index;
    const vertCount = geometry.getAttribute('position').count;
    const triCount = Math.floor(indexAttr.count / 3);
    if (vertCount === 0 || triCount === 0) return null;

    const posAttr = toStorageAttribute(geometry, 'position');
    const nrmAttr = toStorageAttribute(geometry, 'normal');
    if (!posAttr || !nrmAttr || nrmAttr.count !== vertCount) return null;

    // Index copy as u32 storage (source may be Uint16).
    const indexU32 = new Uint32Array(triCount * 3);
    indexU32.set(indexAttr.array.subarray ? indexAttr.array.subarray(0, triCount * 3) : indexAttr.array);

    // CSR vertex → triangle adjacency.
    const offsets = new Uint32Array(vertCount + 1);
    for (let i = 0; i < indexU32.length; i++) {
        const v = indexU32[i];
        if (v >= vertCount) return null; // corrupt index — never trust it on the GPU
        offsets[v + 1]++;
    }
    for (let v = 1; v <= vertCount; v++) offsets[v] += offsets[v - 1];
    const adjTri = new Uint32Array(offsets[vertCount]);
    {
        const cursor = offsets.slice(0, vertCount);
        for (let t = 0; t < triCount; t++) {
            adjTri[cursor[indexU32[t * 3 + 0]]++] = t;
            adjTri[cursor[indexU32[t * 3 + 1]]++] = t;
            adjTri[cursor[indexU32[t * 3 + 2]]++] = t;
        }
    }

    const idxStorage = new THREE.StorageBufferAttribute(indexU32, 1);
    const offStorage = new THREE.StorageBufferAttribute(offsets, 1);
    const adjStorage = new THREE.StorageBufferAttribute(adjTri.length ? adjTri : new Uint32Array(1), 1);
    const faceStorage = new THREE.StorageBufferAttribute(new Float32Array(triCount * 3), 1);

    // LAYOUT-CRITICAL: every float buffer is bound as a scalar array.
    // WGSL `array<vec3<f32>>` storage has a 16-byte stride, but these same
    // buffers are consumed by the render pipeline as tightly packed 12-byte
    // vertex attributes — binding them as 'vec3' makes three allocate the
    // padded layout and silently shears the whole mesh. `array<f32>` is
    // spec-guaranteed stride 4, identical to the vertex layout.
    const positions = storage(posAttr, 'float', vertCount * 3);
    const normals = storage(nrmAttr, 'float', vertCount * 3);
    const indices = storage(idxStorage, 'uint', indexU32.length);
    const adjOff = storage(offStorage, 'uint', offsets.length);
    const adjList = storage(adjStorage, 'uint', Math.max(adjTri.length, 1));
    const faceNormals = storage(faceStorage, 'float', triCount * 3);

    const loadVec3 = (bufNode, base) => vec3(
        bufNode.element(base),
        bufNode.element(base.add(uint(1))),
        bufNode.element(base.add(uint(2))));

    // Pass 1: per-triangle normals (normalized for parity with the CPU
    // plan's uniform smoothing-group weighting; degenerate → +Z).
    const facePass = Fn(() => {
        const tri = instanceIndex.toVar();
        If(tri.greaterThanEqual(uint(triCount)), () => {
            Return();
        });
        const base = tri.mul(uint(3)).toVar();
        const i0 = indices.element(base).mul(uint(3)).toVar();
        const i1 = indices.element(base.add(uint(1))).mul(uint(3)).toVar();
        const i2 = indices.element(base.add(uint(2))).mul(uint(3)).toVar();
        const p0 = loadVec3(positions, i0).toVar();
        const p1 = loadVec3(positions, i1).toVar();
        const p2 = loadVec3(positions, i2).toVar();
        const n = p1.sub(p0).cross(p2.sub(p0)).toVar();
        const lenSq = n.dot(n).toVar();
        const out = vec3(0.0, 0.0, 1.0).toVar();
        If(lenSq.greaterThan(float(1e-20)), () => {
            out.assign(n.mul(lenSq.inverseSqrt()));
        });
        faceNormals.element(base).assign(out.x);
        faceNormals.element(base.add(uint(1))).assign(out.y);
        faceNormals.element(base.add(uint(2))).assign(out.z);
    })().compute(triCount);

    // Pass 2: per-vertex gather over the CSR rows.
    const vertexPass = Fn(() => {
        const v = instanceIndex.toVar();
        If(v.greaterThanEqual(uint(vertCount)), () => {
            Return();
        });
        const rowStart = adjOff.element(v).toVar();
        const rowEnd = adjOff.element(v.add(uint(1))).toVar();
        const accum = vec3(0.0).toVar();
        Loop({ start: rowStart, end: rowEnd, type: 'uint', condition: '<' }, ({ i }) => {
            const f3 = adjList.element(i).mul(uint(3)).toVar();
            accum.addAssign(loadVec3(faceNormals, f3));
        });
        const lenSq = accum.dot(accum).toVar();
        const out = vec3(0.0, 0.0, 1.0).toVar();
        If(lenSq.greaterThan(float(1e-20)), () => {
            out.assign(accum.mul(lenSq.inverseSqrt()));
        });
        const o = v.mul(uint(3)).toVar();
        normals.element(o).assign(out.x);
        normals.element(o.add(uint(1))).assign(out.y);
        normals.element(o.add(uint(2))).assign(out.z);
    })().compute(vertCount);

    return {
        posAttr,
        nrmAttr,
        indexRef: indexAttr,
        facePass,
        vertexPass,
        inFlight: false,
        queued: false,
    };
}

function dispatch(renderer, st) {
    if (st.inFlight) {
        st.queued = true;
        return;
    }
    st.inFlight = true;
    Promise.resolve()
        .then(() => renderer.computeAsync(st.facePass))
        .then(() => renderer.computeAsync(st.vertexPass))
        .catch((err) => disable(err))
        .finally(() => {
            st.inFlight = false;
            if (st.queued && !disabledByError) {
                st.queued = false;
                dispatch(renderer, st);
            }
        });
}

// Drop cached adjacency for a geometry whose index contents were rewritten
// in place (sameTopology geo_fast updates that carry indices).
export function gpuNormalsInvalidate(geometry) {
    if (geometry) states.delete(geometry);
}

// True once a runtime failure has latched the feature off — callers use this
// to tell the plugin to fall back to CPU normal streaming.
export function isGpuNormalsDisabled() {
    return disabledByError;
}

// Recompute normals on the GPU after a position-only update. Returns true
// when a compute was dispatched (or is queued behind one in flight); false
// means the caller should keep its existing fallback behavior.
export function gpuRecomputeNormals(renderer, mesh) {
    if (GPU_NORMALS_HARD_DISABLED || disabledByError) return false;
    try {
        if (!renderer || !renderer.backend || renderer.backend.isWebGPUBackend !== true) return false;
        const geometry = mesh && mesh.geometry;
        if (!geometry || !geometry.index) return false;
        const pos = geometry.getAttribute('position');
        const nrm = geometry.getAttribute('normal');
        if (!pos || !nrm || nrm.count !== pos.count || pos.count === 0) return false;

        let st = states.get(geometry);
        if (st && (geometry.getAttribute('position') !== st.posAttr ||
                   geometry.getAttribute('normal') !== st.nrmAttr ||
                   geometry.index !== st.indexRef)) {
            st = undefined; // attributes were swapped out from under us — rebuild
        }
        if (st === null) return false; // known-unsupported geometry
        if (!st) {
            st = buildState(geometry);
            states.set(geometry, st || null);
            if (!st) return false;
        }
        dispatch(renderer, st);
        return true;
    } catch (err) {
        disable(err);
        return false;
    }
}

export { gpuRecomputeNormals as default };
