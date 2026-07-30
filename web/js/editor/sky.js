// sky.js - procedural sky environment and sky-derived probe state.
import * as THREE from 'three';
import * as THREE_STD from 'three-std';
import { uniform, vec4 } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { Sky } from 'three/addons/objects/Sky.js';

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
        // PostFX owns renderer.toneMappingExposure, so the sky dome carries
        // its own exposure multiplier.
        const skyDomeExposureUniform = uniform(1.0);
        let skySunLight = null;
        let skyFillLight = null;
        let skyEnvMap = null;
        let skyPathTraceTexture = null;
        let lastSkySig = '';
        let lastSkySourceParams = null;
        const skyLinkedSunDirection = new THREE.Vector3();
        const skyLinkedSunPosition = new THREE.Vector3();
        const skyLinkedSunTarget = new THREE.Vector3();
        const skySunDirectionScratch = new THREE.Vector3();
        const skyGiSunDirectionScratch = new THREE.Vector3();
        const SPECTRAL_GI_SKY_INTENSITY = 2.0;
        const SKY_DEFAULTS = Object.freeze({
            turbidity: 10,
            rayleigh: 3,
            mieCoefficient: 0.005,
            mieDirectionalG: 0.7,
            elevation: 2,
            azimuth: 180,
            exposure: 0.5,
            showSunDisc: true,
        });
        const useLegacySky = !(deps.renderer instanceof THREE.WebGPURenderer);

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
            if (!deps.isPathTracingMode) {
                disposeSkyPathTraceEnvironment();
                return;
            }
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
            if (deps.isPathTracingMode) {
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

        // Linear brightness scale for the dome and the DDGI sky, normalized so
        // the default spinner value (0.5) keeps the shipped look.
        function skyExposureScale(params) {
            const exposure = Math.max(0, skyNumber(params?.exposure, SKY_DEFAULTS.exposure));
            return exposure / SKY_DEFAULTS.exposure;
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
            params.showSunDisc = params.showSunDisc !== false && params.showSunDisc !== 0;
            return params;
        }

        // Match Speedball's DDGI sky: a low-frequency, sun-free dome that only
        // enters probe miss rays. The directional light owns the sun itself.
        function buildSpectralGiSky(params) {
            const sunDirection = getSkySunDirectionWorld(params, skyGiSunDirectionScratch);
            const elevation = THREE.MathUtils.clamp(
                THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDirection.y, -1, 1))),
                0,
                88,
            );
            const sunUp = THREE.MathUtils.clamp(Math.sin(THREE.MathUtils.degToRad(elevation)), 0, 1);
            const daylight = Math.sqrt(sunUp);
            const rayleigh = THREE.MathUtils.clamp(skyNumber(params?.rayleigh, 3) / 8, 0, 1);
            const turbidity = THREE.MathUtils.clamp(skyNumber(params?.turbidity, 10) / 20, 0, 1);
            const haze = THREE.MathUtils.clamp((1 - daylight) * 0.65 + turbidity * 0.35, 0, 1);
            const exposureScale = skyExposureScale(params);

            return {
                zenith: new THREE.Color(
                    0.10 + 0.12 * rayleigh,
                    0.20 + 0.20 * rayleigh,
                    0.42 + 0.34 * rayleigh,
                ).multiplyScalar((0.18 + 0.62 * daylight) * exposureScale),
                horizon: new THREE.Color(
                    0.34 + 0.34 * haze,
                    0.39 + 0.18 * daylight,
                    0.48 + 0.24 * daylight,
                ).multiplyScalar((0.16 + 0.50 * daylight) * exposureScale),
                ground: new THREE.Color(0.10, 0.085, 0.065).multiplyScalar((0.06 + 0.16 * daylight) * exposureScale),
            };
        }

        function syncSpectralGiSky(params) {
            if (!deps.isStudioMode || !deps.haloGi?.setSky) return false;
            if (!params) {
                deps.haloGi.setSky(null);
                return false;
            }
            deps.haloGi.setSky(buildSpectralGiSky(params), { intensity: SPECTRAL_GI_SKY_INTENSITY });
            return true;
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
            if (light.name === '__maxjs_sky_sun__') return false;
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
            updateSkyAmbientLightProbe(params, sunDir);
            if (!skyEnvMap || deps.scene.environment !== skyEnvMap) {
                updateSkyReflectionEnvironment(params, sunDir);
            }
            deps.currentHdriProbeSignature = JSON.stringify([
                'sky-probe',
                params.exposure,
                params.elevation,
                params.azimuth,
                params.sunDirectionWorld || null,
            ]);
            return true;
        }

        function applySky(skyParams) {
            if (!skyParams) return;
            lastSkySourceParams = skyParams;

            const params = normalizeSkyParams(withLinkedSkySun(skyParams));
            syncSpectralGiSky(params);
            const sig = JSON.stringify(params);
            if (sig === lastSkySig) {
                if (!deps.hasLightProbeData) refreshSkyAmbientLightProbeFromCurrentSky();
                return;
            }
            lastSkySig = sig;

            try {
                if (!skyMesh) {
                    skyMesh = useLegacySky ? new Sky() : new SkyMesh();
                    skyMesh.scale.setScalar(450000);
                    skyMesh.name = '__maxjs_sky__';
                    skyMesh.frustumCulled = false;
                    skyMesh.userData.volumetricBoundsBypass = true;
                    if (!useLegacySky) {
                        const baseColorNode = skyMesh.material.colorNode;
                        skyMesh.material.colorNode = vec4(
                            baseColorNode.rgb.mul(skyDomeExposureUniform),
                            baseColorNode.a,
                        );
                    }
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

                // The Post FX tonemapper/exposure stays authoritative for the
                // frame; sky exposure scales only the dome + probe sky inputs.
                skyDomeExposureUniform.value = skyExposureScale(params);
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
                skyFillLight.intensity = deps.isStudioMode ? 0.05 : 0.5 + sunStrength * 0.5;

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
            if (skyMesh?.parent) skyMesh.parent.remove(skyMesh);
            if (skySunLight?.parent) skySunLight.parent.remove(skySunLight);
            if (skyFillLight?.parent) skyFillLight.parent.remove(skyFillLight);
            disposeSkyReflectionEnvironment();
            disposeSkyPathTraceEnvironment();
            syncSpectralGiSky(null);
        }

        function refreshSkyForSpectralView() {
            if (!deps.isStudioMode) return false;
            if (!deps.skyActive || !lastSkySourceParams) {
                syncSpectralGiSky(null);
                return false;
            }
            // Probe view needs the PMREM for reflections; Trace needs the raw
            // equirectangular texture. Re-run even when sky params are unchanged.
            lastSkySig = '';
            applySky(lastSkySourceParams);
            return true;
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
            buildSpectralGiSky,
            syncSpectralGiSky,
            getSkySunDirectionWorld,
            isSkyLinkCandidateLight,
            getDirectionalLightSunVector,
            findSkyLinkedSunDirection,
            withLinkedSkySun,
            refreshSkyFromLinkedSun,
            refreshSkyAmbientLightProbeFromCurrentSky,
            applySky,
            removeSky,
            refreshSkyForSpectralView,
        };
}

export { createSky };
