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

const SKY_PROBE_DIRECTIONS = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0.58, 0.58, 0.58).normalize(),
    new THREE.Vector3(-0.58, 0.58, 0.58).normalize(),
    new THREE.Vector3(0.58, 0.58, -0.58).normalize(),
    new THREE.Vector3(-0.58, 0.58, -0.58).normalize(),
    new THREE.Vector3(0.58, -0.58, 0.58).normalize(),
    new THREE.Vector3(-0.58, -0.58, 0.58).normalize(),
    new THREE.Vector3(0.58, -0.58, -0.58).normalize(),
    new THREE.Vector3(-0.58, -0.58, -0.58).normalize(),
];

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
    let lightProbe = null;
    let pmremGenerator = null;
    let skyEnvTarget = null;
    let skyEnvMap = null;
    let skyEnvSourceTexture = null;
    let lastSig = '';
    let lastRawParams = null;
    let visible = true;
    let planetaryActive = false;
    const isWebGpuRenderer = typeof THREE.WebGPURenderer === 'function' && renderer instanceof THREE.WebGPURenderer;
    const rendererBackendLabel = String(renderer?.userData?.maxjsBackendLabel || '');
    const useLegacySky = !isWebGpuRenderer;
    const allowGeospatialSky = rendererBackendLabel
        ? rendererBackendLabel === 'WebGPU' || rendererBackendLabel.startsWith('WebGL')
        : isWebGpuRenderer;
    const linkedSunDirection = new THREE.Vector3();
    const linkedSunPosition = new THREE.Vector3();
    const linkedSunTarget = new THREE.Vector3();
    const skyProbeSH = new THREE.SphericalHarmonics3();
    const skyProbeBasis = new Array(9).fill(0);
    const skyProbeColor = new THREE.Vector3();
    const skyProbeSunColor = new THREE.Vector3();
    const skyReflectionDir = new THREE.Vector3();
    const skyReflectionColor = new THREE.Vector3();

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

    function ensureLightProbe() {
        if (lightProbe) return lightProbe;
        lightProbe = new THREE.LightProbe();
        lightProbe.name = '__maxjs_sky_probe__';
        lightProbe.intensity = 1.0;
        lightProbe.userData.volumetricBypass = true;
        scene.add(lightProbe);
        return lightProbe;
    }

    function setVisible(nextVisible) {
        visible = !!nextVisible;
        if (mesh) mesh.visible = visible;
        if (sun) sun.visible = visible;
        if (fill) fill.visible = visible;
        if (lightProbe) lightProbe.visible = visible;
        geospatialSky?.setVisible?.(visible);
        if (!visible) scene.background = new THREE.Color(0x353535);
    }

    function removeClassicObjects() {
        try { mesh?.parent?.remove(mesh); } catch {}
        try { sun?.parent?.remove(sun); } catch {}
        try { fill?.parent?.remove(fill); } catch {}
    }

    function removeLightProbe() {
        try { lightProbe?.parent?.remove(lightProbe); } catch {}
        lightProbe = null;
    }

    function getPMREMGenerator() {
        pmremGenerator ??= new THREE.PMREMGenerator(renderer);
        return pmremGenerator;
    }

    function disposeSkyEnvironment() {
        const oldMap = skyEnvMap;
        skyEnvMap = null;
        const oldTarget = skyEnvTarget;
        skyEnvTarget = null;
        const oldSource = skyEnvSourceTexture;
        skyEnvSourceTexture = null;
        if (oldMap && scene.environment === oldMap) scene.environment = null;
        try { oldTarget?.dispose?.(); } catch {}
        try {
            if (oldSource && oldSource !== oldMap) oldSource.dispose?.();
        } catch {}
    }

    function sampleSkyReflectionRadiance(direction, params, sunDir, target) {
        const up = THREE.MathUtils.clamp(direction.y * 0.5 + 0.5, 0, 1);
        const horizon = Math.pow(1.0 - Math.abs(direction.y), 1.6);
        const below = direction.y < 0 ? Math.min(1, -direction.y * 1.35) : 0;
        const sunDot = Math.max(direction.dot(sunDir), 0);
        const sunDisc = Math.pow(sunDot, 360);
        const sunGlow = Math.pow(sunDot, 18);
        const exposure = Math.max(0.25, numberOr(params?.exposure, SKY_FALLBACKS.exposure));
        const rayleigh = THREE.MathUtils.clamp(numberOr(params?.rayleigh, SKY_FALLBACKS.rayleigh), 0, 8) / 8;
        const turbidity = THREE.MathUtils.clamp(numberOr(params?.turbidity, SKY_FALLBACKS.turbidity), 0, 20) / 20;

        const zenithR = THREE.MathUtils.lerp(0.08, 0.18, turbidity);
        const zenithG = THREE.MathUtils.lerp(0.22, 0.34, rayleigh);
        const zenithB = THREE.MathUtils.lerp(0.72, 1.15, rayleigh);
        const horizonR = THREE.MathUtils.lerp(0.55, 0.92, turbidity);
        const horizonG = THREE.MathUtils.lerp(0.72, 0.78, turbidity);
        const horizonB = THREE.MathUtils.lerp(0.98, 0.58, turbidity);

        target.set(zenithR, zenithG, zenithB);
        target.lerp(skyProbeColor.set(horizonR, horizonG, horizonB), horizon);
        if (below > 0) {
            target.lerp(skyProbeColor.set(0.028, 0.03, 0.034), below);
        }
        target.addScaledVector(skyProbeSunColor.set(1.0, 0.78, 0.42), sunGlow * 0.9 + sunDisc * 8.0);
        return target.multiplyScalar(0.85 + exposure * 0.45);
    }

    function buildProceduralSkyEnvironment(params, sunDir) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 128;
        const context = canvas.getContext('2d', { willReadFrequently: false });
        if (!context) return null;
        const image = context.createImageData(canvas.width, canvas.height);
        const data = image.data;
        let ptr = 0;
        for (let y = 0; y < canvas.height; y++) {
            const v = (y + 0.5) / canvas.height;
            const phi = v * Math.PI;
            const sinPhi = Math.sin(phi);
            skyReflectionDir.y = Math.cos(phi);
            for (let x = 0; x < canvas.width; x++) {
                const u = (x + 0.5) / canvas.width;
                const theta = u * Math.PI * 2 - Math.PI;
                skyReflectionDir.x = sinPhi * Math.sin(theta);
                skyReflectionDir.z = sinPhi * Math.cos(theta);
                sampleSkyReflectionRadiance(skyReflectionDir, params, sunDir, skyReflectionColor);
                data[ptr++] = Math.round(255 * Math.pow(THREE.MathUtils.clamp(skyReflectionColor.x, 0, 1), 1 / 2.2));
                data[ptr++] = Math.round(255 * Math.pow(THREE.MathUtils.clamp(skyReflectionColor.y, 0, 1), 1 / 2.2));
                data[ptr++] = Math.round(255 * Math.pow(THREE.MathUtils.clamp(skyReflectionColor.z, 0, 1), 1 / 2.2));
                data[ptr++] = 255;
            }
        }
        context.putImageData(image, 0, 0);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.needsUpdate = true;

        try {
            const target = getPMREMGenerator().fromEquirectangular(texture);
            target.texture.name = 'MaxJSSkyReflectionProceduralPMREM';
            return { texture: target.texture, sourceTexture: texture, renderTarget: target };
        } catch (error) {
            texture.dispose?.();
            throw error;
        }
    }

    function disposeUnusedSkyEnvironmentResult(result) {
        try { result?.renderTarget?.dispose?.(); } catch {}
        try {
            if (result?.sourceTexture && result.sourceTexture !== result.texture) {
                result.sourceTexture.dispose?.();
            }
        } finally {
        }
    }

    function markEnvironmentMaterialsDirty() {
        scene.traverse((object) => {
            const material = object?.material;
            const materials = Array.isArray(material) ? material : (material ? [material] : []);
            for (const mat of materials) {
                if (!mat) continue;
                if (
                    mat.isMeshStandardMaterial ||
                    mat.isMeshPhysicalMaterial ||
                    mat.isMeshLambertMaterial ||
                    mat.isMeshPhongMaterial
                ) {
                    mat.needsUpdate = true;
                }
            }
        });
    }

    function updateSkyEnvironment(params, sunDir) {
        if (planetaryActive) {
            disposeSkyEnvironment();
            return;
        }

        const nextEnvironment = buildProceduralSkyEnvironment(params, sunDir);
        const nextMap = nextEnvironment?.texture ?? null;
        if (!nextMap) {
            disposeUnusedSkyEnvironmentResult(nextEnvironment);
            return;
        }

        disposeSkyEnvironment();
        skyEnvTarget = nextEnvironment.renderTarget ?? null;
        skyEnvMap = nextMap;
        skyEnvSourceTexture = nextEnvironment.sourceTexture ?? null;
        scene.environment = skyEnvMap;
        if ('environmentIntensity' in scene) scene.environmentIntensity = 1.0;
        markEnvironmentMaterialsDirty();
    }

    function sampleSkyProbeRadiance(direction, params, sunDir, target) {
        const up = THREE.MathUtils.clamp(direction.y * 0.5 + 0.5, 0, 1);
        const horizon = 1.0 - Math.abs(direction.y);
        const sunAmount = Math.pow(Math.max(direction.dot(sunDir), 0), 48);
        const exposure = Math.max(0.25, numberOr(params?.exposure, SKY_FALLBACKS.exposure));
        const sunStrength = Math.max(0.1, THREE.MathUtils.clamp(sunDir.y, -1, 1));

        target.set(0.06, 0.065, 0.07);
        target.lerp(skyProbeSunColor.set(0.22, 0.34, 0.58), Math.pow(up, 0.75));
        target.addScaledVector(skyProbeSunColor.set(0.55, 0.62, 0.72), horizon * 0.12);
        if (direction.y < 0) {
            target.lerp(skyProbeSunColor.set(0.055, 0.05, 0.04), Math.min(1, -direction.y * 0.9));
        }

        skyProbeSunColor.set(1.0, 0.82, 0.56).multiplyScalar(sunAmount * (0.25 + sunStrength * 0.35));
        target.add(skyProbeSunColor);
        return target.multiplyScalar(0.55 + exposure * 0.35);
    }

    function updateSkyAmbientLightProbe(params, sunDir) {
        const probe = ensureLightProbe();
        skyProbeSH.zero();
        const weight = (Math.PI * 4) / SKY_PROBE_DIRECTIONS.length;
        for (const direction of SKY_PROBE_DIRECTIONS) {
            THREE.SphericalHarmonics3.getBasisAt(direction, skyProbeBasis);
            sampleSkyProbeRadiance(direction, params, sunDir, skyProbeColor);
            for (let i = 0; i < 9; i++) {
                skyProbeSH.coefficients[i].addScaledVector(skyProbeColor, skyProbeBasis[i] * weight);
            }
        }
        probe.sh.copy(skyProbeSH);
        probe.intensity = 1.0;
        probe.visible = visible;
    }

    function update(_dt, elapsed, camera) {
        if (!planetaryActive) return;
        geospatialSky?.update({ camera, elapsedSeconds: elapsed });
    }

    function getDirectionalLightSunVector(light, target = linkedSunDirection) {
        if (!light?.isDirectionalLight || light.visible === false) return null;
        if (light.name === '__maxjs_sky_sun__' || light.name === '__maxjs_geospatial_sky_sun__') return null;
        if (light.userData?.maxjsHandle == null) return null;
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
        scene.updateMatrixWorld?.(true);
        scene.traverse((object) => {
            if (getDirectionalLightSunVector(object, target)) directional.push(object);
        });
        if (!directional.length) return null;
        const named = directional.find((light) => {
            const name = String(light.name || '').toLowerCase();
            return /\b(sun|sunlight|solar|daylight)\b/.test(name)
                || name.includes('sun')
                || name.includes('solar')
                || name.includes('daylight');
        });
        return getDirectionalLightSunVector(named || (directional.length === 1 ? directional[0] : null), target);
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

        const planetary = params.model === SKY_MODEL_PLANETARY && allowGeospatialSky;
        if (planetary) {
            removeClassicObjects();
            removeLightProbe();
            disposeSkyEnvironment();
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
        updateSkyEnvironment(params, sunDir);
        updateSkyAmbientLightProbe(params, sunDir);

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
        removeLightProbe();
        disposeSkyEnvironment();
        try { pmremGenerator?.dispose?.(); } catch {}
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
        lightProbe = null;
        pmremGenerator = null;
        skyEnvSourceTexture = null;
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
