// spectral_tracer.js — WebGPU spectral path tracer controller.
//
// Drop-in replacement for createPathTracingController (the old WebGL
// three-gpu-pathtracer wrapper). Exposes the SAME public surface so the
// existing index.html touchpoints (render-mode branch, env binding, live
// rebuild scheduling, settings/bridge, powershot capture) keep working.
//
// Runs on the SAME WebGPURenderer as a render-loop branch: a compute kernel
// traces 1 sample/pixel/frame into an XYZ accumulation buffer, then a
// fullscreen QuadMesh blits XYZ→sRGB to the canvas (bypassing post-FX, as the
// old PT mode did). Scene/BVH build is CPU-side and debounced; accumulation
// resets on camera move or scene-dirty.

import * as THREE from 'three';
import { buildSpectralScene } from './spectral_scene.js';
import { buildKernels } from './spectral_kernel.js';

const SCENE_REBUILD_COALESCE_MS = 25;
const SCENE_REBUILD_MIN_INTERVAL_MS = 50;
const SCENE_REBUILD_RETRY_MS = 1000;
const CAMERA_MATRIX_EPSILON = 1e-6;
const DEFAULT_SAMPLES_PER_FRAME = 64;
const MIN_SAMPLES_PER_FRAME = 1;
const MAX_SAMPLES_PER_FRAME = 512;
const DEFAULT_GI_CLAMP = 8.0;
const MIN_GI_CLAMP = 1.0;
const MAX_GI_CLAMP = 1000.0;
const DEFAULT_SAMPLE_LIMIT = 0;     // 0 = unlimited (keep accumulating forever)
const MAX_SAMPLE_LIMIT = 100000;
const MAX_TRIANGLES = 4_000_000;

function normalizeSamplesPerFrame(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_SAMPLES_PER_FRAME;
    return Math.max(MIN_SAMPLES_PER_FRAME, Math.min(MAX_SAMPLES_PER_FRAME, n));
}
function normalizeGIClamp(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_GI_CLAMP;
    return Math.max(MIN_GI_CLAMP, Math.min(MAX_GI_CLAMP, n));
}
function normalizeSampleLimit(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_SAMPLE_LIMIT;
    return Math.min(MAX_SAMPLE_LIMIT, n);
}
function matrixChanged(matrix, cache, epsilon = CAMERA_MATRIX_EPSILON) {
    const e = matrix?.elements;
    if (!e) return false;
    if (!cache.initialized) { cache.values.set(e); cache.initialized = true; return true; }
    for (let i = 0; i < 16; i++) {
        if (Math.abs(cache.values[i] - e[i]) > epsilon) { cache.values.set(e); return true; }
    }
    return false;
}

