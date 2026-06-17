// Editor post-FX facade. The public fxApi surface is unchanged; the TSL
// frame graph itself now lives in fx/core.js + fx/effects/* (descriptor
// registry shared 1:1 with the standalone snapshot viewer — see
// docs/POST_FX_UNIFIED_PLAN.md). This file keeps the editor-only concerns:
// state + setters, Shader Lab and PowerShot final-stylize passes, the clone
// CPU blob tracker, CSS colorGrading, and renderer-output/resize tracking.
import * as THREE from 'three';
import { uniform, vec3 } from 'three/tsl';
import { createPowerShotFinal, normalizePowerShotPreset, powerShotPresetUiDefaults, listPowerShotPresets, normalizePowerShotFilmStock, powerShotFilmStockUiDefaults, listPowerShotFilmStocks } from './fx/final/powershot.js';
import { createShaderLabFinal } from './fx/final/shaderlab.js';
import { createFxCore } from './fx/core.js';
import { ALL } from './fx/registry.js';
import { syncRetroUniforms } from './fx/effects/retro.js';
import { syncPixelUniforms } from './fx/effects/pixel.js';
import { syncVolumetricUniforms, applyVolumetricSteps } from './fx/effects/volumetric.js';

function cloneEffectDefaults(defaults = {}) {
    const copy = {};
    for (const [key, value] of Object.entries(defaults)) {
        copy[key] = Array.isArray(value) ? [...value] : value;
    }
    return copy;
}

