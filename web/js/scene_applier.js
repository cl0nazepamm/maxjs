// scene_applier.js — minimal-viable applier for the maxjs binary scene
// payload (`scene.bin`).
//
// Stage 3 deliverable from docs/SNAPSHOT_REFACTOR.md.
//
// Lifts a deliberately reduced version of `handleBinaryScene` from
// web/index.html (lines 6329-6556) into a standalone module. The goal of
// this stage is **visible geometry** for snapshot pages, not full live-
// mode parity.
//
// SCOPE — what's IN
// -----------------
//   - Mesh / line / SkinnedMesh construction from scene.bin via
//     `js/scene_binary.js` helpers.
//   - Transform from `nd.t` (16-float matrix).
//   - Visibility from `nd.vis`.
//   - Multi/sub material groups via `geom.addGroup`.
//   - Forest Pack / RailClone / tyFlow instance groups from binary ranges
//     in `scene.bin`, with legacy JSON-array fallback.
//   - Removal of stale nodes not present in the new payload.
//   - Skeleton bind-pose calculation after the world matrix updates.
//
// SCOPE — what's OUT (by design, lifts in later stages)
// -----------------------------------------------------
//   - Real material building (PBR / VRay / OpenPBR / glTF / TSL / MaterialX).
//     Replaced with a flat MeshStandardMaterial via `materialBuilder`.
//   - Vertex color attribute updates.
//   - jsmod (three.js Deform) sync state.
//   - HTML auto-fit, selection state stamping.
//   - Light linking / light probes / scene profiling.
//   - `finalizeSceneSnapshot` side effects (camera fit, HDRI load, fog,
//     splats, audio, gltf, hairInstances, volumes).
//
// All of the above are wired through the `hooks` parameter so caller code
// can opt in incrementally. The default hooks are no-ops.
//
// CONTRACT
// --------
//   applySceneBin({ buffer, meta, ctx, hooks?, options? })
//
// Returns:
//   { sceneChanged, transformsChanged, applyMs, addedHandles, removedHandles }

import * as THREE from 'three';
import {
    binInRange,
    geometryFromNodeBinary,
    attachSkinAttributes,
    buildSkinnedMeshFromNd,
} from './scene_binary.js';

// ─── Default hooks ─────────────────────────────────────────────────────
//
// All hooks are best-effort opt-in. Snapshot pages with the simplest
// scenes can run with the defaults; full parity needs each subsystem
// (material registry, instance buckets, etc.) plugged in.
const NOOP = () => {};
const RETURNS_FALSE = () => false;

const DEFAULT_HOOKS = Object.freeze({
    /** ({ nd, geom, wantsLine }) → THREE.Material — required */
    materialBuilder: ({ wantsLine }) =>
        wantsLine
            ? new THREE.LineBasicMaterial({ color: 0xcccccc })
            : new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.6, metalness: 0.0 }),

    /** ({ grp, geom }) -> THREE.Material | THREE.Material[] */
    instanceMaterialBuilder: () =>
        new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7, side: THREE.DoubleSide }),

    /** ({ mesh, nd }) → bool changed — for incremental material edits */
    materialUpdater: RETURNS_FALSE,

    /** (material) → void — material disposal hook */
    disposeMaterial: (mat) => {
        if (!mat) return;
        if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
        else mat.dispose?.();
    },

    /** (nodes) → { signature, handles: Set<handle> } — instance bucket plan */
    planInstanceBuckets: () => ({ signature: '', handles: new Set() }),

    /** (handle) → bucket | null — lookup */
    getInstanceBucketFor: () => null,

    /** (handle, nd) → bool transformsChanged */
    updateInstanceBucketNode: RETURNS_FALSE,

    /** (mesh, isJsmod) → void */
    applyJsmodSyncState: NOOP,

    /** (mesh, instOfHandle) → void */
    applyInstanceSyncState: NOOP,

    /** (mesh, selected) → void */
    applySelection: NOOP,

    /** (geometry, vc, buffer) → void — vertex color attribute updates */
    setVertexColors: NOOP,

    /** ({ snapshot, transport, applyStart, producerBytes, options }) → void */
    finalizeSceneSnapshot: NOOP,

    /** Layer manager hooks (called when present) */
    onMaterialApplied: NOOP, // (handle, mesh) → void; live calls layerManager.applyMaterialOverrides
    markRuntimeTransformsDirty: NOOP,

    /** (mesh, nd) → void — additional userData stamping (HTML autofit, signatures, etc.) */
    stampMaterial: NOOP,

    /** (mesh, nd) — visibility from nd.vis */
    applyVisibility: (mesh, vis) => {
        if (!mesh) return false;
        const next = vis === undefined ? mesh.visible : !!vis;
        if (next === mesh.visible) return false;
        mesh.visible = next;
        return true;
    },
});

