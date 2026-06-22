// PowerShot ISP final-stylize stage — shared by the editor facade
// (maxjs_fx.js) and the standalone snapshot viewer (snapshot_fx.js).
// Verbatim move of the PowerShot machinery from maxjs_fx.js: the native
// stack (plain render or post pipeline) renders into a half-float input
// target, then the PowerShot ping-pong pipeline consumes that texture as
// the final pass. Snapshots dynamic-import this module only when
// runtimeFeatures.post_fx lists 'powershot'.
import * as THREE from 'three';
import { Pipeline as PowerShotPipeline, applyPreset as applyPowerShotPreset, STAGE_DEFS as POWERSHOT_STAGE_DEFS } from '../../powershot_pipeline.js';
import { PRESETS as POWERSHOT_PRESETS, PRESET_KEYS as POWERSHOT_PRESET_KEYS } from '../../powershot_presets.js';
import { FilmPipeline as PowerShotFilmPipeline, applyFilmPreset as applyPowerShotFilmPreset, FILM_PRESETS as POWERSHOT_FILM_PRESETS, FILM_PRESET_KEYS as POWERSHOT_FILM_PRESET_KEYS } from '../../powershot_film.js';
import { InfraredPipeline as PowerShotInfraredPipeline, applyInfraredPreset as applyPowerShotInfraredPreset, INFRARED_PRESETS as POWERSHOT_INFRARED_PRESETS, INFRARED_PRESET_KEYS as POWERSHOT_INFRARED_PRESET_KEYS } from '../../powershot_infrared.js';

function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function powerShotNonZero(value, epsilon = 1.0e-6) {
    return Math.abs(Number(value) || 0) > epsilon;
}

function powerShotAnyNonZero(values, epsilon = 1.0e-6) {
    return Array.isArray(values) && values.some((value) => powerShotNonZero(value, epsilon));
}

function powerShotAnyUniformNonZero(preset, keys) {
    return keys.some((key) => powerShotNonZero(preset?.[key]));
}

function powerShotArrayDiffers(values, identity) {
    return Array.isArray(values)
        && values.some((value, index) => Math.abs((Number(value) || 0) - identity[index]) > 1.0e-6);
}

function powerShotCcmDiffers(ccm) {
    const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    return Array.isArray(ccm)
        && ccm.some((row, rowIndex) => powerShotArrayDiffers(row, identity[rowIndex] || []));
}

export function normalizePowerShotPreset(value) {
    const key = String(value || 'powershot');
    return POWERSHOT_PRESETS[key] ? key : 'powershot';
}

export function normalizePowerShotFilmStock(value) {
    const key = String(value || POWERSHOT_FILM_PRESET_KEYS[0]);
    return POWERSHOT_FILM_PRESETS[key] ? key : POWERSHOT_FILM_PRESET_KEYS[0];
}

export function powerShotFilmStockUiDefaults(key) {
    const stock = POWERSHOT_FILM_PRESETS[normalizePowerShotFilmStock(key)];
    return {
        filmExposure: stock.exposure ?? 0,
        filmGrain: stock.grain_strength ?? 1.0,
        filmGrainSize: stock.grain_size ?? 1.6,
        filmGrainColour: stock.grain_saturation ?? 0.8,
        filmHalation: stock.halation_strength ?? 0.35,
        filmHalationThreshold: stock.halation_threshold ?? 0.55,
        filmHalationRadius: stock.halation_radius ?? 1.5,
        filmWeave: stock.weave ?? 0.4,
        filmFlicker: stock.flicker ?? 0.12,
    };
}

export function listPowerShotFilmStocks() {
    return POWERSHOT_FILM_PRESET_KEYS.map((key) => ({
        key,
        label: POWERSHOT_FILM_PRESETS[key]?.name || key,
    }));
}

export function normalizePowerShotInfraredPreset(value) {
    const key = String(value || POWERSHOT_INFRARED_PRESET_KEYS[0]);
    return POWERSHOT_INFRARED_PRESETS[key] ? key : POWERSHOT_INFRARED_PRESET_KEYS[0];
}

