// layer_manager.js - orchestrates MaxJS runtime layer lifecycle.
// Max-owned scene content stays read-only behind adapters.
// JS-authored content lives under its own roots and owns its own resources.

import { maxTimeline } from './maxjs_timeline.js';
import { createCameraAdapter } from './layer_camera_adapter.js';
import { createInputHelper, createInstancesFacade, createMaxSceneFacade, createNodeMapFacade, createRendererFacade } from './layer_facades.js';
import { createDeformSystem } from './layer_deform.js';
import { createLayerParamController } from './layer_params.js';
import { createMorphSystem } from './layer_morph.js';
import { createMaxNodeAdapter } from './layer_node_adapter.js';
import { createRigFacade } from './layer_rig.js';
import { createRuntimeOverrideController } from './layer_runtime_overrides.js';
import { createSpectralMaterialSystem } from './layer_spectral.js';
import {
    MATERIAL_MAP_KEYS,
    OWNER_MAX,
    OWNER_JS,
    OWNER_OVERLAY,
    clearOwner,
    disposeOwnedResource,
    getOwner,
    isOwnedByJs,
    isOwnedByMax,
    markOwned,
    setSnapshotTargetId,
} from './layer_ownership.js';
import { freezePlainObject, normalizeFolder, normalizePriority } from './layer_utils.js';
import { createWebappLayer } from './webapp_layer.js';

const MAX_CONSECUTIVE_ERRORS = 60;

// Handed to a layer that is no longer mounted. Allocating a real input helper
// there would attach DOM listeners nobody owns, but throwing is worse: a stale
// hooks.dispose() reading ctx.input would abort mid-teardown and skip the rest
// of its own cleanup.
const INERT_LAYER_INPUT = freezePlainObject({
    get element() { return null; },
    get document() { return null; },
    on() {},
    dispose() {},
});

const CAMERA_CONTROL_SCALAR_KEYS = Object.freeze([
    'autoRotate', 'autoRotateSpeed',
    'dampingFactor', 'enableDamping',
    'enablePan', 'enableRotate', 'enableZoom',
    'keyPanSpeed', 'maxAzimuthAngle', 'maxDistance', 'maxPolarAngle', 'maxTargetRadius', 'maxZoom',
    'minAzimuthAngle', 'minDistance', 'minPolarAngle', 'minTargetRadius', 'minZoom',
    'panSpeed', 'rotateSpeed', 'screenSpacePanning', 'zoomSpeed', 'zoomToCursor',
]);

function captureCameraState(activeCamera) {
    if (!activeCamera) return null;
    return {
        camera: activeCamera,
        matrixAutoUpdate: activeCamera.matrixAutoUpdate,
        position: activeCamera.position?.clone?.() ?? null,
        quaternion: activeCamera.quaternion?.clone?.() ?? null,
        up: activeCamera.up?.clone?.() ?? null,
        zoom: activeCamera.zoom,
        fov: activeCamera.fov,
        near: activeCamera.near,
        far: activeCamera.far,
        aspect: activeCamera.aspect,
        left: activeCamera.left,
        right: activeCamera.right,
        top: activeCamera.top,
        bottom: activeCamera.bottom,
    };
}

function restoreCameraState(state) {
    const activeCamera = state?.camera;
    if (!activeCamera) return;
    if (state.position && activeCamera.position) activeCamera.position.copy(state.position);
    if (state.quaternion && activeCamera.quaternion) activeCamera.quaternion.copy(state.quaternion);
    if (state.up && activeCamera.up) activeCamera.up.copy(state.up);
    for (const key of ['zoom', 'fov', 'near', 'far', 'aspect', 'left', 'right', 'top', 'bottom']) {
        if (state[key] !== undefined && key in activeCamera) activeCamera[key] = state[key];
    }
    activeCamera.matrixAutoUpdate = state.matrixAutoUpdate;
    activeCamera.updateProjectionMatrix?.();
    activeCamera.updateMatrix?.();
    activeCamera.updateMatrixWorld?.(true);
}

function captureViewerControls(controls) {
    if (!controls) return null;
    const scalars = {};
    for (const key of CAMERA_CONTROL_SCALAR_KEYS) {
        if (key in controls) scalars[key] = controls[key];
    }
    return {
        enabled: controls.enabled,
        target: controls.target?.clone?.() ?? null,
        cursor: controls.cursor?.clone?.() ?? null,
        mouseButtons: controls.mouseButtons ? { ...controls.mouseButtons } : null,
        touches: controls.touches ? { ...controls.touches } : null,
        scalars,
    };
}

function restoreViewerControls(controls, state) {
    if (!controls || !state) return;
    for (const [key, value] of Object.entries(state.scalars)) controls[key] = value;
    if (state.target && controls.target) controls.target.copy(state.target);
    if (state.cursor && controls.cursor) controls.cursor.copy(state.cursor);
    if (state.mouseButtons && controls.mouseButtons) Object.assign(controls.mouseButtons, state.mouseButtons);
    if (state.touches && controls.touches) Object.assign(controls.touches, state.touches);
    controls.enabled = state.enabled;
    controls.update?.();
}

