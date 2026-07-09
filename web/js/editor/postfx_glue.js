// postfx_glue.js - editor post-FX panel, tone mapping, and persistence glue.
import * as THREE from 'three';
import { powerShotInfraredPresetUiDefaults } from '../fx/final/powershot.js';

function createPostFxGlue(deps = {}) {
        let syncClonePanelFn = null;
        let lastPostFxSignature = '';

        function computePathTracingApertureRadius(dof = {}) {
            const focusDistance = Math.max(0.01, Number(dof.focusDistance) || 5);
            const dofRange = Math.max(0.01, Number(dof.focalLength) || focusDistance);
            const bokehScale = Math.max(0, Number(dof.bokehScale) || 0);
            if (bokehScale <= 0) return 0;

            // Post DOF's "focalLength" is a transition range, not optical focal
            // length. Map a narrower range to a stronger PT lens radius, but
            // ramp it gently so the focus plane stays usable.
            const bokehFactor = Math.min(1, bokehScale / 30);
            const rangeFactor = Math.sqrt(Math.min(16, Math.max(0.05, focusDistance / dofRange)));
            const radius = focusDistance * bokehFactor * rangeFactor * 0.006;
            return Math.max(0, Math.min(radius, focusDistance * 0.02));
        }

        function syncPathTracingDofFromPostFx() {
            if (!deps.pathTracingFx?.setDOF) return;
            const dof = deps.maxjsFx.getState?.().dof || {};
            const enabled = deps.maxjsFx.isDofEnabled?.() === true && deps.camera?.isPerspectiveCamera === true;
            const focusDistance = Math.max(0.01, Number(dof.focusDistance) || deps.camera.position.distanceTo(deps.controls.target) || 5);
            deps.pathTracingFx.setDOF({
                enabled,
                focusDistance,
                apertureRadius: enabled ? computePathTracingApertureRadius({ ...dof, focusDistance }) : 0,
            });
        }

        // One PT live frame: route through the post stack when beauty-only or
        // final stylize effects are on, else blit straight to the canvas.
        function applyCoreToneMappingState({ markOutput = true } = {}) {
            deps.renderer.toneMapping = deps.toneMappingModes[deps.currentToneMapping] ?? deps.toneMappingModes[deps.DEFAULT_TONE_MAPPING];
            deps.renderer.toneMappingExposure = deps.currentExposure;
            deps.renderer.userData ??= {};
            deps.renderer.userData.maxjsToneMappingMode = deps.currentToneMapping;
            deps.renderer.userData.maxjsToneMappingExposure = deps.currentExposure;
            if (markOutput) deps.maxjsFx.markOutputChanged?.();
        }

        const isPowerShotInfraredMode = (values) => values.mode === 'infrared';
        const isPowerShotNightshotMode = (values) => values.mode === 'nightshot';
        // Both read NIR flux — spectral-only, and both drive the NIR sensing gates.
        const isPowerShotNirMode = (values) => isPowerShotInfraredMode(values) || isPowerShotNightshotMode(values);
        const isPowerShotDigitalMode = (values) => values.mode !== 'analog' && values.mode !== 'film' && !isPowerShotNirMode(values);
        const isPowerShotAnalogMode = (values) => values.mode === 'analog';
        const isPowerShotFilmMode = (values) => values.mode === 'film';
        const isPowerShotJpegActive = (values) => isPowerShotDigitalMode(values) && Number(values.jpegStrength) > 1.0e-6;
        const isPowerShotAnalogActive = (values) => isPowerShotAnalogMode(values) && Number(values.analogStrength) > 1.0e-6;
        // modes whose output rides the analog tape path (VHS sliders apply):
        // Analog VHS itself, and NightShot's camcorder back end.
        const isPowerShotTapePathMode = (values) => isPowerShotAnalogMode(values) || isPowerShotNightshotMode(values);
        const isPowerShotTapeActive = (values) => isPowerShotTapePathMode(values) && Number(values.analogStrength) > 1.0e-6;
        const isPowerShotTemporalNoiseActive = (values) =>
            (isPowerShotDigitalMode(values) && Number(values.noiseScale) > 1.0e-6)
            || isPowerShotAnalogActive(values)
            || (isPowerShotFilmMode(values) && Number(values.filmGrain) > 1.0e-6)
            || (isPowerShotInfraredMode(values) && Number(values.irNoise) > 1.0e-6)
            || isPowerShotNightshotMode(values); // CCD shot noise + tape noise are always temporal

        const postFxSections = [
            {
                key: 'ssgi',
                title: 'SSGI',
                copy: 'Diffuse bounce lighting and ambient occlusion from the current frame.',
                note: 'Requires WebGPU or Force WebGL.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setEnabled(enabled),
                getValues: (state) => state.ssgi,
                setValues: (patch) => deps.maxjsFx.setSSGIOptions(patch),
                controls: [
                    { key: 'radius', label: 'Radius', min: 1, max: 24, step: 0.5 },
                    { key: 'thickness', label: 'Thickness', min: 0.01, max: 10, step: 0.01 },
                    { key: 'aoIntensity', label: 'AO Intensity', min: 0, max: 4, step: 0.05 },
                    { key: 'giIntensity', label: 'GI Intensity', min: 0, max: 32, step: 0.1 },
                    { key: 'expFactor', label: 'Falloff', min: 1, max: 3, step: 0.05 },
                    { key: 'sliceCount', label: 'Slices', min: 1, max: 4, step: 1, integer: true },
                    { key: 'stepCount', label: 'Steps', min: 1, max: 24, step: 1, integer: true },
                    { key: 'temporal', label: 'Temporal Filter', type: 'checkbox' },
                ],
            },
            {
                key: 'ssr',
                title: 'SSR',
                copy: 'Screen-space reflections for glossy and mirror-like surfaces.',
                note: 'Requires WebGPU or Force WebGL.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isSSREnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setSSREnabled(enabled),
                getValues: (state) => state.ssr,
                setValues: (patch) => deps.maxjsFx.setSSROptions(patch),
                controls: [
                    { key: 'quality', label: 'Quality', min: 0, max: 1, step: 0.01 },
                    { key: 'blurQuality', label: 'Blur Quality', min: 1, max: 3, step: 1, integer: true },
                    { key: 'maxDistance', label: 'Max Distance', min: 0.05, max: 2, step: 0.01 },
                    { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
                    { key: 'thickness', label: 'Thickness', min: 0.001, max: 0.05, step: 0.001 },
                    { key: 'denoise', label: 'Denoiser', type: 'checkbox' },
                    { key: 'stochastic', label: 'Stochastic Rays', type: 'checkbox', visibleWhen: (values) => !values.denoise },
                    { key: 'denoiseRadius', label: 'Denoise Radius', min: 0.25, max: 24, step: 0.25, visibleWhen: (values) => values.denoise },
                    { key: 'denoiseStrength', label: 'Temporal Strength', min: 0.01, max: 1, step: 0.01, visibleWhen: (values) => values.denoise },
                    { key: 'denoiseFrames', label: 'History Frames', min: 1, max: 64, step: 1, integer: true, visibleWhen: (values) => values.denoise },
                    { key: 'denoiseAdaptiveTrust', label: 'Firefly Guard', min: 0, max: 1, step: 0.01, visibleWhen: (values) => values.denoise },
                ],
            },
            {
                key: 'gtao',
                title: 'GTAO',
                copy: 'Ground-truth ambient occlusion from a dedicated depth and normal pre-pass.',
                note: 'Requires WebGPU or Force WebGL.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isGTAOEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setGTAOEnabled(enabled),
                getValues: (state) => state.gtao,
                setValues: (patch) => deps.maxjsFx.setGTAOOptions(patch),
                controls: [
                    { key: 'radius', label: 'Radius', min: 0.05, max: 2, step: 0.01 },
                    { key: 'thickness', label: 'Thickness', min: 0.01, max: 2, step: 0.01 },
                    { key: 'scale', label: 'Intensity', min: 0, max: 4, step: 0.05 },
                    { key: 'distanceExponent', label: 'Dist Exp', min: 1, max: 2, step: 0.01 },
                    { key: 'distanceFallOff', label: 'Falloff', min: 0.01, max: 1, step: 0.01 },
                    { key: 'samples', label: 'Samples', min: 4, max: 32, step: 1, integer: true },
                    { key: 'resolutionScale', label: 'Resolution', min: 0.25, max: 1, step: 0.05 },
                ],
            },
            {
                key: 'bloom',
                title: 'Bloom',
                copy: 'Highlights bleed for emissive and high-energy surfaces.',
                note: 'Requires WebGPU or Force WebGL.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isBloomEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setBloomEnabled(enabled),
                getValues: (state) => state.bloom,
                setValues: (patch) => deps.maxjsFx.setBloomOptions(patch),
                controls: [
                    { key: 'strength', label: 'Strength', min: 0, max: 3, step: 0.01 },
                    { key: 'radius', label: 'Radius', min: 0, max: 1, step: 0.01 },
                    { key: 'threshold', label: 'Threshold', min: 0, max: 2, step: 0.01 },
                ],
            },
            {
                key: 'toonOutline',
                title: 'Toon Outline',
                copy: 'Black ink outline on objects with ThreeJS Toon material. Auto-detected.',
                note: 'Only visible on MeshToonMaterial objects.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isToonOutlineEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setToonOutlineEnabled(enabled),
                getValues: (state) => state.toonOutline,
                setValues: (patch) => deps.maxjsFx.setToonOutlineOptions(patch),
                controls: [
                    { key: 'thickness', label: 'Thickness', min: 0.001, max: 0.02, step: 0.001 },
                    { key: 'alpha', label: 'Opacity', min: 0, max: 1, step: 0.01 },
                ],
            },
            {
                key: 'motionBlur',
                title: 'Motion Blur',
                copy: 'Velocity-based blur from camera and object motion in the current frame.',
                note: 'Requires WebGPU or Force WebGL.',
                requiresWebGPU: true,
                // Pixel FX takes the post-pass output; motion blur on top is meaningless
                // (it would smear the pixelated image). Mutually exclusive.
                disabledBy: (state) => state.pixel.enabled
                    ? 'Disabled while Pixel FX is on.'
                    : null,
                isEnabled: () => deps.maxjsFx.isMotionBlurEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setMotionBlurEnabled(enabled),
                getValues: (state) => state.motionBlur,
                setValues: (patch) => deps.maxjsFx.setMotionBlurOptions(patch),
                controls: [
                    { key: 'amount', label: 'Amount', min: 0, max: 3, step: 0.01 },
                    { key: 'samples', label: 'Samples', min: 4, max: 32, step: 1, integer: true },
                ],
            },
            // TRAA is now managed via the Anti-Aliasing selector above the FX sections
            {
                key: 'contactShadow',
                title: 'Contact Shadows',
                copy: 'Screen-space shadows for detailed close-range shadowing.',
                note: 'Requires WebGPU or Force WebGL and a DirectionalLight.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isContactShadowEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setContactShadowEnabled(enabled),
                getValues: (state) => state.contactShadow,
                setValues: (patch) => deps.maxjsFx.setContactShadowOptions(patch),
                controls: [
                    { key: 'maxDistance', label: 'Max Distance', min: 0.01, max: 1, step: 0.01 },
                    { key: 'thickness', label: 'Thickness', min: 0.001, max: 0.1, step: 0.001 },
                    { key: 'shadowIntensity', label: 'Intensity', min: 0, max: 1, step: 0.01 },
                    { key: 'quality', label: 'Quality', min: 0, max: 1, step: 0.01 },
                    { key: 'temporal', label: 'Temporal', type: 'checkbox' },
                ],
            },
            {
                key: 'retro',
                title: 'Retro',
                copy: 'PS1-style posterization, scanlines, barrel distortion, and CRT effects.',
                note: 'Requires WebGPU or Force WebGL.',
                disabledBy: () => (deps.shaderLabFx?.isEnabled?.()
                    ? 'Disabled while Shader Lab is active.'
                    : null),
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isRetroEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setRetroEnabled(enabled),
                getValues: (state) => state.retro,
                setValues: (patch) => deps.maxjsFx.setRetroOptions(patch),
                controls: [
                    { key: 'dither', label: 'Dither', type: 'checkbox' },
                    { key: 'colorDepth', label: 'Color Depth', min: 2, max: 64, step: 1, integer: true, realtime: true },
                    { key: 'scanlines', label: 'Scanlines', type: 'checkbox' },
                    { key: 'scanlineIntensity', label: 'Scan Intensity', min: 0, max: 1, step: 0.01, realtime: true },
                    { key: 'scanlineDensity', label: 'Scan Density', min: 0.02, max: 1, step: 0.01, realtime: true },
                    { key: 'crt', label: 'CRT Distortion', type: 'checkbox' },
                    { key: 'curvature', label: 'Curvature', min: 0, max: 0.2, step: 0.01, realtime: true },
                    { key: 'bleeding', label: 'Color Bleed', min: 0, max: 0.01, step: 0.001, realtime: true },
                    { key: 'vignetteIntensity', label: 'Vignette', min: 0, max: 1, step: 0.01, realtime: true },
                ],
            },
            {
                key: 'volumetric',
                title: 'Volumetric Light',
                copy: 'Ray-marched light scattering through fog volume. Reacts to scene lights.',
                note: 'Requires WebGPU or Force WebGL.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isVolumetricEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setVolumetricEnabled(enabled),
                getValues: (state) => state.volumetric,
                setValues: (patch) => deps.maxjsFx.setVolumetricOptions(patch),
                controls: [
                    { key: 'intensity', label: 'Intensity', min: 0.001, max: 5, dynamic: 'log', realtime: true },
                    { key: 'density', label: 'Density', min: 0, max: 1, step: 0.01, realtime: true },
                    { key: 'steps', label: 'Steps', min: 2, max: 32, step: 1, integer: true },
                    { key: 'denoise', label: 'Denoise', min: 0, max: 2, step: 0.05, realtime: true },
                    { key: 'resolution', label: 'Resolution', min: 0.1, max: 1, step: 0.05 },
                ],
            },
            {
                key: 'pixel',
                title: 'Pixel FX',
                copy: 'Pixelation, chromatic aberration, sharpen, color grading, and film grain.',
                note: 'Requires WebGPU or Force WebGL. Mutually exclusive with Motion Blur.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isPixelEnabled(),
                setEnabled: (enabled) => {
                    // Pixel FX and Motion Blur are mutually exclusive — turning on
                    // Pixel forces Motion Blur off so the disabled-by gate is honored.
                    if (enabled && deps.maxjsFx.isMotionBlurEnabled()) {
                        deps.maxjsFx.setMotionBlurEnabled(false);
                    }
                    return deps.maxjsFx.setPixelEnabled(enabled);
                },
                getValues: (state) => state.pixel,
                setValues: (patch) => deps.maxjsFx.setPixelOptions(patch),
                controls: [
                    { key: 'pixelate', label: 'Pixelate', type: 'checkbox' },
                    { key: 'pixelSize', label: 'Pixel Size', min: 1, max: 32, step: 1, integer: true, realtime: true },
                    { key: 'chromatic', label: 'Chromatic Aberr', type: 'checkbox' },
                    { key: 'chromaticIntensity', label: 'CA Intensity', min: 0, max: 0.05, step: 0.001, realtime: true },
                    { key: 'sharpen', label: 'Sharpen', type: 'checkbox' },
                    { key: 'sharpenStrength', label: 'Sharp Strength', min: 0, max: 3, step: 0.05, realtime: true },
                    { key: 'grain', label: 'Film Grain', type: 'checkbox' },
                    { key: 'grainIntensity', label: 'Grain Amount', min: 0, max: 0.5, step: 0.01, realtime: true },
                    { key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01, realtime: true },
                    { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, realtime: true },
                    { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01, realtime: true },
                ],
            },
            {
                key: 'powershot',
                title: 'PowerShot',
                copy: 'Compact digital camera ISP, analog VHS, and motion-picture film: CCD smear, Bayer artifacts, JPEG blocks, tape damage, or a Vision3 negative printed to 2383 with grain and halation.',
                note: 'Requires WebGPU or Force WebGL. Disabled while Shader Lab is active.',
                keepVisibleWhenUnsupported: true,
                disabledBy: () => (deps.shaderLabFx?.isEnabled?.()
                    ? 'Disabled while Shader Lab is active.'
                    : null),
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isPowerShotEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setPowerShotEnabled(enabled),
                getValues: (state) => ({
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
                    filmHighlightBurn: 0.7,
                    filmHueRestore: 0.2,
                    filmWeave: 0.4,
                    filmFlicker: 0.12,
                    filmNegative: false,
                    infraredPreset: 'white_phosphor_nir',
                    ...powerShotInfraredPresetUiDefaults('white_phosphor_nir'),
                    nsSmear: 0.9,
                    freezeNoise: false,
                    ...(state.powershot || {}),
                    // A save written in spectral can carry a NIR mode;
                    // standard mode must never surface white phosphor/NightShot.
                    ...(!deps.isStudioMode && ['infrared', 'nightshot'].includes(state.powershot?.mode) ? { mode: 'digital' } : {}),
                }),
                setValues: (patch) => deps.maxjsFx.setPowerShotOptions(
                    !deps.isStudioMode && ['infrared', 'nightshot'].includes(patch?.mode) ? { ...patch, mode: 'digital' } : patch),
                controls: [
                    {
                        key: 'mode',
                        label: 'Mode',
                        type: 'select',
                        options: [
                            { value: 'digital', label: 'Digital CCD' },
                            { value: 'analog', label: 'Analog VHS' },
                            { value: 'film', label: 'Film Print' },
                            // NIR modes read spectral flux — spectral-only.
                            ...(deps.isStudioMode ? [
                                { value: 'infrared', label: 'White Phosphor' },
                                { value: 'nightshot', label: 'NightShot' },
                            ] : []),
                        ],
                    },
                    {
                        key: 'filmStock',
                        label: 'Film Stock',
                        type: 'select',
                        visibleWhen: isPowerShotFilmMode,
                        options: deps.maxjsFx.getPowerShotFilmStocks().map((stock) => ({
                            value: stock.key,
                            label: stock.label,
                        })),
                    },
                    {
                        key: 'preset',
                        label: 'Preset',
                        type: 'select',
                        visibleWhen: isPowerShotDigitalMode,
                        options: deps.maxjsFx.getPowerShotPresets().map((preset) => ({
                            value: preset.key,
                            label: `${preset.key} - ${preset.label}`,
                        })),
                    },
                    { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, realtime: true },
                    { key: 'resolutionScale', label: 'Resolution', min: 0.1, max: 1, step: 0.05 },
                    { key: 'lensSoftness', label: 'Lens Softness', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotDigitalMode },
                    { key: 'ccdBloom', label: 'CCD Bloom', min: 0, max: 2, step: 0.01, realtime: true, visibleWhen: isPowerShotDigitalMode },
                    { key: 'noiseScale', label: 'Noise', min: 0, max: 2, step: 0.01, realtime: true, visibleWhen: isPowerShotDigitalMode },
                    { key: 'bayerNR', label: 'Bayer NR', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotDigitalMode },
                    { key: 'chromaNR', label: 'Chroma NR', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotDigitalMode },
                    { key: 'jpegStrength', label: 'JPEG', min: 0, max: 1, step: 0.01, realtime: true, affectsVisibility: true, visibleWhen: isPowerShotDigitalMode },
                    { key: 'jpegQuality', label: 'JPEG Quality', min: 1, max: 100, step: 1, integer: true, realtime: true, visibleWhen: isPowerShotJpegActive },
                    { key: 'jpegChroma420', label: 'JPEG Chroma', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotJpegActive },
                    { key: 'jpegMidtone', label: 'JPEG Midtones', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotJpegActive },
                    { key: 'jpegHighlight', label: 'JPEG Highlights', min: 0, max: 2, step: 0.01, realtime: true, visibleWhen: isPowerShotJpegActive },
                    { key: 'filmExposure', label: 'Exposure (stops)', min: -3, max: 3, step: 0.05, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmInputGamma', label: 'Input Gamma', min: 0.5, max: 1.5, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmGrain', label: 'Grain', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmGrainSize', label: 'Grain Size', min: 0.5, max: 4, step: 0.05, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmGrainColour', label: 'Grain Colour', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmHalation', label: 'Halation', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmHalationThreshold', label: 'Halation Threshold', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmHalationRadius', label: 'Halation Radius', min: 0.5, max: 3, step: 0.05, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmPrintExposure', label: 'Print Exposure', min: -1, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmPrintWarmth', label: 'Print Warmth', min: -1, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmHighlightBurn', label: 'Highlight Burn', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmHueRestore', label: 'Hue Restore', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmWeave', label: 'Gate Weave', min: 0, max: 2, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmFlicker', label: 'Flicker', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotFilmMode },
                    { key: 'filmNegative', label: 'Show Negative', type: 'checkbox', visibleWhen: isPowerShotFilmMode },
                    { key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01, realtime: true, visibleWhen: (values) => !isPowerShotFilmMode(values) && !isPowerShotNirMode(values) },
                    { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, realtime: true, visibleWhen: (values) => !isPowerShotFilmMode(values) && !isPowerShotNirMode(values) },
                    { key: 'analogStrength', label: 'VHS Strength', min: 0, max: 3, step: 0.01, realtime: true, affectsVisibility: true, visibleWhen: isPowerShotTapePathMode },
                    { key: 'analogTracking', label: 'Tracking', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'analogChromaBleed', label: 'Chroma Bleed', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'analogRinging', label: 'Ringing', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'analogTapeNoise', label: 'Tape Noise', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'analogBandMask', label: 'Band Mask', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'analogEdgeWave', label: 'Edge Wave', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'analogDropouts', label: 'Dropouts', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'analogScanlines', label: 'Scanlines', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'analogHeadSwitch', label: 'Head Switch', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotTapeActive },
                    { key: 'irExposure', label: 'Exposure (stops)', min: -8, max: 8, step: 0.05, realtime: true, visibleWhen: isPowerShotNirMode },
                    { key: 'irResponse', label: 'IR Response', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotNirMode },
                    { key: 'irLocalGain', label: 'Local Gain', min: 0, max: 1.5, step: 0.01, realtime: true, visibleWhen: isPowerShotInfraredMode },
                    { key: 'irGlow', label: 'Halo Bloom', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotInfraredMode },
                    { key: 'irGlowThreshold', label: 'Bloom Threshold', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotInfraredMode },
                    { key: 'irEyes', label: 'Eye Flare', min: 0, max: 3, step: 0.01, realtime: true, visibleWhen: isPowerShotInfraredMode },
                    { key: 'irNoise', label: 'Tube Scintillation', min: 0, max: 3, step: 0.01, realtime: true, affectsVisibility: true, visibleWhen: isPowerShotInfraredMode },
                    { key: 'irVignette', label: 'Tube Vignette', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotInfraredMode },
                    { key: 'irHotspot', label: 'Hotspot', min: 0, max: 1, step: 0.01, realtime: true, visibleWhen: isPowerShotInfraredMode },
                    { key: 'nsSmear', label: 'CCD Smear', min: 0, max: 2, step: 0.01, realtime: true, visibleWhen: isPowerShotNightshotMode },
                    { key: 'freezeNoise', label: 'Freeze Noise', type: 'checkbox', visibleWhen: isPowerShotTemporalNoiseActive },
                ],
            },
            {
                key: 'dof',
                title: 'Depth of Field',
                copy: 'Physical camera DOF with bokeh blur. Auto-syncs from Max Physical Camera when enabled.',
                warn: 'NOTICE: Changing parameters while active can cause temporary flickering.',
                note: 'Requires WebGPU or Force WebGL. Enable DOF on the Physical Camera in Max for auto mode.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isDofEnabled(),
                setEnabled: (enabled) => {
                    const result = deps.maxjsFx.setDofEnabled(enabled);
                    syncPathTracingDofFromPostFx();
                    return result;
                },
                getValues: (state) => state.dof,
                setValues: (patch) => {
                    const result = deps.maxjsFx.setDofOptions(patch);
                    syncPathTracingDofFromPostFx();
                    return result;
                },
                controls: [
                    { key: 'autoFromCamera', label: 'Auto from Camera', type: 'checkbox' },
                    { key: 'focusDistance', label: 'Focus Distance', min: 0.1, max: 10000, step: 1, realtime: true },
                    { key: 'focalLength', label: 'DOF Range', min: 0.1, max: 5000, step: 1, realtime: true },
                    { key: 'bokehScale', label: 'Bokeh Scale', min: 0.5, max: 30, step: 0.5, realtime: true },
                ],
            },
            {
                key: 'fog',
                title: 'Fog',
                copy: 'Distance fog, density fog, or animated procedural ground fog.',
                note: 'Requires WebGPU or Force WebGL. Also controllable via Rendering > Environment > Atmosphere in Max.',
                requiresWebGPU: true,
                isEnabled: () => deps.maxjsFx.isFogEnabled(),
                setEnabled: (enabled) => deps.maxjsFx.setFogEnabled(enabled),
                getValues: (state) => state.fog,
                setValues: (patch) => deps.maxjsFx.setFogOptions(patch),
                controls: [
                    { key: 'type', label: 'Type', min: 0, max: 2, step: 1, integer: true },
                    { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, realtime: true },
                    { key: 'near', label: 'Near', min: 0, max: 9999, step: 1, realtime: true },
                    { key: 'far', label: 'Far', min: 1, max: 9999, step: 5, realtime: true },
                    { key: 'density', label: 'Density', min: 0.0001, max: 0.5, step: 0.001, realtime: true },
                    { key: 'noiseScale', label: 'Noise Scale', min: 0.0001, max: 0.1, step: 0.001, realtime: true },
                    { key: 'noiseSpeed', label: 'Noise Speed', min: 0, max: 5, step: 0.05, realtime: true },
                    { key: 'height', label: 'Height', min: 0, max: 9999, step: 1, realtime: true },
                ],
            },
        ];

        const LOG_SLIDER_STEPS = 1000;
        const EXPOSURE_EV_MIN = -10;
        const EXPOSURE_EV_MAX = 8;
        const EXPOSURE_LINEAR_MIN = Math.pow(2, EXPOSURE_EV_MIN);
        const EXPOSURE_LINEAR_MAX = Math.pow(2, EXPOSURE_EV_MAX);

        function exposureLinearToEv(linear) {
            const safe = Math.max(EXPOSURE_LINEAR_MIN, Math.min(EXPOSURE_LINEAR_MAX, Number(linear) || 1));
            return Math.log2(safe);
        }

        function exposureLinearToSliderInput(linear) {
            return valueToLogSliderInput(linear, EXPOSURE_LINEAR_MIN, EXPOSURE_LINEAR_MAX);
        }

        function exposureSliderInputToLinear(input) {
            return logSliderInputToValue(input, EXPOSURE_LINEAR_MIN, EXPOSURE_LINEAR_MAX);
        }

        function formatExposureEvLabel(linear) {
            const ev = exposureLinearToEv(linear);
            return `${ev >= 0 ? '+' : ''}${ev.toFixed(2)} EV`;
        }

        function postFxControlSliderMode(control) {
            if (!control || control.type === 'checkbox' || control.type === 'select' || control.integer) return 'linear';
            if (control.dynamic === false || control.dynamic === 'linear') return 'linear';
            if (control.dynamic === 'signed-log' || control.dynamic === 'log') return control.dynamic;
            const min = Number(control.min);
            const max = Number(control.max);
            if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 'linear';
            if (min < 0 && max > 0) return 'signed-log';
            if (max > 0) return 'log';
            return 'linear';
        }

        function postFxDynamicSliderFloor(control, maxAbs, currentAbs = NaN) {
            const declaredMin = Number(control.min);
            const step = Number(control.step);
            const candidates = [];
            if (Number.isFinite(declaredMin) && declaredMin > 0) candidates.push(declaredMin);
            if (Number.isFinite(step) && step > 0) candidates.push(step);
            if (Number.isFinite(currentAbs) && currentAbs > 0) candidates.push(currentAbs);
            if (candidates.length === 0 && Number.isFinite(maxAbs) && maxAbs > 0) candidates.push(maxAbs / LOG_SLIDER_STEPS);
            const floor = Math.min(...candidates.filter((v) => Number.isFinite(v) && v > 0));
            return Number.isFinite(floor) && floor > 0 ? floor : 0.001;
        }

        function postFxDynamicPositiveBounds(control, currentValue) {
            const declaredMax = Number(control.max);
            const currentAbs = Math.abs(Number(currentValue));
            const max = Math.max(
                Number.isFinite(declaredMax) && declaredMax > 0 ? declaredMax : 1,
                Number.isFinite(currentAbs) && currentAbs > 0 ? currentAbs : 0
            );
            const min = Math.min(postFxDynamicSliderFloor(control, max, currentAbs), max);
            return { min, max: Math.max(max, min) };
        }

        function valueToLogSliderInput(value, min, max) {
            const v = Math.max(min, Math.min(max, Number(value) || min));
            if (max <= min) return 0;
            const t = Math.log(v / min) / Math.log(max / min);
            return Math.round(Math.max(0, Math.min(1, t)) * LOG_SLIDER_STEPS);
        }

        function logSliderInputToValue(input, min, max) {
            const t = Math.max(0, Math.min(1, Number(input) / LOG_SLIDER_STEPS));
            return min * Math.pow(max / min, t);
        }

        function valueToPostFxDynamicSliderInput(control, value, currentValue = value) {
            const mode = postFxControlSliderMode(control);
            if (mode === 'linear') return Number(value);
            const v = Number(value);
            if (!Number.isFinite(v)) return 0;

            if (mode === 'signed-log') {
                const center = Math.floor(LOG_SLIDER_STEPS / 2);
                if (Math.abs(v) <= 1.0e-12) return center;
                const halfSteps = center - 1;
                const maxAbs = v < 0 ? Math.abs(Number(control.min)) : Number(control.max);
                const { min, max } = postFxDynamicPositiveBounds({ ...control, max: maxAbs }, currentValue);
                if (max <= min) return center;
                const t = Math.max(0, Math.min(1, Math.log(Math.abs(v) / min) / Math.log(max / min)));
                const offset = 1 + Math.round(t * halfSteps);
                return v < 0 ? center - offset : center + offset;
            }

            const declaredMin = Number(control.min);
            if (declaredMin <= 0 && v <= 0) return 0;
            const { min, max } = postFxDynamicPositiveBounds(control, currentValue);
            if (max <= min) return declaredMin <= 0 ? 1 : 0;
            const clamped = Math.max(min, Math.min(max, v));
            const t = Math.max(0, Math.min(1, Math.log(clamped / min) / Math.log(max / min)));
            const zeroSlot = declaredMin <= 0;
            const steps = zeroSlot ? LOG_SLIDER_STEPS - 1 : LOG_SLIDER_STEPS;
            return (zeroSlot ? 1 : 0) + Math.round(t * steps);
        }

        function postFxDynamicSliderInputToValue(control, input, currentValue) {
            const mode = postFxControlSliderMode(control);
            if (mode === 'linear') {
                const raw = Number(input);
                return control.integer ? Math.round(raw) : raw;
            }

            const rawInput = Math.max(0, Math.min(LOG_SLIDER_STEPS, Number(input)));
            if (mode === 'signed-log') {
                const center = Math.floor(LOG_SLIDER_STEPS / 2);
                if (Math.abs(rawInput - center) < 0.5) return 0;
                const sign = rawInput < center ? -1 : 1;
                const maxAbs = sign < 0 ? Math.abs(Number(control.min)) : Number(control.max);
                const { min, max } = postFxDynamicPositiveBounds({ ...control, max: maxAbs }, currentValue);
                if (max <= min) return sign * min;
                const halfSteps = center - 1;
                const offset = Math.max(1, Math.abs(rawInput - center));
                const t = Math.max(0, Math.min(1, (offset - 1) / halfSteps));
                return sign * min * Math.pow(max / min, t);
            }

            const declaredMin = Number(control.min);
            if (declaredMin <= 0 && rawInput <= 0) return 0;
            const { min, max } = postFxDynamicPositiveBounds(control, currentValue);
            if (max <= min) return min;
            const zeroSlot = declaredMin <= 0;
            const steps = zeroSlot ? LOG_SLIDER_STEPS - 1 : LOG_SLIDER_STEPS;
            const adjusted = zeroSlot ? Math.max(1, rawInput) - 1 : rawInput;
            const t = Math.max(0, Math.min(1, adjusted / steps));
            return min * Math.pow(max / min, t);
        }

        function readPostFxControlValue(control, input, getValues) {
            if (control.type === 'checkbox') return input.checked;
            if (control.type === 'select') return input.value;
            if (postFxControlSliderMode(control) !== 'linear') {
                const values = getValues();
                return postFxDynamicSliderInputToValue(control, input.value, values[control.key]);
            }
            const raw = Number(input.value);
            return control.integer ? Math.round(raw) : raw;
        }

        /** Scrub preview only — no maxjsFx / pipeline work (keeps range inputs responsive). */
        function previewPostFxControlLabel(control, input, valueEl, getValues) {
            if (!valueEl || control.type === 'checkbox' || control.type === 'select') return;
            const value = readPostFxControlValue(control, input, getValues);
            valueEl.textContent = formatControlValue(control, value);
        }

        function formatControlValue(control, value) {
            if (control.type === 'checkbox') return value ? 'On' : 'Off';
            if (control.type === 'select') {
                const option = (control.options || []).find((item) => item.value === value);
                return option?.label || String(value ?? '');
            }
            if (!Number.isFinite(value)) return '--';
            if (postFxControlSliderMode(control) !== 'linear') {
                const abs = Math.abs(value);
                if (abs === 0) return '0';
                if (abs < 0.001) return value.toExponential(2);
                if (abs < 0.01) return value.toFixed(4);
                if (abs < 1) return value.toFixed(3);
                if (abs < 10) return value.toFixed(2);
                return value.toFixed(1);
            }
            if (control.integer) return String(Math.round(value));
            if (control.step >= 1) return value.toFixed(0);
            if (control.step >= 0.1) return value.toFixed(1);
            if (control.step >= 0.01) return value.toFixed(2);
            return value.toFixed(3);
        }

        function isPostFxControlVisible(control, values) {
            if (typeof control.visibleWhen !== 'function') return true;
            try {
                return control.visibleWhen(values) !== false;
            } catch (_) {
                return true;
            }
        }

        function setPostPanelVisible(visible) {
            deps.postPanelVisible = !!visible;
            const activeElement = document.activeElement;
            if (!deps.postPanelVisible && activeElement instanceof HTMLElement && deps.postPanel.contains(activeElement)) {
                deps.btnPostFxPanel.focus();
            }
            deps.postPanel.classList.toggle('visible', deps.postPanelVisible);
            deps.postPanel.toggleAttribute('inert', !deps.postPanelVisible);
            deps.postPanel.setAttribute('aria-hidden', String(!deps.postPanelVisible));
            syncPostFxPanel(true, { persist: false });
        }

        function buildPostFxPanel() {
            const cloneSectionKeys = new Set(['powershot']);
            const renderGeneratedPostFxControls = (section) => `
                    ${section.warn ? `<div class="fx-warn">${section.warn}</div>` : ''}
                    <div class="fx-grid">
                        ${section.controls.map(control => {
                            const inputId = `fx-${section.key}-${control.key}`;
                            const valueId = `fx-value-${section.key}-${control.key}`;

                            if (control.type === 'checkbox') {
                                return `
                                    <label class="fx-check" for="${inputId}" data-fx-control="${control.key}">
                                        <span>${control.label}</span>
                                        <input id="${inputId}" type="checkbox">
                                    </label>
                                `;
                            }

                            if (control.type === 'select') {
                                const options = (control.options || []).map((option) =>
                                    `<option value="${option.value}">${option.label}</option>`
                                ).join('');
                                return `
                                    <label class="fx-control" for="${inputId}" data-fx-control="${control.key}">
                                        <div class="fx-control-head">
                                            <span>${control.label}</span>
                                        </div>
                                        <select
                                            id="${inputId}"
                                            style="background:rgba(255,255,255,0.05);color:#aaa;border:1px solid rgba(255,255,255,0.08);border-radius:0;padding:3px 6px;font:10px 'Segoe UI',system-ui,sans-serif;width:100%;outline:none;cursor:pointer"
                                        >${options}</select>
                                    </label>
                                `;
                            }

                            const dynamicMode = postFxControlSliderMode(control);
                            const useDynamicSlider = dynamicMode !== 'linear';
                            const rangeMin = useDynamicSlider ? 0 : control.min;
                            const rangeMax = useDynamicSlider ? LOG_SLIDER_STEPS : control.max;
                            const rangeStep = useDynamicSlider ? 1 : control.step;
                            return `
                                <label class="fx-control" for="${inputId}" data-fx-control="${control.key}">
                                    <div class="fx-control-head">
                                        <span>${control.label}</span>
                                        <span class="fx-value" id="${valueId}"></span>
                                    </div>
                                    <input
                                        class="fx-range"
                                        id="${inputId}"
                                        type="range"
                                        min="${rangeMin}"
                                        max="${rangeMax}"
                                        step="${rangeStep}"
                                    >
                                </label>
                            `;
                        }).join('')}
                    </div>
                    <div class="fx-note" id="fx-note-${section.key}"></div>
            `;
            const renderGeneratedPostFxSection = (section) => `
                <section class="fx-section collapsed" data-fx-section="${section.key}">
                    <div class="fx-section-header">
                        <div class="fx-section-title">${section.title}</div>
                        <button class="fx-toggle" type="button" id="fx-toggle-${section.key}">Off</button>
                    </div>
                    ${renderGeneratedPostFxControls(section)}
                </section>
            `;
            const renderClonePostFxSubsection = (section) => `
                <div class="clone-subsection" data-fx-section="${section.key}" data-post-stack-only style="margin-top:8px;padding:6px 0 4px;border-top:1px solid rgba(255,255,255,0.08)">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                        <span style="font-size:11px;color:#ccc;font-weight:600;letter-spacing:0.3px">${section.title}</span>
                        <button class="fx-toggle" type="button" id="fx-toggle-${section.key}">Off</button>
                    </div>
                    ${renderGeneratedPostFxControls(section)}
                </div>
            `;
            const sectionsHtml = postFxSections
                .filter(section => !cloneSectionKeys.has(section.key))
                .map(renderGeneratedPostFxSection)
                .join('');
            const cloneSectionsHtml = postFxSections
                .filter(section => cloneSectionKeys.has(section.key))
                .map(renderClonePostFxSubsection)
                .join('');

            const tmOptions = Object.keys(deps.toneMappingModes).map(name =>
                `<option value="${name}" ${name === deps.currentToneMapping ? 'selected' : ''}>${name}</option>`
            ).join('');
            const fpsCapOptions = [
                { value: 0, label: 'Uncapped' },
                { value: 12, label: '12 FPS (stop-motion)' },
                { value: 24, label: '24 FPS (cinema)' },
                { value: 30, label: '30 FPS' },
                { value: 60, label: '60 FPS' },
                { value: 90, label: '90 FPS' },
                { value: 120, label: '120 FPS' },
                { value: 144, label: '144 FPS' },
                { value: 240, label: '240 FPS' },
            ].map(option =>
                `<option value="${option.value}" ${option.value === deps.performanceSettings.fpsCap ? 'selected' : ''}>${option.label}</option>`
            ).join('');

            deps.postPanel.innerHTML = `
                <div class="sidepanel-resize" id="panelResizeHandle"></div>
                <div class="sidepanel-header">
                    <div>
                        <div class="sidepanel-title">Post FX</div>
                        <div class="sidepanel-subtitle" id="postPanelStatus">${deps.rendererBackendLabel}</div>
                    </div>
                    <button id="btnPostPanelReset" type="button" style="border-color:rgba(200,80,80,0.3)">Reset</button>
                    <button id="btnPostPanelClose" type="button">Hide</button>
                </div>
                <div class="sidepanel-body">
                    <section class="fx-section collapsed" data-keep-on-shader-lab>
                        <div class="fx-section-header">
                            <div class="fx-section-title">Tone Mapping</div>
                        </div>
                        <div class="fx-grid">
                            <select id="fx-tonemapping-mode" style="background:rgba(255,255,255,0.05);color:#aaa;border:1px solid rgba(255,255,255,0.08);border-radius:0;padding:3px 6px;font:10px 'Segoe UI',system-ui,sans-serif;width:100%;outline:none;cursor:pointer">
                                ${tmOptions}
                            </select>
                            <label class="fx-control" for="fx-tonemapping-exp">
                                <div class="fx-control-head">
                                    <span>Exposure</span>
                                    <span class="fx-value" id="fx-tonemapping-exp-val">${formatExposureEvLabel(deps.currentExposure)}</span>
                                </div>
                                <input class="fx-range" id="fx-tonemapping-exp" type="range" min="0" max="${LOG_SLIDER_STEPS}" step="1" value="${exposureLinearToSliderInput(deps.currentExposure)}">
                            </label>
                            <label class="fx-control" for="fx-tonemapping-brightness">
                                <div class="fx-control-head">
                                    <span>Brightness</span>
                                    <span class="fx-value" id="fx-tonemapping-brightness-val">0.00</span>
                                </div>
                                <input class="fx-range" id="fx-tonemapping-brightness" type="range" min="-1" max="1" step="0.01" value="0">
                            </label>
                            <label class="fx-control" for="fx-tonemapping-contrast">
                                <div class="fx-control-head">
                                    <span>Contrast</span>
                                    <span class="fx-value" id="fx-tonemapping-contrast-val">0.00</span>
                                </div>
                                <input class="fx-range" id="fx-tonemapping-contrast" type="range" min="-1" max="1" step="0.01" value="0">
                            </label>
                        </div>
                    </section>
                    <section class="fx-section collapsed">
                        <div class="fx-section-header">
                            <div class="fx-section-title">Anti-Aliasing</div>
                        </div>
                        <div class="fx-warn">NOTICE: Changing parameters while active can cause temporary flickering.</div>
                        <div class="fx-grid">
                            <select id="fx-aa-mode" style="background:rgba(255,255,255,0.05);color:#aaa;border:1px solid rgba(255,255,255,0.08);border-radius:0;padding:3px 6px;font:10px 'Segoe UI',system-ui,sans-serif;width:100%;outline:none;cursor:pointer">
                                <option value="traa"${deps.maxjsFx.isTRAAEnabled() ? ' selected' : ''}>TRAA</option>
                                <option value="off"${!deps.maxjsFx.isTRAAEnabled() ? ' selected' : ''}>Off</option>
                            </select>
                        </div>
                        <div class="fx-note">TRAA: temporal reprojection (WebGPU only). Off: no anti-aliasing.</div>
                    </section>
                    <section class="fx-section collapsed" data-keep-on-shader-lab>
                        <div class="fx-section-header">
                            <div class="fx-section-title">Performance</div>
                        </div>
                        <div class="fx-grid">
                            <label class="fx-control" for="fx-performance-fpscap">
                                <div class="fx-control-head">
                                    <span>FPS Cap</span>
                                </div>
                                <select id="fx-performance-fpscap" style="background:rgba(255,255,255,0.05);color:#aaa;border:1px solid rgba(255,255,255,0.08);border-radius:0;padding:3px 6px;font:10px 'Segoe UI',system-ui,sans-serif;width:100%;outline:none;cursor:pointer">
                                    ${fpsCapOptions}
                                </select>
                            </label>
                            <label class="fx-control" for="fx-performance-renderscale">
                                <div class="fx-control-head">
                                    <span>Render Scale</span>
                                    <span class="fx-value" id="fx-performance-renderscale-val">${deps.performanceSettings.renderScale.toFixed(2)}x</span>
                                </div>
                                <input class="fx-range" id="fx-performance-renderscale" type="range" min="0.25" max="1" step="0.05" value="${deps.performanceSettings.renderScale}">
                            </label>
                            <label class="fx-control" for="fx-performance-postfxscale">
                                <div class="fx-control-head">
                                    <span>Post FX Scale</span>
                                    <span class="fx-value" id="fx-performance-postfxscale-val">${deps.getEffectivePostFxResolutionScale().toFixed(2)}x</span>
                                </div>
                                <input class="fx-range" id="fx-performance-postfxscale" type="range" min="0.25" max="1" step="0.05" value="${deps.getEffectivePostFxResolutionScale()}">
                            </label>
                            <label class="fx-check" for="fx-performance-optimizeinstances">
                                <span>Optimize Max Instances</span>
                                <input id="fx-performance-optimizeinstances" type="checkbox" ${deps.performanceSettings.optimizeMaxInstances ? 'checked' : ''}>
                            </label>
                            <label class="fx-check" for="fx-performance-flattengroups">
                                <span>Flatten Groups</span>
                                <input id="fx-performance-flattengroups" type="checkbox" ${deps.performanceSettings.flattenGroups ? 'checked' : ''}>
                            </label>
                            <label class="fx-check" for="fx-performance-splats">
                                <span>Gaussian splats (Spark)</span>
                                <input id="fx-performance-splats" type="checkbox" ${deps.performanceSettings.splatsEnabled !== false ? 'checked' : ''}>
                            </label>
                            <label class="fx-control" for="fx-performance-instancethreshold">
                                <div class="fx-control-head">
                                    <span>Instance Bucket Threshold</span>
                                    <span class="fx-value" id="fx-performance-instancethreshold-val">${deps.performanceSettings.maxInstanceBucketThreshold}</span>
                                </div>
                                <input class="fx-range" id="fx-performance-instancethreshold" type="range" min="2" max="500" step="1" value="${deps.performanceSettings.maxInstanceBucketThreshold}">
                            </label>
                        </div>
                        <div class="fx-note" id="fx-performance-note">Caps viewer frame rate and scales renderer/post-FX resolution to reduce GPU load. Splats off skips Spark. Headset sessions stay uncapped.</div>
                    </section>
                    <section class="fx-section collapsed" data-keep-on-shader-lab>
                        <div class="fx-section-header">
                            <div class="fx-section-title">Camera Clipping</div>
                        </div>
                        <div class="fx-grid">
                            <label class="fx-control" for="fx-camera-near">
                                <div class="fx-control-head">
                                    <span>Near plane</span>
                                    <span class="fx-value" id="fx-camera-near-val">auto (${deps.camera.near.toFixed(3)})</span>
                                </div>
                                <input class="fx-number" id="fx-camera-near" type="number" min="0" step="0.01" placeholder="auto" value="${deps.cameraClip.near ?? ''}">
                            </label>
                            <label class="fx-control" for="fx-camera-far">
                                <div class="fx-control-head">
                                    <span>Far plane</span>
                                    <span class="fx-value" id="fx-camera-far-val">auto (${deps.camera.far.toFixed(0)})</span>
                                </div>
                                <input class="fx-number" id="fx-camera-far" type="number" min="0" step="1" placeholder="auto" value="${deps.cameraClip.far ?? ''}">
                            </label>
                        </div>
                        <div class="fx-note">Leave empty for auto-fit. Raise Near (e.g. 1–10) on large scenes to eliminate distant-geometry z-fighting by reclaiming depth buffer precision.</div>
                    </section>
                    <section class="fx-section collapsed" data-fx-section="hdri" data-keep-on-shader-lab>
                        <div class="fx-section-header">
                            <div class="fx-section-title">HDRI</div>
                            <div style="display:flex;gap:3px">
                                <button class="fx-toggle" id="fx-hdri-toggle" type="button">Off</button>
                                <button id="fx-hdri-load" type="button">Load</button>
                                <button id="fx-hdri-clear" type="button" style="border-color:#663030">Clear</button>
                            </div>
                            <input type="file" id="fx-hdri-file" style="display:none">
                        </div>
                        <div id="fx-hdri-name" style="font-size:9px;color:#777;padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">No HDRI loaded</div>
                        <div class="fx-grid">
                            <label class="fx-control" for="fx-hdri-intensity">
                                <div class="fx-control-head"><span>Intensity</span><span class="fx-value" id="fx-hdri-intensity-val">1.0</span></div>
                                <input class="fx-range" id="fx-hdri-intensity" type="range" min="0" max="5" step="0.05" value="1">
                            </label>
                            <label class="fx-control" for="fx-hdri-rotation">
                                <div class="fx-control-head"><span>Rotation</span><span class="fx-value" id="fx-hdri-rotation-val">0</span></div>
                                <input class="fx-range" id="fx-hdri-rotation" type="range" min="0" max="360" step="1" value="0">
                            </label>
                            <label class="fx-control" for="fx-hdri-blur">
                                <div class="fx-control-head"><span>BG Blur</span><span class="fx-value" id="fx-hdri-blur-val">0.0</span></div>
                                <input class="fx-range" id="fx-hdri-blur" type="range" min="0" max="1" step="0.01" value="0">
                            </label>
                            <label class="fx-check" for="fx-hdri-flip">
                                <span>Flip</span>
                                <input id="fx-hdri-flip" type="checkbox">
                            </label>
                            <label class="fx-check" for="fx-hdri-reflection-only" title="Native WebGPU only: keep HDRI reflections, mute HDRI diffuse lighting.">
                                <span>Reflection only (WebGPU)</span>
                                <input id="fx-hdri-reflection-only" type="checkbox">
                            </label>
                        </div>
                    </section>
                    <section class="fx-section collapsed" data-fx-section="halogi" data-keep-on-shader-lab>
                        <div class="fx-section-header">
                            <div class="fx-section-title">Global Illumination</div>
                            <div style="display:flex;align-items:center;gap:6px">
                                <button class="fx-toggle" id="fx-gi-reset" type="button">Reset</button>
                                <button class="fx-toggle" id="fx-gi-toggle" type="button">Off</button>
                            </div>
                        </div>
                        <div class="fx-note" style="margin:0;padding:2px 0;color:#666;font-size:9px">BVH-traced indirect bounce (HALO-GI). WebGPU, any render mode.</div>
                        <div class="fx-grid">
                            ${deps.HALO_GI_NUMERIC_CONTROLS.map(control => `
                            <label class="fx-control" for="fx-gi-${control.key}">
                                <div class="fx-control-head"><span>${control.label}</span><span class="fx-value" id="fx-gi-${control.key}-val">${deps.formatHaloGiValue(control.key)}</span></div>
                                <input class="fx-range" id="fx-gi-${control.key}" type="range" min="${control.min}" max="${control.max}" step="${control.step}" value="${deps.getHaloGiSettings()[control.key]}">
                            </label>`).join('')}
                            <label class="fx-control" for="fx-gi-cascades">
                                <div class="fx-control-head"><span>Cascades</span></div>
                                <select id="fx-gi-cascades" style="background:rgba(255,255,255,0.05);color:#aaa;border:1px solid rgba(255,255,255,0.08);border-radius:0;padding:3px 6px;font:10px 'Segoe UI',system-ui,sans-serif;width:100%;outline:none;cursor:pointer">
                                    <option value="1" ${deps.getHaloGiSettings().cascades === 1 ? 'selected' : ''}>Single grid</option>
                                    <option value="2" ${deps.getHaloGiSettings().cascades === 2 ? 'selected' : ''}>Cascaded (2)</option>
                                </select>
                            </label>
                            <label class="fx-check" for="fx-gi-continuous"><span>Continuous solve</span><input id="fx-gi-continuous" type="checkbox" ${deps.getHaloGiSettings().continuous ? 'checked' : ''}></label>
                            <label class="fx-check" for="fx-gi-hyst-norm"><span>Normalize hysteresis</span><input id="fx-gi-hyst-norm" type="checkbox" ${deps.getHaloGiSettings().hysteresisNormalize ? 'checked' : ''}></label>
                            <label class="fx-check" for="fx-gi-show-probes" title="Diagnostics: show the probe field as a grid of spheres in the viewport."><span>Show probes</span><input id="fx-gi-show-probes" type="checkbox" ${deps.getHaloGiSettings().showProbes ? 'checked' : ''}></label>
                        </div>
                    </section>
                    ${sectionsHtml}
                    <section class="fx-section collapsed" data-fx-section="clone" data-keep-on-shader-lab>
                        <div class="fx-section-header">
                            <div class="fx-section-title">Clone</div>
                        </div>
                        <div class="fx-note" style="margin:0;padding:2px 0;color:#666;font-size:9px">Custom fun effects that are designed by me.</div>

                        <div class="clone-subsection" data-requires-threejs-backend style="margin-top:8px;padding:6px 0 4px;border-top:1px solid rgba(255,255,255,0.08)">
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                                <span style="font-size:11px;color:#ccc;font-weight:600;letter-spacing:0.3px">Blob Tracker</span>
                                <button class="fx-toggle" type="button" id="fx-toggle-clone">Off</button>
                            </div>
                            <div class="fx-grid">
                                <label class="fx-control" for="fx-clone-source">
                                    <div class="fx-control-head"><span>Source</span></div>
                                    <select id="fx-clone-source" style="background:rgba(255,255,255,0.05);color:#aaa;border:1px solid rgba(255,255,255,0.08);border-radius:0;padding:3px 6px;font:10px 'Segoe UI',system-ui,sans-serif;width:100%;outline:none;cursor:pointer">
                                        <option value="luma" selected>Luminance</option>
                                        <option value="depth">Depth</option>
                                    </select>
                                </label>
                                <label class="fx-control" for="fx-clone-threshold">
                                    <div class="fx-control-head"><span>Threshold</span><span class="fx-value" id="fx-clone-threshold-val">0.53</span></div>
                                    <input class="fx-range" id="fx-clone-threshold" type="range" min="0" max="1" step="0.005" value="0.53">
                                </label>
                                <label class="fx-control" for="fx-clone-blurRadius">
                                    <div class="fx-control-head"><span>Merge Radius</span><span class="fx-value" id="fx-clone-blurRadius-val">0.0</span></div>
                                    <input class="fx-range" id="fx-clone-blurRadius" type="range" min="0" max="16" step="0.1" value="0">
                                </label>
                                <label class="fx-control" for="fx-clone-minBlobSize">
                                    <div class="fx-control-head"><span>Min Blob Size</span><span class="fx-value" id="fx-clone-minBlobSize-val">0.00</span></div>
                                    <input class="fx-range" id="fx-clone-minBlobSize" type="range" min="0" max="0.5" step="0.001" value="0">
                                </label>
                                <label class="fx-control" for="fx-clone-gridDensity">
                                    <div class="fx-control-head"><span>Grid Density</span><span class="fx-value" id="fx-clone-gridDensity-val">0</span></div>
                                    <input class="fx-range" id="fx-clone-gridDensity" type="range" min="0" max="8" step="1" value="0">
                                </label>
                                <label class="fx-control" for="fx-clone-smoothing">
                                    <div class="fx-control-head"><span>Smoothing</span><span class="fx-value" id="fx-clone-smoothing-val">0.75</span></div>
                                    <input class="fx-range" id="fx-clone-smoothing" type="range" min="0.01" max="1" step="0.01" value="0.75">
                                </label>
                                <label class="fx-control" for="fx-clone-opacity">
                                    <div class="fx-control-head"><span>Opacity</span><span class="fx-value" id="fx-clone-opacity-val">1.00</span></div>
                                    <input class="fx-range" id="fx-clone-opacity" type="range" min="0" max="1" step="0.005" value="1">
                                </label>
                                <label class="fx-check" for="fx-clone-invert"><span>Invert</span><input id="fx-clone-invert" type="checkbox"></label>
                            </div>
                        </div>

                        <div class="clone-subsection" data-post-stack-only style="margin-top:8px;padding:6px 0 4px;border-top:1px solid rgba(255,255,255,0.08)">
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                                <span style="font-size:11px;color:#ccc;font-weight:600;letter-spacing:0.3px">Playstation Wobble</span>
                                <button class="fx-toggle" type="button" id="fx-toggle-wobble">Off</button>
                            </div>
                            <div class="fx-grid" style="margin-top:6px">
                                <label class="fx-control" for="fx-clone-snapGrid">
                                    <div class="fx-control-head"><span>Snap Grid</span><span class="fx-value" id="fx-clone-snapGrid-val">5.0</span></div>
                                    <input class="fx-range" id="fx-clone-snapGrid" type="range" min="1" max="20" step="0.5" value="5">
                                </label>
                            </div>
                            <div class="fx-note" style="margin-top:2px">Combine it with Pixel or Retro.</div>
                        </div>
                        ${cloneSectionsHtml}
                    </section>
                    <section class="fx-section collapsed" data-fx-section="ascii">
                        <div class="fx-section-header">
                            <div class="fx-section-title">ASCII</div>
                            <button class="fx-toggle" type="button" id="fx-toggle-ascii">Off</button>
                        </div>
                        <div class="fx-grid">
                            <label class="fx-control" for="fx-clone-ascii-resolution">
                                <div class="fx-control-head"><span>Resolution</span><span class="fx-value" id="fx-clone-ascii-resolution-val">0.15</span></div>
                                <input class="fx-range" id="fx-clone-ascii-resolution" type="range" min="0.05" max="0.5" step="0.01" value="0.15">
                            </label>
                            <label class="fx-control" for="fx-clone-ascii-color">
                                <div class="fx-control-head"><span>Color</span></div>
                                <select id="fx-clone-ascii-color" style="background:rgba(255,255,255,0.05);color:#aaa;border:1px solid rgba(255,255,255,0.08);border-radius:0;padding:3px 6px;font:10px 'Segoe UI',system-ui,sans-serif;width:100%;outline:none;cursor:pointer">
                                    <option value="white" selected>White</option>
                                    <option value="green">Green</option>
                                    <option value="amber">Amber</option>
                                </select>
                            </label>
                            <label class="fx-check" for="fx-clone-ascii-invert"><span>Invert</span><input id="fx-clone-ascii-invert" type="checkbox"></label>
                        </div>
                        <div class="fx-note">Full takeover — disables all other post-FX.</div>
                    </section>
                </div>
            `;

            document.getElementById('btnPostPanelClose').onclick = () => setPostPanelVisible(false);

            // Collapsible sections — click header to toggle
            for (const header of deps.postPanel.querySelectorAll('.fx-section-header')) {
                header.addEventListener('click', (e) => {
                    // Don't collapse when clicking buttons/inputs inside the header
                    if (e.target.closest('button, input, select')) return;
                    header.closest('.fx-section')?.classList.toggle('collapsed');
                });
            }

            document.getElementById('btnPostPanelReset').onclick = () => {
                // Reset all FX values to defaults then disable
                // Does NOT touch HDRI or clay mode
                const defaults = {
                    ssgi: { radius: 8, thickness: 1.5, aoIntensity: 1.0, giIntensity: 1.5, expFactor: 1.5, sliceCount: 2, stepCount: 8, temporal: false },
                    ssr: { quality: 0.45, blurQuality: 2, maxDistance: 0.5, opacity: 0.9, thickness: 0.015 },
                    gtao: { samples: 16, distanceExponent: 1.0, distanceFallOff: 1.0, radius: 0.5, scale: 2.0, thickness: 1.0, resolutionScale: 1.0 },
                    bloom: { strength: 0.4, radius: 0.2, threshold: 0.75 },
                    toonOutline: { thickness: 0.003, alpha: 1.0 },
                    motionBlur: { amount: 1.0, samples: 16 },
                    traa: { useSubpixelCorrection: true, depthThreshold: 0.0005, edgeDepthDiff: 0.001, maxVelocityLength: 128 },
                    contactShadow: { maxDistance: 0.1, thickness: 0.006, shadowIntensity: 0.85, quality: 0.3, temporal: false },
                    retro: { wiggle: false, affineDistortion: 5.0, resolutionScale: 0.25, filterTextures: false, dither: false, colorDepth: 32, scanlines: false, scanlineIntensity: 0.3, scanlineDensity: 1.0, crt: false, vignetteIntensity: 0.3, bleeding: 0.001, curvature: 0.02 },
                    volumetric: { intensity: 1.0, steps: 12, density: 0.5, denoise: 0.6, resolution: 0.25 },
                    pixel: { pixelate: false, pixelSize: 4, chromatic: false, chromaticIntensity: 0.005, sharpen: false, sharpenStrength: 0.5, grain: false, grainIntensity: 0.08, brightness: 0, contrast: 0, saturation: 0 },
                    powershot: { mode: 'digital', preset: 'powershot', amount: 1.0, resolutionScale: 0.75, lensSoftness: 0.32, ccdBloom: 0.35, noiseScale: 1.06, bayerNR: 0.5, chromaNR: 1.0, jpegStrength: 0.2, jpegQuality: 60, jpegChroma420: 0.75, jpegMidtone: 0.45, jpegHighlight: 1.0, brightness: 0, contrast: 0, analogStrength: 0.72, analogTracking: 0.46, analogChromaBleed: 0.76, analogRinging: 0.62, analogTapeNoise: 0.70, analogBandMask: 0.35, analogEdgeWave: 0.34, analogDropouts: 0.32, analogScanlines: 0.54, analogHeadSwitch: 0.42, freezeNoise: false },
                    fog: { type: 0, opacity: 1.0, near: 10, far: 500, density: 0.01, noiseScale: 0.005, noiseSpeed: 0.2, height: 20 },
                };
                if (clayModeActive) {
                    // Clay owns the live FX state — reset the snapshot so exit restores to defaults
                    clayPreFxSnapshot = { ssgi: false, ssr: false, gtao: false, bloom: false,
                        toonOutline: false, motionBlur: false, traa: false, contactShadow: false,
                        retro: false, volumetric: false, pixel: false, powershot: false, fog: false, clone: false };
                    // Still push default values so they're ready when clay exits
                    for (const section of postFxSections) {
                        if (defaults[section.key]) section.setValues(defaults[section.key]);
                    }
                } else {
                    for (const section of postFxSections) {
                        section.setEnabled(false);
                        if (defaults[section.key]) section.setValues(defaults[section.key]);
                    }
                }
                deps.currentToneMapping = deps.DEFAULT_TONE_MAPPING;
                deps.currentExposure = 1.0;
                deps.currentAAMode = 'off';
                deps.maxjsFx.setTRAAEnabled(false);
                deps.maxjsFx.setCloneEnabled(false);
                deps.maxjsFx.setCloneOptions({ threshold: 0.53, blurRadius: 0, minBlobSize: 0, opacity: 1.0, gridDensity: 0, smoothing: 0.75, invert: false, source: 'luma' });
                deps.maxjsFx.setColorGrading({ brightness: 0, contrast: 0 });
                if (deps.asciiActive) deps.exitAsciiMode();
                deps.asciiSettings = { resolution: 0.15, color: 'white', invert: false };
                deps.performanceSettings = { ...deps.PERFORMANCE_DEFAULTS };
                deps.cameraClip.near = null;
                deps.cameraClip.far = null;
                {
                    const bounds = deps.computeVisibleSceneBounds(new THREE.Box3());
                    if (!bounds.isEmpty()) {
                        const size = bounds.getSize(new THREE.Vector3());
                        const maxDim = Math.max(size.x, size.y, size.z);
                        deps.camera.near = Math.max(deps.DEFAULT_CAMERA_NEAR, maxDim * 0.001);
                        deps.camera.far = Math.max(1000, maxDim * 100);
                        deps.applyCameraClipOverrides(deps.camera);
                    }
                }
                deps.applyRendererPerformanceSettings({ resizePostFx: true });
                applyCoreToneMappingState();
                try { localStorage.removeItem(POSTFX_STORAGE_KEY); localStorage.removeItem('maxjs_panel_width'); } catch {}
                deps.postPanel.style.width = '';
                deps.setRightDockWidth(240);
                buildPostFxPanel();
                syncPostFxPanel(true);
            };

            // Panel horizontal resize
            const resizeHandle = document.getElementById('panelResizeHandle');
            let resizing = false;
            resizeHandle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                resizing = true;
                resizeHandle.classList.add('active');
                const startX = e.clientX;
                const startW = deps.rightDock?.offsetWidth || deps.postPanel.offsetWidth;
                const onMove = (ev) => {
                    const dx = startX - ev.clientX;
                    deps.setRightDockWidth(startW + dx);
                    deps.postPanel.style.width = '';
                };
                const onUp = () => {
                    resizing = false;
                    resizeHandle.classList.remove('active');
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    const dockWidth = deps.rightDock?.offsetWidth || deps.postPanel.offsetWidth;
                    try { localStorage.setItem('maxjs_panel_width', `${deps.clampDockWidth(dockWidth)}px`); } catch {}
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            try {
                const savedW = localStorage.getItem('maxjs_panel_width');
                if (savedW) deps.setRightDockWidth(savedW);
                deps.postPanel.style.width = '';
            } catch {}

            // Tone mapping controls
            document.getElementById('fx-tonemapping-mode').onchange = (e) => {
                deps.currentToneMapping = e.target.value;
                applyCoreToneMappingState();
                savePostFxState();
            };
            const expSlider = document.getElementById('fx-tonemapping-exp');
            const expLabel = document.getElementById('fx-tonemapping-exp-val');
            expSlider.oninput = () => {
                deps.currentExposure = exposureSliderInputToLinear(expSlider.value);
                applyCoreToneMappingState();
                expLabel.textContent = formatExposureEvLabel(deps.currentExposure);
            };
            expSlider.onchange = () => savePostFxState();

            // Brightness / Contrast (global color grading, runs independently of Pixel FX)
            const brightnessSlider = document.getElementById('fx-tonemapping-brightness');
            const brightnessLabel = document.getElementById('fx-tonemapping-brightness-val');
            const contrastSlider = document.getElementById('fx-tonemapping-contrast');
            const contrastLabel = document.getElementById('fx-tonemapping-contrast-val');
            const usePowerShotColorGrading = () => deps.maxjsFx.isPowerShotEnabled?.() === true;
            brightnessSlider.oninput = (e) => {
                const v = parseFloat(e.target.value);
                if (usePowerShotColorGrading()) {
                    deps.maxjsFx.setPowerShotOptions({ brightness: v });
                } else {
                    deps.maxjsFx.setColorGrading({ brightness: v });
                }
                brightnessLabel.textContent = v.toFixed(2);
            };
            brightnessSlider.onchange = () => savePostFxState();
            contrastSlider.oninput = (e) => {
                const v = parseFloat(e.target.value);
                if (usePowerShotColorGrading()) {
                    deps.maxjsFx.setPowerShotOptions({ contrast: v });
                } else {
                    deps.maxjsFx.setColorGrading({ contrast: v });
                }
                contrastLabel.textContent = v.toFixed(2);
            };
            contrastSlider.onchange = () => savePostFxState();

            // Anti-Aliasing mode
            const aaSelect = document.getElementById('fx-aa-mode');
            aaSelect.onchange = (e) => {
                const mode = e.target.value;
                deps.maxjsFx.setTRAAEnabled(mode === 'traa');
                deps.currentAAMode = mode;
                savePostFxState();
                syncPostFxPanel(true);
            };

            const fpsCapSelect = document.getElementById('fx-performance-fpscap');
            const renderScaleSlider = document.getElementById('fx-performance-renderscale');
            const renderScaleValue = document.getElementById('fx-performance-renderscale-val');
            const postFxScaleSlider = document.getElementById('fx-performance-postfxscale');
            const postFxScaleValue = document.getElementById('fx-performance-postfxscale-val');
            const optimizeInstancesCheck = document.getElementById('fx-performance-optimizeinstances');
            const flattenGroupsCheck = document.getElementById('fx-performance-flattengroups');
            const splatsEnabledCheck = document.getElementById('fx-performance-splats');
            const instanceThresholdSlider = document.getElementById('fx-performance-instancethreshold');
            const instanceThresholdValue = document.getElementById('fx-performance-instancethreshold-val');
            fpsCapSelect.onchange = (e) => {
                deps.performanceSettings.fpsCap = Number(e.target.value) || 0;
                deps.lastRenderTimestamp = 0;
                savePostFxState();
                syncPostFxPanel(true);
            };
            renderScaleSlider.oninput = (e) => {
                const scale = Math.max(0.25, Math.min(1.0, Number(e.target.value) || 1.0));
                renderScaleValue.textContent = `${scale.toFixed(2)}x`;
            };
            renderScaleSlider.onchange = (e) => {
                deps.performanceSettings.renderScale = Math.max(0.25, Math.min(1.0, Number(e.target.value) || 1.0));
                deps.applyRendererPerformanceSettings({ resizePostFx: true });
                savePostFxState();
            };
            postFxScaleSlider.oninput = (e) => {
                const scale = Math.max(0.25, Math.min(1.0, Number(e.target.value) || 1.0));
                postFxScaleValue.textContent = `${scale.toFixed(2)}x`;
            };
            postFxScaleSlider.onchange = (e) => {
                deps.performanceSettings.postFxScale = Math.max(0.25, Math.min(1.0, Number(e.target.value) || 1.0));
                deps.applyRendererPerformanceSettings({ resizePostFx: true });
                savePostFxState();
            };
            optimizeInstancesCheck.onchange = () => {
                deps.performanceSettings.optimizeMaxInstances = optimizeInstancesCheck.checked;
                deps.disposeMaxInstanceBuckets();
                savePostFxState();
                syncPostFxPanel(true);
            };
            if (flattenGroupsCheck) {
                flattenGroupsCheck.onchange = () => {
                    deps.performanceSettings.flattenGroups = flattenGroupsCheck.checked;
                    deps.disposeFlattenedGroups();
                    savePostFxState();
                    syncPostFxPanel(true);
                    // Merging needs a fresh full snapshot to (re)plan clusters.
                    if (deps.performanceSettings.flattenGroups) deps.bridge.send('scene_dirty');
                };
            }
            if (splatsEnabledCheck) {
                splatsEnabledCheck.onchange = () => {
                    deps.performanceSettings.splatsEnabled = splatsEnabledCheck.checked;
                    if (!deps.performanceSettings.splatsEnabled) {
                        deps.splatsSystem.resetMutationQueue();
                        void deps.shutdownSplatViewer().then(() => {
                            savePostFxState();
                            syncPostFxPanel(true);
                        });
                    } else {
                        savePostFxState();
                        syncPostFxPanel(true);
                        deps.bridge.send('scene_dirty');
                    }
                };
            }
            instanceThresholdSlider.oninput = (e) => {
                instanceThresholdValue.textContent = String(Math.max(2, Math.round(Number(e.target.value) || 50)));
            };
            instanceThresholdSlider.onchange = (e) => {
                deps.performanceSettings.maxInstanceBucketThreshold = Math.max(2, Math.round(Number(e.target.value) || 50));
                deps.disposeMaxInstanceBuckets();
                savePostFxState();
            };

            // Camera clipping controls
            const cameraNearInput = document.getElementById('fx-camera-near');
            const cameraNearValue = document.getElementById('fx-camera-near-val');
            const cameraFarInput = document.getElementById('fx-camera-far');
            const cameraFarValue = document.getElementById('fx-camera-far-val');
            function commitCameraClip() {
                const nearRaw = parseFloat(cameraNearInput.value);
                const farRaw = parseFloat(cameraFarInput.value);
                deps.cameraClip.near = Number.isFinite(nearRaw) && nearRaw > 0 ? nearRaw : null;
                deps.cameraClip.far = Number.isFinite(farRaw) && farRaw > 0 ? farRaw : null;
                deps.applyCameraClipOverrides(deps.camera);
                cameraNearValue.textContent = deps.cameraClip.near != null
                    ? `${deps.camera.near.toFixed(3)}`
                    : `auto (${deps.camera.near.toFixed(3)})`;
                cameraFarValue.textContent = deps.cameraClip.far != null
                    ? `${deps.camera.far.toFixed(0)}`
                    : `auto (${deps.camera.far.toFixed(0)})`;
                deps.maxjsFx.markSceneChanged?.();
                savePostFxState();
            }
            function previewCameraClip() {
                const nearRaw = parseFloat(cameraNearInput.value);
                const farRaw = parseFloat(cameraFarInput.value);
                cameraNearValue.textContent = Number.isFinite(nearRaw) && nearRaw > 0
                    ? nearRaw.toFixed(3)
                    : `auto (${deps.camera.near.toFixed(3)})`;
                cameraFarValue.textContent = Number.isFinite(farRaw) && farRaw > 0
                    ? farRaw.toFixed(0)
                    : `auto (${deps.camera.far.toFixed(0)})`;
            }
            cameraNearInput.oninput = previewCameraClip;
            cameraFarInput.oninput = previewCameraClip;
            cameraNearInput.onchange = () => { commitCameraClip(); savePostFxState(); };
            cameraFarInput.onchange = () => { commitCameraClip(); savePostFxState(); };

            // HDRI Environment controls
            const hdriFileInput = document.getElementById('fx-hdri-file');
            document.getElementById('fx-hdri-toggle').onclick = () => deps.toggleLocalHDRI(!deps.localHdriEnabled);
            document.getElementById('fx-hdri-load').onclick = () => hdriFileInput.click();
            document.getElementById('fx-hdri-clear').onclick = () => deps.clearLocalHDRI();
            hdriFileInput.onchange = (e) => {
                const file = e.target.files?.[0];
                if (file) deps.loadLocalHDRIFile(file);
                hdriFileInput.value = '';
            };
            const hdriRotSlider = document.getElementById('fx-hdri-rotation');
            const hdriRotVal = document.getElementById('fx-hdri-rotation-val');
            hdriRotSlider.oninput = (e) => {
                deps.localHdriRotation = parseFloat(e.target.value);
                hdriRotVal.textContent = String(Math.round(deps.localHdriRotation));
                deps.applyLocalHDRISettings();
            };
            hdriRotSlider.onchange = () => savePostFxState();
            const hdriIntSlider = document.getElementById('fx-hdri-intensity');
            const hdriIntVal = document.getElementById('fx-hdri-intensity-val');
            hdriIntSlider.oninput = (e) => {
                deps.localHdriIntensity = parseFloat(e.target.value);
                hdriIntVal.textContent = deps.localHdriIntensity.toFixed(2);
                deps.applyLocalHDRISettings();
            };
            hdriIntSlider.onchange = () => savePostFxState();
            const hdriBlurSlider = document.getElementById('fx-hdri-blur');
            const hdriBlurVal = document.getElementById('fx-hdri-blur-val');
            hdriBlurSlider.oninput = (e) => {
                deps.localHdriBlur = parseFloat(e.target.value);
                hdriBlurVal.textContent = deps.localHdriBlur.toFixed(2);
                deps.applyLocalHDRISettings();
            };
            hdriBlurSlider.onchange = () => savePostFxState();
            const hdriFlipCheck = document.getElementById('fx-hdri-flip');
            hdriFlipCheck.onchange = () => {
                deps.localHdriFlip = hdriFlipCheck.checked;
                deps.applyLocalHDRISettings();
                savePostFxState();
            };
            const hdriReflectionOnlyCheck = document.getElementById('fx-hdri-reflection-only');
            hdriReflectionOnlyCheck.onchange = () => {
                deps.localHdriReflectionOnly = hdriReflectionOnlyCheck.checked;
                deps.applyHdriReflectionOnlyState({ markOutput: true });
                savePostFxState();
                deps.syncHdriPanel();
            };
            // Sync initial state
            hdriRotSlider.value = deps.localHdriRotation;
            hdriRotVal.textContent = Math.round(deps.localHdriRotation);
            hdriIntSlider.value = deps.localHdriIntensity;
            hdriIntVal.textContent = deps.localHdriIntensity.toFixed(2);
            hdriBlurSlider.value = deps.localHdriBlur;
            hdriBlurVal.textContent = deps.localHdriBlur.toFixed(2);
            hdriFlipCheck.checked = deps.localHdriFlip;
            hdriReflectionOnlyCheck.checked = deps.localHdriReflectionOnly;
            deps.syncHdriPanel();

            // HALO-GI controls (window.maxjsHaloGI exists only in Studio + WebGPU)
            {
                const giToggle = document.getElementById('fx-gi-toggle');
                const giReset = document.getElementById('fx-gi-reset');
                const giCascades = document.getElementById('fx-gi-cascades');
                const giContinuous = document.getElementById('fx-gi-continuous');
                const giHystNorm = document.getElementById('fx-gi-hyst-norm');
                const giShowProbes = document.getElementById('fx-gi-show-probes');
                const canSyncGiInput = (input) => !!input && document.activeElement !== input;
                const syncGiPanel = () => {
                    const gi = window.maxjsHaloGI;
                    const giSettings = deps.getHaloGiSettings();
                    const on = !!(gi && gi.isOn && gi.isOn());
                    if (giToggle) {
                        giToggle.textContent = gi ? (on ? 'On' : 'Off') : 'N/A';
                        giToggle.classList.toggle('active', on);
                        giToggle.disabled = !gi;
                    }
                    if (giReset) giReset.disabled = !gi;
                    for (const control of deps.HALO_GI_NUMERIC_CONTROLS) {
                        const input = document.getElementById(`fx-gi-${control.key}`);
                        const val = document.getElementById(`fx-gi-${control.key}-val`);
                        const value = giSettings[control.key];
                        if (input) {
                            input.disabled = !gi;
                            if (canSyncGiInput(input)) input.value = String(value);
                        }
                        if (val) val.textContent = deps.formatHaloGiValue(control.key, value);
                    }
                    if (giCascades) {
                        giCascades.disabled = !gi;
                        if (canSyncGiInput(giCascades)) giCascades.value = String(giSettings.cascades);
                    }
                    if (giContinuous) {
                        giContinuous.disabled = !gi;
                        if (canSyncGiInput(giContinuous)) giContinuous.checked = !!giSettings.continuous;
                    }
                    if (giHystNorm) {
                        giHystNorm.disabled = !gi;
                        if (canSyncGiInput(giHystNorm)) giHystNorm.checked = !!giSettings.hysteresisNormalize;
                    }
                    if (giShowProbes) {
                        giShowProbes.disabled = !gi;
                        if (canSyncGiInput(giShowProbes)) giShowProbes.checked = !!giSettings.showProbes;
                    }
                };
                window.__maxjsSyncGiPanel = syncGiPanel;
                if (giReset) giReset.onclick = () => deps.resetHaloGiToDefaults({ persist: true });
                if (giToggle) giToggle.onclick = () => {
                    const gi = window.maxjsHaloGI;
                    if (!gi) return;
                    deps.setHaloGiSetting('enabled', !(gi.isOn && gi.isOn()), { persist: true });
                    syncGiPanel();
                };
                for (const control of deps.HALO_GI_NUMERIC_CONTROLS) {
                    const input = document.getElementById(`fx-gi-${control.key}`);
                    const val = document.getElementById(`fx-gi-${control.key}-val`);
                    if (!input) continue;
                    const apply = (persist = false) => {
                        const v = deps.clampHaloGiNumber(control.key, input.value);
                        input.value = String(v);
                        if (val) val.textContent = deps.formatHaloGiValue(control.key, v);
                        deps.setHaloGiSetting(control.key, v, { persist });
                    };
                    input.oninput = () => apply(false);
                    input.onchange = () => apply(true);
                }
                if (giCascades) giCascades.onchange = () => deps.setHaloGiSetting('cascades', giCascades.value, { persist: true });
                if (giContinuous) giContinuous.onchange = () => deps.setHaloGiSetting('continuous', giContinuous.checked, { persist: true });
                if (giHystNorm) giHystNorm.onchange = () => deps.setHaloGiSetting('hysteresisNormalize', giHystNorm.checked, { persist: true });
                if (giShowProbes) giShowProbes.onchange = () => deps.setHaloGiSetting('showProbes', giShowProbes.checked, { persist: true });
                syncGiPanel();
            }

            // Clone blob tracker controls
            {
                const cloneToggle = document.getElementById('fx-toggle-clone');
                const cloneSource = document.getElementById('fx-clone-source');
                const cloneSliders = ['threshold', 'blurRadius', 'minBlobSize', 'gridDensity', 'smoothing', 'opacity'];

                cloneToggle.onclick = () => {
                    const enabled = deps.maxjsFx.setCloneEnabled(!deps.maxjsFx.isCloneEnabled());
                    cloneToggle.textContent = enabled ? 'On' : 'Off';
                    cloneToggle.classList.toggle('active', enabled);
                    syncPostFxPanel(true);
                };
                cloneSource.onchange = () => {
                    deps.maxjsFx.setCloneOptions({ source: cloneSource.value });
                    savePostFxState();
                };
                for (const key of cloneSliders) {
                    const input = document.getElementById(`fx-clone-${key}`);
                    const valEl = document.getElementById(`fx-clone-${key}-val`);
                    const applyCloneSlider = () => {
                        const v = Number(input.value);
                        if (valEl) valEl.textContent = v >= 1 ? String(Math.round(v)) : v.toFixed(2);
                        deps.maxjsFx.setCloneOptions({ [key]: v });
                    };
                    input.oninput = applyCloneSlider;
                    input.onchange = () => savePostFxState();
                }
                const invertCheck = document.getElementById('fx-clone-invert');
                invertCheck.onchange = () => {
                    deps.maxjsFx.setCloneOptions({ invert: invertCheck.checked });
                    savePostFxState();
                };

                // Playstation Wobble controls (drives retro.wiggle / retro.affineDistortion)
                const wobbleToggle = document.getElementById('fx-toggle-wobble');
                const wobbleSection = wobbleToggle?.closest('[data-post-stack-only]');
                const snapGridSlider = document.getElementById('fx-clone-snapGrid');
                const snapGridVal = document.getElementById('fx-clone-snapGrid-val');
                wobbleToggle.onclick = () => {
                    if (!deps.maxjsFx.supportsScreenSpaceEffects()) {
                        deps.perfHud.setStatus('max.js - Playstation Wobble requires WebGPU or Force WebGL');
                        syncPostFxPanel(true);
                        return;
                    }
                    const retro = deps.maxjsFx.getState().retro;
                    const shaderLabActive = !!deps.shaderLabFx?.isEnabled?.();
                    const next = !retro.wiggle;
                    deps.maxjsFx.setRetroOptions({ wiggle: next });
                    if (next && !shaderLabActive && !deps.maxjsFx.isRetroEnabled()) deps.maxjsFx.setRetroEnabled(true);
                    wobbleToggle.textContent = next ? 'On' : 'Off';
                    wobbleToggle.classList.toggle('active', next);
                    savePostFxState();
                    syncPostFxPanel(true);
                };
                snapGridSlider.oninput = () => {
                    if (!deps.maxjsFx.supportsScreenSpaceEffects()) return;
                    const v = Number(snapGridSlider.value);
                    snapGridVal.textContent = v.toFixed(1);
                    deps.maxjsFx.setRetroOptions({ affineDistortion: v });
                };
                snapGridSlider.onchange = () => savePostFxState();

                // ASCII controls
                const asciiToggle = document.getElementById('fx-toggle-ascii');
                const asciiResSlider = document.getElementById('fx-clone-ascii-resolution');
                const asciiResVal = document.getElementById('fx-clone-ascii-resolution-val');
                const asciiColorSelect = document.getElementById('fx-clone-ascii-color');
                const asciiInvertCheck = document.getElementById('fx-clone-ascii-invert');
                asciiToggle.onclick = () => {
                    if (deps.asciiActive) deps.exitAsciiMode(); else if (!deps.enterAsciiMode()) return;
                    asciiToggle.textContent = deps.asciiActive ? 'On' : 'Off';
                    asciiToggle.classList.toggle('active', deps.asciiActive);
                    syncPostFxPanel(true);
                };
                asciiResSlider.oninput = () => {
                    deps.asciiSettings.resolution = Number(asciiResSlider.value);
                    asciiResVal.textContent = deps.asciiSettings.resolution.toFixed(2);
                    if (deps.asciiActive) deps.rebuildAsciiEffect();
                };
                asciiResSlider.onchange = () => savePostFxState();
                asciiColorSelect.onchange = () => {
                    deps.asciiSettings.color = asciiColorSelect.value;
                    if (deps.asciiActive) deps.rebuildAsciiEffect();
                    savePostFxState();
                };
                asciiInvertCheck.onchange = () => {
                    deps.asciiSettings.invert = asciiInvertCheck.checked;
                    if (deps.asciiActive) deps.rebuildAsciiEffect();
                    savePostFxState();
                };

                syncClonePanelFn = () => {
                    const canSyncInput = (input) => !!input && document.activeElement !== input;
                    const s = deps.maxjsFx.getState().clone;
                    cloneToggle.textContent = s.enabled ? 'On' : 'Off';
                    cloneToggle.classList.toggle('active', s.enabled);
                    if (canSyncInput(cloneSource)) cloneSource.value = s.source;
                    for (const key of cloneSliders) {
                        const input = document.getElementById(`fx-clone-${key}`);
                        const valEl = document.getElementById(`fx-clone-${key}-val`);
                        if (canSyncInput(input)) input.value = s[key];
                        if (valEl) valEl.textContent = s[key] >= 1 ? String(Math.round(s[key])) : s[key].toFixed(2);
                    }
                    if (canSyncInput(invertCheck)) invertCheck.checked = !!s.invert;
                    const retro = deps.maxjsFx.getState().retro;
                    const supportsPostStack = deps.maxjsFx.supportsScreenSpaceEffects();
                    const asciiBlockedByShaderLab = !!deps.shaderLabFx?.isEnabled?.();
                    if (wobbleSection) wobbleSection.hidden = !supportsPostStack;
                    wobbleToggle.textContent = retro.wiggle ? 'On' : 'Off';
                    wobbleToggle.classList.toggle('active', retro.wiggle);
                    wobbleToggle.disabled = !supportsPostStack;
                    snapGridSlider.disabled = !supportsPostStack;
                    if (canSyncInput(snapGridSlider)) snapGridSlider.value = retro.affineDistortion;
                    snapGridVal.textContent = retro.affineDistortion.toFixed(1);
                    asciiToggle.textContent = deps.asciiActive ? 'On' : 'Off';
                    asciiToggle.classList.toggle('active', deps.asciiActive);
                    asciiToggle.disabled = asciiBlockedByShaderLab;
                    asciiResSlider.disabled = asciiBlockedByShaderLab;
                    asciiColorSelect.disabled = asciiBlockedByShaderLab;
                    asciiInvertCheck.disabled = asciiBlockedByShaderLab;
                    if (canSyncInput(asciiResSlider)) asciiResSlider.value = deps.asciiSettings.resolution;
                    asciiResVal.textContent = deps.asciiSettings.resolution.toFixed(2);
                    if (canSyncInput(asciiColorSelect)) asciiColorSelect.value = deps.asciiSettings.color;
                    if (canSyncInput(asciiInvertCheck)) asciiInvertCheck.checked = deps.asciiSettings.invert;
                };
                syncClonePanelFn();
            }

            for (const section of postFxSections) {
                section.sectionEl = document.querySelector(`[data-fx-section="${section.key}"]`);
                section.toggleEl = document.getElementById(`fx-toggle-${section.key}`);
                section.noteEl = document.getElementById(`fx-note-${section.key}`);
                section.controlEls = {};

                section.toggleEl.onclick = () => {
                    const enabled = section.setEnabled(!section.isEnabled());
                    syncPostFxPanel(true);
                    if (!enabled) {
                        const message = deps.maxjsFx.getLastError();
                        if (message && (!deps.maxjsFx.isAvailable() || section.requiresWebGPU)) {
                            deps.perfHud.setStatus(`max.js - ${section.title} unavailable: ${message}`);
                        }
                    }
                };

                for (const control of section.controls) {
                    const input = document.getElementById(`fx-${section.key}-${control.key}`);
                    const valueEl = control.type === 'checkbox'
                        ? null
                        : document.getElementById(`fx-value-${section.key}-${control.key}`);
                    const wrapperEl = input?.closest?.('[data-fx-control]');

                    section.controlEls[control.key] = { input, valueEl, wrapperEl };

                    const getSectionValues = () => section.getValues(deps.maxjsFx.getState());
                    const applyControlValueLive = () => {
                        const value = readPostFxControlValue(control, input, getSectionValues);
                        section.setValues({ [control.key]: value });
                    };
                    const commitControlValue = (persist) => {
                        applyControlValueLive();
                        syncPostFxPanel(true, { persist });
                    };

                    if (control.type === 'checkbox' || control.type === 'select') {
                        input.addEventListener('change', () => commitControlValue(true));
                    } else if (control.realtime) {
                        input.addEventListener('input', () => {
                            previewPostFxControlLabel(control, input, valueEl, getSectionValues);
                            applyControlValueLive();
                            if (control.affectsVisibility) syncPostFxPanel(false, { persist: false });
                        });
                        input.addEventListener('change', () => savePostFxState());
                    } else {
                        input.addEventListener('input', () => {
                            previewPostFxControlLabel(control, input, valueEl, getSectionValues);
                        });
                        input.addEventListener('change', () => commitControlValue(true));
                    }
                }
            }
        }

        function syncPostFxPanel(force = false, { persist = true } = {}) {
            const state = deps.maxjsFx.getState();
            const derived = deps.postPanelVisible ? deps.maxjsFx.getDerivedState() : null;
            const available = deps.maxjsFx.isAvailable();
            const supportsScreenSpaceEffects = deps.maxjsFx.supportsScreenSpaceEffects();
            const lastError = deps.maxjsFx.getLastError();
            const signature = JSON.stringify({
                panel: deps.postPanelVisible,
                available,
                supportsScreenSpaceEffects,
                lastError,
                performanceSettings: deps.performanceSettings,
                cameraClip: deps.cameraClip,
                state,
                derived,
            });

            if (!force && signature === lastPostFxSignature) return;
            lastPostFxSignature = signature;
            deps.syncShaderLabAvailability();
            const canSyncInput = (input) => !!input && (force || document.activeElement !== input);

            const panelStatus = document.getElementById('postPanelStatus');
            if (panelStatus) {
                panelStatus.textContent = available
                    ? (supportsScreenSpaceEffects
                        ? `${deps.rendererBackendLabel} backend`
                        : `${deps.rendererBackendLabel} backend • utility controls`)
                    : `${deps.rendererBackendLabel} backend • ${lastError || 'unavailable'}`;
            }

            const fpsCapSelect = document.getElementById('fx-performance-fpscap');
            const renderScaleSlider = document.getElementById('fx-performance-renderscale');
            const renderScaleValue = document.getElementById('fx-performance-renderscale-val');
            const postFxScaleSlider = document.getElementById('fx-performance-postfxscale');
            const postFxScaleValue = document.getElementById('fx-performance-postfxscale-val');
            const optimizeInstancesCheck = document.getElementById('fx-performance-optimizeinstances');
            const flattenGroupsCheck = document.getElementById('fx-performance-flattengroups');
            const splatsEnabledCheck = document.getElementById('fx-performance-splats');
            const instanceThresholdSlider = document.getElementById('fx-performance-instancethreshold');
            const instanceThresholdValue = document.getElementById('fx-performance-instancethreshold-val');
            const performanceNote = document.getElementById('fx-performance-note');
            const tmSelect = document.getElementById('fx-tonemapping-mode');
            if (canSyncInput(tmSelect)) tmSelect.value = deps.currentToneMapping;
            const expSlider = document.getElementById('fx-tonemapping-exp');
            const expLabel = document.getElementById('fx-tonemapping-exp-val');
            if (canSyncInput(expSlider)) {
                expSlider.value = String(exposureLinearToSliderInput(deps.currentExposure));
            }
            if (expLabel) expLabel.textContent = formatExposureEvLabel(deps.currentExposure);
            const colorGradingUsesPowerShot = deps.maxjsFx.isPowerShotEnabled?.() === true;
            const cg = colorGradingUsesPowerShot
                ? deps.maxjsFx.getState().powershot
                : deps.maxjsFx.getColorGrading();
            const brightnessSlider = document.getElementById('fx-tonemapping-brightness');
            const brightnessLabel = document.getElementById('fx-tonemapping-brightness-val');
            const contrastSlider = document.getElementById('fx-tonemapping-contrast');
            const contrastLabel = document.getElementById('fx-tonemapping-contrast-val');
            if (canSyncInput(brightnessSlider)) brightnessSlider.value = String(cg.brightness);
            if (brightnessLabel) brightnessLabel.textContent = cg.brightness.toFixed(2);
            if (canSyncInput(contrastSlider)) contrastSlider.value = String(cg.contrast);
            if (contrastLabel) contrastLabel.textContent = cg.contrast.toFixed(2);
            if (brightnessSlider) brightnessSlider.disabled = false;
            if (contrastSlider) contrastSlider.disabled = false;
            const aaSelect = document.getElementById('fx-aa-mode');
            if (canSyncInput(aaSelect)) {
                aaSelect.value = (!supportsScreenSpaceEffects && deps.currentAAMode === 'traa')
                    ? 'off'
                    : deps.currentAAMode;
            }
            const aaTraaOption = document.querySelector('#fx-aa-mode option[value="traa"]');
            if (aaTraaOption) {
                aaTraaOption.disabled = !supportsScreenSpaceEffects;
                aaTraaOption.hidden = !supportsScreenSpaceEffects;
            }
            if (canSyncInput(fpsCapSelect)) fpsCapSelect.value = String(deps.performanceSettings.fpsCap || 0);
            if (canSyncInput(renderScaleSlider)) renderScaleSlider.value = String(deps.performanceSettings.renderScale);
            if (renderScaleValue) renderScaleValue.textContent = `${deps.performanceSettings.renderScale.toFixed(2)}x`;
            if (canSyncInput(postFxScaleSlider)) postFxScaleSlider.value = String(deps.getEffectivePostFxResolutionScale());
            if (postFxScaleValue) postFxScaleValue.textContent = `${deps.getEffectivePostFxResolutionScale().toFixed(2)}x`;
            if (canSyncInput(optimizeInstancesCheck)) optimizeInstancesCheck.checked = !!deps.performanceSettings.optimizeMaxInstances;
            if (canSyncInput(flattenGroupsCheck)) flattenGroupsCheck.checked = !!deps.performanceSettings.flattenGroups;
            if (canSyncInput(splatsEnabledCheck)) splatsEnabledCheck.checked = deps.performanceSettings.splatsEnabled !== false;
            if (canSyncInput(instanceThresholdSlider)) instanceThresholdSlider.value = String(deps.performanceSettings.maxInstanceBucketThreshold);
            if (instanceThresholdValue) instanceThresholdValue.textContent = String(deps.performanceSettings.maxInstanceBucketThreshold);
            if (performanceNote) {
                performanceNote.textContent =
                    `Caps the viewer frame rate and scales device pixel ratio/post-FX targets to reduce GPU load. Effective DPR ${deps.getEffectivePixelRatio().toFixed(2)}. Post FX ${deps.getEffectivePostFxResolutionScale().toFixed(2)}x. Splats off skips Spark. Large plain Max instance groups can collapse into InstancedMesh buckets. Headset sessions stay uncapped.`;
            }

            const cameraNearInput = document.getElementById('fx-camera-near');
            const cameraNearValue = document.getElementById('fx-camera-near-val');
            const cameraFarInput = document.getElementById('fx-camera-far');
            const cameraFarValue = document.getElementById('fx-camera-far-val');
            if (canSyncInput(cameraNearInput)) cameraNearInput.value = deps.cameraClip.near != null ? String(deps.cameraClip.near) : '';
            if (canSyncInput(cameraFarInput)) cameraFarInput.value = deps.cameraClip.far != null ? String(deps.cameraClip.far) : '';
            if (cameraNearValue) {
                cameraNearValue.textContent = deps.cameraClip.near != null
                    ? `${deps.camera.near.toFixed(3)}`
                    : `auto (${deps.camera.near.toFixed(3)})`;
            }
            if (cameraFarValue) {
                cameraFarValue.textContent = deps.cameraClip.far != null
                    ? `${deps.camera.far.toFixed(0)}`
                    : `auto (${deps.camera.far.toFixed(0)})`;
            }

            const hasEnabledEffects = deps.maxjsFx.hasEnabledEffects();
            deps.btnPostFxPanel.classList.toggle('active', deps.postPanelVisible || hasEnabledEffects);

            for (const section of postFxSections) {
                const values = section.getValues(state);
                const enabled = section.isEnabled();
                const disabledByOther = section.disabledBy ? section.disabledBy(state) : null;
                const unsupportedBackend = section.requiresWebGPU && !supportsScreenSpaceEffects;
                const hiddenByBackend = unsupportedBackend && !section.keepVisibleWhenUnsupported;
                const disabled =
                    !available ||
                    unsupportedBackend ||
                    !!disabledByOther;

                if (section.sectionEl) {
                    section.sectionEl.hidden = hiddenByBackend;
                    section.sectionEl.classList.toggle('disabled-by-other', !!disabledByOther);
                }
                if (hiddenByBackend) continue;

                section.toggleEl.textContent = enabled ? 'On' : 'Off';
                section.toggleEl.classList.toggle('active', enabled);
                section.toggleEl.disabled = disabled;

                for (const control of section.controls) {
                    const controlEl = section.controlEls[control.key];
                    if (!controlEl) continue;
                    const visible = isPostFxControlVisible(control, values);
                    if (controlEl.wrapperEl) {
                        controlEl.wrapperEl.hidden = !visible;
                        controlEl.wrapperEl.classList.toggle('is-hidden', !visible);
                    }
                    const editingControl = !force && document.activeElement === controlEl.input;

                    // Lock the camera-driven DOF sliders when "Auto from Camera" is on. DOF Range
                    // (focalLength) stays manual — physical range is unusable at scene scale.
                    const dofAutoControls = ['focusDistance', 'bokehScale'];
                    const autoLocked = section.key === 'dof' && dofAutoControls.includes(control.key) && values.autoFromCamera;
                    controlEl.input.disabled = disabled || autoLocked || !visible;

                    if (control.type === 'checkbox') {
                        if (!editingControl) controlEl.input.checked = !!values[control.key];
                    } else if (control.type === 'select') {
                        if (!editingControl) controlEl.input.value = values[control.key];
                    } else if (postFxControlSliderMode(control) !== 'linear') {
                        if (!editingControl) {
                            controlEl.input.value = valueToPostFxDynamicSliderInput(control, values[control.key], values[control.key]);
                        }
                        if (controlEl.valueEl) {
                            controlEl.valueEl.textContent = formatControlValue(control, values[control.key]);
                        }
                    } else {
                        if (!editingControl) controlEl.input.value = values[control.key];
                        if (controlEl.valueEl) {
                            controlEl.valueEl.textContent = formatControlValue(control, values[control.key]);
                        }
                    }
                }

                let note = section.note;
                let isError = false;
                if (!available && lastError) {
                    note = lastError;
                    isError = true;
                } else if (unsupportedBackend) {
                    note = 'Requires WebGPU or Force WebGL.';
                    isError = true;
                } else if (disabledByOther) {
                    note = disabledByOther;
                    isError = true;
                } else if (section.key === 'ssr' && derived) {
                    note = `World distance ${derived.effectiveSSRMaxDistance.toFixed(2)} • thickness ${derived.effectiveSSRThickness.toFixed(3)}`;
                    if (values.denoise) note += ' • recurrent denoise';
                } else if (section.key === 'gtao' && derived) {
                    note = `World radius ${derived.effectiveGTAORadius.toFixed(2)} • thickness ${derived.effectiveGTAOThickness.toFixed(2)}`;
                } else if (section.key === 'contactShadow' && derived) {
                    note = `World distance ${derived.effectiveContactShadowMaxDistance.toFixed(2)} • thickness ${derived.effectiveContactShadowThickness.toFixed(3)}`;
                    if (values.temporal && !state.traa.enabled) {
                        note += ' • Temporal needs TRAA';
                    }
                } else if (section.key === 'traa') {
                    note = values.useSubpixelCorrection
                        ? 'Temporal AA with subpixel correction enabled.'
                        : 'Temporal AA with the cleaner, less corrective resolve.';
                }

                section.noteEl.textContent = note;
                section.noteEl.classList.toggle('error', isError);
            }

            if (syncClonePanelFn) syncClonePanelFn();
            if (persist) savePostFxState();
        }

        deps.btnPostFxPanel.onclick = () => {
            setPostPanelVisible(!deps.postPanelVisible);
        };

        // ── Post FX persistence ──
        const POSTFX_STORAGE_KEY = 'maxjs_postfx_state';
        let postFxPersistTimer = 0;
        let lastProjectPostFxSignature = '';
        let suppressPostFxPersistenceDepth = 0;

        function withPostFxPersistenceSuppressed(fn) {
            suppressPostFxPersistenceDepth += 1;
            try {
                return fn();
            } finally {
                suppressPostFxPersistenceDepth = Math.max(0, suppressPostFxPersistenceDepth - 1);
            }
        }

        function serializePersistedPostFxState() {
            const payload = deps.serializeSnapshotUiState();
            payload.fx = deps.maxjsFx.getState();
            delete payload.camera;
            delete payload.studio;
            delete payload.bake;
            return payload;
        }

        function savePostFxState() {
            if (suppressPostFxPersistenceDepth > 0) return;
            const projectRuntime = deps._projectRuntimeRef;
            if (projectRuntime?.setPostFxState) {
                const payload = serializePersistedPostFxState();
                const signature = JSON.stringify(payload);
                if (signature === lastProjectPostFxSignature) return;
                lastProjectPostFxSignature = signature;
                clearTimeout(postFxPersistTimer);
                postFxPersistTimer = setTimeout(() => {
                    void projectRuntime.setPostFxState(payload).catch(error => {
                        deps.reportBridgeError('post fx state save', error);
                    });
                }, 180);
                return;
            }
            try {
                const payload = serializePersistedPostFxState();
                localStorage.setItem(POSTFX_STORAGE_KEY, JSON.stringify(payload));
            } catch {}
        }

        // Any user edit in the Shader Lab panel (config layer add/edit/delete,
        // autoApply toggle, activate/deactivate) routes through this handler
        // to persist alongside the rest of the Post FX state — next to the
        // .max file when the project runtime is available, otherwise
        // localStorage.
        deps.onShaderLabSnapshotChange(() => savePostFxState());

        // Track the Activate state in the store whenever it flips so a refresh
        // brings the effect back (same UX as ssgi effects being sticky).
        window.addEventListener('maxjs-shader-lab-state', () => {
            const shaderLabEnabled = deps.shaderLabFx.isEnabled();
            if (shaderLabEnabled && deps.asciiActive) deps.exitAsciiMode();
            deps.updateShaderLabEnabled(shaderLabEnabled);
            syncPostFxPanel(true, { persist: false });
        });

        function applySavedPostFxPayload(saved) {
            try {
                let toneMappingChanged = false;
                if (saved.toneMapping && deps.toneMappingModes[saved.toneMapping] != null) {
                    deps.currentToneMapping = saved.toneMapping;
                    toneMappingChanged = true;
                }
                if (Number.isFinite(saved.exposure)) {
                    deps.currentExposure = saved.exposure;
                    toneMappingChanged = true;
                }
                if (toneMappingChanged) applyCoreToneMappingState();
                if (saved.aaMode && ['msaa', 'traa', 'off'].includes(saved.aaMode)) {
                    // Legacy saved value: 'msaa' was a no-op alias for 'off' — normalize.
                    const loaded = saved.aaMode === 'msaa' ? 'off' : saved.aaMode;
                    deps.currentAAMode = loaded;
                    if (deps.maxjsFx.supportsScreenSpaceEffects()) {
                        deps.maxjsFx.setTRAAEnabled(deps.currentAAMode === 'traa');
                    }
                }
                if (typeof saved.envVisible === 'boolean') {
                    deps.envVisible = saved.envVisible;
                }
                if (typeof saved.camLock === 'boolean') {
                    deps.camLock = saved.camLock;
                    deps.controls.enabled = !deps.camLock;
                    deps.syncCameraLockButtonUi();
                }
                if (typeof saved.lightProbeEnabled === 'boolean') {
                    deps.lightProbeEnabled = saved.lightProbeEnabled;
                    deps.btnLightProbe.classList.toggle('active', deps.lightProbeEnabled);
                    deps.applyLightProbeState();
                    if (deps.lightProbeEnabled) deps.refreshLightProbeFromCurrentHDRI();
                }
                if (typeof saved.lightMode === 'boolean') {
                    deps.lightMode = saved.lightMode;
                    document.body.classList.toggle('light-mode', deps.lightMode);
                }
                if (Number.isFinite(saved.background)) {
                    deps.setBackgroundColor(saved.background >>> 0);
                } else if (saved.backgroundPresets && typeof saved.backgroundPresets === 'object') {
                    const legacy = saved.backgroundPresets.custom ?? saved.backgroundPresets.dark ?? saved.backgroundPresets.light;
                    if (Number.isFinite(legacy)) deps.setBackgroundColor(legacy >>> 0);
                }

                // Restore HDRI settings (file must be re-picked, but sliders persist)
                if (saved.hdri) {
                    if (Number.isFinite(saved.hdri.rotation)) deps.localHdriRotation = saved.hdri.rotation;
                    if (Number.isFinite(saved.hdri.intensity)) deps.localHdriIntensity = saved.hdri.intensity;
                    if (Number.isFinite(saved.hdri.blur)) deps.localHdriBlur = saved.hdri.blur;
                    if (typeof saved.hdri.showBg === 'boolean') deps.localHdriShowBg = saved.hdri.showBg;
                    if (typeof saved.hdri.flip === 'boolean') deps.localHdriFlip = saved.hdri.flip;
                    if (typeof saved.hdri.reflectionOnly === 'boolean') deps.localHdriReflectionOnly = saved.hdri.reflectionOnly;
                    if (typeof saved.hdri.enabled === 'boolean') deps.localHdriEnabled = saved.hdri.enabled;
                    // Apply blur to scene even without HDRI loaded (will be used when HDRI loads)
                    deps.scene.backgroundBlurriness = deps.localHdriBlur;
                }
                if (saved.cameraClip) {
                    deps.cameraClip.near = Number.isFinite(saved.cameraClip.near) && saved.cameraClip.near > 0 ? saved.cameraClip.near : null;
                    deps.cameraClip.far = Number.isFinite(saved.cameraClip.far) && saved.cameraClip.far > 0 ? saved.cameraClip.far : null;
                    deps.applyCameraClipOverrides(deps.camera);
                }
                if (saved.haloGi && typeof saved.haloGi === 'object') {
                    deps.applyHaloGiState(saved.haloGi);
                }
                if (saved.performance) {
                    if (Number.isFinite(saved.performance.fpsCap)) {
                        deps.performanceSettings.fpsCap = Math.max(0, Math.round(saved.performance.fpsCap));
                    }
                    if (Number.isFinite(saved.performance.renderScale)) {
                        deps.performanceSettings.renderScale = Math.max(0.25, Math.min(1.0, saved.performance.renderScale));
                    }
                    if (Number.isFinite(saved.performance.postFxScale)) {
                        deps.performanceSettings.postFxScale = Math.max(0.25, Math.min(1.0, saved.performance.postFxScale));
                    }
                    if (typeof saved.performance.optimizeMaxInstances === 'boolean') {
                        deps.performanceSettings.optimizeMaxInstances = saved.performance.optimizeMaxInstances;
                    }
                    if (typeof saved.performance.flattenGroups === 'boolean') {
                        deps.performanceSettings.flattenGroups = saved.performance.flattenGroups;
                    }
                    if (Number.isFinite(saved.performance.maxInstanceBucketThreshold)) {
                        deps.performanceSettings.maxInstanceBucketThreshold = Math.max(2, Math.round(saved.performance.maxInstanceBucketThreshold));
                    }
                    if (typeof saved.performance.splatsEnabled === 'boolean') {
                        deps.performanceSettings.splatsEnabled = saved.performance.splatsEnabled;
                        if (!deps.performanceSettings.splatsEnabled) {
                            deps.splatsSystem.resetMutationQueue();
                            void deps.shutdownSplatViewer();
                        }
                    }
                    deps.applyRendererPerformanceSettings({ resizePostFx: true });
                }
                deps.syncEnvButtonUi();
                if (deps.isLocalHdriActive()) {
                    deps.applyLocalHDRIToScene();
                } else {
                    deps.syncEnvironmentDisplay();
                }

                const fx = saved.fx;
                if (!fx) return;

                deps.maxjsFx.restoreState?.(fx);
                syncPathTracingDofFromPostFx();
                if (saved.webglBasicFx) {
                    deps.webglBasicFx.restoreState?.(saved.webglBasicFx);
                }

                // ASCII restore
                if (saved.ascii) {
                    if (Number.isFinite(saved.ascii.resolution)) deps.asciiSettings.resolution = saved.ascii.resolution;
                    if (saved.ascii.color) deps.asciiSettings.color = saved.ascii.color;
                    if (typeof saved.ascii.invert === 'boolean') deps.asciiSettings.invert = saved.ascii.invert;
                    if (saved.ascii.enabled && !saved.shaderLab?.enabled) deps.enterAsciiMode();
                }

                // Shader Lab restore (config + autoApply + enabled) —
                // next-to-.max persistence flows through the same Post FX
                // state pipe. If the scene had Shader Lab active, reactivate
                // it so the refresh keeps the effect on screen.
                if (saved.shaderLab) {
                    deps.setShaderLabSnapshot(saved.shaderLab);
                    deps.shaderLabFx.setState?.(saved.shaderLab);
                    if (!deps.maxjsFx.supportsScreenSpaceEffects()) {
                        deps.shaderLabFx.disable?.();
                        deps.syncShaderLabAvailability();
                    } else if (saved.shaderLab.enabled && !deps.shaderLabFx.isEnabled()) {
                        deps.shaderLabFx.enable(saved.shaderLab).catch(err => {
                            console.error('[ShaderLab] restore enable failed:', err);
                        });
                    }
                }
            } catch (e) {
                deps.maxjsDebugWarn('max.js: failed to apply post-FX state', e);
            }
        }

        function restorePostFxState() {
            withPostFxPersistenceSuppressed(() => {
                try {
                    const projectPayload = deps._projectRuntimeRef?.getPostFxState?.();
                    if (projectPayload) {
                        lastProjectPostFxSignature = JSON.stringify(projectPayload);
                        applySavedPostFxPayload(projectPayload);
                        return;
                    }
                    if (deps._projectRuntimeRef) return;
                    const raw = localStorage.getItem(POSTFX_STORAGE_KEY);
                    if (!raw) return;
                    applySavedPostFxPayload(JSON.parse(raw));
                } catch (e) {
                    deps.maxjsDebugWarn('max.js: failed to restore post-FX state', e);
                }
            });
        }

        function syncProjectPostFxState() {
            const payload = deps._projectRuntimeRef?.getPostFxState?.();
            if (!payload) return;
            const signature = JSON.stringify(payload);
            if (!signature || signature === lastProjectPostFxSignature) return;
            lastProjectPostFxSignature = signature;
            withPostFxPersistenceSuppressed(() => {
                applySavedPostFxPayload(payload);
                syncPostFxPanel(true, { persist: false });
            });
        }



        return {
            applyCoreToneMappingState,
            computePathTracingApertureRadius,
            syncPathTracingDofFromPostFx,
            exposureLinearToEv,
            exposureLinearToSliderInput,
            exposureSliderInputToLinear,
            formatExposureEvLabel,
            postFxControlSliderMode,
            setPostPanelVisible,
            buildPostFxPanel,
            syncPostFxPanel,
            withPostFxPersistenceSuppressed,
            serializePersistedPostFxState,
            savePostFxState,
            applySavedPostFxPayload,
            restorePostFxState,
            syncProjectPostFxState,
        };
}

export { createPostFxGlue };