// ─── Geometry refcount tracking (lifted from index.html) ─────────────
function buildNodeGeometryRefCounts(nodeMap) {
    const counts = new Map();
    for (const mesh of nodeMap.values()) {
        const geom = mesh?.geometry;
        if (!geom) continue;
        counts.set(geom, (counts.get(geom) || 0) + 1);
    }
    return counts;
}
function retainGeometryRef(refCounts, geom) {
    if (!refCounts || !geom) return;
    refCounts.set(geom, (refCounts.get(geom) || 0) + 1);
}
function releaseGeometryRef(refCounts, geom) {
    if (!refCounts || !geom) return;
    const next = (refCounts.get(geom) || 0) - 1;
    if (next <= 0) { refCounts.delete(geom); geom.dispose?.(); }
    else { refCounts.set(geom, next); }
}

// ─── applyTransform (lifted) ──────────────────────────────────────────
const I16 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function arraysAlmostEqual(a, b, eps = 1e-6) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
    return true;
}
function isFiniteArray(arr, len) {
    if (!arr || (len != null && arr.length !== len)) return false;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
    return true;
}
function applyTransform(mesh, t) {
    if (!isFiniteArray(t, 16)) {
        if (arraysAlmostEqual(mesh.matrix.elements, I16)) return false;
        mesh.matrix.identity();
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
        mesh.matrixWorldNeedsUpdate = true;
        return true;
    }
    if (arraysAlmostEqual(mesh.matrix.elements, t)) return false;
    mesh.matrix.fromArray(t);
    mesh.matrixWorldNeedsUpdate = true;
    return true;
}

// ─── Binary instance groups ───────────────────────────────────────────
function binaryFloatView(buffer, off, n, label) {
    if (!binInRange(buffer, off, n)) {
        console.warn(`[scene_applier] Invalid ${label} float range`, { off, n });
        return null;
    }
    return new Float32Array(buffer, off, n);
}

function binaryIntView(buffer, off, n, label) {
    if (!binInRange(buffer, off, n)) {
        console.warn(`[scene_applier] Invalid ${label} int range`, { off, n });
        return null;
    }
    return new Int32Array(buffer, off, n);
}

function vectorPayloadToFloat32(arrayLike) {
    return Array.isArray(arrayLike) || ArrayBuffer.isView(arrayLike)
        ? new Float32Array(arrayLike)
        : null;
}

function vectorPayloadToUint32(arrayLike) {
    return Array.isArray(arrayLike) || ArrayBuffer.isView(arrayLike)
        ? new Uint32Array(arrayLike)
        : null;
}

