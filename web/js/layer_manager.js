// layer_manager.js — dual-world JS runtime for MaxJS inline modules.
// Max-owned scene content stays read-only behind adapters.
// JS-authored content lives under its own roots and owns its own resources.

const MAX_CONSECUTIVE_ERRORS = 60;
const OWNER_KEY = 'maxjsOwner';
const OWNER_MAX = 'max';
const OWNER_JS = 'js';
const OWNER_OVERLAY = 'overlay';

const MATERIAL_MAP_KEYS = [
    'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap',
    'emissiveMap', 'aoMap', 'displacementMap', 'alphaMap', 'envMap',
    'lightMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
];

function setOwner(resource, owner) {
    if (!resource || typeof resource !== 'object') return resource;
    resource.userData ??= {};
    resource.userData[OWNER_KEY] = owner;
    return resource;
}

function getOwner(resource) {
    return resource?.userData?.[OWNER_KEY] ?? null;
}

function isDisposable(resource) {
    return !!resource && typeof resource.dispose === 'function';
}

function isOwnedByJs(resource) {
    const owner = getOwner(resource);
    return owner === OWNER_JS || owner === OWNER_OVERLAY;
}

function markMaterialOwned(material, owner) {
    if (!material) return material;
    setOwner(material, owner);
    for (const key of MATERIAL_MAP_KEYS) {
        if (material[key]) setOwner(material[key], owner);
    }
    return material;
}

function markOwned(resource, owner = OWNER_JS) {
    if (!resource) return resource;

    if (Array.isArray(resource)) {
        for (const item of resource) markOwned(item, owner);
        return resource;
    }

    if (resource.isObject3D) {
        resource.traverse(obj => {
            setOwner(obj, owner);
            if (obj.geometry) setOwner(obj.geometry, owner);
            if (Array.isArray(obj.material)) obj.material.forEach(mat => markMaterialOwned(mat, owner));
            else if (obj.material) markMaterialOwned(obj.material, owner);
        });
        return resource;
    }

    if (resource.isMaterial) return markMaterialOwned(resource, owner);
    if (resource.isBufferGeometry || resource.isTexture || resource.isRenderTarget) return setOwner(resource, owner);
    return setOwner(resource, owner);
}

function setSnapshotTargetId(resource, snapshotId) {
    if (!resource || typeof resource !== 'object') return resource;
    resource.userData ??= {};
    resource.userData.maxjsSnapshotId = snapshotId;
    return resource;
}

function disposeOwnedMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
        for (const item of material) disposeOwnedMaterial(item);
        return;
    }
    for (const key of MATERIAL_MAP_KEYS) {
        const map = material[key];
        if (isOwnedByJs(map) && isDisposable(map)) map.dispose();
    }
    if (isOwnedByJs(material) && isDisposable(material)) material.dispose();
}

function disposeOwnedResource(resource) {
    if (!resource) return;

    if (Array.isArray(resource)) {
        for (const item of resource) disposeOwnedResource(item);
        return;
    }

    if (resource.isObject3D) {
        while (resource.children.length > 0) {
            const child = resource.children[0];
            resource.remove(child);
            disposeOwnedResource(child);
        }
        if (isOwnedByJs(resource.geometry) && isDisposable(resource.geometry)) resource.geometry.dispose();
        disposeOwnedMaterial(resource.material);
        return;
    }

    if (resource.isMaterial) {
        disposeOwnedMaterial(resource);
        return;
    }

    if (isOwnedByJs(resource) && isDisposable(resource)) resource.dispose();
}

const surfaceTopologyCache = new WeakMap();

function getSurfaceTopologyCache(geometry, THREE) {
    const position = geometry?.getAttribute?.('position') ?? geometry?.attributes?.position;
    if (!position || position.itemSize < 3 || position.count < 3) return null;

    const index = geometry.index ?? null;
    const topologyKey = `${index?.count ?? 0}:${position.count}`;
    const cached = surfaceTopologyCache.get(geometry);
    if (cached?.topologyKey === topologyKey) return cached;

    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    if (triangleCount <= 0) return null;

    const triangleIndices = new Uint32Array(triangleCount * 3);
    const cumulativeAreas = new Float32Array(triangleCount);
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const edgeAB = new THREE.Vector3();
    const edgeAC = new THREE.Vector3();
    const cross = new THREE.Vector3();

    let totalArea = 0;

    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
        const offset = triangleIndex * 3;
        const iA = index ? index.getX(offset) : offset;
        const iB = index ? index.getX(offset + 1) : offset + 1;
        const iC = index ? index.getX(offset + 2) : offset + 2;

        triangleIndices[offset] = iA;
        triangleIndices[offset + 1] = iB;
        triangleIndices[offset + 2] = iC;

        vA.fromBufferAttribute(position, iA);
        vB.fromBufferAttribute(position, iB);
        vC.fromBufferAttribute(position, iC);

        edgeAB.subVectors(vB, vA);
        edgeAC.subVectors(vC, vA);
        cross.crossVectors(edgeAB, edgeAC);
        totalArea += cross.length() * 0.5;
        cumulativeAreas[triangleIndex] = totalArea;
    }

    if (totalArea <= 0) {
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
            cumulativeAreas[triangleIndex] = triangleIndex + 1;
        }
        totalArea = triangleCount;
    }

    const nextCache = { topologyKey, triangleCount, triangleIndices, cumulativeAreas, totalArea };
    surfaceTopologyCache.set(geometry, nextCache);
    return nextCache;
}

