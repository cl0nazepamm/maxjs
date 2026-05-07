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

import * as THREE from 'three/webgpu';

const TARGET_DISTANCE = 1000;

function setLightTargetFromData(light, ld) {
    const target = light.userData?.maxjsTarget;
    if (!target || !ld?.pos || !ld?.dir) return;
    target.position.set(
        ld.pos[0] + ld.dir[0] * TARGET_DISTANCE,
        ld.pos[1] + ld.dir[1] * TARGET_DISTANCE,
        ld.pos[2] + ld.dir[2] * TARGET_DISTANCE,
    );
    target.updateMatrixWorld();
}

function applyLightShadowDefaults(light, ld) {
    if (!light.shadow) return;
    light.castShadow = !!ld.castShadow;
    if (!light.castShadow) return;
    light.shadow.bias = ld.shadowBias ?? -0.0001;
    light.shadow.radius = ld.shadowRadius ?? 1;
    const mapSz = ld.shadowMapSize ?? 1024;
    light.shadow.mapSize.set(mapSz, mapSz);

    // Snapshot-mode shadow camera defaults — wide enough for most scenes.
    // Live mode recomputes per-frame from scene bounds (`getShadowSceneFocus`);
    // skipping that here keeps things deterministic and cheap.
    const cam = light.shadow.camera;
    if (ld.type === 0 && cam?.isOrthographicCamera) {
        const radius = 500;
        cam.left = -radius;
        cam.right = radius;
        cam.top = radius;
        cam.bottom = -radius;
        cam.near = 0.1;
        cam.far = Math.max(radius * 8, 2000);
        cam.updateProjectionMatrix();
    } else if ((ld.type === 1 || ld.type === 2) && cam?.isPerspectiveCamera) {
        cam.near = 0.1;
        cam.far = ld.distance > 0 ? ld.distance : 2000;
        if (ld.type === 2) cam.fov = THREE.MathUtils.radToDeg((ld.angle ?? Math.PI / 4) * 2);
        cam.updateProjectionMatrix();
    }
    light.shadow.needsUpdate = true;
}

function applyLightData(light, ld) {
    light.userData ??= {};
    light.userData.maxjsTypeId = ld.type;
    if (ld.h != null) light.userData.maxjsHandle = ld.h;
    if (ld.name) light.name = ld.name;

    const visible = ld.v == null ? true : !!ld.v;
    light.visible = visible;
    if (light.userData.maxjsTarget) light.userData.maxjsTarget.visible = visible;

    if (light.color && Array.isArray(ld.color)) {
        light.color.setRGB(ld.color[0], ld.color[1], ld.color[2]);
    }
    if ('intensity' in light && Number.isFinite(ld.intensity)) {
        light.intensity = ld.intensity;
    }

    switch (ld.type) {
    case 0: // Directional
        if (ld.pos) light.position.set(ld.pos[0], ld.pos[1], ld.pos[2]);
        setLightTargetFromData(light, ld);
        break;
    case 1: // Point
        if (ld.pos) light.position.set(ld.pos[0], ld.pos[1], ld.pos[2]);
        light.distance = ld.distance || 0;
        light.decay = ld.decay ?? 2;
        break;
    case 2: // Spot
        if (ld.pos) light.position.set(ld.pos[0], ld.pos[1], ld.pos[2]);
        light.distance = ld.distance || 0;
        light.decay = ld.decay ?? 2;
        light.angle = ld.angle ?? Math.PI / 4;
        light.penumbra = ld.penumbra ?? 0.1;
        setLightTargetFromData(light, ld);
        break;
    case 3: // RectArea — orient toward dir
        if (ld.pos) light.position.set(ld.pos[0], ld.pos[1], ld.pos[2]);
        light.width = ld.width || 20;
        light.height = ld.height || 20;
        if (ld.pos && ld.dir) {
            light.lookAt(
                ld.pos[0] + ld.dir[0],
                ld.pos[1] + ld.dir[1],
                ld.pos[2] + ld.dir[2],
            );
        }
        break;
    case 4: // Hemisphere
        if (ld.pos) light.position.set(ld.pos[0], ld.pos[1], ld.pos[2]);
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

    applyLightShadowDefaults(light, ld);
}

function createLightFromData(ld, lightGroup) {
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
    applyLightData(light, ld);
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
export function createSceneLights({ scene, lightHandleMap = new Map() } = {}) {
    if (!scene) throw new Error('createSceneLights: scene required');

    const lightGroup = new THREE.Group();
    lightGroup.name = '__maxjs_lights__';
    scene.add(lightGroup);

    let lastSignature = '';

    function clear() {
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
            const light = createLightFromData(ld, lightGroup);
            if (!light) continue;
            lightGroup.add(light);
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
        scene.remove(lightGroup);
    }

    return { apply, clear, dispose, group: lightGroup, lightHandleMap };
}