// Flat UI trims pulled from a preset; the full preset (phosphor colours, curves,
// gain limits, etc.) is applied wholesale in syncInfraredPipeline, then these
// user-facing knobs are layered on top.
export function powerShotInfraredPresetUiDefaults(key) {
    const preset = POWERSHOT_INFRARED_PRESETS[normalizePowerShotInfraredPreset(key)];
    return {
        irExposure: preset.exposure ?? 1.25,
        irResponse: preset.nir_input ?? 0,
        irLocalGain: preset.local_gain ?? 0.48,
        irGlow: preset.glow_strength ?? 0.92,
        irGlowThreshold: preset.glow_threshold ?? 0.43,
        irEyes: preset.eye_strength ?? 1.15,
        irNoise: preset.noise_amount ?? 1.0,
        irVignette: preset.vignette ?? 0.52,
        irHotspot: preset.hotspot ?? 0.12,
    };
}

export function listPowerShotInfraredPresets() {
    return POWERSHOT_INFRARED_PRESET_KEYS.map((key) => ({
        key,
        label: POWERSHOT_INFRARED_PRESETS[key]?.name || key,
    }));
}

export function powerShotPresetUiDefaults(key) {
    const preset = POWERSHOT_PRESETS[normalizePowerShotPreset(key)] || POWERSHOT_PRESETS.powershot;
    return {
        lensSoftness: preset.lens_softness ?? 0.25,
        ccdBloom: preset.ccd_bloom_strength ?? 0,
        bayerNR: preset.bnr_strength ?? 0,
        jpegStrength: 0.2,
        jpegQuality: preset.jpeg_quality ?? 60,
        jpegChroma420: 0.75,
        jpegMidtone: 0.45,
        jpegHighlight: 1.0,
        analogStrength: preset.analog_vhs_strength ?? 0.65,
        analogTracking: preset.analog_tracking ?? 0.45,
        analogChromaBleed: preset.analog_chroma_bleed ?? 0.75,
        analogRinging: preset.analog_ringing ?? 0.65,
        analogTapeNoise: preset.analog_tape_noise ?? 0.75,
        analogBandMask: preset.analog_band_mask ?? 0.35,
        analogEdgeWave: preset.analog_edge_wave ?? 0.35,
        analogDropouts: preset.analog_dropouts ?? 0.35,
        analogScanlines: preset.analog_scanlines ?? 0.55,
        analogHeadSwitch: preset.analog_head_switch ?? 0.45,
    };
}

export function listPowerShotPresets() {
    return POWERSHOT_PRESET_KEYS.map((key) => ({
        key,
        label: POWERSHOT_PRESETS[key]?.name || key,
    }));
}

/**
 * @param renderer                  WebGPURenderer
 * @param getOptions                () => state.powershot (live object; normalize mutates it in place, as before)
 * @param getScaledPostFxSize       core.getScaledPostFxSize
 * @param supportsScreenSpaceEffects backend capability flag
 * @param isShaderLabEnabled        Shader Lab wins the final-stylize slot
 */
