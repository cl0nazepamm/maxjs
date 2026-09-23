// Shared authored sky controls for the editor and standalone snapshots.
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';

export const SKY_DETAIL_DEFAULTS = Object.freeze({
    cloudCoverage: 0,
    cloudDensity: 0.4,
    cloudScale: 0.0002,
    cloudElevation: 0.5,
    sunShadows: false,
    sunShadowDistance: 10000,
});

const registeredRenderers = new WeakSet();

export function normalizeSkyDetails(params) {
    for (const [key, min, max] of [
        ['cloudCoverage', 0, 1], ['cloudDensity', 0, 1],
        ['cloudScale', 0.00001, 0.01], ['cloudElevation', 0, 1],
        ['sunShadowDistance', 1, 1000000],
    ]) {
        const value = Number(params[key]);
        params[key] = Number.isFinite(value)
            ? Math.max(min, Math.min(max, value)) : SKY_DETAIL_DEFAULTS[key];
    }
    params.sunShadows = params.sunShadows === true || params.sunShadows === 1;
    return params;
}

export function applySkyDetails(mesh, params) {
    const uniforms = mesh.isSkyMesh ? mesh : mesh.material.uniforms;
    for (const key of ['cloudCoverage', 'cloudDensity', 'cloudScale', 'cloudElevation']) {
        uniforms[key].value = params[key];
    }
    // Authored clouds are static, so a snapshot and the live view share the
    // same cloud pattern independently of their renderer clocks.
    uniforms.cloudSpeed.value = 0;
    uniforms.showSunDisc.value = params.showSunDisc ? 1 : 0;
}

export function createSkySun(renderer, params) {
    if (params.sunShadows && renderer.library && !registeredRenderers.has(renderer)) {
        renderer.library.addLight(SunLightNode, SunLight);
        registeredRenderers.add(renderer);
    }
    const sun = params.sunShadows
        ? new SunLight(0xffffff, 2)
        : new THREE.DirectionalLight(0xffffff, 2);
    sun.name = '__maxjs_sky_sun__';
    sun.userData.volumetricBypass = true;
    sun.castShadow = params.sunShadows;
    sun.shadow.camera.far = params.sunShadowDistance;
    return sun;
}
