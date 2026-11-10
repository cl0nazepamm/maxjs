// instance_buckets.js — collapse compatible ordinary node families into
// THREE.InstancedMesh buckets: one GPU draw per (source geometry, material)
// family instead of one draw per node. Families may arrive as live `instOf`
// references or as static snapshot nodes whose exact M3 descriptors alias the
// same physical ranges.
//
// Host-neutral engine shared by snapshot boot and the editor's
// `optimizeMaxInstances` path (web/js/editor/scene_sync.js).
//
// Fits the scene_applier hook contract:
//
//   const buckets = createInstanceBuckets({ nodeMap, root, ... });
//   await applySceneBin({
//     ctx:   { ..., lastInstanceBucketSignature: buckets.signature },
//     hooks: {
//       planInstanceBuckets:      (nodes)      => buckets.plan(nodes),
//       getInstanceBucketFor:     (handle)     => buckets.getBucketFor(handle),
//       updateInstanceBucketNode: (handle, nd) => buckets.updateNode(handle, nd),
//     },
//   });
//   buckets.build(meta.nodes); // after apply: hides originals, adds InstancedMesh
//
// Originals stay in the nodeMap (hidden), so handle lookups, colliders,
// bounds and GI scans keep working; a bucket is a render substitute, not a
// scene-graph replacement. Per-handle edits stream through updateNode /
// updateTransform / updateVisibility without reallocation; composition
// changes rebuild by signature. Instance matrices are the wire's root-space
// `nd.t` poses, so bucket meshes must parent directly under the max root.

import * as THREE from 'three';
import { markOwned, OWNER_MAX } from './layer_ownership.js';

function isFiniteArray(value, length) {
    if (!value || typeof value.length !== 'number' || value.length < length) return false;
    for (let i = 0; i < length; i++) {
        if (!Number.isFinite(value[i])) return false;
    }
    return true;
}

function matrixArraysAlmostEqual(a, b, eps = 1.0e-7) {
    if (!a || !b || a.length < 16 || b.length < 16) return false;
    for (let i = 0; i < 16; i++) {
        if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > eps) return false;
    }
    return true;
}

const matrixScratch = new THREE.Matrix4();

// The storage identity used by scene_applier's decode cache and by this draw
// bucket planner must stay identical. Geometry aliases remain ordinary meshes
// unless the bucket performance gate/threshold elects to promote the family.
// Mutable node-owned geometry paths never participate.
export function ordinaryM3GeometryStorageKey(nd) {
    if (!nd?.geo || nd.spline || nd.skin || nd.morph || nd.jsmod) return null;
    if (!Number.isSafeInteger(nd.geo.vOff) || !Number.isSafeInteger(nd.geo.vN)
        || !Number.isSafeInteger(nd.geo.iOff) || !Number.isSafeInteger(nd.geo.iN)
        || nd.geo.vN <= 0 || nd.geo.iN <= 0) {
        return null;
    }
    return JSON.stringify([nd.geo, Array.isArray(nd.groups) ? nd.groups : null]);
}

/**
 * @param {object}   options
 * @param {Map}      options.nodeMap       handle → THREE.Object3D (per-node originals)
 * @param {object}   options.root          parent for bucket meshes (the max root)
 * @param {function} options.materialKey   (nd) → string; material identity for grouping
 * @param {function} options.buildMaterial ({ nd, geom }) → THREE.Material for a bucket
 *                                         (nd is the family's first payload)
 * @param {function} [options.disposeMaterial]     (mat) → void; default disposes
 * @param {function} [options.applyMaterialScalar] (mesh, mat) → void; live scalar edits
 * @param {number|function} [options.threshold=4]  minimum family size worth a bucket;
 *                                                 a function is read per plan (live setting)
 * @param {boolean|function} [options.enabled=true] gate; disabled plans are empty, so
 *                                                  build() dissolves existing buckets
 * @param {function} [options.excludeNode]  (nd) → true to keep a node out of buckets
 * @param {function} [options.sourceSignature] (sourceNd) → string folded into the plan
 *                   signature so a source-material change rebuilds; default materialKey
 * @param {Map}      [options.buckets]        externally owned bucketKey → bucket map
 * @param {Map}      [options.handleToBucket] externally owned handle → bucketKey map
 */
