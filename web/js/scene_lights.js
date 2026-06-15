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
const shadowOriginScale = new THREE.Vector3();
const shadowOriginDir = new THREE.Vector3();
const shadowOriginLightPos = new THREE.Vector3();
const lightLocalPos = new THREE.Vector3();
const lightWorldPos = new THREE.Vector3();
const lightTargetLocal = new THREE.Vector3();
const lightTargetWorld = new THREE.Vector3();
const lightDirWorld = new THREE.Vector3();
const lightParentQuat = new THREE.Quaternion();
const lightWorldQuat = new THREE.Quaternion();
// Exporter convention: beam = node TM -Y (WriteLightJson: dir = -row1).
const LIGHT_BEAM_AXIS = new THREE.Vector3(0, -1, 0);
const MAXJS_SELF_HIDDEN_LAYER = 31;
const MAXJS_MAX_LIGHT_IDS = 64;

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
    if (target) {
        // Lights parented in Max (flashlight on a camera, lamp on a vehicle)
        // carry their aim point WITH them: the target rides as a child of the
        // light so animated matrix tracks rotate the beam too — the light's
        // own quaternion is otherwise ignored by Spot/Directional lights.
        // Free lights keep the world-space sibling target (existing behavior,
        // incl. the directional shadow-origin focus path).
        const attachTargetToLight = (Number(light.userData.maxjsParentHandle) || 0) > 0;
        const targetParent = attachTargetToLight ? light : parentObject;
        if (target.parent !== targetParent) targetParent.add(target);
    }
    return parentObject;
}