function pickWeightedIndex(cumulativeAreas, totalArea, rng) {
    const clamped = Math.min(Math.max(rng(), 0), 0.9999999999999999);
    const target = clamped * totalArea;
    let lo = 0;
    let hi = cumulativeAreas.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulativeAreas[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function getMeshVertexPosition(mesh, vertexIndex, target) {
    if (typeof mesh.getVertexPosition === 'function') {
        mesh.getVertexPosition(vertexIndex, target);
        return target;
    }

    const position = mesh.geometry?.getAttribute?.('position') ?? mesh.geometry?.attributes?.position;
    if (!position) return target.set(0, 0, 0);

    target.fromBufferAttribute(position, vertexIndex);
    if (mesh.isSkinnedMesh && typeof mesh.applyBoneTransform === 'function') {
        mesh.applyBoneTransform(vertexIndex, target);
    }
    return target;
}

function freezePlainObject(obj) {
    return Object.freeze(obj);
}

function createCameraAdapter(camera, THREE, ownForJs, cameraControl, layerId) {
    return freezePlainObject({
        get raw() { return camera; },
        getState() {
            return {
                type: camera.type,
                fov: camera.fov,
                near: camera.near,
                far: camera.far,
                up: camera.up.toArray(),
                matrix: camera.matrix.toArray(),
                matrixWorld: camera.matrixWorld.toArray(),
                projectionMatrix: camera.projectionMatrix.toArray(),
            };
        },
        clone(options = {}) {
            const clone = camera.clone();
            clone.matrix.copy(camera.matrix);
            clone.matrixWorld.copy(camera.matrixWorld);
            clone.projectionMatrix.copy(camera.projectionMatrix);
            clone.matrixAutoUpdate = camera.matrixAutoUpdate;
            if (options.name) clone.name = options.name;
            return ownForJs(clone, options.overlay ? OWNER_OVERLAY : OWNER_JS);
        },
        takeOver() { cameraControl.claim(layerId); },
        release() { cameraControl.release(layerId); },
        get isOverridden() { return cameraControl.isClaimed(); },
    });
}

function createMaxNodeAdapter({ handle, getObject, THREE, createAnchor }) {
    const scratch = {
        vA: new THREE.Vector3(),
        vB: new THREE.Vector3(),
        vC: new THREE.Vector3(),
        edgeAB: new THREE.Vector3(),
        edgeAC: new THREE.Vector3(),
        localPoint: new THREE.Vector3(),
        localNormal: new THREE.Vector3(),
        normalMatrix: new THREE.Matrix3(),
    };

    function collectSampleableMeshes(root, includeInvisible = false) {
        if (!root?.isObject3D) return [];
        const meshes = [];
        root.updateWorldMatrix(true, true);
        root.traverse(obj => {
            if (!obj?.isMesh) return;
            if (!includeInvisible && !obj.visible) return;
            const topology = getSurfaceTopologyCache(obj.geometry, THREE);
            if (!topology) return;
            meshes.push({ mesh: obj, topology });
        });
        return meshes;
    }

    function sampleMeshSurface(mesh, topology, options = {}) {
        const rng = typeof options.rng === 'function' ? options.rng : Math.random;
        const point = options.point ?? new THREE.Vector3();
        const normal = options.normal ?? new THREE.Vector3();
        const barycentric = options.barycentric ?? new THREE.Vector3();

        const triangleIndex = pickWeightedIndex(topology.cumulativeAreas, topology.totalArea, rng);
        const base = triangleIndex * 3;
        const iA = topology.triangleIndices[base];
        const iB = topology.triangleIndices[base + 1];
        const iC = topology.triangleIndices[base + 2];

        getMeshVertexPosition(mesh, iA, scratch.vA);
        getMeshVertexPosition(mesh, iB, scratch.vB);
        getMeshVertexPosition(mesh, iC, scratch.vC);

        let u = rng();
        let v = rng();
        if (u + v > 1) {
            u = 1 - u;
            v = 1 - v;
        }
        const w = 1 - u - v;
        barycentric.set(w, u, v);

        scratch.localPoint
            .copy(scratch.vA).multiplyScalar(w)
            .addScaledVector(scratch.vB, u)
            .addScaledVector(scratch.vC, v);

        scratch.edgeAB.subVectors(scratch.vB, scratch.vA);
        scratch.edgeAC.subVectors(scratch.vC, scratch.vA);
        scratch.localNormal.crossVectors(scratch.edgeAB, scratch.edgeAC);
        if (scratch.localNormal.lengthSq() > 0) scratch.localNormal.normalize();
        else scratch.localNormal.set(0, 1, 0);

        if (options.local === true) {
            point.copy(scratch.localPoint);
            normal.copy(scratch.localNormal);
        } else {
            point.copy(scratch.localPoint).applyMatrix4(mesh.matrixWorld);
            scratch.normalMatrix.getNormalMatrix(mesh.matrixWorld);
            normal.copy(scratch.localNormal).applyMatrix3(scratch.normalMatrix).normalize();
        }

        return {
            point,
            normal,
            barycentric,
            triangleIndex,
            meshHandle: mesh.userData?.maxjsHandle ?? handle,
            meshName: mesh.name ?? '',
        };
    }

    return freezePlainObject({
        handle,
        get exists() { return !!getObject(); },
        get name() { return getObject()?.name ?? ''; },
        get type() { return getObject()?.type ?? null; },
        get visible() { return !!getObject()?.visible; },
        setVisible(v) { const obj = getObject(); if (obj) obj.visible = !!v; },
        get isMesh() { return !!getObject()?.isMesh; },
        get jsmod() { return !!getObject()?.userData?.jsmod; },
        get materialType() {
            const obj = getObject();
            const mat = Array.isArray(obj?.material) ? obj.material[0] : obj?.material;
            return mat?.type ?? null;
        },
        getWorldMatrix() {
            const obj = getObject();
            return obj ? obj.matrixWorld.clone() : null;
        },
        getWorldPosition() {
            const obj = getObject();
            if (!obj) return null;
            const position = new THREE.Vector3();
            obj.getWorldPosition(position);
            return position;
        },
        getWorldQuaternion() {
            const obj = getObject();
            if (!obj) return null;
            const quaternion = new THREE.Quaternion();
            obj.getWorldQuaternion(quaternion);
            return quaternion;
        },
        getWorldScale() {
            const obj = getObject();
            if (!obj) return null;
            const scale = new THREE.Vector3();
            obj.getWorldScale(scale);
            return scale;
        },
        getBoundingBox() {
            const obj = getObject();
            return obj ? new THREE.Box3().setFromObject(obj) : null;
        },
        snapshot() {
            const obj = getObject();
            if (!obj) return null;
            const position = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            obj.matrixWorld.decompose(position, quaternion, scale);
            return {
                handle,
                name: obj.name,
                type: obj.type,
                visible: !!obj.visible,
                matrixWorld: obj.matrixWorld.toArray(),
                position: position.toArray(),
                quaternion: quaternion.toArray(),
                scale: scale.toArray(),
            };
        },
        createAnchor(options = {}) {
            return createAnchor(handle, options);
        },
        sampleSurface(options = {}) {
            const obj = getObject();
            if (!obj?.isObject3D) return null;
            if (!options.includeInvisible && !obj.visible) return null;

            if (obj.isMesh) {
                const topology = getSurfaceTopologyCache(obj.geometry, THREE);
                return topology ? sampleMeshSurface(obj, topology, options) : null;
            }

            const meshes = collectSampleableMeshes(obj, options.includeInvisible === true);
            if (meshes.length === 0) return null;
            if (meshes.length === 1) {
                const { mesh, topology } = meshes[0];
                return sampleMeshSurface(mesh, topology, options);
            }

            const rng = typeof options.rng === 'function' ? options.rng : Math.random;
            let totalArea = 0;
            for (const entry of meshes) totalArea += entry.topology.totalArea;
            if (totalArea <= 0) return null;

            const target = Math.min(Math.max(rng(), 0), 0.9999999999999999) * totalArea;
            let running = 0;
            for (const entry of meshes) {
                running += entry.topology.totalArea;
                if (target <= running) return sampleMeshSurface(entry.mesh, entry.topology, options);
            }

            const last = meshes[meshes.length - 1];
            return sampleMeshSurface(last.mesh, last.topology, options);
        },
    });
}

function createNodeMapFacade(nodeMap, getAdapter) {
    const facade = {
        get size() { return nodeMap.size; },
        has(handle) { return nodeMap.has(handle); },
        get(handle) { return nodeMap.has(handle) ? getAdapter(handle) : null; },
        keys() { return nodeMap.keys(); },
        *values() {
            for (const handle of nodeMap.keys()) yield getAdapter(handle);
        },
        *entries() {
            for (const handle of nodeMap.keys()) yield [handle, getAdapter(handle)];
        },
        forEach(fn, thisArg) {
            for (const handle of nodeMap.keys()) {
                fn.call(thisArg, getAdapter(handle), handle, facade);
            }
        },
        [Symbol.iterator]() {
            return this.entries();
        },
    };
    return freezePlainObject(facade);
}

function createMaxSceneFacade({ scene, nodeMap, getAdapter, createAnchor, THREE }) {
    return freezePlainObject({
        get size() { return nodeMap.size; },
        get background() { return scene.background?.clone?.() ?? scene.background ?? null; },
        get environment() { return scene.environment?.clone?.() ?? null; },
        get fog() { return scene.fog?.clone?.() ?? null; },
        has(handle) { return nodeMap.has(handle); },
        getNode(handle) { return nodeMap.has(handle) ? getAdapter(handle) : null; },
        listHandles() { return Array.from(nodeMap.keys()); },
        listNodes() { return Array.from(nodeMap.keys(), handle => getAdapter(handle)); },
        /** Meshes whose Max stack has three.js Deform (bridge sets adapter.jsmod). Safe to poll every frame — nodeMap grows as sync arrives. */
        listJsmodNodes() {
            const out = [];
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                if (adapter?.isMesh && adapter.jsmod) out.push(adapter);
            }
            return out;
        },
        findByName(name, options = {}) {
            const query = String(name ?? '').toLowerCase();
            const exact = options.exact === true;
            const matches = [];
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                const current = String(adapter?.name ?? '').toLowerCase();
                if (!query) continue;
                if ((exact && current === query) || (!exact && current.includes(query))) {
                    matches.push(adapter);
                }
            }
            return matches;
        },
        createAnchor(handle, options = {}) {
            return createAnchor(handle, options);
        },
        raycast(origin, direction, options = {}) {
            const rc = new THREE.Raycaster(origin, direction);
            if (Number.isFinite(options.near)) rc.near = options.near;
            if (Number.isFinite(options.far)) rc.far = options.far;
            const targets = [];
            for (const obj of nodeMap.values()) {
                if (obj?.isMesh && obj.visible) targets.push(obj);
            }
            return rc.intersectObjects(targets, false).map(hit => ({
                point: hit.point.clone(),
                normal: hit.face?.normal?.clone() ?? new THREE.Vector3(0, 0, 1),
                distance: hit.distance,
                handle: hit.object?.userData?.maxjsHandle ?? null,
                name: hit.object?.name ?? '',
            }));
        },
    });
}