export function createInstanceBuckets({
    nodeMap,
    root,
    materialKey,
    buildMaterial,
    disposeMaterial = (mat) => {
        if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
        else mat?.dispose?.();
    },
    applyMaterialScalar = null,
    threshold = 4,
    enabled = true,
    excludeNode = null,
    sourceSignature = null,
    buckets = new Map(),
    handleToBucket = new Map(),
} = {}) {
    let lastSignature = '';
    let lastPlan = null;              // { nodes, plan } — reused by build()

    function computeGroups(nodes) {
        const groups = new Map();
        const isEnabled = typeof enabled === 'function' ? enabled() : enabled;
        if (!isEnabled) return groups;
        for (const nd of nodes) {
            if (nd?.jsmod || nd?.spline || nd?.skin || nd?.morph) continue;
            if (excludeNode?.(nd)) continue;
            const materialIdentity = String(materialKey(nd));
            const isExplicitInstance = Number.isFinite(nd?.instOf) && nd.instOf > 0 && !nd.geo;
            const storageKey = isExplicitInstance ? null : ordinaryM3GeometryStorageKey(nd);
            if (!isExplicitInstance && !storageKey) continue;
            const bucketKey = isExplicitInstance
                ? `inst:${nd.instOf}|${materialIdentity}`
                : `m3:${storageKey}|${materialIdentity}`;
            if (!groups.has(bucketKey)) {
                groups.set(bucketKey, {
                    key: bucketKey,
                    sourceHandle: isExplicitInstance ? nd.instOf : nd.h,
                    materialKey: materialIdentity,
                    hideSource: !isExplicitInstance,
                    nodes: [],
                });
            }
            groups.get(bucketKey).nodes.push(nd);
        }
        const minSize = Math.max(1, typeof threshold === 'function' ? threshold() : threshold);
        for (const [key, group] of [...groups.entries()]) {
            if (group.nodes.length < minSize) groups.delete(key);
        }
        return groups;
    }

    function plan(nodes) {
        const groups = computeGroups(nodes);
        const nodeByHandle = new Map();
        for (const nd of nodes) nodeByHandle.set(nd.h, nd);
        let signature = '';
        const handles = new Set();
        if (groups.size > 0) {
            const parts = [];
            for (const group of groups.values()) {
                const sorted = group.nodes.map((nd) => nd.h).sort((a, b) => a - b);
                for (const handle of sorted) handles.add(handle);
                const sourceNode = nodeByHandle.get(group.sourceHandle);
                const signatureOf = sourceSignature ?? materialKey;
                const sourceSig = sourceNode ? signatureOf(sourceNode) : '';
                parts.push(`${group.key}@${sourceSig}#${group.nodes.length}:${sorted.join(',')}`);
            }
            parts.sort();
            signature = parts.join('||');
        }
        const result = { groups, signature, handles };
        lastPlan = { nodes, plan: result };
        return result;
    }

    function dissolveBucket(bucketKey) {
        const bucket = buckets.get(bucketKey);
        if (!bucket) return false;
        if (bucket.mesh?.parent) bucket.mesh.parent.remove(bucket.mesh);
        // Geometry is shared with the source mesh; only the material is the
        // bucket's to release, and the callback decides whether it really is
        // (a consumer with a shared material cache passes a guarded disposer).
        disposeMaterial(bucket.mesh?.material);
        for (const handle of bucket.handles ?? []) {
            handleToBucket.delete(handle);
            const original = nodeMap.get(handle);
            if (original) original.visible = bucket.visible?.get(handle) !== false;
        }
        buckets.delete(bucketKey);
        lastSignature = '';
        return true;
    }

    function disposeAll() {
        for (const bucketKey of [...buckets.keys()]) dissolveBucket(bucketKey);
        buckets.clear();
        handleToBucket.clear();
        lastSignature = '';
        lastPlan = null;
    }

    function getBucketFor(handle) {
        const bucketKey = handleToBucket.get(handle);
        return bucketKey ? buckets.get(bucketKey) ?? null : null;
    }

    /** Dissolve the whole bucket containing a handle (light-link changes etc.). */
    function dissolveBucketFor(handle) {
        const bucketKey = handleToBucket.get(handle);
        return bucketKey != null ? dissolveBucket(bucketKey) : false;
    }

    // Compact: rebuild instance matrices with only the visible entries.
    function refreshVisibility(bucket) {
        if (!bucket?.mesh) return;
        let slot = 0;
        for (const handle of bucket.handles) {
            bucket.handleToIndex.set(handle, -1);
            if (bucket.visible.get(handle) === false) continue;
            const xf = bucket.transforms.get(handle);
            if (xf) matrixScratch.fromArray(xf);
            else matrixScratch.identity();
            bucket.handleToIndex.set(handle, slot);
            bucket.mesh.setMatrixAt(slot, matrixScratch);
            slot++;
        }
        bucket.mesh.count = slot;
        bucket.mesh.visible = slot > 0;
        bucket.mesh.instanceMatrix.needsUpdate = true;
    }

    function updateTransform(handle, matrixArray) {
        const bucket = getBucketFor(handle);
        if (!bucket || !isFiniteArray(matrixArray, 16)) return false;
        const idx = bucket.handleToIndex.get(handle);
        if (idx == null) return false;
        const previous = bucket.transforms.get(handle);
        if (matrixArraysAlmostEqual(previous, matrixArray)) return false;
        if (previous) {
            for (let i = 0; i < 16; i++) previous[i] = matrixArray[i];
        } else {
            bucket.transforms.set(handle, Array.from(matrixArray));
        }
        if (bucket.visible.get(handle) === false || idx < 0) return false;
        matrixScratch.fromArray(matrixArray);
        bucket.mesh.setMatrixAt(idx, matrixScratch);
        bucket.mesh.instanceMatrix.needsUpdate = true;
        return true;
    }

    function updateVisibility(handle, visible) {
        const bucket = getBucketFor(handle);
        if (!bucket) return false;
        const next = !!visible;
        if (bucket.visible.get(handle) === next) return false;
        bucket.visible.set(handle, next);
        refreshVisibility(bucket);
        return true;
    }

    function updateNode(handle, nd) {
        const bucket = getBucketFor(handle);
        if (!bucket) return false;
        let changed = false;
        if (nd.vis != null && updateVisibility(handle, nd.vis)) changed = true;
        if (isFiniteArray(nd.t, 16) && updateTransform(handle, nd.t)) changed = true;
        if (nd.mat && applyMaterialScalar) {
            const signature = materialKey(nd);
            if (bucket.lastMaterialScalarSignature !== signature) {
                applyMaterialScalar(bucket.mesh, nd.mat);
                bucket.lastMaterialScalarSignature = signature;
                bucket.materialKey = signature;
                changed = true;
            }
        }
        return changed;
    }

    function build(nodes, bucketPlan = null) {
        const resolved = bucketPlan
            ?? (lastPlan?.nodes === nodes ? lastPlan.plan : plan(nodes));
        if (resolved.signature === lastSignature) {
            // Composition unchanged — keep existing buckets; per-handle
            // transform / visibility / material edits flowed through
            // updateNode without reallocating meshes.
            return false;
        }

        disposeAll();
        lastSignature = resolved.signature;
        if (resolved.groups.size === 0) return true;

        for (const group of resolved.groups.values()) {
            const sourceMesh = nodeMap.get(group.sourceHandle);
            // Explicit instOf referrers may own a geometry clone solely for a
            // different group table. Use the first referrer's resolved geometry
            // for the draw, while keeping the semantic source separately visible.
            const geometryMesh = nodeMap.get(group.nodes[0]?.h) ?? sourceMesh;
            if (!sourceMesh || !geometryMesh?.geometry || geometryMesh.isLine
                || geometryMesh.isLineSegments || geometryMesh.isSkinnedMesh) continue;
            const material = buildMaterial({ nd: group.nodes[0], geom: geometryMesh.geometry });
            const mesh = new THREE.InstancedMesh(geometryMesh.geometry, material, group.nodes.length);
            mesh.matrixAutoUpdate = false;
            mesh.frustumCulled = false;
            mesh.castShadow = !!geometryMesh.castShadow;
            mesh.receiveShadow = !!geometryMesh.receiveShadow;
            mesh.name = `max_instances_${group.sourceHandle}_x${group.nodes.length}`;

            const bucket = {
                mesh,
                sourceHandle: group.sourceHandle,
                materialKey: group.materialKey,
                hideSource: group.hideSource,
                handles: new Set(),
                handleToIndex: new Map(),
                transforms: new Map(),
                visible: new Map(),
                lastMaterialScalarSignature: group.materialKey,
            };

            group.nodes.forEach((nd, index) => {
                bucket.handles.add(nd.h);
                bucket.handleToIndex.set(nd.h, index);
                bucket.transforms.set(nd.h, isFiniteArray(nd.t, 16) ? Array.from(nd.t) : null);
                bucket.visible.set(nd.h, nd.vis == null ? true : !!nd.vis);
                handleToBucket.set(nd.h, group.key);
                const original = nodeMap.get(nd.h);
                if (original && (group.hideSource || original !== sourceMesh)) original.visible = false;
            });

            refreshVisibility(bucket);
            markOwned(mesh, OWNER_MAX);
            root.add(mesh);
            buckets.set(group.key, bucket);
        }
        return true;
    }

    function stats() {
        let instances = 0;
        for (const bucket of buckets.values()) instances += bucket.handles.size;
        return { buckets: buckets.size, instances };
    }

    return {
        plan,
        build,
        getBucketFor,
        dissolveBucketFor,
        updateNode,
        updateTransform,
        updateVisibility,
        stats,
        dispose: disposeAll,
        get signature() { return lastSignature; },
    };
}
