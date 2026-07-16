// studio_lighting.js - shared Studio render-mode lighting state.
//
// Live mode owns the editing UI in index.html. This module owns the portable
// pieces needed by exported snapshots: MaxLightsNode renderer wiring, per-mesh
// light masks, per-material environment intensity, reflection paint, and
// camera-relative constraints.

import * as THREE from 'three';

import {
    clearUnownedLightLinkMaterialObserver,
    getReflectionPaintNode,
    installMaxLightsRenderer,
    setLightLinkMaterialObserver,
    setLightLinkMaskDefaults,
} from './max_lights_node.js';
import {
    createLightLinkMaskApplier,
    deserializeLightLinks,
    getByHandle,
    handleToken,
    hasActiveLightLinksPayload,
} from './light_linking_core.js';

const constraintCameraQuat = new THREE.Quaternion();
const constraintInverseQuat = new THREE.Quaternion();
const constraintWorldPos = new THREE.Vector3();

export function installStudioLightingRenderer(renderer, options = {}) {
    return installMaxLightsRenderer(renderer, options);
}

export function studioStateNeedsMaxLightsNode(studioState) {
    if (!studioState || typeof studioState !== 'object') return false;
    if (hasActiveLightLinksPayload(studioState.lightLinking)) return true;
    return Array.isArray(studioState.reflectionPaint?.lights)
        && studioState.reflectionPaint.lights.length > 0;
}

function vectorFromPlain(value) {
    if (value?.isVector3) return value.clone();
    if (Array.isArray(value) && value.length >= 3) {
        return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
    }
    if (value && typeof value === 'object') {
        return new THREE.Vector3(Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0);
    }
    return null;
}

function vectorFromArray(value) {
    return Array.isArray(value) && value.length >= 3 ? vectorFromPlain(value) : null;
}

function materialNameOf(material) {
    const value = String(
        material?.userData?.maxjsSourceMaterialName ??
        material?.name ??
        ''
    ).trim();
    return value || 'default';
}

