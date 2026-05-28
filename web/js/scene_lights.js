// scene_lights.js — applies the maxjs `lights` array from snapshot.json
// into a Three.js scene group.
//
// Stage 4 deliverable from docs/SNAPSHOT_REFACTOR.md.
//
// Lifted from web/index.html (~lines 7024-7230). Snapshot-mode scope:
//
//   IN:
//     - All six light types (Directional/Point/Spot/RectArea/Hemisphere/Ambient)
//     - Color, intensity, position, distance, decay, angle, penumbra,
//       width/height (rect area), groundColor (hemisphere)
//     - Shadow bias, radius, mapSize for shadow-casting types
//     - Visibility flag
//     - lightHandleMap registration (so animations can target lights)
//     - Signature-based skip when nothing changed
//
//   OUT (deferred to follow-up sessions):
//     - Light helpers (debug visualization)
//     - Light linking (per-mesh masks — live-mode editor feature)
//     - Light probe scheduling
//     - SSGI main-light wiring
//     - Shadow camera scene-bounds focus (snapshot uses fixed defaults)
//
// Type IDs match index.html's:
//   0 Directional, 1 Point, 2 Spot, 3 RectArea, 4 Hemisphere, 5 Ambient

import * as THREE from 'three';

const TARGET_DISTANCE = 1000;
const shadowBounds = new THREE.Box3();
const shadowCenter = new THREE.Vector3();
const shadowSize = new THREE.Vector3();
const lightLocalPos = new THREE.Vector3();
const lightWorldPos = new THREE.Vector3();
const lightTargetLocal = new THREE.Vector3();
const lightTargetWorld = new THREE.Vector3();

function getLightParentObject(light, ld, parent, nodeMap) {
    const explicitParent = Object.prototype.hasOwnProperty.call(ld ?? {}, 'p')
        ? Number(ld.p)
        : Number(light?.userData?.maxjsParentHandle);
    const parentObject = Number.isFinite(explicitParent) && explicitParent > 0
        ? nodeMap?.get?.(explicitParent)
        : null;
    if (!parentObject || parentObject === light) return parent;
    for (let cursor = parentObject; cursor; cursor = cursor.parent) {
        if (cursor === light) return parent;
    }
    return parentObject;
}

function syncLightParent(light, ld, parent, nodeMap) {
    light.userData ??= {};
    if (Object.prototype.hasOwnProperty.call(ld ?? {}, 'p')) {
        const parentHandle = Number(ld.p);
        light.userData.maxjsParentHandle =
            Number.isFinite(parentHandle) && parentHandle > 0 ? parentHandle : 0;
    } else {
        light.userData.maxjsParentHandle = Number(light.userData.maxjsParentHandle) || 0;
    }
    const parentObject = getLightParentObject(light, ld, parent, nodeMap);
    if (light.parent !== parentObject) parentObject.add(light);
    const target = light.userData.maxjsTarget;
    if (target && target.parent !== parentObject) parentObject.add(target);
    return parentObject;
}

function setPositionFromRootSpace(obj, pos, rootParent) {
    if (!obj || !Array.isArray(pos)) return;
    lightLocalPos.set(pos[0], pos[1], pos[2]);
    const parent = obj.parent || rootParent;
    if (parent !== rootParent) {
        rootParent.updateMatrixWorld(true);
        parent.updateMatrixWorld(true);
        lightWorldPos.copy(lightLocalPos);
        rootParent.localToWorld(lightWorldPos);
        lightLocalPos.copy(lightWorldPos);
        parent.worldToLocal(lightLocalPos);
    }
    obj.position.copy(lightLocalPos);
}

function setLightTargetFromData(light, ld, rootParent) {
    const target = light.userData?.maxjsTarget;
    if (!target || !ld?.pos || !ld?.dir) return;
    lightTargetLocal.set(
        ld.pos[0] + ld.dir[0] * TARGET_DISTANCE,
        ld.pos[1] + ld.dir[1] * TARGET_DISTANCE,
        ld.pos[2] + ld.dir[2] * TARGET_DISTANCE,
    );
    lightTargetWorld.copy(lightTargetLocal);
    rootParent.updateMatrixWorld(true);
    rootParent.localToWorld(lightTargetWorld);
    const parent = target.parent || rootParent;
    if (parent !== rootParent) {
        parent.updateMatrixWorld(true);
        target.position.copy(lightTargetWorld);
        parent.worldToLocal(target.position);
    } else {
        target.position.copy(lightTargetLocal);
    }
    target.updateMatrixWorld();
}

