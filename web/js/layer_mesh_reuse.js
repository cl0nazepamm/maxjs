// Layer-owned mesh reuse for procedural kits.
// A batch binds one Max-authored drawable once, then stores only per-instance
// matrices/colors. Max resources may be followed read-only or cloned once for
// isolated runtime edits; they are never cloned per placed instance.

import {
    OWNER_JS,
    OWNER_MAX,
    OWNER_OVERLAY,
    clearOwner,
    disposeOwnedResource,
    ensureMaxOwned,
    markOwned,
    setSnapshotTargetId,
} from './layer_ownership.js';
import { freezePlainObject } from './layer_utils.js';

const MAX_INSTANCE_CAPACITY = 100000;

function normalizePolicy(value, fallback, label) {
    const policy = value == null ? fallback : String(value).toLowerCase();
    if (policy === 'follow' || policy === 'clone') return policy;
    throw new TypeError(`${label} must be "follow" or "clone"`);
}

function normalizeCapacity(options = {}) {
    const transforms = Array.isArray(options.transforms) ? options.transforms : null;
    const requested = options.capacity ?? options.count ?? transforms?.length ?? 1;
    const capacity = Number(requested);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_INSTANCE_CAPACITY) {
        throw new RangeError(
            `instanceFromMax: capacity must be an integer between 1 and ${MAX_INSTANCE_CAPACITY}`,
        );
    }
    return capacity;
}

function normalizeInitialCount(options, capacity) {
    if (Array.isArray(options.transforms)) return 0;
    const count = options.count == null ? 0 : Number(options.count);
    if (!Number.isInteger(count) || count < 0 || count > capacity) {
        throw new RangeError('instanceFromMax: count must be an integer between 0 and capacity');
    }
    return count;
}

function copyMatrixLike(THREE, value, target) {
    if (value?.isMatrix4) {
        target.copy(value);
        return true;
    }
    const elements = value?.elements ?? value;
    if ((Array.isArray(elements) || ArrayBuffer.isView(elements)) && elements.length >= 16) {
        target.fromArray(elements);
        return true;
    }
    return false;
}

function readVectorLike(THREE, value, target) {
    if (value?.isVector3) return target.copy(value);
    const point = value?.point;
    if (point?.isVector3) return target.copy(point);
    const source = point ?? value;
    if (Array.isArray(source) || ArrayBuffer.isView(source)) {
        return target.set(Number(source[0]) || 0, Number(source[1]) || 0, Number(source[2]) || 0);
    }
    if (source && typeof source === 'object') {
        return target.set(Number(source.x) || 0, Number(source.y) || 0, Number(source.z) || 0);
    }
    return target.set(0, 0, 0);
}

function readScaleLike(THREE, value, target) {
    const uniform = Number(value);
    if (Number.isFinite(uniform)) return target.set(uniform, uniform, uniform);
    return readVectorLike(THREE, value, target);
}

function readEulerLike(THREE, value, target) {
    if (value?.isEuler) return target.setFromEuler(value);
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        const order = typeof value[3] === 'string' ? value[3] : 'XYZ';
        return target.setFromEuler(new THREE.Euler(
            Number(value[0]) || 0,
            Number(value[1]) || 0,
            Number(value[2]) || 0,
            order,
        ));
    }
    if (value && typeof value === 'object') {
        return target.setFromEuler(new THREE.Euler(
            Number(value.x) || 0,
            Number(value.y) || 0,
            Number(value.z) || 0,
            value.order || 'XYZ',
        ));
    }
    return target.identity();
}

function readQuaternionLike(THREE, value, target) {
    if (value?.isQuaternion) return target.copy(value);
    if (value?.isEuler) return target.setFromEuler(value);
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        if (value.length >= 4 && typeof value[3] !== 'string') {
            const w = Number(value[3]);
            return target.set(
                Number(value[0]) || 0,
                Number(value[1]) || 0,
                Number(value[2]) || 0,
                Number.isFinite(w) ? w : 1,
            ).normalize();
        }
        return readEulerLike(THREE, value, target);
    }
    if (value && typeof value === 'object') {
        if (Number.isFinite(Number(value.w))) {
            return target.set(
                Number(value.x) || 0,
                Number(value.y) || 0,
                Number(value.z) || 0,
                Number(value.w),
            ).normalize();
        }
        return readEulerLike(THREE, value, target);
    }
    return target.identity();
}

function composeTransformMatrix(THREE, value, fallback, target, scratch) {
    if (copyMatrixLike(THREE, value, target)) return target;
    if (copyMatrixLike(THREE, value?.matrix, target)) return target;

    const hasTransformOverride = value?.isVector3
        || Array.isArray(value)
        || ArrayBuffer.isView(value)
        || (
            value
            && typeof value === 'object'
            && [
                'at', 'position', 'worldPosition', 'quaternion', 'rotationEuler',
                'rotation', 'scale', 'scaleMultiplier', 'matrix',
            ].some(key => value[key] != null)
        );
    // Decompose/recompose loses shear. Preserve the exact authored matrix when
    // the caller did not request a component override.
    if (fallback && !hasTransformOverride) return target.copy(fallback);

    if (fallback) fallback.decompose(scratch.position, scratch.quaternion, scratch.scale);
    else {
        scratch.position.set(0, 0, 0);
        scratch.quaternion.identity();
        scratch.scale.set(1, 1, 1);
    }

    const transform = value?.isVector3 || Array.isArray(value) || ArrayBuffer.isView(value)
        ? { position: value }
        : (value ?? {});
    const position = transform.at ?? transform.position ?? transform.worldPosition;
    if (position != null) readVectorLike(THREE, position, scratch.position);
    if (transform.quaternion != null) {
        readQuaternionLike(THREE, transform.quaternion, scratch.quaternion);
    } else if (transform.rotationEuler != null) {
        readEulerLike(THREE, transform.rotationEuler, scratch.quaternion);
    } else if (transform.rotation != null) {
        readQuaternionLike(THREE, transform.rotation, scratch.quaternion);
    }
    if (transform.scale != null) readScaleLike(THREE, transform.scale, scratch.scale);
    if (transform.scaleMultiplier != null && Number.isFinite(Number(transform.scaleMultiplier))) {
        scratch.scale.multiplyScalar(Number(transform.scaleMultiplier));
    }
    return target.compose(scratch.position, scratch.quaternion, scratch.scale);
}

