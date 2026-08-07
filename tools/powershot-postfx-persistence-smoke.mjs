import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../web/js/editor/postfx_glue.js', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const adapterSource = await readFile(
    new URL('../web/js/fx/final/powershot.js', import.meta.url),
    'utf8',
);
const maxjsFxSource = await readFile(
    new URL('../web/js/maxjs_fx.js', import.meta.url),
    'utf8',
);
const testableSource = source
    .replace(
        "import * as THREE from 'three';",
        'const THREE = {};',
    )
    .replace(
        "import { powerShotInfraredPresetUiDefaults } from '../fx/final/powershot.js';",
        `const powerShotInfraredPresetUiDefaults = () => ({
            irExposure: 0,
            irInputGamma: 1,
            irResponse: 1,
            irLocalGain: 0.5,
            irGlow: 0.25,
            irGlowThreshold: 0.5,
            irNoise: 0.5,
            irVignette: 0.25,
            irHotspot: 0.05,
        });`,
    )
    .replace(
        "import { getHostProfile } from '../host_profile.js';",
        "const getHostProfile = () => ({ app: 'Max' });",
    );
const moduleUrl = `data:text/javascript;base64,${Buffer.from(testableSource).toString('base64')}`;

globalThis.window = {
    addEventListener() {},
};

const { createPostFxGlue } = await import(moduleUrl);

