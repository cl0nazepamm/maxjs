// layer_deform.js — ctx.deform: GPU vertex-stage deformation for synced Max meshes.
//
// Deforms in place through material.positionNode (TSL) on the synced mesh:
// no geometry clone, no hide/unhide of the Max copy, no per-frame CPU vertex
// work. The synced geometry stays at rest; displacement happens in the GPU
// vertex stage, so fastsync (transforms, materials, geo_fast) keeps flowing.
//
// Survival contract:
// - Node-graph edits register as material decorators (layer_runtime_overrides)
//   so the live viewer reapplies them right after every fastsync material
//   rebuild — same mechanism that keeps map-slot overrides alive.
// - update() self-heals each frame for appliers that bypass the decorator
//   hook (snapshot boot), and keeps resolving late-synced targets — layers
//   mount before the scene is populated, so attach() is safe at mount time.
// - dispose() restores the exact previous position/normal nodes.
//
// The "three.js Deform" Max modifier is NOT required for this path. It stays
// the authoring marker (adapter.jsmod) and the geometry-ownership guard for
// layers that write vertex buffers directly.

import * as TSL from 'three/tsl';
import { freezePlainObject } from './layer_utils.js';

// Synced from Max as a vc channel when sub-object selection sits in the
// modifier stack of a three.js Deform node (see maxjs_geometry_sync.h).
const DEFORM_WEIGHT_ATTRIBUTE = 'deformWeight';

