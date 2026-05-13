import * as THREE from 'three';
import * as THREE_STD from 'three-std';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

import { copyMaxComponentsToWorld } from './max_basis.js';

const GEODETIC_LONGITUDE = 0;
const GEODETIC_LATITUDE = 67;
const DEFAULT_ALTITUDE_METERS = 1200;
const FALLBACK_BACKGROUND = 0x353535;
const ASSET_ROOT_URL = new URL('../node_modules/@takram/three-atmosphere/assets/', import.meta.url).href;
// takram SkyMaterial outputs raw HDR luminance. We tone-map it inside the
// shader (see patchSkyMaterialForToneMapping) at this exposure multiplier so
// the sky lands in a visible range without compressing the rest of the scene.
const WEBGL_ATMOSPHERE_EXPOSURE_BOOST = 10.0;
const WEBGL_ATMOSPHERE_ENV_INTENSITY_FLOOR = 1.0;
const WEBGPU_ATMOSPHERE_EXPOSURE_BOOST = 3.5;
const WEBGPU_ATMOSPHERE_ENV_INTENSITY_FLOOR = 2.0;

// NeutralToneMapping + Linear→sRGB encoding, injected into takram's SkyMaterial
// fragment shader. Three.js doesn't auto-inject tone-mapping or colorspace
// conversion into RawShaderMaterial-derived shaders, so without this the sky
// is rendered as clamped raw radiance.
const SKY_TONEMAP_PATCH_GLSL = `
uniform float maxjsToneMappingExposure;

vec3 maxjsToneMappingNeutral(vec3 color) {
    float StartCompression = 0.8 - 0.04;
    float Desaturation = 0.15;
    color *= maxjsToneMappingExposure;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < StartCompression) return color;
    float d = 1.0 - StartCompression;
    float newPeak = 1.0 - d * d / (peak + d - StartCompression);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
}

vec3 maxjsLinearToSRGB(vec3 color) {
    color = max(color, vec3(0.0));
    return mix(
        12.92 * color,
        1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055,
        step(vec3(0.0031308), color)
    );
}
`;

function patchSkyMaterialForToneMapping(material, state) {
    if (!material || material.userData?.maxjsToneMapped) return;
    material.userData = material.userData || {};
    material.userData.maxjsToneMapped = true;
    material.uniforms.maxjsToneMappingExposure = { value: 1.0 };

    let frag = material.fragmentShader;
    if (frag.includes('layout(location = 0) out vec4 outputColor;')) {
        frag = frag.replace(
            'layout(location = 0) out vec4 outputColor;',
            `layout(location = 0) out vec4 outputColor;\n${SKY_TONEMAP_PATCH_GLSL}`,
        );
    } else {
        frag = `${SKY_TONEMAP_PATCH_GLSL}\n${frag}`;
    }
    frag = frag.replace(
        /outputColor\.a\s*=\s*1\.0;/,
        `outputColor.rgb = maxjsToneMappingNeutral(outputColor.rgb);
         outputColor.rgb = maxjsLinearToSRGB(outputColor.rgb);
         outputColor.a = 1.0;`,
    );
    material.fragmentShader = frag;
    material.needsUpdate = true;

    const baseOnBeforeRender = material.onBeforeRender;
    material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
        if (typeof baseOnBeforeRender === 'function') {
            baseOnBeforeRender.call(material, renderer, scene, camera, geometry, object, group);
        }
        const uniform = material.uniforms?.maxjsToneMappingExposure;
        if (uniform) {
            uniform.value = state?.skyExposure ?? renderer?.toneMappingExposure ?? 1.0;
        }
    };
}

const scratchWorldToECEF = new THREE.Matrix4();
const scratchRotation = new THREE.Matrix4();
const scratchCameraPosition = new THREE.Vector3();
const scratchRotatedCamera = new THREE.Vector3();
const scratchECEFPosition = new THREE.Vector3();
const scratchSunWorld = new THREE.Vector3();
const scratchMoonECEF = new THREE.Vector3();
const scratchTranslation = new THREE.Vector3();
const scratchLightCenter = new THREE.Vector3();
const scratchLinkedSunWorld = new THREE.Vector3();

function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function altitudeFromParams(params) {
    if (Number.isFinite(params?.altitude)) return Math.max(0, Number(params.altitude));
    if (Number.isFinite(params?.cameraAltitude)) return Math.max(0, Number(params.cameraAltitude));
    return DEFAULT_ALTITUDE_METERS;
}