const normalizerSource = adapterSource.match(
    /const POWERSHOT_DEFAULT_INFRARED_PRESET[\s\S]+?^}\r?$(?=\r?\n\r?\n\/\/ Flat UI)/m,
)?.[0];
assert.ok(normalizerSource, 'PowerShot infrared normalizer remains testable');
const makeNormalizer = new Function(
    'POWERSHOT_INFRARED_PRESETS',
    'POWERSHOT_INFRARED_PRESET_KEYS',
    `${normalizerSource.replace('export function', 'function')}
    return normalizePowerShotInfraredPreset;`,
);
const normalizeInfraredPreset = makeNormalizer({
    white_phosphor: { input_mode: 'rgb' },
    white_phosphor_nir: { input_mode: 'nir' },
    gen3_white_phosphor: { input_mode: 'rgb' },
    gen3_white_phosphor_nir: { input_mode: 'nir' },
}, [
    'white_phosphor',
    'white_phosphor_nir',
    'gen3_white_phosphor',
    'gen3_white_phosphor_nir',
]);
assert.equal(
    normalizeInfraredPreset('white_phosphor'),
    'gen3_white_phosphor_nir',
    'obsolete RGB saves resolve directly to the current true-NIR default',
);
assert.equal(
    normalizeInfraredPreset('white_phosphor_nir'),
    'white_phosphor_nir',
    'the selectable Ethereal true-NIR profile remains valid',
);
assert.equal(
    normalizeInfraredPreset('gen3_white_phosphor_nir'),
    'gen3_white_phosphor_nir',
    'the current Gen 3 true-NIR profile remains valid',
);
assert.doesNotMatch(
    maxjsFxSource,
    /source\.infraredPreset\s*===\s*['"]white_phosphor['"]/,
    'restore stays free of one-off legacy infrared migration branches',
);

const exposureHelpersSource = adapterSource.match(
    /function exposureLinearToStops[\s\S]+?(?=\r?\nexport function normalizePowerShotPreset)/,
)?.[0];
assert.ok(exposureHelpersSource, 'PowerShot input-exposure helpers remain testable');
const setInputExposure = new Function(
    `${exposureHelpersSource}
    return setPowerShotInputExposure;`,
)();
for (const mode of ['digital', 'analog']) {
    let appliedStops = null;
    setInputExposure({ setInputExposure: (stops) => { appliedStops = stops; } }, mode, 2, {
        inputExposure: -0.25,
    });
    assert.equal(appliedStops, 0.75, `${mode} stacks its PowerShot exposure with viewer exposure`);
}
let infraredStops = null;
setInputExposure({ setInputExposure: (stops) => { infraredStops = stops; } }, 'infrared', 2, {
    inputExposure: -0.25,
});
assert.equal(infraredStops, 1, 'NIR modes keep their separate exposure control');
assert.match(
    source,
    /key: 'inputExposure', label: 'Exposure \(stops\)', min: -12, max: 12,[^\n]+visibleWhen: isPowerShotIspMode/,
    'the -12 to +12 Exposure (stops) slider stays visible in the digital and analog modes',
);
assert.match(
    adapterSource,
    /p\.inputExposure = THREE\.MathUtils\.clamp\(finiteOr\(p\.inputExposure, 0\), -12, 12\)/,
    'PowerShot input exposure is normalized to the full slider range',
);
assert.match(
    maxjsFxSource,
    /assignFinite\(state\.powershot, 'inputExposure', options\.inputExposure\)/,
    'PowerShot input exposure has a persisted state setter',
);

const powershot = {
    enabled: true,
    mode: 'infrared',
    preset: 'powershot',
    amount: 0.81,
    resolutionScale: 0.65,
    inputExposure: -0.25,
    lensSoftness: 0.21,
    ccdBloom: 0.42,
    noiseScale: 0.63,
    bayerNR: 0.24,
    chromaNR: 0.45,
    jpegStrength: 0.66,
    jpegQuality: 77,
    jpegChroma420: 0.28,
    jpegMidtone: 0.49,
    jpegHighlight: 1.1,
    brightness: -0.12,
    contrast: 0.23,
    analogStrength: 0.74,
    analogTracking: 0.35,
    analogTrackingChoppiness: 0.56,
    analogChromaBleed: 0.47,
    analogRinging: 0.58,
    analogTapeNoise: 0.69,
    analogBandMask: 0.31,
    analogEdgeWave: 0.22,
    analogDropouts: 0.13,
    analogScanlines: 0.84,
    analogHeadSwitch: 0.95,
    filmStock: 'kodak_250d',
    filmExposure: -0.4,
    filmInputGamma: 0.76,
    filmGrain: 1.17,
    filmGrainSize: 1.8,
    filmGrainColour: 0.59,
    filmHalation: 0.38,
    filmHalationThreshold: 0.61,
    filmHalationRadius: 1.9,
    filmPrintExposure: -0.2,
    filmPrintWarmth: 0.14,
    filmHighlightBurn: 0.72,
    filmHueRestore: 0.33,
    filmWeave: 0.44,
    filmFlicker: 0.15,
    filmNegative: true,
    infraredPreset: 'gen3_white_phosphor_nir',
    irIlluminator: 1.35,
    irExposure: -0.55,
    irInputGamma: 1.13,
    irResponse: 0.73,
    irLocalGain: 0.64,
    irGlow: 0.46,
    irGlowThreshold: 0.37,
    irElectronModel: true,
    irElectronsPerUnit: 1536,
    irNoise: 0.57,
    irVignette: 0.29,
    irHotspot: 0.07,
    nsSmear: 1.2,
    freezeNoise: true,
};

const writes = [];
const fxState = { powershot };
const deps = {
    btnPostFxPanel: {},
    maxjsFx: {
        getState: () => fxState,
        getPowerShotFilmStocks: () => [],
        getPowerShotInfraredPresets: () => [],
        getPowerShotPresets: () => [],
    },
    serializeSnapshotUiState: () => ({ marker: 'ui-state' }),
    _projectRuntimeRef: {
        setPostFxState(payload) {
            writes.push(payload);
            return Promise.resolve(true);
        },
    },
    onShaderLabSnapshotChange() {},
    reportBridgeError(_label, error) {
        throw error;
    },
};

let glue;
try {
    glue = createPostFxGlue(deps);
} catch (error) {
    throw new Error(`createPostFxGlue fixture failed: ${error?.message || error}`);
}
glue.savePostFxState();

assert.equal(
    writes.length,
    1,
    'a committed edit must enter the host write path before the page can restart',
);
assert.deepEqual(
    writes[0].fx.powershot,
    powershot,
    'the persisted payload must contain every PowerShot parameter without panel filtering',
);

glue.savePostFxState();
assert.equal(writes.length, 1, 'unchanged snapshots remain deduplicated');

fxState.powershot = { ...powershot, irResponse: 0.41 };
glue.savePostFxState();
assert.equal(writes.length, 2, 'the next committed PowerShot value writes immediately');
assert.equal(writes[1].fx.powershot.irResponse, 0.41);

console.log('powershot-postfx-persistence-smoke: OK');