// For lights whose target rides as a child: the light's local rotation must
// carry the beam direction so the child target (≈ local −Y offset) lands at
// the exported aim point. Animated matrix16 tracks later overwrite this
// rotation with the sampled Max node TM, whose −Y is the beam by the same
// exporter convention — so static pose and animated frames stay consistent.
function orientLightFromDir(light, ld, rootParent) {
    if (!Array.isArray(ld?.dir)) return;
    lightDirWorld.set(ld.dir[0], ld.dir[1], ld.dir[2]);
    if (lightDirWorld.lengthSq() < 1e-12) return;
    rootParent.updateMatrixWorld(true);
    lightDirWorld.transformDirection(rootParent.matrixWorld);
    lightWorldQuat.setFromUnitVectors(LIGHT_BEAM_AXIS, lightDirWorld);
    if (light.parent) {
        light.parent.updateMatrixWorld(true);
        light.parent.getWorldQuaternion(lightParentQuat);
        light.quaternion.copy(lightParentQuat.invert().multiply(lightWorldQuat));
    } else {
        light.quaternion.copy(lightWorldQuat);
    }
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

function isShadowMapOriginObject(object) {
    const name = String(object?.name || '');
    return /^(?:maxjs[\s_-]*)?(?:(?:shadow[\s_-]*map|shadowmap|shadow)[\s_-]*)origin(?:$|[\s_.:-])/i.test(name);
}

function getShadowMapOriginRadiusFromName(name) {
    const match = String(name || '').match(/(?:^|[\s_:-])(?:r|radius|size)?[\s_:=:-]*(\d+(?:\.\d+)?)(?:$|[\s_:-])/i);
    if (!match) return 0;
    const radius = Number(match[1]);
    return Number.isFinite(radius) && radius > 0 ? radius : 0;
}

function setObjectSelfVisibleLayer(object, visible) {
    if (!object?.layers?.set) return;
    object.layers.set(visible ? 0 : MAXJS_SELF_HIDDEN_LAYER);
}

function configureShadowMapOriginObject(object) {
    if (!object) return;
    object.userData ??= {};
    object.userData.maxjsShadowMapOrigin = true;
    object.userData.maxjsVisible = false;
    object.castShadow = false;
    object.receiveShadow = false;
    setObjectSelfVisibleLayer(object, false);
}

function findShadowMapOriginObject(nodeMap) {
    for (const object of nodeMap?.values?.() ?? []) {
        if (!isShadowMapOriginObject(object)) continue;
        configureShadowMapOriginObject(object);
        return object;
    }
    return null;
}

function getShadowMapOriginFocus(object) {
    if (!object) return null;
    object.updateWorldMatrix(true, false);
    const nameRadius = getShadowMapOriginRadiusFromName(object.name);
    shadowBounds.makeEmpty();
    if (object.isMesh || object.isLine || object.isLineSegments) {
        shadowBounds.setFromObject(object);
    }
    object.getWorldPosition(shadowCenter);

    let radius = nameRadius;
    if (!radius && !shadowBounds.isEmpty()) {
        shadowBounds.getCenter(shadowCenter);
        shadowBounds.getSize(shadowSize);
        radius = Math.max(shadowSize.x, shadowSize.y, shadowSize.z) * 0.5;
    }
    if (!radius) {
        object.getWorldScale(shadowOriginScale);
        radius = Math.max(shadowOriginScale.x, shadowOriginScale.y, shadowOriginScale.z, 50);
    }

    return {
        center: shadowCenter,
        radius: Math.max(radius, 1),
        explicit: true,
    };
}

function getShadowSceneFocus(nodeMap) {
    const origin = findShadowMapOriginObject(nodeMap);
    if (origin) return getShadowMapOriginFocus(origin);

    shadowBounds.makeEmpty();
    for (const mesh of nodeMap?.values?.() ?? []) {
        if (mesh?.userData?.maxjsShadowMapOrigin || isShadowMapOriginObject(mesh)) continue;
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
        explicit: false,
    };
}

function setObjectWorldPosition(object, worldPosition) {
    const parent = object?.parent;
    if (!object || !worldPosition) return;
    object.position.copy(worldPosition);
    if (parent) {
        parent.updateMatrixWorld(true);
        parent.worldToLocal(object.position);
    }
    object.updateMatrixWorld(true);
}

function applyDirectionalShadowOrigin(light, focus) {
    const target = light.userData?.maxjsTarget;
    if (!focus?.explicit || !target) return;

    light.getWorldPosition(lightWorldPos);
    target.getWorldPosition(lightTargetWorld);
    shadowOriginDir.subVectors(lightTargetWorld, lightWorldPos);
    if (shadowOriginDir.lengthSq() < 1e-8) return;
    shadowOriginDir.normalize();

    const distance = Math.max(focus.radius * 4, lightWorldPos.distanceTo(lightTargetWorld), 200);
    shadowOriginLightPos.copy(focus.center).addScaledVector(shadowOriginDir, -distance);
    setObjectWorldPosition(light, shadowOriginLightPos);
    setObjectWorldPosition(target, focus.center);
    lightTargetWorld.copy(focus.center);
}

function applyLightShadowDefaults(light, ld, nodeMap) {
    if (!light.shadow) return;
    const visible = light.userData?.maxjsVisible !== false;
    light.castShadow = visible && !!ld.castShadow;
    if (!light.castShadow) return;
    light.shadow.bias = ld.shadowBias ?? -0.0001;
    light.shadow.radius = ld.shadowRadius ?? 1;
    const mapSz = ld.shadowMapSize ?? 1024;
    light.shadow.mapSize.set(mapSz, mapSz);

    const focus = getShadowSceneFocus(nodeMap);
    const { radius } = focus;
    const cam = light.shadow.camera;
    if (ld.type === 0 && cam?.isOrthographicCamera) {
        applyDirectionalShadowOrigin(light, focus);
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
    light.userData.maxjsVisible = visible;
    light.visible = true;
    light.layers?.set?.(visible ? 0 : MAXJS_SELF_HIDDEN_LAYER);
    if (light.userData.maxjsTarget) light.userData.maxjsTarget.visible = true;

    if (light.color && Array.isArray(ld.color)) {
        light.color.setRGB(ld.color[0], ld.color[1], ld.color[2]);
    }
    if ('intensity' in light && Number.isFinite(ld.intensity)) {
        light.userData.maxjsAuthoredIntensity = ld.intensity;
        light.intensity = visible ? ld.intensity : 0;
    }
    if (Number.isFinite(ld.volContrib)) {
        light.userData.volContrib = ld.volContrib;
    } else {
        delete light.userData.volContrib;
    }

    switch (ld.type) {
    case 0: // Directional
        setPositionFromRootSpace(light, ld.pos, parent);
        if (light.userData.maxjsTarget?.parent === light) orientLightFromDir(light, ld, parent);
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
        if (light.userData.maxjsTarget?.parent === light) orientLightFromDir(light, ld, parent);
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
    const lightIdByName = new Map();
    const lightIdSlots = new Uint8Array(MAXJS_MAX_LIGHT_IDS);

    function lightStableKey(light, ld) {
        return String(light?.name || ld?.name || (ld?.h != null ? `_h${ld.h}` : `_light_${light?.id ?? 0}`));
    }

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
        lightIdSlots.fill(0);

        let count = 0;
        let mainDirectional = null;
        for (const ld of (lightsData ?? [])) {
            const light = createLightFromData(ld, lightGroup, nodeMap);
            if (!light) continue;
            if (!light.parent) lightGroup.add(light);
            light.userData ??= {};
            light.userData.maxjsLightId = allocLightId(lightStableKey(light, ld));
            light.userData.maxjsLightLinked = false;
            if (ld.h != null) lightHandleMap.set(ld.h, light);
            if (light.userData?.maxjsVisible !== false) {
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
