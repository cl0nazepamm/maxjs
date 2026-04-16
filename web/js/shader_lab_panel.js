// Shader Lab configurator panel — full layer-stack editor for the
// shader-lab post-fx pipeline. React + htm UI mounted into the side
// panel, drives shaderLabFx via setConfig() with auto-debounced apply.
//
// Visual style reuses MaxJS's existing .fx-control / .fx-range / .fx-check
// classes so it matches the rest of the panels (no blue native sliders).

const EFFECT_TYPES = [
    'ascii', 'circuit-bent', 'directional-blur', 'chromatic-aberration',
    'crt', 'displacement-map', 'dithering', 'edge-detect', 'fluted-glass',
    'halftone', 'ink', 'particle-grid', 'pattern', 'pixelation',
    'pixel-sorting', 'plotter', 'posterize', 'slice', 'smear', 'threshold',
];

const SOURCE_TYPES = [
    'custom-shader', 'gradient', 'image', 'live', 'text', 'video',
];

const BLEND_MODES = [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
    'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

const COMPOSITE_MODES = ['filter', 'mask'];

// Per-effect default params — extracted from shader-lab 1.3.4's pass source
// files. Users can tweak any value in the Params JSON editor. When the
// user picks a new effect type, the params get reset to that type's defaults
// so every layer starts with a working, editable config instead of an
// empty {} that offers zero discoverability.
const DEFAULT_PARAMS = {
    'ascii': {
        cellSize: 12, colorMode: 1, invert: 0,
        monoRed: 0.96, monoGreen: 0.96, monoBlue: 0.94,
        signalBlackPoint: 0, signalWhitePoint: 1, signalGamma: 1,
        presenceThreshold: 0, presenceSoftness: 0,
        shimmerAmount: 0, shimmerSpeed: 1, directionBias: 0,
        bloomEnabled: false, bloomIntensity: 1.25, bloomRadius: 6,
        bloomSoftness: 0.35, bloomThreshold: 0.6,
    },
    'circuit-bent': {
        colorMode: 'source', invert: false,
        lineAngle: 0, linePitch: 6.4, lineThickness: 0.5,
        noiseMode: 'turbulence', noiseAmount: 1,
        presenceSoftness: 0.64, presenceThreshold: 0.37,
        scrollSpeed: 4,
        signalBlackPoint: 0, signalGamma: 3.07, signalWhitePoint: 0.22,
        monoColor: '#eba8f1',
    },
    'directional-blur': {
        strength: 18, samples: 8, angle: 0, mode: 'linear',
        centerX: 0.5, centerY: 0.5,
    },
    'chromatic-aberration': {
        intensity: 5, centerX: 0.5, centerY: 0.5, angle: 0,
        directionMode: 0,
    },
    'crt': {
        cellSize: 3, scanlineIntensity: 0.17, maskIntensity: 1,
        barrelDistortion: 0.15, chromaticAberration: 2,
        beamFocus: 0.58, brightness: 1.8,
        highlightDrive: 1, highlightThreshold: 0.62,
        shoulder: 0.25, chromaRetention: 1.15, shadowLift: 0.16,
        persistence: 0.18, vignetteIntensity: 0.45,
        flickerIntensity: 0.2, glitchIntensity: 0.13, glitchSpeed: 5,
        signalArtifacts: 0.45,
        bloomEnabled: true, bloomIntensity: 1.93, bloomRadius: 8,
        bloomSoftness: 0.31, bloomThreshold: 0,
    },
    'displacement-map': {
        strength: 20, midpoint: 0.5, directionMode: 0,
        channelMode: 'luminance',
    },
    'dithering': {
        levels: 4, matrixSize: 4, pixelSize: 1, spread: 0.5,
        colorRed: 0.96, colorGreen: 0.96, colorBlue: 0.94,
        shadowRed: 0.06, shadowGreen: 0.06, shadowBlue: 0.06,
        highlightRed: 0.96, highlightGreen: 0.95, highlightBlue: 0.91,
        dotScale: 1.0, animateDither: 0, ditherSpeed: 1.0,
        chromaticSplit: 0, colorMode: 'source',
    },
    'edge-detect': {
        threshold: 0.1, strength: 1, invert: 0,
        lineColorR: 1, lineColorG: 1, lineColorB: 1,
        bgColorR: 0, bgColorG: 0, bgColorB: 0,
        colorMode: 0,
    },
    'fluted-glass': {
        preset: 'architectural', frequency: 20,
        amplitude: 0.02, warp: 0.28, irregularity: 0.35, angle: 0,
    },
    'halftone': {
        spacing: 5, dotSize: 1.0, dotMin: 0,
        shape: 'circle', angle: 28,
        contrast: 1.0, softness: 0.25, invertLuma: false,
        ink: '#0d1014',
        duotoneLight: '#f5f5f0', duotoneDark: '#1c1c1c',
        customBgColor: '#F5F5F0', customColorCount: 4,
        customColor1: '#161616', customColor2: '#595959',
        customColor3: '#A0A0A0', customColor4: '#E8E8E8',
        customLuminanceBias: 0,
        cyanAngle: 15, magentaAngle: 75, yellowAngle: 0, keyAngle: 45,
        paperColor: '#F5F5F0', paperGrain: 0.15,
        gcr: 0.5, registration: 0,
        inkCyan: '#00AEEF', inkMagenta: '#EC008C',
        inkYellow: '#FFF200', inkKey: '#1a1a1a',
        dotGain: 0, dotMorph: 0,
        colorMode: 'cmyk', cmykBlend: 'subtractive',
        bloomEnabled: false, bloomIntensity: 1.25, bloomRadius: 6,
        bloomSoftness: 0.35, bloomThreshold: 0.6,
    },
    'ink': {
        backgroundColor: '#0a0b0d',
        coreColor: '#fffde8', midColor: '#c8f542', edgeColor: '#00c9a7',
        blurStrength: 0.02, crispBlend: 0.75,
        directionX: 0.3746, directionY: 0.9271,
        dripLength: 7.1, dripWeight: 1.2,
        fluidNoise: 0.2, noiseScale: 1,
        smokeSpeed: 0.2, smokeTurbulence: 0.25,
        blurSpread: 1.7, blurPasses: 12, crispPasses: 3,
        grainEnabled: true, grainIntensity: 0.3, grainScale: 1.5,
        bloomIntensity: 1.25, bloomRadius: 6,
        bloomSoftness: 0.35, bloomThreshold: 0.6,
    },
    'particle-grid': {
        gridResolution: 64, displacement: 0.5, pointSize: 3.0,
        noiseAmount: 0, noiseScale: 3.0, noiseSpeed: 0.5,
        bgColor: '#000000',
        bloomEnabled: false, bloomIntensity: 1.25, bloomRadius: 6,
        bloomSoftness: 0.35, bloomThreshold: 0.6,
    },
    'pattern': {
        cellSize: 12, colorMode: 0, invert: 0,
        numPatterns: 1, bgOpacity: 0,
        monoRed: 0.96, monoGreen: 0.96, monoBlue: 0.94,
        customColorCount: 4, customLuminanceBias: 0,
    },
    'pixelation': {
        cellSize: 8, aspectRatio: 1,
    },
    'pixel-sorting': {
        threshold: 0.25, upperThreshold: 1,
        direction: 0, mode: 0, reverse: 0,
        passCount: 150, passOffset: 0,
    },
    'plotter': {
        colorMode: 0, gap: 12, weight: 1.5,
        angle: 90, crossAngle: 135, crosshatch: 1,
        threshold: 0.5, wobble: 0.3,
        paperColorR: 0.96, paperColorG: 0.94, paperColorB: 0.91,
        inkColorR: 0.1, inkColorG: 0.1, inkColorB: 0.1,
    },
    'posterize': {
        levels: 5, gamma: 1, inverseGamma: 1, mode: 0,
    },
    'slice': {
        amount: 180, sliceHeight: 28, blockWidth: 120,
        density: 0.58, dispersion: 0.18, speed: 0.2,
        direction: 'right',
    },
    'smear': {
        angle: 0, start: 0.25, end: 0.75,
        strength: 24, samples: 12,
    },
    'threshold': {
        threshold: 0.5, softness: 0.02, noise: 0.08, invert: 0,
    },
    // Source layers
    'gradient': {
        activePoints: 5, animate: 1,
        warpAmount: 0.18, warpBias: 0.5, warpDecay: 1, warpScale: 1.4,
        vortexAmount: 0.12, motionAmount: 0.18, motionSpeed: 0.2,
        falloff: 1.85,
        glowStrength: 0.18, glowThreshold: 0.62,
        grainAmount: 0.03,
        vignetteStrength: 0.18, vignetteRadius: 0.9, vignetteSoftness: 0.32,
        noiseSeed: 0, noiseMode: 'simplex', tonemapMode: 'aces',
        warpIterations: 1,
    },
    'text': {
        text: 'basement.studio',
        fontSize: 280, fontWeight: 700,
        letterSpacing: -0.02, fontFamily: 'display-serif',
        textColor: '#ffffff', backgroundColor: '#000000',
    },
    'image': { url: '' },
    'video': { url: '', loop: true, muted: true },
    'live': { source: 'webcam' },
    'custom-shader': { code: '// WGSL / TSL shader code' },
};

function defaultParamsFor(type) {
    // Deep-clone to avoid sharing refs between layer instances
    return DEFAULT_PARAMS[type] ? JSON.parse(JSON.stringify(DEFAULT_PARAMS[type])) : {};
}

let _idCounter = 0;
function nextId() {
    _idCounter++;
    return 'layer-' + Date.now().toString(36) + '-' + _idCounter;
}

function makeLayer(type = 'crt', kind = 'effect') {
    return {
        id: nextId(),
        kind,
        type,
        name: type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        visible: true,
        opacity: 1,
        hue: 0,
        saturation: 1,
        blendMode: 'normal',
        compositeMode: 'filter',
        params: defaultParamsFor(type),
    };
}

const DEFAULT_CONFIG = () => ({
    composition: { width: 1920, height: 1080 },
    layers: [makeLayer('crt')],
    timeline: { duration: 6, loop: true, tracks: [] },
});

// ── Host store ──────────────────────────────────────────────
// The panel's user-editable state (config + autoApply) lives in a module-
// level snapshot so host code can persist it next to the .max file via the
// existing Post FX project-state pipeline. The React component mirrors its
// useState into this snapshot on every change and fires _storeChangeHandler
// so the host knows to save.
let _storeSnapshot = {
    config: DEFAULT_CONFIG(),
    autoApply: true,
    enabled: false,
};
let _storeChangeHandler = null;
let _storeApplyToReact = null;

export function getShaderLabSnapshot() {
    return _storeSnapshot;
}

export function setShaderLabSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    _storeSnapshot = {
        config: snapshot.config ?? DEFAULT_CONFIG(),
        autoApply: snapshot.autoApply !== false,
        enabled: !!snapshot.enabled,
    };
    if (_storeApplyToReact) _storeApplyToReact(_storeSnapshot);
}