function readSunDirectionOverride(params, target) {
    const raw = params?.sunDirectionWorld || params?.linkedSunDirection || params?.sunDirection;
    if (!raw) return null;
    if (Array.isArray(raw) && raw.length >= 3) {
        target.set(Number(raw[0]), Number(raw[1]), Number(raw[2]));
    } else if (typeof raw === 'object') {
        target.set(Number(raw.x), Number(raw.y), Number(raw.z));
    } else {
        return null;
    }
    return target.lengthSq() > 1.0e-8 ? target.normalize() : null;
}

function getSunDirectionWorld(params, target = new THREE.Vector3()) {
    const linked = readSunDirectionOverride(params, target);
    if (linked) return linked;
    const elevation = THREE.MathUtils.degToRad(numberOr(params?.elevation, 2));
    const azimuth = THREE.MathUtils.degToRad(numberOr(params?.azimuth, 180));
    return copyMaxComponentsToWorld(
        target,
        Math.cos(elevation) * Math.sin(azimuth),
        Math.cos(elevation) * Math.cos(azimuth),
        Math.sin(elevation),
    ).normalize();
}

function disposeMaterial(material) {
    if (Array.isArray(material)) {
        material.forEach((entry) => entry?.dispose?.());
    } else {
        material?.dispose?.();
    }
}

function removeNamedObject(scene, name) {
    if (!scene || !name) return;
    const matches = [];
    scene.traverse((object) => {
        if (object?.name === name) matches.push(object);
    });
    for (const object of matches) {
        object.parent?.remove(object);
        try { object.geometry?.dispose?.(); } catch {}
        try { disposeMaterial(object.material); } catch {}
        try { disposeMaterial(object.customDepthMaterial); } catch {}
        try { disposeMaterial(object.customDistanceMaterial); } catch {}
    }
}

function materialListHasRawShader(material) {
    if (Array.isArray(material)) return material.some((entry) => entry?.isRawShaderMaterial);
    return !!material?.isRawShaderMaterial;
}

function removeRawShaderObjects(scene) {
    if (!scene) return;
    const matches = [];
    scene.traverse((object) => {
        if (!object?.parent) return;
        if (
            materialListHasRawShader(object.material)
            || materialListHasRawShader(object.customDepthMaterial)
            || materialListHasRawShader(object.customDistanceMaterial)
        ) {
            matches.push(object);
        }
    });
    for (const object of matches) {
        object.parent?.remove(object);
        try { object.geometry?.dispose?.(); } catch {}
        try { disposeMaterial(object.material); } catch {}
        try { disposeMaterial(object.customDepthMaterial); } catch {}
        try { disposeMaterial(object.customDistanceMaterial); } catch {}
    }
}

function removeWebGPUIncompatibleObjects(state) {
    removeRawShaderObjects(state.scene);
    removeNamedObject(state.scene, '__maxjs_sky__');
    removeNamedObject(state.scene, '__maxjs_geospatial_sky__');
    disposeBackdropSky(state);

    if (state.webglMesh?.parent) state.webglMesh.parent.remove(state.webglMesh);

    state.webglMesh = null;
    state.webglMaterial = null;
}

function buildWorldToECEFMatrix({ camera, params, geospatial, target = new THREE.Matrix4() }) {
    const altitude = altitudeFromParams(params);
    const positionECEF = new geospatial.Geodetic(
        geospatial.radians(GEODETIC_LONGITUDE),
        geospatial.radians(GEODETIC_LATITUDE),
        altitude,
    ).toECEF(scratchECEFPosition);

    geospatial.Ellipsoid.WGS84.getNorthUpEastFrame(positionECEF, target);
    scratchRotation.copy(target).setPosition(0, 0, 0);

    if (camera) {
        camera.updateMatrixWorld?.();
        scratchCameraPosition.setFromMatrixPosition(camera.matrixWorld);
    } else {
        scratchCameraPosition.set(0, 0, 0);
    }
    scratchRotatedCamera.copy(scratchCameraPosition).applyMatrix4(scratchRotation);
    scratchTranslation.copy(positionECEF).sub(scratchRotatedCamera);
    target.setPosition(scratchTranslation);
    return target;
}