function createDeformSystem({
    THREE,
    renderer = null,
    nodeMap,
    getTimelineSeconds = () => 0,
    setMaterialDecorator,
    clearMaterialDecorator,
    debugWarn = (...args) => console.warn(...args),
}) {
    const entries = new Map(); // entryId -> entry
    let nextEntryId = 1;

    // Shared time uniforms — one graph input per source, updated once per frame.
    // 'timeline' follows the Max timeline (and snapshot playback), which keeps
    // deformation render-deterministic for powershot/film capture.
    const clockUniform = TSL.uniform(0);
    const timelineUniform = TSL.uniform(0);
    const dtUniform = TSL.uniform(0);

    function isDrawable(obj) {
        return !!(obj && (obj.isMesh || obj.isLine || obj.isLineSegments));
    }

    function isMesh(obj) {
        return !!(obj && obj.isMesh);
    }

    function materialsOf(mesh) {
        return Array.isArray(mesh.material) ? mesh.material : (mesh.material ? [mesh.material] : []);
    }

    function clampDt(dt) {
        const n = Number(dt);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(0.1, n));
    }

    // ── Target specs ────────────────────────────────────────────────
    // adapter | handle | exact name | 'Prefix*' | predicate(adapter) | array.
    // Name/prefix/predicate specs stay live: nodes that sync in later still match.

    function normalizeTarget(target) {
        if (target == null) return null;
        if (Array.isArray(target)) {
            const parts = target.map(normalizeTarget).filter(Boolean);
            if (parts.length === 0) return null;
            return { kind: 'multi', parts, dynamic: parts.some(p => p.dynamic) };
        }
        if (typeof target === 'function') {
            return { kind: 'predicate', predicate: target, dynamic: true };
        }
        if (typeof target === 'number' && Number.isFinite(target)) {
            return { kind: 'handle', handle: target, dynamic: false };
        }
        if (typeof target === 'string' && target.length > 0) {
            if (target.endsWith('*')) {
                return { kind: 'prefix', prefix: target.slice(0, -1), dynamic: true };
            }
            return { kind: 'name', name: target, dynamic: true };
        }
        const handle = Number(target?.handle);
        if (Number.isFinite(handle) && handle > 0) {
            return { kind: 'handle', handle, dynamic: false };
        }
        return null;
    }

    function countStaticHandles(spec) {
        if (spec.kind === 'handle') return 1;
        if (spec.kind === 'multi') return spec.parts.reduce((n, p) => n + countStaticHandles(p), 0);
        return 0;
    }

    function specMatches(spec, handle, obj, getAdapter) {
        switch (spec.kind) {
            case 'multi':
                return spec.parts.some(p => specMatches(p, handle, obj, getAdapter));
            case 'handle':
                return spec.handle === handle;
            case 'name':
                return obj.name === spec.name;
            case 'prefix':
                return typeof obj.name === 'string' && obj.name.startsWith(spec.prefix);
            case 'predicate': {
                const adapter = getAdapter?.(handle);
                if (!adapter) return false;
                try {
                    return spec.predicate(adapter) === true;
                } catch (err) {
                    debugWarn('[ctx.deform] target predicate threw:', err);
                    return false;
                }
            }
            default:
                return false;
        }
    }

    // ── Params → uniforms ───────────────────────────────────────────

    function toUniform(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return TSL.uniform(value);
        if (typeof value === 'boolean') return TSL.uniform(value ? 1 : 0);
        if (Array.isArray(value)) {
            if (value.length === 2) return TSL.uniform(new THREE.Vector2(...value));
            if (value.length === 3) return TSL.uniform(new THREE.Vector3(...value));
            if (value.length === 4) return TSL.uniform(new THREE.Vector4(...value));
            return null;
        }
        if (value?.isColor || value?.isVector2 || value?.isVector3 || value?.isVector4) {
            return TSL.uniform(value.clone());
        }
        return null;
    }

    function buildParams(entry, paramSpec) {
        const proxy = {};
        for (const [name, value] of Object.entries(paramSpec ?? {})) {
            const node = toUniform(value);
            if (!node) {
                debugWarn(`[ctx.deform] "${entry.key}" param "${name}": unsupported value — use number, [x,y(,z,w)], Vector*, or Color`);
                continue;
            }
            entry.paramNodes[name] = node;
            entry.paramUniforms.set(name, node);
            Object.defineProperty(proxy, name, {
                enumerable: true,
                get() { return node.value; },
                set(next) {
                    const cur = node.value;
                    if (typeof cur === 'number') {
                        const num = Number(next);
                        if (Number.isFinite(num)) node.value = num;
                    } else if (Array.isArray(next) && typeof cur?.fromArray === 'function') {
                        cur.fromArray(next);
                    } else if (next && typeof next === 'object' && typeof cur?.copy === 'function') {
                        cur.copy(next);
                    } else if (typeof next === 'number' && typeof cur?.setScalar === 'function') {
                        cur.setScalar(next);
                    }
                },
            });
        }
        return freezePlainObject(proxy);
    }

    // ── Storage-buffer simulation ──────────────────────────────────

    function componentOf(attr, index, component, fallback = 0) {
        if (!attr) return fallback;
        if (attr.isInterleavedBufferAttribute === true) {
            if (component === 0 && typeof attr.getX === 'function') return attr.getX(index);
            if (component === 1 && typeof attr.getY === 'function') return attr.getY(index);
            if (component === 2 && typeof attr.getZ === 'function') return attr.getZ(index);
            if (component === 3 && typeof attr.getW === 'function') return attr.getW(index);
            return fallback;
        }
        const base = index * attr.itemSize + component;
        return base < attr.array.length ? attr.array[base] : fallback;
    }

    function cloneRegularAttribute(attr) {
        if (!attr) return null;
        const sourceArray = attr.isInterleavedBufferAttribute === true ? attr.data?.array : attr.array;
        const ArrayType = sourceArray?.constructor;
        if (typeof ArrayType !== 'function') return null;
        const array = new ArrayType(attr.count * attr.itemSize);
        if (attr.isInterleavedBufferAttribute === true) {
            for (let i = 0; i < attr.count; i++) {
                for (let c = 0; c < attr.itemSize; c++) {
                    array[i * attr.itemSize + c] = componentOf(attr, i, c, 0);
                }
            }
        } else {
            array.set(sourceArray.subarray ? sourceArray.subarray(0, array.length) : sourceArray);
        }
        const out = new THREE.BufferAttribute(array, attr.itemSize, attr.normalized === true);
        out.name = attr.name || '';
        if (attr.gpuType != null) out.gpuType = attr.gpuType;
        if (Number.isFinite(attr.usage)) out.setUsage(attr.usage);
        return out;
    }

    function cloneIndexAttribute(indexAttr) {
        if (!indexAttr?.array) return null;
        const ArrayType = indexAttr.array.constructor;
        const array = new ArrayType(indexAttr.array.length);
        array.set(indexAttr.array.subarray ? indexAttr.array.subarray(0) : indexAttr.array);
        return new THREE.BufferAttribute(array, 1);
    }

    function paddedVec4AttributeArray(attr, count, fallback, w) {
        const out = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) {
            const base = i * 4;
            out[base + 0] = componentOf(attr, i, 0, fallback[0]);
            out[base + 1] = componentOf(attr, i, 1, fallback[1]);
            out[base + 2] = componentOf(attr, i, 2, fallback[2]);
            out[base + 3] = w;
        }
        return out;
    }

    function buildKernelIndexArray(sourceGeometry, vertexCount) {
        const indexAttr = sourceGeometry.index;
        if (indexAttr?.array?.length) {
            const out = new Uint32Array(indexAttr.array.length);
            out.set(indexAttr.array.subarray ? indexAttr.array.subarray(0) : indexAttr.array);
            for (let i = 0; i < out.length; i++) {
                if (out[i] >= vertexCount) return null;
            }
            return out;
        }
        const triVertCount = Math.floor(vertexCount / 3) * 3;
        if (triVertCount === 0) return null;
        const out = new Uint32Array(triVertCount);
        for (let i = 0; i < triVertCount; i++) out[i] = i;
        return out;
    }

    function buildStorageGeometry(sourceGeometry) {
        if (typeof THREE.StorageBufferAttribute !== 'function') return null;
        const pos = sourceGeometry?.getAttribute?.('position');
        if (!pos || pos.count <= 0) return null;
        const normal = sourceGeometry.getAttribute('normal');
        const vertexCount = pos.count;
        const positionArray = paddedVec4AttributeArray(pos, vertexCount, [0, 0, 0], 1);
        const normalArray = paddedVec4AttributeArray(normal, vertexCount, [0, 1, 0], 0);
        const geometry = new THREE.BufferGeometry();
        const positionAttr = new THREE.StorageBufferAttribute(positionArray, 4);
        const normalAttr = new THREE.StorageBufferAttribute(normalArray, 4);
        geometry.setAttribute('position', positionAttr);
        geometry.setAttribute('normal', normalAttr);

        for (const [name, attr] of Object.entries(sourceGeometry.attributes ?? {})) {
            if (name === 'position' || name === 'normal') continue;
            const copy = cloneRegularAttribute(attr);
            if (copy) geometry.setAttribute(name, copy);
        }

        const indexCopy = cloneIndexAttribute(sourceGeometry.index);
        if (indexCopy) geometry.setIndex(indexCopy);
        geometry.clearGroups();
        for (const group of sourceGeometry.groups ?? []) {
            geometry.addGroup(group.start, group.count, group.materialIndex);
        }
        geometry.drawRange.start = sourceGeometry.drawRange?.start ?? 0;
        geometry.drawRange.count = sourceGeometry.drawRange?.count ?? Infinity;
        geometry.boundingBox = sourceGeometry.boundingBox?.clone?.() ?? null;
        geometry.boundingSphere = sourceGeometry.boundingSphere?.clone?.() ?? null;
        geometry.name = sourceGeometry.name || '';
        geometry.userData = { ...(sourceGeometry.userData ?? {}) };

        // Sub-object selection weights, lifted into a kernel-readable flat
        // storage buffer (the copied render attribute stays for attach()).
        let restWeightAttr = null;
        const weightSrc = sourceGeometry.getAttribute(DEFORM_WEIGHT_ATTRIBUTE);
        if (weightSrc) {
            const weights = new Float32Array(vertexCount);
            for (let i = 0; i < vertexCount; i++) {
                weights[i] = componentOf(weightSrc, i, 0, 1);
            }
            restWeightAttr = new THREE.StorageBufferAttribute(weights, 1);
        }

        return {
            geometry,
            vertexCount,
            positionAttr,
            normalAttr,
            restPositionAttr: new THREE.StorageBufferAttribute(new Float32Array(positionArray), 4),
            restNormalAttr: new THREE.StorageBufferAttribute(new Float32Array(normalArray), 4),
            restWeightAttr,
            kernelIndexArray: buildKernelIndexArray(sourceGeometry, vertexCount),
        };
    }

    function vectorNode(value, itemSize) {
        if (itemSize > 4) return value;
        if (itemSize === 1) return value;
        if (Array.isArray(value)) {
            if (itemSize === 2) return TSL.vec2(...value);
            if (itemSize === 3) return TSL.vec3(...value);
            return TSL.vec4(...value);
        }
        if (itemSize === 2) return TSL.vec2(value);
        if (itemSize === 3) return TSL.vec3(value);
        return TSL.vec4(value);
    }

    function zeroNode(itemSize) {
        if (itemSize === 1) return 0;
        if (itemSize === 2) return TSL.vec2(0);
        if (itemSize === 3) return TSL.vec3(0);
        if (itemSize === 4) return TSL.vec4(0);
        return new Array(itemSize).fill(0);
    }

    function storageAccessor(bufferNode, itemSize, stride, vertexIndex) {
        const base = vertexIndex.mul(TSL.uint(stride)).toVar();
        const element = (component = 0) => bufferNode.element(base.add(TSL.uint(component)));
        const read = () => {
            if (itemSize === 1) return element(0);
            if (itemSize === 2) return TSL.vec2(element(0), element(1));
            if (itemSize === 3) return TSL.vec3(element(0), element(1), element(2));
            if (itemSize === 4) return TSL.vec4(element(0), element(1), element(2), element(3));
            return Object.freeze(Array.from({ length: itemSize }, (_, i) => element(i)));
        };
        const assign = (value) => {
            if (itemSize > 4) {
                const values = Array.isArray(value) ? value : null;
                for (let i = 0; i < itemSize; i++) {
                    element(i).assign(values ? values[i] ?? 0 : value);
                }
                return value;
            }
            const node = vectorNode(value, itemSize);
            if (itemSize === 1) {
                element(0).assign(node);
                return node;
            }
            // Var the value once — assigning component-wise would otherwise
            // re-evaluate the user's expression per component in WGSL.
            const v = typeof node.toVar === 'function' ? node.toVar() : node;
            for (let i = 0; i < itemSize; i++) {
                element(i).assign(v[['x', 'y', 'z', 'w'][i]]);
            }
            return v;
        };
        return freezePlainObject({
            itemSize,
            stride,
            element,
            read,
            load: read,
            assign,
            write: assign,
            get x() { return element(0); },
            get y() { return element(1); },
            get z() { return element(2); },
            get w() { return element(3); },
        });
    }

    function buildStateChannels(entry, vertexCount) {
        const channels = new Map();
        for (const [name, size] of Object.entries(entry.options.state ?? {})) {
            const itemSize = Number(size);
            if (!Number.isInteger(itemSize) || itemSize < 1) {
                debugWarn(`[ctx.deform] "${entry.key}" state "${name}": itemSize must be a positive integer`);
                continue;
            }
            const attr = new THREE.StorageBufferAttribute(new Float32Array(vertexCount * itemSize), 1);
            channels.set(name, {
                itemSize,
                stride: itemSize,
                attr,
                node: TSL.storage(attr, 'float', vertexCount * itemSize),
            });
        }
        return channels;
    }

    function buildSimulationArgs(entry, st, vertexIndex) {
        const state = {};
        for (const [name, channel] of st.stateChannels) {
            state[name] = storageAccessor(channel.node, channel.itemSize, channel.stride, vertexIndex);
        }
        return {
            position: storageAccessor(st.positionNode, 3, 4, vertexIndex),
            rest: storageAccessor(st.restPositionNode, 3, 4, vertexIndex),
            normal: storageAccessor(st.normalNode, 3, 4, vertexIndex),
            // Read-only sub-object selection weight (1.0 when none synced).
            weight: st.weightNode ? st.weightNode.element(vertexIndex) : TSL.float(1),
            state: freezePlainObject(state),
            dt: dtUniform,
            time: entry.timeMode === 'timeline' ? timelineUniform : clockUniform,
            params: entry.paramNodes,
            vertexIndex,
            vertexCount: TSL.uint(st.vertexCount),
            TSL,
            THREE,
        };
    }

    function buildResetPass(st) {
        return TSL.Fn(() => {
            const vertexIndex = TSL.instanceIndex.toVar();
            TSL.If(vertexIndex.greaterThanEqual(TSL.uint(st.vertexCount)), () => {
                TSL.Return();
            });
            storageAccessor(st.positionNode, 3, 4, vertexIndex)
                .assign(storageAccessor(st.restPositionNode, 3, 4, vertexIndex).read());
            storageAccessor(st.normalNode, 3, 4, vertexIndex)
                .assign(storageAccessor(st.restNormalNode, 3, 4, vertexIndex).read());
            for (const channel of st.stateChannels.values()) {
                storageAccessor(channel.node, channel.itemSize, channel.stride, vertexIndex)
                    .assign(zeroNode(channel.itemSize));
            }
        })().compute(st.vertexCount);
    }

    function loadPaddedVec3(bufferNode, base) {
        return TSL.vec3(
            bufferNode.element(base),
            bufferNode.element(base.add(TSL.uint(1))),
            bufferNode.element(base.add(TSL.uint(2))));
    }

    function buildNormalPasses(st) {
        const indexU32 = st.kernelIndexArray;
        const triCount = Math.floor((indexU32?.length ?? 0) / 3);
        if (triCount <= 0) return null;

        const offsets = new Uint32Array(st.vertexCount + 1);
        for (let i = 0; i < indexU32.length; i++) offsets[indexU32[i] + 1]++;
        for (let v = 1; v <= st.vertexCount; v++) offsets[v] += offsets[v - 1];
        const adjTri = new Uint32Array(offsets[st.vertexCount]);
        {
            const cursor = offsets.slice(0, st.vertexCount);
            for (let t = 0; t < triCount; t++) {
                adjTri[cursor[indexU32[t * 3 + 0]]++] = t;
                adjTri[cursor[indexU32[t * 3 + 1]]++] = t;
                adjTri[cursor[indexU32[t * 3 + 2]]++] = t;
            }
        }

        const indices = TSL.storage(new THREE.StorageBufferAttribute(indexU32, 1), 'uint', indexU32.length);
        const adjOff = TSL.storage(new THREE.StorageBufferAttribute(offsets, 1), 'uint', offsets.length);
        const adjList = TSL.storage(new THREE.StorageBufferAttribute(adjTri.length ? adjTri : new Uint32Array(1), 1), 'uint', Math.max(adjTri.length, 1));
        const faceNormals = TSL.storage(new THREE.StorageBufferAttribute(new Float32Array(triCount * 3), 1), 'float', triCount * 3);

        const facePass = TSL.Fn(() => {
            const tri = TSL.instanceIndex.toVar();
            TSL.If(tri.greaterThanEqual(TSL.uint(triCount)), () => {
                TSL.Return();
            });
            const base = tri.mul(TSL.uint(3)).toVar();
            const i0 = indices.element(base).mul(TSL.uint(4)).toVar();
            const i1 = indices.element(base.add(TSL.uint(1))).mul(TSL.uint(4)).toVar();
            const i2 = indices.element(base.add(TSL.uint(2))).mul(TSL.uint(4)).toVar();
            const p0 = loadPaddedVec3(st.positionNode, i0).toVar();
            const p1 = loadPaddedVec3(st.positionNode, i1).toVar();
            const p2 = loadPaddedVec3(st.positionNode, i2).toVar();
            const n = p1.sub(p0).cross(p2.sub(p0)).toVar();
            const lenSq = n.dot(n).toVar();
            const out = TSL.vec3(0.0, 0.0, 1.0).toVar();
            TSL.If(lenSq.greaterThan(TSL.float(1e-20)), () => {
                out.assign(n.mul(lenSq.inverseSqrt()));
            });
            faceNormals.element(base).assign(out.x);
            faceNormals.element(base.add(TSL.uint(1))).assign(out.y);
            faceNormals.element(base.add(TSL.uint(2))).assign(out.z);
        })().compute(triCount);

        const vertexPass = TSL.Fn(() => {
            const v = TSL.instanceIndex.toVar();
            TSL.If(v.greaterThanEqual(TSL.uint(st.vertexCount)), () => {
                TSL.Return();
            });
            const rowStart = adjOff.element(v).toVar();
            const rowEnd = adjOff.element(v.add(TSL.uint(1))).toVar();
            const accum = TSL.vec3(0.0).toVar();
            TSL.Loop({ start: rowStart, end: rowEnd, type: 'uint', condition: '<' }, ({ i }) => {
                const f3 = adjList.element(i).mul(TSL.uint(3)).toVar();
                accum.addAssign(loadPaddedVec3(faceNormals, f3));
            });
            const lenSq = accum.dot(accum).toVar();
            const out = TSL.vec3(0.0, 0.0, 1.0).toVar();
            TSL.If(lenSq.greaterThan(TSL.float(1e-20)), () => {
                out.assign(accum.mul(lenSq.inverseSqrt()));
            });
            storageAccessor(st.normalNode, 3, 4, v).assign(out);
        })().compute(st.vertexCount);

        return [facePass, vertexPass];
    }

    function computeAvailable(entry) {
        if (renderer?.backend?.isWebGPUBackend === true &&
            (typeof renderer.compute === 'function' || typeof renderer.computeAsync === 'function')) {
            return true;
        }
        if (!entry.warnedComputeUnavailable) {
            entry.warnedComputeUnavailable = true;
            console.error(`[ctx.deform] "${entry.key}": ctx.deform.simulate requires WebGPU compute; current renderer/backend cannot run compute — entry disabled`);
        }
        entry.failed = true;
        return false;
    }

    function failSimulationEntry(entry, message, err = null) {
        if (entry.failed) return;
        entry.failed = true;
        if (err) console.error(message, err);
        else console.error(message);
        // Leave nothing half-simulated: restore original geometry so meshes
        // render their rest pose live and snapshot export sees a normal
        // (undriven) jsmod mesh instead of a frozen storage geometry.
        if (entry.simulations) {
            for (const st of entry.simulations.values()) {
                disposeSimulationState(st, true);
            }
            entry.simulations.clear();
            entry.matched.clear();
        }
    }

    function buildSimulationForMesh(entry, handle, mesh) {
        const storageGeometry = buildStorageGeometry(mesh.geometry);
        if (!storageGeometry) {
            if (!entry.warnedGeometryHandles.has(handle)) {
                entry.warnedGeometryHandles.add(handle);
                console.error(`[ctx.deform] "${entry.key}": "${mesh.name}" has no storage-capable position geometry — skipped`);
            }
            return null;
        }

        const st = {
            handle,
            mesh,
            originalGeometry: mesh.geometry,
            geometry: storageGeometry.geometry,
            vertexCount: storageGeometry.vertexCount,
            kernelIndexArray: storageGeometry.kernelIndexArray,
            stateChannels: buildStateChannels(entry, storageGeometry.vertexCount),
            positionNode: TSL.storage(storageGeometry.positionAttr, 'float', storageGeometry.vertexCount * 4),
            restPositionNode: TSL.storage(storageGeometry.restPositionAttr, 'float', storageGeometry.vertexCount * 4),
            normalNode: TSL.storage(storageGeometry.normalAttr, 'float', storageGeometry.vertexCount * 4),
            restNormalNode: TSL.storage(storageGeometry.restNormalAttr, 'float', storageGeometry.vertexCount * 4),
            weightNode: storageGeometry.restWeightAttr
                ? TSL.storage(storageGeometry.restWeightAttr, 'float', storageGeometry.vertexCount)
                : null,
            normalPasses: null,
            kernel: null,
            resetPass: null,
            inFlight: false,
            pendingReset: false,
            disposed: false,
        };

        try {
            st.kernel = TSL.Fn(() => {
                const vertexIndex = TSL.instanceIndex.toVar();
                // Dispatch rounds up to workgroup size — without this guard the
                // overflow threads' clamped OOB writes can corrupt the last vertex.
                TSL.If(vertexIndex.greaterThanEqual(TSL.uint(st.vertexCount)), () => {
                    TSL.Return();
                });
                entry.options.compute(buildSimulationArgs(entry, st, vertexIndex));
            })().compute(st.vertexCount);
            st.resetPass = buildResetPass(st);
            if (entry.normalsMode === 'recompute') {
                st.normalPasses = buildNormalPasses(st);
                if (!st.normalPasses) {
                    throw new Error('normals:"recompute" requires triangle topology');
                }
            }
        } catch (err) {
            st.kernel?.dispose?.();
            st.resetPass?.dispose?.();
            for (const pass of st.normalPasses ?? []) pass?.dispose?.();
            st.geometry.dispose?.();
            failSimulationEntry(entry, `[ctx.deform] "${entry.key}" compute builder failed — simulation inactive:`, err);
            return null;
        }

        mesh.geometry = st.geometry;
        mesh.updateMorphTargets?.();
        return st;
    }

    function disposeSimulationState(st, restore = true) {
        if (!st || st.disposed) return;
        st.disposed = true;
        st.kernel?.dispose?.();
        st.resetPass?.dispose?.();
        for (const pass of st.normalPasses ?? []) pass?.dispose?.();
        if (restore && st.mesh?.geometry === st.geometry) {
            st.mesh.geometry = st.originalGeometry;
            st.mesh.updateMorphTargets?.();
        }
        st.geometry?.dispose?.();
    }

    function dispatchCompute(entry, st, passes, label) {
        if (entry.disposed || entry.failed || st.disposed) return false;
        if (!computeAvailable(entry)) return false;
        st.inFlight = true;
        const group = passes.length === 1 ? passes[0] : passes;
        let result = null;
        try {
            result = typeof renderer.compute === 'function'
                ? renderer.compute(group)
                : renderer.computeAsync(group);
        } catch (err) {
            st.inFlight = false;
            failSimulationEntry(entry, `[ctx.deform] "${entry.key}" ${label} dispatch failed — simulation inactive:`, err);
            return false;
        }
        Promise.resolve(result)
            .catch((err) => {
                failSimulationEntry(entry, `[ctx.deform] "${entry.key}" ${label} dispatch failed — simulation inactive:`, err);
            })
            .finally(() => {
                st.inFlight = false;
                if (st.pendingReset && !entry.disposed && !entry.failed && !st.disposed) {
                    st.pendingReset = false;
                    dispatchCompute(entry, st, [st.resetPass], 'reset');
                }
            });
        return true;
    }

    function dispatchSimulation(entry, st) {
        if (st.inFlight) return false;
        const passes = st.normalPasses ? [st.kernel, ...st.normalPasses] : [st.kernel];
        return dispatchCompute(entry, st, passes, 'compute');
    }

    function resetSimulationState(entry, st) {
        if (st.inFlight) {
            st.pendingReset = true;
            return true;
        }
        return dispatchCompute(entry, st, [st.resetPass], 'reset');
    }

    // ── Decoration ──────────────────────────────────────────────────

    function builderArgs(entry, material, mesh = null) {
        return {
            // Existing chain (TSL snippet or an earlier deform entry) or rest
            // position — builders displace this and return the result.
            position: material.positionNode ?? TSL.positionLocal,
            normal: material.normalNode ?? TSL.normalLocal,
            uv: TSL.uv(),
            color: TSL.vertexColor(),
            // Modifier-stack sub-object selection weight (Poly Select /
            // Vol. Select soft selection below the Deform flag) — synced as
            // the 'deformWeight' attribute; 1.0 when the mesh has none.
            weight: mesh?.geometry?.getAttribute?.(DEFORM_WEIGHT_ATTRIBUTE)
                ? TSL.attribute(DEFORM_WEIGHT_ATTRIBUTE, 'vec4').x
                : TSL.float(1),
            time: entry.timeMode === 'timeline' ? timelineUniform : clockUniform,
            params: entry.paramNodes,
            TSL,
            THREE,
        };
    }

    // Idempotent: runs once per material instance (WeakSet guard), so the
    // decorator hook, the per-frame self-heal, and rebuild reapplies can all
    // call it freely without node-graph stacking or pipeline churn.
    function ensureDecorated(entry, mesh) {
        if (entry.disposed || entry.failed) return;
        for (const material of materialsOf(mesh)) {
            if (!material || entry.decorated.has(material)) continue;
            if (material.isNodeMaterial !== true) {
                if (!entry.warnedNonNode) {
                    entry.warnedNonNode = true;
                    debugWarn(`[ctx.deform] "${entry.key}": non-node material on "${mesh.name}" — skipped`);
                }
                continue;
            }
            let positionNode = null;
            let normalNode = null;
            try {
                const args = builderArgs(entry, material, mesh);
                positionNode = entry.options.position(args);
                if (!positionNode || typeof positionNode !== 'object') {
                    throw new Error('options.position must return a TSL node');
                }
                if (typeof entry.options.normal === 'function') {
                    normalNode = entry.options.normal(args) ?? null;
                }
            } catch (err) {
                entry.failed = true;
                console.error(`[ctx.deform] "${entry.key}" builder failed — deform inactive:`, err);
                return;
            }
            entry.prevNodes.set(material, {
                position: material.positionNode ?? null,
                normal: material.normalNode ?? null,
                appliedPosition: positionNode,
                appliedNormal: normalNode,
            });
            material.positionNode = positionNode;
            if (normalNode) material.normalNode = normalNode;
            material.needsUpdate = true;
            entry.decorated.add(material);
        }
    }

    function restoreMesh(entry, mesh) {
        for (const material of materialsOf(mesh)) {
            if (!material || !entry.decorated.has(material)) continue;
            const record = entry.prevNodes.get(material);
            entry.decorated.delete(material);
            if (!record) continue;
            // Another entry may have chained on top of our node; restoring the
            // pre-deform graph would wipe its work, so leave the chain alone.
            if (material.positionNode !== record.appliedPosition) continue;
            material.positionNode = record.position;
            if (record.appliedNormal && material.normalNode === record.appliedNormal) {
                material.normalNode = record.normal;
            }
            material.needsUpdate = true;
        }
    }

    function decoratorKey(entry) {
        return `deform:${entry.id}`;
    }

    function scanAttachEntry(entry) {
        for (const [handle, obj] of nodeMap) {
            if (entry.matched.has(handle)) continue;
            if (!isDrawable(obj)) continue;
            if (!specMatches(entry.spec, handle, obj, entry.getAdapter)) continue;
            entry.matched.add(handle);
            // Registration applies immediately to the live mesh and reapplies
            // after every fastsync material rebuild.
            setMaterialDecorator(entry.layerId, handle, decoratorKey(entry),
                mesh => ensureDecorated(entry, mesh));
        }
    }

    function scanSimulateEntry(entry) {
        if (!computeAvailable(entry)) return;
        for (const [handle, obj] of nodeMap) {
            if (entry.matched.has(handle) || entry.simulations.has(handle)) continue;
            if (!isMesh(obj)) continue;
            if (!specMatches(entry.spec, handle, obj, entry.getAdapter)) continue;
            if (obj.userData?.jsmod !== true) {
                if (!entry.warnedJsmodHandles.has(handle)) {
                    entry.warnedJsmodHandles.add(handle);
                    console.error(`[ctx.deform] "${entry.key}": "${obj.name}" requires the three.js Deform/jsmod flag for buffer-writing simulation — skipped`);
                }
                continue;
            }
            const st = buildSimulationForMesh(entry, handle, obj);
            if (!st) continue;
            entry.simulations.set(handle, st);
            entry.matched.add(handle);
        }
    }

    function scanEntry(entry) {
        if (entry.kind === 'simulate') scanSimulateEntry(entry);
        else scanAttachEntry(entry);
    }

    function disposeEntry(entry) {
        if (entry.disposed) return false;
        entry.disposed = true;
        if (entry.kind === 'simulate') {
            for (const st of entry.simulations.values()) {
                disposeSimulationState(st, true);
            }
            entry.simulations.clear();
            entry.matched.clear();
        } else {
            for (const handle of entry.matched) {
                clearMaterialDecorator(handle, decoratorKey(entry));
                const mesh = nodeMap.get(handle);
                if (mesh) restoreMesh(entry, mesh);
            }
        }
        entries.delete(entry.id);
        return true;
    }

    function resetEntry(entry) {
        if (entry.disposed || entry.failed || entry.kind !== 'simulate') return false;
        let didReset = false;
        for (const st of entry.simulations.values()) {
            didReset = resetSimulationState(entry, st) || didReset;
        }
        return didReset;
    }

    function updateSimulateEntry(entry) {
        for (const [handle, st] of [...entry.simulations.entries()]) {
            const mesh = nodeMap.get(handle);
            if (mesh === st.mesh && mesh?.geometry === st.geometry) continue;
            disposeSimulationState(st, st.mesh?.geometry === st.geometry);
            entry.simulations.delete(handle);
            entry.matched.delete(handle);
        }
        if (entry.dynamic || entry.matched.size < entry.staticHandleCount) {
            scanSimulateEntry(entry);
        }
        for (const st of entry.simulations.values()) {
            dispatchSimulation(entry, st);
        }
    }

    function updateAttachEntry(entry) {
        if (entry.dynamic || entry.matched.size < entry.staticHandleCount) {
            scanAttachEntry(entry);
        }
        // Self-heal: appliers without the decorator hook (snapshot boot)
        // can swap materials under us — WeakSet guard makes this a no-op
        // when nothing changed.
        for (const handle of entry.matched) {
            const mesh = nodeMap.get(handle);
            if (mesh) ensureDecorated(entry, mesh);
        }
    }

    // ── Public surface ──────────────────────────────────────────────

    function attach(layerId, getAdapter, target, options = {}) {
        if (typeof options.position !== 'function') {
            throw new Error('ctx.deform.attach(target, options): options.position must be a function returning a TSL position node');
        }
        const spec = normalizeTarget(target);
        if (!spec) {
            throw new Error('ctx.deform.attach: unsupported target — use a node adapter, handle, name, "Prefix*", predicate, or an array of those');
        }
        const id = nextEntryId++;
        const entry = {
            id,
            kind: 'attach',
            key: typeof options.key === 'string' && options.key ? options.key : `deform_${id}`,
            layerId,
            spec,
            dynamic: spec.dynamic,
            staticHandleCount: countStaticHandles(spec),
            options,
            timeMode: options.timeMode === 'timeline' ? 'timeline' : 'clock',
            getAdapter,
            paramNodes: {},
            paramUniforms: new Map(),
            matched: new Set(),
            decorated: new WeakSet(),
            prevNodes: new WeakMap(),
            warnedNonNode: false,
            failed: false,
            disposed: false,
        };
        const params = buildParams(entry, options.params);
        entries.set(id, entry);
        scanEntry(entry);
        return freezePlainObject({
            key: entry.key,
            params,
            uniform(name) { return entry.paramUniforms.get(name) ?? null; },
            get matched() { return [...entry.matched]; },
            get active() { return !entry.disposed && !entry.failed; },
            dispose() { return disposeEntry(entry); },
        });
    }

    function simulate(layerId, getAdapter, target, options = {}) {
        if (typeof options.compute !== 'function') {
            throw new Error('ctx.deform.simulate(target, options): options.compute must be a function building a TSL compute kernel');
        }
        const spec = normalizeTarget(target);
        if (!spec) {
            throw new Error('ctx.deform.simulate: unsupported target — use a node adapter, handle, name, "Prefix*", predicate, or an array of those');
        }
        const id = nextEntryId++;
        const entry = {
            id,
            kind: 'simulate',
            key: typeof options.key === 'string' && options.key ? options.key : `deform_${id}`,
            layerId,
            spec,
            dynamic: spec.dynamic,
            staticHandleCount: countStaticHandles(spec),
            options,
            normalsMode: options.normals === 'recompute' ? 'recompute' : 'keep',
            timeMode: options.timeMode === 'timeline' ? 'timeline' : 'clock',
            getAdapter,
            paramNodes: {},
            paramUniforms: new Map(),
            matched: new Set(),
            simulations: new Map(),
            warnedJsmodHandles: new Set(),
            warnedGeometryHandles: new Set(),
            warnedComputeUnavailable: false,
            failed: false,
            disposed: false,
        };
        const params = buildParams(entry, options.params);
        entries.set(id, entry);
        scanSimulateEntry(entry);
        return freezePlainObject({
            key: entry.key,
            params,
            uniform(name) { return entry.paramUniforms.get(name) ?? null; },
            get matched() { return [...entry.matched]; },
            get active() { return !entry.disposed && !entry.failed; },
            reset() { return resetEntry(entry); },
            dispose() { return disposeEntry(entry); },
        });
    }

    function update(dt, elapsed) {
        if (entries.size === 0) return;
        dtUniform.value = clampDt(dt);
        clockUniform.value = elapsed;
        timelineUniform.value = getTimelineSeconds() || 0;
        for (const entry of entries.values()) {
            if (entry.disposed || entry.failed) continue;
            if (entry.kind === 'simulate') updateSimulateEntry(entry);
            else updateAttachEntry(entry);
        }
    }

    /** True when an entry actively deforms this handle in place — snapshot
     *  export must keep the Max mesh visible instead of jsmod-hiding it. */
    function drives(handle) {
        for (const entry of entries.values()) {
            if (!entry.disposed && !entry.failed && entry.matched.has(handle)) return true;
        }
        return false;
    }

    function disposeLayer(layerId) {
        for (const entry of [...entries.values()]) {
            if (entry.layerId === layerId) disposeEntry(entry);
        }
    }

    function createLayerFacade(layerId, getAdapter) {
        return freezePlainObject({
            attach(target, options = {}) {
                return attach(layerId, getAdapter, target, options);
            },
            simulate(target, options = {}) {
                return simulate(layerId, getAdapter, target, options);
            },
            list() {
                const out = [];
                for (const entry of entries.values()) {
                    if (entry.layerId !== layerId || entry.disposed) continue;
                    out.push({ key: entry.key, matched: [...entry.matched], active: !entry.failed });
                }
                return out;
            },
        });
    }

    return {
        update,
        drives,
        disposeLayer,
        createLayerFacade,
    };
}

export { createDeformSystem };