export function createMaxJSFxController({
    renderer,
    scene,
    camera,
    shaderLabFx = null,
    backendLabel = '',
    onError = () => {},
    environmentVisible = true,
    hiddenBackgroundColor = 0x1a1a2e,
}) {
    const isNodeRenderer = renderer?.isWebGPURenderer === true
        || renderer?.backend?.isWebGPUBackend === true
        || renderer?.backend?.isWebGLBackend === true;
    const supportsScreenSpaceEffects = backendLabel === 'WebGPU' || backendLabel === 'TSL_GL' || isNodeRenderer;
    const supportsTslPostEffects = supportsScreenSpaceEffects;
    const hiddenBackground = new THREE.Color(hiddenBackgroundColor);
    const hiddenBackgroundRU = uniform(hiddenBackground.r);
    const hiddenBackgroundGU = uniform(hiddenBackground.g);
    const hiddenBackgroundBU = uniform(hiddenBackground.b);
    const hiddenBackgroundNode = vec3(hiddenBackgroundRU, hiddenBackgroundGU, hiddenBackgroundBU);

    const colorGradingBrightnessU = uniform(0);
    const colorGradingContrastU = uniform(0);

    // Effect state — defaults are sourced from each descriptor (single source
    // of truth shared with the snapshot viewer). powershot / clone /
    // colorGrading are facade-resident: not TSL composite descriptors.
    const state = {};
    for (const descriptor of ALL) {
        state[descriptor.id] = cloneEffectDefaults(descriptor.defaults);
    }
    state.powershot = {
        enabled: false,
        mode: 'digital',
        preset: 'powershot',
        amount: 1.0,
        resolutionScale: 0.75,
        lensSoftness: 0.32,
        ccdBloom: 0.35,
        noiseScale: 1.06,
        bayerNR: 0.5,
        chromaNR: 1.0,
        jpegStrength: 0.2,
        jpegQuality: 60,
        jpegChroma420: 0.75,
        jpegMidtone: 0.45,
        jpegHighlight: 1.0,
        brightness: 0,
        contrast: 0,
        analogStrength: 0.72,
        analogTracking: 0.46,
        analogChromaBleed: 0.76,
        analogRinging: 0.62,
        analogTapeNoise: 0.70,
        analogBandMask: 0.35,
        analogEdgeWave: 0.34,
        analogDropouts: 0.32,
        analogScanlines: 0.54,
        analogHeadSwitch: 0.42,
        filmStock: 'kodak_500t',
        filmExposure: 0,
        filmInputGamma: 0.65,
        filmGrain: 1.0,
        filmGrainSize: 1.6,
        filmGrainColour: 0.8,
        filmHalation: 0.35,
        filmHalationThreshold: 0.55,
        filmHalationRadius: 1.5,
        filmPrintExposure: 0,
        filmPrintWarmth: 0,
        filmWeave: 0.4,
        filmFlicker: 0.12,
        filmNegative: false,
        freezeNoise: false,
    };
    state.clone = {
        enabled: false,
        source: 'luma',          // 'luma', 'depth'
        threshold: 0.53,
        blurRadius: 0,           // box blur radius on the 64x64 analysis grid
        minBlobSize: 0,          // minimum blob area (0-1 of screen)
        color: [0.0, 1.0, 0.6], // reserved for future use
        opacity: 1.0,
        gridDensity: 0,          // subdivision grid (0=off, 2-8=lines)
        smoothing: 0.75,         // lerp factor (0=frozen, 1=instant snap)
        invert: false,           // invert threshold (track dark regions)
    };
    state.colorGrading = {
        brightness: 0,
        contrast: 0,
    };

    let mainLight = null;  // DirectionalLight for contact shadows

    let available = true;
    let lastError = '';
    let pipelineReady = false;
    // True if rebuildPipeline() last ran while the scene had zero renderables.
    // Happens when saved post-FX state is restored at boot before any scene
    // sync — the pass(scene, camera) node caches an empty render list.
    // Next scene-change escalates to a real rebuild to re-bind against the
    // now-populated scene, then clears this flag. Prevents breakage without
    // rebuilding on every subsequent snapshot (which would murder scrub perf).
    let pipelineBuiltAgainstEmptyScene = false;
    let activeShaderLabFx = shaderLabFx;
    let postFxResolutionScale = 1.0;
    let forceEnvironmentBackground = false;

    const core = createFxCore({
        renderer,
        scene,
        descriptors: ALL,
        state,
        getCamera: () => camera,
        getMainLight: () => mainLight,
        supportsScreenSpaceEffects,
        supportsTslPostEffects,
        isShaderLabEnabled,
        getEnvironmentVisible: () => environmentVisible,
        getResolutionScale: () => postFxResolutionScale,
    });
    const postProcessing = core.postProcessing;

    // Final-stylize stages — shared with the snapshot viewer (fx/final/*).
    const shaderLabFinal = createShaderLabFinal({
        renderer,
        getShaderLabFx: () => activeShaderLabFx,
        getScaledPostFxSize: core.getScaledPostFxSize,
        supportsScreenSpaceEffects,
    });
    const powerShotFinal = createPowerShotFinal({
        renderer,
        getOptions: () => state.powershot,
        getScaledPostFxSize: core.getScaledPostFxSize,
        supportsScreenSpaceEffects,
        isShaderLabEnabled,
    });

    // Clone blob analysis (CPU side — tiny 64x64 readback + CCL)
    const BLOB_W = 64, BLOB_H = 64;
    let blobCvs = null, blobCtx = null;
    try {
        blobCvs = typeof OffscreenCanvas !== 'undefined'
            ? new OffscreenCanvas(BLOB_W, BLOB_H)
            : (() => { const c = document.createElement('canvas'); c.width = BLOB_W; c.height = BLOB_H; return c; })();
        blobCtx = blobCvs.getContext('2d', { willReadFrequently: true });
    } catch {}
    let lastBlobs = [];      // raw CCL output
    let stableBlobs = [];    // temporally smoothed blobs for rendering
    let nextStableId = 0;
    let blobSkip = 0;
    const BLOB_MATCH_DIST = 0.3;    // max centroid distance to match (normalized)
    const BLOB_FADE_FRAMES = 8;     // frames before an unmatched blob disappears

    function isShaderLabEnabled() {
        return supportsScreenSpaceEffects && !!activeShaderLabFx?.isEnabled?.();
    }

    function syncHiddenBackgroundUniforms() {
        hiddenBackgroundRU.value = hiddenBackground.r;
        hiddenBackgroundGU.value = hiddenBackground.g;
        hiddenBackgroundBU.value = hiddenBackground.b;
    }

    function setHiddenBackgroundColor(color) {
        if (typeof color === 'number') {
            hiddenBackground.setHex(color);
        } else if (color?.isColor) {
            hiddenBackground.copy(color);
        } else {
            return hiddenBackground.getHex();
        }
        syncHiddenBackgroundUniforms();
        queuePipelineUpdate({ output: true });
        return hiddenBackground.getHex();
    }

    function matchAndSmooth(rawBlobs) {
        const lerp = state.clone.smoothing;
        const used = new Set();

        // Match each stable blob to the nearest raw blob by centroid
        for (const sb of stableBlobs) {
            let bestDist = BLOB_MATCH_DIST;
            let bestRaw = null;
            let bestIdx = -1;
            for (let i = 0; i < rawBlobs.length; i++) {
                if (used.has(i)) continue;
                const dx = rawBlobs[i].cx - sb.cx;
                const dy = rawBlobs[i].cy - sb.cy;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestRaw = rawBlobs[i];
                    bestIdx = i;
                }
            }
            if (bestRaw) {
                used.add(bestIdx);
                sb.x += (bestRaw.x - sb.x) * lerp;
                sb.y += (bestRaw.y - sb.y) * lerp;
                sb.w += (bestRaw.w - sb.w) * lerp;
                sb.h += (bestRaw.h - sb.h) * lerp;
                sb.cx += (bestRaw.cx - sb.cx) * lerp;
                sb.cy += (bestRaw.cy - sb.cy) * lerp;
                sb.area += (bestRaw.area - sb.area) * lerp;
                sb.ttl = BLOB_FADE_FRAMES;
            } else {
                sb.ttl--;
            }
        }

        // Remove dead blobs
        stableBlobs = stableBlobs.filter(sb => sb.ttl > 0);

        // Spawn new blobs for unmatched raw detections
        for (let i = 0; i < rawBlobs.length; i++) {
            if (used.has(i)) continue;
            stableBlobs.push({
                ...rawBlobs[i],
                id: nextStableId++,
                ttl: BLOB_FADE_FRAMES,
            });
        }

        // Update lastBlobs for external consumers
        lastBlobs = stableBlobs.map(sb => ({
            x: sb.x, y: sb.y, w: sb.w, h: sb.h,
            cx: sb.cx, cy: sb.cy, area: sb.area,
            id: sb.id,
            opacity: Math.min(sb.ttl / BLOB_FADE_FRAMES, 1),
        }));
    }

    // Two-pass union-find CCL on a binary image → bounding box list
    function runCCL(data, w, h, threshold, invert, minAreaPx, sourceMode, blurRadius) {
        // Extract luminance/depth from RGBA pixels
        const luma = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
            luma[i] = sourceMode === 'depth'
                ? r / 255
                : (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
        }

        // Box blur to merge nearby blobs (fast separable 1D passes, fractional radius via lerp)
        const radClamped = Math.max(0, Math.min(blurRadius, 16));
        if (radClamped > 0) {
            const radLo = Math.floor(radClamped);
            const radHi = Math.ceil(radClamped);
            const frac = radClamped - radLo;

            function boxBlur1D(src, dst, r) {
                if (r <= 0) { dst.set(src); return; }
                const kern = 2 * r + 1;
                const tmp = new Float32Array(w * h);
                for (let y = 0; y < h; y++) {
                    let sum = 0;
                    for (let x = 0; x < Math.min(r, w); x++) sum += src[y * w + x];
                    for (let x = 0; x < w; x++) {
                        if (x + r < w) sum += src[y * w + x + r];
                        if (x - r - 1 >= 0) sum -= src[y * w + x - r - 1];
                        tmp[y * w + x] = sum / kern;
                    }
                }
                for (let x = 0; x < w; x++) {
                    let sum = 0;
                    for (let y = 0; y < Math.min(r, h); y++) sum += tmp[y * w + x];
                    for (let y = 0; y < h; y++) {
                        if (y + r < h) sum += tmp[(y + r) * w + x];
                        if (y - r - 1 >= 0) sum -= tmp[(y - r - 1) * w + x];
                        dst[y * w + x] = sum / kern;
                    }
                }
            }

            if (frac < 0.001 || radLo === radHi) {
                boxBlur1D(luma, luma, radLo);
            } else {
                const lo = new Float32Array(w * h);
                const hi = new Float32Array(w * h);
                boxBlur1D(luma, lo, radLo);
                boxBlur1D(luma, hi, radHi);
                for (let i = 0; i < w * h; i++) luma[i] = lo[i] + (hi[i] - lo[i]) * frac;
            }
        }

        // Threshold to binary
        const binary = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            binary[i] = (invert ? luma[i] < threshold : luma[i] > threshold) ? 1 : 0;
        }

        const labels = new Int32Array(w * h).fill(-1);
        const parent = [];
        let nextLabel = 0;

        const find = (x) => {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        };
        const union = (a, b) => {
            a = find(a); b = find(b);
            if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        };

        // Pass 1: assign labels with neighbor merge
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                if (!binary[idx]) continue;
                const up = y > 0 ? labels[(y - 1) * w + x] : -1;
                const left = x > 0 ? labels[y * w + x - 1] : -1;
                if (up >= 0 && left >= 0) {
                    labels[idx] = Math.min(up, left);
                    union(up, left);
                } else if (up >= 0) {
                    labels[idx] = up;
                } else if (left >= 0) {
                    labels[idx] = left;
                } else {
                    parent.push(nextLabel);
                    labels[idx] = nextLabel++;
                }
            }
        }

        // Pass 2: resolve labels → bounding boxes
        const blobs = new Map();
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                if (labels[idx] < 0) continue;
                const root = find(labels[idx]);
                let b = blobs.get(root);
                if (!b) { b = { minX: x, minY: y, maxX: x, maxY: y, area: 0, sumX: 0, sumY: 0 }; blobs.set(root, b); }
                if (x < b.minX) b.minX = x;
                if (y < b.minY) b.minY = y;
                if (x > b.maxX) b.maxX = x;
                if (y > b.maxY) b.maxY = y;
                b.area++;
                b.sumX += x;
                b.sumY += y;
            }
        }

        // Filter + normalize to 0-1 range
        const result = [];
        for (const [, b] of blobs) {
            if (b.area < minAreaPx) continue;
            // Kill blobs that are too large
            const bboxW = (b.maxX - b.minX + 1) / w;
            const bboxH = (b.maxY - b.minY + 1) / h;
            if (b.area > w * h * 0.4) continue;
            if (bboxW > 0.85 || bboxH > 0.85) continue;
            if (bboxW * bboxH > 0.5) continue;
            result.push({
                x: b.minX / w,
                y: b.minY / h,
                w: (b.maxX - b.minX + 1) / w,
                h: (b.maxY - b.minY + 1) / h,
                area: b.area / (w * h),
                cx: (b.sumX / b.area) / w,
                cy: (b.sumY / b.area) / h,
                id: result.length,
            });
        }
        return result.sort((a, b) => b.area - a.area);
    }

    function analyzeBlobsFromCanvas() {
        if (!blobCtx || !renderer.domElement) return;
        try {
            blobCtx.drawImage(renderer.domElement, 0, 0, BLOB_W, BLOB_H);
            const imgData = blobCtx.getImageData(0, 0, BLOB_W, BLOB_H);
            const cl = state.clone;
            const minAreaPx = cl.minBlobSize * BLOB_W * BLOB_H;
            const rawBlobs = runCCL(imgData.data, BLOB_W, BLOB_H, cl.threshold, cl.invert, minAreaPx, cl.source, cl.blurRadius);
            matchAndSmooth(rawBlobs);
        } catch {
            lastBlobs = [];
        }
    }

    function updateCloneBlobAnalysis() {
        if (state.clone.enabled && blobCtx) {
            if (++blobSkip >= 2) {
                blobSkip = 0;
                analyzeBlobsFromCanvas();
            }
        } else {
            lastBlobs = [];
            stableBlobs = [];
        }
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
        state.pixel.enabled = false;
        state.powershot.enabled = false;
        state.volumetric.enabled = false;
        state.dof.enabled = false;
        pipelineReady = false;
        core.handleBuildFailure();
        onError(`${prefix}: ${lastError}`);
    }

    function hasColorGradingEnabled() {
        return Math.abs(state.colorGrading.brightness || 0) > 1.0e-6
            || Math.abs(state.colorGrading.contrast || 0) > 1.0e-6;
    }

    function hasPipelineEffectEnabled() {
        return core.anyEffectActive()
            || powerShotFinal.isActive()
            || (!!core.ctx.pathTracedColor && shaderLabFinal.hasPassEnabled());
    }

    function hasAnyEffectEnabled() {
        return hasPipelineEffectEnabled() || shaderLabFinal.hasPassEnabled();
    }

    function renderPostInputToCurrentTarget() {
        if (core.ctx.pathTracedColor && pipelineReady) {
            postProcessing.render();
            return;
        }
        renderer.render(scene, camera);
    }

    function syncCanvasColorGrading() {
        const canvas = renderer?.domElement;
        if (!canvas?.style) return;

        if (!hasColorGradingEnabled() || powerShotFinal.isActive()) {
            canvas.style.filter = '';
            return;
        }

        const brightness = Math.max(0, 1 + (state.colorGrading.brightness || 0));
        const contrast = Math.max(0, 1 + (state.colorGrading.contrast || 0));
        canvas.style.filter = `brightness(${brightness}) contrast(${contrast})`;
    }

    function snapshotState() {
        const snap = {};
        for (const descriptor of ALL) {
            snap[descriptor.id] = cloneEffectDefaults(state[descriptor.id]);
        }
        snap.toonOutline.toonCount = core.hasToonMeshes() ? 1 : 0;
        snap.powershot = { ...state.powershot };
        snap.clone = { ...state.clone, color: [...state.clone.color] };  // blob tracker (CPU-only, no GPU pipeline)
        snap.colorGrading = { ...state.colorGrading };
        return snap;
    }

    function restoreStateSnapshot(fx = {}) {
        const keys = [...ALL.map((d) => d.id), 'powershot', 'clone', 'colorGrading'];
        for (const key of keys) {
            const source = fx[key];
            if (!source || typeof source !== 'object') continue;
            state[key] = { ...state[key], ...source };
        }
        if (Array.isArray(fx.toonOutline?.color)) {
            state.toonOutline.color = [...fx.toonOutline.color];
        }
        if (Array.isArray(fx.fog?.color)) {
            state.fog.color = [...fx.fog.color];
        }
        if (Array.isArray(fx.clone?.color)) {
            state.clone.color = [...fx.clone.color];
        }
        syncHiddenBackgroundUniforms();
        colorGradingBrightnessU.value = state.colorGrading.brightness;
        colorGradingContrastU.value = state.colorGrading.contrast;
        core.cleanupUnsupportedRealtimeResources();
        rebuildPipeline();
        return snapshotState();
    }

    // ── Renderer output tracking + queued pipeline updates ──────────────

    const rendererDrawBufferSize = new THREE.Vector2();
    let pendingPipelineRebuild = false;
    let pendingSceneRefresh = false;
    let pendingOutputRefresh = false;
    let lastRenderWidth = 0;
    let lastRenderHeight = 0;
    let lastRenderPixelRatio = 1;
    let lastToneMapping = renderer.toneMapping;
    let lastToneMappingExposure = renderer.toneMappingExposure;

    function readRendererDrawBufferSize(target) {
        if (typeof renderer.getDrawingBufferSize === 'function') {
            return renderer.getDrawingBufferSize(target);
        }
        return renderer.getSize(target);
    }

    function snapshotRendererOutputState() {
        readRendererDrawBufferSize(rendererDrawBufferSize);
        lastRenderWidth = rendererDrawBufferSize.x;
        lastRenderHeight = rendererDrawBufferSize.y;
        lastRenderPixelRatio = Number.isFinite(renderer.getPixelRatio?.()) ? renderer.getPixelRatio() : 1;
        lastToneMapping = renderer.toneMapping;
        lastToneMappingExposure = renderer.toneMappingExposure;
    }

    function queuePipelineUpdate({ rebuild = false, scene = false, output = false } = {}) {
        if (rebuild) pendingPipelineRebuild = true;
        if (scene) pendingSceneRefresh = true;
        if (output) pendingOutputRefresh = true;
        if (output && pipelineReady) {
            postProcessing.needsUpdate = true;
        }
    }

    function syncRendererOutputState(force = false) {
        readRendererDrawBufferSize(rendererDrawBufferSize);
        const nextPixelRatio = Number.isFinite(renderer.getPixelRatio?.()) ? renderer.getPixelRatio() : 1;
        const sizeChanged =
            force ||
            rendererDrawBufferSize.x !== lastRenderWidth ||
            rendererDrawBufferSize.y !== lastRenderHeight ||
            Math.abs(nextPixelRatio - lastRenderPixelRatio) > 1.0e-6;
        const toneMappingChanged =
            renderer.toneMapping !== lastToneMapping ||
            Math.abs((renderer.toneMappingExposure ?? 1) - (lastToneMappingExposure ?? 1)) > 1.0e-6;

        if (sizeChanged) {
            queuePipelineUpdate({ rebuild: true, output: true });
        } else if (toneMappingChanged) {
            queuePipelineUpdate({ output: true });
        }

        snapshotRendererOutputState();
    }

    function syncRendererResizeState() {
        readRendererDrawBufferSize(rendererDrawBufferSize);
        const nextPixelRatio = Number.isFinite(renderer.getPixelRatio?.()) ? renderer.getPixelRatio() : 1;
        const sizeChanged =
            rendererDrawBufferSize.x !== lastRenderWidth ||
            rendererDrawBufferSize.y !== lastRenderHeight ||
            Math.abs(nextPixelRatio - lastRenderPixelRatio) > 1.0e-6;
        const toneMappingChanged =
            renderer.toneMapping !== lastToneMapping ||
            Math.abs((renderer.toneMappingExposure ?? 1) - (lastToneMappingExposure ?? 1)) > 1.0e-6;

        if (sizeChanged || toneMappingChanged) {
            // PassNode render targets resize themselves from the renderer dimensions.
            // Rebuilding the whole post-FX graph here allocates a second full set of
            // effect targets after panel resize in ActiveShade/WebView2.
            queuePipelineUpdate({ output: true });
        }

        snapshotRendererOutputState();
    }

    function normalizePostFxResolutionScale(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 1.0;
        return THREE.MathUtils.clamp(numeric, 0.25, 1.0);
    }

    function flushPendingPipelineUpdates() {
        syncRendererOutputState();
        const needsRebuild = pendingPipelineRebuild;
        const needsSceneRefresh = pendingSceneRefresh;
        const needsOutputRefresh = pendingOutputRefresh;

        pendingSceneRefresh = false;
        pendingPipelineRebuild = false;
        pendingOutputRefresh = false;

        if (needsRebuild) {
            // Full pipeline reconstruction — only when the post-FX node graph actually
            // changes (effect toggled, renderer size changed, env map swapped). Do not
            // call this on data updates: pass(scene, camera) reads the latest scene
            // state every frame automatically.
            rebuildPipeline();
            return;
        }

        if (needsSceneRefresh && pipelineReady) {
            // Scene structure changed (mesh added/removed/material swap) but the
            // post-FX node graph is unchanged. Refresh the two scene-derived caches
            // without tearing down the pipeline.
            core.refreshSceneCaches();
        }

        if (needsOutputRefresh && pipelineReady) {
            postProcessing.needsUpdate = true;
        }
    }

    snapshotRendererOutputState();

    function syncWebPanelPunchEnabled() {
        const rects = core.ctx.shared.webPanelPunch?.rects ?? [];
        // Derive with the punch OFF so "others active" can't see itself — the
        // punch must never force the pipeline path on its own (with FX off,
        // depth-occluded panels punch via their occluder meshes instead).
        state.webPanelPunch.enabled = false;
        const othersActive = hasPipelineEffectEnabled();
        state.webPanelPunch.enabled = othersActive && rects.length > 0;
    }

    function rebuildPipeline() {
        core.prepareRebuild();
        syncWebPanelPunchEnabled();

        if (!hasPipelineEffectEnabled() || !available) {
            pipelineReady = false;
            core.teardownPipeline();
            forceEnvironmentBackground = false;
            syncCanvasColorGrading();
            return;
        }

        core.clearNodes();
        syncCanvasColorGrading();

        const result = core.buildPipeline();
        if (result.ok) {
            pipelineReady = true;
            lastError = '';
            forceEnvironmentBackground = result.forceEnvironmentBackground;
            pipelineBuiltAgainstEmptyScene = result.builtAgainstEmptyScene;
        } else {
            forceEnvironmentBackground = false;
            disableWithError('SSGI setup failed', result.error);
        }
    }

    function assignFinite(target, key, value) {
        if (Number.isFinite(value)) target[key] = value;
    }

    function retroOptionsNeedRebuild(options = {}) {
        if (typeof options.wiggle === 'boolean' && options.wiggle !== state.retro.wiggle) return true;
        if (typeof options.dither === 'boolean' && options.dither !== state.retro.dither) return true;
        if (typeof options.scanlines === 'boolean' && options.scanlines !== state.retro.scanlines) return true;
        if (typeof options.crt === 'boolean' && options.crt !== state.retro.crt) return true;
        if (typeof options.filterTextures === 'boolean' && options.filterTextures !== state.retro.filterTextures) return true;
        return false;
    }

    function pixelOptionsNeedRebuild(options = {}) {
        if (typeof options.pixelate === 'boolean' && options.pixelate !== state.pixel.pixelate) return true;
        if (typeof options.chromatic === 'boolean' && options.chromatic !== state.pixel.chromatic) return true;
        if (typeof options.sharpen === 'boolean' && options.sharpen !== state.pixel.sharpen) return true;
        if (typeof options.grain === 'boolean' && options.grain !== state.pixel.grain) return true;
        return false;
    }

    const fxApi = {
        getState() {
            return snapshotState();
        },
        getDerivedState() {
            return core.computeDerivedState();
        },
        hasEnabledEffects() {
            return pendingSceneRefresh || pendingPipelineRebuild || hasAnyEffectEnabled();
        },
        isEnabled() {
            return state.ssgi.enabled;
        },
        isAvailable() {
            return available;
        },
        applySharedSceneEffects() {
            core.syncSharedSceneEffects();
        },
        getLastError() {
            return lastError;
        },
        supportsScreenSpaceEffects() {
            return supportsScreenSpaceEffects;
        },
        getResolutionScale() {
            return postFxResolutionScale;
        },
        isPipelineRenderActive() {
            return pipelineReady && hasPipelineEffectEnabled();
        },
        // Depth-occluded web panel rects (maxjs_webapp.js). Rebuild only on
        // count changes — transforms/opacity ride the descriptor's per-frame
        // uniform update, so 30-60 Hz panel traffic never rebuilds the graph.
        setWebPanelPunchRects(rects) {
            const shared = core.ctx.shared;
            const prevCount = shared.webPanelPunch?.rects?.length ?? 0;
            const next = Array.isArray(rects) ? rects.slice(0) : [];
            if (!shared.webPanelPunch) shared.webPanelPunch = { rects: next };
            else shared.webPanelPunch.rects = next;
            if (next.length !== prevCount) {
                syncWebPanelPunchEnabled();
                if (pipelineReady || hasPipelineEffectEnabled()) rebuildPipeline();
            }
        },
        setResolutionScale(scale) {
            const nextScale = normalizePostFxResolutionScale(scale);
            if (Math.abs(nextScale - postFxResolutionScale) <= 1.0e-6) {
                return postFxResolutionScale;
            }
            postFxResolutionScale = nextScale;
            if (pipelineReady || hasPipelineEffectEnabled()) {
                rebuildPipeline();
            }
            return postFxResolutionScale;
        },
        setEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'SSGI requires WebGPU or TSL_GL';
                onError(lastError);
                state.ssgi.enabled = true;
                rebuildPipeline();
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
            if (enabled && !supportsTslPostEffects) {
                lastError = 'SSR requires WebGPU or TSL_GL';
                onError(lastError);
                state.ssr.enabled = true;
                rebuildPipeline();
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
                lastError = 'GTAO requires WebGPU or TSL_GL';
                onError(lastError);
                state.gtao.enabled = true;
                rebuildPipeline();
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
                lastError = 'Motion blur requires WebGPU or TSL_GL';
                onError(lastError);
                state.motionBlur.enabled = true;
                rebuildPipeline();
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
                lastError = 'TRAA requires WebGPU or TSL_GL';
                onError(lastError);
                state.traa.enabled = true;
                rebuildPipeline();
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
            rebuildPipeline();
            return environmentVisible;
        },
        /** Call after scene.environment toggles or swaps (local HDRI load, Max HDRI, clear). */
        markEnvironmentChanged() {
            if (available) {
                queuePipelineUpdate({ rebuild: true, output: true });
            }
        },
        /**
         * Call when the scene's mesh list / material assignment changes
         * (mesh added, removed, or material swapped). Cheap: just refreshes the
         * toon-cache and post-pass hide list. Does NOT rebuild the pipeline graph.
         *
         * Pass `{ rebuild: true }` only when the post-FX node graph itself must be
         * reconstructed (effect toggled, env map swapped) — almost
         * never needed from outside, since those have dedicated entry points.
         */
        markSceneChanged(options = {}) {
            core.markPS1SceneDirty();
            // Three reasons to escalate a scene-structure change to a full rebuild:
            //   1. Explicit {rebuild:true} from the caller (env/effect graph swap).
            //   2. Toon outline is on — it binds per-mesh refs into the node
            //      graph at rebuild time, so scene-structure mutations break it.
            //   3. The current pipeline was built against an empty scene (cold
            //      start with saved post-FX). pass(scene, camera) cached an
            //      empty render list; we need one real rebuild to re-bind.
            //
            // Do NOT pass output:true here — scene structure changes do not touch
            // the output node tree (tone mapping / exposure / gamma). Setting
            // postProcessing.needsUpdate forces a one-frame re-resolution that can
            // cause DOF microflicker (the gather kernel samples a partially
            // re-bound RT). Output changes have their own entry point.
            const mustRebuild =
                options.rebuild === true ||
                state.toonOutline.enabled ||
                pipelineBuiltAgainstEmptyScene;
            queuePipelineUpdate({
                scene: true,
                rebuild: mustRebuild,
            });
        },
        /**
         * Call after vertex / normal / uv / index data on an existing mesh changed
         * (mesh fast sync hot path). This is a no-op: pass(scene, camera) reads the
         * latest BufferGeometry attributes every frame automatically. Exists so
         * callers can document intent without paying for an unnecessary rebuild.
         */
        markGeometryDataDirty() {
            // intentionally empty — see doc above
        },
        markOutputChanged() {
            queuePipelineUpdate({ output: true });
        },
        isBloomEnabled() {
            return state.bloom.enabled;
        },
        setBloomEnabled(enabled) {
            if (enabled && !supportsTslPostEffects) {
                lastError = 'Bloom requires WebGPU or TSL_GL';
                onError(lastError);
                state.bloom.enabled = true;
                rebuildPipeline();
                return false;
            }
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
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'Toon outline requires WebGPU or TSL_GL';
                onError(lastError);
                state.toonOutline.enabled = true;
                rebuildPipeline();
                return false;
            }
            state.toonOutline.enabled = !!enabled;
            rebuildPipeline();
            return state.toonOutline.enabled;
        },
        setToonOutlineOptions(options = {}) {
            assignFinite(state.toonOutline, 'thickness', options.thickness);
            assignFinite(state.toonOutline, 'alpha', options.alpha);
            if (Array.isArray(options.color)) state.toonOutline.color = options.color;
            rebuildPipeline();
            return { ...state.toonOutline };
        },
        isContactShadowEnabled() {
            return state.contactShadow.enabled;
        },
        setContactShadowEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'Contact shadows require WebGPU or TSL_GL';
                onError(lastError);
                state.contactShadow.enabled = true;
                rebuildPipeline();
                return false;
            }
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
                core.restoreForcedContactShadowLight();
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
            if (enabled && isShaderLabEnabled()) {
                lastError = 'Retro is unavailable while Shader Lab is active.';
                onError(lastError);
                return false;
            }
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'Retro requires WebGPU or TSL_GL';
                onError(lastError);
                state.retro.enabled = true;
                rebuildPipeline();
                return false;
            }
            state.retro.enabled = !!enabled;
            rebuildPipeline();
            return state.retro.enabled;
        },
        isRetroBlockedByShaderLab() {
            return isShaderLabEnabled();
        },
        setRetroOptions(options = {}) {
            const needsRebuild = retroOptionsNeedRebuild(options);
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
            syncRetroUniforms(core.ctx);
            if (needsRebuild) {
                rebuildPipeline();
            } else {
                core.syncSharedSceneEffects();
                if (state.retro.enabled) queuePipelineUpdate({ output: true });
            }
            return { ...state.retro };
        },
        // ── Pixel FX ──

        isPixelEnabled() {
            return state.pixel.enabled;
        },
        setPixelEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'Pixel FX requires WebGPU or TSL_GL';
                onError(lastError);
                state.pixel.enabled = true;
                rebuildPipeline();
                return false;
            }
            state.pixel.enabled = !!enabled;
            rebuildPipeline();
            return state.pixel.enabled;
        },
        setPixelOptions(options = {}) {
            const needsRebuild = pixelOptionsNeedRebuild(options);
            if (typeof options.pixelate === 'boolean') state.pixel.pixelate = options.pixelate;
            assignFinite(state.pixel, 'pixelSize', options.pixelSize);
            if (typeof options.chromatic === 'boolean') state.pixel.chromatic = options.chromatic;
            assignFinite(state.pixel, 'chromaticIntensity', options.chromaticIntensity);
            if (typeof options.sharpen === 'boolean') state.pixel.sharpen = options.sharpen;
            assignFinite(state.pixel, 'sharpenStrength', options.sharpenStrength);
            if (typeof options.grain === 'boolean') state.pixel.grain = options.grain;
            assignFinite(state.pixel, 'grainIntensity', options.grainIntensity);
            assignFinite(state.pixel, 'brightness', options.brightness);
            assignFinite(state.pixel, 'contrast', options.contrast);
            assignFinite(state.pixel, 'saturation', options.saturation);
            syncPixelUniforms(core.ctx);
            if (needsRebuild) {
                rebuildPipeline();
            } else if (state.pixel.enabled) {
                queuePipelineUpdate({ output: true });
            }
            return { ...state.pixel };
        },

        // ── PowerShot ISP ──

        isPowerShotEnabled() {
            return state.powershot.enabled;
        },
        setPowerShotEnabled(enabled) {
            if (enabled && isShaderLabEnabled()) {
                lastError = 'PowerShot is unavailable while Shader Lab is active.';
                onError(lastError);
                return false;
            }
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'PowerShot requires WebGPU or TSL_GL';
                onError(lastError);
                state.powershot.enabled = true;
                rebuildPipeline();
                return false;
            }
            state.powershot.enabled = !!enabled && available;
            rebuildPipeline();
            return state.powershot.enabled;
        },
        setPowerShotOptions(options = {}) {
            if (typeof options.mode === 'string') {
                state.powershot.mode = options.mode === 'analog' ? 'analog'
                    : options.mode === 'film' ? 'film'
                    : 'digital';
                state.powershot.freezeNoise = false;
            }
            if (typeof options.preset === 'string') {
                state.powershot.preset = normalizePowerShotPreset(options.preset);
                Object.assign(state.powershot, powerShotPresetUiDefaults(state.powershot.preset));
            }
            if (typeof options.filmStock === 'string') {
                state.powershot.filmStock = normalizePowerShotFilmStock(options.filmStock);
                Object.assign(state.powershot, powerShotFilmStockUiDefaults(state.powershot.filmStock));
            }
            assignFinite(state.powershot, 'amount', options.amount);
            assignFinite(state.powershot, 'resolutionScale', options.resolutionScale);
            assignFinite(state.powershot, 'lensSoftness', options.lensSoftness);
            assignFinite(state.powershot, 'ccdBloom', options.ccdBloom);
            assignFinite(state.powershot, 'noiseScale', options.noiseScale);
            assignFinite(state.powershot, 'bayerNR', options.bayerNR);
            assignFinite(state.powershot, 'chromaNR', options.chromaNR);
            assignFinite(state.powershot, 'jpegStrength', options.jpegStrength);
            assignFinite(state.powershot, 'jpegQuality', options.jpegQuality);
            assignFinite(state.powershot, 'jpegChroma420', options.jpegChroma420);
            assignFinite(state.powershot, 'jpegMidtone', options.jpegMidtone);
            assignFinite(state.powershot, 'jpegHighlight', options.jpegHighlight);
            assignFinite(state.powershot, 'brightness', options.brightness);
            assignFinite(state.powershot, 'contrast', options.contrast);
            assignFinite(state.powershot, 'analogStrength', options.analogStrength);
            assignFinite(state.powershot, 'analogTracking', options.analogTracking);
            assignFinite(state.powershot, 'analogChromaBleed', options.analogChromaBleed);
            assignFinite(state.powershot, 'analogRinging', options.analogRinging);
            assignFinite(state.powershot, 'analogTapeNoise', options.analogTapeNoise);
            assignFinite(state.powershot, 'analogBandMask', options.analogBandMask);
            assignFinite(state.powershot, 'analogEdgeWave', options.analogEdgeWave);
            assignFinite(state.powershot, 'analogDropouts', options.analogDropouts);
            assignFinite(state.powershot, 'analogScanlines', options.analogScanlines);
            assignFinite(state.powershot, 'analogHeadSwitch', options.analogHeadSwitch);
            assignFinite(state.powershot, 'filmExposure', options.filmExposure);
            assignFinite(state.powershot, 'filmInputGamma', options.filmInputGamma);
            assignFinite(state.powershot, 'filmGrain', options.filmGrain);
            assignFinite(state.powershot, 'filmGrainSize', options.filmGrainSize);
            assignFinite(state.powershot, 'filmGrainColour', options.filmGrainColour);
            assignFinite(state.powershot, 'filmHalation', options.filmHalation);
            assignFinite(state.powershot, 'filmHalationThreshold', options.filmHalationThreshold);
            assignFinite(state.powershot, 'filmHalationRadius', options.filmHalationRadius);
            assignFinite(state.powershot, 'filmPrintExposure', options.filmPrintExposure);
            assignFinite(state.powershot, 'filmPrintWarmth', options.filmPrintWarmth);
            assignFinite(state.powershot, 'filmWeave', options.filmWeave);
            assignFinite(state.powershot, 'filmFlicker', options.filmFlicker);
            if (typeof options.filmNegative === 'boolean') state.powershot.filmNegative = options.filmNegative;
            if (typeof options.freezeNoise === 'boolean') state.powershot.freezeNoise = options.freezeNoise;
            if (powerShotFinal.hasPipeline()) powerShotFinal.syncPipeline();
            if (state.powershot.enabled) queuePipelineUpdate({ output: true });
            return { ...state.powershot };
        },
        getPowerShotPresets() {
            return listPowerShotPresets();
        },
        getPowerShotFilmStocks() {
            return listPowerShotFilmStocks();
        },

        // ── Global Color Grading ──

        getColorGrading() {
            return { ...state.colorGrading };
        },
        setColorGrading(options = {}) {
            if (powerShotFinal.isActive()) {
                syncCanvasColorGrading();
                return { ...state.colorGrading };
            }
            assignFinite(state.colorGrading, 'brightness', options.brightness);
            assignFinite(state.colorGrading, 'contrast', options.contrast);
            colorGradingBrightnessU.value = state.colorGrading.brightness;
            colorGradingContrastU.value = state.colorGrading.contrast;
            syncCanvasColorGrading();
            return { ...state.colorGrading };
        },

        // ── Depth of Field ──

        isDofEnabled() {
            return state.dof.enabled;
        },
        setDofEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'DOF requires WebGPU or TSL_GL';
                onError(lastError);
                state.dof.enabled = true;
                rebuildPipeline();
                return false;
            }
            state.dof.enabled = !!enabled && available;
            rebuildPipeline();
            return state.dof.enabled;
        },
        setDofOptions(options = {}) {
            assignFinite(state.dof, 'focusDistance', options.focusDistance);
            assignFinite(state.dof, 'focalLength', options.focalLength);
            assignFinite(state.dof, 'bokehScale', options.bokehScale);
            if (typeof options.autoFromCamera === 'boolean') state.dof.autoFromCamera = options.autoFromCamera;
            if (state.dof.enabled) {
                core.uniforms.dofFocusDistanceU.value = state.dof.focusDistance;
                core.uniforms.dofFocalLengthU.value = state.dof.focalLength;
                core.uniforms.dofBokehScaleU.value = state.dof.bokehScale;
            }
            return { ...state.dof };
        },
        updateDofFocusFromCamera(targetDist) {
            if (!state.dof.enabled || !state.dof.autoFromCamera) return;
            if (!Number.isFinite(targetDist) || targetDist <= 0) return;
            state.dof.focusDistance = targetDist;
            core.uniforms.dofFocusDistanceU.value = targetDist;
        },
        updateDofFromPhysicalCamera(cam, onUpdate = null) {
            // Called when Camera Lock is ON and Physical Camera has DOF
            if (!state.dof.enabled || !state.dof.autoFromCamera) return;
            if (!cam.dofEnabled) return;

            let changed = false;
            if (Number.isFinite(cam.dofFocusDistance) && cam.dofFocusDistance > 0) {
                state.dof.focusDistance = cam.dofFocusDistance;
                core.uniforms.dofFocusDistanceU.value = cam.dofFocusDistance;
                changed = true;
            }
            if (Number.isFinite(cam.dofFocalLength) && cam.dofFocalLength > 0) {
                state.dof.focalLength = cam.dofFocalLength;
                core.uniforms.dofFocalLengthU.value = cam.dofFocalLength;
                changed = true;
            }
            if (Number.isFinite(cam.dofBokehScale) && cam.dofBokehScale > 0) {
                state.dof.bokehScale = cam.dofBokehScale;
                core.uniforms.dofBokehScaleU.value = cam.dofBokehScale;
                changed = true;
            }
            if (changed && onUpdate) onUpdate();
        },

        // ── Volumetric Lighting ──

        isVolumetricEnabled() {
            return state.volumetric.enabled;
        },
        setVolumetricEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'Volumetric lighting requires WebGPU or TSL_GL';
                onError(lastError);
                state.volumetric.enabled = true;
                rebuildPipeline();
                return false;
            }
            state.volumetric.enabled = !!enabled && available;
            rebuildPipeline();
            return state.volumetric.enabled;
        },
        setVolumetricOptions(options = {}) {
            const needsRebuild =
                (Number.isFinite(options.steps) && options.steps !== state.volumetric.steps) ||
                (Number.isFinite(options.resolution) && options.resolution !== state.volumetric.resolution);

            assignFinite(state.volumetric, 'intensity', options.intensity);
            assignFinite(state.volumetric, 'steps', options.steps);
            assignFinite(state.volumetric, 'density', options.density);
            assignFinite(state.volumetric, 'denoise', options.denoise);
            assignFinite(state.volumetric, 'resolution', options.resolution);

            // Live-update uniforms without pipeline rebuild
            syncVolumetricUniforms(core.ctx);
            if (Number.isFinite(options.steps)) {
                applyVolumetricSteps(core.ctx);
            }

            if (needsRebuild) rebuildPipeline();
            return { ...state.volumetric };
        },

        // ── Fog (scene.fogNode — independent of post-processing) ──

        isFogEnabled() {
            return state.fog.enabled;
        },
        setFogEnabled(enabled) {
            if (enabled && !supportsScreenSpaceEffects) {
                lastError = 'Fog requires WebGPU or TSL_GL';
                onError(lastError);
                state.fog.enabled = true;
                core.applySceneFog();
                rebuildPipeline();
                return false;
            }
            state.fog.enabled = !!enabled;
            core.applySceneFog();
            rebuildPipeline();
            return state.fog.enabled;
        },
        setFogOptions(options = {}) {
            const prevType = state.fog.type;
            if (Number.isFinite(options.type)) state.fog.type = options.type;
            if (Array.isArray(options.color)) state.fog.color = options.color;
            assignFinite(state.fog, 'opacity', options.opacity);
            assignFinite(state.fog, 'near', options.near);
            assignFinite(state.fog, 'far', options.far);
            assignFinite(state.fog, 'density', options.density);
            assignFinite(state.fog, 'noiseScale', options.noiseScale);
            assignFinite(state.fog, 'noiseSpeed', options.noiseSpeed);
            assignFinite(state.fog, 'height', options.height);
            core.applySceneFog();
            if (Number.isFinite(options.type) && options.type !== prevType) {
                rebuildPipeline();
            }
            return { ...state.fog };
        },
        setFogFromScene(fogData) {
            if (!fogData) return;
            const f = state.fog;
            const nextEnabled = !!fogData.active;
            const nextType = fogData.type ?? 0;
            const nextColor = Array.isArray(fogData.color) ? fogData.color : f.color;
            const nextOpacity = Number.isFinite(fogData.opacity) ? fogData.opacity : f.opacity;
            const nextNear = Number.isFinite(fogData.near) ? fogData.near : f.near;
            const nextFar = Number.isFinite(fogData.far) ? fogData.far : f.far;
            const nextDensity = Number.isFinite(fogData.density) ? fogData.density : f.density;
            const nextNoiseScale = Number.isFinite(fogData.noiseScale) ? fogData.noiseScale : f.noiseScale;
            const nextNoiseSpeed = Number.isFinite(fogData.noiseSpeed) ? fogData.noiseSpeed : f.noiseSpeed;
            const nextHeight = Number.isFinite(fogData.height) ? fogData.height : f.height;
            const changed =
                f.enabled !== nextEnabled ||
                f.type !== nextType ||
                f.opacity !== nextOpacity ||
                f.near !== nextNear ||
                f.far !== nextFar ||
                f.density !== nextDensity ||
                f.noiseScale !== nextNoiseScale ||
                f.noiseSpeed !== nextNoiseSpeed ||
                f.height !== nextHeight ||
                f.color[0] !== nextColor[0] ||
                f.color[1] !== nextColor[1] ||
                f.color[2] !== nextColor[2];
            if (!changed) return;
            f.enabled = nextEnabled;
            f.type = nextType;
            f.color = nextColor;
            f.opacity = nextOpacity;
            f.near = nextNear;
            f.far = nextFar;
            f.density = nextDensity;
            f.noiseScale = nextNoiseScale;
            f.noiseSpeed = nextNoiseSpeed;
            f.height = nextHeight;
            core.applySceneFog();
            rebuildPipeline();
        },

        setHiddenBackgroundColor(color) {
            return setHiddenBackgroundColor(color);
        },

        // ── Clone Blob Tracker ──

        isCloneEnabled() {
            return state.clone.enabled;
        },
        setCloneEnabled(enabled) {
            state.clone.enabled = !!enabled;
            if (!enabled) { lastBlobs = []; stableBlobs = []; }
            return state.clone.enabled;
        },
        setCloneOptions(options = {}) {
            if (typeof options.source === 'string') state.clone.source = options.source;
            assignFinite(state.clone, 'threshold', options.threshold);
            assignFinite(state.clone, 'blurRadius', options.blurRadius);
            assignFinite(state.clone, 'minBlobSize', options.minBlobSize);
            if (typeof options.invert === 'boolean') state.clone.invert = options.invert;
            assignFinite(state.clone, 'opacity', options.opacity);
            assignFinite(state.clone, 'gridDensity', options.gridDensity);
            assignFinite(state.clone, 'smoothing', options.smoothing);
            if (Array.isArray(options.color)) state.clone.color = options.color;
            return { ...state.clone };
        },
        sanitizeForCurrentBackend() {
            core.cleanupUnsupportedRealtimeResources();
            rebuildPipeline();
            return snapshotState();
        },
        restoreState(fx = {}) {
            return restoreStateSnapshot(fx);
        },
        setShaderLabFx(fx) {
            activeShaderLabFx = fx || null;
        },
        getCapabilities() {
            return {
                backendLabel,
                screenSpace: supportsScreenSpaceEffects,
                tslPostEffects: supportsTslPostEffects,
                commonPostFx: supportsScreenSpaceEffects,
                shaderLab: supportsScreenSpaceEffects && !!activeShaderLabFx,
            };
        },

        // Hot-swap the camera used by every pass/effect node. Callers hit
        // this when Max toggles between perspective and orthographic so the
        // pipeline's pass(scene, camera) nodes re-capture the right camera.
        // Without this, the pipeline was stuck rendering with whichever
        // camera was passed into createMaxJSFxController().
        setCamera(nextCamera) {
            if (!nextCamera || nextCamera === camera) return;
            camera = nextCamera;
            rebuildPipeline();
        },

        // Path-traced source: hand the post stack a linear-HDR texture (the
        // spectral PT output) to use as the beauty instead of a rasterized
        // scene pass. buildPipeline gates the gbuffer effects and folds only
        // the color-domain ones; PowerShot/tone map at output are shared.
        // Pass null to return to the normal scene-pass pipeline.
        setPathTracedSource(texture) {
            const next = texture || null;
            if (core.ctx.pathTracedColor === next) return;
            core.ctx.pathTracedColor = next;
            queuePipelineUpdate({ rebuild: true, output: true });
        },
        hasPathTracedSource() {
            return !!core.ctx.pathTracedColor;
        },

        render() {
            flushPendingPipelineUpdates();
            syncCanvasColorGrading();
            // Fog + pixel-grain timers (procedural animation)
            core.updateFrameTimers();

            const shaderLabActive = shaderLabFinal.hasPassEnabled();

            if (!hasPipelineEffectEnabled() || !pipelineReady) {
                if (shaderLabActive) {
                    const consumed = shaderLabFinal.renderFinal(renderPostInputToCurrentTarget);
                    if (!consumed) renderPostInputToCurrentTarget();
                } else if (powerShotFinal.isActive()) {
                    const consumed = powerShotFinal.renderFinal(renderPostInputToCurrentTarget);
                    if (!consumed) renderPostInputToCurrentTarget();
                } else {
                    renderer.render(scene, camera);
                }
                updateCloneBlobAnalysis();
                return;
            }

            const originalBackground = forceEnvironmentBackground ? scene.background : null;

            try {
                if (forceEnvironmentBackground) {
                    scene.background = scene.environment;
                }
                core.updatePerFrame();
                if (shaderLabActive) {
                    const consumed = shaderLabFinal.renderFinal(() => postProcessing.render());
                    if (!consumed) postProcessing.render();
                } else if (powerShotFinal.isActive()) {
                    const consumed = powerShotFinal.renderFinal(() => postProcessing.render());
                    if (!consumed) postProcessing.render();
                } else {
                    postProcessing.render();
                }
            } catch (error) {
                core.restoreSceneAfterPostPass();
                disableWithError('Post pipeline render failed', error);
                renderer.render(scene, camera);
            } finally {
                if (forceEnvironmentBackground) {
                    scene.background = originalBackground;
                }
            }

            updateCloneBlobAnalysis();
        },

        afterExternalRender() {
            updateCloneBlobAnalysis();
        },

        getBlobs() {
            return lastBlobs;
        },

        drawBlobOverlay(ctx, canvasW, canvasH) {
            ctx.clearRect(0, 0, canvasW, canvasH);
            if (!state.clone.enabled || lastBlobs.length === 0) return;
            const cl = state.clone;
            const a = cl.opacity;
            const density = cl.gridDensity;

            ctx.font = '10px "Segoe UI", system-ui, monospace';

            for (const blob of lastBlobs) {
                const ba = a * (blob.opacity != null ? blob.opacity : 1);
                if (ba < 0.01) continue;
                const bx = blob.x * canvasW;
                const by = blob.y * canvasH;
                const bw = blob.w * canvasW;
                const bh = blob.h * canvasH;
                const ccx = blob.cx * canvasW;
                const ccy = blob.cy * canvasH;

                // ── Subdivision grid inside the blob rect ──
                if (density >= 2) {
                    ctx.strokeStyle = `rgba(255,255,255,${ba * 0.15})`;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    for (let i = 1; i < density; i++) {
                        const gx = bx + (bw * i / density);
                        ctx.moveTo(gx, by); ctx.lineTo(gx, by + bh);
                        const gy = by + (bh * i / density);
                        ctx.moveTo(bx, gy); ctx.lineTo(bx + bw, gy);
                    }
                    ctx.stroke();
                }

                // ── Main bounding rectangle ──
                ctx.strokeStyle = `rgba(255,255,255,${ba})`;
                ctx.lineWidth = 2;
                ctx.strokeRect(bx, by, bw, bh);

                // ── Corner brackets ──
                const bracketLen = Math.min(bw, bh, 14) * 0.35;
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.moveTo(bx, by + bracketLen); ctx.lineTo(bx, by); ctx.lineTo(bx + bracketLen, by);
                ctx.moveTo(bx + bw - bracketLen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + bracketLen);
                ctx.moveTo(bx + bw, by + bh - bracketLen); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - bracketLen, by + bh);
                ctx.moveTo(bx + bracketLen, by + bh); ctx.lineTo(bx, by + bh); ctx.lineTo(bx, by + bh - bracketLen);
                ctx.stroke();

                // ── Centroid crosshair ──
                ctx.strokeStyle = `rgba(255,255,255,${ba})`;
                ctx.lineWidth = 1.5;
                const crossSize = 6;
                ctx.beginPath();
                ctx.moveTo(ccx - crossSize, ccy); ctx.lineTo(ccx + crossSize, ccy);
                ctx.moveTo(ccx, ccy - crossSize); ctx.lineTo(ccx, ccy + crossSize);
                ctx.stroke();

                // ── Label ──
                ctx.fillStyle = `rgba(255,255,255,${ba * 0.9})`;
                const areaPercent = (blob.area * 100).toFixed(1);
                ctx.fillText(`#${blob.id} ${areaPercent}%`, bx + 3, by - 4);
            }
        },

        resize() {
            syncRendererResizeState();
        },
    };

    if (typeof window !== 'undefined') {
        window.addEventListener('maxjs-shader-lab-state', () => {
            core.syncSharedSceneEffects(true);
            if (supportsScreenSpaceEffects && state.retro.enabled) {
                rebuildPipeline();
            }
        });
    }

    return fxApi;
}

export { createMaxJSFxController as createSSGIController };
