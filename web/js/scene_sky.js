// scene_sky.js - explicit snapshot sky controller.
//
// Only used when snapshot.json contains env.sky. Inline sky scripts are
// handled by project/inlines and should not be replaced by default sky data.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

import { copyMaxComponentsToWorld } from './max_basis.js';

const SKY_FALLBACKS = Object.freeze({
    turbidity: 10,
    rayleigh: 3,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.7,
    elevation: 2,
    azimuth: 180,
    exposure: 0.5,
});

function numberOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

export function createSky({ scene, renderer }) {
    if (!scene) throw new Error('createSky: scene is required');
    if (!renderer) throw new Error('createSky: renderer is required');

    let mesh = null;
    let sun = null;
    let fill = null;
    let lastSig = '';
    let visible = true;

    function ensureMesh() {
        if (mesh) return;
        mesh = new Sky();
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
        if (!visible) scene.background = new THREE.Color(0x353535);
    }

    function apply(rawParams) {
        const params = { ...SKY_FALLBACKS, ...(rawParams || {}) };
        params.turbidity = numberOr(params.turbidity, SKY_FALLBACKS.turbidity);
        params.rayleigh = numberOr(params.rayleigh, SKY_FALLBACKS.rayleigh);
        params.mieCoefficient = numberOr(params.mieCoefficient, SKY_FALLBACKS.mieCoefficient);
        params.mieDirectionalG = numberOr(params.mieDirectionalG, SKY_FALLBACKS.mieDirectionalG);
        params.elevation = numberOr(params.elevation, SKY_FALLBACKS.elevation);
        params.azimuth = numberOr(params.azimuth, SKY_FALLBACKS.azimuth);
        params.exposure = numberOr(params.exposure, SKY_FALLBACKS.exposure);

        const sig = JSON.stringify(params);
        if (sig === lastSig) return { params, changed: false };
        lastSig = sig;

        ensureMesh();
        ensureLights();

        const elevRad = THREE.MathUtils.degToRad(params.elevation);
        const azimRad = THREE.MathUtils.degToRad(params.azimuth);
        const sunDir = copyMaxComponentsToWorld(
            new THREE.Vector3(),
            Math.cos(elevRad) * Math.sin(azimRad),
            Math.cos(elevRad) * Math.cos(azimRad),
            Math.sin(elevRad),
        );

        const u = mesh.material.uniforms;
        u.turbidity.value = params.turbidity;
        u.rayleigh.value = params.rayleigh;
        u.mieCoefficient.value = params.mieCoefficient;
        u.mieDirectionalG.value = params.mieDirectionalG;
        u.up.value.set(0, 1, 0);
        u.sunPosition.value.copy(sunDir);

        renderer.toneMappingExposure = params.exposure;
        scene.background = null;

        const sunStrength = Math.max(0.1, Math.sin(elevRad));
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
        try { mesh?.geometry?.dispose?.(); } catch {}
        try {
            const mat = mesh?.material;
            if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
            else mat?.dispose?.();
        } catch {}
        mesh = null;
        sun = null;
        fill = null;
        lastSig = '';
    }

    return {
        apply,
        setVisible,
        dispose,
        get mesh() { return mesh; },
        get sun() { return sun; },
        get fill() { return fill; },
    };
}