function createRendererFacade(renderer) {
    return freezePlainObject({
        get capabilities() { return renderer.capabilities; },
        get info() { return renderer.info; },
        get domElement() { return renderer.domElement; },
        get width() { return renderer.domElement?.width ?? 0; },
        get height() { return renderer.domElement?.height ?? 0; },
    });
}

function createInputHelper(renderer) {
    const el = renderer.domElement;
    const listeners = [];
    function on(target, event, fn, opts) {
        target.addEventListener(event, fn, opts);
        listeners.push({ target, event, fn, opts });
    }
    return {
        get element() { return el; },
        get document() { return el?.ownerDocument; },
        on,
        dispose() {
            for (const { target, event, fn, opts } of listeners)
                target.removeEventListener(event, fn, opts);
            listeners.length = 0;
        },
    };
}

const SANDBOX_DOM_WHITELIST = new Set(['canvas', 'img', 'video', 'audio']);

const sandboxDocument = Object.freeze({
    createElement(tag) {
        const t = String(tag).toLowerCase();
        if (!SANDBOX_DOM_WHITELIST.has(t))
            throw new Error(`Sandbox: createElement("${t}") not allowed. Whitelist: ${[...SANDBOX_DOM_WHITELIST].join(', ')}`);
        return document.createElement(t);
    },
});