export function createSpectralTracer({
    renderer,
    scene,
    camera,
    enabled = false,
    onStatus = () => {},
    onError = () => {},
    settings = {},
} = {}) {
    let activeCamera = camera;
    let disposed = false;
    let started = false;

    let sceneDirty = true;
    let sceneDirtyAt = 0;
    let hasSceneBuilt = false;
    let lastSceneRebuildAt = -Infinity;
    let nextRebuildRetryAt = 0;
    let lastRebuildErrorKey = '';
    let renderedSamples = 0;
    let frameSeed = 1;
    let captureMode = false;
    let paused = false;
    let warnedUnsupported = false;

    let samplesPerFrame = normalizeSamplesPerFrame(settings.samplesPerFrame);
    let giClamp = normalizeGIClamp(settings.giClamp);
    let sampleLimit = normalizeSampleLimit(settings.sampleLimit);
    let convergedNotified = false;
    let freezeSync = settings.freezeSync === true;
    // Camera post: thin-lens DOF + where tone mapping happens.
    let dofEnabled = false;
    let dofFocusDistance = 5;
    let dofApertureRadius = 0;
    let toneMapInBlit = true; // false → emit linear HDR for an external post stack

    const lastCameraWorld = { initialized: false, values: new Float64Array(16) };
    const lastCameraProj = { initialized: false, values: new Float64Array(16) };

    // GPU resources (rebuilt on scene change)
    let gpu = null; // { buffers, kernels, quad, width, height, env }

    function isEnabled() { return enabled === true && !disposed; }
    function isStarted() { return started === true && isEnabled(); }
    function isSupported() { return renderer?.backend?.isWebGPUBackend === true; }

    function resetCameraKeys() {
        lastCameraWorld.initialized = false;
        lastCameraProj.initialized = false;
    }

    function requestSceneRebuild({ immediate = false } = {}) {
        const wasDirty = sceneDirty;
        sceneDirty = true;
        const now = performance.now();
        if (immediate) sceneDirtyAt = now;
        else if (!wasDirty || sceneDirtyAt <= now) sceneDirtyAt = now + SCENE_REBUILD_COALESCE_MS;
    }

    function shouldRebuildSceneNow(now = performance.now()) {
        if (!sceneDirty) return false;
        if (freezeSync && hasSceneBuilt) return false;
        if (now < nextRebuildRetryAt) return false;
        if (now < sceneDirtyAt) return false;
        if (Number.isFinite(lastSceneRebuildAt) && now - lastSceneRebuildAt < SCENE_REBUILD_MIN_INTERVAL_MS) {
            sceneDirtyAt = lastSceneRebuildAt + SCENE_REBUILD_MIN_INTERVAL_MS;
            return false;
        }
        return true;
    }

    function preload() { return Promise.resolve(); }

    function start() {
        if (!isEnabled()) return false;
        if (started) return true;
        started = true;
        requestSceneRebuild({ immediate: true });
        return true;
    }

    function rendererSize() {
        const v = new THREE.Vector2();
        renderer.getDrawingBufferSize(v);
        return { width: Math.max(1, Math.floor(v.x)), height: Math.max(1, Math.floor(v.y)) };
    }

    function disposeGPU() {
        if (!gpu) return;
        for (const key of ['bvhNodes', 'triIndex', 'vertexPos', 'triMaterial', 'materials', 'lights', 'accum']) {
            gpu.buffers[key]?.dispose?.();
        }
        gpu.quad?.material?.dispose?.();
        gpu.quad?.geometry?.dispose?.();
        gpu = null;
    }

    function makeStorage(array) {
        return new THREE.StorageBufferAttribute(array, 1);
    }

    function rebuildScene() {
        try {
            const built = buildSpectralScene({ THREE, scene, maxTriangles: MAX_TRIANGLES });
            if (!built) {
                // Empty scene — nothing to trace. Treat as built so we just clear.
                disposeGPU();
                hasSceneBuilt = false;
                sceneDirty = false;
                sceneDirtyAt = 0;
                return true;
            }
            if (built.error) {
                onStatus(`max.js - Path tracer: ${built.error}`);
                sceneDirty = false; // don't spin; surface the cap and stop
                hasSceneBuilt = false;
                return false;
            }

            disposeGPU();
            const { width, height } = rendererSize();
            const buffers = {
                bvhNodes: makeStorage(built.bvhNodes),
                triIndex: makeStorage(built.triIndex),
                vertexPos: makeStorage(built.vertexPos),
                triMaterial: makeStorage(built.triMaterial),
                materials: makeStorage(built.materials),
                lights: makeStorage(built.lights),
                accum: makeStorage(new Float32Array(width * height * 4)),
                lightCount: built.lightCount,
                nodeCount: built.nodeCount,
            };
            const kernels = buildKernels({ THREE, buffers, env: built.env, width, height });
            const quad = new THREE.QuadMesh(kernels.blitMaterial);
            gpu = { buffers, kernels, quad, width, height, env: built.env };

            applyUniformSettings();
            updateCameraUniforms(true);
            renderedSamples = 0;

            sceneDirty = false;
            hasSceneBuilt = true;
            sceneDirtyAt = 0;
            lastSceneRebuildAt = performance.now();
            nextRebuildRetryAt = 0;
            lastRebuildErrorKey = '';
            return true;
        } catch (error) {
            sceneDirty = true;
            const key = error?.stack || error?.message || String(error);
            nextRebuildRetryAt = performance.now() + SCENE_REBUILD_RETRY_MS;
            if (key !== lastRebuildErrorKey) { lastRebuildErrorKey = key; onError(error); }
            return false;
        }
    }

    function applyUniformSettings() {
        if (!gpu) return;
        const u = gpu.kernels.uniforms;
        u.radianceClamp.value = giClamp;
        u.bounceCap.value = captureMode ? 6 : 4;
        u.apertureRadius.value = dofEnabled ? Math.max(0, dofApertureRadius) : 0;
        u.focusDistance.value = Math.max(0.01, dofFocusDistance);
        u.toneMapEnabled.value = toneMapInBlit ? 1 : 0;
    }

    function updateCameraUniforms(force = false) {
        if (!gpu || !activeCamera) return false;
        activeCamera.updateMatrixWorld();
        const worldChanged = matrixChanged(activeCamera.matrixWorld, lastCameraWorld);
        const projChanged = matrixChanged(activeCamera.projectionMatrix, lastCameraProj);
        if (!force && !worldChanged && !projChanged) return false;
        const u = gpu.kernels.uniforms;
        u.camWorld.value.copy(activeCamera.matrixWorld);
        u.camProjInv.value.copy(activeCamera.projectionMatrixInverse);
        u.camPos.value.setFromMatrixPosition(activeCamera.matrixWorld);
        return true;
    }

    function resetAccumulation() {
        if (!gpu) return;
        renderedSamples = 0;
        convergedNotified = false;
        try { renderer.compute(gpu.kernels.clearKernel); } catch (e) { onError(e); }
    }

    function clearFrame() {
        try { renderer.clear(); } catch {}
        return true;
    }

    function ensureSize() {
        if (!gpu) return;
        const { width, height } = rendererSize();
        if (width !== gpu.width || height !== gpu.height) requestSceneRebuild({ immediate: true });
    }

    function render() {
        if (!isStarted()) return false;
        if (!isSupported()) {
            if (!warnedUnsupported) { warnedUnsupported = true; onStatus('max.js - Path tracer requires the WebGPU backend'); }
            return false;
        }

        // Paused: dispatch NO compute and ignore camera/scene changes — just
        // re-present the accumulated image. The 64 trace dispatches/frame are
        // what starve the GPU/compositor, so this frees the UI panels while the
        // last render stays frozen on screen. Resume picks up where it left off.
        if (paused) {
            if (!gpu) return clearFrame();
            try { gpu.quad.render(renderer); } catch (error) { onError(error); }
            return true;
        }

        if (sceneDirty) {
            if (shouldRebuildSceneNow()) {
                if (!rebuildScene()) return hasSceneBuilt || clearFrame();
            } else if (!hasSceneBuilt) {
                return clearFrame();
            }
        }
        if (!gpu) return clearFrame();

        ensureSize();
        if (!gpu) return clearFrame();

        if (updateCameraUniforms()) resetAccumulation();

        // Sample limit (converge-and-stop): once the target is reached, dispatch
        // no more compute — just hold the converged frame. Frees the GPU exactly
        // like a pause, but automatic. Capture/render-to-image ignores it (it
        // drives its own sample target). A camera move resets and re-traces.
        if (!captureMode && sampleLimit > 0 && renderedSamples >= sampleLimit) {
            if (!convergedNotified) {
                convergedNotified = true;
                onStatus(`max.js - Path tracer converged (${renderedSamples}/${sampleLimit} samples)`);
            }
            try { gpu.quad.render(renderer); } catch (error) { onError(error); }
            return true;
        }

        try {
            const u = gpu.kernels.uniforms;
            const count = samplesPerFrame;
            for (let i = 0; i < count; i++) {
                frameSeed = (frameSeed + 1) >>> 0;
                u.frameSeed.value = frameSeed;
                renderer.compute(gpu.kernels.traceKernel);
                renderedSamples += 1;
            }
            u.sampleCount.value = Math.max(1, renderedSamples);
            // Exposure follows the viewer's tone-mapping exposure (display-time
            // multiply in the blit — no accumulation reset needed).
            u.exposure.value = Number.isFinite(renderer.toneMappingExposure) ? renderer.toneMappingExposure : 1;
            gpu.quad.render(renderer);
            return true;
        } catch (error) {
            onError(error);
            return false;
        }
    }

    function markSceneDirty() { requestSceneRebuild(); }
    function getSampleCount() { return renderedSamples; }
    function isPaused() { return paused === true; }
    function setPaused(next) {
        const v = next === true;
        if (paused === v) return false;
        paused = v;
        // On resume, re-check the camera so a move made while paused triggers a
        // clean restart instead of accumulating onto a stale viewpoint.
        if (!paused) resetCameraKeys();
        onStatus(`max.js - Path tracer ${paused ? 'paused' : 'resumed'}`);
        return true;
    }
    function togglePaused() { setPaused(!paused); return paused; }
    function isCaptureReady(minSamples = 1) {
        return isStarted() && hasSceneBuilt && renderedSamples >= Math.max(1, minSamples | 0);
    }
    function setCaptureMode(next) {
        const v = next === true;
        if (captureMode === v) return false;
        captureMode = v;
        applyUniformSettings();
        resetAccumulation();
        return true;
    }
    function setOptions(options = {}) {
        let changed = false;
        let imageChanged = false;
        if (options.samplesPerFrame != null) {
            const n = normalizeSamplesPerFrame(options.samplesPerFrame);
            changed = changed || n !== samplesPerFrame; samplesPerFrame = n;
        }
        if (options.giClamp != null) {
            const n = normalizeGIClamp(options.giClamp);
            if (n !== giClamp) imageChanged = true;
            changed = changed || n !== giClamp; giClamp = n;
        }
        if (options.freezeSync != null) {
            const n = options.freezeSync === true;
            changed = changed || n !== freezeSync; freezeSync = n;
        }
        if (options.sampleLimit != null) {
            const n = normalizeSampleLimit(options.sampleLimit);
            if (n !== sampleLimit) {
                changed = true;
                sampleLimit = n;
                // raising the cap should resume tracing; re-arm the converged note
                convergedNotified = false;
            }
        }
        if (imageChanged) { applyUniformSettings(); resetAccumulation(); }
        return changed;
    }
    function getSettings() { return { samplesPerFrame, giClamp, freezeSync, sampleLimit }; }
    function setDOF(opts = {}) {
        let changed = false;
        if (typeof opts.enabled === 'boolean' && opts.enabled !== dofEnabled) { dofEnabled = opts.enabled; changed = true; }
        if (Number.isFinite(opts.focusDistance) && opts.focusDistance !== dofFocusDistance) { dofFocusDistance = opts.focusDistance; changed = true; }
        if (Number.isFinite(opts.apertureRadius) && opts.apertureRadius !== dofApertureRadius) { dofApertureRadius = opts.apertureRadius; changed = true; }
        if (changed) { applyUniformSettings(); resetAccumulation(); }
        return changed;
    }
    function setToneMapInBlit(next) {
        const v = next !== false;
        if (toneMapInBlit === v) return false;
        toneMapInBlit = v;
        applyUniformSettings();
        return true;
    }
    function isSyncFrozen() { return freezeSync === true; }
    function setCamera(nextCamera) {
        if (!nextCamera) return;
        activeCamera = nextCamera;
        resetCameraKeys();
        if (updateCameraUniforms(true)) resetAccumulation();
    }
    function dispose() {
        disposed = true;
        disposeGPU();
        hasSceneBuilt = false;
        sceneDirty = false;
    }

    if (typeof window !== 'undefined' && isEnabled()) {
        window.addEventListener('pagehide', dispose, { once: true });
    }

    return {
        isEnabled,
        isStarted,
        preload,
        clearFrame,
        start,
        isSupported,
        render,
        markSceneDirty,
        getSampleCount,
        isPaused,
        setPaused,
        togglePaused,
        isCaptureReady,
        setCaptureMode,
        setOptions,
        getSettings,
        setDOF,
        setToneMapInBlit,
        isSyncFrozen,
        setCamera,
        dispose,
    };
}
