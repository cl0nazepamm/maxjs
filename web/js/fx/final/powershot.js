// PowerShot ISP final-stylize stage — shared by the editor facade
// (maxjs_fx.js) and the standalone snapshot viewer (snapshot_fx.js).
// Verbatim move of the PowerShot machinery from maxjs_fx.js: the native
// stack (plain render or post pipeline) renders into a half-float input
// target, then the PowerShot ping-pong pipeline consumes that texture as
// the final pass. Snapshots dynamic-import this module only when
// runtimeFeatures.post_fx lists 'powershot'.
import * as THREE from 'three';
import { Pipeline as PowerShotPipeline, applyPreset as applyPowerShotPreset, STAGE_DEFS as POWERSHOT_STAGE_DEFS } from 'powershot-threejs/pipeline';
import { PRESETS as POWERSHOT_PRESETS, PRESET_KEYS as POWERSHOT_PRESET_KEYS } from 'powershot-threejs/presets';
import { FilmPipeline as PowerShotFilmPipeline, applyFilmPreset as applyPowerShotFilmPreset, FILM_PRESETS as POWERSHOT_FILM_PRESETS, FILM_PRESET_KEYS as POWERSHOT_FILM_PRESET_KEYS } from 'powershot-threejs/film';
import { InfraredPipeline as PowerShotInfraredPipeline, applyInfraredProfile as applyPowerShotInfraredProfile, applyInfraredPreset as applyPowerShotInfraredPreset, INFRARED_PRESETS as POWERSHOT_INFRARED_PRESETS, INFRARED_PRESET_KEYS as POWERSHOT_INFRARED_PRESET_KEYS } from 'powershot-threejs/infrared';
import { NightshotPipeline as PowerShotNightshotPipeline, applyNightshotPreset as applyPowerShotNightshotPreset, NIGHTSHOT_PRESETS as POWERSHOT_NIGHTSHOT_PRESETS } from 'powershot-threejs/nightshot';
import { SolarFlarePipeline } from 'powershot-threejs/solar-flare';
import { HELIAR_TRONNIER_100MM, loadHeliarTronnierFlareProfile } from 'powershot-threejs/solar-flare-profile';

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

function exposureLinearToStops(linear) {
    return Math.log2(Math.max(1e-8, Number(linear) || 1));
}

