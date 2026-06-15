// studio_lighting.js - shared Studio render-mode lighting state.
//
// Live mode owns the editing UI in index.html. This module owns the portable
// pieces needed by exported snapshots: MaxLightsNode renderer wiring, per-mesh
// light masks, per-material environment intensity, reflection paint, and
// camera-relative constraints.

import * as THREE from 'three';

import { getReflectionPaintNode, maxLights, ensureMeshMaskDefaults, LIGHT_MASK_LO_KEY, LIGHT_MASK_HI_KEY } from './max_lights_node.js';

const MAXJS_MAX_LIGHT_IDS = 64;

const constraintCameraQuat = new THREE.Quaternion();
const constraintInverseQuat = new THREE.Quaternion();
const constraintWorldPos = new THREE.Vector3();

export function installStudioLightingRenderer(renderer, options = {}) {
    if (!renderer?.lighting?.createNode) return false;
    if (renderer.lighting.createNode?.maxjsStudioLighting === true) return true;

    const factory = (lights = []) => maxLights({
        maxDirectionalLights: options.maxDirectionalLights ?? 16,
        maxPointLights: options.maxPointLights ?? 32,
        maxSpotLights: options.maxSpotLights ?? 32,
        maxHemisphereLights: options.maxHemisphereLights ?? 4,
    }).setLights(lights);
    factory.maxjsStudioLighting = true;
    renderer.lighting.createNode = factory;
    return true;
}

function handleToken(handle) {
    return handle == null ? '' : String(handle);
}

function resolveHandle(map, handle) {
    if (!map || handle == null) return null;
    if (map.has(handle)) return handle;
    const token = handleToken(handle);
    if (map.has(token)) return token;
    if (/^-?\d+$/.test(token)) {
        const numeric = Number(token);
        if (Number.isSafeInteger(numeric) && map.has(numeric)) return numeric;
    }
    return null;
}