function cloneGeometry(source, owner) {
    if (!source?.clone) return null;
    return markOwned(clearOwner(source.clone()), owner);
}

function resolveUsage(THREE, value) {
    if (Number.isFinite(Number(value))) return Number(value);
    switch (String(value ?? 'dynamic').toLowerCase()) {
        case 'static': return THREE.StaticDrawUsage;
        case 'stream': return THREE.StreamDrawUsage;
        default: return THREE.DynamicDrawUsage;
    }
}

function objectWorldMatrix(object, target) {
    object?.updateWorldMatrix?.(true, false);
    return object?.matrixWorld ? target.copy(object.matrixWorld) : target.identity();
}

function matrixDeterminantIsSupported(matrix) {
    return matrix.determinant() >= 0;
}

function caseInsensitiveProp(userProps, requested) {
    const wanted = String(requested ?? '').toLowerCase();
    for (const [key, value] of Object.entries(userProps ?? {})) {
        if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
}

function stableId(base, handle, used) {
    const requested = String(base ?? '').trim() || `node_${handle}`;
    if (!used.has(requested)) {
        used.add(requested);
        return requested;
    }
    const withHandle = `${requested}#${handle}`;
    if (!used.has(withHandle)) {
        used.add(withHandle);
        return withHandle;
    }
    let suffix = 2;
    let candidate = `${withHandle}-${suffix}`;
    while (used.has(candidate)) {
        suffix += 1;
        candidate = `${withHandle}-${suffix}`;
    }
    used.add(candidate);
    return candidate;
}

function hasNodeMaterial(material) {
    const materials = Array.isArray(material) ? material : [material];
    return materials.some(item => item?.isNodeMaterial === true);
}

function isDescendantOf(object, root) {
    let current = object;
    while (current) {
        if (current === root) return true;
        current = current.parent;
    }
    return false;
}

/**
 * Creates the public ctx.js.instanceFromMax() and ctx.kits facades for one
 * layer context. The manager owns registration/teardown; this module owns the
 * fixed-capacity batch behavior and prefab-local matrix math.
 */
export function createLayerMeshReuse({
    THREE,
    layerId,
    group,
    overlayGroup,
    isActive,
    resolveAdapter,
    listUnder,
    cloneMaterial,
    cloneFromMax,
    registerBatch,
    unregisterBatch,
    registerComposite = () => {},
    unregisterComposite = () => {},
    untrackResource = () => {},
    notifyChanged = () => {},
    debugWarn = () => {},
}) {
    const scratch = {
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1),
        matrixA: new THREE.Matrix4(),
        matrixB: new THREE.Matrix4(),
        matrixC: new THREE.Matrix4(),
        color: new THREE.Color(),
    };

    const snapshotIdFor = id => `runtime:${layerId}:${id}`;

    function ensureActive(action) {
        if (isActive()) return true;
        debugWarn(`[LayerManager] Layer "${layerId}" ignored stale ${action}`);
        return false;
    }

    function resolveLayerParent(options = {}) {
        const fallback = options.overlay ? overlayGroup : group;
        if (options.parent == null) return fallback;
        if (!options.parent?.isObject3D) {
            throw new TypeError('ctx.js: parent must be a THREE.Object3D owned by this layer');
        }
        if (!isDescendantOf(options.parent, group) && !isDescendantOf(options.parent, overlayGroup)) {
            throw new TypeError('ctx.js: parent must belong to this layer\'s js or overlay root');
        }
        return options.parent;
    }

    function ensureSourceOwned(sourceRaw) {
        ensureMaxOwned(sourceRaw);
        ensureMaxOwned(sourceRaw?.geometry);
        const materials = Array.isArray(sourceRaw?.material)
            ? sourceRaw.material
            : [sourceRaw?.material];
        for (const material of materials) ensureMaxOwned(material);
    }

    function assertClassicCloneMaterial(source, action) {
        const resolved = resolveStaticMesh(source);
        if (resolved && hasNodeMaterial(resolved.raw.material)) {
            throw new TypeError(
                `${action}: NodeMaterial cloning is shallow in Three.js; use createInstances() with materials: "follow" in v1`,
            );
        }
        return resolved;
    }

    function resolveStaticMesh(source) {
        const adapter = resolveAdapter(source);
        const raw = adapter?.raw ?? adapter?.object ?? null;
        if (!adapter || !raw?.isMesh) return null;
        if (raw.isSkinnedMesh || raw.isBatchedMesh || raw.morphTargetInfluences || raw.userData?.jsmod) {
            throw new TypeError(
                `instanceFromMax: "${adapter.name || adapter.handle}" must be a static mesh; `
                + 'three.js Deform, skinned, batched, and morph-target meshes are not supported in v1',
            );
        }
        if (!raw.geometry || !raw.material) {
            throw new TypeError(`instanceFromMax: "${adapter.name || adapter.handle}" has no geometry or material`);
        }
        return { adapter, raw };
    }

    function createBatch(source, options = {}) {
        if (!ensureActive('instanceFromMax()')) return null;
        const resolved = resolveStaticMesh(source);
        if (!resolved) return null;

        const { adapter, raw: sourceRaw } = resolved;
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        const capacity = normalizeCapacity(options);
        const initialCount = normalizeInitialCount(options, capacity);
        const geometryPolicy = normalizePolicy(options.geometry, 'follow', 'instanceFromMax: geometry');
        const materialPolicy = normalizePolicy(
            options.materials ?? options.material,
            'follow',
            'instanceFromMax: materials',
        );
        if (materialPolicy === 'clone' && hasNodeMaterial(sourceRaw.material)) {
            throw new TypeError(
                'instanceFromMax: THREE.NodeMaterial cloning is shallow; use materials: "follow" for TSL materials in v1',
            );
        }
        const followsSource = geometryPolicy === 'follow' || materialPolicy === 'follow';
        const parent = resolveLayerParent(options);

        ensureSourceOwned(sourceRaw);
        const sourceWorld = objectWorldMatrix(sourceRaw, new THREE.Matrix4());
        let geometry = null;
        let material = null;
        let raw = null;
        try {
            geometry = geometryPolicy === 'follow'
                ? sourceRaw.geometry
                : cloneGeometry(sourceRaw.geometry, owner);
            material = materialPolicy === 'follow'
                ? sourceRaw.material
                : cloneMaterial(sourceRaw.material, owner);
            if (!geometry || !material) throw new Error('source resource clone failed');
            raw = new THREE.InstancedMesh(geometry, material, capacity);
        } catch (error) {
            const seen = new Set();
            if (geometryPolicy === 'clone') disposeOwnedResource(geometry, { seen, force: true });
            if (materialPolicy === 'clone') disposeOwnedResource(material, { seen, force: true });
            throw error;
        }
        raw.name = options.name || `${sourceRaw.name || 'mesh'}_instances`;
        raw.castShadow = options.castShadow ?? sourceRaw.castShadow;
        raw.receiveShadow = options.receiveShadow ?? sourceRaw.receiveShadow;
        raw.renderOrder = options.renderOrder ?? sourceRaw.renderOrder;
        raw.frustumCulled = options.frustumCulled !== false;
        raw.visible = options.visible !== false;
        raw.count = 0;
        raw.instanceMatrix.setUsage(resolveUsage(THREE, options.usage));
        raw.userData ??= {};
        raw.userData.maxjsRuntimeInstances = true;
        raw.userData.maxjsSourceHandle = adapter.handle;
        raw.userData.maxjsInstanceCapacity = capacity;
        raw.userData.maxjsGeometryPolicy = geometryPolicy;
        raw.userData.maxjsMaterialPolicy = materialPolicy;
        markOwned(raw, owner);
        if (options.snapshotId) setSnapshotTargetId(raw, snapshotIdFor(options.snapshotId));
        parent.add(raw);
        raw.updateWorldMatrix(true, false);

        let count = 0;
        let dirty = false;
        let disposed = false;
        let missingSource = false;
        let visibleBeforeMissing = raw.visible;
        let registered = false;
        const socketRecords = Object.freeze([...(options._sockets ?? [])]);

        function resolveSocket(value) {
            if (value && socketRecords.includes(value)) return value;
            if (typeof value === 'string') return socketRecords.find(socket => socket.id === value) ?? null;
            if (Number.isFinite(Number(value))) {
                return socketRecords.find(socket => socket.handle === Number(value)) ?? null;
            }
            return null;
        }

        function defaultMatrixForSpace(space, target) {
            if (space === 'local') {
                raw.updateWorldMatrix(true, false);
                return target.copy(raw.matrixWorld).invert().multiply(sourceWorld);
            }
            return target.copy(sourceWorld);
        }

        function toLocalMatrix(value, callOptions = {}, target = new THREE.Matrix4()) {
            const requestedSpace = String(callOptions.space ?? value?.space ?? options.space ?? 'world').toLowerCase();
            const space = requestedSpace === 'local' ? 'local' : 'world';
            const fallback = defaultMatrixForSpace(space, scratch.matrixB);
            composeTransformMatrix(THREE, value, fallback, scratch.matrixA, scratch);
            if (space === 'local') target.copy(scratch.matrixA);
            else {
                raw.updateWorldMatrix(true, false);
                target.copy(raw.matrixWorld).invert().multiply(scratch.matrixA);
            }
            if (!matrixDeterminantIsSupported(target)) {
                throw new RangeError('instanceFromMax: negatively scaled instance matrices are not supported by THREE.InstancedMesh');
            }
            return target;
        }

        function markDirty() {
            dirty = true;
            raw.instanceMatrix.needsUpdate = true;
            if (raw.instanceColor) raw.instanceColor.needsUpdate = true;
        }

        function writeAt(index, value, callOptions = {}) {
            if (disposed || !ensureActive('instance batch mutation')) return false;
            if (!Number.isInteger(index) || index < 0 || index >= count) return false;
            raw.setMatrixAt(index, toLocalMatrix(value, callOptions, scratch.matrixC));
            markDirty();
            return true;
        }

        function append(value, callOptions = {}) {
            if (disposed || !ensureActive('instance batch add()')) return -1;
            if (count >= capacity) return -1;
            const index = count;
            raw.setMatrixAt(index, toLocalMatrix(value, callOptions, scratch.matrixC));
            count += 1;
            raw.count = count;
            markDirty();
            return index;
        }

        function flush(flushOptions = {}) {
            if (disposed || !ensureActive('instance batch flush()')) return false;
            if (!dirty && flushOptions.force !== true) return false;
            raw.instanceMatrix.needsUpdate = true;
            if (raw.instanceColor) raw.instanceColor.needsUpdate = true;
            if (flushOptions.bounds !== false) {
                raw.computeBoundingBox?.();
                raw.computeBoundingSphere?.();
            }
            dirty = false;
            if (flushOptions.notify !== false) {
                notifyChanged({ type: 'jsScene', layerId, action: 'instanceBatch' });
            }
            return true;
        }

        const internal = {
            get raw() { return raw; },
            get disposed() { return disposed; },
            syncSource() {
                if (disposed) return false;
                const next = resolveStaticMesh(adapter.handle);
                if (!next) {
                    if (followsSource && !missingSource) {
                        missingSource = true;
                        visibleBeforeMissing = raw.visible;
                        raw.visible = false;
                        return true;
                    }
                    return false;
                }

                const nextRaw = next.raw;
                ensureSourceOwned(nextRaw);
                sourceWorld.copy(objectWorldMatrix(nextRaw, scratch.matrixA));
                let changed = false;
                if (geometryPolicy === 'follow' && raw.geometry !== nextRaw.geometry) {
                    raw.geometry = nextRaw.geometry;
                    changed = true;
                }
                if (materialPolicy === 'follow' && raw.material !== nextRaw.material) {
                    raw.material = nextRaw.material;
                    changed = true;
                }
                if (missingSource) {
                    missingSource = false;
                    raw.visible = visibleBeforeMissing;
                    changed = true;
                }
                if (changed) {
                    raw.computeBoundingBox?.();
                    raw.computeBoundingSphere?.();
                }
                return changed;
            },
            retire() {
                if (disposed) return false;
                disposed = true;
                if (registered) unregisterBatch(internal);
                registered = false;
                raw.parent?.remove(raw);
                disposeOwnedResource(raw, { force: true });
                return true;
            },
        };

        const handle = freezePlainObject({
            get raw() { return disposed ? null : raw; },
            get object() { return disposed ? null : raw; },
            get sourceHandle() { return adapter.handle; },
            get capacity() { return capacity; },
            get count() { return count; },
            get geometryPolicy() { return geometryPolicy; },
            get materialPolicy() { return materialPolicy; },
            get sockets() { return socketRecords; },
            get disposed() { return disposed; },
            add(value = null, callOptions = {}) {
                return append(value, callOptions);
            },
            addMany(values, callOptions = {}) {
                if (disposed || !ensureActive('instance batch addMany()')) return Object.freeze([]);
                const indices = [];
                for (const value of values ?? []) {
                    const index = append(value, callOptions);
                    if (index < 0) break;
                    indices.push(index);
                }
                if (callOptions.flush !== false) flush(callOptions);
                return Object.freeze(indices);
            },
            setMatrixAt(index, matrix, callOptions = {}) {
                return writeAt(index, matrix, callOptions);
            },
            setTransformAt(index, transform, callOptions = {}) {
                return writeAt(index, transform, callOptions);
            },
            getMatrixAt(index, target = new THREE.Matrix4()) {
                if (disposed || !Number.isInteger(index) || index < 0 || index >= count) return null;
                raw.getMatrixAt(index, target);
                return target;
            },
            getWorldMatrixAt(index, target = new THREE.Matrix4()) {
                if (disposed || !Number.isInteger(index) || index < 0 || index >= count) return null;
                raw.updateWorldMatrix(true, false);
                raw.getMatrixAt(index, scratch.matrixA);
                return target.multiplyMatrices(raw.matrixWorld, scratch.matrixA);
            },
            getSocket(socket) {
                return resolveSocket(socket);
            },
            getSocketMatrixAt(index, socket, target = new THREE.Matrix4(), callOptions = {}) {
                if (disposed || !Number.isInteger(index) || index < 0 || index >= count) return null;
                const descriptor = resolveSocket(socket);
                if (!descriptor) return null;
                raw.getMatrixAt(index, target);
                target.multiply(scratch.matrixA.fromArray(descriptor.matrix));
                if (String(callOptions.space ?? 'world').toLowerCase() !== 'local') {
                    raw.updateWorldMatrix(true, false);
                    target.premultiply(raw.matrixWorld);
                }
                return target;
            },
            getSocketPositionAt(index, socket, target = new THREE.Vector3(), callOptions = {}) {
                const matrix = handle.getSocketMatrixAt(index, socket, scratch.matrixB, callOptions);
                return matrix ? target.setFromMatrixPosition(matrix) : null;
            },
            addAtSocket(socket, targetMatrix, callOptions = {}) {
                const descriptor = resolveSocket(socket);
                if (!descriptor) return -1;
                if (!copyMatrixLike(THREE, targetMatrix?.matrix ?? targetMatrix, scratch.matrixA)) {
                    throw new TypeError('instance batch addAtSocket: targetMatrix must be a Matrix4 or 16-value array');
                }
                scratch.matrixA.multiply(scratch.matrixB.fromArray(descriptor.matrix).invert());
                return append(scratch.matrixA, { ...callOptions, space: 'world' });
            },
            setPositionAt(index, x, y, z, callOptions = {}) {
                if (disposed || !Number.isInteger(index) || index < 0 || index >= count) return false;
                const requestedSpace = String(callOptions.space ?? options.space ?? 'world').toLowerCase();
                if (requestedSpace === 'local') raw.getMatrixAt(index, scratch.matrixA);
                else handle.getWorldMatrixAt(index, scratch.matrixA);
                if (x?.isVector3 || Array.isArray(x) || ArrayBuffer.isView(x) || (x && typeof x === 'object')) {
                    readVectorLike(THREE, x, scratch.position);
                } else {
                    scratch.position.set(Number(x) || 0, Number(y) || 0, Number(z) || 0);
                }
                scratch.matrixA.setPosition(scratch.position);
                return writeAt(index, scratch.matrixA, { space: requestedSpace });
            },
            setColorAt(index, color) {
                if (disposed || !ensureActive('instance batch setColorAt()')) return false;
                if (!Number.isInteger(index) || index < 0 || index >= count) return false;
                raw.setColorAt(index, scratch.color.set(color));
                markDirty();
                return true;
            },
            getColorAt(index, target = new THREE.Color()) {
                if (disposed || !Number.isInteger(index) || index < 0 || index >= count || !raw.instanceColor) return null;
                raw.getColorAt(index, target);
                return target;
            },
            removeAt(index) {
                if (disposed || !ensureActive('instance batch removeAt()')) return false;
                if (!Number.isInteger(index) || index < 0 || index >= count) return false;
                const last = count - 1;
                if (index !== last) {
                    raw.getMatrixAt(last, scratch.matrixA);
                    raw.setMatrixAt(index, scratch.matrixA);
                    if (raw.instanceColor) {
                        raw.getColorAt(last, scratch.color);
                        raw.setColorAt(index, scratch.color);
                    }
                }
                count = last;
                raw.count = count;
                markDirty();
                return true;
            },
            clear() {
                if (disposed || !ensureActive('instance batch clear()')) return false;
                if (count === 0) return false;
                count = 0;
                raw.count = 0;
                markDirty();
                return true;
            },
            flush,
            refresh() {
                if (disposed || !ensureActive('instance batch refresh()')) return false;
                const next = resolveStaticMesh(adapter.handle);
                if (!next) return false;
                const nextRaw = next.raw;
                ensureSourceOwned(nextRaw);
                if (materialPolicy === 'clone' && hasNodeMaterial(nextRaw.material)) {
                    throw new TypeError(
                        'instanceFromMax: THREE.NodeMaterial cloning is shallow; use materials: "follow" for TSL materials in v1',
                    );
                }
                let nextGeometry = null;
                let nextMaterial = null;
                try {
                    nextGeometry = geometryPolicy === 'clone'
                        ? cloneGeometry(nextRaw.geometry, owner)
                        : nextRaw.geometry;
                    nextMaterial = materialPolicy === 'clone'
                        ? cloneMaterial(nextRaw.material, owner)
                        : nextRaw.material;
                    if (!nextGeometry || !nextMaterial) throw new Error('source resource clone failed');
                } catch (error) {
                    const prepared = new Set();
                    if (geometryPolicy === 'clone') disposeOwnedResource(nextGeometry, { seen: prepared, force: true });
                    if (materialPolicy === 'clone') disposeOwnedResource(nextMaterial, { seen: prepared, force: true });
                    throw error;
                }

                const seen = new Set();
                const previousGeometry = raw.geometry;
                const previousMaterial = raw.material;
                const changed = missingSource
                    || previousGeometry !== nextGeometry
                    || previousMaterial !== nextMaterial;
                raw.geometry = nextGeometry;
                raw.material = nextMaterial;
                if (geometryPolicy === 'clone') {
                    disposeOwnedResource(previousGeometry, { seen, force: true });
                }
                if (materialPolicy === 'clone') {
                    disposeOwnedResource(previousMaterial, { seen, force: true });
                }

                sourceWorld.copy(objectWorldMatrix(nextRaw, scratch.matrixA));
                if (missingSource) raw.visible = visibleBeforeMissing;
                missingSource = false;
                raw.computeBoundingBox?.();
                raw.computeBoundingSphere?.();
                if (changed) notifyChanged({ type: 'jsScene', layerId, action: 'instanceRefresh' });
                return changed;
            },
            dispose(disposeOptions = {}) {
                if (disposed) return false;
                disposed = true;
                if (registered) unregisterBatch(internal);
                registered = false;
                raw.parent?.remove(raw);
                disposeOwnedResource(raw, { force: true });
                if (disposeOptions.notify !== false) {
                    notifyChanged({ type: 'jsScene', layerId, action: 'instanceDispose' });
                }
                return true;
            },
        });

        registerBatch(internal);
        registered = true;

        try {
            for (let i = 0; i < initialCount; i += 1) append(null);
            if (Array.isArray(options.transforms)) {
                for (const transform of options.transforms) {
                    if (append(transform) < 0) break;
                }
            }
            if (count > 0) flush({ notify: false });
        } catch (error) {
            handle.dispose({ notify: false });
            throw error;
        }
        notifyChanged({ type: 'jsScene', layerId, action: 'instanceCreate' });
        return handle;
    }

    function createOwnedGroup(name, options = {}) {
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        const parent = resolveLayerParent(options);
        const raw = markOwned(new THREE.Group(), owner);
        raw.name = name;
        if (options.snapshotId) setSnapshotTargetId(raw, snapshotIdFor(options.snapshotId));
        parent.add(raw);
        return raw;
    }

    function captureKit(source, options = {}) {
        if (!ensureActive('kits.capture()')) return null;
        const rootAdapter = resolveAdapter(source);
        const rootRaw = rootAdapter?.raw ?? rootAdapter?.object ?? null;
        if (!rootAdapter || !rootRaw?.isObject3D) return null;

        const descendants = [...listUnder(rootAdapter, { includeSelf: true })]
            .filter(Boolean)
            .sort((a, b) => Number(a.handle) - Number(b.handle));
        if (!descendants.some(adapter => adapter.handle === rootAdapter.handle)) {
            descendants.unshift(rootAdapter);
        }

        rootRaw.updateWorldMatrix(true, true);
        const rootWorld = objectWorldMatrix(rootRaw, new THREE.Matrix4());
        const inverseRoot = new THREE.Matrix4().copy(rootWorld).invert();
        const partIds = new Set();
        const moduleProperty = options.moduleProperty ?? options.moduleProp ?? 'module';
        const socketProperty = options.socketProperty ?? options.socketProp ?? 'socket';
        const socketForProperty = options.socketForProperty ?? options.socketForProp ?? 'socketFor';
        const adapterByHandle = new Map(descendants.map(adapter => [Number(adapter.handle), adapter]));
        const partDrafts = [];
        const socketDrafts = [];

        for (const adapter of descendants) {
            const raw = adapter.raw ?? adapter.object ?? null;
            if (!raw?.isObject3D) continue;
            raw.updateWorldMatrix(true, false);
            const localMatrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, raw.matrixWorld);
            const userProps = Object.freeze({ ...(adapter.userProps ?? {}) });

            if (raw.isMesh) {
                resolveStaticMesh(adapter);
                const explicitId = caseInsensitiveProp(userProps, moduleProperty);
                const requestedId = explicitId ?? adapter.name;
                if (explicitId != null && partIds.has(String(requestedId))) {
                    throw new TypeError(`ctx.kits.capture: duplicate module id "${requestedId}"`);
                }
                const id = stableId(requestedId, adapter.handle, partIds);
                partDrafts.push({
                    id,
                    name: adapter.name || id,
                    handle: adapter.handle,
                    node: adapter,
                    matrix: Object.freeze(localMatrix.toArray()),
                    userProps,
                    raw,
                });
            }

            if (options.sockets !== false) {
                const socketValue = caseInsensitiveProp(userProps, socketProperty);
                if (socketValue !== undefined && socketValue !== false && socketValue !== '') {
                    socketDrafts.push({
                        localId: String(socketValue === true ? adapter.name : socketValue),
                        name: adapter.name || String(socketValue),
                        handle: adapter.handle,
                        node: adapter,
                        matrix: Object.freeze(localMatrix.toArray()),
                        userProps,
                        raw,
                        socketFor: caseInsensitiveProp(userProps, socketForProperty),
                    });
                }
            }
        }

        if (partDrafts.length === 0) {
            throw new TypeError(`ctx.kits.capture: "${rootAdapter.name || rootAdapter.handle}" has no reusable static meshes`);
        }

        const draftById = new Map(partDrafts.map(part => [part.id, part]));
        const draftByHandle = new Map(partDrafts.map(part => [Number(part.handle), part]));
        const draftByName = new Map(partDrafts.map(part => [part.name, part]));

        function findSocketOwner(socket) {
            if (socket.socketFor != null && socket.socketFor !== '') {
                const requested = String(socket.socketFor);
                const explicit = draftById.get(requested) ?? draftByName.get(requested) ?? null;
                if (!explicit) {
                    throw new TypeError(`ctx.kits.capture: socket "${socket.localId}" targets unknown module "${requested}"`);
                }
                return explicit;
            }
            let current = socket.raw;
            const seen = new Set();
            while (current) {
                const parentHandle = Number(current.userData?.maxjsParentHandle);
                if (!Number.isFinite(parentHandle) || seen.has(parentHandle)) break;
                seen.add(parentHandle);
                const part = draftByHandle.get(parentHandle);
                if (part) return part;
                current = adapterByHandle.get(parentHandle)?.raw ?? null;
            }
            return partDrafts.length === 1 ? partDrafts[0] : null;
        }

        const socketsByPart = new Map(partDrafts.map(part => [part.id, []]));
        const kitSocketIds = new Set();
        const sockets = [];
        for (const socket of socketDrafts) {
            const ownerPart = findSocketOwner(socket);
            if (ownerPart) {
                const partSockets = socketsByPart.get(ownerPart.id);
                if (partSockets.some(item => item.id === socket.localId)) {
                    throw new TypeError(
                        `ctx.kits.capture: duplicate socket id "${socket.localId}" on module "${ownerPart.id}"`,
                    );
                }
                const partInverse = new THREE.Matrix4().fromArray(ownerPart.matrix).invert();
                const partLocal = partInverse.multiply(new THREE.Matrix4().fromArray(socket.matrix));
                partSockets.push(freezePlainObject({
                    id: socket.localId,
                    name: socket.name || socket.localId,
                    handle: socket.handle,
                    node: socket.node,
                    matrix: Object.freeze(partLocal.toArray()),
                    userProps: socket.userProps,
                    moduleId: ownerPart.id,
                }));
            }

            const qualifiedId = ownerPart ? `${ownerPart.id}:${socket.localId}` : socket.localId;
            const id = stableId(qualifiedId, socket.handle, kitSocketIds);
            sockets.push(freezePlainObject({
                id,
                localId: socket.localId,
                name: socket.name || socket.localId,
                handle: socket.handle,
                node: socket.node,
                matrix: socket.matrix,
                userProps: socket.userProps,
                moduleId: ownerPart?.id ?? null,
            }));
        }

        const parts = partDrafts.map(part => {
            const moduleSockets = Object.freeze(socketsByPart.get(part.id));
            const moduleRecord = freezePlainObject({
                id: part.id,
                name: part.name,
                handle: part.handle,
                node: part.node,
                matrix: part.matrix,
                userProps: part.userProps,
                sockets: moduleSockets,
                getSocket(id) {
                    return moduleSockets.find(socket => socket.id === String(id)) ?? null;
                },
                createInstances(instanceOptions = {}) {
                    return createBatch(part.node, {
                        ...instanceOptions,
                        name: instanceOptions.name || `${part.id}_instances`,
                        _sockets: moduleSockets,
                    });
                },
                instantiate(instanceOptions = {}) {
                    const parent = resolveLayerParent(instanceOptions);
                    assertClassicCloneMaterial(part.node, `ctx.kits module "${part.id}" instantiate`);
                    return cloneFromMax(part.node, {
                        ...instanceOptions,
                        parent,
                    });
                },
            });
            return moduleRecord;
        });

        const frozenParts = Object.freeze(parts);
        const frozenSockets = Object.freeze(sockets);
        const partById = new Map(parts.map(part => [part.id, part]));
        const socketById = new Map(sockets.map(socket => [socket.id, socket]));
        for (const socket of sockets) {
            const matches = sockets.filter(item => item.localId === socket.localId);
            if (matches.length === 1) socketById.set(socket.localId, socket);
        }
        const kitName = options.name || rootAdapter.name || `kit_${rootAdapter.handle}`;

        function resolveSocket(value) {
            if (value && sockets.includes(value)) return value;
            if (typeof value === 'string') return socketById.get(value) ?? null;
            if (Number.isFinite(Number(value))) {
                return sockets.find(socket => socket.handle === Number(value)) ?? null;
            }
            return null;
        }

        function createKitInstances(instanceOptions = {}) {
            if (!ensureActive('kit.createInstances()')) return null;
            const capacity = normalizeCapacity(instanceOptions);
            const initialCount = normalizeInitialCount(instanceOptions, capacity);
            const name = instanceOptions.name || `${kitName}_instances`;
            const rawGroup = createOwnedGroup(name, instanceOptions);
            rawGroup.userData.maxjsRuntimeKit = true;
            rawGroup.userData.maxjsKitSourceHandle = rootAdapter.handle;
            rawGroup.userData.maxjsKitCapacity = capacity;
            if (
                instanceOptions.at != null
                || instanceOptions.position != null
                || instanceOptions.rotation != null
                || instanceOptions.rotationEuler != null
                || instanceOptions.quaternion != null
                || instanceOptions.scale != null
                || instanceOptions.matrix != null
            ) {
                const parent = rawGroup.parent;
                parent?.updateWorldMatrix?.(true, false);
                const parentWorld = parent?.matrixWorld ?? scratch.matrixA.identity();
                composeTransformMatrix(THREE, instanceOptions.matrix ?? instanceOptions, null, scratch.matrixB, scratch);
                scratch.matrixC.copy(parentWorld).invert().multiply(scratch.matrixB);
                rawGroup.matrixAutoUpdate = false;
                rawGroup.matrix.copy(scratch.matrixC);
            }
            rawGroup.updateWorldMatrix(true, false);

            const partBatches = [];
            try {
                for (let index = 0; index < parts.length; index += 1) {
                    const part = parts[index];
                    const batch = createBatch(part.node, {
                        capacity,
                        count: 0,
                        geometry: instanceOptions.geometry,
                        materials: instanceOptions.materials ?? instanceOptions.material,
                        usage: instanceOptions.usage,
                        parent: rawGroup,
                        name: `${name}:${part.id}`,
                        snapshotId: instanceOptions.snapshotId
                            ? `${instanceOptions.snapshotId}:part:${encodeURIComponent(part.id)}`
                            : undefined,
                        frustumCulled: instanceOptions.frustumCulled,
                        castShadow: instanceOptions.castShadow,
                        receiveShadow: instanceOptions.receiveShadow,
                        space: 'world',
                        _sockets: part.sockets,
                    });
                    if (!batch) throw new Error(`ctx.kits: source module "${part.id}" is unavailable`);
                    partBatches.push(batch);
                }
            } catch (error) {
                for (const batch of partBatches) batch.dispose();
                rawGroup.parent?.remove(rawGroup);
                disposeOwnedResource(rawGroup, { force: true });
                throw error;
            }
            const rootMatrices = new Float32Array(capacity * 16);
            const partPlacementMatrices = parts.map(() => new THREE.Matrix4());
            const validationMatrix = new THREE.Matrix4();
            const frozenPartBatches = Object.freeze(partBatches.map(batch => freezePlainObject({
                get sourceHandle() { return batch.sourceHandle; },
                get capacity() { return batch.capacity; },
                get count() { return batch.count; },
                get geometryPolicy() { return batch.geometryPolicy; },
                get materialPolicy() { return batch.materialPolicy; },
                get sockets() { return batch.sockets; },
                get disposed() { return batch.disposed; },
                getMatrixAt: (...args) => batch.getMatrixAt(...args),
                getWorldMatrixAt: (...args) => batch.getWorldMatrixAt(...args),
                getColorAt: (...args) => batch.getColorAt(...args),
                getSocket: (...args) => batch.getSocket(...args),
                getSocketMatrixAt: (...args) => batch.getSocketMatrixAt(...args),
                getSocketPositionAt: (...args) => batch.getSocketPositionAt(...args),
            })));
            let count = 0;
            let disposed = false;
            let registeredComposite = false;

            function partBatchesAreAligned() {
                return partBatches.every(batch => (
                    batch.count === count
                    && batch.raw?.count === count
                    && batch.raw?.parent === rawGroup
                ));
            }

            function requirePartBatchAlignment() {
                if (!partBatchesAreAligned()) {
                    throw new Error('ctx.kits: part batches were mutated directly and lost index alignment');
                }
            }

            function readRootLocal(index, target) {
                return target.fromArray(rootMatrices, index * 16);
            }

            function rootLocalFromPlacement(value, callOptions, target) {
                const requestedSpace = String(callOptions?.space ?? value?.space ?? instanceOptions.space ?? 'world').toLowerCase();
                rawGroup.updateWorldMatrix(true, false);
                if (requestedSpace === 'local') {
                    const fallbackLocal = scratch.matrixA.copy(rawGroup.matrixWorld).invert().multiply(rootWorld);
                    return composeTransformMatrix(THREE, value, fallbackLocal, target, scratch);
                }
                composeTransformMatrix(THREE, value, rootWorld, scratch.matrixB, scratch);
                return target.copy(rawGroup.matrixWorld).invert().multiply(scratch.matrixB);
            }

            function appendKit(value = null, callOptions = {}) {
                if (disposed || !ensureActive('kit instance add()')) return -1;
                if (count >= capacity) return -1;
                requirePartBatchAlignment();
                const index = count;
                const rootLocal = rootLocalFromPlacement(value, callOptions, scratch.matrixA);
                rawGroup.updateWorldMatrix(true, false);
                for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
                    const part = parts[partIndex];
                    const partLocal = scratch.matrixB.fromArray(part.matrix);
                    const partWorld = partPlacementMatrices[partIndex]
                        .multiplyMatrices(rawGroup.matrixWorld, rootLocal)
                        .multiply(partLocal);
                    partBatches[partIndex].raw.updateWorldMatrix(true, false);
                    validationMatrix.copy(partBatches[partIndex].raw.matrixWorld).invert().multiply(partWorld);
                    if (!matrixDeterminantIsSupported(validationMatrix)) {
                        throw new RangeError(
                            `ctx.kits: module "${part.id}" produces a negative-determinant instance matrix`,
                        );
                    }
                }

                // Save before calling child batches: all batch factories share
                // the layer scratch matrices and may reuse scratch.matrixA.
                rootMatrices.set(rootLocal.elements, index * 16);
                let appendedParts = 0;
                try {
                    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
                        const added = partBatches[partIndex].add(
                            partPlacementMatrices[partIndex],
                            { space: 'world' },
                        );
                        if (added !== index) {
                            throw new Error(`ctx.kits: part batch "${parts[partIndex].id}" lost index alignment`);
                        }
                        appendedParts += 1;
                    }
                } catch (error) {
                    for (let partIndex = 0; partIndex < appendedParts; partIndex += 1) {
                        partBatches[partIndex].removeAt(index);
                    }
                    throw error;
                }
                count += 1;
                return index;
            }

            function disposeKitBatch(disposeOptions = {}) {
                if (disposed) return false;
                disposed = true;
                if (registeredComposite) unregisterComposite(composite);
                registeredComposite = false;
                for (const batch of partBatches) batch.dispose({ notify: false });
                rawGroup.parent?.remove(rawGroup);
                disposeOwnedResource(rawGroup, { force: true });
                if (disposeOptions.notify !== false) {
                    notifyChanged({ type: 'jsScene', layerId, action: 'kitDispose' });
                }
                return true;
            }

            const composite = {
                retire() {
                    return disposeKitBatch({ notify: false });
                },
            };

            const kitBatch = freezePlainObject({
                get raw() { return disposed ? null : rawGroup; },
                get root() { return disposed ? null : rawGroup; },
                get capacity() { return capacity; },
                get count() { return count; },
                get batches() { return frozenPartBatches; },
                get parts() { return frozenParts; },
                get sockets() { return frozenSockets; },
                get disposed() { return disposed; },
                add: appendKit,
                addMany(values, callOptions = {}) {
                    if (disposed) return Object.freeze([]);
                    const indices = [];
                    for (const value of values ?? []) {
                        const index = appendKit(value, callOptions);
                        if (index < 0) break;
                        indices.push(index);
                    }
                    if (callOptions.flush !== false) kitBatch.flush(callOptions);
                    return Object.freeze(indices);
                },
                getMatrixAt(index, target = new THREE.Matrix4(), callOptions = {}) {
                    if (disposed || !Number.isInteger(index) || index < 0 || index >= count) return null;
                    readRootLocal(index, target);
                    if (String(callOptions.space ?? 'local').toLowerCase() === 'world') {
                        rawGroup.updateWorldMatrix(true, false);
                        target.premultiply(rawGroup.matrixWorld);
                    }
                    return target;
                },
                getSocketMatrixAt(index, socket, target = new THREE.Matrix4(), callOptions = {}) {
                    if (disposed || !Number.isInteger(index) || index < 0 || index >= count) return null;
                    const descriptor = resolveSocket(socket);
                    if (!descriptor) return null;
                    readRootLocal(index, target);
                    target.multiply(scratch.matrixA.fromArray(descriptor.matrix));
                    if (String(callOptions.space ?? 'world').toLowerCase() !== 'local') {
                        rawGroup.updateWorldMatrix(true, false);
                        target.premultiply(rawGroup.matrixWorld);
                    }
                    return target;
                },
                getSocketPositionAt(index, socket, target = new THREE.Vector3(), callOptions = {}) {
                    const matrix = kitBatch.getSocketMatrixAt(index, socket, scratch.matrixB, callOptions);
                    return matrix ? target.setFromMatrixPosition(matrix) : null;
                },
                removeAt(index) {
                    if (disposed || !Number.isInteger(index) || index < 0 || index >= count) return false;
                    requirePartBatchAlignment();
                    const last = count - 1;
                    for (const batch of partBatches) batch.removeAt(index);
                    if (index !== last) {
                        rootMatrices.copyWithin(index * 16, last * 16, (last + 1) * 16);
                    }
                    count = last;
                    return true;
                },
                clear() {
                    if (disposed || count === 0) return false;
                    requirePartBatchAlignment();
                    for (const batch of partBatches) batch.clear();
                    count = 0;
                    return true;
                },
                flush(flushOptions = {}) {
                    if (disposed) return false;
                    requirePartBatchAlignment();
                    let changed = false;
                    for (const batch of partBatches) {
                        changed = batch.flush({ ...flushOptions, notify: false }) || changed;
                    }
                    if (changed && flushOptions.notify !== false) {
                        notifyChanged({ type: 'jsScene', layerId, action: 'kitBatch' });
                    }
                    return changed;
                },
                refresh() {
                    if (disposed) return false;
                    let changed = false;
                    for (const batch of partBatches) changed = batch.refresh() || changed;
                    return changed;
                },
                dispose() {
                    return disposeKitBatch();
                },
            });

            try {
                if (Array.isArray(instanceOptions.transforms)) {
                    for (const transform of instanceOptions.transforms) {
                        if (appendKit(transform) < 0) break;
                    }
                    kitBatch.flush({ notify: false });
                } else {
                    for (let i = 0; i < initialCount; i += 1) appendKit(null);
                    if (initialCount > 0) kitBatch.flush({ notify: false });
                }
            } catch (error) {
                kitBatch.dispose();
                throw error;
            }
            registerComposite(composite);
            registeredComposite = true;
            notifyChanged({ type: 'jsScene', layerId, action: 'kitCreate' });
            return kitBatch;
        }

        function instantiateKit(instanceOptions = {}) {
            if (!ensureActive('kit.instantiate()')) return null;
            resolveLayerParent(instanceOptions);
            for (const part of parts) {
                assertClassicCloneMaterial(part.node, `ctx.kits "${kitName}" instantiate`);
            }
            const name = instanceOptions.name || `${kitName}_copy`;
            const rawGroup = createOwnedGroup(name, instanceOptions);
            rawGroup.userData.maxjsRuntimeKit = true;
            rawGroup.userData.maxjsKitSourceHandle = rootAdapter.handle;
            rawGroup.updateWorldMatrix(true, false);
            const requestedSpace = String(instanceOptions.space ?? 'world').toLowerCase();
            let localRoot;
            if (requestedSpace === 'local') {
                localRoot = composeTransformMatrix(THREE, instanceOptions, null, scratch.matrixA, scratch);
            } else {
                const worldRoot = composeTransformMatrix(THREE, instanceOptions, rootWorld, scratch.matrixA, scratch);
                rawGroup.parent?.updateWorldMatrix?.(true, false);
                scratch.matrixB.identity();
                if (rawGroup.parent?.matrixWorld) scratch.matrixB.copy(rawGroup.parent.matrixWorld);
                localRoot = scratch.matrixB.invert().multiply(worldRoot);
            }
            rawGroup.matrixAutoUpdate = false;
            rawGroup.matrix.copy(localRoot);
            rawGroup.updateMatrixWorld(true);

            const clones = [];
            try {
                for (let index = 0; index < parts.length; index += 1) {
                    const part = parts[index];
                    const clone = cloneFromMax(part.node, {
                        parent: rawGroup,
                        name: `${part.name}_clone`,
                        snapshotId: instanceOptions.snapshotId
                            ? `${instanceOptions.snapshotId}:part:${encodeURIComponent(part.id)}`
                            : undefined,
                    });
                    if (!clone) throw new Error(`ctx.kits: source module "${part.id}" is unavailable`);
                    clone.matrixAutoUpdate = false;
                    clone.matrix.fromArray(part.matrix);
                    clone.updateMatrixWorld(true);
                    clones.push(clone);
                }
            } catch (error) {
                for (const clone of clones) untrackResource(clone);
                rawGroup.parent?.remove(rawGroup);
                disposeOwnedResource(rawGroup, { force: true });
                throw error;
            }

            let disposed = false;
            let registeredComposite = false;
            function disposeKitInstance(disposeOptions = {}) {
                if (disposed) return false;
                disposed = true;
                if (registeredComposite) unregisterComposite(composite);
                registeredComposite = false;
                for (const clone of clones) untrackResource(clone);
                rawGroup.parent?.remove(rawGroup);
                disposeOwnedResource(rawGroup, { force: true });
                if (disposeOptions.notify !== false) {
                    notifyChanged({ type: 'jsScene', layerId, action: 'kitDispose' });
                }
                return true;
            }
            const composite = {
                retire() {
                    return disposeKitInstance({ notify: false });
                },
            };
            const instance = freezePlainObject({
                get raw() { return disposed ? null : rawGroup; },
                get root() { return disposed ? null : rawGroup; },
                get clones() { return Object.freeze([...clones]); },
                get parts() { return frozenParts; },
                get sockets() { return frozenSockets; },
                get disposed() { return disposed; },
                getSocketMatrix(socket, target = new THREE.Matrix4(), socketOptions = {}) {
                    if (disposed) return null;
                    const descriptor = resolveSocket(socket);
                    if (!descriptor) return null;
                    target.fromArray(descriptor.matrix);
                    if (String(socketOptions.space ?? 'world').toLowerCase() !== 'local') {
                        rawGroup.updateWorldMatrix(true, false);
                        target.premultiply(rawGroup.matrixWorld);
                    }
                    return target;
                },
                getSocketPosition(socket, target = new THREE.Vector3(), socketOptions = {}) {
                    const matrix = instance.getSocketMatrix(socket, scratch.matrixA, socketOptions);
                    return matrix ? target.setFromMatrixPosition(matrix) : null;
                },
                dispose() {
                    return disposeKitInstance();
                },
            });
            registerComposite(composite);
            registeredComposite = true;
            notifyChanged({ type: 'jsScene', layerId, action: 'kitInstantiate' });
            return instance;
        }

        return freezePlainObject({
            name: kitName,
            sourceHandle: rootAdapter.handle,
            root: rootAdapter,
            parts: frozenParts,
            sockets: frozenSockets,
            matrix: Object.freeze(rootWorld.toArray()),
            getPart(id) { return partById.get(String(id)) ?? null; },
            module(id) { return partById.get(String(id)) ?? null; },
            getSocket(id) { return resolveSocket(id); },
            instantiate: instantiateKit,
            createInstances: createKitInstances,
        });
    }

    const kits = freezePlainObject({
        capture: captureKit,
    });

    return freezePlainObject({
        instanceFromMax: createBatch,
        kits,
    });
}
