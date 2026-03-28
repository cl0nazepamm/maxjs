import * as THREE from 'three';
import {
    add,
    blendColor,
    colorToDirection,
    diffuseColor,
    directionToColor,
    float,
    max,
    metalness,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    sample,
    sub,
    vec2,
    vec3,
    vec4,
    screenUV,
    screenSize,
    builtinShadowContext,
    posterize,
    uniform,
    replaceDefaultUV,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import { sss } from 'three/addons/tsl/display/SSSNode.js';
import { scanlines, vignette, colorBleeding, barrelUV } from 'three/addons/tsl/display/CRT.js';
import { bayerDither } from 'three/addons/tsl/math/Bayer.js';
import { retroPass } from 'three/addons/tsl/display/RetroPassNode.js';

function setTexturePrecision(scenePass) {
    const diffuseTexture = scenePass.getTexture('diffuseColor');
    if (diffuseTexture) diffuseTexture.type = THREE.UnsignedByteType;

    const normalTexture = scenePass.getTexture('normal');
    if (normalTexture) normalTexture.type = THREE.UnsignedByteType;

    const metalRoughTexture = scenePass.getTexture('metalrough');
    if (metalRoughTexture) metalRoughTexture.type = THREE.UnsignedByteType;
}

export function createSSGIController({ renderer, scene, camera, backendLabel = '', onError = () => {} }) {
    const postProcessing = new THREE.PostProcessing(renderer);
    const supportsScreenSpaceEffects = backendLabel === 'WebGPU';
    const SSR_REFERENCE_SIZE = 6.0;
    const SSR_DIELECTRIC_STRENGTH = 0.35;
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
        bloom: {
            enabled: false,
            strength: 0.4,
            radius: 0.2,
            threshold: 0.75,
        },
        outline: {
            enabled: false,
            edgeStrength: 3.0,
            edgeGlow: 0.0,
            edgeThickness: 1.0,
            visibleEdgeColor: [1, 1, 1],
            hiddenEdgeColor: [0.3, 0.2, 0.2],
        },
        contactShadow: {
            enabled: false,
            maxDistance: 0.15,
            thickness: 0.01,
            shadowIntensity: 1.0,
            quality: 0.5,
            temporal: true,
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
    let hiddenDuringPost = [];

    function prepareSceneForPostPass() {
        hiddenDuringPost = [];

        scene.traverse((object) => {
            if (!object?.visible) return;

            if (object.isLine || object.isLineSegments || object.isPoints || object.isSprite) {
                hiddenDuringPost.push(object);
                object.visible = false;
                return;
            }

            if (!object.isMesh || !object.geometry) return;

            const hasNormal = !!object.geometry.getAttribute?.('normal');
            if (!hasNormal && object.geometry.getAttribute?.('position')) {
                try {
                    object.geometry.computeVertexNormals();
                } catch (error) {
                    hiddenDuringPost.push(object);
                    object.visible = false;
                }
            }
        });
    }

    function restoreSceneAfterPostPass() {
        for (const object of hiddenDuringPost) {
            object.visible = true;
        }
        hiddenDuringPost = [];
    }

    function clearNodes() {
        activeSSRPass = null;
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
        state.bloom.enabled = false;
        pipelineReady = false;
        clearNodes();
        postProcessing.outputNode = null;
        postProcessing.needsUpdate = true;
        onError(`${prefix}: ${lastError}`);
    }

    function hasAnyEffectEnabled() {
        return state.ssgi.enabled || state.ssr.enabled || state.bloom.enabled
            || (state.outline.enabled && selectedObjects.length > 0)
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
        };
    }

    function snapshotState() {
        return {
            ssgi: { ...state.ssgi },
            ssr: { ...state.ssr },
            bloom: { ...state.bloom },
            outline: { ...state.outline, selectedCount: selectedObjects.length },
            contactShadow: { ...state.contactShadow },
            retro: { ...state.retro },
        };
    }

    function updateActiveScreenSpaceParams() {
        if (!activeSSRPass) return;
        const derived = computeDerivedState();
        activeSSRPass.maxDistance.value = derived.effectiveSSRMaxDistance;
        activeSSRPass.thickness.value = derived.effectiveSSRThickness;
    }

    function assignFinite(target, key, value) {
        if (Number.isFinite(value)) target[key] = value;
    }

    function rebuildPipeline() {
        if (!hasAnyEffectEnabled() || !available) {
            pipelineReady = false;
            clearNodes();
            postProcessing.outputNode = null;
            postProcessing.needsUpdate = true;
            return;
        }

        clearNodes();

        try {
            // Contact shadows need a depth pre-pass
            let sssContext = null;
            if (state.contactShadow.enabled && mainLight) {
                const prePass = pass(scene, camera);
                activeNodes.push(prePass);
                const prePassDepth = prePass.getTextureNode('depth');

                const sssPass = sss(prePassDepth, camera, mainLight);
                sssPass.maxDistance.value = state.contactShadow.maxDistance;
                sssPass.thickness.value = state.contactShadow.thickness;
                sssPass.shadowIntensity.value = state.contactShadow.shadowIntensity;
                sssPass.quality.value = state.contactShadow.quality;
                sssPass.useTemporalFiltering = state.contactShadow.temporal;
                activeNodes.push(sssPass);

                const sssSample = sssPass.getTextureNode().sample(screenUV).r;
                sssContext = builtinShadowContext(sssSample, mainLight);
            }

            const useWiggle = state.retro.enabled && state.retro.wiggle;
            let beauty;
            let scenePassDepth, scenePassDiffuse, scenePassNormalColor, scenePassMetalRough, sceneNormal, ssrReflectivity;

            if (useWiggle) {
                // Wiggle: retroPass replaces the normal scene pass
                const r = state.retro;
                const retro = retroPass(scene, camera, { affineDistortion: uniform(r.affineDistortion) });
                retro.setResolutionScale(r.resolutionScale);
                retro.filterTextures = r.filterTextures;
                activeNodes.push(retro);
                beauty = retro;
                // No MRT — SSGI/SSR won't have depth/normals
            } else {
                // Normal scene pass with MRT for SSGI/SSR
                const scenePass = pass(scene, camera);
                activeNodes.push(scenePass);

                if (sssContext) scenePass.contextNode = sssContext;

                scenePass.setMRT(mrt({
                    output,
                    diffuseColor,
                    normal: directionToColor(normalView),
                    metalrough: vec2(metalness, roughness),
                }));

                setTexturePrecision(scenePass);

                beauty = scenePass.getTextureNode('output');
                scenePassDiffuse = scenePass.getTextureNode('diffuseColor');
                scenePassDepth = scenePass.getTextureNode('depth');
                scenePassNormalColor = scenePass.getTextureNode('normal');
                scenePassMetalRough = scenePass.getTextureNode('metalrough');
                sceneNormal = sample((uvNode) => colorToDirection(scenePassNormalColor.sample(uvNode)));
                ssrReflectivity = max(
                    scenePassMetalRough.r,
                    sub(float(1.0), scenePassMetalRough.g).mul(SSR_DIELECTRIC_STRENGTH)
                );
            }

            if (state.ssgi.enabled && !useWiggle) {
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

            if (state.ssr.enabled && !useWiggle) {
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
                beauty = blendColor(beauty, ssrPass);
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

            if (state.outline.enabled && selectedObjects.length > 0) {
                const outlinePass = outline(scene, camera, {
                    selectedObjects,
                    edgeGlow: float(state.outline.edgeGlow),
                    edgeThickness: float(state.outline.edgeThickness),
                });
                activeNodes.push(outlinePass);

                const visC = state.outline.visibleEdgeColor;
                const hidC = state.outline.hiddenEdgeColor;
                const outlineColor = outlinePass.visibleEdge
                    .mul(vec3(visC[0], visC[1], visC[2]))
                    .add(outlinePass.hiddenEdge.mul(vec3(hidC[0], hidC[1], hidC[2])))
                    .mul(state.outline.edgeStrength);
                beauty = beauty.add(vec4(outlineColor, 0));
            }

            if (state.retro.enabled) {
                const r = state.retro;

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

            postProcessing.outputNode = beauty;
            postProcessing.needsUpdate = true;
            pipelineReady = true;
            lastError = '';
        } catch (error) {
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
        isOutlineEnabled() {
            return state.outline.enabled;
        },
        setOutlineEnabled(enabled) {
            state.outline.enabled = !!enabled;
            rebuildPipeline();
            return state.outline.enabled;
        },
        setSelectedObjects(objects) {
            // Mutate the array in place — OutlineNode holds a reference to it
            selectedObjects.length = 0;
            if (objects) selectedObjects.push(...objects);
            // Only rebuild if outline just became relevant (first selection) or lost all selection
            if (state.outline.enabled && !pipelineReady) rebuildPipeline();
        },
        setOutlineOptions(options = {}) {
            assignFinite(state.outline, 'edgeStrength', options.edgeStrength);
            assignFinite(state.outline, 'edgeGlow', options.edgeGlow);
            assignFinite(state.outline, 'edgeThickness', options.edgeThickness);
            if (Array.isArray(options.visibleEdgeColor)) state.outline.visibleEdgeColor = options.visibleEdgeColor;
            if (Array.isArray(options.hiddenEdgeColor)) state.outline.hiddenEdgeColor = options.hiddenEdgeColor;
            rebuildPipeline();
            return { ...state.outline };
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

            try {
                updateActiveScreenSpaceParams();
                prepareSceneForPostPass();
                postProcessing.render();
                restoreSceneAfterPostPass();
            } catch (error) {
                restoreSceneAfterPostPass();
                disableWithError('Post pipeline render failed', error);
                renderer.render(scene, camera);
            }
        },
        resize() {
            if (hasAnyEffectEnabled()) {
                postProcessing.needsUpdate = true;
            }
        },
    };
}
