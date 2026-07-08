// sky.js - procedural sky environment and sky-derived probe state.
import * as THREE from 'three';
import * as THREE_STD from 'three-std';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { createGeospatialSkyController } from '../geospatial_sky.js';

function createSky(deps = {}) {
        const skyProbeSH = new THREE.SphericalHarmonics3();
        const skyProbeBasis = new Array(9).fill(0);
        const skyProbeColor = new THREE.Vector3();
        const skyProbeSunColor = new THREE.Vector3();
        const skyReflectionDir = new THREE.Vector3();
        const skyReflectionColor = new THREE.Vector3();
        const skyProbeDirections = [
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

        // SkyMesh (TSL/NodeMaterial) for WebGPU + WebGL2-fallback backends.
        // Legacy Sky (ShaderMaterial) for pure WebGLRenderer — NodeMaterial can't compile there.
        let skyMesh = null;
        let skySunLight = null;
        let skyFillLight = null;
        let skyEnvMap = null;
        let skyPathTraceTexture = null;
        let lastSkySig = '';
        let lastSkySourceParams = null;
        let skyPlanetaryActive = false;
        const skyLinkedSunDirection = new THREE.Vector3();
        const skyLinkedSunPosition = new THREE.Vector3();
        const skyLinkedSunTarget = new THREE.Vector3();
        const skySunDirectionScratch = new THREE.Vector3();
        const SKY_MODEL_PLANETARY = 1;
        const SKY_DEFAULTS = Object.freeze({
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
        // Geospatial sky is supported by WebGPU and plain WebGL. Keep it out of
        // Force WebGL because that TSL path conflicts with post effects.
        const useLegacySky = !(deps.renderer instanceof THREE.WebGPURenderer);
        const allowGeospatialSky = deps.rendererBackendLabel === 'WebGPU'
            || String(deps.rendererBackendLabel || '').startsWith('WebGL');

        function addSkyProbeSample(direction, radiance, weight) {
            THREE.SphericalHarmonics3.getBasisAt(direction, skyProbeBasis);
            for (let i = 0; i < 9; i++) {
                skyProbeSH.coefficients[i].addScaledVector(radiance, skyProbeBasis[i] * weight);
            }
        }

        function sampleSkyProbeRadiance(direction, params, sunDir, target) {
            const up = THREE.MathUtils.clamp(direction.y * 0.5 + 0.5, 0, 1);
            const horizon = 1.0 - Math.abs(direction.y);
            const sunAmount = Math.pow(Math.max(direction.dot(sunDir), 0), 48);
            const exposure = Math.max(0.25, skyNumber(params?.exposure, 0.5));
            const sunStrength = Math.max(0.1, THREE.MathUtils.clamp(sunDir.y, -1, 1));

            target.set(0.06, 0.065, 0.07);
            target.lerp(new THREE.Vector3(0.22, 0.34, 0.58), Math.pow(up, 0.75));
            target.addScaledVector(new THREE.Vector3(0.55, 0.62, 0.72), horizon * 0.12);
            if (direction.y < 0) {
                target.lerp(new THREE.Vector3(0.055, 0.05, 0.04), Math.min(1, -direction.y * 0.9));
            }

            skyProbeSunColor.set(1.0, 0.82, 0.56).multiplyScalar(sunAmount * (0.25 + sunStrength * 0.35));
            target.add(skyProbeSunColor);
            return target.multiplyScalar(0.55 + exposure * 0.35);
        }

        function sampleSkyReflectionRadiance(direction, params, sunDir, target) {
            const up = THREE.MathUtils.clamp(direction.y * 0.5 + 0.5, 0, 1);
            const horizon = Math.pow(1.0 - Math.abs(direction.y), 1.6);
            const below = direction.y < 0 ? Math.min(1, -direction.y * 1.35) : 0;
            const sunDot = Math.max(direction.dot(sunDir), 0);
            const sunDisc = Math.pow(sunDot, 360);
            const sunGlow = Math.pow(sunDot, 18);
            const exposure = Math.max(0.25, skyNumber(params?.exposure, 0.5));
            const rayleigh = THREE.MathUtils.clamp(skyNumber(params?.rayleigh, 3), 0, 8) / 8;
            const turbidity = THREE.MathUtils.clamp(skyNumber(params?.turbidity, 10), 0, 20) / 20;

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

        function disposeSkyReflectionEnvironment() {
            if (!skyEnvMap) return;
            const oldSkyEnvMap = skyEnvMap;
            skyEnvMap = null;
            if (deps.scene.environment === oldSkyEnvMap) deps.scene.environment = null;
            if (deps.scene.background === oldSkyEnvMap) deps.scene.background = null;
            oldSkyEnvMap.dispose?.();
        }

        function disposeSkyPathTraceEnvironment() {
            if (!skyPathTraceTexture) return;
            const oldSkyPathTraceTexture = skyPathTraceTexture;
            skyPathTraceTexture = null;
            if (deps.scene.userData.maxjsPathTraceEnvironment === oldSkyPathTraceTexture) {
                deps.scene.userData.maxjsPathTraceEnvironment = null;
            }
            if (deps.scene.userData.maxjsPathTraceBackground === oldSkyPathTraceTexture) {
                deps.scene.userData.maxjsPathTraceBackground = null;
            }
            oldSkyPathTraceTexture.dispose?.();
        }

        function updateSkyPathTraceEnvironment(params, sunDir) {
            if (!deps.isPathTracingMode) return;
            const canvas = document.createElement('canvas');
            canvas.width = 384;
            canvas.height = 192;
            const ctx2d = canvas.getContext('2d', { willReadFrequently: false });
            if (!ctx2d) return;
            const image = ctx2d.createImageData(canvas.width, canvas.height);
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
            ctx2d.putImageData(image, 0, 0);

            const SkyTextureTHREE = deps.renderer?.isWebGLRenderer === true ? THREE_STD : THREE;
            const textureData = new Uint8Array(data);
            const texture = new SkyTextureTHREE.DataTexture(
                textureData,
                canvas.width,
                canvas.height,
                SkyTextureTHREE.RGBAFormat || THREE.RGBAFormat,
                SkyTextureTHREE.UnsignedByteType || THREE.UnsignedByteType,
            );
            texture.name = 'MaxJSSkyPathTraceEquirect';
            texture.colorSpace = SkyTextureTHREE.SRGBColorSpace || THREE.SRGBColorSpace;
            texture.mapping = SkyTextureTHREE.EquirectangularReflectionMapping || THREE.EquirectangularReflectionMapping;
            texture.flipY = false;
            texture.needsUpdate = true;

            disposeSkyPathTraceEnvironment();
            skyPathTraceTexture = texture;
            deps.scene.userData.maxjsPathTraceEnvironment = texture;
            deps.scene.userData.maxjsPathTraceBackground = texture;
        }

        function buildProceduralSkyReflectionEnvironment(params, sunDir) {
            const SkyTextureTHREE = deps.renderer?.isWebGLRenderer === true ? THREE_STD : THREE;
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 128;
            const ctx2d = canvas.getContext('2d', { willReadFrequently: false });
            if (!ctx2d) return null;
            const image = ctx2d.createImageData(canvas.width, canvas.height);
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
            ctx2d.putImageData(image, 0, 0);

            const texture = new SkyTextureTHREE.CanvasTexture(canvas);
            texture.colorSpace = SkyTextureTHREE.SRGBColorSpace || THREE.SRGBColorSpace;
            texture.mapping = SkyTextureTHREE.EquirectangularReflectionMapping || THREE.EquirectangularReflectionMapping;
            const envMap = deps.retainPMREMTexture(deps.pmremGenerator.fromEquirectangular(texture));
            texture.dispose?.();
            if (envMap) envMap.name = 'MaxJSSkyReflectionProceduralPMREM';
            return envMap;
        }

        function updateSkyReflectionEnvironment(params, sunDir) {
            const usesGeospatialSky = params?.model === SKY_MODEL_PLANETARY
                && allowGeospatialSky;
            if (deps.isPathTracingMode || usesGeospatialSky) {
                disposeSkyReflectionEnvironment();
                return;
            }
            const nextEnvMap = buildProceduralSkyReflectionEnvironment(params, sunDir);
            if (!nextEnvMap) return;

            disposeSkyReflectionEnvironment();
            skyEnvMap = nextEnvMap;
            deps.scene.environment = skyEnvMap;
            deps.scene.environmentIntensity = 1.0;
            deps.syncMaterialEnvMaps();
        }

        function updateSkyAmbientLightProbe(params, sunDir) {
            if (deps.isPathTracingMode) {
                deps.clearLightProbe();
                return;
            }
            if (deps.lightProbeGrid) {
                if (deps.lightProbeGrid.parent) deps.lightProbeGrid.parent.remove(deps.lightProbeGrid);
                deps.lightProbeGrid.dispose?.();
                deps.lightProbeGrid = null;
            }
            skyProbeSH.zero();
            const weight = (Math.PI * 4) / skyProbeDirections.length;
            for (const direction of skyProbeDirections) {
                addSkyProbeSample(direction, sampleSkyProbeRadiance(direction, params, sunDir, skyProbeColor), weight);
            }
            deps.lightProbe.sh.copy(skyProbeSH);
            deps.hasLightProbeData = true;
            deps.hasLightProbeGridData = false;
            deps.applyLightProbeState();
        }

        function skyNumber(value, fallback) {
            const n = Number(value);
            return Number.isFinite(n) ? n : fallback;
        }

        function hasAuthoredEnvironmentActive() {
            return !!(deps.skyActive || deps.currentEnvParams?.hdri);
        }

        function restoreAuthoredEnvironmentAfterLocalHDRIChange() {
            if (deps.skyActive && lastSkySourceParams) {
                lastSkySig = '';
                applySky(lastSkySourceParams);
                return true;
            }
            if (deps.currentEnvParams?.hdri) {
                deps.loadHDRI(deps.currentEnvParams, { forceProbeRefresh: true });
                return true;
            }
            return false;
        }

        function normalizeSkyParams(rawParams) {
            const params = { ...SKY_DEFAULTS, ...(rawParams || {}) };
            params.turbidity = skyNumber(params.turbidity, SKY_DEFAULTS.turbidity);
            params.rayleigh = skyNumber(params.rayleigh, SKY_DEFAULTS.rayleigh);
            params.mieCoefficient = skyNumber(params.mieCoefficient, SKY_DEFAULTS.mieCoefficient);
            params.mieDirectionalG = skyNumber(params.mieDirectionalG, SKY_DEFAULTS.mieDirectionalG);
            params.elevation = skyNumber(params.elevation, SKY_DEFAULTS.elevation);
            params.azimuth = skyNumber(params.azimuth, SKY_DEFAULTS.azimuth);
            params.exposure = skyNumber(params.exposure, SKY_DEFAULTS.exposure);
            params.model = Math.trunc(skyNumber(params.model, SKY_DEFAULTS.model));
            params.showSunDisc = params.showSunDisc !== false && params.showSunDisc !== 0;
            params.cameraAltitude = Math.max(0, skyNumber(params.cameraAltitude, SKY_DEFAULTS.cameraAltitude));
            return params;
        }

        function getSkySunDirectionWorld(params, target = skySunDirectionScratch) {
            if (Array.isArray(params?.sunDirectionWorld)) {
                target.set(
                    Number(params.sunDirectionWorld[0]),
                    Number(params.sunDirectionWorld[1]),
                    Number(params.sunDirectionWorld[2])
                );
                if (target.lengthSq() > 1e-8) return target.normalize();
            }
            const elevRad = THREE.MathUtils.degToRad(skyNumber(params?.elevation, SKY_DEFAULTS.elevation));
            const azimRad = THREE.MathUtils.degToRad(skyNumber(params?.azimuth, SKY_DEFAULTS.azimuth));
            return deps.copyMaxComponentsToWorld(target,
                Math.cos(elevRad) * Math.sin(azimRad),
                Math.cos(elevRad) * Math.cos(azimRad),
                Math.sin(elevRad)
            ).normalize();
        }

        function isSkyLinkCandidateLight(light) {
            if (!light?.isDirectionalLight || light.userData?.maxjsVisible === false) return false;
            if (light.name === '__maxjs_sky_sun__' || light.name === '__maxjs_geospatial_sky_sun__') return false;
            return light.userData?.maxjsHandle != null;
        }

        function getDirectionalLightSunVector(light, target = new THREE.Vector3()) {
            if (!light) return null;
            light.updateMatrixWorld?.();
            light.target?.updateMatrixWorld?.();
            skyLinkedSunPosition.setFromMatrixPosition(light.matrixWorld);
            if (light.target?.matrixWorld) skyLinkedSunTarget.setFromMatrixPosition(light.target.matrixWorld);
            else skyLinkedSunTarget.set(0, 0, 0);
            target.copy(skyLinkedSunPosition).sub(skyLinkedSunTarget);
            return target.lengthSq() > 1.0e-8 ? target.normalize() : null;
        }

        function findSkyLinkedSunDirection(target = skyLinkedSunDirection) {
            const directional = [];
            for (const light of deps.lightHandleMap.values()) {
                if (isSkyLinkCandidateLight(light)) directional.push(light);
            }
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

        function withLinkedSkySun(rawParams) {
            const linkedDir = findSkyLinkedSunDirection();
            if (!linkedDir) return rawParams;
            const snap = (value) => Math.round(value * 10000) / 10000;
            return {
                ...(rawParams || {}),
                sunDirectionWorld: [snap(linkedDir.x), snap(linkedDir.y), snap(linkedDir.z)],
                sunLinkedLight: true,
            };
        }

        function updateSkyTime(elapsedSeconds) {
            if (!deps.skyActive || !skyPlanetaryActive) return;
            deps.geospatialSky?.update({ camera: deps.camera, elapsedSeconds });
        }

        function refreshSkyFromLinkedSun() {
            if (!deps.skyActive || !lastSkySourceParams) return false;
            const beforeSig = lastSkySig;
            applySky(lastSkySourceParams);
            return beforeSig !== lastSkySig;
        }

        function refreshSkyAmbientLightProbeFromCurrentSky() {
            if (!deps.skyActive || !lastSkySourceParams) return false;
            const params = normalizeSkyParams(withLinkedSkySun(lastSkySourceParams));
            const sunDir = getSkySunDirectionWorld(params, skySunDirectionScratch);
            if (params.model === SKY_MODEL_PLANETARY && allowGeospatialSky) {
                deps.clearLightProbe();
                deps.hasLightProbeData = true;
                disposeSkyReflectionEnvironment();
                if (skyEnvMap && deps.scene.environment === skyEnvMap) deps.scene.environment = null;
                deps.scene.environmentIntensity = 1.0;
                deps.applyHdriReflectionOnlyState();
                deps.currentHdriProbeSignature = JSON.stringify([
                    'geospatial-probe',
                    params.model,
                    params.exposure,
                    params.elevation,
                    params.azimuth,
                    params.sunDirectionWorld || null,
                ]);
                return true;
            }
            updateSkyAmbientLightProbe(params, sunDir);
            if (!skyEnvMap || deps.scene.environment !== skyEnvMap) {
                updateSkyReflectionEnvironment(params, sunDir);
            }
            deps.currentHdriProbeSignature = JSON.stringify([
                'sky-probe',
                params.model,
                params.exposure,
                params.elevation,
                params.azimuth,
                params.sunDirectionWorld || null,
            ]);
            return true;
        }

        function removeClassicSkyObjects() {
            if (skyMesh?.parent) skyMesh.parent.remove(skyMesh);
            if (skySunLight?.parent) skySunLight.parent.remove(skySunLight);
            if (skyFillLight?.parent) skyFillLight.parent.remove(skyFillLight);
        }

        function applySky(skyParams) {
            if (!skyParams) return;
            lastSkySourceParams = skyParams;

            const params = normalizeSkyParams(withLinkedSkySun(skyParams));
            const sig = JSON.stringify(params);
            if (sig === lastSkySig) {
                if (!deps.hasLightProbeData) refreshSkyAmbientLightProbeFromCurrentSky();
                return;
            }
            lastSkySig = sig;

            try {
                const planetary = params.model === SKY_MODEL_PLANETARY && allowGeospatialSky;
                if (planetary) {
                    removeClassicSkyObjects();
                    deps.geospatialSky ??= createGeospatialSkyController({
                        scene: deps.scene,
                        renderer: deps.renderer,
                        backendLabel: deps.rendererBackendLabel,
                        fallbackBackground: deps.hiddenBackgroundColor,
                    });

                    deps.clearCurrentHdriEnvMap();
                    disposeSkyReflectionEnvironment();
                    disposeSkyPathTraceEnvironment();
                    deps.scene.environment = null;
                    deps.scene.environmentIntensity = 1.0;
                    deps.syncMaterialEnvMaps();
                    deps.scene.environmentRotation.set(0, 0, 0);
                    deps.scene.backgroundRotation.set(0, 0, 0);

                    deps.geospatialSky.apply(params, { camera: deps.camera });
                    deps.applyCoreToneMappingState({ markOutput: false });
                    deps.syncDefaultLightsVisibility();
                    deps.clearLightProbe();
                    deps.hasLightProbeData = true;
                    deps.skyActive = true;
                    skyPlanetaryActive = true;
                    deps.applyHdriReflectionOnlyState();
                    deps.currentHdriUrl = null;
                    deps.currentHdriProbeSignature = '';
                    deps.maxjsFx.markEnvironmentChanged?.();
                    deps.syncHdriPanel();
                    return;
                }

                deps.geospatialSky?.dispose();
                deps.geospatialSky = null;
                skyPlanetaryActive = false;

                if (!skyMesh) {
                    skyMesh = useLegacySky ? new Sky() : new SkyMesh();
                    skyMesh.scale.setScalar(450000);
                    skyMesh.name = '__maxjs_sky__';
                    skyMesh.frustumCulled = false;
                    skyMesh.userData.volumetricBoundsBypass = true;
                }

                const sunDir = getSkySunDirectionWorld(params, skySunDirectionScratch);

                if (useLegacySky) {
                    const u = skyMesh.material.uniforms;
                    u.turbidity.value = params.turbidity;
                    u.rayleigh.value = params.rayleigh;
                    u.mieCoefficient.value = params.mieCoefficient;
                    u.mieDirectionalG.value = params.mieDirectionalG;
                    u.up.value.set(0, 1, 0);
                    u.sunPosition.value.copy(sunDir);
                } else {
                    skyMesh.turbidity.value = params.turbidity;
                    skyMesh.rayleigh.value = params.rayleigh;
                    skyMesh.mieCoefficient.value = params.mieCoefficient;
                    skyMesh.mieDirectionalG.value = params.mieDirectionalG;
                    skyMesh.upUniform.value.set(0, 1, 0);
                    skyMesh.sunPosition.value.copy(sunDir);
                }

                deps.renderer.toneMappingExposure = params.exposure;
                // Keep the user-selected Post FX tonemapper/exposure authoritative.
                deps.applyCoreToneMappingState({ markOutput: false });

                if (skyMesh.parent !== deps.scene) deps.scene.add(skyMesh);

                deps.clearCurrentHdriEnvMap();

                // The sky mesh is the environment surface. Keep the scene
                // background transparent so it never enters Bloom/SSGI as a
                // matte when the environment backdrop is hidden.
                deps.scene.background = null;
                updateSkyReflectionEnvironment(params, sunDir);
                updateSkyPathTraceEnvironment(params, sunDir);
                deps.scene.environmentRotation.set(0, 0, 0);
                deps.scene.backgroundRotation.set(0, 0, 0);

                // Sun DirectionalLight along sun direction
                if (!skySunLight) {
                    skySunLight = new THREE.DirectionalLight(0xffffff, 2.0);
                    skySunLight.name = '__maxjs_sky_sun__';
                    skySunLight.userData.volumetricBypass = true;
                }
                if (skySunLight.parent !== deps.scene) deps.scene.add(skySunLight);
                const sunStrength = Math.max(0.1, THREE.MathUtils.clamp(sunDir.y, -1, 1));
                const warmth = 1.0 - sunStrength * 0.2;
                skySunLight.color.setRGB(1.0, warmth, warmth * 0.85);
                skySunLight.intensity = 1.0 + sunStrength * 3.0;
                skySunLight.position.copy(sunDir).multiplyScalar(200);

                // Sky fill HemisphereLight
                if (!skyFillLight) {
                    skyFillLight = new THREE.HemisphereLight(0x87CEEB, 0x362D1B, 1.0);
                    skyFillLight.name = '__maxjs_sky_fill__';
                    skyFillLight.userData.volumetricBypass = true;
                }
                if (skyFillLight.parent !== deps.scene) deps.scene.add(skyFillLight);
                skyFillLight.intensity = 0.5 + sunStrength * 0.5;

                deps.syncDefaultLightsVisibility();
                updateSkyAmbientLightProbe(params, sunDir);
                deps.skyActive = true;
                deps.applyHdriReflectionOnlyState();

                // Clear HDRI state
                deps.currentHdriUrl = null;
                deps.currentHdriProbeSignature = '';

                deps.maxjsFx.markEnvironmentChanged?.();
                deps.syncHdriPanel();

            } catch (err) {
                console.error('[max.js] applySky error:', err);
            }
        }

        function removeSky() {
            lastSkySig = '';
            deps.skyActive = false;
            skyPlanetaryActive = false;
            deps.geospatialSky?.dispose();
            deps.geospatialSky = null;
            if (skyMesh?.parent) skyMesh.parent.remove(skyMesh);
            if (skySunLight?.parent) skySunLight.parent.remove(skySunLight);
            if (skyFillLight?.parent) skyFillLight.parent.remove(skyFillLight);
            disposeSkyReflectionEnvironment();
            disposeSkyPathTraceEnvironment();
        }

        return {
            addSkyProbeSample,
            sampleSkyProbeRadiance,
            sampleSkyReflectionRadiance,
            disposeSkyReflectionEnvironment,
            disposeSkyPathTraceEnvironment,
            updateSkyPathTraceEnvironment,
            buildProceduralSkyReflectionEnvironment,
            updateSkyReflectionEnvironment,
            updateSkyAmbientLightProbe,
            skyNumber,
            hasAuthoredEnvironmentActive,
            restoreAuthoredEnvironmentAfterLocalHDRIChange,
            normalizeSkyParams,
            getSkySunDirectionWorld,
            isSkyLinkCandidateLight,
            getDirectionalLightSunVector,
            findSkyLinkedSunDirection,
            withLinkedSkySun,
            updateSkyTime,
            refreshSkyFromLinkedSun,
            refreshSkyAmbientLightProbeFromCurrentSky,
            removeClassicSkyObjects,
            applySky,
            removeSky,
        };
}

export { createSky };
