import * as THREE from 'three';
import {
    add,
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
    const renderPipeline = new THREE.RenderPipeline(renderer);
    const supportsScreenSpaceEffects = backendLabel === 'WebGPU';
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

    function clearNodes() {
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
        renderPipeline.outputNode = null;
        renderPipeline.needsUpdate = true;
        onError(`${prefix}: ${lastError}`);
    }

    function hasAnyEffectEnabled() {
        return state.ssgi.enabled || state.ssr.enabled || state.bloom.enabled;
    }

    function rebuildPipeline() {
        if (!hasAnyEffectEnabled() || !available) {
            pipelineReady = false;
            clearNodes();
            renderPipeline.outputNode = null;
            renderPipeline.needsUpdate = true;
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
                const ssrPass = ssr(
                    beauty,
                    scenePassDepth,
                    sceneNormal,
                    scenePassMetalRough.r,
                    scenePassMetalRough.g,
                    camera
                );
                ssrPass.quality.value = state.ssr.quality;
                ssrPass.blurQuality.value = state.ssr.blurQuality;
                ssrPass.maxDistance.value = state.ssr.maxDistance;
                ssrPass.opacity.value = state.ssr.opacity;
                ssrPass.thickness.value = state.ssr.thickness;
                activeNodes.push(ssrPass);
                beauty = vec4(beauty.rgb.add(ssrPass.rgb), beauty.a);
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

            renderPipeline.outputNode = beauty;
            renderPipeline.needsUpdate = true;
            pipelineReady = true;
            lastError = '';
        } catch (error) {
            disableWithError('SSGI setup failed', error);
        }
    }

    return {
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
        isBloomEnabled() {
            return state.bloom.enabled;
        },
        setBloomEnabled(enabled) {
            state.bloom.enabled = !!enabled && available;
            rebuildPipeline();
            return state.bloom.enabled;
        },
        render() {
            if (!hasAnyEffectEnabled() || !pipelineReady) {
                renderer.render(scene, camera);
                return;
            }

            try {
                renderPipeline.render();
            } catch (error) {
                disableWithError('Post pipeline render failed', error);
                renderer.render(scene, camera);
            }
        },
        resize() {
            if (hasAnyEffectEnabled()) {
                renderPipeline.needsUpdate = true;
            }
        },
    };
}