const SANDBOX_PRELUDE = [
    '"use strict";',
    'const window = undefined;',
    'const globalThis = undefined;',
    'const self = undefined;',
    'const chrome = undefined;',
    'const fetch = undefined;',
    'const XMLHttpRequest = undefined;',
    'const WebSocket = undefined;',
    'const localStorage = undefined;',
    'const sessionStorage = undefined;',
].join('\n');

function buildInlineFactory(code) {
    return new Function('ctx', 'THREE', 'document', `${SANDBOX_PRELUDE}\n${code}`);
}

export function createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap,
    maxRoot = null,
    jsRoot = null,
    overlayRoot = null,
    space = null,
}) {
    const layers = new Map();
    const listeners = new Set();
    let projectControl = null;
    let lastMountMs = 0;
    let lastStats = freezePlainObject({
        layerCount: 0,
        activeLayerCount: 0,
        anchorCount: 0,
        trackedCount: 0,
        updateMs: 0,
        lastMountMs: 0,
    });

    const jsWorldRoot = markOwned(jsRoot || new THREE.Group(), OWNER_JS);
    jsWorldRoot.name ||= '__maxjs_js_root__';
    if (!jsWorldRoot.parent) scene.add(jsWorldRoot);

    const overlayWorldRoot = markOwned(overlayRoot || new THREE.Group(), OWNER_OVERLAY);
    overlayWorldRoot.name ||= '__maxjs_overlay_root__';
    if (!overlayWorldRoot.parent) scene.add(overlayWorldRoot);

    if (maxRoot) setOwner(maxRoot, OWNER_MAX);

    let cameraClaimOwner = null; // layer id that claimed camera, or null
    const cameraControl = {
        claim(layerId) { cameraClaimOwner = layerId; camera.matrixAutoUpdate = true; },
        release(layerId) {
            if (!layerId || cameraClaimOwner === layerId) {
                cameraClaimOwner = null;
                camera.matrixAutoUpdate = false;
            }
        },
        isClaimed() { return cameraClaimOwner !== null; },
        getOwner() { return cameraClaimOwner; },
    };

    const isWebGPU = !!(renderer?.backend?.parameters?.forceWebGL === undefined
        && renderer?.backend?.constructor?.name !== 'WebGLBackend');

    let dt = 0;
    let elapsed = 0;

    function emitChange(reason = 'state') {
        for (const listener of listeners) {
            try {
                listener(reason);
            } catch (error) {
                console.error('[LayerManager] listener error', error);
            }
        }
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function snapshotLayer(layer) {
        return {
            id: layer.id,
            name: layer.name,
            source: layer.source,
            entry: layer.entry,
            code: layer.code,
            active: layer.active,
            loading: layer.loading,
            error: layer.error,
            anchors: layer.anchors.length,
            tracked: layer.tracked.size,
            profile: freezePlainObject({
                mountMs: layer.profile.mountMs,
                lastUpdateMs: layer.profile.lastUpdateMs,
                avgUpdateMs: layer.profile.avgUpdateMs,
                maxUpdateMs: layer.profile.maxUpdateMs,
                updateCount: layer.profile.updateCount,
            }),
        };
    }

    function ownForLayer(resource, owner = OWNER_JS) {
        return markOwned(resource, owner);
    }

    function getOrCreateLayerInput(layer) {
        if (!layer.input) layer.input = createInputHelper(renderer);
        return layer.input;
    }

    function cloneMaterialForLayer(material, owner) {
        if (!material) return material;
        if (Array.isArray(material)) return material.map(item => cloneMaterialForLayer(item, owner));
        const clone = material.clone();
        for (const key of MATERIAL_MAP_KEYS) {
            if (material[key]?.clone) clone[key] = markOwned(material[key].clone(), owner);
        }
        return markOwned(clone, owner);
    }

    function cloneMaxNode(handle, options = {}) {
        const source = nodeMap.get(handle);
        if (!source?.isObject3D) return null;
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        const clone = source.clone(false);
        clone.name = options.name || `${source.name || 'node'}_clone`;
        clone.matrixAutoUpdate = false;
        clone.matrix.copy(source.matrixWorld);
        clone.matrixWorld.copy(source.matrixWorld);
        clone.matrixWorldNeedsUpdate = true;
        clone.visible = true;
        if (source.geometry?.clone) clone.geometry = markOwned(source.geometry.clone(), owner);
        if (source.material) {
            if (source.userData?.jsmod) {
                // three.js Deform layers own geometry, but material edits from Max
                // should keep flowing to the runtime clone without a refresh.
                clone.material = source.material;
                clone.userData.maxjsSourceHandle = handle;
                clone.userData.maxjsFollowSourceMaterial = true;
            } else {
                clone.material = cloneMaterialForLayer(source.material, owner);
            }
        }
        return markOwned(clone, owner);
    }

    function createAnchorForLayer(layer, handle, options = {}) {
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
        const anchor = markOwned(new THREE.Group(), owner);
        anchor.name = options.name || `anchor_${handle}`;
        anchor.matrixAutoUpdate = false;
        anchor.userData.maxjsAnchorHandle = handle;
        anchor.userData.maxjsFollowVisibility = options.followVisibility !== false;
        anchor.userData.maxjsCopyWorldMatrix = options.copyWorldMatrix !== false;
        if (options.snapshotId) setSnapshotTargetId(anchor, `runtime:${layer.id}:${options.snapshotId}`);
        layer.anchors.push(anchor);
        parent.add(anchor);
        return anchor;
    }

    function getLayerNodeAdapter(layer, handle) {
        if (!nodeMap.has(handle)) return null;
        let adapter = layer.nodeAdapters.get(handle);
        if (!adapter) {
            adapter = createMaxNodeAdapter({
                handle,
                getObject: () => nodeMap.get(handle) ?? null,
                THREE,
                createAnchor: (nextHandle, options) => createAnchorForLayer(layer, nextHandle, options),
            });
            layer.nodeAdapters.set(handle, adapter);
        }
        return adapter;
    }

    function buildContext(layer) {
        const rendererFacade = createRendererFacade(renderer);
        const cameraFacade = createCameraAdapter(camera, THREE, ownForLayer, cameraControl, layer.id);
        const nodeMapFacade = createNodeMapFacade(nodeMap, handle => getLayerNodeAdapter(layer, handle));
        const maxSceneFacade = createMaxSceneFacade({
            scene,
            nodeMap,
            getAdapter: handle => getLayerNodeAdapter(layer, handle),
            createAnchor: (handle, options = {}) => createAnchorForLayer(layer, handle, options),
            THREE,
        });

        const runtimeFacade = freezePlainObject({
            get id() { return layer.id; },
            get name() { return layer.name; },
            get isWebGPU() { return isWebGPU; },
            get dt() { return dt; },
            get elapsed() { return elapsed; },
            // Scene coordinate info — world is Y-up (Three.js default), Max Z-up converted on input
            upAxis: Object.freeze(new THREE.Vector3(0, 1, 0)),
            gravity: Object.freeze(new THREE.Vector3(0, -980, 0)),
            space,
            units: 'cm',
            log: (...args) => console.log(`[Layer:${layer.id}]`, ...args),
            warn: (...args) => console.warn(`[Layer:${layer.id}]`, ...args),
            error: (...args) => console.error(`[Layer:${layer.id}]`, ...args),
        });

        const projectFacade = freezePlainObject({
            setDirectory(dir, options = {}) {
                if (!projectControl?.setProjectDirectory) {
                    throw new Error('Project runtime is not bound');
                }
                return projectControl.setProjectDirectory(dir, options);
            },
            reload(force = true) {
                if (!projectControl?.reload) {
                    throw new Error('Project runtime is not bound');
                }
                return projectControl.reload(force);
            },
            getState() {
                return projectControl?.getState?.() ?? null;
            },
        });

        const jsFacade = freezePlainObject({
            root: layer.group,
            overlayRoot: layer.overlayGroup,
            own(resource, options = {}) {
                return ownForLayer(resource, options.overlay ? OWNER_OVERLAY : OWNER_JS);
            },
            add(resource, options = {}) {
                if (!resource?.isObject3D) return null;
                const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
                const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
                markOwned(resource, owner);
                if (options.snapshotId) setSnapshotTargetId(resource, `runtime:${layer.id}:${options.snapshotId}`);
                parent.add(resource);
                return resource;
            },
            remove(resource) {
                if (!resource?.isObject3D || !isOwnedByJs(resource)) return false;
                resource.parent?.remove(resource);
                disposeOwnedResource(resource);
                return true;
            },
            createGroup(name = '', options = {}) {
                const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
                const group = markOwned(new THREE.Group(), owner);
                if (name) group.name = name;
                if (options.snapshotId) setSnapshotTargetId(group, `runtime:${layer.id}:${options.snapshotId}`);
                const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
                parent.add(group);
                return group;
            },
            createAnchor(handle, options = {}) {
                return createAnchorForLayer(layer, handle, options);
            },
            cloneFromMax(handle, options = {}) {
                const clone = cloneMaxNode(handle, options);
                if (!clone) return null;
                if (options.snapshotId) setSnapshotTargetId(clone, `runtime:${layer.id}:${options.snapshotId}`);
                const parent = options.overlay ? layer.overlayGroup : layer.group;
                parent.add(clone);
                if (clone.userData?.maxjsFollowSourceMaterial) layer.liveMaterialClones.add(clone);
                return clone;
            },
            track(resource, options = {}) {
                if (!resource) return resource;
                markOwned(resource, options.overlay ? OWNER_OVERLAY : OWNER_JS);
                if (options.snapshotId) setSnapshotTargetId(resource, `runtime:${layer.id}:${options.snapshotId}`);
                layer.tracked.add(resource);
                return resource;
            },
            setSnapshotId(resource, id) {
                if (!resource?.isObject3D || !id) return resource;
                return setSnapshotTargetId(resource, `runtime:${layer.id}:${id}`);
            },
            dispose(resource) {
                disposeOwnedResource(resource);
            },
        });

        return {
            layer: freezePlainObject({ id: layer.id, name: layer.name }),
            group: layer.group,
            overlayGroup: layer.overlayGroup,
            js: jsFacade,
            scene: maxSceneFacade,
            maxScene: maxSceneFacade,
            nodeMap: nodeMapFacade,
            camera: cameraFacade,
            renderer: rendererFacade,
            get input() {
                return getOrCreateLayerInput(layer);
            },
            THREE,
            clock: freezePlainObject({
                get dt() { return dt; },
                get elapsed() { return elapsed; },
            }),
            runtime: runtimeFacade,
            project: projectFacade,
            track(resource, options = {}) {
                return jsFacade.track(resource, options);
            },
        };
    }

    function syncAnchors(layer, syncCache) {
        for (const anchor of layer.anchors) {
            const handle = anchor.userData.maxjsAnchorHandle;
            let sourceState = syncCache.get(handle);
            if (sourceState === undefined) {
                const source = nodeMap.get(handle);
                if (!source) {
                    sourceState = null;
                } else {
                    source.updateWorldMatrix(true, false);
                    sourceState = {
                        visible: !!source.visible,
                        matrixWorld: source.matrixWorld,
                    };
                }
                syncCache.set(handle, sourceState);
            }

            if (!sourceState) {
                anchor.visible = false;
                continue;
            }
            anchor.visible = anchor.userData.maxjsFollowVisibility ? sourceState.visible : true;
            if (anchor.userData.maxjsCopyWorldMatrix) {
                anchor.matrix.copy(sourceState.matrixWorld);
                anchor.matrixWorldNeedsUpdate = true;
            }
        }
    }

    function syncLiveMaterialClones(layer) {
        for (const clone of [...layer.liveMaterialClones]) {
            if (!clone?.isObject3D || !clone.parent) {
                layer.liveMaterialClones.delete(clone);
                continue;
            }
            if (!clone.userData?.maxjsFollowSourceMaterial) {
                layer.liveMaterialClones.delete(clone);
                continue;
            }

            const handle = clone.userData.maxjsSourceHandle;
            const source = Number.isFinite(handle) ? nodeMap.get(handle) : null;
            if (!source?.isObject3D) {
                clone.visible = false;
                continue;
            }

            if (clone.material !== source.material) clone.material = source.material;
        }
    }

    function createLayerState(id, options = {}) {
        if (layers.has(id)) remove(id);

        const group = markOwned(new THREE.Group(), OWNER_JS);
        group.name = `__inline_${id}__`;
        group.matrixAutoUpdate = false;
        group.matrix.identity();
        setSnapshotTargetId(group, `runtime:${id}:root`);

        const overlayGroup = markOwned(new THREE.Group(), OWNER_OVERLAY);
        overlayGroup.name = `__inline_overlay_${id}__`;
        overlayGroup.matrixAutoUpdate = false;
        overlayGroup.matrix.identity();
        setSnapshotTargetId(overlayGroup, `runtime:${id}:overlay_root`);

        const layer = {
            id,
            name: options.name || id,
            code: options.code || '',
            group,
            overlayGroup,
            source: options.source || 'inline',
            entry: options.entry || '',
            hooks: null,
            active: true,
            loading: false,
            error: null,
            errorCount: 0,
            tracked: new Set(),
            anchors: [],
            liveMaterialClones: new Set(),
            nodeAdapters: new Map(),
            input: null,
            profile: {
                mountMs: 0,
                lastUpdateMs: 0,
                avgUpdateMs: 0,
                maxUpdateMs: 0,
                updateCount: 0,
            },
            ctx: null,
        };

        jsWorldRoot.add(group);
        overlayWorldRoot.add(overlayGroup);
        layer.ctx = buildContext(layer);
        layers.set(id, layer);
        emitChange('mounting');
        return layer;
    }

    async function mount(id, createHooks, options = {}) {
        const layer = createLayerState(id, options);
        const mountStart = performance.now();
        const mountToken = Symbol(id);
        layer.loading = true;
        layer.mountToken = mountToken;
        try {
            const hooks = await createHooks(layer.ctx, THREE);
            if (layers.get(id) !== layer || layer.mountToken !== mountToken) {
                return { id, error: 'Layer replaced during load' };
            }
            layer.hooks = hooks || {};
            if (typeof layer.hooks.init === 'function') {
                await layer.hooks.init(layer.ctx);
            }
        } catch (err) {
            layer.error = err?.message || String(err);
            layer.active = false;
            console.error(`[LayerManager] Layer "${id}" init error:`, err);
        } finally {
            if (layers.get(id) === layer) layer.loading = false;
        }
        layer.profile.mountMs = performance.now() - mountStart;
        lastMountMs = layer.profile.mountMs;
        emitChange('mounted');
        return { id, error: layer.error };
    }

    function inject(id, code, name) {
        return mount(id, async (ctx, runtimeThree) => {
            const factory = buildInlineFactory(code);
            return factory(ctx, runtimeThree, sandboxDocument);
        }, { name: name || id, code, source: 'inline' });
    }

    function remove(id, options = {}) {
        const layer = layers.get(id);
        if (!layer) return false;

        if (layer.hooks && typeof layer.hooks.dispose === 'function') {
            try {
                layer.hooks.dispose(layer.ctx);
            } catch (err) {
                console.warn(`[LayerManager] Layer "${id}" dispose error:`, err);
            }
        }

        for (const resource of layer.tracked) {
            try {
                disposeOwnedResource(resource);
            } catch (err) {
                console.warn(`[LayerManager] Layer "${id}" tracked dispose error:`, err);
            }
        }
        layer.tracked.clear();
        layer.anchors.length = 0;
        layer.nodeAdapters.clear();
        if (layer.input) { layer.input.dispose(); layer.input = null; }

        jsWorldRoot.remove(layer.group);
        overlayWorldRoot.remove(layer.overlayGroup);
        disposeOwnedResource(layer.group);
        disposeOwnedResource(layer.overlayGroup);

        // Safety: release camera if this layer had claimed it
        if (cameraControl.getOwner() === id) {
            cameraControl.release(id);
        }

        layers.delete(id);
        if (!options.silent) emitChange('removed');
        return true;
    }

    function clearWhere(predicate = null) {
        let changed = false;
        for (const [id, layer] of [...layers.entries()]) {
            if (predicate && !predicate(layer)) continue;
            changed = remove(id, { silent: true }) || changed;
        }
        if (changed) emitChange('cleared');
    }

    function clear() {
        clearWhere();
    }

    function clearInline() {
        clearWhere(layer => layer.source === 'inline');
    }

    function list() {
        return [...layers.values()].map(layer => snapshotLayer(layer));
    }

    function getLayerSnapshot(id) {
        const layer = layers.get(id);
        return layer ? snapshotLayer(layer) : null;
    }

    function getStats() {
        return lastStats;
    }

    function update(frameDt, frameElapsed) {
        dt = frameDt;
        elapsed = frameElapsed;
        const anchorSyncCache = new Map();
        let activeLayerCount = 0;
        let anchorCount = 0;
        let trackedCount = 0;
        let totalUpdateMs = 0;

        for (const layer of layers.values()) {
            anchorCount += layer.anchors.length;
            trackedCount += layer.tracked.size;
            if (layer.active) activeLayerCount++;

            if (layer.loading || !layer.active || !layer.hooks || typeof layer.hooks.update !== 'function') {
                syncAnchors(layer, anchorSyncCache);
                syncLiveMaterialClones(layer);
                continue;
            }
            try {
                const updateStart = performance.now();
                syncAnchors(layer, anchorSyncCache);
                syncLiveMaterialClones(layer);
                layer.hooks.update(layer.ctx, dt, elapsed);
                const updateMs = performance.now() - updateStart;
                totalUpdateMs += updateMs;
                layer.profile.lastUpdateMs = updateMs;
                layer.profile.updateCount += 1;
                layer.profile.avgUpdateMs += (updateMs - layer.profile.avgUpdateMs) / layer.profile.updateCount;
                layer.profile.maxUpdateMs = Math.max(layer.profile.maxUpdateMs, updateMs);
                layer.errorCount = 0;
            } catch (err) {
                layer.errorCount++;
                if (layer.errorCount >= MAX_CONSECUTIVE_ERRORS) {
                    layer.active = false;
                    layer.error = `Auto-deactivated after ${MAX_CONSECUTIVE_ERRORS} errors: ${err.message}`;
                    console.error(`[LayerManager] Layer "${layer.id}" deactivated:`, err);
                    emitChange('deactivated');
                }
            }
        }

        lastStats = freezePlainObject({
            layerCount: layers.size,
            activeLayerCount,
            anchorCount,
            trackedCount,
            updateMs: totalUpdateMs,
            lastMountMs,
        });
    }

    function getLayerCode(id) {
        return layers.get(id)?.code ?? null;
    }

    function isDescendantOf(obj, ancestor) {
        let p = obj;
        while (p) {
            if (p === ancestor) return true;
            p = p.parent;
        }
        return false;
    }

    /** Max-bridge meshes currently hidden in the viewport (e.g. jsmod layers show JS clones instead). */
    function collectHiddenMaxSyncHandles() {
        if (!maxRoot) return [];
        const out = [];
        for (const [handle, obj] of nodeMap.entries()) {
            if (!obj?.isObject3D) continue;
            if (!isDescendantOf(obj, maxRoot)) continue;
            const drawable = obj.isMesh || obj.isLine || obj.isLineSegments;
            if (!drawable) continue;
            if (!obj.visible) out.push(handle);
        }
        return out;
    }

    /** Meshes driven by three.js Deform (jsmod); snapshot embeds JS clones under jsRoot — always hide these Max copies when jsRoot is present. */
    function collectJsmodMaxSyncHandles() {
        if (!maxRoot) return [];
        const out = [];
        for (const [handle, obj] of nodeMap.entries()) {
            if (!obj?.isObject3D) continue;
            if (!isDescendantOf(obj, maxRoot)) continue;
            const drawable = obj.isMesh || obj.isLine || obj.isLineSegments;
            if (!drawable) continue;
            if (obj.userData?.jsmod) out.push(handle);
        }
        return out;
    }

    /**
     * Snapshot everything under a runtime world root (all layer groups + any future direct children),
     * plus tracked Object3Ds that are not already in that subtree (e.g. ctx.track only).
     */
    function buildRuntimeSubtreeJson(worldRoot, snapshotName, trackedOwnerFilter) {
        const snapshot = new THREE.Group();
        snapshot.name = snapshotName;

        if (worldRoot?.isObject3D) {
            for (const child of worldRoot.children) {
                if (!child?.isObject3D) continue;
                if (child.userData?.maxjsExcludeFromRuntimeSnapshot) continue;
                snapshot.add(child.clone(true));
            }
        }

        if (trackedOwnerFilter != null) {
            for (const layer of layers.values()) {
                for (const t of layer.tracked) {
                    if (!t?.isObject3D) continue;
                    if (getOwner(t) !== trackedOwnerFilter) continue;
                    if (isDescendantOf(t, worldRoot)) continue;
                    snapshot.add(t.clone(true));
                }
            }
        }

        return snapshot.children.length > 0 ? snapshot.toJSON() : null;
    }

    function serializeSnapshot() {
        const jsRoot = buildRuntimeSubtreeJson(jsWorldRoot, '__maxjs_snapshot_js_root__', OWNER_JS);
        const overlayRoot = buildRuntimeSubtreeJson(overlayWorldRoot, '__maxjs_snapshot_overlay_root__', OWNER_OVERLAY);
        const payload = {
            version: 1,
            layers: [...layers.values()].map(layer => ({
                id: layer.id,
                name: layer.name,
                source: layer.source,
                active: layer.active,
                error: layer.error,
            })),
            jsRoot,
            overlayRoot,
        };
        if (jsRoot || overlayRoot) {
            const hidden = new Set(collectHiddenMaxSyncHandles());
            if (jsRoot) {
                for (const h of collectJsmodMaxSyncHandles()) hidden.add(h);
            }
            payload.hideMaxSyncHandles = [...hidden];
        }
        return payload;
    }

    function serialize() {
        return [...layers.values()].map(layer => ({
            id: layer.id,
            name: layer.name,
            code: layer.code,
            enabled: layer.active,
        }));
    }

    return {
        mount,
        subscribe,
        bindProjectRuntime(control) {
            projectControl = control;
            emitChange('project_bound');
        },
        inject,
        remove,
        clear,
        clearInline,
        list,
        getLayerSnapshot,
        getStats,
        update,
        getLayerCode,
        serializeSnapshot,
        serialize,
        get isCameraOverridden() { return cameraControl.isClaimed(); },
        roots: freezePlainObject({
            maxRoot,
            jsRoot: jsWorldRoot,
            overlayRoot: overlayWorldRoot,
        }),
    };
}
