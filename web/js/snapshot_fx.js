// Standalone snapshot post-FX wrapper. Dynamic-imports ONLY the enabled
// effect descriptors (snapshot.json → runtimeFeatures.post_fx) and runs them
// through the same fx/core.js frame graph as the editor — structural 1:1
// parity with maxjs_fx.js. Final-stylize stages replay through the same
// shared modules the editor uses:
//   - 'powershot' → fx/final/powershot.js (TSL ISP, fully offline)
//   - 'shaderLab' → fx/final/shaderlab.js + shader_lab_fx.js (React +
//     @basementstudio/shader-lab from esm.sh — needs network; falls back to
//     no-FX gracefully when offline)
// Editor-only concerns that never replay here: clone overlay, UI setters.
// colorGrading flows through applySnapshotCoreLook in snapshot_boot.js,
// except when PowerShot is active (it grades its own output, matching the
// editor's syncCanvasColorGrading behavior).
import * as THREE from 'three';
import { createFxCore } from './fx/core.js';
import { loadEffects } from './fx/loader.js';

// post_fx ids that are not TSL composite descriptors. 'clone' is a CPU
// overlay with no snapshot module (outline only, future).
const FINAL_STAGE_IDS = new Set(['powershot', 'shaderLab']);
const SKIPPED_IDS = new Set(['clone']);

function cloneEffectDefaults(defaults = {}) {
    const copy = {};
    for (const [key, value] of Object.entries(defaults)) {
        copy[key] = Array.isArray(value) ? [...value] : value;
    }
    return copy;
}