function buildInstanceGeometry(grp, buffer) {
    const geo = grp?.geo;
    let verts = null;
    let indices = null;
    let uvs = null;
    let norms = null;

    if (geo) {
        const vView = binaryFloatView(buffer, geo.vOff, geo.vN, 'instance position');
        const iView = binaryIntView(buffer, geo.iOff, geo.iN, 'instance index');
        if (!vView || !iView) return null;
        verts = new Float32Array(vView);
        indices = new Uint32Array(iView);
        if (geo.uvOff != null && geo.uvN) {
            const uvView = binaryFloatView(buffer, geo.uvOff, geo.uvN, 'instance uv');
            if (uvView) uvs = new Float32Array(uvView);
        }
        if (geo.nOff != null && geo.nN) {
            const nView = binaryFloatView(buffer, geo.nOff, geo.nN, 'instance normal');
            if (nView) norms = new Float32Array(nView);
        }
    } else {
        verts = vectorPayloadToFloat32(grp?.v);
        indices = vectorPayloadToUint32(grp?.i);
        uvs = vectorPayloadToFloat32(grp?.uv);
        norms = vectorPayloadToFloat32(grp?.norm);
    }

    if (!verts?.length || !indices?.length) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    if (uvs?.length) geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (norms?.length) geom.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    else geom.computeVertexNormals();

    if (Array.isArray(grp.groups)) {
        for (const [start, count, idx] of grp.groups) geom.addGroup(start, count, idx);
    }
    return geom;
}

function getInstanceTransformPayload(grp, buffer) {
    if (Number.isInteger(grp?.xformOff) && Number.isInteger(grp?.xformN)) {
        return binaryFloatView(buffer, grp.xformOff, grp.xformN, 'instance transform');
    }
    return Array.isArray(grp?.xforms) || ArrayBuffer.isView(grp?.xforms)
        ? grp.xforms
        : null;
}

function setMatrixFromRowMajor16(matrix, values, off) {
    // Instance payloads preserve Max row-major Matrix3 layout. Three's
    // Matrix4.set takes row-major arguments and stores column-major internally.
    matrix.set(
        values[off + 0], values[off + 4], values[off + 8],  values[off + 12],
        values[off + 1], values[off + 5], values[off + 9],  values[off + 13],
        values[off + 2], values[off + 6], values[off + 10], values[off + 14],
        values[off + 3], values[off + 7], values[off + 11], values[off + 15],
    );
}

function disposeInstanceMeshes(ctx, hooks) {
    const forestMeshes = ctx.forestMeshes;
    if (!forestMeshes?.size) return 0;
    let removed = 0;
    for (const mesh of forestMeshes.values()) {
        if (!mesh) continue;
        mesh.parent?.remove(mesh);
        mesh.geometry?.dispose?.();
        hooks.disposeMaterial(mesh.material);
        removed++;
    }
    forestMeshes.clear();
    return removed;
}

function applyForestInstances(groups, buffer, ctx, hooks) {
    ctx.forestMeshes ??= new Map();
    const removed = disposeInstanceMeshes(ctx, hooks);
    let added = 0;

    if (!Array.isArray(groups) || groups.length === 0) {
        return { sceneChanged: removed > 0, added, removed };
    }

    const matrix = new THREE.Matrix4();
    for (const grp of groups) {
        const xforms = getInstanceTransformPayload(grp, buffer);
        const count = grp?.count || Math.floor((xforms?.length || 0) / 16);
        if (!count || !xforms || xforms.length < count * 16) continue;

        const geom = buildInstanceGeometry(grp, buffer);
        if (!geom) continue;

        const material = hooks.instanceMaterialBuilder({ grp, geom });
        const instMesh = new THREE.InstancedMesh(geom, material, count);
        instMesh.matrixAutoUpdate = false;
        instMesh.frustumCulled = false;
        instMesh.castShadow = true;
        instMesh.receiveShadow = true;
        const groupKey = String(grp.key ?? grp.src ?? added);
        instMesh.name = `forest_${groupKey}_x${count}`;
        instMesh.userData.maxjsInstanceGroup = true;
        instMesh.userData.maxjsSource = groupKey;

        for (let i = 0; i < count; i++) {
            setMatrixFromRowMajor16(matrix, xforms, i * 16);
            instMesh.setMatrixAt(i, matrix);
        }
        instMesh.instanceMatrix.needsUpdate = true;

        ctx.maxRoot.add(instMesh);
        ctx.forestMeshes.set(groupKey, instMesh);
        added++;
    }

    return { sceneChanged: removed > 0 || added > 0, added, removed };
}

