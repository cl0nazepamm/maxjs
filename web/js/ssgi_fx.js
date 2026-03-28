import * as THREE from 'three';
import {
    add,
    blendColor,
    colorToDirection,
    diffuseColor,
    directionToColor,
    metalness,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    sample,
    vec2,
    vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';

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
    };

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
        return state.ssgi.enabled || state.ssr.enabled || state.bloom.enabled;
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
            const scenePass = pass(scene, camera);
            activeNodes.push(scenePass);

            scenePass.setMRT(mrt({
                output,
                diffuseColor,
                normal: directionToColor(normalView),
                metalrough: vec2(metalness, roughness),
            }));

            setTexturePrecision(scenePass);

            const scenePassColor = scenePass.getTextureNode('output');
            const scenePassDiffuse = scenePass.getTextureNode('diffuseColor');
            const scenePassDepth = scenePass.getTextureNode('depth');
            const scenePassNormalColor = scenePass.getTextureNode('normal');
            const scenePassMetalRough = scenePass.getTextureNode('metalrough');
            const sceneNormal = sample((uvNode) => colorToDirection(scenePassNormalColor.sample(uvNode)));
            let beauty = scenePassColor;

            if (state.ssgi.enabled) {
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

            if (state.ssr.enabled) {
                const derived = computeDerivedState();
                const ssrPass = ssr(
                    scenePassColor,
                    scenePassDepth,
                    sceneNormal,
                    scenePassMetalRough.r,
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