function updatePhysicalLights(state, params) {
    const sunWorld = getSunDirectionWorld(params, scratchSunWorld);
    const sunStrength = Math.max(0.1, THREE.MathUtils.clamp(sunWorld.y, -1, 1));
    const warmth = 1.0 - sunStrength * 0.2;
    const exposure = numberOr(params?.exposure, 0.5);
    const lightBoost = THREE.MathUtils.clamp(1.0 + exposure * 1.8, 1.4, 3.2);
    if (state.camera) {
        state.camera.updateMatrixWorld?.();
        scratchLightCenter.setFromMatrixPosition(state.camera.matrixWorld);
    } else {
        scratchLightCenter.set(0, 0, 0);
    }

    if (!state.sunLight) {
        state.sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
        state.sunLight.name = '__maxjs_geospatial_sky_sun__';
        state.sunLight.target.name = '__maxjs_geospatial_sky_sun_target__';
        state.sunLight.userData.volumetricBypass = true;
        state.scene.add(state.sunLight);
        state.scene.add(state.sunLight.target);
    }
    state.sunLight.visible = state.visible;
    state.sunLight.color.setRGB(1.0, warmth, warmth * 0.85);
    state.sunLight.intensity = (1.8 + sunStrength * 5.0) * lightBoost;
    state.sunLight.target.position.set(scratchLightCenter.x, 0, scratchLightCenter.z);
    state.sunLight.position.copy(state.sunLight.target.position).addScaledVector(sunWorld, 15000);
    state.sunLight.castShadow = false;

    if (!state.fillLight) {
        state.fillLight = new THREE.HemisphereLight(0x87ceeb, 0x111111, 0.9);
        state.fillLight.name = '__maxjs_geospatial_sky_fill__';
        state.fillLight.userData.volumetricBypass = true;
        state.scene.add(state.fillLight);
    }
    state.fillLight.visible = state.visible;
    state.fillLight.intensity = (0.85 + sunStrength * 1.35) * lightBoost;
}

function applySunToECEF(target, params, worldToECEF) {
    getSunDirectionWorld(params, scratchSunWorld);
    target.copy(scratchSunWorld).transformDirection(worldToECEF).normalize();
    return target;
}

function rendererUsesLegacyWebGL(renderer) {
    return renderer?.isWebGLRenderer === true;
}

function rendererUsesForcedWebGL(state) {
    const label = String(state.backendLabel || state.renderer?.userData?.maxjsBackendLabel || '');
    return !rendererUsesLegacyWebGL(state.renderer)
        && (label === 'WGL2 Fallback' || label.includes('Fallback'));
}

function ensureSkyLightProbe(state, atmosphere, textures = null) {
    if (!atmosphere?.SkyLightProbe) return;
    if (!state.skyLightProbe) {
        state.skyLightProbe = new atmosphere.SkyLightProbe({
            irradianceTexture: textures?.irradianceTexture ?? null,
        });
        state.skyLightProbe.name = '__maxjs_geospatial_sky_light_probe__';
        state.skyLightProbe.userData.volumetricBypass = true;
        state.skyLightProbe.userData.maxjsExcludeFromRuntimeSnapshot = true;
    } else if (textures?.irradianceTexture) {
        state.skyLightProbe.irradianceTexture = textures.irradianceTexture;
    }
    if (state.skyLightProbe.parent !== state.scene) state.scene.add(state.skyLightProbe);
}

function assignWebGLAtmosphereTextures(state, textures) {
    state.webglTextures = textures || null;
    for (const material of [state.webglMaterial, state.skyEnvironmentMaterial]) {
        if (!material || !textures) continue;
        Object.assign(material, textures);
        material.needsUpdate = true;
    }
}

function disposeSkyEnvironmentCapture(state) {
    if (state.scene?.environment === state.skyEnvironmentTexture) {
        state.scene.environment = null;
    }
    try { state.skyEnvironmentPmremTarget?.dispose?.(); } catch {}
    try { state.skyEnvironmentCubeTarget?.dispose?.(); } catch {}
    try { state.skyEnvironmentPmremGenerator?.dispose?.(); } catch {}
    try { state.skyEnvironmentMaterial?.dispose?.(); } catch {}
    try { state.skyEnvironmentMesh?.geometry?.dispose?.(); } catch {}
    state.skyEnvironmentPmremTarget = null;
    state.skyEnvironmentTexture = null;
    state.skyEnvironmentCubeTarget = null;
    state.skyEnvironmentCubeCamera = null;
    state.skyEnvironmentPmremGenerator = null;
    state.skyEnvironmentMaterial = null;
    state.skyEnvironmentMesh = null;
    state.skyEnvironmentSignature = '';
}