// ─── applySceneBin ─────────────────────────────────────────────────────
export async function applySceneBin({ buffer, meta, ctx, hooks: userHooks = {}, options = {} } = {}) {
    if (!buffer) throw new Error('applySceneBin: buffer is required');
    if (!meta || meta.type !== 'scene_bin') throw new Error('applySceneBin: meta.type must be "scene_bin"');
    if (!ctx?.nodeMap || !ctx?.maxRoot) throw new Error('applySceneBin: ctx.nodeMap + ctx.maxRoot required');

    const hooks = { ...DEFAULT_HOOKS, ...userHooks };
    const { nodeMap, maxRoot, lastInstanceBucketSignature = '', scene } = ctx;

    const applyStart = performance.now();
    const incoming = new Set(meta.nodes.map((n) => n.h));
    const bucketPlan = hooks.planInstanceBuckets(meta.nodes);
    const stableBucketHandles = bucketPlan.signature === lastInstanceBucketSignature
        ? bucketPlan.handles
        : null;

    let sceneChanged = false;
    let transformsChanged = false;
    const addedHandles = [];
    const removedHandles = [];
    const refCounts = buildNodeGeometryRefCounts(nodeMap);

    // ─── Remove deleted nodes ───────────────────────────────────────
    const toRemove = [];
    for (const [handle, mesh] of nodeMap) {
        if (!incoming.has(handle)) toRemove.push(handle);
    }
    for (const handle of toRemove) {
        const mesh = nodeMap.get(handle);
        if (mesh) {
            maxRoot.remove(mesh);
            releaseGeometryRef(refCounts, mesh.geometry);
            hooks.disposeMaterial(mesh.material);
        }
        nodeMap.delete(handle);
        removedHandles.push(handle);
        sceneChanged = true;
    }

    // Geometry cache for instance sharing within this sync.
    const geoByHandle = new Map();

    for (const nd of meta.nodes) {
        let mesh = nodeMap.get(nd.h);

        // Instance buckets — early-out if this handle is currently bucketed.
        if (stableBucketHandles?.has(nd.h) && hooks.getInstanceBucketFor(nd.h)) {
            if (hooks.updateInstanceBucketNode(nd.h, nd)) transformsChanged = true;
            if (mesh) {
                hooks.applyJsmodSyncState(mesh, !!nd.jsmod);
                hooks.applyInstanceSyncState(mesh, nd.instOf);
                if (nd.s != null) hooks.applySelection(mesh, nd.s);
            }
            continue;
        }

        const jsmodFlag = !!nd.jsmod;
        const instSrcMesh = nd.instOf ? nodeMap.get(nd.instOf) : null;
        const sharesInstGeom = !!(mesh && instSrcMesh && mesh.geometry === instSrcMesh.geometry);
        const jsmodSkipGeo = jsmodFlag && mesh && !sharesInstGeom;

        // Geometry — instance share, fresh build, or reuse.
        let geom = mesh?.geometry;
        if (nd.instOf && !nd.geo) {
            const srcGeom = geoByHandle.get(nd.instOf) || instSrcMesh?.geometry;
            if (srcGeom) geom = jsmodFlag ? srcGeom.clone() : srcGeom;
        } else if (nd.geo && !jsmodSkipGeo) {
            const built = geometryFromNodeBinary(nd, buffer);
            if (!built) continue;
            geom = built;
            hooks.setVertexColors(geom, nd.geo.vc, buffer);
            if (nd.groups) {
                for (const [start, count, idx] of nd.groups) geom.addGroup(start, count, idx);
            }
            if (nd.skin && !nd.spline) attachSkinAttributes(geom, nd, buffer);
        } else if (geom && nd.groups) {
            geom.clearGroups();
            for (const [start, count, idx] of nd.groups) geom.addGroup(start, count, idx);
        }

        if (geom) geoByHandle.set(nd.h, geom);

        const wantsLine = !!nd.spline;
        const hasLineRenderable = !!(mesh?.isLine || mesh?.isLineSegments);
        const renderableTypeMismatch = !!mesh && wantsLine !== hasLineRenderable;
        const skinTypeMismatch = !!mesh && nd.skin && !mesh.isSkinnedMesh && !wantsLine;

        if (renderableTypeMismatch || skinTypeMismatch) {
            maxRoot.remove(mesh);
            releaseGeometryRef(refCounts, mesh.geometry);
            hooks.disposeMaterial(mesh.material);
            nodeMap.delete(nd.h);
            mesh = null;
            sceneChanged = true;
        }

        if (mesh) {
            // Existing mesh — update geometry if changed, ask hooks if material changed.
            if (!jsmodSkipGeo && geom && geom !== mesh.geometry) {
                releaseGeometryRef(refCounts, mesh.geometry);
                retainGeometryRef(refCounts, geom);
                mesh.geometry = geom;
            }
            if (hooks.materialUpdater({ mesh, nd, wantsLine, geom })) {
                sceneChanged = true;
                hooks.onMaterialApplied(nd.h, mesh);
            }
        } else {
            if (!geom) continue;
            const material = hooks.materialBuilder({ nd, geom, wantsLine });
            if (wantsLine) {
                mesh = new THREE.LineSegments(geom, material);
            } else if (nd.skin) {
                mesh = buildSkinnedMeshFromNd({ nd, geom, material, buffer, nodeMap })
                    ?? new THREE.Mesh(geom, material);
            } else {
                mesh = new THREE.Mesh(geom, material);
            }
            mesh.matrixAutoUpdate = false;
            mesh.frustumCulled = false;
            mesh.name = nd.n ?? '';
            mesh.userData.maxjsHandle = nd.h;
            hooks.stampMaterial(mesh, nd);
            maxRoot.add(mesh);
            nodeMap.set(nd.h, mesh);
            retainGeometryRef(refCounts, mesh.geometry);
            addedHandles.push(nd.h);
            sceneChanged = true;
            hooks.onMaterialApplied(nd.h, mesh);
        }

        // Transform + visibility (a tiny subset of finalizeSceneNode).
        const visChanged = hooks.applyVisibility(mesh, nd.vis);
        const xformChanged = applyTransform(mesh, nd.t);
        if (nd.s != null) hooks.applySelection(mesh, nd.s);
        if (visChanged || xformChanged) transformsChanged = true;
    }

    if (Object.prototype.hasOwnProperty.call(meta, 'forestInstances') || ctx.forestMeshes?.size) {
        const instanced = applyForestInstances(meta.forestInstances ?? [], buffer, ctx, hooks);
        if (instanced.sceneChanged) sceneChanged = true;
    }

    if (transformsChanged || sceneChanged) hooks.markRuntimeTransformsDirty();

    // World matrix update + skinned bind pose pass.
    scene?.updateMatrixWorld(true);
    for (const mesh of nodeMap.values()) {
        if (mesh?.isSkinnedMesh && mesh.skeleton && !mesh.userData._skelBound) {
            mesh.skeleton.calculateInverses();
            mesh.bind(mesh.skeleton, mesh.matrixWorld);
            mesh.userData._skelBound = true;
        }
    }

    hooks.finalizeSceneSnapshot({
        snapshot: meta,
        transport: 'binary-scene',
        applyStart,
        producerBytes: meta.stats?.producerBytes ?? buffer.byteLength,
        options: { ...options, bucketPlan, sceneChanged },
    });

    return {
        sceneChanged,
        transformsChanged,
        applyMs: performance.now() - applyStart,
        addedHandles,
        removedHandles,
        bucketSignature: bucketPlan.signature,
    };
}
