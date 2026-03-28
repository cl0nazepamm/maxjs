import * as THREE from 'three';
import {
    add,
    colorToDirection,
    diffuseColor,
    directionToColor,
    mrt,
    normalView,
    output,
    pass,
    sample,
    vec4,
} from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';

function setTexturePrecision(scenePass) {
    const diffuseTexture = scenePass.getTexture('diffuseColor');
    if (diffuseTexture) diffuseTexture.type = THREE.UnsignedByteType;

    const normalTexture = scenePass.getTexture('normal');
    if (normalTexture) normalTexture.type = THREE.UnsignedByteType;
}

export function createSSGIController({ renderer, scene, camera, onError = () => {} }) {
    const postProcessing = new THREE.PostProcessing(renderer);
    const state = {
        enabled: false,
        radius: 8,
        thickness: 1.5,
        aoIntensity: 1.0,
        giIntensity: 1.5,
        expFactor: 1.5,
        sliceCount: 2,
        stepCount: 8,
        temporal: false,
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
        state.enabled = false;
        pipelineReady = false;
        clearNodes();
        postProcessing.outputNode = null;
        postProcessing.needsUpdate = true;
        onError(`${prefix}: ${lastError}`);
    }

    function rebuildPipeline() {
        if (!state.enabled || !available) {
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
            }));

            setTexturePrecision(scenePass);

            const scenePassColor = scenePass.getTextureNode('output');
            const scenePassDiffuse = scenePass.getTextureNode('diffuseColor');
            const scenePassDepth = scenePass.getTextureNode('depth');
            const scenePassNormalColor = scenePass.getTextureNode('normal');
            const sceneNormal = sample((uvNode) => colorToDirection(scenePassNormalColor.sample(uvNode)));

            const ssgiPass = ssgi(scenePassColor, scenePassDepth, sceneNormal, camera);
            ssgiPass.sliceCount.value = state.sliceCount;
            ssgiPass.stepCount.value = state.stepCount;
            ssgiPass.radius.value = state.radius;
            ssgiPass.thickness.value = state.thickness;
            ssgiPass.aoIntensity.value = state.aoIntensity;
            ssgiPass.giIntensity.value = state.giIntensity;
            ssgiPass.expFactor.value = state.expFactor;
            ssgiPass.useTemporalFiltering = state.temporal;
            activeNodes.push(ssgiPass);

            postProcessing.outputNode = vec4(
                add(
                    scenePassColor.rgb.mul(ssgiPass.a),
                    scenePassDiffuse.rgb.mul(ssgiPass.rgb)
                ),
                scenePassColor.a
            );
            postProcessing.needsUpdate = true;
            pipelineReady = true;
            lastError = '';
        } catch (error) {
            disableWithError('SSGI setup failed', error);
        }
    }

    return {
        isEnabled() {
            return state.enabled;
        },
        isAvailable() {
            return available;
        },
        getLastError() {
            return lastError;
        },
        setEnabled(enabled) {
            state.enabled = !!enabled && available;
            rebuildPipeline();
            return state.enabled;
        },
        render() {
            if (!state.enabled || !pipelineReady) {
                renderer.render(scene, camera);
                return;
            }

            try {
                postProcessing.render();
            } catch (error) {
                disableWithError('SSGI render failed', error);
                renderer.render(scene, camera);
            }
        },
        resize() {
            if (state.enabled) {
                postProcessing.needsUpdate = true;
            }
        },
    };
}