function ensureSkyEnvironmentCapture(state, atmosphere, geospatial) {
    if (!rendererUsesLegacyWebGL(state.renderer) || !atmosphere?.SkyMaterial || !geospatial?.QuadGeometry) return;
    if (state.skyEnvironmentMesh) return;

    const material = new atmosphere.SkyMaterial({
        ground: true,
        moon: false,
        groundAlbedo: new THREE.Color(0.045, 0.055, 0.05),
    });
    material.name = 'MaxJSGeospatialSkyEnvironmentMaterial';
    material.sun = false;
    material.moon = false;

    const mesh = new THREE.Mesh(new geospatial.QuadGeometry(), material);
    mesh.name = '__maxjs_geospatial_sky_environment__';
    mesh.frustumCulled = false;
    mesh.userData.volumetricBoundsBypass = true;
    mesh.userData.maxjsExcludeFromRuntimeSnapshot = true;

    state.skyEnvironmentMaterial = material;
    state.skyEnvironmentMesh = mesh;
    state.skyEnvironmentCubeTarget = new THREE_STD.WebGLCubeRenderTarget(64, {
        depthBuffer: false,
        type: THREE_STD.HalfFloatType,
        format: THREE_STD.RGBAFormat,
    });
    state.skyEnvironmentCubeCamera = new THREE_STD.CubeCamera(0.1, 1000, state.skyEnvironmentCubeTarget);
    state.skyEnvironmentPmremGenerator = new THREE_STD.PMREMGenerator(state.renderer);
    assignWebGLAtmosphereTextures(state, state.webglTextures);
}

function updateSkyEnvironmentCapture(state, params, worldToECEF) {
    if (!state.skyEnvironmentMaterial || !state.skyEnvironmentMesh || !state.skyEnvironmentCubeCamera || !state.skyEnvironmentPmremGenerator) return;
    state.skyEnvironmentMaterial.worldToECEFMatrix.copy(worldToECEF);
    applySunToECEF(state.skyEnvironmentMaterial.sunDirection, params, worldToECEF);
    state.skyEnvironmentMaterial.moonDirection.copy(state.skyEnvironmentMaterial.sunDirection).negate();
    state.skyEnvironmentMaterial.sun = false;
    state.skyEnvironmentMaterial.moon = false;
    state.skyEnvironmentMaterial.ground = true;

    const e = worldToECEF.elements;
    const s = state.skyEnvironmentMaterial.sunDirection;
    const signature = [
        s.x.toFixed(4), s.y.toFixed(4), s.z.toFixed(4),
        e[12].toFixed(0), e[13].toFixed(0), e[14].toFixed(0),
        state.webglTextures?.irradianceTexture?.uuid || '',
    ].join('|');
    if (signature === state.skyEnvironmentSignature && state.scene.environment === state.skyEnvironmentTexture) return;

    state.skyEnvironmentSignature = signature;
    try {
        state.skyEnvironmentCubeCamera.update(state.renderer, state.skyEnvironmentMesh);
        const nextTarget = state.skyEnvironmentPmremGenerator.fromCubemap(
            state.skyEnvironmentCubeTarget.texture,
            state.skyEnvironmentPmremTarget,
        );
        state.skyEnvironmentPmremTarget = nextTarget;
        state.skyEnvironmentTexture = nextTarget.texture;
        state.skyEnvironmentTexture.name = 'MaxJSGeospatialSkyPMREM';
        state.scene.environment = state.skyEnvironmentTexture;
        // The PMREM is captured from the raw-HDR SkyMaterial (no tone mapping),
        // so its values are in the same scale as the SkyMaterial's pre-tone-map
        // radiance. Scale by skyExposure so IBL contribution lines up with the
        // visible sky after the main scene tone-maps the IBL term back.
        state.scene.environmentIntensity = Math.max(
            WEBGL_ATMOSPHERE_ENV_INTENSITY_FLOOR,
            state.skyExposure ?? numberOr(params?.exposure, 0.5),
        );
    } catch (error) {
        console.error('[max.js] geospatial WebGL environment failed:', error);
    }
}

function copyMatrixLike(target, source) {
    if (!target || !source?.elements) return target;
    target.fromArray(source.elements);
    return target;
}

function syncBackdropCamera(state, camera) {
    if (!state.backdropCamera || !camera) return;
    const dst = state.backdropCamera;
    dst.isPerspectiveCamera = camera.isPerspectiveCamera === true;
    dst.isOrthographicCamera = camera.isOrthographicCamera === true;
    copyMatrixLike(dst.projectionMatrix, camera.projectionMatrix);
    copyMatrixLike(dst.projectionMatrixInverse, camera.projectionMatrixInverse);
    copyMatrixLike(dst.matrixWorld, camera.matrixWorld);
    copyMatrixLike(dst.matrixWorldInverse, camera.matrixWorldInverse);
    if (camera.position) dst.position.set(camera.position.x, camera.position.y, camera.position.z);
    if (camera.quaternion) dst.quaternion.set(camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w);
    if (camera.up) dst.up.set(camera.up.x, camera.up.y, camera.up.z);
}

function syncBackdropCanvas(state) {
    const canvas = state.backdropRenderer?.domElement;
    if (!canvas) return;
    canvas.style.width = `${window.innerWidth || 1}px`;
    canvas.style.height = `${window.innerHeight || 1}px`;
    canvas.style.display = state.visible ? 'block' : 'none';
}