function getShadowSceneFocus(nodeMap) {
    shadowBounds.makeEmpty();
    for (const mesh of nodeMap?.values?.() ?? []) {
        if (!mesh?.isMesh || !mesh.visible) continue;
        shadowBounds.expandByObject(mesh);
    }

    if (shadowBounds.isEmpty()) {
        shadowBounds.min.set(-100, -100, -100);
        shadowBounds.max.set(100, 100, 100);
    }

    shadowBounds.getCenter(shadowCenter);
    shadowBounds.getSize(shadowSize);
    return {
        center: shadowCenter,
        radius: Math.max(shadowSize.x, shadowSize.y, shadowSize.z, 50),
    };
}

function applyLightShadowDefaults(light, ld, nodeMap) {
    if (!light.shadow) return;
    light.castShadow = !!ld.castShadow;
    if (!light.castShadow) return;
    light.shadow.bias = ld.shadowBias ?? -0.0001;
    light.shadow.radius = ld.shadowRadius ?? 1;
    const mapSz = ld.shadowMapSize ?? 1024;
    light.shadow.mapSize.set(mapSz, mapSz);

    const { radius } = getShadowSceneFocus(nodeMap);
    const cam = light.shadow.camera;
    if (ld.type === 0 && cam?.isOrthographicCamera) {
        cam.left = -radius;
        cam.right = radius;
        cam.top = radius;
        cam.bottom = -radius;
        cam.near = 0.1;
        const target = light.userData?.maxjsTarget;
        const targetDistance = target ? light.position.distanceTo(target.position) : 0;
        cam.far = Math.max(radius * 8, targetDistance, 200);
        cam.updateProjectionMatrix();
    } else if ((ld.type === 1 || ld.type === 2) && cam?.isPerspectiveCamera) {
        cam.near = Math.max(radius * 0.01, 0.1);
        cam.far = ld.distance > 0 ? ld.distance : Math.max(radius * 6, 200);
        if (ld.type === 2) cam.fov = THREE.MathUtils.radToDeg((ld.angle ?? Math.PI / 4) * 2);
        cam.updateProjectionMatrix();
    }
    light.shadow.needsUpdate = true;
}

function applyLightData(light, ld, nodeMap, parent) {
    light.userData ??= {};
    light.userData.maxjsTypeId = ld.type;
    if (ld.h != null) light.userData.maxjsHandle = ld.h;
    if (ld.name) light.name = ld.name;
    syncLightParent(light, ld, parent, nodeMap);

    const visible = ld.v == null ? true : !!ld.v;
    light.visible = visible;
    if (light.userData.maxjsTarget) light.userData.maxjsTarget.visible = visible;

    if (light.color && Array.isArray(ld.color)) {
        light.color.setRGB(ld.color[0], ld.color[1], ld.color[2]);
    }
    if ('intensity' in light && Number.isFinite(ld.intensity)) {
        light.intensity = ld.intensity;
    }
    if (Number.isFinite(ld.volContrib)) {
        light.userData.volContrib = ld.volContrib;
    } else {
        delete light.userData.volContrib;
    }

    switch (ld.type) {
    case 0: // Directional
        setPositionFromRootSpace(light, ld.pos, parent);
        setLightTargetFromData(light, ld, parent);
        break;
    case 1: // Point
        setPositionFromRootSpace(light, ld.pos, parent);
        light.distance = ld.distance || 0;
        light.decay = ld.decay ?? 2;
        break;
    case 2: // Spot
        setPositionFromRootSpace(light, ld.pos, parent);
        light.distance = ld.distance || 0;
        light.decay = ld.decay ?? 2;
        light.angle = ld.angle ?? Math.PI / 4;
        light.penumbra = ld.penumbra ?? 0.1;
        setLightTargetFromData(light, ld, parent);
        break;
    case 3: // RectArea — orient toward dir
        setPositionFromRootSpace(light, ld.pos, parent);
        light.width = ld.width || 20;
        light.height = ld.height || 20;
        if (ld.pos && ld.dir) {
            lightTargetLocal.set(
                ld.pos[0] + ld.dir[0],
                ld.pos[1] + ld.dir[1],
                ld.pos[2] + ld.dir[2],
            );
            lightTargetWorld.copy(lightTargetLocal);
            parent.updateMatrixWorld(true);
            parent.localToWorld(lightTargetWorld);
            light.updateMatrixWorld(true);
            light.lookAt(lightTargetWorld);
        }
        break;
    case 4: // Hemisphere
        setPositionFromRootSpace(light, ld.pos, parent);
        if (light.groundColor) {
            light.groundColor.setRGB(
                ld.groundColor?.[0] ?? 0.2666666667,
                ld.groundColor?.[1] ?? 0.2666666667,
                ld.groundColor?.[2] ?? 0.2666666667,
            );
        }
        break;
    case 5: // Ambient
        break;
    }

    applyLightShadowDefaults(light, ld, nodeMap);
}

