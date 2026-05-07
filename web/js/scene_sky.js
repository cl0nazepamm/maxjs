// scene_sky.js - snapshot-mode procedural sky.
//
// Mirrors the Sky / SkyMesh path in index.html (search "Sky Environment")
// but trimmed for standalone snapshot use:
//   - No PMREM env-map generation. Snapshots target WebGL2 by default and
//     metallic env reflection is not part of snapshot parity (per user
//     direction). The visible blue background + atmospheric sun come from
//     the sky mesh + lights only.
//   - No bridge / no live param feed. apply() is called once per
//     snapshot meta apply, with either authored params (meta.env.sky) or
//     the snapshot defaults below.
//   - Owns its own DirectionalLight (sun) and HemisphereLight (fill) so
//     the scene reads with realistic outdoor shading without depending on
//     authored Max lights.
//
// Backend selection: pure WebGLRenderer cannot compile NodeMaterial, so
// we use the legacy ShaderMaterial-based `Sky`. WebGPURenderer (including
// forceWebGL fallback) can compile NodeMaterial -> use `SkyMesh`. Same
// rule live mode applies.

import * as THREE from 'three/webgpu';
import { Sky } from 'three/addons/objects/Sky.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

import { copyMaxComponentsToWorld } from './max_basis.js';

// Snapshot defaults - slightly more vibrant / cleaner than live's quick-
// fallback. Picked to read well on the container scene: late-morning sun
// angle, moderate haze, neutral exposure. Override per-scene by emitting
// `meta.env.sky` from the exporter.
export const SNAPSHOT_DEFAULT_SKY = Object.freeze({
    turbidity: 6,
    rayleigh: 1.2,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.7,
    elevation: 35,        // degrees above horizon
    azimuth: 220,         // degrees from north (compass)
    exposure: 0.6,
});

/**
 * Build a snapshot-mode sky controller. Idempotent: calling apply() with
 * the same params is a no-op (signature-compared).
 *
 * Returns:
 *   {
 *     apply(rawParams) -> { params, changed }
 *     dispose()
 *     mesh, sun, fill - read-only handles
 *   }
 */
export function createSky({ scene, renderer }) {
    if (!scene)    throw new Error('createSky: scene is required');
    if (!renderer) throw new Error('createSky: renderer is required');

    const useLegacy = !(renderer instanceof THREE.WebGPURenderer);

    let mesh = null;
    let sun = null;
    let fill = null;
    let lastSig = '';

    function ensureMesh() {
        if (mesh) return;
        mesh = useLegacy ? new Sky() : new SkyMesh();
        mesh.scale.setScalar(450000);
        mesh.name = '__maxjs_sky__';
        mesh.frustumCulled = false;
        mesh.userData.volumetricBoundsBypass = true;
        scene.add(mesh);
    }

    function ensureLights() {
        if (!sun) {
            sun = new THREE.DirectionalLight(0xffffff, 2.0);
            sun.name = '__maxjs_sky_sun__';
            sun.userData.volumetricBypass = true;
            scene.add(sun);
        }
        if (!fill) {
            fill = new THREE.HemisphereLight(0x87CEEB, 0x362D1B, 1.0);
            fill.name = '__maxjs_sky_fill__';
            fill.userData.volumetricBypass = true;
            scene.add(fill);
        }
    }

    function apply(rawParams) {
        const params = { ...SNAPSHOT_DEFAULT_SKY, ...(rawParams || {}) };
        const sig = JSON.stringify(params);
        if (sig === lastSig) return { params, changed: false };
        lastSig = sig;

        try {
            ensureMesh();
            ensureLights();

            const elevRad = THREE.MathUtils.degToRad(params.elevation);
            const azimRad = THREE.MathUtils.degToRad(params.azimuth);
            // Sun direction in Max basis (Z-up), then convert to world (Y-up).
            const sunDir = copyMaxComponentsToWorld(
                new THREE.Vector3(),
                Math.cos(elevRad) * Math.sin(azimRad),
                Math.cos(elevRad) * Math.cos(azimRad),
                Math.sin(elevRad),
            );

            if (useLegacy) {
                const u = mesh.material.uniforms;
                u.turbidity.value       = params.turbidity;
                u.rayleigh.value        = params.rayleigh;
                u.mieCoefficient.value  = params.mieCoefficient;
                u.mieDirectionalG.value = params.mieDirectionalG;
                u.up.value.set(0, 1, 0);
                u.sunPosition.value.copy(sunDir);
            } else {
                mesh.turbidity.value       = params.turbidity;
                mesh.rayleigh.value        = params.rayleigh;
                mesh.mieCoefficient.value  = params.mieCoefficient;
                mesh.mieDirectionalG.value = params.mieDirectionalG;
                mesh.upUniform.value.set(0, 1, 0);
                mesh.sunPosition.value.copy(sunDir);
            }

            renderer.toneMappingExposure = params.exposure;

            // Sky mesh renders the background; clear scene.background so we
            // don't overpaint a flat color on top of the sky shader.
            scene.background = null;

            // Sun: warmer + stronger near zenith, dimmer + cooler near horizon.
            const sunStrength = Math.max(0.1, Math.sin(elevRad));
            const warmth = 1.0 - sunStrength * 0.2;
            sun.color.setRGB(1.0, warmth, warmth * 0.85);
            sun.intensity = 1.0 + sunStrength * 3.0;
            sun.position.copy(sunDir).multiplyScalar(200);

            // Hemisphere fill: scales with sun elevation so dusk doesn't blow.
            fill.intensity = 0.5 + sunStrength * 0.5;

            return { params, changed: true };
        } catch (err) {
            console.error('[scene_sky] apply failed:', err);
            return { params, changed: false, error: err };
        }
    }

    function dispose() {
        try { mesh?.parent?.remove(mesh); } catch {}
        try { sun?.parent?.remove(sun); } catch {}
        try { fill?.parent?.remove(fill); } catch {}
        try { mesh?.geometry?.dispose?.(); } catch {}
        try {
            const mat = mesh?.material;
            if (Array.isArray(mat)) mat.forEach(m => m?.dispose?.());
            else mat?.dispose?.();
        } catch {}
        mesh = null;
        sun = null;
        fill = null;
        lastSig = '';
    }

    return {
        apply,
        dispose,
        get mesh() { return mesh; },
        get sun() { return sun; },
        get fill() { return fill; },
    };
}