function ensureBackdropSkyRenderer(state) {
    if (state.backdropRenderer) return;

    const backdropRenderer = new THREE_STD.WebGLRenderer({
        antialias: false,
        alpha: true,
        powerPreference: 'high-performance',
    });
    backdropRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    backdropRenderer.setSize(window.innerWidth || 1, window.innerHeight || 1, false);
    backdropRenderer.toneMapping = THREE_STD.NeutralToneMapping;
    backdropRenderer.toneMappingExposure = 1.0;
    backdropRenderer.setClearColor(0x000000, 0);
    backdropRenderer.domElement.style.cssText = 'position:absolute;inset:0;z-index:0;pointer-events:none';
    document.body.insertBefore(backdropRenderer.domElement, state.renderer?.domElement || null);

    state.renderer.domElement.style.zIndex = '1';
    state.renderer.domElement.style.background = 'transparent';
    try { state.renderer.setClearColor?.(0x000000, 0); } catch {}

    state.backdropRenderer = backdropRenderer;
    state.backdropScene = new THREE_STD.Scene();
    state.backdropCamera = new THREE_STD.Camera();
    state.backdropTexture = new THREE.CanvasTexture(backdropRenderer.domElement);
    state.backdropTexture.name = 'MaxJSGeospatialBackdropTexture';
    state.backdropTexture.colorSpace = THREE.SRGBColorSpace;
    state.backdropTexture.needsUpdate = true;
    syncBackdropCanvas(state);
}

function renderBackdropSky(state, camera) {
    if (!state.backdropRenderer || !state.backdropScene || !state.backdropCamera) return;
    syncBackdropCanvas(state);
    if (!state.visible) return;
    syncBackdropCamera(state, camera);
    state.backdropRenderer.toneMappingExposure = state.skyExposure ?? state.renderer?.toneMappingExposure ?? 1.0;
    state.backdropRenderer.render(state.backdropScene, state.backdropCamera);
    if (state.backdropTexture) state.backdropTexture.needsUpdate = true;
}

function disposeBackdropSky(state) {
    if (state.backdropMesh?.parent) state.backdropMesh.parent.remove(state.backdropMesh);
    try { state.backdropMesh?.geometry?.dispose?.(); } catch {}
    try { state.backdropTexture?.dispose?.(); } catch {}
    try { state.backdropRenderer?.dispose?.(); } catch {}
    state.backdropRenderer?.domElement?.remove?.();
    if (state.renderer?.domElement) {
        state.renderer.domElement.style.zIndex = '0';
        state.renderer.domElement.style.background = '';
    }
    state.backdropRenderer = null;
    state.backdropScene = null;
    state.backdropCamera = null;
    state.backdropMesh = null;
    state.backdropTexture = null;
}

async function loadCoreModules(state) {
    if (!state.coreModulesPromise) {
        state.coreModulesPromise = Promise.all([
            import('@takram/three-atmosphere'),
            import('@takram/three-geospatial'),
        ]).then(([atmosphere, geospatial]) => ({ atmosphere, geospatial }));
    }
    return state.coreModulesPromise;
}

async function loadNodeModules(state) {
    if (!state.nodeModulesPromise) {
        state.nodeModulesPromise = Promise.all([
            import('@takram/three-atmosphere/webgpu'),
            import('three/tsl'),
        ]).then(([atmosphereWebGPU, tsl]) => ({ atmosphereWebGPU, tsl }));
    }
    return state.nodeModulesPromise;
}