export async function createSnapshotFx({
    renderer,
    scene,
    camera,
    postFx = [],
    backendLabel = '',
    environmentVisible = true,
}) {
    const supportsScreenSpaceEffects = backendLabel === 'WebGPU' || backendLabel === 'TSL_GL';
    const descriptorIds = postFx.filter((id) => !FINAL_STAGE_IDS.has(id) && !SKIPPED_IDS.has(id));
    const wantsPowerShot = postFx.includes('powershot');
    const wantsShaderLab = postFx.includes('shaderLab');

    const descriptors = await loadEffects(descriptorIds);

    const state = {};
    for (const descriptor of descriptors) {
        state[descriptor.id] = cloneEffectDefaults(descriptor.defaults);
    }
    state.powershot = { enabled: false, mode: 'digital', preset: 'powershot', freezeNoise: false };

    let mainLight = null;
    let envVisible = environmentVisible !== false;
    let resolutionScale = 1.0;
    let shaderLabFx = null;
    let shaderLabFinal = null;
    let powerShotFinal = null;

    function isShaderLabEnabled() {
        return !!shaderLabFinal?.isEnabled();
    }

    const core = createFxCore({
        renderer,
        scene,
        descriptors,
        state,
        getCamera: () => camera,
        getMainLight: () => mainLight,
        supportsScreenSpaceEffects,
        isShaderLabEnabled,
        getEnvironmentVisible: () => envVisible,
        getResolutionScale: () => resolutionScale,
    });

    // Final-stylize stages — same shared modules the editor facade uses.
    if (wantsPowerShot && supportsScreenSpaceEffects) {
        try {
            const { createPowerShotFinal } = await import('./fx/final/powershot.js');
            powerShotFinal = createPowerShotFinal({
                renderer,
                getOptions: () => state.powershot,
                getScaledPostFxSize: core.getScaledPostFxSize,
                supportsScreenSpaceEffects,
                isShaderLabEnabled,
            });
        } catch (error) {
            console.warn('[snapshot_fx] PowerShot module init failed', error);
        }
    }
    if (wantsShaderLab && supportsScreenSpaceEffects) {
        try {
            const [{ createShaderLabFinal }, { createShaderLabFx }] = await Promise.all([
                import('./fx/final/shaderlab.js'),
                import('./shader_lab_fx.js'),
            ]);
            shaderLabFx = createShaderLabFx({ THREE, renderer, scene, camera });
            shaderLabFinal = createShaderLabFinal({
                renderer,
                getShaderLabFx: () => shaderLabFx,
                getScaledPostFxSize: core.getScaledPostFxSize,
                supportsScreenSpaceEffects,
            });
        } catch (error) {
            console.warn('[snapshot_fx] Shader Lab module init failed', error);
        }
    }

    let pipelineReady = false;
    let restored = false;
    let forceEnvironmentBackground = false;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastPixelRatio = 1;

    const drawBufferSize = new THREE.Vector2();

    function readDrawBufferSize() {
        if (typeof renderer.getDrawingBufferSize === 'function') {
            return renderer.getDrawingBufferSize(drawBufferSize);
        }
        return renderer.getSize(drawBufferSize);
    }

    function snapshotRendererSize() {
        readDrawBufferSize();
        lastWidth = drawBufferSize.x;
        lastHeight = drawBufferSize.y;
        lastPixelRatio = Number.isFinite(renderer.getPixelRatio?.()) ? renderer.getPixelRatio() : 1;
    }

    function rendererSizeChanged() {
        readDrawBufferSize();
        const pixelRatio = Number.isFinite(renderer.getPixelRatio?.()) ? renderer.getPixelRatio() : 1;
        return drawBufferSize.x !== lastWidth
            || drawBufferSize.y !== lastHeight
            || Math.abs(pixelRatio - lastPixelRatio) > 1.0e-6;
    }

    function findMainLight() {
        mainLight = null;
        scene.traverse((obj) => {
            if (!mainLight && obj.isDirectionalLight) mainLight = obj;
        });
    }

    function hasPipelineEffectEnabled() {
        // PowerShot wraps the post pipeline output, so it forces a (possibly
        // bare scene-pass) pipeline build — identical to the editor facade.
        return core.anyEffectActive() || !!powerShotFinal?.isActive();
    }

    // The editor clears the CSS colorGrading filter while PowerShot is active
    // (PowerShot grades its own output). applySnapshotCoreLook may have set
    // the filter from fx.colorGrading before we got here.
    function syncCanvasFilterForPowerShot() {
        const canvas = renderer?.domElement;
        if (!canvas?.style) return;
        if (powerShotFinal?.isActive() && canvas.style.filter) {
            canvas.style.filter = '';
        }
    }

    function rebuild() {
        core.prepareRebuild();
        if (!hasPipelineEffectEnabled()) {
            pipelineReady = false;
            forceEnvironmentBackground = false;
            core.teardownPipeline();
            syncCanvasFilterForPowerShot();
            return;
        }
        core.clearNodes();
        syncCanvasFilterForPowerShot();
        const result = core.buildPipeline();
        if (result.ok) {
            pipelineReady = true;
            forceEnvironmentBackground = result.forceEnvironmentBackground;
            snapshotRendererSize();
        } else {
            pipelineReady = false;
            forceEnvironmentBackground = false;
            core.handleBuildFailure();
            console.warn('[snapshot_fx] post-FX pipeline build failed; falling back to plain render', result.error);
        }
    }

    // Shader Lab enable() resolves asynchronously (esm.sh fetch) and retro /
    // PS1 wiggle yield to it — same listener contract as the editor facade.
    if (typeof window !== 'undefined' && wantsShaderLab) {
        window.addEventListener('maxjs-shader-lab-state', () => {
            core.syncSharedSceneEffects(true);
            if (supportsScreenSpaceEffects && state.retro?.enabled && restored) {
                rebuild();
            }
        });
    }

    return {
        /**
         * Replay the exported editor post-FX state.
         * @param fx      snapshotUi.fx (descriptor states + powershot)
         * @param extras  { shaderLab } — snapshotUi.shaderLab ({config, enabled, passes})
         */
        restoreState(fx = {}, extras = {}) {
            for (const descriptor of descriptors) {
                const source = fx?.[descriptor.id];
                if (!source || typeof source !== 'object') continue;
                state[descriptor.id] = { ...state[descriptor.id], ...source };
                for (const [key, value] of Object.entries(state[descriptor.id])) {
                    if (Array.isArray(value)) state[descriptor.id][key] = [...value];
                }
            }
            if (fx?.powershot && typeof fx.powershot === 'object') {
                state.powershot = { ...state.powershot, ...fx.powershot };
            }
            if (powerShotFinal?.hasPipeline()) powerShotFinal.syncPipeline();

            const shaderLabState = extras?.shaderLab;
            if (shaderLabFx && shaderLabState && typeof shaderLabState === 'object') {
                shaderLabFx.setState?.(shaderLabState);
                if (shaderLabState.enabled && !shaderLabFx.isEnabled()) {
                    shaderLabFx.enable(shaderLabState).catch((error) => {
                        console.warn('[snapshot_fx] Shader Lab enable failed (offline?); continuing without it', error);
                    });
                }
            }

            restored = true;
            findMainLight();
            rebuild();
        },

        /** Editor's environmentVisible flag (HDRI shown as backdrop). */
        setEnvironmentVisible(visible) {
            envVisible = visible !== false;
        },

        /** Editor's exported post-FX resolution scale (snapshotUi.performance.postFxScale). */
        setResolutionScale(scale) {
            const numeric = Number(scale);
            if (!Number.isFinite(numeric)) return resolutionScale;
            resolutionScale = THREE.MathUtils.clamp(numeric, 0.25, 1.0);
            if (restored) rebuild();
            return resolutionScale;
        },

        /**
         * Call after scene.environment changes (the snapshot HDRI applies
         * AFTER snapshotUi in boot, so the env-backdrop compensation needs
         * one rebuild once the environment exists).
         */
        notifyEnvironmentChanged(visible) {
            if (typeof visible === 'boolean') envVisible = visible;
            if (restored && (pipelineReady || hasPipelineEffectEnabled())) rebuild();
        },

        isEnabled() {
            return (pipelineReady && hasPipelineEffectEnabled())
                || !!shaderLabFinal?.hasPassEnabled()
                || !!powerShotFinal?.isActive();
        },

        render() {
            if (pipelineReady && rendererSizeChanged()) {
                rebuild();
            }
            core.updateFrameTimers();
            syncCanvasFilterForPowerShot();

            const shaderLabActive = !!shaderLabFinal?.hasPassEnabled();

            if (!hasPipelineEffectEnabled() || !pipelineReady) {
                if (shaderLabActive) {
                    const consumed = shaderLabFinal.renderFinal(() => renderer.render(scene, camera));
                    if (!consumed) renderer.render(scene, camera);
                } else if (powerShotFinal?.isActive()) {
                    const consumed = powerShotFinal.renderFinal(() => renderer.render(scene, camera));
                    if (!consumed) renderer.render(scene, camera);
                } else {
                    renderer.render(scene, camera);
                }
                return;
            }

            const originalBackground = forceEnvironmentBackground ? scene.background : null;
            try {
                if (forceEnvironmentBackground) {
                    scene.background = scene.environment;
                }
                core.updatePerFrame();
                if (shaderLabActive) {
                    const consumed = shaderLabFinal.renderFinal(() => core.postProcessing.render());
                    if (!consumed) core.postProcessing.render();
                } else if (powerShotFinal?.isActive()) {
                    const consumed = powerShotFinal.renderFinal(() => core.postProcessing.render());
                    if (!consumed) core.postProcessing.render();
                } else {
                    core.postProcessing.render();
                }
            } catch (error) {
                console.warn('[snapshot_fx] post pipeline render failed; disabling post-FX', error);
                pipelineReady = false;
                core.restoreSceneAfterPostPass();
                core.handleBuildFailure();
                renderer.render(scene, camera);
            } finally {
                if (forceEnvironmentBackground) {
                    scene.background = originalBackground;
                }
            }
        },

        resize() {
            if (pipelineReady && rendererSizeChanged()) rebuild();
        },

        dispose() {
            pipelineReady = false;
            core.teardownPipeline();
            powerShotFinal?.dispose?.();
            shaderLabFinal?.dispose?.();
            try { shaderLabFx?.disable?.(); } catch (_) {}
        },
    };
}