function createLightFromData(ld, lightGroup, nodeMap) {
    let light;
    switch (ld.type) {
    case 0:
        light = new THREE.DirectionalLight(0xffffff, 1);
        light.userData.maxjsTarget = light.target;
        lightGroup.add(light.target);
        break;
    case 1:
        light = new THREE.PointLight(0xffffff, 1, 0, 2);
        break;
    case 2:
        light = new THREE.SpotLight(0xffffff, 1, 0, Math.PI / 4, 0.1, 2);
        light.userData.maxjsTarget = light.target;
        lightGroup.add(light.target);
        break;
    case 3:
        light = new THREE.RectAreaLight(0xffffff, 1, ld.width || 20, ld.height || 20);
        break;
    case 4:
        light = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
        break;
    case 5:
        light = new THREE.AmbientLight(0xffffff, 1);
        break;
    default:
        return null;
    }
    applyLightData(light, ld, nodeMap, lightGroup);
    return light;
}

/**
 * Creates a SceneLights instance bound to a parent scene. Owns its own
 * THREE.Group so callers can wire the layer-manager nodeMap / handle
 * registry through `lightHandleMap` without leaking ownership.
 *
 * Usage:
 *   const lights = createSceneLights({ scene, lightHandleMap });
 *   lights.apply(meta.lights ?? []);
 *   // → returns { count, mainDirectional, signature }
 */
export function createSceneLights({ scene, parent = scene, lightHandleMap = new Map(), nodeMap = null } = {}) {
    if (!scene) throw new Error('createSceneLights: scene required');
    if (!parent?.add) throw new Error('createSceneLights: parent Object3D required');

    const lightGroup = new THREE.Group();
    lightGroup.name = '__maxjs_lights__';
    parent.add(lightGroup);

    let lastSignature = '';

    function clear() {
        for (const [, light] of lightHandleMap) {
            const target = light.userData?.maxjsTarget;
            if (target?.parent) target.parent.remove(target);
            if (light.parent) light.parent.remove(light);
            light.dispose?.();
        }
        lightHandleMap.clear();
        while (lightGroup.children.length) {
            const c = lightGroup.children[0];
            lightGroup.remove(c);
            c.dispose?.();
        }
    }

    function signature(lightsData) {
        return JSON.stringify(Array.isArray(lightsData) ? lightsData : []);
    }

    function apply(lightsData) {
        const sig = signature(lightsData);
        if (sig === lastSignature) {
            return { count: 0, mainDirectional: null, signature: sig, changed: false };
        }
        clear();

        let count = 0;
        let mainDirectional = null;
        for (const ld of (lightsData ?? [])) {
            const light = createLightFromData(ld, lightGroup, nodeMap);
            if (!light) continue;
            if (!light.parent) lightGroup.add(light);
            if (ld.h != null) lightHandleMap.set(ld.h, light);
            if (light.visible !== false) {
                count++;
                if (!mainDirectional && ld.type === 0) mainDirectional = light;
            }
        }

        lastSignature = sig;
        return { count, mainDirectional, signature: sig, changed: true };
    }

    function dispose() {
        clear();
        parent.remove(lightGroup);
    }

    return { apply, clear, dispose, group: lightGroup, lightHandleMap };
}
