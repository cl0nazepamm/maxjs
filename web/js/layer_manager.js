// layer_manager.js - orchestrates MaxJS runtime layer lifecycle.
// Max-owned scene content stays read-only behind adapters.
// JS-authored content lives under its own roots and owns its own resources.

import { maxTimeline } from './maxjs_timeline.js';
import { createCameraAdapter } from './layer_camera_adapter.js';
import { createInputHelper, createMaxSceneFacade, createNodeMapFacade, createRendererFacade } from './layer_facades.js';
import { createMaxNodeAdapter } from './layer_node_adapter.js';
import { createRuntimeOverrideController } from './layer_runtime_overrides.js';
import {
    MATERIAL_MAP_KEYS,
    OWNER_MAX,
    OWNER_JS,
    OWNER_OVERLAY,
    disposeOwnedResource,
    getOwner,
    markOwned,
    setOwner,
    setSnapshotTargetId,
} from './layer_ownership.js';
import { freezePlainObject, normalizeFolder, normalizePriority } from './layer_utils.js';
import { createWebappLayer } from './webapp_layer.js';

const MAX_CONSECUTIVE_ERRORS = 60;

export function createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap,
    lightHandleMap = null,
    maxRoot = null,
    jsRoot = null,
    overlayRoot = null,
    space = null,
    controls = null,
    getCamera = null,
    getCameraTarget = null,
    onCameraModeChange = null,
    getSceneCameras = () => [],
    getGLTFSystem = () => null,
    debugLog = () => {},
    debugWarn = () => {},
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

    // Camera modes:
    // - 'viewport': synced from Max viewport (default, controlled by Max navigation)
    // - 'physical': locked to a Max Physical Camera object in scene
    // - 'script': fully owned by Three.js layer code (game camera)
    let cameraMode = 'viewport';
    let cameraClaimOwner = null; // layer id that claimed camera (for 'script' mode)
    let physicalCameraHandle = null; // handle of locked physical camera (for 'physical' mode)
    let controlsEnabledBeforeClaim = true;

    const cameraControl = {
        getMode() { return cameraMode; },
        setMode(mode, options = {}) {
            if (mode !== 'viewport' && mode !== 'physical' && mode !== 'script') return false;
            if (mode === 'physical' && !Number.isFinite(Number(options.handle))) return false;
            const prevMode = cameraMode;
            cameraMode = mode;

            if (mode === 'viewport') {
                // Release any ownership, sync from Max viewport
                cameraClaimOwner = null;
                physicalCameraHandle = null;
                camera.matrixAutoUpdate = false;
                if (controls) controls.enabled = controlsEnabledBeforeClaim;
            } else if (mode === 'physical') {
                // Lock to physical camera object
                physicalCameraHandle = options.handle ?? null;
                cameraClaimOwner = options.layerId ?? null;
                camera.matrixAutoUpdate = false;
                if (controls) controls.enabled = false;
            } else if (mode === 'script') {
                // Full JS control
                cameraClaimOwner = options.layerId ?? null;
                physicalCameraHandle = null;
                camera.matrixAutoUpdate = true;
                if (controls) {
                    if (prevMode !== 'script') controlsEnabledBeforeClaim = controls.enabled;
                    controls.enabled = options.enableControls ?? false;
                }
            }
            try {
                onCameraModeChange?.(mode, {
                    handle: physicalCameraHandle,
                    owner: cameraClaimOwner,
                    enableControls: options.enableControls ?? false,
                });
            } catch (error) {
                console.error('[LayerManager] camera mode change callback error', error);
            }
            return true;
        },
        claim(layerId) {
            if (cameraMode === 'script' && cameraClaimOwner && cameraClaimOwner !== layerId) return false;
            return this.setMode('script', { layerId, enableControls: false });
        },
        release(layerId) {
            if (cameraMode === 'script' && (!layerId || cameraClaimOwner === layerId)) {
                return this.setMode('viewport');
            }
            if (cameraMode === 'physical' && (!cameraClaimOwner || !layerId || cameraClaimOwner === layerId)) {
                return this.setMode('viewport');
            }
            return false;
        },
        isClaimed() { return cameraMode === 'script' && cameraClaimOwner !== null; },
        isScriptMode() { return cameraMode === 'script'; },
        isViewportMode() { return cameraMode === 'viewport'; },
        isPhysicalMode() { return cameraMode === 'physical'; },
        getOwner() { return cameraClaimOwner; },
        getPhysicalCameraHandle() { return physicalCameraHandle; },
        getControls() { return controls; },
        getCamera() { return getCamera ? getCamera() : camera; },
        getCameraTarget(target) { return getCameraTarget?.(target) ?? null; },
        getSceneCameras() { return getSceneCameras?.() ?? []; },
    };

    const isWebGPU = !!(renderer?.backend?.parameters?.forceWebGL === undefined
        && renderer?.backend?.constructor?.name !== 'WebGLBackend');

    let dt = 0;
    let elapsed = 0;

    // Inter-layer pub/sub (ctx.bus) — one map shared by all layers of this manager.
    // Handlers are stored with their owning layerId so we can force-remove on layer dispose
    // (the per-layer `disposers` array is the primary cleanup path; this is belt-and-braces).
    const busHandlers = new Map(); // event -> Set<{ handler, layerId }>
    function busEmitInternal(event, payload) {
        const set = busHandlers.get(event);
        if (!set || set.size === 0) return;
        for (const rec of [...set]) {
            try {
                rec.handler(payload);
            } catch (err) {
                console.error(`[LayerManager bus:${event}]`, err);
            }
        }
    }

    // Named service registry (ctx.services) — long-lived handles shared across layers.
    const serviceRegistry = new Map(); // name -> { value, layerId }
    const servicePending = new Map();  // name -> Set<{ cb, layerId }>
    function serviceFireWaiters(name, value) {
        const set = servicePending.get(name);
        if (!set || set.size === 0) return;
        const waiters = [...set];
        servicePending.delete(name);
        for (const rec of waiters) {
            try {
                rec.cb(value);
            } catch (err) {
                console.error(`[LayerManager services.onProvide:${name}]`, err);
            }
        }
    }

    const {
        applyMaterialOverridesToMesh,
        setMaterialMapOverride,
        clearMaterialOverridesForLayer,
        applyAllRuntimeTransformOverrides,
        markRuntimeTransformOverridesDirty,
        serializeRuntimeTransformOverrides,
        restoreRuntimeTransformOverrides,
        createTransformApi,
        clearRuntimeTransformOverridesForLayer,
    } = createRuntimeOverrideController({ THREE, nodeMap });

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
            folder: layer.folder || '',
            priority: Number.isFinite(layer.priority) ? layer.priority : 100,
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
        clone.matrixAutoUpdate = true;
        source.updateWorldMatrix?.(true, false);
        source.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
        clone.matrix.compose(clone.position, clone.quaternion, clone.scale);
        clone.matrixWorld.copy(source.matrixWorld);
        clone.matrixWorldNeedsUpdate = true;
        clone.visible = true;
        clone.userData ??= {};
        clone.userData.maxjsRuntimeClone = true;
        clone.userData.maxjsSourceHandle = handle;
        if (source.geometry?.clone) clone.geometry = markOwned(source.geometry.clone(), owner);
        if (source.material) {
            if (source.userData?.jsmod) {
                // three.js Deform layers own geometry, but material edits from Max
                // should keep flowing to the runtime clone without a refresh.
                clone.material = source.material;
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

    function getLayerNodeAdapter(layer, handle, explicitObj = null) {
        // Check if handle exists in nodeMap or lightHandleMap
        const fromNodeMap = nodeMap.has(handle);
        const fromLightMap = lightHandleMap?.has(handle);
        if (!fromNodeMap && !fromLightMap && !explicitObj) return null;

        let adapter = layer.nodeAdapters.get(handle);
        if (!adapter) {
            adapter = createMaxNodeAdapter({
                handle,
                getObject: () => explicitObj ?? nodeMap.get(handle) ?? lightHandleMap?.get(handle) ?? null,
                THREE,
                createAnchor: (nextHandle, options) => createAnchorForLayer(layer, nextHandle, options),
                layerId: layer.id,
                getTransformApi: createTransformApi,
                setMaterialMap: (h, slot, tex) => setMaterialMapOverride(layer.id, h, slot, tex),
                getNodeAdapter: (nextHandle) => getLayerNodeAdapter(layer, nextHandle),
            });
            layer.nodeAdapters.set(handle, adapter);
        }
        return adapter;
    }

    function buildContext(layer) {
        const rendererFacade = createRendererFacade(renderer, THREE, scene);
        const cameraFacade = createCameraAdapter(camera, THREE, ownForLayer, cameraControl, layer.id, debugWarn);
        const nodeMapFacade = createNodeMapFacade(nodeMap, handle => getLayerNodeAdapter(layer, handle));
        const maxSceneFacade = createMaxSceneFacade({
            scene,
            nodeMap,
            lightHandleMap,
            getAdapter: (handle, explicitObj) => getLayerNodeAdapter(layer, handle, explicitObj),
            createAnchor: (handle, options = {}) => createAnchorForLayer(layer, handle, options),
            THREE,
        });

        const gltfFacade = freezePlainObject({
            get(handle) {
                return getGLTFSystem()?.getEntry?.(handle) ?? null;
            },
            findByName(name) {
                return getGLTFSystem()?.findByName?.(name) ?? null;
            },
            list() {
                return Object.freeze([...(getGLTFSystem()?.list?.() ?? [])]);
            },
            onReady(handle, cb) {
                const sys = getGLTFSystem();
                if (!sys?.onReady) return () => {};
                const dispose = sys.onReady(handle, cb);
                if (typeof dispose === 'function') layer.disposers.push(dispose);
                return dispose;
            },
        });

        const readVectorLike = (value, target = new THREE.Vector3()) => {
            if (value?.isVector3) return target.copy(value);
            if (value?.point?.isVector3) return target.copy(value.point);
            if (Array.isArray(value?.point) || ArrayBuffer.isView(value?.point)) {
                return target.set(Number(value.point[0]) || 0, Number(value.point[1]) || 0, Number(value.point[2]) || 0);
            }
            if (Array.isArray(value) || ArrayBuffer.isView(value)) {
                return target.set(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
            }
            if (value && typeof value === 'object') {
                return target.set(Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0);
            }
            return target.set(0, 0, 0);
        };

        const pointFromNodeLike = (value, target = new THREE.Vector3()) => {
            if (value?.getVisualCenter) return value.getVisualCenter(target);
            if (value?.getWorldPosition) return value.getWorldPosition(target);
            return readVectorLike(value, target);
        };

        const readQuaternionLike = (value, target = new THREE.Quaternion()) => {
            if (value?.isQuaternion) return target.copy(value);
            if (Array.isArray(value) || ArrayBuffer.isView(value)) {
                return target.set(
                    Number(value[0]) || 0,
                    Number(value[1]) || 0,
                    Number(value[2]) || 0,
                    Number(value[3]) || 1
                ).normalize();
            }
            if (value?.isEuler) return target.setFromEuler(value);
            if (value && typeof value === 'object') {
                if (Number.isFinite(Number(value.w))) {
                    return target.set(
                        Number(value.x) || 0,
                        Number(value.y) || 0,
                        Number(value.z) || 0,
                        Number(value.w)
                    ).normalize();
                }
                if (Number.isFinite(Number(value.x)) || Number.isFinite(Number(value.y)) || Number.isFinite(Number(value.z))) {
                    return target.setFromEuler(new THREE.Euler(
                        Number(value.x) || 0,
                        Number(value.y) || 0,
                        Number(value.z) || 0,
                        value.order || 'XYZ'
                    ));
                }
            }
            return target.identity();
        };

        const readScaleLike = (value, target = new THREE.Vector3()) => {
            if (Number.isFinite(Number(value))) {
                const uniform = Number(value);
                return target.set(uniform, uniform, uniform);
            }
            return readVectorLike(value, target);
        };

        const resolveNodeAdapter = (value, options = {}) => {
            if (value?.handle != null) return getLayerNodeAdapter(layer, Number(value.handle));
            if (Number.isFinite(Number(value))) return getLayerNodeAdapter(layer, Number(value));
            if (typeof value === 'string') {
                return maxSceneFacade.findOne(value, { exact: options.exact !== false })
                    ?? maxSceneFacade.findOne(value, { exact: false });
            }
            return null;
        };

        const setObjectWorldTransform = (obj, parent, position, quaternion, scale) => {
            parent.add(obj);
            parent.updateWorldMatrix?.(true, false);
            const world = new THREE.Matrix4().compose(position, quaternion, scale);
            const local = parent.matrixWorld
                ? new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(world)
                : world;
            local.decompose(obj.position, obj.quaternion, obj.scale);
            obj.matrixAutoUpdate = true;
            obj.updateMatrix();
            obj.updateMatrixWorld(true);
            return obj;
        };

        const placeRuntimeClone = (clone, sourceAdapter, parent, options = {}) => {
            const sourceObj = nodeMap.get(sourceAdapter.handle);
            const position = sourceAdapter.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
            const quaternion = sourceAdapter.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
            const scale = sourceAdapter.getWorldScale(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);

            if (options.quaternion != null || options.rotation != null || options.rotationEuler != null) {
                readQuaternionLike(options.quaternion ?? options.rotation ?? options.rotationEuler, quaternion);
            }
            if (options.scale != null) readScaleLike(options.scale, scale);
            if (options.scaleMultiplier != null && Number.isFinite(Number(options.scaleMultiplier))) {
                scale.multiplyScalar(Number(options.scaleMultiplier));
            }
            if (scale.lengthSq() < 1e-12) scale.set(1, 1, 1);

            const requestedPosition = options.at ?? options.position ?? options.worldPosition;
            if (requestedPosition != null) {
                readVectorLike(requestedPosition, position);
                const align = String(options.align ?? options.anchor ?? 'pivot').toLowerCase();
                if (align === 'center' || align === 'visualcenter' || align === 'visual-center') {
                    const pivot = sourceAdapter.getWorldPosition(new THREE.Vector3());
                    const center = sourceAdapter.getVisualCenter(new THREE.Vector3());
                    if (pivot && center) position.sub(center.sub(pivot));
                }
            } else if (sourceObj?.matrixWorld) {
                sourceObj.matrixWorld.decompose(position, quaternion, scale);
            }

            return setObjectWorldTransform(clone, parent, position, quaternion, scale);
        };

        const runtimeSpaceFacade = freezePlainObject({
            maxUpAxis: space?.maxUpAxis?.clone?.() ?? Object.freeze(new THREE.Vector3(0, 0, 1)),
            worldUpAxis: space?.worldUpAxis?.clone?.() ?? Object.freeze(new THREE.Vector3(0, 1, 0)),
            upAxis: Object.freeze(new THREE.Vector3(0, 1, 0)),
            groundPlane: 'XZ',
            units: 'cm',
            maxToWorldMapping: 'x,z,-y',
            toWorldPosition(value, target = new THREE.Vector3()) {
                if (space?.toWorldPosition) return space.toWorldPosition(value, target);
                readVectorLike(value, target);
                return target.set(target.x, target.z, -target.y);
            },
            toWorldDirection(value, target = new THREE.Vector3()) {
                if (space?.toWorldDirection) return space.toWorldDirection(value, target);
                readVectorLike(value, target);
                return target.set(target.x, target.z, -target.y).normalize();
            },
            toWorldMatrix(value, target = new THREE.Matrix4()) {
                if (space?.toWorldMatrix) return space.toWorldMatrix(value, target);
                if (value?.isMatrix4) return target.copy(value);
                if (Array.isArray(value) || ArrayBuffer.isView(value)) return target.fromArray(value);
                return target.identity();
            },
            toMaxPosition(value, target = new THREE.Vector3()) {
                if (space?.toMaxPosition) return space.toMaxPosition(value, target);
                readVectorLike(value, target);
                return target.set(target.x, -target.z, target.y);
            },
            getPivotWorldPosition(node, target = new THREE.Vector3()) {
                if (node?.getPivotWorldPosition) return node.getPivotWorldPosition(target);
                if (node?.getWorldPosition) return node.getWorldPosition(target);
                return readVectorLike(node, target);
            },
            getVisualCenter(node, target = new THREE.Vector3()) {
                if (node?.getVisualCenter) return node.getVisualCenter(target);
                if (node?.getBoundingBox) {
                    const box = node.getBoundingBox();
                    if (box) return box.getCenter(target);
                }
                if (node?.isObject3D) return new THREE.Box3().setFromObject(node).getCenter(target);
                return readVectorLike(node, target);
            },
            getPivotToVisualCenter(node, target = new THREE.Vector3()) {
                if (node?.getPivotToVisualCenter) return node.getPivotToVisualCenter(target);
                const pivot = this.getPivotWorldPosition(node, new THREE.Vector3());
                const center = this.getVisualCenter(node, target);
                return center.sub(pivot);
            },
            getLocalAxesWorld(node) {
                if (node?.getLocalAxesWorld) return node.getLocalAxesWorld();
                const obj = node?.isObject3D ? node : null;
                if (!obj) return null;
                const q = obj.getWorldQuaternion(new THREE.Quaternion());
                return {
                    x: new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize(),
                    y: new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize(),
                    z: new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize(),
                };
            },
            forwardFromAxles(frontLeft, frontRight, rearLeft, rearRight, target = new THREE.Vector3()) {
                const front = pointFromNodeLike(frontLeft, new THREE.Vector3())
                    .add(pointFromNodeLike(frontRight, new THREE.Vector3()))
                    .multiplyScalar(0.5);
                const rear = pointFromNodeLike(rearLeft, new THREE.Vector3())
                    .add(pointFromNodeLike(rearRight, new THREE.Vector3()))
                    .multiplyScalar(0.5);
                target.subVectors(front, rear);
                return target.lengthSq() > 0 ? target.normalize() : target.set(0, 0, 1);
            },
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
            space: runtimeSpaceFacade,
            units: 'cm',
            gltf: gltfFacade,
            log: (...args) => debugLog(`[Layer:${layer.id}]`, ...args),
            warn: (...args) => debugWarn(`[Layer:${layer.id}]`, ...args),
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

        const ctxRef = { current: null };
        const webappFacade = freezePlainObject({
            create(spec) {
                return createWebappLayer(ctxRef.current, THREE, spec);
            },
        });

        const busFacade = freezePlainObject({
            on(event, handler) {
                if (typeof event !== 'string' || !event) throw new TypeError('bus.on: event must be a non-empty string');
                if (typeof handler !== 'function') throw new TypeError('bus.on: handler must be a function');
                let set = busHandlers.get(event);
                if (!set) { set = new Set(); busHandlers.set(event, set); }
                const rec = { handler, layerId: layer.id };
                set.add(rec);
                const dispose = () => {
                    set.delete(rec);
                    if (set.size === 0) busHandlers.delete(event);
                };
                layer.disposers.push(dispose);
                return dispose;
            },
            once(event, handler) {
                if (typeof handler !== 'function') throw new TypeError('bus.once: handler must be a function');
                let dispose = null;
                dispose = busFacade.on(event, (payload) => {
                    dispose?.();
                    try { handler(payload); } catch (err) { console.error(`[LayerManager bus.once:${event}]`, err); }
                });
                return dispose;
            },
            off(event, handler) {
                const set = busHandlers.get(event);
                if (!set) return false;
                for (const rec of set) {
                    if (rec.handler === handler) {
                        set.delete(rec);
                        if (set.size === 0) busHandlers.delete(event);
                        return true;
                    }
                }
                return false;
            },
            emit: busEmitInternal,
        });

        const servicesFacade = freezePlainObject({
            provide(name, value) {
                if (typeof name !== 'string' || !name) throw new TypeError('services.provide: name must be a non-empty string');
                const existing = serviceRegistry.get(name);
                if (existing) {
                    throw new Error(`Service "${name}" already provided by layer "${existing.layerId}" (layer "${layer.id}" conflict)`);
                }
                serviceRegistry.set(name, { value, layerId: layer.id });
                serviceFireWaiters(name, value);
                const dispose = () => {
                    const cur = serviceRegistry.get(name);
                    if (cur && cur.layerId === layer.id) serviceRegistry.delete(name);
                };
                layer.disposers.push(dispose);
                return value;
            },
            get(name) {
                const entry = serviceRegistry.get(name);
                return entry ? entry.value : null;
            },
            require(name) {
                const entry = serviceRegistry.get(name);
                if (!entry) throw new Error(`Service "${name}" is not available`);
                return entry.value;
            },
            onProvide(name, cb) {
                if (typeof cb !== 'function') throw new TypeError('services.onProvide: cb must be a function');
                const existing = serviceRegistry.get(name);
                if (existing) {
                    try { cb(existing.value); } catch (err) { console.error(`[LayerManager services.onProvide:${name}]`, err); }
                    return () => {};
                }
                let set = servicePending.get(name);
                if (!set) { set = new Set(); servicePending.set(name, set); }
                const rec = { cb, layerId: layer.id };
                set.add(rec);
                const dispose = () => {
                    const cur = servicePending.get(name);
                    if (cur) {
                        cur.delete(rec);
                        if (cur.size === 0) servicePending.delete(name);
                    }
                };
                layer.disposers.push(dispose);
                return dispose;
            },
            has(name) {
                return serviceRegistry.has(name);
            },
        });

        const cloneFromMaxForLayer = (source, options = {}) => {
            const adapter = resolveNodeAdapter(source, options);
            if (!adapter?.isMesh) return null;
            const clone = cloneMaxNode(adapter.handle, options);
            if (!clone) return null;
            if (options.snapshotId) setSnapshotTargetId(clone, `runtime:${layer.id}:${options.snapshotId}`);
            const parent = options.overlay ? layer.overlayGroup : layer.group;
            const targetParent = options.parent?.isObject3D ? options.parent : parent;
            placeRuntimeClone(clone, adapter, targetParent, options);
            if (clone.userData?.maxjsFollowSourceMaterial) layer.liveMaterialClones.add(clone);
            return clone;
        };

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
            cloneFromMax(source, options = {}) {
                return cloneFromMaxForLayer(source, options);
            },
            cloneManyFromMax(sources, options = {}) {
                const list = Array.isArray(sources) ? sources : Array.from(sources ?? []);
                const out = [];
                for (let i = 0; i < list.length; i += 1) {
                    const itemOptions = typeof options === 'function' ? options(list[i], i) : options;
                    const clone = cloneFromMaxForLayer(list[i], itemOptions ?? {});
                    if (clone) out.push(clone);
                }
                return Object.freeze(out);
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
            traverse(cb) {
                if (typeof cb === 'function') layer.group.traverse(cb);
            },
            traverseScene(cb) {
                if (typeof cb === 'function' && scene) scene.traverse(cb);
            },
        });

        const ctx = {
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
            maxTime: freezePlainObject({
                get seconds() { return maxTimeline.now(); },
                get frame() { return maxTimeline.frame(); },
                get fps() { return maxTimeline.fps(); },
                get playing() { return maxTimeline.playing(); },
                get source() { return maxTimeline.source(); },
            }),
            runtime: runtimeFacade,
            project: projectFacade,
            bus: busFacade,
            services: servicesFacade,
            webapp: webappFacade,
            track(resource, options = {}) {
                return jsFacade.track(resource, options);
            },
        };
        ctxRef.current = ctx;
        return ctx;
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
            folder: normalizeFolder(options.folder),
            priority: normalizePriority(options.priority),
            hooks: null,
            active: true,
            loading: false,
            error: null,
            errorCount: 0,
            tracked: new Set(),
            anchors: [],
            liveMaterialClones: new Set(),
            nodeAdapters: new Map(),
            disposers: [],
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

    function remove(id, options = {}) {
        const layer = layers.get(id);
        if (!layer) return false;

        if (layer.hooks && typeof layer.hooks.dispose === 'function') {
            try {
                layer.hooks.dispose(layer.ctx);
            } catch (err) {
                debugWarn(`[LayerManager] Layer "${id}" dispose error:`, err);
            }
        }

        // Auto-unsubscribe bus handlers, service provisions, and onProvide waiters
        // registered through ctx.bus / ctx.services. Runs after hooks.dispose so layer
        // code sees a live bus during its own teardown, then we sweep ghost handlers.
        if (layer.disposers?.length) {
            for (const fn of layer.disposers) {
                try { fn(); } catch (err) { debugWarn(`[LayerManager] Layer "${id}" disposer error:`, err); }
            }
            layer.disposers.length = 0;
        }

        for (const resource of layer.tracked) {
            try {
                disposeOwnedResource(resource);
            } catch (err) {
                debugWarn(`[LayerManager] Layer "${id}" tracked dispose error:`, err);
            }
        }
        layer.tracked.clear();
        layer.anchors.length = 0;
        layer.nodeAdapters.clear();
        if (layer.input) { layer.input.dispose(); layer.input = null; }
        clearRuntimeTransformOverridesForLayer(id);
        clearMaterialOverridesForLayer(id);

        jsWorldRoot.remove(layer.group);
        overlayWorldRoot.remove(layer.overlayGroup);
        disposeOwnedResource(layer.group);
        disposeOwnedResource(layer.overlayGroup);

        // Safety: release camera if this layer had claimed it. Older layers could
        // also leave physical camera mode ownerless, so clear that on removal too.
        if (cameraControl.getOwner() === id || (cameraControl.isPhysicalMode() && cameraControl.getOwner() == null)) {
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

        applyAllRuntimeTransformOverrides();

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

        // Re-sync anchors after runtime transform overrides are applied,
        // so anchors reflect the current frame's transforms, not the previous frame's.
        for (const layer of layers.values()) {
            syncAnchors(layer, anchorSyncCache);
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

    /**
     * Render-time hooks for last-mile camera offsets such as handheld shake.
     *
     * Called every frame from renderFrame:
     *   - beforeRender(elapsed) runs after layer.update() and after all camera
     *     sync (controls.update / applyCamera), but before renderer.render().
     *     Layers can mutate ctx.camera.raw here knowing nothing else will
     *     overwrite it before the draw.
     *   - afterRender(elapsed) runs immediately after the draw. Layers that
     *     applied a transient camera offset should restore the camera here so
     *     the authored state is what other systems (controls, applyCamera,
     *     anchors, sync) see between frames.
     *
     * Mutations made here are NOT seen by anchors, raycasts, or any other
     * system that reads camera state outside the render call.
     */
    function dispatchRenderHook(hookName, frameElapsed) {
        if (Number.isFinite(frameElapsed)) elapsed = frameElapsed;
        for (const layer of layers.values()) {
            if (layer.loading || !layer.active || !layer.hooks) continue;
            const fn = layer.hooks[hookName];
            if (typeof fn !== 'function') continue;
            try {
                fn(layer.ctx, elapsed);
            } catch (err) {
                layer.errorCount++;
                if (layer.errorCount >= MAX_CONSECUTIVE_ERRORS) {
                    layer.active = false;
                    layer.error = `Auto-deactivated after ${MAX_CONSECUTIVE_ERRORS} errors in ${hookName}: ${err.message}`;
                    console.error(`[LayerManager] Layer "${layer.id}" deactivated:`, err);
                    emitChange('deactivated');
                }
            }
        }
    }
    function beforeRender(frameElapsed) { dispatchRenderHook('onBeforeRender', frameElapsed); }
    function afterRender(frameElapsed)  { dispatchRenderHook('onAfterRender',  frameElapsed); }

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
                entry: layer.entry || '',
                folder: layer.folder || '',
                priority: Number.isFinite(layer.priority) ? layer.priority : 100,
                active: layer.active,
                error: layer.error,
            })),
            jsRoot,
            overlayRoot,
        };
        const transformOverrides = serializeRuntimeTransformOverrides();
        if (transformOverrides.length > 0) payload.transformOverrides = transformOverrides;
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
            folder: layer.folder || '',
            priority: Number.isFinite(layer.priority) ? layer.priority : 100,
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
        remove,
        clear,
        setActive(id, active) {
            const layer = layers.get(id);
            if (!layer) return false;
            const next = !!active;
            if (layer.active === next && !!layer.group?.visible === next) return false;
            layer.active = next;
            if (layer.group) layer.group.visible = next;
            if (layer.overlayGroup) layer.overlayGroup.visible = next;
            emitChange(next ? 'activated' : 'deactivated');
            return true;
        },
        setLayerMeta(id, meta = {}) {
            const layer = layers.get(id);
            if (!layer) return false;
            let changed = false;
            if (Object.prototype.hasOwnProperty.call(meta, 'folder')) {
                const next = normalizeFolder(meta.folder);
                if (layer.folder !== next) { layer.folder = next; changed = true; }
            }
            if (Object.prototype.hasOwnProperty.call(meta, 'priority')) {
                const next = normalizePriority(meta.priority);
                if (layer.priority !== next) { layer.priority = next; changed = true; }
            }
            if (Object.prototype.hasOwnProperty.call(meta, 'name')) {
                const next = String(meta.name || id);
                if (layer.name !== next) { layer.name = next; changed = true; }
            }
            if (changed) emitChange('meta');
            return changed;
        },
        getBus() {
            return {
                emit: busEmitInternal,
                has(event) { return busHandlers.has(event) && busHandlers.get(event).size > 0; },
            };
        },
        list,
        getLayerSnapshot,
        getStats,
        update,
        beforeRender,
        afterRender,
        getLayerCode,
        serializeSnapshot,
        restoreTransformOverrides: restoreRuntimeTransformOverrides,
        markRuntimeTransformsDirty: markRuntimeTransformOverridesDirty,
        // Called from the scene message handler after each material assignment
        // so layer-registered map slot overrides survive fastsync rebuilds.
        applyMaterialOverrides: applyMaterialOverridesToMesh,
        serialize,
        get isCameraOverridden() { return cameraControl.isScriptMode(); },
        get cameraMode() { return cameraControl.getMode(); },
        roots: freezePlainObject({
            maxRoot,
            jsRoot: jsWorldRoot,
            overlayRoot: overlayWorldRoot,
        }),
    };
}