async function ensureWebGLSky(state) {
    const { atmosphere, geospatial } = await loadCoreModules(state);
    if (!state.webglMesh) {
        if (rendererUsesLegacyWebGL(state.renderer) || rendererUsesForcedWebGL(state)) {
            if (rendererUsesForcedWebGL(state)) ensureBackdropSkyRenderer(state);
            const material = new atmosphere.SkyMaterial({
                ground: true,
                moon: false,
                groundAlbedo: new THREE.Color(0.045, 0.055, 0.05),
            });
            material.name = 'MaxJSGeospatialSkyMaterial';
            patchSkyMaterialForToneMapping(material, state);

            const geometry = rendererUsesForcedWebGL(state)
                ? new THREE_STD.PlaneGeometry(2, 2)
                : new THREE.PlaneGeometry(2, 2);
            const mesh = rendererUsesForcedWebGL(state)
                ? new THREE_STD.Mesh(geometry, material)
                : new THREE.Mesh(geometry, material);
            mesh.name = '__maxjs_geospatial_sky__';
            mesh.frustumCulled = false;
            mesh.renderOrder = -10000;
            mesh.userData.volumetricBoundsBypass = true;

            state.webglMaterial = material;
            state.webglMesh = mesh;
            ensureSkyEnvironmentCapture(state, atmosphere, geospatial);
            if (rendererUsesForcedWebGL(state)) {
                state.backdropMesh = mesh;
                state.backdropScene.add(mesh);
            }
        } else {
            const mesh = new SkyMesh();
            mesh.name = '__maxjs_geospatial_sky__';
            mesh.scale.setScalar(450000);
            mesh.frustumCulled = false;
            mesh.renderOrder = -10000;
            mesh.userData.volumetricBoundsBypass = true;
            state.webglMaterial = null;
            state.webglMesh = mesh;
        }
    }

    if ((rendererUsesLegacyWebGL(state.renderer) || rendererUsesForcedWebGL(state)) && !state.textureLoadPromise) {
        state.textureLoadPromise = new Promise((resolve, reject) => {
            const loader = new atmosphere.PrecomputedTexturesLoader({
                format: 'binary',
                combinedScattering: true,
                higherOrderScattering: true,
            });
            const textureRenderer = state.backdropRenderer || state.renderer;
            try { loader.setType(textureRenderer); } catch {}
            const textures = loader.load(ASSET_ROOT_URL, (loaded) => {
                assignWebGLAtmosphereTextures(state, loaded);
                state.skyEnvironmentSignature = '';
                ensureSkyLightProbe(state, atmosphere, loaded);
                resolve(loaded);
            }, undefined, reject);
            assignWebGLAtmosphereTextures(state, textures);
            ensureSkyLightProbe(state, atmosphere, textures);
        }).catch((error) => {
            console.error('[max.js] geospatial sky texture load failed:', error);
            throw error;
        });
    } else if ((rendererUsesLegacyWebGL(state.renderer) || rendererUsesForcedWebGL(state)) && state.webglTextures) {
        ensureSkyEnvironmentCapture(state, atmosphere, geospatial);
        ensureSkyLightProbe(state, atmosphere, state.webglTextures);
    }

    state.webglGeospatial = geospatial;
    return { atmosphere, geospatial };
}

async function ensureNodeSky(state) {
    const { geospatial } = await loadCoreModules(state);
    const { atmosphereWebGPU, tsl } = await loadNodeModules(state);

    removeWebGPUIncompatibleObjects(state);

    if (!state.nodeContext) {
        state.nodeContext = new atmosphereWebGPU.AtmosphereContext();
        state.nodeContext.camera = state.camera || undefined;

        const previousContextValue = state.renderer.contextNode?.value || {};
        state.renderer.contextNode = tsl.context({
            ...previousContextValue,
            getAtmosphere: () => state.nodeContext,
        });
    }

    if (!state.nodeBackground) {
        state.nodeBackgroundBase = atmosphereWebGPU.skyBackground();
        state.nodeBackground = state.nodeBackgroundBase.mul(tsl.float(WEBGPU_ATMOSPHERE_EXPOSURE_BOOST));
    }
    if (!state.nodeEnvironment) {
        state.nodeEnvironment = atmosphereWebGPU.skyEnvironment(64);
    }

    if (state.scene.backgroundNode !== state.nodeBackground) {
        state.scene.backgroundNode = state.nodeBackground;
    }
    if (state.scene.environmentNode !== state.nodeEnvironment) {
        state.scene.environmentNode = state.nodeEnvironment;
    }
    state.scene.background = null;
    state.nodeGeospatial = geospatial;
    return { atmosphereWebGPU, geospatial };
}

function isNodeRenderer(state) {
    const label = String(state.backendLabel || state.renderer?.userData?.maxjsBackendLabel || '');
    if (label) return label === 'WebGPU';
    return state.renderer?.backend?.isWebGPUBackend === true;
}

function applyCommonState(state, params, camera) {
    state.params = params || {};
    state.camera = camera || state.camera || null;
    state.active = true;
    state.visible = true;
    const exposure = numberOr(state.params.exposure, 0.5);
    // Node (TSL) sky needs its own luminance boost; changing renderer exposure
    // would brighten the authored scene too. WebGL2 uses the SkyMaterial patch.
    if (isNodeRenderer(state)) {
        state.skyExposure = exposure * WEBGPU_ATMOSPHERE_EXPOSURE_BOOST;
        state.renderer.toneMappingExposure = exposure;
    } else {
        state.skyExposure = exposure * WEBGL_ATMOSPHERE_EXPOSURE_BOOST;
        state.renderer.toneMappingExposure = exposure;
    }
}