export function createPowerShotFinal({
    renderer,
    getOptions,
    getScaledPostFxSize,
    supportsScreenSpaceEffects = false,
    isShaderLabEnabled = () => false,
}) {
    let powerShotInputTarget = null;
    let powerShotPipeline = null;
    let filmPipeline = null;
    let infraredPipeline = null;
    let powerShotFrame = 0;
    const drawBufferSize = new THREE.Vector2();

    function readRendererDrawBufferSize() {
        if (typeof renderer.getDrawingBufferSize === 'function') {
            return renderer.getDrawingBufferSize(drawBufferSize);
        }
        return renderer.getSize(drawBufferSize);
    }

    function normalizeOptions() {
        const p = getOptions();
        p.mode = p.mode === 'analog' ? 'analog'
            : p.mode === 'film' ? 'film'
            : p.mode === 'infrared' ? 'infrared'
            : 'digital';
        p.amount = THREE.MathUtils.clamp(finiteOr(p.amount, 1.0), 0, 1);
        p.resolutionScale = THREE.MathUtils.clamp(finiteOr(p.resolutionScale, 0.75), 0.1, 1);
        p.lensSoftness = THREE.MathUtils.clamp(finiteOr(p.lensSoftness, 0.32), 0, 1);
        p.ccdBloom = THREE.MathUtils.clamp(finiteOr(p.ccdBloom, 0.35), 0, 2);
        p.noiseScale = THREE.MathUtils.clamp(finiteOr(p.noiseScale, 1.06), 0, 2);
        p.bayerNR = THREE.MathUtils.clamp(finiteOr(p.bayerNR, 0.5), 0, 1);
        p.chromaNR = THREE.MathUtils.clamp(finiteOr(p.chromaNR, 1.0), 0, 1);
        p.jpegStrength = THREE.MathUtils.clamp(finiteOr(p.jpegStrength, 0.2), 0, 1);
        p.jpegQuality = THREE.MathUtils.clamp(finiteOr(p.jpegQuality, 60), 1, 100);
        p.jpegChroma420 = THREE.MathUtils.clamp(finiteOr(p.jpegChroma420, 0.75), 0, 1);
        p.jpegMidtone = THREE.MathUtils.clamp(finiteOr(p.jpegMidtone, 0.45), 0, 1);
        p.jpegHighlight = THREE.MathUtils.clamp(finiteOr(p.jpegHighlight, 1.0), 0, 2);
        p.brightness = THREE.MathUtils.clamp(finiteOr(p.brightness, 0), -1, 1);
        p.contrast = THREE.MathUtils.clamp(finiteOr(p.contrast, 0), -1, 1);
        p.analogStrength = THREE.MathUtils.clamp(finiteOr(p.analogStrength, 0.72), 0, 3);
        p.analogTracking = THREE.MathUtils.clamp(finiteOr(p.analogTracking, 0.46), 0, 3);
        p.analogChromaBleed = THREE.MathUtils.clamp(finiteOr(p.analogChromaBleed, 0.76), 0, 3);
        p.analogRinging = THREE.MathUtils.clamp(finiteOr(p.analogRinging, 0.62), 0, 3);
        p.analogTapeNoise = THREE.MathUtils.clamp(finiteOr(p.analogTapeNoise, 0.70), 0, 3);
        p.analogBandMask = THREE.MathUtils.clamp(finiteOr(p.analogBandMask, 0.35), 0, 3);
        p.analogEdgeWave = THREE.MathUtils.clamp(finiteOr(p.analogEdgeWave, 0.34), 0, 3);
        p.analogDropouts = THREE.MathUtils.clamp(finiteOr(p.analogDropouts, 0.32), 0, 3);
        p.analogScanlines = THREE.MathUtils.clamp(finiteOr(p.analogScanlines, 0.54), 0, 3);
        p.analogHeadSwitch = THREE.MathUtils.clamp(finiteOr(p.analogHeadSwitch, 0.42), 0, 3);
        p.filmStock = normalizePowerShotFilmStock(p.filmStock);
        p.filmExposure = THREE.MathUtils.clamp(finiteOr(p.filmExposure, 0), -3, 3);
        p.filmInputGamma = THREE.MathUtils.clamp(finiteOr(p.filmInputGamma, 0.65), 0.5, 1.5);
        p.filmGrain = THREE.MathUtils.clamp(finiteOr(p.filmGrain, 1.0), 0, 3);
        p.filmGrainSize = THREE.MathUtils.clamp(finiteOr(p.filmGrainSize, 1.6), 0.5, 4);
        p.filmGrainColour = THREE.MathUtils.clamp(finiteOr(p.filmGrainColour, 0.8), 0, 1);
        p.filmHalation = THREE.MathUtils.clamp(finiteOr(p.filmHalation, 0.35), 0, 1);
        p.filmHalationThreshold = THREE.MathUtils.clamp(finiteOr(p.filmHalationThreshold, 0.55), 0, 1);
        p.filmHalationRadius = THREE.MathUtils.clamp(finiteOr(p.filmHalationRadius, 1.5), 0.5, 3);
        p.filmPrintExposure = THREE.MathUtils.clamp(finiteOr(p.filmPrintExposure, 0), -1, 1);
        p.filmPrintWarmth = THREE.MathUtils.clamp(finiteOr(p.filmPrintWarmth, 0), -1, 1);
        p.filmWeave = THREE.MathUtils.clamp(finiteOr(p.filmWeave, 0.4), 0, 2);
        p.filmFlicker = THREE.MathUtils.clamp(finiteOr(p.filmFlicker, 0.12), 0, 1);
        p.filmNegative = !!p.filmNegative;
        p.infraredPreset = normalizePowerShotInfraredPreset(p.infraredPreset);
        p.irExposure = THREE.MathUtils.clamp(finiteOr(p.irExposure, 1.25), -3, 4);
        p.irResponse = THREE.MathUtils.clamp(finiteOr(p.irResponse, 0), 0, 1);
        p.irLocalGain = THREE.MathUtils.clamp(finiteOr(p.irLocalGain, 0.48), 0, 1.5);
        p.irGlow = THREE.MathUtils.clamp(finiteOr(p.irGlow, 0.92), 0, 3);
        p.irGlowThreshold = THREE.MathUtils.clamp(finiteOr(p.irGlowThreshold, 0.43), 0, 1);
        p.irEyes = THREE.MathUtils.clamp(finiteOr(p.irEyes, 1.15), 0, 3);
        p.irNoise = THREE.MathUtils.clamp(finiteOr(p.irNoise, 1.0), 0, 3);
        p.irVignette = THREE.MathUtils.clamp(finiteOr(p.irVignette, 0.52), 0, 1);
        p.irHotspot = THREE.MathUtils.clamp(finiteOr(p.irHotspot, 0.12), 0, 1);
        return p;
    }

    function isActive() {
        const p = normalizeOptions();
        if (p.mode === 'analog') {
            return supportsScreenSpaceEffects
                && !!p.enabled
                && p.amount > 1.0e-6
                && (p.analogStrength > 1.0e-6 || Math.abs(p.brightness) > 1.0e-6 || Math.abs(p.contrast) > 1.0e-6)
                && !isShaderLabEnabled();
        }
        return supportsScreenSpaceEffects
            && !!p.enabled
            && p.amount > 1.0e-6
            && !isShaderLabEnabled();
    }

    function syncFilmPipeline() {
        if (!filmPipeline) return;
        const p = normalizeOptions();
        const stock = POWERSHOT_FILM_PRESETS[p.filmStock];
        // stock preset first (curves, lights, grain character), then the
        // user-facing trims from state on top
        applyPowerShotFilmPreset(filmPipeline.ctx, stock);
        filmPipeline.ctx.power.value = THREE.MathUtils.clamp(p.amount, 0, 1);
        const F = filmPipeline.ctx.P;
        F.exposure.value = p.filmExposure;
        F.inputGamma.value = p.filmInputGamma;
        F.grainStrength.value = p.filmGrain;
        F.grainSize.value = p.filmGrainSize;
        F.grainSaturation.value = p.filmGrainColour;
        F.halStrength.value = p.filmHalation;
        F.halThreshold.value = p.filmHalationThreshold;
        F.halRadius.value = p.filmHalationRadius;
        F.printExposure.value = p.filmPrintExposure * 0.301; // slider stops -> log10
        F.printWarmth.value = p.filmPrintWarmth;
        F.weave.value = p.filmWeave;
        F.flicker.value = p.filmFlicker;
        F.negativeView.value = p.filmNegative ? 1 : 0;
        filmPipeline.setEnabled?.('halation', p.filmHalation > 1.0e-6);
    }

    function syncInfraredPipeline() {
        if (!infraredPipeline) return;
        const p = normalizeOptions();
        const presetKey = normalizePowerShotInfraredPreset(p.infraredPreset);
        const preset = POWERSHOT_INFRARED_PRESETS[presetKey];
        p.infraredPreset = presetKey;
        // full preset first (phosphor colours, gain curve, noise character),
        // then the user-facing trims from state on top
        applyPowerShotInfraredPreset(infraredPipeline.ctx, preset);
        infraredPipeline.ctx.power.value = THREE.MathUtils.clamp(p.amount, 0, 1);
        const I = infraredPipeline.ctx.P;
        I.exposure.value = p.irExposure;
        I.nirInput.value = p.irResponse;
        I.localGain.value = p.irLocalGain;
        I.glowStrength.value = p.irGlow;
        I.glowThreshold.value = p.irGlowThreshold;
        I.eyeStrength.value = p.irEyes;
        I.noiseAmount.value = p.irNoise;
        I.vignette.value = p.irVignette;
        I.hotspot.value = p.irHotspot;
    }

    function syncPipeline() {
        syncFilmPipeline();
        syncInfraredPipeline();
        if (!powerShotPipeline) return;
        const p = normalizeOptions();
        const presetKey = normalizePowerShotPreset(p.preset);
        const preset = POWERSHOT_PRESETS[presetKey];
        p.preset = presetKey;
        powerShotPipeline.setMode?.(p.mode);
        applyPowerShotPreset(powerShotPipeline.ctx, preset);
        powerShotPipeline.ctx.power.value = THREE.MathUtils.clamp(p.amount, 0, 1);
        powerShotPipeline.ctx.P.lensSoftness.value = p.lensSoftness;
        powerShotPipeline.ctx.P.ccdBloom.value = p.ccdBloom;
        powerShotPipeline.ctx.noiseScale.value = p.noiseScale;
        powerShotPipeline.ctx.P.bayerNR.value = p.bayerNR;
        powerShotPipeline.ctx.P.chromaNR.value = p.chromaNR;
        powerShotPipeline.ctx.P.jpegStrength.value = p.jpegStrength;
        powerShotPipeline.ctx.P.jpegQuality.value = p.jpegQuality;
        powerShotPipeline.ctx.P.jpegChroma420.value = p.jpegChroma420;
        powerShotPipeline.ctx.P.jpegMidtone.value = p.jpegMidtone;
        powerShotPipeline.ctx.P.jpegHighlight.value = p.jpegHighlight;
        powerShotPipeline.ctx.P.analogStrength.value = p.analogStrength;
        powerShotPipeline.ctx.P.analogTracking.value = p.analogTracking;
        powerShotPipeline.ctx.P.analogChromaBleed.value = p.analogChromaBleed;
        powerShotPipeline.ctx.P.analogRinging.value = p.analogRinging;
        powerShotPipeline.ctx.P.analogTapeNoise.value = p.analogTapeNoise;
        powerShotPipeline.ctx.P.analogBandMask.value = p.analogBandMask;
        powerShotPipeline.ctx.P.analogEdgeWave.value = p.analogEdgeWave;
        powerShotPipeline.ctx.P.analogDropouts.value = p.analogDropouts;
        powerShotPipeline.ctx.P.analogScanlines.value = p.analogScanlines;
        powerShotPipeline.ctx.P.analogHeadSwitch.value = p.analogHeadSwitch;
        powerShotPipeline.setOutputColorGrading?.(p);

        const digital = p.mode === 'digital';
        if (!digital) return;

        const setDigitalStage = (id, enabled) => powerShotPipeline.setEnabled?.(id, digital && !!enabled);
        const hasNoise = p.noiseScale > 1.0e-6 && powerShotAnyUniformNonZero(preset, [
            'noise_intensity', 'color_noise_intensity', 'column_fpn', 'row_fpn', 'prnu', 'dsnu',
        ]);
        setDigitalStage('barrel', powerShotNonZero(preset?.barrel_distortion));
        setDigitalStage('ca', powerShotNonZero(preset?.chromatic_aberration));
        setDigitalStage('lens', p.lensSoftness > 1.0e-6);
        setDigitalStage('ccdbloom', p.ccdBloom > 1.0e-6);
        setDigitalStage('mosaic', true);
        setDigitalStage('dpc', powerShotNonZero(preset?.hot_pixel_rate));
        setDigitalStage('blacklevel', powerShotAnyNonZero(preset?.black_level));
        setDigitalStage('noise', hasNoise);
        setDigitalStage('aaf', powerShotNonZero(preset?.aaf_strength));
        setDigitalStage('bnr', p.bayerNR > 1.0e-6);
        setDigitalStage('wb', powerShotArrayDiffers(preset?.wb_shift, [1, 1, 1]));
        setDigitalStage('demosaic', true);
        setDigitalStage('chromanr', p.chromaNR > 1.0e-6);
        setDigitalStage('ccm', powerShotCcmDiffers(preset?.ccm));
        setDigitalStage('tone', false);
        setDigitalStage('saturation', Math.abs((Number(preset?.saturation_boost) || 1) - 1) > 1.0e-6);
        setDigitalStage('vignette', powerShotNonZero(preset?.vignette_strength));
        setDigitalStage('edge', powerShotNonZero(preset?.ee_gain));
        setDigitalStage('jpeg', p.jpegStrength > 1.0e-6);
    }

    function ensurePipeline() {
        if (!powerShotPipeline) {
            powerShotPipeline = new PowerShotPipeline(renderer);
            for (const stage of POWERSHOT_STAGE_DEFS) {
                powerShotPipeline.setEnabled(stage.id, stage.id !== 'tone');
            }
        }
        syncPipeline();
        return powerShotPipeline;
    }

    function ensureFilmPipeline() {
        if (!filmPipeline) filmPipeline = new PowerShotFilmPipeline(renderer);
        syncFilmPipeline();
        return filmPipeline;
    }

    function ensureInfraredPipeline() {
        if (!infraredPipeline) infraredPipeline = new PowerShotInfraredPipeline(renderer);
        syncInfraredPipeline();
        return infraredPipeline;
    }

    // film mode runs its own negative->print pipeline and infrared runs the
    // pseudo-NIR night-vision pipeline; digital/analog share the classic ISP
    // runner. All expose renderTexture(tex, frame, opts) / setSize(w, h).
    function ensureActivePipeline() {
        const mode = normalizeOptions().mode;
        if (mode === 'film') return ensureFilmPipeline();
        if (mode === 'infrared') return ensureInfraredPipeline();
        return ensurePipeline();
    }

    function ensureInputTarget() {
        readRendererDrawBufferSize();
        const drawWidth = Math.max(1, Math.round(drawBufferSize.x || renderer.domElement?.width || 1));
        const drawHeight = Math.max(1, Math.round(drawBufferSize.y || renderer.domElement?.height || 1));
        const powerShotScale = THREE.MathUtils.clamp(Number(getOptions().resolutionScale) || 1, 0.1, 1);
        const { width: workWidth, height: workHeight } = getScaledPostFxSize(drawWidth, drawHeight, powerShotScale);
        const targetMatches = powerShotInputTarget
            && powerShotInputTarget.width === workWidth
            && powerShotInputTarget.height === workHeight;
        if (!targetMatches) {
            try { powerShotInputTarget?.dispose?.(); } catch (_) {}
            powerShotInputTarget = new THREE.RenderTarget(workWidth, workHeight, {
                type: THREE.HalfFloatType,
                colorSpace: THREE.LinearSRGBColorSpace,
                depthBuffer: true,
                stencilBuffer: false,
            });
        }
        ensureActivePipeline().setSize(workWidth, workHeight);
        return powerShotInputTarget;
    }

    function renderFinal(renderNativeToCurrentTarget) {
        if (!isActive()) return false;
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

        try {
            renderer.toneMapping = previousToneMapping;
            renderer.toneMappingExposure = previousExposure;
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

        if (!getOptions().freezeNoise) powerShotFrame += 1;
        const pipeline = ensureActivePipeline();
        try {
            renderer.toneMapping = THREE.NoToneMapping;
            renderer.toneMappingExposure = 1.0;
            renderer.outputColorSpace = previousOutputColorSpace;
            renderer.setClearColor?.(0x000000, 0);
            return pipeline.renderTexture(target.texture, powerShotFrame, {
                outputTarget: previousTarget,
            }) === true;
        } finally {
            renderer.toneMapping = previousToneMapping;
            renderer.toneMappingExposure = previousExposure;
            renderer.outputColorSpace = previousOutputColorSpace;
            if (previousClearAlpha != null) {
                try { renderer.setClearColor?.(previousClearColor, previousClearAlpha); } catch (_) {}
            }
        }
    }

    return {
        isActive,
        normalizeOptions,
        syncPipeline,
        renderFinal,
        hasPipeline: () => !!powerShotPipeline || !!filmPipeline || !!infraredPipeline,
        dispose() {
            try { powerShotInputTarget?.dispose?.(); } catch (_) {}
            powerShotInputTarget = null;
            try { powerShotPipeline?.dispose?.(); } catch (_) {}
            powerShotPipeline = null;
            try { filmPipeline?.dispose?.(); } catch (_) {}
            filmPipeline = null;
            try { infraredPipeline?.dispose?.(); } catch (_) {}
            infraredPipeline = null;
        },
    };
}
