// Shader Lab final-stylize stage — shared by the editor facade
// (maxjs_fx.js) and the standalone snapshot viewer (snapshot_fx.js).
// Verbatim move of the Shader Lab render-final machinery from maxjs_fx.js:
// the native stack renders into a half-float input target, then the Shader
// Lab postprocessing graph (shader_lab_fx.js → @basementstudio/shader-lab)
// consumes that texture as the final pass and blits to the output.
//
// This module deliberately does NOT create the Shader Lab fx instance — the
// editor injects its panel-managed instance, the snapshot creates one from
// shader_lab_fx.js and enables it from snapshotUi.shaderLab. Loading
// shader-lab pulls React + the library from esm.sh at runtime (needs net);
// callers must treat enable() failure as a graceful no-FX fallback.
import * as THREE from 'three';

export function createShaderLabFinal({
    renderer,
    getShaderLabFx,
    getScaledPostFxSize,
    supportsScreenSpaceEffects = false,
}) {
    let shaderLabInputTarget = null;
    let lastShaderLabFrameTime = 0;
    const drawBufferSize = new THREE.Vector2();

    function readRendererDrawBufferSize() {
        if (typeof renderer.getDrawingBufferSize === 'function') {
            return renderer.getDrawingBufferSize(drawBufferSize);
        }
        return renderer.getSize(drawBufferSize);
    }

    function getInputs() {
        return {
            color: true,
            depth: false,
            normal: false,
            motion: false,
            slot: 'finalStylize',
        };
    }

    function isEnabled() {
        return supportsScreenSpaceEffects && !!getShaderLabFx()?.isEnabled?.();
    }

    function hasPassEnabled() {
        return isEnabled()
            && getShaderLabFx().canRenderWithInputs?.(getInputs()) !== false;
    }

    function ensureInputTarget() {
        readRendererDrawBufferSize();
        const drawWidth = Math.max(1, Math.round(drawBufferSize.x || renderer.domElement?.width || 1));
        const drawHeight = Math.max(1, Math.round(drawBufferSize.y || renderer.domElement?.height || 1));
        const { width, height } = getScaledPostFxSize(drawWidth, drawHeight);
        getShaderLabFx()?.resize?.(width, height);
        if (shaderLabInputTarget && shaderLabInputTarget.width === width && shaderLabInputTarget.height === height) {
            return shaderLabInputTarget;
        }
        try { shaderLabInputTarget?.dispose?.(); } catch (_) {}
        shaderLabInputTarget = new THREE.RenderTarget(width, height, {
            type: THREE.HalfFloatType,
            colorSpace: THREE.LinearSRGBColorSpace,
            depthBuffer: true,
            stencilBuffer: false,
        });
        return shaderLabInputTarget;
    }

    function renderFinal(renderNativeToCurrentTarget) {
        if (!hasPassEnabled()) return false;
        const target = ensureInputTarget();
        const previousTarget = renderer.getRenderTarget?.() || null;
        const previousToneMapping = renderer.toneMapping;
        const previousExposure = renderer.toneMappingExposure;
        const previousOutputColorSpace = renderer.outputColorSpace;
        const previousClearColor = new THREE.Color();
        try { renderer.getClearColor?.(previousClearColor); } catch (_) {}
        const previousClearAlpha = typeof renderer.getClearAlpha === 'function'
            ? renderer.getClearAlpha()
            : null;
        const now = performance.now() * 0.001;
        const delta = lastShaderLabFrameTime > 0 ? now - lastShaderLabFrameTime : 0;
        lastShaderLabFrameTime = now;

        try {
            renderer.toneMapping = THREE.NoToneMapping;
            renderer.toneMappingExposure = 1.0;
            renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
            renderer.setClearColor?.(0x000000, 0);
            renderer.setRenderTarget(target);
            renderNativeToCurrentTarget();
        } finally {
            renderer.setRenderTarget(previousTarget);
            renderer.toneMapping = previousToneMapping;
            renderer.toneMappingExposure = previousExposure;
            renderer.outputColorSpace = previousOutputColorSpace;
            if (previousClearAlpha != null) {
                try { renderer.setClearColor?.(previousClearColor, previousClearAlpha); } catch (_) {}
            }
        }

        return getShaderLabFx().renderTexture?.(target.texture, now, delta, {
            inputs: getInputs(),
            outputTarget: previousTarget,
        }) === true;
    }

    return {
        getInputs,
        isEnabled,
        hasPassEnabled,
        renderFinal,
        dispose() {
            try { shaderLabInputTarget?.dispose?.(); } catch (_) {}
            shaderLabInputTarget = null;
            lastShaderLabFrameTime = 0;
        },
    };
}