export function createStudioLightingController({
    renderer,
    scene,
    camera,
    nodeMap,
    lightHandleMap,
    getRenderableMeshes = null,
    onSceneChanged = null,
    onOutputChanged = null,
} = {}) {
    if (!renderer) throw new Error('createStudioLightingController: renderer required');
    if (!scene) throw new Error('createStudioLightingController: scene required');
    if (!camera) throw new Error('createStudioLightingController: camera required');
    if (!nodeMap) throw new Error('createStudioLightingController: nodeMap required');
    if (!lightHandleMap) throw new Error('createStudioLightingController: lightHandleMap required');

    const links = new Map();
    const envIntensityByName = new Map();
    const envBaseIntensityByMaterial = new WeakMap();
    const reflectionPaintCameraDirections = new Map();
    const lightCameraConstraints = new Map();
    const materialObserverOwner = {};
    const observedMaterials = new Set();
    let observerSweepSet = null;

    let hdriConstrainToCamera = false;
    let hdriBaseRotationY = 0;
    let reflectionPaintConstrainToCamera = false;

    function forEachRenderableMesh(fn) {
        const seen = new WeakSet();
        for (const [h, mesh] of nodeMap) {
            if (!mesh?.isMesh) continue;
            seen.add(mesh);
            fn(handleToken(h), mesh);
        }
        scene.traverse?.((mesh) => {
            if (!mesh?.isMesh || seen.has(mesh)) return;
            seen.add(mesh);
            const handle = mesh.userData?.maxjsHandle
                ?? mesh.userData?.maxjsSourceHandle
                ?? mesh.userData?.maxjsSource
                ?? '';
            fn(handleToken(handle), mesh);
        });
        if (typeof getRenderableMeshes === 'function') {
            for (const entry of getRenderableMeshes() ?? []) {
                const mesh = entry?.mesh?.isMesh ? entry.mesh : (entry?.isMesh ? entry : null);
                if (!mesh || seen.has(mesh)) continue;
                seen.add(mesh);
                const handle = entry?.handle ?? entry?.sourceHandle ?? mesh.userData?.maxjsHandle ?? mesh.userData?.maxjsSource ?? '';
                fn(handleToken(handle), mesh);
            }
        }
    }

    function prepareMaterialObserver(material) {
        const materials = Array.isArray(material) ? material : [material];
        for (const entry of materials) {
            if (!entry) continue;
            observerSweepSet?.add(entry);
            if (observedMaterials.has(entry)) continue;
            observedMaterials.add(entry);
            setLightLinkMaterialObserver(entry, true, materialObserverOwner);
        }
    }

    function releaseMaterialObservers() {
        for (const material of observedMaterials) {
            setLightLinkMaterialObserver(material, false, materialObserverOwner);
        }
        observedMaterials.clear();
    }

    function sweepMaterialObservers(currentMaterials) {
        for (const material of [...observedMaterials]) {
            if (currentMaterials.has(material)) continue;
            setLightLinkMaterialObserver(material, false, materialObserverOwner);
            observedMaterials.delete(material);
        }
    }

    const maskApplier = createLightLinkMaskApplier({
        lightHandleMap,
        forEachRenderableMesh,
        onPrepareMesh: (mesh) => prepareMaterialObserver(mesh.material),
        onOverflow: (overflowCount, activeCount) => {
            console.warn(
                `[max.js snapshot] ${activeCount} linked lights active; ${overflowCount} use the per-light fallback beyond the 64-light batched mask.`,
            );
        },
    });
    let specializedLightingActive = false;

    function lightHandleByName(name) {
        for (const [h, light] of lightHandleMap) {
            if (light?.name === name) return handleToken(h);
        }
        return null;
    }

    function forEachMaterialByName(materialName, fn) {
        const seen = new Set();
        forEachRenderableMesh((_h, mesh) => {
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const mat of materials) {
                if (!mat || seen.has(mat)) continue;
                seen.add(mat);
                if (materialNameOf(mat) === materialName) fn(mat, mesh);
            }
        });
    }

    function applyEnvIntensities() {
        if (envIntensityByName.size === 0) return;
        for (const [materialName, value] of envIntensityByName) {
            forEachMaterialByName(materialName, (mat) => {
                if (!envBaseIntensityByMaterial.has(mat)) {
                    envBaseIntensityByMaterial.set(
                        mat,
                        Number.isFinite(mat.envMapIntensity) ? mat.envMapIntensity : 1.0,
                    );
                }
                mat.envMapIntensity = value;
            });
        }
    }

    function clearEnvIntensityOverrides() {
        for (const [materialName] of envIntensityByName) {
            forEachMaterialByName(materialName, (mat) => {
                const base = envBaseIntensityByMaterial.get(mat);
                if (Number.isFinite(base)) mat.envMapIntensity = base;
                envBaseIntensityByMaterial.delete(mat);
            });
        }
        envIntensityByName.clear();
    }

    function reapply() {
        observerSweepSet = new Set();
        const maskState = maskApplier.apply(links);
        const currentObserverMaterials = observerSweepSet;
        observerSweepSet = null;
        if (maskState.activeCount === 0 && specializedLightingActive) {
            releaseMaterialObservers();
            forEachRenderableMesh((_handle, mesh) => {
                clearUnownedLightLinkMaterialObserver(mesh.material);
            });
        } else if (maskState.activeCount > 0) {
            sweepMaterialObservers(currentObserverMaterials);
        }
        specializedLightingActive = maskState.activeCount > 0;
        setLightLinkMaskDefaults(
            renderer,
            maskState.defaultLo,
            maskState.defaultHi,
            maskState.generation,
        );
        applyEnvIntensities();
        return maskState;
    }

    function getCameraYaw() {
        camera.updateMatrixWorld(true);
        return Math.atan2(camera.matrixWorld.elements[8], camera.matrixWorld.elements[10]);
    }

    function getCameraWorldQuaternion(target = new THREE.Quaternion()) {
        camera.updateMatrixWorld(true);
        return camera.getWorldQuaternion(target);
    }

    function captureReflectionPaintCameraDirections(saved = null) {
        reflectionPaintCameraDirections.clear();
        const savedById = new Map();
        for (const item of (Array.isArray(saved) ? saved : [])) {
            const id = Number(item?.id);
            const direction = vectorFromPlain(item?.cameraDirection ?? item?.direction);
            if (Number.isFinite(id) && direction) savedById.set(id, direction.normalize());
        }
        getCameraWorldQuaternion(constraintCameraQuat);
        constraintInverseQuat.copy(constraintCameraQuat).invert();
        for (const l of getReflectionPaintNode().getLights()) {
            const id = Number(l.id);
            const savedDir = savedById.get(id);
            if (savedDir) {
                reflectionPaintCameraDirections.set(id, savedDir);
                continue;
            }
            const worldDir = vectorFromPlain(l.direction);
            if (!worldDir) continue;
            reflectionPaintCameraDirections.set(
                id,
                worldDir.normalize().applyQuaternion(constraintInverseQuat).normalize(),
            );
        }
    }

    function toCameraLocalOffset(worldPosition) {
        camera.updateMatrixWorld(true);
        return camera.worldToLocal(worldPosition.clone());
    }

    function applyWorldPosition(object, worldPosition) {
        if (!object || !worldPosition) return;
        if (object.parent) {
            object.parent.updateMatrixWorld(true);
            object.position.copy(object.parent.worldToLocal(worldPosition.clone()));
        } else {
            object.position.copy(worldPosition);
        }
        object.updateMatrixWorld(true);
    }

    function buildCameraConstraintForLight(lightHandle, saved = null) {
        const light = getByHandle(lightHandleMap, lightHandle);
        if (!light) return null;
        light.updateMatrixWorld(true);
        const posOffset = vectorFromArray(saved?.posOffset)
            || toCameraLocalOffset(light.getWorldPosition(new THREE.Vector3()));
        let targetOffset = vectorFromArray(saved?.targetOffset ?? saved?.dirOffset);
        const target = light.userData?.maxjsTarget || light.target;
        if (!targetOffset && target) {
            target.updateMatrixWorld(true);
            targetOffset = toCameraLocalOffset(target.getWorldPosition(new THREE.Vector3()));
        }
        return { posOffset, targetOffset };
    }

    function applyReflectionPaintState(payload) {
        const paint = getReflectionPaintNode();
        const wasActive = paint.active;
        paint.clearLights();
        paint.setGlobalIntensity(Number.isFinite(Number(payload?.intensity)) ? Number(payload.intensity) : 1.0);
        for (const item of (Array.isArray(payload?.lights) ? payload.lights : [])) {
            paint.addLight({
                id: item.id,
                direction: vectorFromPlain(item.direction),
                lat: item.lat,
                lon: item.lon,
                color: item.color,
                colorOuter: item.colorOuter,
                intensity: item.intensity,
                radiusX: item.radiusX,
                radiusY: item.radiusY,
                edge: item.edge,
                rotation: item.rotation,
                shape: item.shape,
            });
        }
        if (wasActive !== paint.active) onSceneChanged?.();
        onOutputChanged?.();
    }

    function applyLightLinkingPayload(data = {}, options = {}) {
        links.clear();
        clearEnvIntensityOverrides();
        lightCameraConstraints.clear();
        reflectionPaintCameraDirections.clear();
        hdriConstrainToCamera = false;
        reflectionPaintConstrainToCamera = false;

        if (!data || typeof data !== 'object') {
            reapply();
            return;
        }

        const rawEnv = data.env || {};
        const restoredLinks = deserializeLightLinks(data, { lightHandleMap, nodeMap });
        for (const [lightHandle, link] of restoredLinks) {
            links.set(lightHandle, link);
        }

        for (const [materialName, raw] of Object.entries(rawEnv)) {
            const v = Number(raw);
            if (Number.isFinite(v)) envIntensityByName.set(materialName, v);
        }

        const rawConstrain = data.constrain || {};
        hdriConstrainToCamera = !!rawConstrain.hdri;
        if (hdriConstrainToCamera) {
            hdriBaseRotationY = (scene.environmentRotation?.y ?? 0) + getCameraYaw();
        }

        reflectionPaintConstrainToCamera = !!rawConstrain.reflectionPaint;
        if (reflectionPaintConstrainToCamera) {
            captureReflectionPaintCameraDirections(rawConstrain.reflectionPaintDirections);
        }

        const lightConstraints = Array.isArray(rawConstrain.lightOffsets)
            ? rawConstrain.lightOffsets
            : (rawConstrain.lights || []).map(name => ({ name }));
        for (const item of lightConstraints) {
            const lName = typeof item === 'string' ? item : item?.name;
            const lh = lightHandleByName(lName);
            if (lh == null) continue;
            const constraint = buildCameraConstraintForLight(lh, item);
            if (constraint) lightCameraConstraints.set(handleToken(lh), constraint);
        }

        if (options.applyReflectionPaintIntensity !== false && Number.isFinite(Number(data.reflectionPaintIntensity))) {
            getReflectionPaintNode().setGlobalIntensity(Number(data.reflectionPaintIntensity));
        }
        reapply();
        onOutputChanged?.();
    }

    function applyState(studioState = {}) {
        if (!studioState || typeof studioState !== 'object') return;
        applyReflectionPaintState(studioState.reflectionPaint ?? { lights: [], intensity: 1.0 });
        applyLightLinkingPayload(studioState.lightLinking ?? {}, {
            applyReflectionPaintIntensity: studioState.reflectionPaint == null,
        });
        updateCameraConstraints();
    }

    function updateCameraConstraints() {
        if (hdriConstrainToCamera) {
            const camYaw = getCameraYaw();
            const y = hdriBaseRotationY - camYaw;
            if (scene.environmentRotation) scene.environmentRotation.y = y;
            if (scene.backgroundRotation) scene.backgroundRotation.y = y;
        }

        if (reflectionPaintConstrainToCamera) {
            getCameraWorldQuaternion(constraintCameraQuat);
            const paint = getReflectionPaintNode();
            const liveIds = new Set();
            for (const l of paint.getLights()) {
                const id = Number(l.id);
                liveIds.add(id);
                let localDir = reflectionPaintCameraDirections.get(id);
                if (!localDir) {
                    const worldDir = vectorFromPlain(l.direction);
                    if (!worldDir) continue;
                    constraintInverseQuat.copy(constraintCameraQuat).invert();
                    localDir = worldDir.normalize().applyQuaternion(constraintInverseQuat).normalize();
                    reflectionPaintCameraDirections.set(id, localDir);
                }
                paint.updateLight(id, {
                    direction: localDir.clone().applyQuaternion(constraintCameraQuat).normalize(),
                });
            }
            for (const id of reflectionPaintCameraDirections.keys()) {
                if (!liveIds.has(id)) reflectionPaintCameraDirections.delete(id);
            }
            onOutputChanged?.();
        }

        if (lightCameraConstraints.size === 0) return;
        camera.updateMatrixWorld(true);
        for (const [lh, constraint] of lightCameraConstraints) {
            const light = getByHandle(lightHandleMap, lh);
            if (!light) continue;
            applyWorldPosition(light, camera.localToWorld(constraintWorldPos.copy(constraint.posOffset)));
            if (constraint.targetOffset) {
                const target = light.userData?.maxjsTarget || light.target;
                if (target) {
                    applyWorldPosition(target, camera.localToWorld(constraintWorldPos.copy(constraint.targetOffset)));
                }
            }
        }
    }

    function setEnvIntensity(materialName, value) {
        if (!materialName) return;
        const v = Number.isFinite(Number(value)) ? Number(value) : 1.0;
        if (v !== 1.0) envIntensityByName.set(materialName, v);
        else envIntensityByName.delete(materialName);
        forEachMaterialByName(materialName, (mat) => {
            if (!envBaseIntensityByMaterial.has(mat)) {
                envBaseIntensityByMaterial.set(
                    mat,
                    Number.isFinite(mat.envMapIntensity) ? mat.envMapIntensity : 1.0,
                );
            }
            if (v !== 1.0) {
                mat.envMapIntensity = v;
            } else {
                const base = envBaseIntensityByMaterial.get(mat);
                if (Number.isFinite(base)) mat.envMapIntensity = base;
                envBaseIntensityByMaterial.delete(mat);
            }
        });
        onOutputChanged?.();
    }

    function dispose() {
        links.clear();
        clearEnvIntensityOverrides();
        reflectionPaintCameraDirections.clear();
        lightCameraConstraints.clear();
        hdriConstrainToCamera = false;
        reflectionPaintConstrainToCamera = false;
        const paint = getReflectionPaintNode();
        paint.clearLights();
        paint.setGlobalIntensity(1.0);
        reapply();
    }

    return {
        applyState,
        applyLightLinkingPayload,
        applyReflectionPaintState,
        reapply,
        refreshSceneBindings: () => {
            reapply();
            onOutputChanged?.();
        },
        updateCameraConstraints,
        setEnvIntensity,
        dispose,
        hasReflectionPaint: () => getReflectionPaintNode().active,
        getReflectionPaintNode,
    };
}
