import * as THREE from 'three';
import {
    add,
    blendColor,
    convertToTexture,
    colorToDirection,
    diffuseColor,
    directionToColor,
    float,
    int,
    max,
    metalness,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    sample,
    vec2,
    vec3,
    vec4,
    screenUV,
    screenSize,
    builtinShadowContext,
    builtinAOContext,
    toonOutlinePass,
    posterize,
    uniform,
    replaceDefaultUV,
    velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
// OutlineNode removed — using built-in toonOutlinePass from TSL instead
import { sss } from 'three/addons/tsl/display/SSSNode.js';
import { scanlines, vignette, colorBleeding, barrelUV } from 'three/addons/tsl/display/CRT.js';
import { bayerDither } from 'three/addons/tsl/math/Bayer.js';
import { retroPass } from 'three/addons/tsl/display/RetroPassNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';

function setTexturePrecision(scenePass) {
    const diffuseTexture = scenePass.getTexture('diffuseColor');
    if (diffuseTexture) diffuseTexture.type = THREE.UnsignedByteType;

    const normalTexture = scenePass.getTexture('normal');
    if (normalTexture) normalTexture.type = THREE.UnsignedByteType;

    const metalRoughTexture = scenePass.getTexture('metalrough');
    if (metalRoughTexture) metalRoughTexture.type = THREE.UnsignedByteType;
}

export function createSSGIController({
    renderer,
    scene,
    camera,
    backendLabel = '',
    onError = () => {},
    environmentVisible = true,
    hiddenBackgroundColor = 0x1a1a2e,
}) {
    const PipelineCtor = THREE.RenderPipeline || THREE.PostProcessing;
    const postProcessing = new PipelineCtor(renderer);
    const supportsScreenSpaceEffects = backendLabel === 'WebGPU';
    const SSR_REFERENCE_SIZE = 6.0;
    const hiddenBackground = new THREE.Color(hiddenBackgroundColor);
    const hiddenBackgroundNode = vec3(hiddenBackground.r, hiddenBackground.g, hiddenBackground.b);

    // Cached toon mesh detection — refreshed on pipeline rebuild, not every frame
    let cachedHasToonMeshes = false;

    function refreshToonMeshCache() {
        cachedHasToonMeshes = false;
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.visible) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (m && m.isMeshToonMaterial) {
                    cachedHasToonMeshes = true;
                    return;
                }
            }
        });
    }

    function getToonMeshes() {
        // Only used during pipeline rebuild — returns fresh list
        const result = [];
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.visible) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (m && m.isMeshToonMaterial) {
                    result.push(obj);
                    break;
                }
            }
        });
        return result;
    }
    const state = {
        ssgi: {
            enabled: false,
            radius: 8,
            thickness: 1.5,
            aoIntensity: 1.0,
            giIntensity: 1.5,
            expFactor: 1.5,
            sliceCount: 2,
            stepCount: 8,
            temporal: false,
        },
        ssr: {
            enabled: false,
            quality: 0.45,
            blurQuality: 2,
            maxDistance: 0.5,
            opacity: 0.9,
            thickness: 0.015,
        },
        gtao: {
            enabled: false,
            samples: 16,
            distanceExponent: 1.0,
            distanceFallOff: 1.0,
            radius: 0.25,
            scale: 1.0,
            thickness: 1.0,
            resolutionScale: 0.5,
        },
        motionBlur: {
            enabled: false,
            amount: 1.0,
            samples: 16,
        },
        traa: {
            enabled: false,
            useSubpixelCorrection: true,
            depthThreshold: 0.0005,
            edgeDepthDiff: 0.001,
            maxVelocityLength: 128,
        },
        bloom: {
            enabled: false,
            strength: 0.4,
            radius: 0.2,
            threshold: 0.75,
        },
        toonOutline: {
            enabled: true,
            edgeStrength: 3.0,
            edgeGlow: 0.0,
            edgeThickness: 1.0,
            visibleEdgeColor: [0, 0, 0],
            hiddenEdgeColor: [0, 0, 0],
        },
        contactShadow: {
            enabled: false,
            maxDistance: 0.1,
            thickness: 0.006,
            shadowIntensity: 0.85,
            quality: 0.3,
            temporal: false,
        },
        retro: {
            enabled: false,
            wiggle: true,
            affineDistortion: 5.0,
            resolutionScale: 0.25,
            filterTextures: false,
            dither: false,
            colorDepth: 32,
            scanlines: false,
            scanlineIntensity: 0.3,
            scanlineDensity: 1.0,
            crt: false,
            vignetteIntensity: 0.3,
            bleeding: 0.001,
            curvature: 0.02,
        },
    };

    let selectedObjects = [];
    let mainLight = null;  // DirectionalLight for contact shadows

    let available = true;
    let lastError = '';
    let pipelineReady = false;
    let activeNodes = [];
    let activeSSRPass = null;
    let activeAOPass = null;
    let activeContactShadowPass = null;
    let hiddenDuringPost = [];
    let forceEnvironmentBackground = false;
    let forcedContactShadowLightState = null;

    // Cache objects that need hiding during post pass — rebuilt on pipeline rebuild only
    let postPassHideList = [];
    let normalsComputed = new WeakSet();

    function refreshPostPassHideList() {
        postPassHideList = [];
        scene.traverse((object) => {
            if (!object?.visible) return;
            if (object.isLine || object.isLineSegments || object.isPoints || object.isSprite) {
                postPassHideList.push(object);
            }
            // Pre-compute normals once, not every frame
            if (object.isMesh && object.geometry && !normalsComputed.has(object.geometry)) {
                if (!object.geometry.getAttribute?.('normal') && object.geometry.getAttribute?.('position')) {
                    try { object.geometry.computeVertexNormals(); } catch {}
                }
                normalsComputed.add(object.geometry);
            }
        });
    }

    function prepareSceneForPostPass() {
        hiddenDuringPost = postPassHideList.filter(o => o.visible);
        for (const o of hiddenDuringPost) o.visible = false;
    }

    function restoreSceneAfterPostPass() {
        for (const o of hiddenDuringPost) o.visible = true;
        hiddenDuringPost = [];
    }

    function restoreForcedContactShadowLight() {
        if (!forcedContactShadowLightState) return;

        const { light, castShadow, shadowIntensity } = forcedContactShadowLightState;
        forcedContactShadowLightState = null;

        if (!light) return;

        light.castShadow = castShadow;
        if (light.shadow && shadowIntensity != null) {
            light.shadow.intensity = shadowIntensity;
            light.shadow.needsUpdate = true;
        }
    }

    function ensureMainLightSupportsContactShadow() {
        if (!state.contactShadow.enabled || !mainLight?.isDirectionalLight) {
            restoreForcedContactShadowLight();
            return;
        }

        if (forcedContactShadowLightState?.light && forcedContactShadowLightState.light !== mainLight) {
            restoreForcedContactShadowLight();
        }

        if (mainLight.castShadow || forcedContactShadowLightState?.light === mainLight) return;

        forcedContactShadowLightState = {
            light: mainLight,
            castShadow: mainLight.castShadow,
            shadowIntensity: mainLight.shadow && Number.isFinite(mainLight.shadow.intensity)
                ? mainLight.shadow.intensity
                : null,
        };

        mainLight.castShadow = true;
        if (mainLight.shadow) {
            if (typeof mainLight.shadow.intensity === 'number') {
                mainLight.shadow.intensity = 0;
            }
            mainLight.shadow.needsUpdate = true;
        }
    }

    function clearNodes() {
        activeSSRPass = null;
        activeAOPass = null;
        activeContactShadowPass = null;
        for (const node of activeNodes) {
            if (node && typeof node.dispose === 'function') {
                node.dispose();
            }
        }
        activeNodes = [];
    }

    function disableWithError(prefix, error) {
        lastError = error?.message || String(error);
        available = false;
        state.ssgi.enabled = false;
        state.ssr.enabled = false;
        state.gtao.enabled = false;
        state.motionBlur.enabled = false;
        state.traa.enabled = false;
        state.bloom.enabled = false;
        pipelineReady = false;
        restoreForcedContactShadowLight();
        clearNodes();
        postProcessing.outputNode = null;
        postProcessing.needsUpdate = true;
        onError(`${prefix}: ${lastError}`);
    }

    function hasAnyEffectEnabled() {
        return state.ssgi.enabled || state.ssr.enabled || state.gtao.enabled || state.motionBlur.enabled || state.traa.enabled || state.bloom.enabled
            || (state.toonOutline.enabled && cachedHasToonMeshes)
            || (state.contactShadow.enabled && mainLight)
            || state.retro.enabled;
    }

    function computeSceneReferenceSize() {
        const box = new THREE.Box3();
        let foundMesh = false;

        scene.traverse((object) => {
            if (!object?.visible || !object.isMesh || !object.geometry) return;
            const position = object.geometry.getAttribute?.('position');
            if (!position || position.count === 0) return;
            box.expandByObject(object);
            foundMesh = true;
        });

        if (!foundMesh || box.isEmpty()) return SSR_REFERENCE_SIZE;

        const size = box.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z);
        return Number.isFinite(maxDimension) && maxDimension > 1.0e-3
            ? maxDimension
            : SSR_REFERENCE_SIZE;
    }

    function computeDerivedState() {
        const sceneReferenceSize = computeSceneReferenceSize();
        const ssrUnitScale = Math.max(1, sceneReferenceSize / SSR_REFERENCE_SIZE);

        return {
            sceneReferenceSize,
            ssrUnitScale,
            effectiveSSRMaxDistance: state.ssr.maxDistance * ssrUnitScale,
            effectiveSSRThickness: state.ssr.thickness * ssrUnitScale,
            effectiveGTAORadius: state.gtao.radius * ssrUnitScale,
            effectiveGTAOThickness: state.gtao.thickness * ssrUnitScale,
            effectiveContactShadowMaxDistance: state.contactShadow.maxDistance * ssrUnitScale,
            effectiveContactShadowThickness: state.contactShadow.thickness * ssrUnitScale,
            retroTakeoverActive: state.retro.enabled && state.retro.wiggle,
        };
    }

    function snapshotState() {
        return {
            ssgi: { ...state.ssgi },
            ssr: { ...state.ssr },
            gtao: { ...state.gtao },
            motionBlur: { ...state.motionBlur },
            traa: { ...state.traa },
            bloom: { ...state.bloom },
            toonOutline: { ...state.toonOutline, toonCount: cachedHasToonMeshes ? 1 : 0 },
            contactShadow: { ...state.contactShadow },
            retro: { ...state.retro },
        };
    }

    function updateActiveScreenSpaceParams() {
        const derived = computeDerivedState();
        if (activeSSRPass) {
            activeSSRPass.maxDistance.value = derived.effectiveSSRMaxDistance;
            activeSSRPass.thickness.value = derived.effectiveSSRThickness;
        }
        if (activeAOPass) {
            activeAOPass.radius.value = derived.effectiveGTAORadius;
            activeAOPass.thickness.value = derived.effectiveGTAOThickness;
        }
        if (activeContactShadowPass) {
            activeContactShadowPass.maxDistance.value = derived.effectiveContactShadowMaxDistance;
            activeContactShadowPass.thickness.value = derived.effectiveContactShadowThickness;
        }
    }

    function assignFinite(target, key, value) {
        if (Number.isFinite(value)) target[key] = value;
    }

    function rebuildPipeline() {
        refreshToonMeshCache();
        refreshPostPassHideList();
        ensureMainLightSupportsContactShadow();

        if (!hasAnyEffectEnabled() || !available) {
            pipelineReady = false;
            restoreForcedContactShadowLight();
            clearNodes();
            postProcessing.outputNode = null;
            postProcessing.needsUpdate = true;
            forceEnvironmentBackground = false;
            return;
        }

        clearNodes();

        try {
            const useRetroTakeover = state.retro.enabled && state.retro.wiggle;
            const useSharedPrePass =
                !useRetroTakeover && (
                    state.gtao.enabled ||
                    state.motionBlur.enabled ||
                    state.traa.enabled ||
                    (state.contactShadow.enabled && mainLight)
                );

            let prePassDepth = null;
            let prePassNormal = null;
            let prePassVelocity = null;

            if (useSharedPrePass) {
                const prePass = pass(scene, camera);
                activeNodes.push(prePass);
                prePass.transparent = false;
                prePass.setMRT(mrt({
                    output: directionToColor(normalView),
                    velocity,
                }));

                prePassDepth = prePass.getTextureNode('depth');
                const prePassNormalColor = prePass.getTextureNode('output');
                prePassVelocity = prePass.getTextureNode('velocity');
                prePassNormal = sample((uvNode) => colorToDirection(prePassNormalColor.sample(uvNode)));

                const normalTexture = prePass.getTexture('output');
                if (normalTexture) normalTexture.type = THREE.UnsignedByteType;
            }

            let sceneContext = null;
            if (state.contactShadow.enabled && mainLight && prePassDepth) {
                const derived = computeDerivedState();
                const contactShadowTemporal = state.contactShadow.temporal && state.traa.enabled;
                const sssPass = sss(prePassDepth, camera, mainLight);
                sssPass.maxDistance.value = derived.effectiveContactShadowMaxDistance;
                sssPass.thickness.value = derived.effectiveContactShadowThickness;
                sssPass.shadowIntensity.value = state.contactShadow.shadowIntensity;
                sssPass.quality.value = state.contactShadow.quality;
                sssPass.useTemporalFiltering = contactShadowTemporal;
                activeNodes.push(sssPass);
                activeContactShadowPass = sssPass;

                const sssSample = sssPass.getTextureNode().sample(screenUV).r;
                sceneContext = builtinShadowContext(sssSample, mainLight, sceneContext);
            }

            const useEnvironmentBackdropCompensation =
                state.ssr.enabled && !useRetroTakeover && !!scene.environment && !environmentVisible;

            let beauty;
            let scenePassColor, scenePassDepth, scenePassDiffuse, scenePassNormalColor, scenePassMetalRough, sceneNormal, ssrReflectivity;

            if (useRetroTakeover) {
                const r = state.retro;
                const retro = retroPass(scene, camera, { affineDistortion: uniform(r.affineDistortion) });
                retro.setResolutionScale(r.resolutionScale);
                retro.filterTextures = r.filterTextures;
                activeNodes.push(retro);
                beauty = retro;
            } else {
                const derived = computeDerivedState();
                const ssrReflectivityNode = max(
                    metalness,
                    roughness.oneMinus().mul(0.35).add(float(0.04))
                );

                if (state.gtao.enabled && prePassDepth && prePassNormal) {
                    const aoPass = ao(prePassDepth, prePassNormal, camera);
                    aoPass.samples.value = state.gtao.samples;
                    aoPass.distanceExponent.value = state.gtao.distanceExponent;
                    aoPass.distanceFallOff.value = state.gtao.distanceFallOff;
                    aoPass.radius.value = derived.effectiveGTAORadius;
                    aoPass.scale.value = state.gtao.scale;
                    aoPass.thickness.value = derived.effectiveGTAOThickness;
                    aoPass.resolutionScale = state.gtao.resolutionScale;
                    aoPass.useTemporalFiltering = state.traa.enabled;
                    activeNodes.push(aoPass);
                    activeAOPass = aoPass;

                    const aoSample = aoPass.getTextureNode().sample(screenUV).r;
                    sceneContext = builtinAOContext(aoSample, sceneContext);
                }

                // Use toonOutlinePass as scene pass when toon materials exist — outlines + MRT
                const useToonPass = state.toonOutline.enabled && getToonMeshes().length > 0;
                const scenePass = useToonPass
                    ? toonOutlinePass(scene, camera)
                    : pass(scene, camera);
                activeNodes.push(scenePass);

                if (sceneContext) scenePass.contextNode = sceneContext;

                scenePass.setMRT(mrt({
                    output,
                    diffuseColor,
                    normal: directionToColor(normalView),
                    metalrough: vec2(ssrReflectivityNode, roughness),
                }));

                setTexturePrecision(scenePass);

                scenePassColor = scenePass.getTextureNode('output');
                beauty = scenePassColor;
                scenePassDiffuse = scenePass.getTextureNode('diffuseColor');
                scenePassDepth = scenePass.getTextureNode('depth');
                scenePassNormalColor = scenePass.getTextureNode('normal');
                scenePassMetalRough = scenePass.getTextureNode('metalrough');
                sceneNormal = sample((uvNode) => colorToDirection(scenePassNormalColor.sample(uvNode)));
                ssrReflectivity = scenePassMetalRough.r;
            }

            if (state.ssgi.enabled && !useRetroTakeover) {
                const ssgiPass = ssgi(scenePassColor, scenePassDepth, sceneNormal, camera);
                ssgiPass.sliceCount.value = state.ssgi.sliceCount;
                ssgiPass.stepCount.value = state.ssgi.stepCount;
                ssgiPass.radius.value = state.ssgi.radius;
                ssgiPass.thickness.value = state.ssgi.thickness;
                ssgiPass.aoIntensity.value = state.ssgi.aoIntensity;
                ssgiPass.giIntensity.value = state.ssgi.giIntensity;
                ssgiPass.expFactor.value = state.ssgi.expFactor;
                ssgiPass.useTemporalFiltering = state.ssgi.temporal;
                activeNodes.push(ssgiPass);

                beauty = vec4(
                    add(
                        beauty.rgb.mul(ssgiPass.a),
                        scenePassDiffuse.rgb.mul(ssgiPass.rgb)
                    ),
                    beauty.a
                );
            }

            if (state.ssr.enabled && !useRetroTakeover) {
                const derived = computeDerivedState();
                const ssrPass = ssr(
                    scenePassColor,
                    scenePassDepth,
                    sceneNormal,
                    ssrReflectivity,
                    scenePassMetalRough.g,
                    camera
                );
                ssrPass.quality.value = state.ssr.quality;
                ssrPass.blurQuality.value = state.ssr.blurQuality;
                ssrPass.maxDistance.value = derived.effectiveSSRMaxDistance;
                ssrPass.opacity.value = state.ssr.opacity;
                ssrPass.thickness.value = derived.effectiveSSRThickness;
                activeNodes.push(ssrPass);
                activeSSRPass = ssrPass;
                // SSR has no proper environment fallback, so do not let it darken
                // the existing beauty pass. Keep the brighter of the base lighting
                // (including HDRI/IBL) and the SSR-composited result.
                const ssrBlended = blendColor(beauty, ssrPass);
                beauty = vec4(max(beauty.rgb, ssrBlended.rgb), beauty.a);
            }

            if (state.bloom.enabled) {
                const bloomPass = bloom(
                    beauty,
                    state.bloom.strength,
                    state.bloom.radius,
                    state.bloom.threshold
                );
                activeNodes.push(bloomPass);
                beauty = beauty.add(bloomPass);
            }

            // Toon outline is handled at the scene pass level (line above) —
            // toonOutlinePass replaces pass() so MRT + SSGI/SSR/Bloom all stack on top.

            if (state.traa.enabled && !useRetroTakeover && prePassDepth && prePassVelocity) {
                const traaInput = convertToTexture(beauty);
                activeNodes.push(traaInput);

                const traaPass = traa(traaInput, prePassDepth, prePassVelocity, camera);
                traaPass.useSubpixelCorrection = state.traa.useSubpixelCorrection;
                traaPass.depthThreshold = state.traa.depthThreshold;
                traaPass.edgeDepthDiff = state.traa.edgeDepthDiff;
                traaPass.maxVelocityLength = state.traa.maxVelocityLength;
                activeNodes.push(traaPass);
                beauty = traaPass;
            }

            if (state.motionBlur.enabled && !useRetroTakeover && prePassVelocity) {
                const motionBlurInput = convertToTexture(beauty);
                activeNodes.push(motionBlurInput);
                beauty = motionBlur(
                    motionBlurInput,
                    prePassVelocity.mul(uniform(state.motionBlur.amount)),
                    int(Math.max(2, Math.round(state.motionBlur.samples)))
                );
            }

            if (state.retro.enabled) {
                const r = state.retro;
                if (!useRetroTakeover && !r.filterTextures && r.resolutionScale < 0.999) {
                    const retroScale = uniform(Math.max(0.05, r.resolutionScale));
                    const retroPixels = vec2(
                        max(screenSize.x.mul(retroScale), float(1.0)),
                        max(screenSize.y.mul(retroScale), float(1.0))
                    );
                    beauty = replaceDefaultUV(() => screenUV.mul(retroPixels).floor().div(retroPixels), beauty);
                }

                // CRT barrel distortion + color bleeding
                if (r.crt) {
                    const distortedUV = barrelUV(uniform(r.curvature));
                    beauty = replaceDefaultUV(distortedUV, beauty);
                    beauty = colorBleeding(beauty, uniform(r.bleeding));
                }

                // Dither + posterize
                if (r.dither) {
                    const colorSteps = uniform(r.colorDepth);
                    beauty = bayerDither(beauty, colorSteps);
                    beauty = posterize(beauty, colorSteps);
                }

                // Vignette
                if (r.vignetteIntensity > 0) {
                    beauty = vignette(beauty, uniform(r.vignetteIntensity), 0.6);
                }

                // Scanlines
                if (r.scanlines) {
                    beauty = scanlines(beauty, uniform(r.scanlineIntensity), screenSize.y.mul(uniform(r.scanlineDensity)), 0.0);
                }
            }

            if (useEnvironmentBackdropCompensation && scenePassDepth) {
                const hasSceneGeometry = scenePassDepth.r.lessThan(float(0.999999));
                beauty = vec4(hasSceneGeometry.select(beauty.rgb, hiddenBackgroundNode), beauty.a);
            }

            postProcessing.outputNode = beauty;
            postProcessing.needsUpdate = true;
            pipelineReady = true;
            lastError = '';
            forceEnvironmentBackground = useEnvironmentBackdropCompensation;
        } catch (error) {
            forceEnvironmentBackground = false;
            disableWithError('SSGI setup failed', error);
        }
    }

    return {
        getState() {
            return snapshotState();
        },
        getDerivedState() {
            return computeDerivedState();
        },
        hasEnabledEffects() {
            return hasAnyEffectEnabled();
        },
        isEnabled() {
            return state.ssgi.enabled;
        },
        isAvailable() {
            return available;
        },
        getLastError() {
            return lastError;
        },
        supportsScreenSpaceEffects() {
            return supportsScreenSpaceEffects;
        },
        setEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'SSGI requires the real WebGPU backend';
                state.ssgi.enabled = false;
                onError(lastError);
                return false;
            }
            state.ssgi.enabled = !!enabled && available;
            rebuildPipeline();
            return state.ssgi.enabled;
        },
        setSSGIOptions(options = {}) {
            assignFinite(state.ssgi, 'radius', options.radius);
            assignFinite(state.ssgi, 'thickness', options.thickness);
            assignFinite(state.ssgi, 'aoIntensity', options.aoIntensity);
            assignFinite(state.ssgi, 'giIntensity', options.giIntensity);
            assignFinite(state.ssgi, 'expFactor', options.expFactor);
            assignFinite(state.ssgi, 'sliceCount', options.sliceCount);
            assignFinite(state.ssgi, 'stepCount', options.stepCount);
            if (typeof options.temporal === 'boolean') state.ssgi.temporal = options.temporal;
            rebuildPipeline();
            return { ...state.ssgi };
        },
        isSSREnabled() {
            return state.ssr.enabled;
        },
        setSSREnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'SSR requires the real WebGPU backend';
                state.ssr.enabled = false;
                onError(lastError);
                return false;
            }
            state.ssr.enabled = !!enabled && available;
            rebuildPipeline();
            return state.ssr.enabled;
        },
        setSSROptions(options = {}) {
            assignFinite(state.ssr, 'quality', options.quality);
            assignFinite(state.ssr, 'blurQuality', options.blurQuality);
            assignFinite(state.ssr, 'maxDistance', options.maxDistance);
            assignFinite(state.ssr, 'opacity', options.opacity);
            assignFinite(state.ssr, 'thickness', options.thickness);
            rebuildPipeline();
            return { ...state.ssr };
        },
        isGTAOEnabled() {
            return state.gtao.enabled;
        },
        setGTAOEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'GTAO requires the real WebGPU backend';
                state.gtao.enabled = false;
                onError(lastError);
                return false;
            }
            state.gtao.enabled = !!enabled && available;
            rebuildPipeline();
            return state.gtao.enabled;
        },
        setGTAOOptions(options = {}) {
            assignFinite(state.gtao, 'samples', options.samples);
            assignFinite(state.gtao, 'distanceExponent', options.distanceExponent);
            assignFinite(state.gtao, 'distanceFallOff', options.distanceFallOff);
            assignFinite(state.gtao, 'radius', options.radius);
            assignFinite(state.gtao, 'scale', options.scale);
            assignFinite(state.gtao, 'thickness', options.thickness);
            assignFinite(state.gtao, 'resolutionScale', options.resolutionScale);
            rebuildPipeline();
            return { ...state.gtao };
        },
        isMotionBlurEnabled() {
            return state.motionBlur.enabled;
        },
        setMotionBlurEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'Motion blur requires the real WebGPU backend';
                state.motionBlur.enabled = false;
                onError(lastError);
                return false;
            }
            state.motionBlur.enabled = !!enabled && available;
            rebuildPipeline();
            return state.motionBlur.enabled;
        },
        setMotionBlurOptions(options = {}) {
            assignFinite(state.motionBlur, 'amount', options.amount);
            assignFinite(state.motionBlur, 'samples', options.samples);
            rebuildPipeline();
            return { ...state.motionBlur };
        },
        isTRAAEnabled() {
            return state.traa.enabled;
        },
        setTRAAEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'TRAA requires the real WebGPU backend';
                state.traa.enabled = false;
                onError(lastError);
                return false;
            }
            state.traa.enabled = !!enabled && available;
            rebuildPipeline();
            return state.traa.enabled;
        },
        setTRAAOptions(options = {}) {
            if (typeof options.useSubpixelCorrection === 'boolean') state.traa.useSubpixelCorrection = options.useSubpixelCorrection;
            assignFinite(state.traa, 'depthThreshold', options.depthThreshold);
            assignFinite(state.traa, 'edgeDepthDiff', options.edgeDepthDiff);
            assignFinite(state.traa, 'maxVelocityLength', options.maxVelocityLength);
            rebuildPipeline();
            return { ...state.traa };
        },
        setEnvironmentVisible(visible) {
            const nextVisible = !!visible;
            if (environmentVisible === nextVisible) return environmentVisible;
            environmentVisible = nextVisible;
            if (state.ssr.enabled) rebuildPipeline();
            return environmentVisible;
        },
        isBloomEnabled() {
            return state.bloom.enabled;
        },
        setBloomEnabled(enabled) {
            state.bloom.enabled = !!enabled && available;
            rebuildPipeline();
            return state.bloom.enabled;
        },
        setBloomOptions(options = {}) {
            assignFinite(state.bloom, 'strength', options.strength);
            assignFinite(state.bloom, 'radius', options.radius);
            assignFinite(state.bloom, 'threshold', options.threshold);
            rebuildPipeline();
            return { ...state.bloom };
        },
        isToonOutlineEnabled() {
            return state.toonOutline.enabled;
        },
        setToonOutlineEnabled(enabled) {
            state.toonOutline.enabled = !!enabled;
            rebuildPipeline();
            return state.toonOutline.enabled;
        },
        setToonOutlineOptions(options = {}) {
            assignFinite(state.toonOutline, 'edgeStrength', options.edgeStrength);
            assignFinite(state.toonOutline, 'edgeGlow', options.edgeGlow);
            assignFinite(state.toonOutline, 'edgeThickness', options.edgeThickness);
            if (Array.isArray(options.visibleEdgeColor)) state.toonOutline.visibleEdgeColor = options.visibleEdgeColor;
            if (Array.isArray(options.hiddenEdgeColor)) state.toonOutline.hiddenEdgeColor = options.hiddenEdgeColor;
            rebuildPipeline();
            return { ...state.toonOutline };
        },
        isContactShadowEnabled() {
            return state.contactShadow.enabled;
        },
        setContactShadowEnabled(enabled) {
            if (enabled && !mainLight) {
                // Auto-find a directional light in the scene
                scene.traverse(obj => {
                    if (!mainLight && obj.isDirectionalLight) mainLight = obj;
                });
            }
            if (enabled && !mainLight) {
                lastError = 'Contact shadows require a DirectionalLight';
                onError(lastError);
                return false;
            }
            state.contactShadow.enabled = !!enabled && available;
            if (!state.contactShadow.enabled) {
                restoreForcedContactShadowLight();
            }
            rebuildPipeline();
            return state.contactShadow.enabled;
        },
        setContactShadowOptions(options = {}) {
            assignFinite(state.contactShadow, 'maxDistance', options.maxDistance);
            assignFinite(state.contactShadow, 'thickness', options.thickness);
            assignFinite(state.contactShadow, 'shadowIntensity', options.shadowIntensity);
            assignFinite(state.contactShadow, 'quality', options.quality);
            if (typeof options.temporal === 'boolean') state.contactShadow.temporal = options.temporal;
            rebuildPipeline();
            return { ...state.contactShadow };
        },
        setMainLight(light) {
            const changed = mainLight !== light;
            mainLight = light;
            if (changed && state.contactShadow.enabled) rebuildPipeline();
        },
        isRetroEnabled() {
            return state.retro.enabled;
        },
        setRetroEnabled(enabled) {
            state.retro.enabled = !!enabled;
            rebuildPipeline();
            return state.retro.enabled;
        },
        setRetroOptions(options = {}) {
            if (typeof options.wiggle === 'boolean') state.retro.wiggle = options.wiggle;
            assignFinite(state.retro, 'affineDistortion', options.affineDistortion);
            assignFinite(state.retro, 'resolutionScale', options.resolutionScale);
            if (typeof options.filterTextures === 'boolean') state.retro.filterTextures = options.filterTextures;
            if (typeof options.dither === 'boolean') state.retro.dither = options.dither;
            assignFinite(state.retro, 'colorDepth', options.colorDepth);
            if (typeof options.scanlines === 'boolean') state.retro.scanlines = options.scanlines;
            assignFinite(state.retro, 'scanlineIntensity', options.scanlineIntensity);
            assignFinite(state.retro, 'scanlineDensity', options.scanlineDensity);
            if (typeof options.crt === 'boolean') state.retro.crt = options.crt;
            assignFinite(state.retro, 'vignetteIntensity', options.vignetteIntensity);
            assignFinite(state.retro, 'bleeding', options.bleeding);
            assignFinite(state.retro, 'curvature', options.curvature);
            rebuildPipeline();
            return { ...state.retro };
        },
        render() {
            if (!hasAnyEffectEnabled() || !pipelineReady) {
                renderer.render(scene, camera);
                return;
            }

            const originalBackground = forceEnvironmentBackground ? scene.background : null;

            try {
                if (forceEnvironmentBackground) {
                    scene.background = scene.environment;
                }
                updateActiveScreenSpaceParams();
                prepareSceneForPostPass();
                postProcessing.render();
                restoreSceneAfterPostPass();
            } catch (error) {
                restoreSceneAfterPostPass();
                disableWithError('Post pipeline render failed', error);
                renderer.render(scene, camera);
            } finally {
                if (forceEnvironmentBackground) {
                    scene.background = originalBackground;
                }
            }
        },
        resize() {
            // Post-processing handles resize internally — no need to force recompile
        },
    };
}