function applyWebGLState(state, params, camera) {
    const geospatial = state.webglGeospatial;
    if (!geospatial || !state.webglMesh) return;
    if (state.scene.backgroundNode === state.nodeBackground) state.scene.backgroundNode = null;
    if (state.scene.environmentNode === state.nodeEnvironment) state.scene.environmentNode = null;
    const worldToECEF = buildWorldToECEFMatrix({
        camera,
        params,
        geospatial,
        target: scratchWorldToECEF,
    });
    if (state.webglMaterial) {
        state.webglMaterial.worldToECEFMatrix.copy(worldToECEF);
        applySunToECEF(state.webglMaterial.sunDirection, params, worldToECEF);
        state.webglMaterial.moonDirection.copy(state.webglMaterial.sunDirection).negate();
        state.webglMaterial.sun = params.showSunDisc !== false && params.showSunDisc !== 0;
        state.webglMaterial.moon = false;
        state.webglMaterial.ground = true;
    } else if (state.webglMesh?.isSkyMesh) {
        const sunDir = getSunDirectionWorld(params, scratchLinkedSunWorld);
        state.webglMesh.turbidity.value = numberOr(params?.turbidity, 10);
        state.webglMesh.rayleigh.value = numberOr(params?.rayleigh, 3);
        state.webglMesh.mieCoefficient.value = numberOr(params?.mieCoefficient, 0.005);
        state.webglMesh.mieDirectionalG.value = numberOr(params?.mieDirectionalG, 0.7);
        state.webglMesh.upUniform.value.set(0, 1, 0);
        state.webglMesh.sunPosition.value.copy(sunDir);
        state.webglMesh.showSunDisc.value = params.showSunDisc !== false && params.showSunDisc !== 0 ? 1 : 0;
    }
    if (state.skyLightProbe) {
        state.skyLightProbe.worldToECEFMatrix.copy(worldToECEF);
        applySunToECEF(state.skyLightProbe.sunDirection, params, worldToECEF);
        if (camera) {
            camera.updateMatrixWorld?.();
            state.skyLightProbe.position.setFromMatrixPosition(camera.matrixWorld);
        } else {
            state.skyLightProbe.position.set(0, 0, 0);
        }
        state.skyLightProbe.visible = state.visible;
        state.skyLightProbe.intensity = state.visible ? 1.0 : 0.0;
        state.skyLightProbe.update?.();
    }
    if (state.skyEnvironmentWorldToECEF) {
        buildWorldToECEFMatrix({
            camera: null,
            params,
            geospatial,
            target: state.skyEnvironmentWorldToECEF,
        });
        updateSkyEnvironmentCapture(state, params, state.skyEnvironmentWorldToECEF);
    }

    if (state.backdropRenderer) {
        state.webglMesh.visible = state.visible;
        renderBackdropSky(state, camera);
        state.scene.background = state.backdropTexture || null;
    } else {
        if (state.webglMesh.parent !== state.scene) state.scene.add(state.webglMesh);
        state.webglMesh.visible = state.visible;
        state.scene.background = new THREE.Color(state.fallbackBackground);
    }
    updatePhysicalLights(state, params);
}

function applyNodeState(state, params, camera) {
    const geospatial = state.nodeGeospatial;
    if (!geospatial || !state.nodeContext) return;
    removeWebGPUIncompatibleObjects(state);
    state.nodeContext.camera = camera || undefined;
    const worldToECEF = buildWorldToECEFMatrix({
        camera,
        params,
        geospatial,
        target: state.nodeContext.matrixWorldToECEF.value,
    });
    applySunToECEF(state.nodeContext.sunDirectionECEF.value, params, worldToECEF);
    scratchMoonECEF.copy(state.nodeContext.sunDirectionECEF.value).negate();
    state.nodeContext.moonDirectionECEF.value.copy(scratchMoonECEF);
    state.nodeContext.matrixECIToECEF.value.identity();

    if (state.visible) {
        state.scene.backgroundNode = state.nodeBackground;
        state.scene.environmentNode = state.nodeEnvironment;
        state.scene.background = null;
        state.scene.environmentIntensity = Math.max(
            WEBGPU_ATMOSPHERE_ENV_INTENSITY_FLOOR,
            state.skyExposure ?? numberOr(params?.exposure, 0.5),
        );
    } else if (state.scene.backgroundNode === state.nodeBackground) {
        state.scene.backgroundNode = null;
        if (state.scene.environmentNode === state.nodeEnvironment) state.scene.environmentNode = null;
        state.scene.background = new THREE.Color(state.fallbackBackground);
    }
    updatePhysicalLights(state, params);
}

