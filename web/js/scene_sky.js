// scene_sky.js - explicit snapshot sky controller.
//
// Only used when snapshot.json contains env.sky. Inline sky scripts are
// handled by project/inlines and should not be replaced by default sky data.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

import { createGeospatialSkyController } from './geospatial_sky.js';
import { copyMaxComponentsToWorld } from './max_basis.js';

const SKY_MODEL_PLANETARY = 1;

const SKY_FALLBACKS = Object.freeze({
    turbidity: 10,
    rayleigh: 3,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.7,
    elevation: 2,
    azimuth: 180,
    exposure: 0.5,
    model: 0,
    showSunDisc: true,
    cameraAltitude: 1200,
});

function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function createSky({ scene, renderer }) {
    if (!scene) throw new Error('createSky: scene is required');
    if (!renderer) throw new Error('createSky: renderer is required');

    let mesh = null;
    let sun = null;
    let fill = null;
    let geospatialSky = null;
    let lastSig = '';
    let lastRawParams = null;
    let visible = true;
    let planetaryActive = false;
    const useLegacySky = !(typeof THREE.WebGPURenderer === 'function' && renderer instanceof THREE.WebGPURenderer);
    const linkedSunDirection = new THREE.Vector3();
    const linkedSunPosition = new THREE.Vector3();
    const linkedSunTarget = new THREE.Vector3();

    function ensureMesh() {
        if (mesh) return;
        mesh = useLegacySky ? new Sky() : new SkyMesh();
        mesh.scale.setScalar(450000);
        mesh.name = '__maxjs_sky__';
        mesh.frustumCulled = false;
        mesh.userData.volumetricBoundsBypass = true;
        mesh.visible = visible;
        scene.add(mesh);
    }

    function ensureLights() {
        if (!sun) {
            sun = new THREE.DirectionalLight(0xffffff, 2.0);
            sun.name = '__maxjs_sky_sun__';
            sun.userData.volumetricBypass = true;
            sun.visible = visible;
            scene.add(sun);
        }
        if (!fill) {
            fill = new THREE.HemisphereLight(0x87ceeb, 0x362d1b, 1.0);
            fill.name = '__maxjs_sky_fill__';
            fill.userData.volumetricBypass = true;
            fill.visible = visible;
            scene.add(fill);
        }
    }

    function setVisible(nextVisible) {
        visible = !!nextVisible;
        if (mesh) mesh.visible = visible;
        if (sun) sun.visible = visible;
        if (fill) fill.visible = visible;
        geospatialSky?.setVisible?.(visible);
        if (!visible) scene.background = new THREE.Color(0x353535);
    }

    function removeClassicObjects() {
        try { mesh?.parent?.remove(mesh); } catch {}
        try { sun?.parent?.remove(sun); } catch {}
        try { fill?.parent?.remove(fill); } catch {}
    }

    function update(_dt, elapsed, camera) {
        if (!planetaryActive) return;
        geospatialSky?.update({ camera, elapsedSeconds: elapsed });
    }

    function getDirectionalLightSunVector(light, target = linkedSunDirection) {
        if (!light?.isDirectionalLight || light.visible === false) return null;
        if (light.name === '__maxjs_sky_sun__' || light.name === '__maxjs_geospatial_sky_sun__') return null;
        light.updateMatrixWorld?.();
        light.target?.updateMatrixWorld?.();
        linkedSunPosition.setFromMatrixPosition(light.matrixWorld);
        if (light.target?.matrixWorld) linkedSunTarget.setFromMatrixPosition(light.target.matrixWorld);
        else linkedSunTarget.set(0, 0, 0);
        target.copy(linkedSunPosition).sub(linkedSunTarget);
        return target.lengthSq() > 1.0e-8 ? target.normalize() : null;
    }

    function findLinkedSunDirection(target = linkedSunDirection) {
        const directional = [];
        scene.traverse((object) => {
            if (object?.isDirectionalLight && object.visible !== false) directional.push(object);
        });
        const authored = directional.filter(light => light.name !== '__maxjs_sky_sun__' && light.name !== '__maxjs_geospatial_sky_sun__');
        if (!authored.length) return null;
        const named = authored.find((light) => {
            const name = String(light.name || '').toLowerCase();
            return /\b(sun|sunlight|solar|daylight)\b/.test(name)
                || name.includes('sun')
                || name.includes('solar')
                || name.includes('daylight');
        });
        return getDirectionalLightSunVector(named || (authored.length === 1 ? authored[0] : null), target);
    }

    function withLinkedSun(rawParams) {
        const linkedDir = findLinkedSunDirection();
        if (!linkedDir) return rawParams;
        return {
            ...(rawParams || {}),
            sunDirectionWorld: [linkedDir.x, linkedDir.y, linkedDir.z],
            sunLinkedLight: true,
        };
    }

    function apply(rawParams) {
        lastRawParams = rawParams;
        const params = { ...SKY_FALLBACKS, ...withLinkedSun(rawParams) };
        params.turbidity = numberOr(params.turbidity, SKY_FALLBACKS.turbidity);
        params.rayleigh = numberOr(params.rayleigh, SKY_FALLBACKS.rayleigh);
        params.mieCoefficient = numberOr(params.mieCoefficient, SKY_FALLBACKS.mieCoefficient);
        params.mieDirectionalG = numberOr(params.mieDirectionalG, SKY_FALLBACKS.mieDirectionalG);
        params.elevation = numberOr(params.elevation, SKY_FALLBACKS.elevation);
        params.azimuth = numberOr(params.azimuth, SKY_FALLBACKS.azimuth);
        params.exposure = numberOr(params.exposure, SKY_FALLBACKS.exposure);
        params.model = Math.trunc(numberOr(params.model, SKY_FALLBACKS.model));
        params.showSunDisc = params.showSunDisc !== false && params.showSunDisc !== 0;
        params.cameraAltitude = Math.max(0, numberOr(params.cameraAltitude, SKY_FALLBACKS.cameraAltitude));

        const sig = JSON.stringify(params);
        if (sig === lastSig) return { params, changed: false };
        lastSig = sig;

        const planetary = params.model === SKY_MODEL_PLANETARY;
        if (planetary) {
            removeClassicObjects();
            geospatialSky ??= createGeospatialSkyController({
                scene,
                renderer,
                backendLabel: renderer?.userData?.maxjsBackendLabel || '',
            });
            geospatialSky.apply(params);
            geospatialSky.setVisible(visible);
            planetaryActive = true;
            return { params, changed: true };
        }

        geospatialSky?.dispose();
        geospatialSky = null;
        planetaryActive = false;

        ensureMesh();
        ensureLights();

        const elevRad = THREE.MathUtils.degToRad(params.elevation);
        const azimRad = THREE.MathUtils.degToRad(params.azimuth);
        const sunDir = Array.isArray(params.sunDirectionWorld)
            ? new THREE.Vector3(
                Number(params.sunDirectionWorld[0]),
                Number(params.sunDirectionWorld[1]),
                Number(params.sunDirectionWorld[2])
            ).normalize()
            : copyMaxComponentsToWorld(
                new THREE.Vector3(),
                Math.cos(elevRad) * Math.sin(azimRad),
                Math.cos(elevRad) * Math.cos(azimRad),
                Math.sin(elevRad),
            ).normalize();

        if (useLegacySky) {
            const u = mesh.material.uniforms;
            u.turbidity.value = params.turbidity;
            u.rayleigh.value = params.rayleigh;
            u.mieCoefficient.value = params.mieCoefficient;
            u.mieDirectionalG.value = params.mieDirectionalG;
            u.up.value.set(0, 1, 0);
            u.sunPosition.value.copy(sunDir);
        } else {
            mesh.turbidity.value = params.turbidity;
            mesh.rayleigh.value = params.rayleigh;
            mesh.mieCoefficient.value = params.mieCoefficient;
            mesh.mieDirectionalG.value = params.mieDirectionalG;
            mesh.upUniform.value.set(0, 1, 0);
            mesh.sunPosition.value.copy(sunDir);
        }
        renderer.toneMappingExposure = params.exposure;
        scene.background = new THREE.Color(0x353535);

        const sunStrength = Math.max(0.1, THREE.MathUtils.clamp(sunDir.y, -1, 1));
        const warmth = 1.0 - sunStrength * 0.2;
        sun.color.setRGB(1.0, warmth, warmth * 0.85);
        sun.intensity = 1.0 + sunStrength * 3.0;
        sun.position.copy(sunDir).multiplyScalar(200);
        fill.intensity = 0.5 + sunStrength * 0.5;
        setVisible(visible);

        return { params, changed: true };
    }

    function dispose() {
        try { mesh?.parent?.remove(mesh); } catch {}
        try { sun?.parent?.remove(sun); } catch {}
        try { fill?.parent?.remove(fill); } catch {}
        try { geospatialSky?.dispose?.(); } catch {}
        try { mesh?.geometry?.dispose?.(); } catch {}
        try {
            const mat = mesh?.material;
            if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
            else mat?.dispose?.();
        } catch {}
        mesh = null;
        sun = null;
        fill = null;
        geospatialSky = null;
        lastSig = '';
        planetaryActive = false;
    }

    return {
        apply,
        update,
        setVisible,
        dispose,
        get mesh() { return mesh; },
        get sun() { return sun; },
        get fill() { return fill; },
    };
}