function setPowerShotInputExposure(pipeline, mode, linearExposure, options) {
    if (!pipeline || mode === 'film') return;
    const stops = exposureLinearToStops(linearExposure);
    if (typeof pipeline.setInputExposure === 'function') {
        pipeline.setInputExposure(stops);
        return;
    }

    // Compatibility with published PowerShot versions before setInputExposure.
    if (mode === 'infrared' && pipeline.ctx?.P?.exposure) {
        pipeline.ctx.P.exposure.value = options.irExposure + stops;
    } else if (mode === 'nightshot' && pipeline.ir?.ctx?.P?.exposure) {
        pipeline.ir.ctx.P.exposure.value = options.irExposure + stops;
    } else if (pipeline.ctx?.sceneExposure) {
        pipeline.ctx.sceneExposure.value = stops;
    }
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

const POWERSHOT_DEFAULT_INFRARED_PRESET = 'gen3_white_phosphor_nir';

export function normalizePowerShotInfraredPreset(value) {
    const fallback = POWERSHOT_INFRARED_PRESETS[POWERSHOT_DEFAULT_INFRARED_PRESET] ? POWERSHOT_DEFAULT_INFRARED_PRESET : POWERSHOT_INFRARED_PRESET_KEYS[0];
    const key = String(value || fallback);
    return POWERSHOT_INFRARED_PRESETS[key]?.input_mode === 'nir' ? key : fallback;
}

// Flat UI trims pulled from a preset; the full preset (phosphor colours, curves,
// gain limits, etc.) is applied wholesale in syncInfraredPipeline, then these
// user-facing knobs are layered on top.
export function powerShotInfraredPresetUiDefaults(key) {
    const preset = POWERSHOT_INFRARED_PRESETS[normalizePowerShotInfraredPreset(key)];
    return {
        irExposure: preset.exposure ?? 0.85,
        irInputGamma: preset.input_gamma ?? 1.0,
        irResponse: preset.nir_input ?? 0,
        irLocalGain: preset.local_gain ?? 0.46,
        irGlow: preset.glow_strength ?? 0.34,
        irGlowThreshold: preset.glow_threshold ?? 0.44,
        irNoise: preset.noise_amount ?? 0.48,
        irVignette: preset.vignette ?? 0.26,
        irHotspot: preset.hotspot ?? 0.055,
    };
}

export function listPowerShotInfraredPresets() {
    // max.js feeds the tube a scene-linear NIR response, not an ordinary RGB image.
    return POWERSHOT_INFRARED_PRESET_KEYS
        .filter((key) => POWERSHOT_INFRARED_PRESETS[key]?.input_mode === 'nir')
        .map((key) => ({
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
        analogTrackingChoppiness: preset.analog_tracking_choppiness ?? 1.0,
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

// UI trims seeded when the user enters NightShot mode: the shared analog
// sliders drive nightshot.cam, so entering the mode loads the preset's dialed
// tape character instead of the classic-analog defaults.
export function powerShotNightshotUiDefaults() {
    const ns = POWERSHOT_NIGHTSHOT_PRESETS.nightshot_plus;
    const cam = ns.cam;
    return {
        irNoise: ns.ir.noise_amount ?? 0.5,
        analogStrength: cam.analog_vhs_strength ?? 1.15,
        analogTracking: cam.analog_tracking ?? 0.45,
        analogTrackingChoppiness: cam.analog_tracking_choppiness ?? 1.0,
        analogChromaBleed: cam.analog_chroma_bleed ?? 0.15,
        analogRinging: cam.analog_ringing ?? 0.95,
        analogTapeNoise: cam.analog_tape_noise ?? 0.85,
        analogBandMask: cam.analog_band_mask ?? 0.3,
        analogEdgeWave: cam.analog_edge_wave ?? 0.3,
        analogDropouts: cam.analog_dropouts ?? 0.35,
        analogScanlines: cam.analog_scanlines ?? 0.75,
        analogHeadSwitch: cam.analog_head_switch ?? 0.5,
        nsSmear: ns.smear ?? 0.9,
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
 *
 * Viewer Exposure is scene-linear plate gain before every non-film mode.
 * Film ignores it and keeps filmExposure as the authoritative stock exposure.
 * brightness + contrast are post-effect corrective grades via setOutputColorGrading
 * (powershotLinearGrade on the linear print/phosphor/ISP output) — not input exposure.
 */
export function createPowerShotFinal({
    renderer,
    getOptions,
    getScaledPostFxSize,
    supportsScreenSpaceEffects = false,
    isShaderLabEnabled = () => false,
    getCamera = () => null,
    getSun = () => null,
    getDepthTexture = () => null,
}) {
    let powerShotInputTarget = null;
    let powerShotPipeline = null;
    let filmPipeline = null;
    let infraredPipeline = null;
    let infraredProfileKey = null;
    let nightshotPipeline = null;
    let flarePipeline = null;
    let flareProfilePromise = null;
    let flareTarget = null;
    let flareFailed = false;
    let flareLens = null;
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
            : p.mode === 'nightshot' ? 'nightshot'
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
        p.analogTrackingChoppiness = THREE.MathUtils.clamp(finiteOr(p.analogTrackingChoppiness, 1.0), 0, 1);
        p.analogChromaBleed = THREE.MathUtils.clamp(finiteOr(p.analogChromaBleed, 0.76), 0, 3);
        p.analogRinging = THREE.MathUtils.clamp(finiteOr(p.analogRinging, 0.62), 0, 3);
        p.analogTapeNoise = THREE.MathUtils.clamp(finiteOr(p.analogTapeNoise, 0.70), 0, 3);
        p.analogBandMask = THREE.MathUtils.clamp(finiteOr(p.analogBandMask, 0.35), 0, 3);
        p.analogEdgeWave = THREE.MathUtils.clamp(finiteOr(p.analogEdgeWave, 0.34), 0, 3);
        p.analogDropouts = THREE.MathUtils.clamp(finiteOr(p.analogDropouts, 0.32), 0, 3);
        p.analogScanlines = THREE.MathUtils.clamp(finiteOr(p.analogScanlines, 0.54), 0, 3);
        p.analogHeadSwitch = THREE.MathUtils.clamp(finiteOr(p.analogHeadSwitch, 0.42), 0, 3);
        p.filmStock = normalizePowerShotFilmStock(p.filmStock);
        p.filmExposure = THREE.MathUtils.clamp(finiteOr(p.filmExposure, 0), -12, 12);
        p.filmInputGamma = THREE.MathUtils.clamp(finiteOr(p.filmInputGamma, 0.65), 0.5, 1.5);
        p.filmGrain = THREE.MathUtils.clamp(finiteOr(p.filmGrain, 1.0), 0, 3);
        p.filmGrainSize = THREE.MathUtils.clamp(finiteOr(p.filmGrainSize, 1.6), 0.5, 4);
        p.filmGrainColour = THREE.MathUtils.clamp(finiteOr(p.filmGrainColour, 0.8), 0, 1);
        p.filmHalation = THREE.MathUtils.clamp(finiteOr(p.filmHalation, 0.35), 0, 1);
        p.filmHalationThreshold = THREE.MathUtils.clamp(finiteOr(p.filmHalationThreshold, 0.55), 0, 1);
        p.filmHalationRadius = THREE.MathUtils.clamp(finiteOr(p.filmHalationRadius, 1.5), 0.5, 3);
        p.filmPrintExposure = THREE.MathUtils.clamp(finiteOr(p.filmPrintExposure, 0), -1, 1);
        p.filmPrintWarmth = THREE.MathUtils.clamp(finiteOr(p.filmPrintWarmth, 0), -1, 1);
        p.filmHighlightBurn = THREE.MathUtils.clamp(finiteOr(p.filmHighlightBurn, 0.7), 0, 1);
        p.filmHueRestore = THREE.MathUtils.clamp(finiteOr(p.filmHueRestore, 0.2), 0, 1);
        p.filmWeave = THREE.MathUtils.clamp(finiteOr(p.filmWeave, 0.4), 0, 2);
        p.filmFlicker = THREE.MathUtils.clamp(finiteOr(p.filmFlicker, 0.12), 0, 1);
        p.filmNegative = !!p.filmNegative;
        p.infraredPreset = normalizePowerShotInfraredPreset(p.infraredPreset);
        p.irExposure = THREE.MathUtils.clamp(finiteOr(p.irExposure, 0.85), -12, 12);
        p.irInputGamma = THREE.MathUtils.clamp(finiteOr(p.irInputGamma, 1.0), 0.35, 2);
        p.irResponse = THREE.MathUtils.clamp(finiteOr(p.irResponse, 0), 0, 1);
        p.irLocalGain = THREE.MathUtils.clamp(finiteOr(p.irLocalGain, 0.46), 0, 1.5);
        p.irGlow = THREE.MathUtils.clamp(finiteOr(p.irGlow, 0.34), 0, 3);
        p.irGlowThreshold = THREE.MathUtils.clamp(finiteOr(p.irGlowThreshold, 0.44), 0, 1);
        p.irNoise = THREE.MathUtils.clamp(finiteOr(p.irNoise, 0.48), 0, 3);
        p.irElectronModel = p.irElectronModel === true;
        p.irElectronsPerUnit = THREE.MathUtils.clamp(finiteOr(p.irElectronsPerUnit, 1024), 1, 1.0e6);
        p.irVignette = THREE.MathUtils.clamp(finiteOr(p.irVignette, 0.26), 0, 1);
        p.irHotspot = THREE.MathUtils.clamp(finiteOr(p.irHotspot, 0.055), 0, 1);
        p.nsSmear = THREE.MathUtils.clamp(finiteOr(p.nsSmear, 0.9), 0, 2);
        p.flareEnabled = p.flareEnabled === true;
        p.flareStrength = THREE.MathUtils.clamp(finiteOr(p.flareStrength, 1.0), 0, 4);
        p.flareFNumber = THREE.MathUtils.clamp(finiteOr(p.flareFNumber, 8), 1, 64);
        p.flareRadiance = THREE.MathUtils.clamp(finiteOr(p.flareRadiance, 4.0), 0, 1000);
        p.flareGhosts = THREE.MathUtils.clamp(finiteOr(p.flareGhosts, 1.0), 0, 4);
        p.flareVeiling = THREE.MathUtils.clamp(finiteOr(p.flareVeiling, 0.06), 0, 1);
        return p;
    }

    // Solar Flares — scene-linear optical sun flare rendered onto the plate
    // BEFORE the ISP/film/tube consumes it (a camera photographs the flare;
    // it does not composite one on afterwards). The Heliar atlas loads async;
    // frames pass through untouched until it is ready.
    function flareActive() {
        const p = normalizeOptions();
        return supportsScreenSpaceEffects
            && !!p.enabled
            && p.flareEnabled
            && p.flareStrength > 1.0e-6
            && !!getSun()
            && getCamera()?.isPerspectiveCamera === true;
    }

    function ensureFlarePipeline() {
        if (flareFailed) return null;
        if (!flareProfilePromise) {
            flareProfilePromise = loadHeliarTronnierFlareProfile()
                .then((profile) => {
                    flareLens = { ...HELIAR_TRONNIER_100MM };
                    flarePipeline = new SolarFlarePipeline(renderer, {
                        profile,
                        ownsProfile: true,
                        lens: flareLens,
                    });
                })
                .catch((error) => {
                    flareFailed = true;
                    console.warn('[powershot] Solar Flares atlas load failed', error);
                });
        }
        return flarePipeline;
    }

    function renderFlareOntoPlate(target) {
        const flare = ensureFlarePipeline();
        if (!flare) return null;
        const p = normalizeOptions();
        flare.setEnabled(true);
        flare.setStrength({
            strength: p.flareStrength,
            ghosts: p.flareGhosts,
            veiling: p.flareVeiling,
        });
        // Angular fit: the Heliar profile is a 100 mm lens (24° FOV). On a
        // wide viewer camera its flare pattern renders at true angular size —
        // ghosts compressed near frame centre and a few-pixel starburst.
        // Scale the virtual sensor gate and diffraction window so the pattern
        // spans the frame the way it does on the profile's own 36×24 gate,
        // while the aperture/housing optics stay in real Heliar millimetres.
        const projectionY = Math.abs(getCamera()?.projectionMatrix?.elements?.[5]) || 1;
        const fit = (2 * HELIAR_TRONNIER_100MM.focalLengthMm / HELIAR_TRONNIER_100MM.sensorHeightMm)
            / projectionY;
        flareLens.sensorWidthMm = HELIAR_TRONNIER_100MM.sensorWidthMm * fit;
        flareLens.sensorHeightMm = HELIAR_TRONNIER_100MM.sensorHeightMm * fit;
        flare.settings.diffractionScale = fit;
        // setAperture re-derives the diffraction extent from diffractionScale.
        flare.setAperture({ fNumber: p.flareFNumber });
        if (!flareTarget
            || flareTarget.width !== target.width
            || flareTarget.height !== target.height) {
            try { flareTarget?.dispose?.(); } catch (_) {}
            flareTarget = new THREE.RenderTarget(target.width, target.height, {
                type: THREE.HalfFloatType,
                colorSpace: THREE.LinearSRGBColorSpace,
                depthBuffer: false,
                stencilBuffer: false,
            });
        }
        try {
            // Solar occlusion reads the scene pass depth (deformed cloth
            // included), never the input target's own depth — that one holds
            // the post pipeline's output quad and reads "occluded" everywhere.
            let depthTexture = null;
            try { depthTexture = getDepthTexture() || null; } catch (_) {}
            const ok = flare.renderTexture(target.texture, powerShotFrame, {
                camera: getCamera(),
                sun: getSun(),
                depthTexture,
                sourceRadiance: p.flareRadiance,
                width: target.width,
                height: target.height,
                outputTarget: flareTarget,
            });
            return ok === true ? flareTarget.texture : null;
        } catch (error) {
            flareFailed = true;
            console.warn('[powershot] Solar Flares render failed; flare disabled', error);
            return null;
        }
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
        F.highlightBurn.value = p.filmHighlightBurn;
        F.hueRestore.value = p.filmHueRestore;
        F.weave.value = p.filmWeave;
        F.flicker.value = p.filmFlicker;
        F.negativeView.value = p.filmNegative ? 1 : 0;
        filmPipeline.setEnabled?.('halation', p.filmHalation > 1.0e-6);
        // post-print corrective grade (not film exposure)
        filmPipeline.setOutputColorGrading?.({ brightness: p.brightness, contrast: p.contrast });
    }

    function syncInfraredPipeline() {
        if (!infraredPipeline) return;
        const p = normalizeOptions();
        const presetKey = normalizePowerShotInfraredPreset(p.infraredPreset);
        const preset = POWERSHOT_INFRARED_PRESETS[presetKey];
        p.infraredPreset = presetKey;
        // A profile change also updates input interpretation + halo topology and
        // clears temporal history once. Ordinary frame sync must not clear it:
        // persistence and ABC/autogating need their previous-frame buffers.
        if (infraredProfileKey !== presetKey) {
            applyPowerShotInfraredProfile(infraredPipeline, preset);
            infraredProfileKey = presetKey;
        } else {
            // Full preset first (phosphor colours, gain curve, noise character),
            // then the user-facing trims from state on top.
            applyPowerShotInfraredPreset(infraredPipeline.ctx, preset);
        }
        infraredPipeline.ctx.power.value = THREE.MathUtils.clamp(p.amount, 0, 1);
        const I = infraredPipeline.ctx.P;
        I.exposure.value = p.irExposure;
        I.inputGamma.value = p.irInputGamma;
        infraredPipeline.setInputResponse(p.irResponse, preset.flux_scale ?? 1.0);
        I.localGain.value = p.irLocalGain;
        I.glowStrength.value = p.irGlow;
        I.glowThreshold.value = p.irGlowThreshold;
        I.noiseAmount.value = p.irNoise;
        infraredPipeline.setElectronModel?.(p.irElectronModel
            ? { electronsPerUnit: p.irElectronsPerUnit }
            : false);
        I.vignette.value = p.irVignette;
        I.hotspot.value = p.irHotspot;
        // post-phosphor corrective grade (not tube exposure)
        infraredPipeline.setOutputColorGrading?.({ brightness: p.brightness, contrast: p.contrast });
    }

    function syncNightshotPipeline() {
        if (!nightshotPipeline) return;
        const p = normalizeOptions();
        // full preset first (CCD sensor character, camcorder tape path), then
        // the user-facing trims on top. The shared ir* trims drive the sensor
        // half; the smear knob is NightShot-only.
        applyPowerShotNightshotPreset(nightshotPipeline, POWERSHOT_NIGHTSHOT_PRESETS.nightshot_plus);
        nightshotPipeline.ctx.power.value = THREE.MathUtils.clamp(p.amount, 0, 1);
        const I = nightshotPipeline.ir.ctx.P;
        I.exposure.value = p.irExposure;
        I.inputGamma.value = p.irInputGamma;
        nightshotPipeline.ir.setInputResponse(
            p.irResponse,
            POWERSHOT_NIGHTSHOT_PRESETS.nightshot_plus.ir.flux_scale ?? 1.0,
        );
        I.noiseAmount.value = p.irNoise;
        // PowerShot <=0.6.1 added the NightShot hotspot as constant green
        // emission, lifting black across most of the frame. Newer pipelines
        // expose setInputExposure and use a black-preserving gain hotspot.
        if (typeof nightshotPipeline.setInputExposure !== 'function') I.hotspot.value = 0;
        nightshotPipeline.ctx.P.smear.value = p.nsSmear;
        // shared analog trims drive the camcorder tape path (state is seeded
        // from the NightShot preset on mode entry — powerShotNightshotUiDefaults)
        const A = nightshotPipeline.cam.ctx.P;
        A.analogStrength.value = p.analogStrength;
        A.analogTracking.value = p.analogTracking;
        A.analogTrackingChoppiness.value = p.analogTrackingChoppiness;
        A.analogChromaBleed.value = p.analogChromaBleed;
        A.analogRinging.value = p.analogRinging;
        A.analogTapeNoise.value = p.analogTapeNoise;
        A.analogBandMask.value = p.analogBandMask;
        A.analogEdgeWave.value = p.analogEdgeWave;
        A.analogDropouts.value = p.analogDropouts;
        A.analogScanlines.value = p.analogScanlines;
        A.analogHeadSwitch.value = p.analogHeadSwitch;
        // post-camcorder corrective grade (forwards to internal camera ISP)
        nightshotPipeline.setOutputColorGrading?.({ brightness: p.brightness, contrast: p.contrast });
    }

    function syncPipeline() {
        syncFilmPipeline();
        syncInfraredPipeline();
        syncNightshotPipeline();
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
        powerShotPipeline.ctx.P.analogTrackingChoppiness.value = p.analogTrackingChoppiness;
        powerShotPipeline.ctx.P.analogChromaBleed.value = p.analogChromaBleed;
        powerShotPipeline.ctx.P.analogRinging.value = p.analogRinging;
        powerShotPipeline.ctx.P.analogTapeNoise.value = p.analogTapeNoise;
        powerShotPipeline.ctx.P.analogBandMask.value = p.analogBandMask;
        powerShotPipeline.ctx.P.analogEdgeWave.value = p.analogEdgeWave;
        powerShotPipeline.ctx.P.analogDropouts.value = p.analogDropouts;
        powerShotPipeline.ctx.P.analogScanlines.value = p.analogScanlines;
        powerShotPipeline.ctx.P.analogHeadSwitch.value = p.analogHeadSwitch;
        // post-ISP corrective grade — not sceneExposure / input gain
        powerShotPipeline.setOutputColorGrading?.({ brightness: p.brightness, contrast: p.contrast });

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

    function ensureNightshotPipeline() {
        if (!nightshotPipeline) nightshotPipeline = new PowerShotNightshotPipeline(renderer);
        syncNightshotPipeline();
        return nightshotPipeline;
    }

    // film mode runs its own negative->print pipeline, infrared runs the
    // pseudo-NIR night-vision pipeline, nightshot runs the CCD camcorder
    // composition (sensor + tape path); digital/analog share the classic ISP
    // runner. All expose renderTexture(tex, frame, opts) / setSize(w, h).
    function ensureActivePipeline() {
        const mode = normalizeOptions().mode;
        if (mode === 'film') return ensureFilmPipeline();
        if (mode === 'infrared') return ensureInfraredPipeline();
        if (mode === 'nightshot') return ensureNightshotPipeline();
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
            // The ISP is the IMAGER: it receives scene-linear radiance and
            // owns the entire transfer curve (setInputEncoding('linear')
            // below). Running the display tone map first would stack two
            // response curves — a camera doesn't photograph a tone-mapped
            // JPEG of the world.
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

        if (!getOptions().freezeNoise) powerShotFrame += 1;
        // Brightness/contrast already live in the pipeline's post-effect output
        // grade. Viewer Exposure is a separate pre-effect plate gain.
        const options = normalizeOptions();
        const pipeline = ensureActivePipeline();
        pipeline.setInputEncoding?.('linear');
        setPowerShotInputExposure(pipeline, options.mode, previousExposure, options);
        try {
            renderer.toneMapping = THREE.NoToneMapping;
            renderer.toneMappingExposure = 1.0;
            renderer.outputColorSpace = previousOutputColorSpace;
            renderer.setClearColor?.(0x000000, 0);
            // Optical flare joins the scene-linear plate before the imager.
            let plateTexture = target.texture;
            if (flareActive()) {
                plateTexture = renderFlareOntoPlate(target) || target.texture;
            }
            return pipeline.renderTexture(plateTexture, powerShotFrame, {
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
        hasPipeline: () => !!powerShotPipeline || !!filmPipeline || !!infraredPipeline || !!nightshotPipeline,
        dispose() {
            try { powerShotInputTarget?.dispose?.(); } catch (_) {}
            powerShotInputTarget = null;
            try { powerShotPipeline?.dispose?.(); } catch (_) {}
            powerShotPipeline = null;
            try { filmPipeline?.dispose?.(); } catch (_) {}
            filmPipeline = null;
            try { infraredPipeline?.dispose?.(); } catch (_) {}
            infraredPipeline = null;
            infraredProfileKey = null;
            try { nightshotPipeline?.dispose?.(); } catch (_) {}
            nightshotPipeline = null;
            try { flareTarget?.dispose?.(); } catch (_) {}
            flareTarget = null;
            try { flarePipeline?.dispose?.(); } catch (_) {}
            flarePipeline = null;
            flareProfilePromise = null;
            flareFailed = false;
        },
    };
}