export function createGeospatialSkyController({ scene, renderer, backendLabel = '', fallbackBackground = FALLBACK_BACKGROUND } = {}) {
    if (!scene) throw new Error('createGeospatialSkyController: scene is required');
    if (!renderer) throw new Error('createGeospatialSkyController: renderer is required');

    const state = {
        scene,
        renderer,
        backendLabel,
        fallbackBackground,
        active: false,
        visible: true,
        camera: null,
        params: {},
        coreModulesPromise: null,
        nodeModulesPromise: null,
        textureLoadPromise: null,
        webglMesh: null,
        webglMaterial: null,
        webglTextures: null,
        webglGeospatial: null,
        skyLightProbe: null,
        skyEnvironmentMaterial: null,
        skyEnvironmentMesh: null,
        skyEnvironmentCubeTarget: null,
        skyEnvironmentCubeCamera: null,
        skyEnvironmentPmremGenerator: null,
        skyEnvironmentPmremTarget: null,
        skyEnvironmentTexture: null,
        skyEnvironmentSignature: '',
        skyEnvironmentWorldToECEF: new THREE.Matrix4(),
        backdropRenderer: null,
        backdropScene: null,
        backdropCamera: null,
        backdropMesh: null,
        backdropTexture: null,
        nodeContext: null,
        nodeBackgroundBase: null,
        nodeBackground: null,
        nodeEnvironment: null,
        nodeGeospatial: null,
        sunLight: null,
        fillLight: null,
        skyExposure: 1,
    };

    function apply(params, { camera } = {}) {
        applyCommonState(state, params, camera);
        if (isNodeRenderer(state)) {
            ensureNodeSky(state)
                .then(() => applyNodeState(state, state.params, state.camera))
                .catch((error) => console.error('[max.js] geospatial node sky failed:', error));
        } else {
            ensureWebGLSky(state)
                .then(() => applyWebGLState(state, state.params, state.camera))
                .catch((error) => console.error('[max.js] geospatial WebGL sky failed:', error));
        }
    }

    function update({ camera, elapsedSeconds } = {}) {
        if (!state.active) return;
        state.camera = camera || state.camera || null;
        if (Number.isFinite(elapsedSeconds)) state.elapsedSeconds = elapsedSeconds;
        if (isNodeRenderer(state)) {
            applyNodeState(state, state.params, state.camera);
        } else {
            applyWebGLState(state, state.params, state.camera);
        }
    }

    function setVisible(visible) {
        state.visible = !!visible;
        if (state.webglMesh) state.webglMesh.visible = state.visible;
        syncBackdropCanvas(state);
        if (state.skyLightProbe) {
            state.skyLightProbe.visible = state.visible;
            state.skyLightProbe.intensity = state.visible ? 1.0 : 0.0;
        }
        if (state.sunLight) state.sunLight.visible = state.visible;
        if (state.fillLight) state.fillLight.visible = state.visible;
        if (!state.visible) {
            if (state.scene.backgroundNode === state.nodeBackground) state.scene.backgroundNode = null;
            if (state.scene.environmentNode === state.nodeEnvironment) state.scene.environmentNode = null;
            state.scene.background = new THREE.Color(state.fallbackBackground);
        } else if (state.active) {
            if (state.backdropTexture) state.scene.background = state.backdropTexture;
            update({ camera: state.camera });
        }
    }

    function dispose() {
        state.active = false;
        if (state.webglMesh?.parent) state.webglMesh.parent.remove(state.webglMesh);
        if (state.skyLightProbe?.parent) state.skyLightProbe.parent.remove(state.skyLightProbe);
        disposeSkyEnvironmentCapture(state);
        if (state.scene.backgroundNode === state.nodeBackground) state.scene.backgroundNode = null;
        if (state.scene.environmentNode === state.nodeEnvironment) state.scene.environmentNode = null;
        if (state.sunLight?.parent) state.sunLight.parent.remove(state.sunLight);
        if (state.sunLight?.target?.parent) state.sunLight.target.parent.remove(state.sunLight.target);
        if (state.fillLight?.parent) state.fillLight.parent.remove(state.fillLight);
        try { state.webglMesh?.geometry?.dispose?.(); } catch {}
        try { state.webglMaterial?.dispose?.(); } catch {}
        try { state.nodeContext?.dispose?.(); } catch {}
        try { state.nodeBackgroundBase?.dispose?.(); } catch {}
        try { state.nodeEnvironment?.dispose?.(); } catch {}
        disposeBackdropSky(state);
        state.webglMesh = null;
        state.webglMaterial = null;
        state.skyLightProbe = null;
        state.webglTextures = null;
        state.nodeContext = null;
        state.nodeBackgroundBase = null;
        state.nodeBackground = null;
        state.nodeEnvironment = null;
        state.nodeGeospatial = null;
        state.backdropTexture = null;
        state.sunLight = null;
        state.fillLight = null;
    }

    return {
        apply,
        update,
        setVisible,
        dispose,
        get active() { return state.active; },
    };
}