export function onShaderLabSnapshotChange(handler) {
    _storeChangeHandler = handler;
}

// Fires whenever enabled state flips from the backend side (Activate/
// Deactivate button). Callers register once at startup and it fires for
// the lifetime of the page. Used to keep the persisted snapshot in sync.
export function updateShaderLabEnabled(enabled) {
    if (_storeSnapshot.enabled === !!enabled) return;
    _storeSnapshot = { ..._storeSnapshot, enabled: !!enabled };
    if (_storeChangeHandler) _storeChangeHandler(_storeSnapshot);
}

let _loadPromise = null;
async function ensureReact() {
    if (!_loadPromise) {
        _loadPromise = (async () => {
            const [ReactMod, ReactDOMClientMod, htmMod] = await Promise.all([
                import('react'),
                import('react-dom/client'),
                import('https://esm.sh/htm@3.1.1'),
            ]);
            const React = ReactMod.default ?? ReactMod;
            const ReactDOMClient = ReactDOMClientMod;
            const htm = htmMod.default ?? htmMod;
            return { React, ReactDOMClient, htm };
        })();
    }
    return _loadPromise;
}

// One-time stylesheet injection for the few classes that aren't already
// covered by MaxJS's panel CSS. Scoped under .sl-panel so they can't
// leak into other panels.
let _stylesInjected = false;
function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const css = `
        /* ── Width containment ────────────────────────────────
         * The default .sidepanel-body is a grid with auto columns,
         * which grow to fit content's intrinsic width. A long
         * <option> string in a Type select can push the grid track
         * past the 280px panel and overflow the right edge. Force
         * minmax(0, 1fr) + min-width:0 on every flex/grid child so
         * everything shrinks to the panel width.
         * ──────────────────────────────────────────────────── */
        .sl-panel {
            --sl-accent: rgb(255, 77, 0);
            --sl-accent-dim: rgba(255, 77, 0, 0.18);
            --sl-accent-glow: rgba(255, 77, 0, 0.45);
        }
        .sl-panel,
        .sl-panel * { box-sizing: border-box; }
        .sl-panel { min-width: 0; max-width: 100%; overflow-x: hidden; }
        .sl-panel .sidepanel-body { grid-template-columns: minmax(0, 1fr); }
        .sl-panel .sidepanel-body > * { min-width: 0; max-width: 100%; }
        .sl-panel .fx-section { min-width: 0; max-width: 100%; overflow: hidden; }
        .sl-panel .fx-control { min-width: 0; max-width: 100%; }
        .sl-panel select,
        .sl-panel input[type="text"],
        .sl-panel input[type="range"] {
            width: 100%;
            max-width: 100%;
            min-width: 0;
        }

        /* ── Accent-colored slider thumbs (scoped to shader lab) ─ */
        .sl-panel input[type="range"].fx-range::-webkit-slider-thumb {
            background: var(--sl-accent);
            border: none;
            box-shadow: 0 0 6px var(--sl-accent-glow);
        }
        .sl-panel input[type="range"].fx-range::-moz-range-thumb {
            background: var(--sl-accent);
            border: none;
            box-shadow: 0 0 6px var(--sl-accent-glow);
        }
        .sl-panel input[type="range"].fx-range:hover::-webkit-slider-thumb {
            box-shadow: 0 0 10px var(--sl-accent-glow);
        }
        .sl-panel input[type="range"].fx-range:hover::-moz-range-thumb {
            box-shadow: 0 0 10px var(--sl-accent-glow);
        }

        /* ── Shader Lab wordmark (section title replacement) ─ */
        .sl-wordmark {
            display: block;
            width: auto;
            height: 14px;
            color: #e0e0e0;
        }

        /* ── Activate toggle ──────────────────────────────── */
        .sl-panel .sl-activate {
            width: 100%;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #bbb;
            font: 600 11px/1 -apple-system, 'Segoe UI', system-ui, sans-serif;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            padding: 9px 8px;
            cursor: pointer;
            border-radius: 3px;
            transition: background 0.15s, color 0.15s, border-color 0.15s;
        }
        .sl-panel .sl-activate:hover {
            background: rgba(255, 255, 255, 0.07);
            color: #eee;
            border-color: rgba(255, 255, 255, 0.15);
        }
        .sl-panel .sl-activate.active {
            background: rgba(255, 255, 255, 0.12);
            border-color: rgba(255, 255, 255, 0.25);
            color: #fff;
        }

        /* ── Layer cards ──────────────────────────────────── */
        .sl-cards {
            display: flex;
            flex-direction: column;
            gap: 1px;
            background: rgba(0, 0, 0, 0.18);
            border-radius: 3px;
            padding: 1px;
        }
        .sl-card {
            background: rgba(255,255,255,0.025);
            border: 0;
            border-radius: 2px;
            min-width: 0;
            max-width: 100%;
            transition: background 0.12s ease;
        }
        .sl-card:hover { background: rgba(255,255,255,0.035); }
        .sl-card.expanded { background: rgba(255,255,255,0.045); }
        .sl-card-head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 10px;
            cursor: pointer;
            user-select: none;
            min-width: 0;
            overflow: hidden;
            min-height: 28px;
        }
        .sl-dot {
            width: 6px; height: 6px; border-radius: 50%;
            flex-shrink: 0;
        }
        .sl-dot.on  { background: var(--sl-accent); box-shadow: 0 0 4px var(--sl-accent-glow); }
        .sl-dot.off { background: #2a2a2a; box-shadow: inset 0 0 0 1px #383838; }
        .sl-name {
            flex: 1 1 0;
            min-width: 0;
            font: 600 11px/1.2 -apple-system, 'Segoe UI', system-ui, sans-serif;
            background: transparent; border: none; color: #e8e8e8;
            outline: none; padding: 0;
            text-overflow: ellipsis; overflow: hidden;
            letter-spacing: -0.005em;
        }
        .sl-name:focus { color: #fff; }
        .sl-pill {
            font: 9px/1 -apple-system, 'Segoe UI', system-ui, sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: #777;
            padding: 3px 7px;
            border-radius: 2px;
            background: rgba(255,255,255,0.05);
            white-space: nowrap;
            flex-shrink: 1;
            min-width: 0;
            max-width: 88px;
            overflow: hidden;
            text-overflow: ellipsis;
            font-weight: 600;
        }
        .sl-eye {
            background: transparent; border: none; cursor: pointer;
            font-size: 11px; color: #444;
            padding: 2px 4px;
            line-height: 1;
            flex-shrink: 0;
            transition: color 0.12s ease;
        }
        .sl-eye:hover { color: #888; }
        .sl-eye.on { color: var(--sl-accent); }
        .sl-card-body {
            padding: 4px 10px 10px;
            border-top: 1px solid rgba(255,255,255,0.04);
            min-width: 0;
            overflow: hidden;
            display: grid;
            gap: 8px;
            margin-top: 2px;
        }
        .sl-select {
            width: 100%;
            max-width: 100%;
            min-width: 0;
            background: rgba(255,255,255,0.04);
            color: #ccc;
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 0;
            padding: 4px 6px;
            font: 10px 'Segoe UI', system-ui, sans-serif;
            outline: none;
            cursor: pointer;
        }
        .sl-row-actions {
            display: flex;
            gap: 4px;
            margin-top: 8px;
            justify-content: space-between;
        }
        .sl-mini {
            font: 9px 'Segoe UI', system-ui, sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            padding: 4px 10px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.1);
            color: #ccc;
            cursor: pointer;
            border-radius: 0;
        }
        .sl-mini:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
        .sl-mini:disabled { opacity: 0.35; cursor: not-allowed; }
        .sl-mini.danger { color: #f88; border-color: rgba(255,100,100,0.25); }
        .sl-mini.danger:hover { background: rgba(255,100,100,0.08); }
        .sl-add-row {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            min-width: 0;
        }
        .sl-add-row .sl-select { flex: 1 1 0; min-width: 0; }
        .sl-empty {
            font: 10px 'Segoe UI', system-ui, sans-serif;
            color: #555;
            padding: 8px 0;
            text-align: center;
        }
        .sl-brand-box {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 10px 12px;
            min-height: 0;
        }
        .sl-brand-wordmark {
            display: block;
            width: 120px;
            height: auto;
            color: #e8e8e8;
        }

        /* ── Params editor ────────────────────────────────── */
        .sl-params-block {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding-top: 6px;
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            margin-top: 4px;
        }
        .sl-params-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font: 600 10px/1 -apple-system, 'Segoe UI', system-ui, sans-serif;
            color: #aaa;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }
        .sl-params-toggle {
            display: inline-flex;
            gap: 0;
            background: rgba(0, 0, 0, 0.25);
            border-radius: 2px;
            padding: 1px;
        }
        .sl-params-toggle button {
            background: transparent;
            border: 0;
            color: #777;
            font: 9px/1 -apple-system, 'Segoe UI', system-ui, sans-serif;
            letter-spacing: 0.04em;
            padding: 4px 8px;
            cursor: pointer;
            text-transform: uppercase;
        }
        .sl-params-toggle button:hover { color: #ccc; }
        .sl-params-toggle button.active {
            background: var(--sl-accent);
            color: #fff;
        }
        .sl-params-empty {
            color: #666;
            font: 10px/1.4 -apple-system, 'Segoe UI', system-ui, sans-serif;
            padding: 8px 0;
        }
        .sl-color-row {
            flex-direction: row !important;
            justify-content: space-between;
            align-items: center;
        }
        .sl-color-row input[type="color"] {
            width: 28px;
            height: 18px;
            padding: 0;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: transparent;
            cursor: pointer;
        }
        .sl-text-input {
            background: rgba(0, 0, 0, 0.25);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: #d8d8d8;
            font: 11px/1.4 -apple-system, 'Segoe UI', system-ui, sans-serif;
            padding: 4px 6px;
            border-radius: 2px;
            outline: none;
            width: 100%;
        }
        .sl-text-input:focus {
            border-color: rgba(255, 255, 255, 0.2);
        }
        .sl-params-editor {
            width: 100%;
            background: rgba(0, 0, 0, 0.25);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: #d8d8d8;
            font: 11px/1.4 'SF Mono', 'Consolas', 'Monaco', monospace;
            padding: 6px 8px;
            border-radius: 2px;
            resize: vertical;
            outline: none;
            min-height: 48px;
            max-width: 100%;
            white-space: pre;
            overflow: auto;
        }
        .sl-params-editor:focus {
            border-color: rgba(255, 255, 255, 0.2);
            background: rgba(0, 0, 0, 0.35);
        }
        .sl-switch {
            display: flex;
            width: 100%;
            gap: 0;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 0;
            padding: 2px;
        }
        .sl-switch button {
            flex: 1 1 0;
            font: 9px 'Segoe UI', system-ui, sans-serif;
            text-transform: uppercase;
            letter-spacing: 1px;
            padding: 6px 8px;
            background: transparent;
            border: none;
            color: #777;
            cursor: pointer;
            border-radius: 0;
            transition: background 0.15s, color 0.15s;
        }
        .sl-switch button:hover { color: #ccc; }
        .sl-switch button.active {
            background: var(--sl-accent);
            color: #fff;
        }
    `;
    const style = document.createElement('style');
    style.id = 'sl-panel-styles';
    style.textContent = css;
    document.head.appendChild(style);
}