function normalizeCameraControlsMode(options = {}) {
    const requested = options.controls;
    if (requested === true || requested === 'viewer' || requested === 'orbit') return 'viewer';
    if (requested === false || requested === 'none' || requested === 'manual') return 'none';
    return options.enableControls === true || options.enableOrbitControls === true ? 'viewer' : 'none';
}

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
    getAnimationSystem = () => null,
    getAudioSystem = () => null,
    debugLog = () => {},
    debugWarn = () => {},
    onRuntimeVisibilityChanged = null,
    onRuntimeSceneChanged = null,
    whenSceneReady = null,
    isSnapshot = false,
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

    if (maxRoot) markOwned(maxRoot, OWNER_MAX);

    // Camera modes:
    // - 'viewport': synced from Max viewport (default, controlled by Max navigation)
    // - 'physical': locked to a Max Physical Camera object in scene
    // - 'script': fully owned by Three.js layer code (game camera)
    let cameraMode = 'viewport';
    let cameraClaimOwner = null; // layer id that claimed camera (for 'script' mode)
    let physicalCameraHandle = null; // handle of locked physical camera (for 'physical' mode)
    let cameraControlsMode = 'none';
    let cameraRestoreFrame = null;

    const cameraControl = {
        getMode() { return cameraMode; },
        setMode(mode, options = {}) {
            if (mode !== 'viewport' && mode !== 'physical' && mode !== 'script') return false;
            const resolvedHandle = Number(options.handle);
            if (mode === 'physical' && (!Number.isFinite(resolvedHandle) || resolvedHandle <= 0)) return false;
            const requestedOwner = options.layerId ?? null;
            if (cameraClaimOwner && requestedOwner !== cameraClaimOwner && options.force !== true) return false;
            if (mode !== 'viewport' && !requestedOwner) return false;
            const prevMode = cameraMode;
            const prevOwner = cameraClaimOwner;
            const prevPhysicalHandle = physicalCameraHandle;
            const prevCameraControlsMode = cameraControlsMode;
            const activeCamera = getCamera ? getCamera() : camera;
            const transactionCameraState = captureCameraState(activeCamera);
            const transactionControlsState = captureViewerControls(controls);
            const enteringOwnedMode = prevMode === 'viewport' && mode !== 'viewport';
            const leavingOwnedMode = prevMode !== 'viewport' && mode === 'viewport';

            if (enteringOwnedMode) {
                cameraRestoreFrame = {
                    camera: transactionCameraState,
                    controls: transactionControlsState,
                };
            }
            cameraMode = mode;

            if (mode === 'viewport') {
                // Release any ownership, sync from Max viewport
                cameraClaimOwner = null;
                physicalCameraHandle = null;
                cameraControlsMode = 'none';
                if (leavingOwnedMode && cameraRestoreFrame) {
                    restoreCameraState(cameraRestoreFrame.camera);
                    restoreViewerControls(controls, cameraRestoreFrame.controls);
                } else if (activeCamera) {
                    activeCamera.matrixAutoUpdate = isSnapshot;
                }
            } else if (mode === 'physical') {
                // Lock to a named scene camera. Live mode asks Max to sync it;
                // snapshots apply the exported static camera record in the
                // onCameraModeChange callback.
                physicalCameraHandle = resolvedHandle;
                cameraClaimOwner = requestedOwner;
                cameraControlsMode = 'none';
                if (activeCamera) activeCamera.matrixAutoUpdate = false;
                if (controls) controls.enabled = false;
            } else if (mode === 'script') {
                // Full JS control
                cameraClaimOwner = requestedOwner;
                physicalCameraHandle = null;
                cameraControlsMode = normalizeCameraControlsMode(options);
                if (activeCamera) activeCamera.matrixAutoUpdate = true;
                if (controls) controls.enabled = cameraControlsMode === 'viewer';
            }
            let accepted = true;
            try {
                const callbackResult = onCameraModeChange?.(mode, {
                    handle: physicalCameraHandle,
                    owner: cameraClaimOwner,
                    controls: cameraControlsMode,
                    enableControls: cameraControlsMode === 'viewer',
                    previousMode: prevMode,
                    previousOwner: prevOwner,
                    restoring: leavingOwnedMode,
                });
                if (callbackResult === false) accepted = false;
            } catch (error) {
                console.error('[LayerManager] camera mode change callback error', error);
                accepted = false;
            }
            if (!accepted) {
                cameraMode = prevMode;
                cameraClaimOwner = prevOwner;
                physicalCameraHandle = prevPhysicalHandle;
                cameraControlsMode = prevCameraControlsMode;
                restoreCameraState(transactionCameraState);
                restoreViewerControls(controls, transactionControlsState);
                if (enteringOwnedMode) cameraRestoreFrame = null;
                return false;
            }
            if (leavingOwnedMode) cameraRestoreFrame = null;
            return true;
        },
        claim(layerId, options = {}) {
            if (cameraMode === 'script' && cameraClaimOwner && cameraClaimOwner !== layerId) return false;
            return this.setMode('script', { ...options, layerId });
        },
        release(layerId) {
            if (cameraMode === 'script' && (!layerId || cameraClaimOwner === layerId)) {
                return this.setMode('viewport', { layerId: layerId ?? cameraClaimOwner });
            }
            if (cameraMode === 'physical' && (!cameraClaimOwner || !layerId || cameraClaimOwner === layerId)) {
                return this.setMode('viewport', { layerId: layerId ?? cameraClaimOwner });
            }
            return false;
        },
        isClaimed() { return cameraMode === 'script' && cameraClaimOwner !== null; },
        isScriptMode() { return cameraMode === 'script'; },
        isViewportMode() { return cameraMode === 'viewport'; },
        isPhysicalMode() { return cameraMode === 'physical'; },
        getOwner() { return cameraClaimOwner; },
        getControlsMode() { return cameraControlsMode; },
        setControlsEnabled(layerId, enabled) {
            if (cameraMode !== 'script' || cameraClaimOwner !== layerId) return false;
            cameraControlsMode = enabled ? 'viewer' : 'none';
            if (controls) controls.enabled = enabled === true;
            return true;
        },
        enforceControls() {
            if (!controls || cameraMode === 'viewport') return false;
            const enabled = cameraMode === 'script' && cameraControlsMode === 'viewer';
            if (controls.enabled === enabled) return false;
            controls.enabled = enabled;
            return true;
        },
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
        setMaterialDecorator,
        clearMaterialDecorator,
        clearMaterialDecoratorsForLayer,
        setObjectPropertyOverride,
        clearObjectPropertyOverride,
        clearObjectPropertyOverridesForLayer,
        applyObjectPropertyOverrides,
        applyAllObjectPropertyOverrides,
        hasObjectPropertyOverride,
        applyAllRuntimeTransformOverrides,
        applyAllRuntimeVisibilityOverrides,
        markRuntimeTransformOverridesDirty,
        serializeRuntimeTransformOverrides,
        restoreRuntimeTransformOverrides,
        createTransformApi,
        clearRuntimeTransformOverridesForLayer,
        setRuntimeVisibilityOverride,
        clearRuntimeVisibilityOverride,
        clearRuntimeVisibilityOverridesForLayer,
        hasRuntimeVisibilityOverride,
    } = createRuntimeOverrideController({
        THREE,
        nodeMap,
        lightHandleMap,
        onRuntimeSceneChanged: (event) => notifyRuntimeSceneChanged(event),
    });
    const morphSystem = createMorphSystem({ nodeMap, lightHandleMap });

    // Max selection diff — re-emitted on the shared bus as 'max:selection'.
    // Scanned only while at least one layer is subscribed; the two Sets are
    // swapped each change so the steady state allocates nothing.
    const selectionState = { current: new Set(), scratch: new Set() };
    function diffSelection() {
        const prev = selectionState.current;
        const next = selectionState.scratch;
        next.clear();
        let grew = false;
        for (const [handle, obj] of nodeMap) {
            if (obj?.userData?.maxjsSelected === true) {
                next.add(handle);
                if (!prev.has(handle)) grew = true;
            }
        }
        if (!grew && next.size === prev.size) return;
        const added = [];
        const removed = [];
        for (const handle of next) if (!prev.has(handle)) added.push(handle);
        for (const handle of prev) if (!next.has(handle)) removed.push(handle);
        selectionState.current = next;
        selectionState.scratch = prev;
        busEmitInternal('max:selection', freezePlainObject({
            selected: Object.freeze([...next]),
            added: Object.freeze(added),
            removed: Object.freeze(removed),
        }));
    }

    // Max timeline transitions, re-emitted on the shared layer bus.
    // 'change' fires continuously during playback (deferred to RAF) but a
    // change while NOT playing is a scrub/jump — that's the seek signal.
    maxTimeline.on('play', snap => busEmitInternal('max:time:play', snap));
    maxTimeline.on('pause', snap => busEmitInternal('max:time:pause', snap));
    maxTimeline.on('change', snap => {
        if (!snap.playing) busEmitInternal('max:time:seek', snap);
    });

    // Max authored-animation playback control (ctx.anim). Thin facade over
    // createMaxJSAnimationSystem — absent system (standalone without
    // animations) degrades to empty list / no-op false.
    const animFacade = freezePlainObject({
        list() {
            const sys = getAnimationSystem?.();
            return sys ? sys.getState().clips : [];
        },
        play(id) { return getAnimationSystem?.()?.setClipPlaying(id, true) === true; },
        pause(id) { return getAnimationSystem?.()?.setClipPlaying(id, false) === true; },
        stop(id) {
            const sys = getAnimationSystem?.();
            if (!sys) return false;
            const paused = sys.setClipPlaying(id, false);
            return sys.setClipTime(id, 0) && paused;
        },
        setTime(id, seconds) { return getAnimationSystem?.()?.setClipTime(id, seconds) === true; },
        setSpeed(id, speed) { return getAnimationSystem?.()?.setClipSpeed(id, speed) === true; },
        setLoop(id, mode) { return getAnimationSystem?.()?.setClipLoop(id, mode) === true; },
        seekAll(seconds) { return getAnimationSystem?.()?.seekAllClips(seconds) === true; },
        isPlaying(id) {
            const sys = getAnimationSystem?.();
            return !!sys && sys.getState().clips.some(clip => clip.id === id && clip.playing);
        },
    });

    function createLayerAnimFacade(layer) {
        const mutate = callback => {
            if (!isLayerCurrent(layer)) {
                warnStaleLayerMutation(layer);
                return false;
            }
            return callback();
        };
        return freezePlainObject({
            list: () => animFacade.list(),
            play: id => mutate(() => animFacade.play(id)),
            pause: id => mutate(() => animFacade.pause(id)),
            stop: id => mutate(() => animFacade.stop(id)),
            setTime: (id, seconds) => mutate(() => animFacade.setTime(id, seconds)),
            setSpeed: (id, speed) => mutate(() => animFacade.setSpeed(id, speed)),
            setLoop: (id, mode) => mutate(() => animFacade.setLoop(id, mode)),
            seekAll: seconds => mutate(() => animFacade.seekAll(seconds)),
            isPlaying: id => animFacade.isPlaying(id),
        });
    }

    // Max audio control + layer-fired one-shots (ctx.audio). One-shots are
    // tracked per layer and silenced on that layer's dispose.
    function createLayerAudioFacade(layer) {
        const activeOneShots = new Set();
        layer.disposers.push(() => {
            for (const shot of [...activeOneShots]) {
                try { shot.stop(); } catch (_) {}
            }
            activeOneShots.clear();
        });
        return freezePlainObject({
            list() { return getAudioSystem?.()?.listEntries?.() ?? []; },
            play(handle) {
                if (!isLayerCurrent(layer)) return false;
                return getAudioSystem?.()?.playEntry?.(handle) === true;
            },
            stop(handle) {
                if (!isLayerCurrent(layer)) return false;
                return getAudioSystem?.()?.stopEntry?.(handle) === true;
            },
            setVolume(handle, volume) {
                if (!isLayerCurrent(layer)) return false;
                return getAudioSystem?.()?.setEntryVolume?.(handle, volume) === true;
            },
            get muted() { return getAudioSystem?.()?.getMuted?.() === true; },
            playOneShot(url, options = {}) {
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return null;
                }
                const shot = getAudioSystem?.()?.playOneShot?.(url, options) ?? null;
                if (!shot) return null;
                for (const old of activeOneShots) {
                    if (!old.active) activeOneShots.delete(old);
                }
                activeOneShots.add(shot);
                return shot;
            },
        });
    }

    // GPU vertex-stage deformation (ctx.deform). Node-graph edits ride the
    // material decorator reapply path so fastsync rebuilds keep them.
    const deformSystem = createDeformSystem({
        THREE,
        renderer,
        nodeMap,
        getTimelineSeconds: () => maxTimeline.now(),
        setMaterialDecorator,
        clearMaterialDecorator,
        debugWarn,
    });
    const spectralMaterialSystem = createSpectralMaterialSystem({
        nodeMap,
        setMaterialDecorator,
        clearMaterialDecorator,
        onChange: event => notifyRuntimeSceneChanged(event),
        debugWarn,
    });

    function emitChange(reason = 'state') {
        for (const listener of listeners) {
            try {
                listener(reason);
            } catch (error) {
                console.error('[LayerManager] listener error', error);
            }
        }
    }

    function notifyRuntimeSceneChanged(event) {
        const payload = event && typeof event === 'object' ? event : { type: 'runtime' };
        if (payload.type === 'visibility' && typeof onRuntimeVisibilityChanged === 'function') {
            try {
                onRuntimeVisibilityChanged(payload);
            } catch (error) {
                console.error('[LayerManager] runtime visibility listener error', error);
            }
        }
        if (typeof onRuntimeSceneChanged !== 'function') return;
        try {
            onRuntimeSceneChanged(payload);
        } catch (error) {
            console.error('[LayerManager] runtime scene listener error', error);
        }
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    const paramController = createLayerParamController({
        THREE,
        emitChange,
        debugWarn,
    });

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
            parameters: paramController.list(layer),
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

    function isLayerCurrent(layer) {
        return !!layer && layers.get(layer.id) === layer;
    }

    function warnStaleLayerMutation(layer) {
        if (!layer || layer.staleWarningEmitted) return;
        layer.staleWarningEmitted = true;
        debugWarn(`[LayerManager] Ignoring work resumed by inactive layer "${layer.id}"`);
    }

    function disposeLateUnownedResource(layer, resource, owner = OWNER_JS) {
        warnStaleLayerMutation(layer);
        if (!resource || isOwnedByMax(resource) || getOwner(resource) != null) return resource;
        markOwned(resource, owner);
        disposeOwnedResource(resource, { force: true });
        return resource;
    }

    function ownForLayer(layer, resource, owner = OWNER_JS) {
        if (!resource) return resource;
        if (!isLayerCurrent(layer)) {
            return disposeLateUnownedResource(layer, resource, owner);
        }
        if (isOwnedByMax(resource)) {
            debugWarn(`[LayerManager] Layer "${layer.id}" cannot own a Max-managed resource`);
            return resource;
        }
        markOwned(resource, owner);
        layer.tracked.add(resource);
        return resource;
    }

    function getOrCreateLayerInput(layer) {
        if (!isLayerCurrent(layer)) {
            warnStaleLayerMutation(layer);
            // Keep an already-built helper: disposeLayerState disposes it right
            // after hooks.dispose, so late unbinds still get swept.
            return layer.input ?? INERT_LAYER_INPUT;
        }
        if (!layer.input) layer.input = createInputHelper(renderer);
        return layer.input;
    }

    function cloneMaterialForLayer(material, owner) {
        if (!material) return material;
        if (Array.isArray(material)) return material.map(item => cloneMaterialForLayer(item, owner));
        const clone = clearOwner(material.clone());
        for (const key of MATERIAL_MAP_KEYS) {
            if (material[key]?.clone) {
                clone[key] = markOwned(clearOwner(material[key].clone()), owner);
            }
        }
        return markOwned(clone, owner);
    }

    function cloneMaxNode(handle, options = {}) {
        const source = nodeMap.get(handle);
        if (!source?.isObject3D) return null;
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        if (source.geometry) markOwned(source.geometry, OWNER_MAX);
        if (source.material) markOwned(source.material, OWNER_MAX);
        const clone = clearOwner(source.clone(false));
        clone.userData ??= {};
        delete clone.userData.maxjsHandle;
        clone.name = options.name || `${source.name || 'node'}_clone`;
        clone.matrixAutoUpdate = true;
        source.updateWorldMatrix?.(true, false);
        source.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
        clone.matrix.compose(clone.position, clone.quaternion, clone.scale);
        clone.matrixWorld.copy(source.matrixWorld);
        clone.matrixWorldNeedsUpdate = true;
        clone.visible = true;
        clone.userData.maxjsRuntimeClone = true;
        clone.userData.maxjsSourceHandle = handle;
        if (source.geometry?.clone) {
            clone.geometry = markOwned(clearOwner(source.geometry.clone()), owner);
        }
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
        if (!isLayerCurrent(layer)) {
            warnStaleLayerMutation(layer);
            return null;
        }
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
        if (!isLayerCurrent(layer)) {
            warnStaleLayerMutation(layer);
            return layer.nodeAdapters.get(handle) ?? null;
        }
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
                isActive: () => isLayerCurrent(layer),
                getTransformApi: (nextHandle, getObject, layerId) => createTransformApi(
                    nextHandle,
                    getObject,
                    layerId,
                    () => isLayerCurrent(layer),
                ),
                setMaterialMap: (h, slot, tex) => (
                    isLayerCurrent(layer)
                    && setMaterialMapOverride(layer.id, h, slot, tex)
                ),
                setPropertyOverride: (h, property, value, options) => (
                    isLayerCurrent(layer)
                    && setObjectPropertyOverride(layer.id, h, property, value, options)
                ),
                clearPropertyOverride: (h, property, options) => (
                    isLayerCurrent(layer)
                    && clearObjectPropertyOverride(layer.id, h, property, options)
                ),
                hasPropertyOverride: (h, property) => (
                    isLayerCurrent(layer)
                    && hasObjectPropertyOverride(h, property)
                ),
                getNodeAdapter: (nextHandle) => getLayerNodeAdapter(layer, nextHandle),
                cloneFromMax: (source, options) => layer.cloneFromMax?.(source, options) ?? null,
                setVisibilityOverride: (h, visible, obj) => {
                    if (!isLayerCurrent(layer)) return false;
                    const changed = setRuntimeVisibilityOverride(layer.id, h, visible, obj);
                    if (changed) notifyRuntimeSceneChanged({ type: 'visibility', layerId: layer.id, handle: h, visible: visible !== false });
                    return changed;
                },
                clearVisibilityOverride: (h, obj) => {
                    if (!isLayerCurrent(layer)) return false;
                    const changed = clearRuntimeVisibilityOverride(h, obj);
                    if (changed) notifyRuntimeSceneChanged({ type: 'visibility', layerId: layer.id, handle: h, reset: true });
                    return changed;
                },
            });
            layer.nodeAdapters.set(handle, adapter);
        }
        return adapter;
    }

    function buildContext(layer) {
        const rendererFacade = createRendererFacade(
            renderer,
            THREE,
            scene,
            () => isLayerCurrent(layer),
            (dispose) => layer.disposers.push(dispose),
        );
        const instancesFacade = createInstancesFacade({
            THREE,
            getRoot: () => maxRoot ?? scene,
            isActive: () => isLayerCurrent(layer),
        });
        const cameraFacade = createCameraAdapter(
            camera,
            THREE,
            (resource, owner) => ownForLayer(layer, resource, owner),
            cameraControl,
            layer.id,
            debugWarn,
            () => isLayerCurrent(layer),
        );
        const nodeMapFacade = createNodeMapFacade(nodeMap, handle => getLayerNodeAdapter(layer, handle));
        const maxSceneFacade = createMaxSceneFacade({
            scene,
            nodeMap,
            lightHandleMap,
            getAdapter: (handle, explicitObj) => getLayerNodeAdapter(layer, handle, explicitObj),
            createAnchor: (handle, options = {}) => createAnchorForLayer(layer, handle, options),
            THREE,
        });
        const rigFacade = createRigFacade({
            THREE,
            nodeMap,
            maxScene: maxSceneFacade,
            getAdapter: (handle, explicitObj) => getLayerNodeAdapter(layer, handle, explicitObj),
            isActive: () => isLayerCurrent(layer),
        });
        layer.disposers.push(() => rigFacade.disposeAll());

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
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return () => {};
                }
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
            isSnapshot: isSnapshot === true,
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
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return false;
                }
                if (!projectControl?.setProjectDirectory) {
                    throw new Error('Project runtime is not bound');
                }
                return projectControl.setProjectDirectory(dir, options);
            },
            reload(force = true) {
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return false;
                }
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
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return null;
                }
                return createWebappLayer(ctxRef.current, THREE, spec);
            },
        });

        const busFacade = freezePlainObject({
            on(event, handler) {
                if (typeof event !== 'string' || !event) throw new TypeError('bus.on: event must be a non-empty string');
                if (typeof handler !== 'function') throw new TypeError('bus.on: handler must be a function');
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return () => {};
                }
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
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return false;
                }
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
            emit(event, payload) {
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return;
                }
                busEmitInternal(event, payload);
            },
        });

        const servicesFacade = freezePlainObject({
            provide(name, value) {
                if (typeof name !== 'string' || !name) throw new TypeError('services.provide: name must be a non-empty string');
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return null;
                }
                const existing = serviceRegistry.get(name);
                if (existing) {
                    throw new Error(`Service "${name}" already provided by layer "${existing.layerId}" (layer "${layer.id}" conflict)`);
                }
                const record = { value, layerId: layer.id };
                serviceRegistry.set(name, record);
                serviceFireWaiters(name, value);
                const dispose = () => {
                    const cur = serviceRegistry.get(name);
                    if (cur === record) serviceRegistry.delete(name);
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
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return () => {};
                }
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
            if (!isLayerCurrent(layer)) {
                warnStaleLayerMutation(layer);
                return null;
            }
            const adapter = resolveNodeAdapter(source, options);
            if (!adapter?.isMesh) return null;
            const clone = cloneMaxNode(adapter.handle, options);
            if (!clone) return null;
            if (options.snapshotId) setSnapshotTargetId(clone, `runtime:${layer.id}:${options.snapshotId}`);
            const parent = options.overlay ? layer.overlayGroup : layer.group;
            const targetParent = options.parent?.isObject3D ? options.parent : parent;
            placeRuntimeClone(clone, adapter, targetParent, options);
            if (clone.userData?.maxjsFollowSourceMaterial) {
                layer.liveMaterialClones.set(clone, clone.material);
            }
            notifyRuntimeSceneChanged({ type: 'jsScene', layerId: layer.id, action: 'cloneFromMax' });
            return clone;
        };
        layer.cloneFromMax = cloneFromMaxForLayer;

        const jsFacade = freezePlainObject({
            root: layer.group,
            overlayRoot: layer.overlayGroup,
            own(resource, options = {}) {
                return ownForLayer(layer, resource, options.overlay ? OWNER_OVERLAY : OWNER_JS);
            },
            add(resource, options = {}) {
                if (!resource?.isObject3D) return null;
                if (!isLayerCurrent(layer)) {
                    disposeLateUnownedResource(
                        layer,
                        resource,
                        options.overlay ? OWNER_OVERLAY : OWNER_JS,
                    );
                    return null;
                }
                if (isOwnedByMax(resource)) {
                    debugWarn(`[LayerManager] Layer "${layer.id}" cannot add a Max-managed object`);
                    return null;
                }
                const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
                const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
                markOwned(resource, owner);
                if (options.snapshotId) setSnapshotTargetId(resource, `runtime:${layer.id}:${options.snapshotId}`);
                parent.add(resource);
                notifyRuntimeSceneChanged({ type: 'jsScene', layerId: layer.id, action: 'add' });
                return resource;
            },
            remove(resource) {
                if (!resource?.isObject3D) return false;
                if (!isLayerCurrent(layer)) {
                    disposeLateUnownedResource(layer, resource);
                    return false;
                }
                if (isOwnedByMax(resource)) {
                    layer.tracked.delete(resource);
                    debugWarn(`[LayerManager] Layer "${layer.id}" cannot remove a Max-managed object`);
                    return false;
                }
                const owned = isOwnedByJs(resource)
                    || layer.tracked.has(resource)
                    || isDescendantOf(resource, layer.group)
                    || isDescendantOf(resource, layer.overlayGroup);
                layer.tracked.delete(resource);
                resource.parent?.remove(resource);
                if (owned) {
                    disposeOwnedResource(resource, { force: true });
                } else {
                    debugWarn(`[LayerManager] Layer "${layer.id}" detached a foreign object without disposing it`);
                }
                notifyRuntimeSceneChanged({ type: 'jsScene', layerId: layer.id, action: 'remove' });
                // remove() reports DETACHMENT, dispose() reports FREEING — the
                // differing return contracts are intentional, not an oversight.
                // A foreign object is genuinely detached here (and warned about),
                // so true is honest; only its resources are left alone.
                return true;
            },
            createGroup(name = '', options = {}) {
                const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return null;
                }
                const group = markOwned(new THREE.Group(), owner);
                if (name) group.name = name;
                if (options.snapshotId) setSnapshotTargetId(group, `runtime:${layer.id}:${options.snapshotId}`);
                const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
                parent.add(group);
                notifyRuntimeSceneChanged({ type: 'jsScene', layerId: layer.id, action: 'createGroup' });
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
                if (!isLayerCurrent(layer)) {
                    return disposeLateUnownedResource(
                        layer,
                        resource,
                        options.overlay ? OWNER_OVERLAY : OWNER_JS,
                    );
                }
                if (isOwnedByMax(resource)) {
                    debugWarn(`[LayerManager] Layer "${layer.id}" cannot track a Max-managed resource`);
                    return resource;
                }
                markOwned(resource, options.overlay ? OWNER_OVERLAY : OWNER_JS);
                if (options.snapshotId) setSnapshotTargetId(resource, `runtime:${layer.id}:${options.snapshotId}`);
                layer.tracked.add(resource);
                return resource;
            },
            setSnapshotId(resource, id) {
                if (!resource?.isObject3D || !id) return resource;
                if (!isLayerCurrent(layer)) {
                    warnStaleLayerMutation(layer);
                    return resource;
                }
                return setSnapshotTargetId(resource, `runtime:${layer.id}:${id}`);
            },
            dispose(resource) {
                if (!resource) return false;
                if (!isLayerCurrent(layer)) {
                    disposeLateUnownedResource(layer, resource);
                    return false;
                }
                if (isOwnedByMax(resource)) {
                    layer.tracked.delete(resource);
                    debugWarn(`[LayerManager] Layer "${layer.id}" cannot dispose a Max-managed resource`);
                    return false;
                }
                // Detach Object3D resources from the scene graph before freeing them.
                // Without this, dispose() frees geometry/material but leaves the object
                // parented — it lingers as a dead, un-rendered-but-present husk (and any
                // layer still toggling its ancestor's visibility brings it back "stuck").
                const wasObject3D = resource?.isObject3D === true;
                const owned = isOwnedByJs(resource)
                    || layer.tracked.has(resource)
                    || (wasObject3D && (
                        isDescendantOf(resource, layer.group)
                        || isDescendantOf(resource, layer.overlayGroup)
                    ));
                layer.tracked.delete(resource);
                if (wasObject3D) resource.parent?.remove(resource);
                if (owned) {
                    disposeOwnedResource(resource, { force: true });
                } else {
                    debugWarn(`[LayerManager] Layer "${layer.id}" detached a foreign resource without disposing it`);
                }
                if (wasObject3D) notifyRuntimeSceneChanged({ type: 'jsScene', layerId: layer.id, action: 'dispose' });
                return owned;
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
            rig: rigFacade,
            camera: cameraFacade,
            renderer: rendererFacade,
            instances: instancesFacade,
            params: paramController.createFacade(layer),
            deform: deformSystem.createLayerFacade(
                layer.id,
                handle => getLayerNodeAdapter(layer, handle),
                () => isLayerCurrent(layer),
            ),
            spectral: spectralMaterialSystem.createLayerFacade(
                layer.id,
                handle => getLayerNodeAdapter(layer, handle),
                () => isLayerCurrent(layer),
            ),
            morph: morphSystem.createLayerFacade(
                layer.id,
                () => isLayerCurrent(layer),
            ),
            anim: createLayerAnimFacade(layer),
            audio: createLayerAudioFacade(layer),
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
                        visible: source.userData?.maxjsVisible !== false && source.visible !== false,
                        matrixWorld: source.matrixWorld,
                    };
                }
                syncCache.set(handle, sourceState);
            }

            if (!sourceState) {
                if (anchor.userData.maxjsFollowVisibility) anchor.visible = false;
                continue;
            }
            if (anchor.userData.maxjsFollowVisibility) anchor.visible = sourceState.visible;
            if (anchor.userData.maxjsCopyWorldMatrix) {
                anchor.matrix.copy(sourceState.matrixWorld);
                anchor.matrixWorldNeedsUpdate = true;
            }
        }
    }

    function syncLiveMaterialClones(layer) {
        for (const [clone, lastFollowedMaterial] of [...layer.liveMaterialClones]) {
            if (!clone?.isObject3D || !clone.parent) {
                layer.liveMaterialClones.delete(clone);
                continue;
            }
            if (!clone.userData?.maxjsFollowSourceMaterial) {
                layer.liveMaterialClones.delete(clone);
                continue;
            }

            if (clone.material !== lastFollowedMaterial) {
                delete clone.userData.maxjsFollowSourceMaterial;
                layer.liveMaterialClones.delete(clone);
                continue;
            }

            const handle = clone.userData.maxjsSourceHandle;
            const source = Number.isFinite(handle) ? nodeMap.get(handle) : null;
            if (!source?.isObject3D) {
                clone.visible = false;
                continue;
            }

            if (lastFollowedMaterial !== source.material) {
                markOwned(source.material, OWNER_MAX);
                clone.material = source.material;
                layer.liveMaterialClones.set(clone, source.material);
            }
        }
    }

    function createLayerState(id, options = {}) {
        if (layers.has(id)) remove(id);

        const group = markOwned(new THREE.Group(), OWNER_JS);
        group.name = `__inline_${id}__`;
        group.matrixAutoUpdate = false;
        group.matrix.identity();
        group.userData.maxjsLayerId = id;
        setSnapshotTargetId(group, `runtime:${id}:root`);

        const overlayGroup = markOwned(new THREE.Group(), OWNER_OVERLAY);
        overlayGroup.name = `__inline_overlay_${id}__`;
        overlayGroup.matrixAutoUpdate = false;
        overlayGroup.matrix.identity();
        overlayGroup.userData.maxjsLayerId = id;
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
            hooksDisposed: false,
            active: true,
            loading: false,
            error: null,
            errorCount: 0,
            tracked: new Set(),
            anchors: [],
            liveMaterialClones: new Map(),
            nodeAdapters: new Map(),
            disposers: [],
            input: null,
            cloneFromMax: null,
            profile: {
                mountMs: 0,
                lastUpdateMs: 0,
                avgUpdateMs: 0,
                maxUpdateMs: 0,
                updateCount: 0,
            },
            ctx: null,
        };
        paramController.initLayer(layer, options, {
            isActive: () => isLayerCurrent(layer),
        });

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
            const sceneReady = typeof whenSceneReady === 'function'
                ? whenSceneReady()
                : whenSceneReady;
            if (sceneReady) await sceneReady;
            if (layers.get(id) !== layer || layer.mountToken !== mountToken) {
                disposeLayerState(layer, { cleanupGlobals: false });
                return { id, error: 'Layer replaced during load' };
            }
            // Initial scene sync may populate maxRoot after the manager itself
            // was constructed. Stamp the authoritative tree immediately before
            // user hooks receive raw objects/materials through the adapters.
            if (maxRoot) markOwned(maxRoot, OWNER_MAX);
            const hooks = await createHooks(layer.ctx, THREE);
            layer.hooks = hooks || {};
            layer.hooksDisposed = false;
            if (layers.get(id) !== layer || layer.mountToken !== mountToken) {
                disposeLayerState(layer, { cleanupGlobals: false });
                return { id, error: 'Layer replaced during load' };
            }
            const hookParams = layer.hooks.parameters ?? layer.hooks.params;
            if (hookParams && typeof hookParams === 'object') {
                paramController.define(layer, hookParams, undefined, { source: 'hooks', silent: true });
            }
            if (typeof layer.hooks.init === 'function') {
                await layer.hooks.init(layer.ctx);
            }
        } catch (err) {
            if (layers.get(id) === layer && layer.mountToken === mountToken) {
                layer.error = err?.message || String(err);
                layer.active = false;
                console.error(`[LayerManager] Layer "${id}" init error:`, err);
            }
        } finally {
            if (layers.get(id) === layer) layer.loading = false;
        }
        if (layers.get(id) !== layer || layer.mountToken !== mountToken) {
            disposeLayerState(layer, { cleanupGlobals: false });
            return { id, error: 'Layer replaced during load' };
        }
        layer.profile.mountMs = performance.now() - mountStart;
        lastMountMs = layer.profile.mountMs;
        emitChange('mounted');
        return { id, error: layer.error };
    }

    // cleanupGlobals:false is for the replaced-during-load path ONLY, and it is
    // load-bearing — do not "fix" it. The deform/spectral/override registries
    // are keyed by layer ID STRING, not by layer object. A stale layer whose
    // mount lost the race shares its id with the live replacement, so clearing
    // those registries here would wipe the NEW layer's state. The cost is
    // accepted: global registrations made by a layer that was replaced mid-init
    // survive until the live layer with that id is itself removed. Everything
    // owned per-object (tracked resources, groups, disposers, hooks) is always
    // swept, whichever path we are on.
    function disposeLayerState(layer, { cleanupGlobals = true } = {}) {
        if (!layer) return;
        layer.mountToken = null;
        if (!layer.hooksDisposed && layer.hooks && typeof layer.hooks.dispose === 'function') {
            try {
                layer.hooks.dispose(layer.ctx);
            } catch (err) {
                debugWarn(`[LayerManager] Layer "${layer.id}" dispose error:`, err);
            }
        }
        layer.hooksDisposed = true;

        // Auto-unsubscribe bus handlers, service provisions, and onProvide waiters
        // registered through ctx.bus / ctx.services. Runs after hooks.dispose so layer
        // code sees a live bus during its own teardown, then we sweep ghost handlers.
        if (layer.disposers?.length) {
            for (const fn of layer.disposers) {
                try { fn(); } catch (err) { debugWarn(`[LayerManager] Layer "${layer.id}" disposer error:`, err); }
            }
            layer.disposers.length = 0;
        }

        if (cleanupGlobals) {
            // Restore live Max state before freeing layer-owned resources.
            clearMaterialOverridesForLayer(layer.id);
            clearObjectPropertyOverridesForLayer(layer.id);
            morphSystem.clearLayer(layer.id);
        }

        const disposedResources = new Set();
        for (const resource of layer.tracked) {
            try {
                if (isOwnedByMax(resource)) continue;
                if (resource?.isObject3D) resource.parent?.remove(resource);
                disposeOwnedResource(resource, { seen: disposedResources, force: true });
            } catch (err) {
                debugWarn(`[LayerManager] Layer "${layer.id}" tracked dispose error:`, err);
            }
        }
        layer.tracked.clear();
        layer.liveMaterialClones.clear();
        layer.anchors.length = 0;
        layer.nodeAdapters.clear();
        if (layer.input) { layer.input.dispose(); layer.input = null; }
        if (cleanupGlobals) {
            deformSystem.disposeLayer(layer.id);
            spectralMaterialSystem.disposeLayer(layer.id);
            clearRuntimeTransformOverridesForLayer(layer.id);
            clearRuntimeVisibilityOverridesForLayer(layer.id);
            clearMaterialDecoratorsForLayer(layer.id);
        }

        jsWorldRoot.remove(layer.group);
        overlayWorldRoot.remove(layer.overlayGroup);
        disposeOwnedResource(layer.group, { seen: disposedResources, force: true });
        disposeOwnedResource(layer.overlayGroup, { seen: disposedResources, force: true });

        // Safety: release camera if this layer had claimed it. Older layers could
        // also leave physical camera mode ownerless, so clear that on removal too.
        if (
            cleanupGlobals
            && (
                cameraControl.getOwner() === layer.id
                || (cameraControl.isPhysicalMode() && cameraControl.getOwner() == null)
            )
        ) {
            cameraControl.release(layer.id);
        }
        layer.active = false;
        layer.loading = false;
    }

    function remove(id, options = {}) {
        const layer = layers.get(id);
        if (!layer) return false;
        paramController.remember(layer);
        disposeLayerState(layer);

        if (layers.get(id) === layer) layers.delete(id);
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
        applyAllRuntimeVisibilityOverrides();
        applyAllObjectPropertyOverrides();
        deformSystem.update(dt, elapsed);
        spectralMaterialSystem.update(dt, elapsed);
        if (busHandlers.get('max:selection')?.size) diffSelection();

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
    function beforeRender(frameElapsed) {
        applyAllObjectPropertyOverrides();
        morphSystem.applyAll();
        dispatchRenderHook('onBeforeRender', frameElapsed);
        applyAllObjectPropertyOverrides();
        morphSystem.applyAll();
    }
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

    /** Meshes driven by three.js Deform (jsmod); snapshot embeds JS clones under jsRoot — hide those Max copies when jsRoot is present.
     *  Meshes deformed in place by ctx.deform have no clone and must stay visible. */
    function collectJsmodMaxSyncHandles() {
        if (!maxRoot) return [];
        const out = [];
        for (const [handle, obj] of nodeMap.entries()) {
            if (!obj?.isObject3D) continue;
            if (!isDescendantOf(obj, maxRoot)) continue;
            const drawable = obj.isMesh || obj.isLine || obj.isLineSegments;
            if (!drawable) continue;
            if (obj.userData?.jsmod && !deformSystem.drives(handle)) out.push(handle);
        }
        return out;
    }

    /**
     * Snapshot everything under a runtime world root (all layer groups + any future direct children),
     * plus tracked Object3Ds that are not already in that subtree (e.g. ctx.track only).
     */
    function buildRuntimeSubtreeJson(worldRoot, snapshotName, trackedOwnerFilter, includeLayer) {
        const snapshot = new THREE.Group();
        snapshot.name = snapshotName;

        if (worldRoot?.isObject3D) {
            for (const child of worldRoot.children) {
                if (!child?.isObject3D) continue;
                if (child.userData?.maxjsExcludeFromRuntimeSnapshot) continue;
                const layerId = child.userData?.maxjsLayerId;
                if (layerId && includeLayer && !includeLayer(layerId)) continue;
                snapshot.add(child.clone(true));
            }
        }

        if (trackedOwnerFilter != null) {
            for (const layer of layers.values()) {
                if (includeLayer && !includeLayer(layer.id)) continue;
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

    function serializeSnapshot(options = {}) {
        const includeDisabledLayers = options.includeDisabledLayers === true;
        const includeLayer = includeDisabledLayers
            ? null
            : (id) => layers.get(id)?.active !== false;
        const serializedLayers = [...layers.values()]
            .filter(layer => includeDisabledLayers || layer.active !== false);
        const jsRoot = buildRuntimeSubtreeJson(jsWorldRoot, '__maxjs_snapshot_js_root__', OWNER_JS, includeLayer);
        const overlayRoot = buildRuntimeSubtreeJson(overlayWorldRoot, '__maxjs_snapshot_overlay_root__', OWNER_OVERLAY, includeLayer);
        const payload = {
            version: 1,
            layers: serializedLayers.map(layer => ({
                id: layer.id,
                name: layer.name,
                source: layer.source,
                entry: layer.entry || '',
                folder: layer.folder || '',
                priority: Number.isFinite(layer.priority) ? layer.priority : 100,
                active: layer.active,
                error: layer.error,
                parameters: paramController.list(layer),
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
            parameters: paramController.list(layer),
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
        setParameter(id, name, value, options = {}) {
            return paramController.setLayerParameter(layers, id, name, value, options);
        },
        setParam(id, name, value, options = {}) {
            return paramController.setLayerParameter(layers, id, name, value, options);
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
        // Raster NV band swap for ctx.spectral tags (see layer_spectral.js) —
        // render loop drives this from the white-phosphor sensing state.
        setSpectralRasterSensing: (on) => spectralMaterialSystem.setRasterSensing(on),
        getLayerCode,
        serializeSnapshot,
        restoreTransformOverrides: restoreRuntimeTransformOverrides,
        markRuntimeTransformsDirty: markRuntimeTransformOverridesDirty,
        // Called from the scene message handler after each material assignment
        // so layer-registered map slot overrides and node-graph decorators
        // (ctx.deform) survive fastsync rebuilds.
        applyMaterialOverrides: applyMaterialOverridesToMesh,
        applyMorphOverrides: morphSystem.applyHandle,
        // Bridge visibility consults this so Max hide/unhide flows to jsmod
        // meshes unless a layer explicitly owns their visibility.
        hasRuntimeVisibilityOverride,
        applyObjectPropertyOverrides,
        hasObjectPropertyOverride,
        serialize,
        get isCameraOverridden() { return cameraControl.isScriptMode(); },
        get cameraMode() { return cameraControl.getMode(); },
        get cameraOwner() { return cameraControl.getOwner(); },
        get cameraControlsMode() { return cameraControl.getControlsMode(); },
        enforceCameraControls() { return cameraControl.enforceControls(); },
        roots: freezePlainObject({
            maxRoot,
            jsRoot: jsWorldRoot,
            overlayRoot: overlayWorldRoot,
        }),
    };
}