function getByHandle(map, handle) {
    const resolved = resolveHandle(map, handle);
    return resolved == null ? undefined : map.get(resolved);
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

function lightStableKey(light, handle) {
    return String(light?.name || (handle != null ? `_h${handle}` : `_light_${light?.id ?? 0}`));
}

export function createStudioLightingController({
    scene,
    camera,
    nodeMap,
    lightHandleMap,
    getRenderableMeshes = null,
    onSceneChanged = null,
    onOutputChanged = null,
} = {}) {
    if (!scene) throw new Error('createStudioLightingController: scene required');
    if (!camera) throw new Error('createStudioLightingController: camera required');
    if (!nodeMap) throw new Error('createStudioLightingController: nodeMap required');
    if (!lightHandleMap) throw new Error('createStudioLightingController: lightHandleMap required');

    const links = new Map();
    const envIntensityByName = new Map();
    const reflectionPaintCameraDirections = new Map();
    const lightCameraConstraints = new Map();
    const lightIdByName = new Map();
    const lightIdSlots = new Uint8Array(MAXJS_MAX_LIGHT_IDS);

    let hdriConstrainToCamera = false;
    let hdriBaseRotationY = 0;
    let reflectionPaintConstrainToCamera = false;

    function allocLightId(key) {
        if (lightIdByName.has(key)) {
            const id = lightIdByName.get(key);
            lightIdSlots[id] = 1;
            return id;
        }
        for (let i = 0; i < MAXJS_MAX_LIGHT_IDS; i++) {
            if (!lightIdSlots[i]) {
                lightIdSlots[i] = 1;
                lightIdByName.set(key, i);
                return i;
            }
        }
        return -1;
    }

    function ensureLightIds() {
        lightIdSlots.fill(0);
        for (const [handle, light] of lightHandleMap) {
            if (!light) continue;
            light.userData ??= {};
            light.userData.maxjsLightId = allocLightId(lightStableKey(light, handle));
            light.userData.maxjsLightLinked = false;
        }
    }

    function forEachRenderableMesh(fn) {
        for (const [h, mesh] of nodeMap) {
            if (!mesh?.isMesh) continue;
            fn(handleToken(h), mesh);
        }
        if (typeof getRenderableMeshes === 'function') {
            for (const entry of getRenderableMeshes() ?? []) {
                const mesh = entry?.mesh?.isMesh ? entry.mesh : (entry?.isMesh ? entry : null);
                if (!mesh) continue;
                const handle = entry?.handle ?? entry?.sourceHandle ?? mesh.userData?.maxjsHandle ?? mesh.userData?.maxjsSource ?? '';
                fn(handleToken(handle), mesh);
            }
        }
    }

    function resetMask(mesh) {
        ensureMeshMaskDefaults(mesh);
        mesh.userData[LIGHT_MASK_LO_KEY] = 0xFFFFFFFF;
        mesh.userData[LIGHT_MASK_HI_KEY] = 0xFFFFFFFF;
    }

    function writeBit(mesh, lightId, enabled) {
        ensureMeshMaskDefaults(mesh);
        const key = lightId < 32 ? LIGHT_MASK_LO_KEY : LIGHT_MASK_HI_KEY;
        const bit = (1 << (lightId & 31)) >>> 0;
        const cur = mesh.userData[key] >>> 0;
        mesh.userData[key] = enabled ? ((cur | bit) >>> 0) : ((cur & ~bit) >>> 0);
    }

    function lightHandleByName(name) {
        for (const [h, light] of lightHandleMap) {
            if (light?.name === name) return handleToken(h);
        }
        return null;
    }

    function meshHandleByName(name) {
        for (const [h, mesh] of nodeMap) {
            if (mesh?.name === name) return handleToken(h);
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
        const seen = new Set();
        forEachRenderableMesh((_h, mesh) => {
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const mat of materials) {
                if (!mat || seen.has(mat)) continue;
                seen.add(mat);
                const matName = materialNameOf(mat);
                const ev = envIntensityByName.get(matName);
                mat.envMapIntensity = (typeof ev === 'number') ? ev : 1.0;
            }
        });
    }

    function reapply() {
        ensureLightIds();
        if (links.size > 0) {
            forEachRenderableMesh((_meshHandle, mesh) => resetMask(mesh));
            for (const [lh, link] of links) {
                const light = getByHandle(lightHandleMap, lh);
                const lid = light?.userData?.maxjsLightId;
                if (!Number.isInteger(lid) || lid < 0 || lid >= MAXJS_MAX_LIGHT_IDS) continue;
                light.userData.maxjsLightLinked = true;
                if (link.mode === 'include') {
                    forEachRenderableMesh((meshHandle, mesh) => {
                        writeBit(mesh, lid, link.objects.has(meshHandle));
                    });
                } else {
                    forEachRenderableMesh((meshHandle, mesh) => {
                        if (link.objects.has(meshHandle)) writeBit(mesh, lid, false);
                    });
                }
            }
        }
        applyEnvIntensities();
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
        envIntensityByName.clear();
        lightCameraConstraints.clear();
        reflectionPaintCameraDirections.clear();
        hdriConstrainToCamera = false;
        reflectionPaintConstrainToCamera = false;

        if (!data || typeof data !== 'object') {
            reapply();
            return;
        }

        const rawLinks = data.links || (data.env === undefined ? data : {});
        const rawEnv = data.env || {};
        for (const [lName, entry] of Object.entries(rawLinks)) {
            if (!entry || typeof entry !== 'object' || !entry.mode) continue;
            const lh = lightHandleByName(lName);
            if (lh == null) continue;
            const objHandles = new Set();
            for (const oName of (entry.objects || [])) {
                const oh = meshHandleByName(oName);
                if (oh != null) objHandles.add(oh);
            }
            if (objHandles.size > 0) {
                links.set(lh, {
                    mode: entry.mode === 'include' ? 'include' : 'exclude',
                    objects: objHandles,
                });
            }
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
            mat.envMapIntensity = v;
        });
        onOutputChanged?.();
    }

    function dispose() {
        links.clear();
        envIntensityByName.clear();
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