function buildApp({ React, htm, shaderLabFx }) {
    const html = htm.bind(React.createElement);
    const { useState, useEffect, useRef, useCallback } = React;

    function FxSlider({ label, value, min, max, step, format, onChange }) {
        const display = format ? format(value) : (
            Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(0)
        );
        return html`
            <label className="fx-control">
                <div className="fx-control-head">
                    <span>${label}</span>
                    <span className="fx-value">${display}</span>
                </div>
                <input
                    className="fx-range"
                    type="range"
                    min=${min} max=${max} step=${step ?? 0.01} value=${value}
                    onInput=${(e) => onChange(parseFloat(e.target.value))}
                />
            </label>
        `;
    }

    function FxSelect({ label, value, options, onChange }) {
        return html`
            <label className="fx-control">
                <div className="fx-control-head">
                    <span>${label}</span>
                </div>
                <select className="sl-select" value=${value}
                    onChange=${(e) => onChange(e.target.value)}>
                    ${options.map(o => html`<option key=${o} value=${o}>${o}</option>`)}
                </select>
            </label>
        `;
    }

    // Known string enums — key name → dropdown options. Derived from the
    // shader-lab pass source. If a string key isn't in this map, it falls
    // back to a text input.
    const PARAM_ENUMS = {
        colorMode: ['source', 'mono', 'cmyk', 'duotone', 'custom', '0', '1', '2'],
        mode: ['linear', 'radial'],
        direction: ['right', 'left', 'up', 'down'],
        noiseMode: ['simplex', 'turbulence', 'perlin'],
        shape: ['circle', 'square', 'diamond'],
        fontFamily: ['display-serif', 'serif', 'sans-serif', 'monospace'],
        preset: ['architectural', 'vintage', 'industrial'],
        tonemapMode: ['aces', 'linear', 'reinhard'],
        channelMode: ['luminance', 'red', 'green', 'blue', 'alpha'],
        cmykBlend: ['subtractive', 'additive'],
        source: ['webcam', 'screen'],
    };

    // Humanize camelCase / kebab-case param keys for display
    const humanize = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2')
                              .replace(/-/g, ' ')
                              .replace(/\b\w/g, c => c.toUpperCase());

    // Param keys whose name strongly implies "counts of discrete things"
    // (pixels, grid cells, sample counts, iteration loops). These stay
    // integer-stepped. Everything else is float so sliders give fractional
    // values — `Number.isInteger(defaultValue)` alone is a bad signal
    // because many float params default to 0 (thresholds, offsets) or 1
    // (full intensity) which look like ints.
    const INT_KEY_RE = /(?:^|[A-Z_-])(count|passes?|iterations?|samples?|levels?|gridresolution|cellsize|matrixsize|pixelsize|spacing|numchars|activepoints|fontsize|fontweight|passoffset|sliceheight|blockwidth|width|height)$/i;

    // Heuristic: compute a stable slider range for a numeric param. Range
    // is pinned to the DEFAULT value (not current) — otherwise a user drag
    // past the initial max inflates the range on the next render, and every
    // subsequent drag inflates it further until the slider is useless.
    function inferNumericRange(paramKey, defaultValue, currentValue) {
        const d = Math.abs(defaultValue ?? 0);
        const isInt = INT_KEY_RE.test(paramKey);
        const allowNegative = (defaultValue ?? 0) < 0 || (currentValue ?? 0) < 0;

        // Range tiers — ~4-6x headroom above the default so tweaking both
        // directions feels natural without letting small defaults (like
        // cellSize=3) balloon to 1000+ when the user scrubs upward.
        let max;
        if (d === 0) max = isInt ? 10 : 1;
        else if (d <= 1)   max = isInt ? Math.max(8, d * 4) : 1;
        else if (d <= 5)   max = d * 4;
        else if (d <= 20)  max = d * 3;
        else if (d <= 100) max = d * 2.5;
        else               max = d * 2;

        // If current is outside the computed max (loaded-from-save with a
        // tweaked value), extend to accommodate without triggering the
        // creeping inflation — use once per mount.
        const cur = Math.abs(currentValue ?? 0);
        if (cur > max) max = cur;

        const min = allowNegative ? -max : 0;
        const step = isInt
            ? 1
            : (max <= 1 ? 0.01 : max <= 10 ? 0.05 : max <= 100 ? 0.1 : 1);
        return { min, max, step, isInt };
    }

    const isHexColor = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s);

    // Auto-generated per-param control renderer. Looks at each key in the
    // current params object and picks an appropriate widget based on the
    // value type (number → slider, bool → checkbox, hex string → color
    // picker, known enum → dropdown, other string → text input).
    function AutoParamControl({ paramKey, value, defaultValue, onChange }) {
        const label = humanize(paramKey);

        if (typeof value === 'boolean') {
            return html`
                <label className="fx-check">
                    <span>${label}</span>
                    <input type="checkbox" checked=${value}
                        onChange=${(e) => onChange(e.target.checked)} />
                </label>
            `;
        }

        if (typeof value === 'number') {
            const range = inferNumericRange(paramKey, defaultValue, value);
            const display = range.isInt ? Math.round(value) : value.toFixed(2);
            return html`
                <label className="fx-control">
                    <div className="fx-control-head">
                        <span>${label}</span>
                        <span className="fx-value">${display}</span>
                    </div>
                    <input className="fx-range" type="range"
                        min=${range.min} max=${range.max} step=${range.step}
                        value=${value}
                        onInput=${(e) => onChange(range.isInt
                            ? parseInt(e.target.value, 10)
                            : parseFloat(e.target.value))} />
                </label>
            `;
        }

        if (typeof value === 'string' && isHexColor(value)) {
            return html`
                <label className="fx-control sl-color-row">
                    <span>${label}</span>
                    <input type="color" value=${value}
                        onChange=${(e) => onChange(e.target.value)} />
                </label>
            `;
        }

        if (typeof value === 'string' && PARAM_ENUMS[paramKey]) {
            const options = PARAM_ENUMS[paramKey];
            return html`
                <label className="fx-control">
                    <div className="fx-control-head"><span>${label}</span></div>
                    <select className="sl-select" value=${value}
                        onChange=${(e) => onChange(e.target.value)}>
                        ${options.map(o => html`<option key=${o} value=${o}>${o}</option>`)}
                    </select>
                </label>
            `;
        }

        // Fallback: text input (free-form strings, unknown types, etc.)
        return html`
            <label className="fx-control">
                <div className="fx-control-head"><span>${label}</span></div>
                <input className="sl-text-input" type="text" value=${String(value ?? '')}
                    onChange=${(e) => onChange(e.target.value)} />
            </label>
        `;
    }

    // Full params editor — auto-generates widgets for every key with a
    // "raw JSON" toggle for power users who want to paste shader-lab configs
    // directly or tweak keys we don't have defaults for.
    function ParamsEditor({ value, defaults, onChange }) {
        const [rawMode, setRawMode] = useState(false);
        const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
        const [error, setError] = useState('');

        useEffect(() => {
            try {
                if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(value ?? {})) {
                    setText(JSON.stringify(value ?? {}, null, 2));
                    setError('');
                }
            } catch (_) { /* user is mid-edit */ }
        }, [value]);

        const updateKey = (k, v) => {
            onChange({ ...(value ?? {}), [k]: v });
        };

        const handleRawInput = (e) => {
            const next = e.target.value;
            setText(next);
            try {
                const parsed = JSON.parse(next);
                setError('');
                onChange(parsed);
            } catch (err) {
                setError(err.message.split('\n')[0]);
            }
        };

        const paramKeys = Object.keys(value ?? {});
        return html`
            <div className="sl-params-block">
                <div className="sl-params-head">
                    <span>Params</span>
                    <div className="sl-params-toggle">
                        <button type="button" className=${!rawMode ? 'active' : ''}
                            onClick=${() => setRawMode(false)}>Auto</button>
                        <button type="button" className=${rawMode ? 'active' : ''}
                            onClick=${() => setRawMode(true)}>JSON</button>
                    </div>
                </div>
                ${rawMode
                    ? html`
                        ${error && html`<div style=${{ color: '#f66', fontSize: '9px', marginBottom: '4px' }}>${error}</div>`}
                        <textarea className="sl-params-editor"
                            spellcheck=${false}
                            rows=${Math.min(16, Math.max(4, text.split('\n').length))}
                            value=${text}
                            onChange=${handleRawInput} />
                    `
                    : html`
                        ${paramKeys.length === 0
                            ? html`<div className="sl-params-empty">No params for this type.</div>`
                            : paramKeys.map(k => html`
                                <${AutoParamControl}
                                    key=${k}
                                    paramKey=${k}
                                    value=${value[k]}
                                    defaultValue=${defaults?.[k]}
                                    onChange=${(v) => updateKey(k, v)} />
                            `)
                        }
                    `}
            </div>
        `;
    }

    function LayerCard({ layer, index, total, onUpdate, onRemove, onMoveUp, onMoveDown }) {
        const [open, setOpen] = useState(false);
        const update = (patch) => onUpdate({ ...layer, ...patch });
        const isSource = layer.kind === 'source';
        const typeOptions = isSource ? SOURCE_TYPES : EFFECT_TYPES;

        return html`
            <div className=${'sl-card' + (open ? ' expanded' : '')}>
                <div className="sl-card-head" onClick=${() => setOpen(!open)}>
                    <span className=${'sl-dot ' + (layer.visible ? 'on' : 'off')}></span>
                    <input
                        className="sl-name"
                        value=${layer.name}
                        onClick=${(e) => e.stopPropagation()}
                        onChange=${(e) => update({ name: e.target.value })}
                    />
                    <span className="sl-pill">${layer.type}</span>
                    <button
                        type="button"
                        className=${'sl-eye ' + (layer.visible ? 'on' : '')}
                        onClick=${(e) => { e.stopPropagation(); update({ visible: !layer.visible }); }}
                        title="Toggle visibility"
                    >${layer.visible ? '◉' : '○'}</button>
                </div>
                ${open && html`
                    <div className="sl-card-body">
                        <${FxSelect} label="Kind" value=${layer.kind} options=${['effect', 'source']}
                            onChange=${(v) => {
                                const nextType = v === 'source' ? SOURCE_TYPES[0] : EFFECT_TYPES[0];
                                update({ kind: v, type: nextType, params: defaultParamsFor(nextType) });
                            }} />
                        <${FxSelect} label="Type" value=${layer.type} options=${typeOptions}
                            onChange=${(v) => update({ type: v, params: defaultParamsFor(v) })} />
                        <${FxSlider} label="Opacity" value=${layer.opacity} min=${0} max=${1} step=${0.01}
                            onChange=${(v) => update({ opacity: v })} />
                        <${FxSlider} label="Hue" value=${layer.hue} min=${-180} max=${180} step=${1}
                            format=${(v) => Math.round(v) + '°'}
                            onChange=${(v) => update({ hue: v })} />
                        <${FxSlider} label="Saturation" value=${layer.saturation} min=${0} max=${2} step=${0.01}
                            onChange=${(v) => update({ saturation: v })} />
                        <${FxSelect} label="Blend" value=${layer.blendMode} options=${BLEND_MODES}
                            onChange=${(v) => update({ blendMode: v })} />
                        <${FxSelect} label="Composite" value=${layer.compositeMode} options=${COMPOSITE_MODES}
                            onChange=${(v) => update({ compositeMode: v })} />
                        <${ParamsEditor} value=${layer.params}
                            defaults=${DEFAULT_PARAMS[layer.type]}
                            onChange=${(v) => update({ params: v })} />
                        <div className="sl-row-actions">
                            <div style=${{ display: 'flex', gap: '4px' }}>
                                <button type="button" className="sl-mini"
                                    onClick=${onMoveUp} disabled=${index === 0}>▲</button>
                                <button type="button" className="sl-mini"
                                    onClick=${onMoveDown} disabled=${index === total - 1}>▼</button>
                            </div>
                            <button type="button" className="sl-mini danger"
                                onClick=${onRemove}>Delete</button>
                        </div>
                    </div>
                `}
            </div>
        `;
    }

    return function ShaderLabApp({ onHide }) {
        const [config, setConfig] = useState(() => _storeSnapshot.config);
        const [enabled, setEnabled] = useState(() => shaderLabFx.isEnabled());
        const [status, setStatus] = useState(() => shaderLabFx.isEnabled() ? 'live' : 'three.js backend');
        const [statusColor, setStatusColor] = useState('#777');
        const [autoApply, setAutoApply] = useState(() => _storeSnapshot.autoApply);
        const [addType, setAddType] = useState(EFFECT_TYPES[0]);
        const debounceTimer = useRef(0);

        // Mirror React state → module store, notify host on every change so
        // persistence lands in project.maxjs.json (or localStorage fallback)
        // alongside the rest of the Post FX state. Merge-update rather than
        // replace so fields tracked outside React (currently `enabled`,
        // which is driven by shaderLabFx event, not by the panel) survive.
        useEffect(() => {
            _storeSnapshot = { ..._storeSnapshot, config, autoApply };
            if (_storeChangeHandler) _storeChangeHandler(_storeSnapshot);
        }, [config, autoApply]);

        // Expose imperative apply so host code can push restored state into
        // the mounted panel (for the case where saved state loads AFTER the
        // panel has already mounted — e.g. switching scenes).
        useEffect(() => {
            _storeApplyToReact = (snap) => {
                if (snap.config) setConfig(snap.config);
                if (typeof snap.autoApply === 'boolean') setAutoApply(snap.autoApply);
            };
            return () => { _storeApplyToReact = null; };
        }, []);

        // Keep the React state in sync with shaderLabFx whenever the
        // burger-menu POSTFX switch (or any other caller) changes backend.
        useEffect(() => {
            const onChange = () => {
                const on = shaderLabFx.isEnabled();
                setEnabled(on);
                if (on) {
                    setStatus('live');
                    setStatusColor('rgb(255, 77, 0)');
                } else {
                    setStatus('three.js backend');
                    setStatusColor('#777');
                }
            };
            window.addEventListener('maxjs-shader-lab-state', onChange);
            return () => window.removeEventListener('maxjs-shader-lab-state', onChange);
        }, []);

        const applyNow = useCallback(async (cfg) => {
            if (!shaderLabFx.isEnabled()) return;
            try {
                setStatus('applying...');
                setStatusColor('#fa5');
                await shaderLabFx.setConfig(cfg);
                setStatus('live');
                setStatusColor('rgb(255, 77, 0)');
            } catch (err) {
                setStatus('apply failed');
                setStatusColor('#f66');
                console.error('[ShaderLab] setConfig failed:', err);
            }
        }, []);

        useEffect(() => {
            if (!autoApply || !enabled) return;
            clearTimeout(debounceTimer.current);
            debounceTimer.current = setTimeout(() => applyNow(config), 350);
            return () => clearTimeout(debounceTimer.current);
        }, [config, enabled, autoApply, applyNow]);

        const selectBackend = useCallback(async (backend) => {
            if (backend === 'threejs') {
                if (!shaderLabFx.isEnabled()) return;
                shaderLabFx.disable();
                return;
            }
            if (shaderLabFx.isEnabled()) return;
            setStatus('loading...');
            setStatusColor('#fa5');
            try {
                await shaderLabFx.enable(config);
            } catch (err) {
                setStatus('error: ' + (err?.message || err));
                setStatusColor('#f66');
                console.error('[ShaderLab] enable failed:', err);
            }
        }, [config]);

        const addLayer = useCallback(() => {
            const isSource = SOURCE_TYPES.includes(addType);
            setConfig(c => ({
                ...c,
                layers: [...c.layers, makeLayer(addType, isSource ? 'source' : 'effect')],
            }));
        }, [addType]);

        const updateLayer = useCallback((id, next) => {
            setConfig(c => ({
                ...c,
                layers: c.layers.map(l => l.id === id ? next : l),
            }));
        }, []);

        const removeLayer = useCallback((id) => {
            setConfig(c => ({ ...c, layers: c.layers.filter(l => l.id !== id) }));
        }, []);

        const moveLayer = useCallback((index, dir) => {
            setConfig(c => {
                const layers = [...c.layers];
                const target = index + dir;
                if (target < 0 || target >= layers.length) return c;
                [layers[index], layers[target]] = [layers[target], layers[index]];
                return { ...c, layers };
            });
        }, []);

        const resetConfig = useCallback(() => setConfig(DEFAULT_CONFIG()), []);

        return html`
            <div className="sl-panel">
                <div className="sidepanel-header">
                    <div>
                        <div className="sidepanel-title">Shader Lab</div>
                        <div className="sidepanel-subtitle" style=${{ color: statusColor }}>${status}</div>
                    </div>
                    <div style=${{ display: 'flex', gap: '4px' }}>
                        <button type="button" onClick=${resetConfig}>Reset</button>
                        <button type="button" onClick=${onHide}>Hide</button>
                    </div>
                </div>
                <div className="sidepanel-body">
                    <section className="fx-section sl-brand-box">
                        <svg className="sl-brand-wordmark" fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 107 15" aria-label="basement.">
                            <path d="M3.54378 5.68462c.40819-1.71646 1.48431-2.19633 3.71077-2.19633 3.30255 0 4.06325.81209 4.06325 4.94636v1.60575c0 4.1158-.7792 4.9463-4.24879 4.9463-2.05947 0-3.26547-.9597-3.618-2.8792v2.6578H0V0h3.54378v5.68462Zm.01856 5.18628c.11132.7014.76071 1.0705 2.00381 1.0705 1.70696 0 2.02237-.3691 2.02237-1.97485V8.54539c0-1.64263-.31541-2.01176-2.02237-2.01176-1.26166 0-1.91104.47987-2.00381 1.47652v2.86075Zm8.94296.7014c0-2.84234.6679-3.37758 4.2488-3.37758l3.5252-.01846v-.62752c0-1.27351-.2968-1.49499-1.8553-1.49499-1.7441 0-2.0595.22148-2.0224 1.49499h-3.5252v-.44296c0-3.04534.8163-3.61749 5.1579-3.61749h.8535c4.1375 0 4.9168.59061 4.9168 3.82051v7.4565h-3.5253v-1.9564c-.4824 1.4765-1.7255 2.1594-3.4695 2.1778-3.6366.1108-4.3045-.4245-4.3045-3.4144Zm3.7108.0369c0 .7382.2783.8859 1.7255.8859h.1855c1.5585-.0369 2.1522-.3691 2.1522-1.2366v-.4799l-2.9129.0185c-.9648 0-1.1503.1292-1.1503.8121Zm8.7759-.2953v-.24h3.3397v.24c0 .849.4639 1.0889 2.1894 1.0889 1.5956 0 2.0223-.1846 2.0223-.849 0-.4429-.3896-.7383-2.0223-1.0336-.6494-.1292-2.3378-.3875-3.451-.81204-1.5215-.59061-1.9111-1.42116-1.9111-2.89769 0-2.82385.8164-3.32218 5.0281-3.32218h.8535c4.1375 0 4.9167.57215 4.9167 3.72823v.33222h-3.5253v-.33222c0-.90437-.3896-1.16277-1.8183-1.16277-1.3729 0-1.744.18457-1.744.86746 0 .46142.3339.6829 1.5399.86746 1.8183.29531 2.6718.51679 3.6366.79363 1.7626.51679 2.1894 1.5319 2.1894 3.2299 0 2.6578-.8535 3.1745-5.5291 3.1745h-.8535c-4.0818 0-4.8611-.5906-4.8611-3.6728Zm12.3198-2.06716c0-4.87253.8535-5.75845 5.3991-5.75845h.8535c4.5828 0 5.4363.81209 5.4363 5.20475V10.428h-7.9782v.0553c0 1.6058.334 1.9195 2.1337 1.9195 1.7255 0 2.041-.203 2.041-1.1443h3.7107c0 3.1376-.8349 3.7282-5.3435 3.7282h-.8535c-4.5456 0-5.3991-.9043-5.3991-5.73996Zm3.7107-1.42115h4.2674c-.0185-1.49499-.3896-1.77184-2.1337-1.77184-1.7997 0-2.1337.27685-2.1337 1.71647v.05537Zm9.5367 6.93971V3.70977h3.5252v2.10405c.3897-1.66109 1.3359-2.32553 2.9872-2.32553 2.8202 0 3.4325.44296 3.5809 2.54701.4082-1.75338 1.54-2.54701 3.4139-2.54701 3.3954 0 4.0262.64598 4.0262 4.11582l.0186 7.16119h-3.5253V8.13935c0-1.43962-.2412-1.71646-1.6513-1.71646-1.1874 0-1.7997.60906-1.8368 1.8272l.0186 6.51521h-3.5067V8.13935c0-1.43962-.2783-1.71646-1.6884-1.71646-1.2246 0-1.8369.64598-1.8369 1.93794v6.40447h-3.5252Zm18.9249-5.51856c0-4.87253.8535-5.75845 5.4178-5.75845h.8534c4.5457 0 5.3992.81209 5.3992 5.20475V10.428h-7.9781v.0553c0 1.6058.3339 1.9195 2.1708 1.9195 1.7069 0 2.0223-.203 2.0223-1.1443h3.6922c0 3.1376-.8349 3.7282-5.3064 3.7282h-.8534c-4.5643 0-5.4178-.9043-5.4178-5.73996Zm3.6923-1.42115h4.2859c-.0186-1.49499-.3896-1.77184-2.1151-1.77184-1.8369 0-2.1708.27685-2.1708 1.71647v.05537Zm9.5181 6.93971V3.70977h3.5252v2.23325c.4267-1.79029 1.5029-2.45473 3.5438-2.45473 3.2284 0 3.8406.64598 3.8406 4.11582l.0186 7.16119h-3.5252V8.43465c0-1.698-.2969-2.01176-1.9296-2.01176-1.2803 0-1.9296.57215-1.9482 1.75337v6.58904h-3.5252Zm11.8373-8.12094V3.70977h1.2802v-2.3809h3.3397v2.3809h3.1723v2.93459h-3.1723v3.87584c0 .9229.2041 1.1074 1.2993 1.1074h2.04v3.1377h-2.412c-3.7289 0-4.4525-.5907-4.4525-3.7098V6.64436h-1.0947Zm9.2952 8.12094v-3.1377H107v3.1377h-3.173Z"></path>
                        </svg>
                    </section>
                    <section className="fx-section">
                        <button
                            type="button"
                            className=${`sl-activate ${enabled ? 'active' : ''}`}
                            onClick=${() => selectBackend(enabled ? 'threejs' : 'shaderlab')}>
                            ${enabled ? 'Deactivate' : 'Activate'}
                        </button>
                        <div className="fx-note" style=${{ marginTop: '6px' }}>
                            Post FX will be limited when Shader Lab is active.
                        </div>
                        <label className="fx-check" style=${{ marginTop: '10px' }}>
                            <span>Auto-apply layer changes</span>
                            <input type="checkbox" checked=${autoApply}
                                onChange=${(e) => setAutoApply(e.target.checked)} />
                        </label>
                        ${!autoApply && html`
                            <button type="button" onClick=${() => applyNow(config)}
                                style=${{ width: '100%', marginTop: '6px' }}>
                                Apply Now
                            </button>
                        `}
                    </section>

                    <section className="fx-section">
                        <div className="fx-section-header">
                            <div className="fx-section-title">Layers (${config.layers.length})</div>
                        </div>
                        <div className="sl-add-row">
                            <select className="sl-select" value=${addType}
                                onChange=${(e) => setAddType(e.target.value)}>
                                <optgroup label="Effects">
                                    ${EFFECT_TYPES.map(t => html`<option key=${t} value=${t}>${t}</option>`)}
                                </optgroup>
                                <optgroup label="Sources">
                                    ${SOURCE_TYPES.map(t => html`<option key=${t} value=${t}>${t}</option>`)}
                                </optgroup>
                            </select>
                            <button type="button" className="sl-mini" onClick=${addLayer}>+ Add</button>
                        </div>
                        ${config.layers.length === 0
                            ? html`<div className="sl-empty">No layers — add one above.</div>`
                            : html`<div className="sl-cards">
                                ${config.layers.map((layer, i) => html`
                                    <${LayerCard}
                                        key=${layer.id}
                                        layer=${layer}
                                        index=${i}
                                        total=${config.layers.length}
                                        onUpdate=${(next) => updateLayer(layer.id, next)}
                                        onRemove=${() => removeLayer(layer.id)}
                                        onMoveUp=${() => moveLayer(i, -1)}
                                        onMoveDown=${() => moveLayer(i, 1)}
                                    />
                                `)}
                            </div>`
                        }
                    </section>
                </div>
            </div>
        `;
    };
}

export async function createShaderLabPanel({ panelEl, shaderLabFx, onHide }) {
    injectStyles();
    const { React, ReactDOMClient, htm } = await ensureReact();
    const App = buildApp({ React, htm, shaderLabFx });
    const root = ReactDOMClient.createRoot(panelEl);
    root.render(React.createElement(App, { onHide }));
    return {
        unmount() { try { root.unmount(); } catch (_) {} },
    };
}
