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
//
// Dynamic range: shader-lab's passes are LDR. Its own pipeline clamps every
// layer to [0,1] between passes, so the shaders are written against a
// display-referred image. Ink in particular multiplies by a fixed ~1.9 glow
// gain and then hard-clamps with no rolloff, so feeding it our raw linear-HDR
// native render collapses everything above ~0.5 onto a flat clipped plateau —
// a single 1.4-range highlight smears into a solid white bar. So we tone map
// into a [0,1] linear buffer before handing the texture over, and skip the
// renderer's own output tone mapping on the way out so the curve lands once.
import * as THREE from 'three';
import {
    texture as tslTexture,
    toneMapping as toneMappingNode,
    toneMappingExposure,
    vec4,
} from 'three/tsl';

export function createShaderLabFinal({
    renderer,
    getShaderLabFx,
    getScaledPostFxSize,
    supportsScreenSpaceEffects = false,
    toneMapInput = true,
}) {
    let shaderLabInputTarget = null;
    let toneMapTarget = null;
    let toneMapQuad = null;
    let toneMapMaterial = null;
    let toneMapSourceNode = null;
    let toneMapMode = null;
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

    // r185 forces NoToneMapping whenever the destination is not screen output
    // (Renderer.currentToneMapping), so simply setting renderer.toneMapping and
    // rendering into a target would not apply any curve. The quad below carries
    // the curve in its own colorNode instead.
    function ensureToneMapChain(source, width, height) {
        if (typeof THREE.QuadMesh !== 'function'
            || typeof THREE.MeshBasicNodeMaterial !== 'function'
            || !source) {
            return null;
        }

        if (!toneMapTarget) {
            toneMapTarget = new THREE.RenderTarget(width, height, {
                type: THREE.HalfFloatType,
                colorSpace: THREE.LinearSRGBColorSpace,
                depthBuffer: false,
                stencilBuffer: false,
            });
        } else if (toneMapTarget.width !== width || toneMapTarget.height !== height) {
            toneMapTarget.setSize(width, height);
        }

        if (!toneMapMaterial) {
            toneMapMaterial = new THREE.MeshBasicNodeMaterial();
            toneMapMaterial.name = 'shaderlab-input-tonemap';
            toneMapSourceNode = tslTexture(source);
            toneMapQuad = new THREE.QuadMesh(toneMapMaterial);
        }
        toneMapSourceNode.value = source;

        // The tone mapping type is a compile-time branch inside ToneMappingNode,
        // so the material only gets rebuilt when the user changes the mode.
        const mode = renderer.toneMapping ?? THREE.NoToneMapping;
        if (toneMapMode !== mode) {
            // "none" still has to land in [0,1] — that is what the display would
            // do anyway, and it keeps ink's per-pass mix(blurred, lifted,
            // intensity * 0.5) off its extrapolating branch above intensity 2.
            toneMapMaterial.colorNode = mode === THREE.NoToneMapping
                ? vec4(toneMapSourceNode.rgb.clamp(0, 1), 1)
                : toneMappingNode(mode, toneMappingExposure, vec4(toneMapSourceNode.rgb, 1));
            toneMapMaterial.needsUpdate = true;
            toneMapMode = mode;
        }

        return toneMapTarget;
    }

    function toneMapIntoLdr(source, width, height) {
        const mapped = ensureToneMapChain(source, width, height);
        if (!mapped) return source;

        const previousTarget = renderer.getRenderTarget?.() || null;
        try {
            renderer.initRenderTarget?.(mapped);
            renderer.setRenderTarget(mapped);
            toneMapQuad.render(renderer);
            return mapped.texture;
        } catch (err) {
            console.error('[shader-lab-final] input tone map failed:', err);
            return source;
        } finally {
            renderer.setRenderTarget(previousTarget);
        }
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

        // Runs after the finally above so it sees the real toneMapping /
        // toneMappingExposure again — ToneMappingNode reads exposure through a
        // live renderer reference.
        const shaderLabInput = toneMapInput
            ? toneMapIntoLdr(target.texture, target.width, target.height)
            : target.texture;

        // shader-lab clamps its own output to [0,1], so letting the final blit
        // apply the renderer's curve a second time would only crush an already
        // display-referred image. The curve was spent on the input above.
        const skipOutputToneMapping = shaderLabInput !== target.texture;
        if (skipOutputToneMapping) renderer.toneMapping = THREE.NoToneMapping;
        try {
            return getShaderLabFx().renderTexture?.(shaderLabInput, now, delta, {
                inputs: getInputs(),
                outputTarget: previousTarget,
            }) === true;
        } finally {
            if (skipOutputToneMapping) renderer.toneMapping = previousToneMapping;
        }
    }

    return {
        getInputs,
        isEnabled,
        hasPassEnabled,
        renderFinal,
        dispose() {
            try { shaderLabInputTarget?.dispose?.(); } catch (_) {}
            try { toneMapTarget?.dispose?.(); } catch (_) {}
            try { toneMapMaterial?.dispose?.(); } catch (_) {}
            shaderLabInputTarget = null;
            toneMapTarget = null;
            toneMapQuad = null;
            toneMapMaterial = null;
            toneMapSourceNode = null;
            toneMapMode = null;
            lastShaderLabFrameTime = 0;
        },
    };
}
