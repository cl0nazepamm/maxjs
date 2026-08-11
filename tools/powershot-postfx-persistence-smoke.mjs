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
// The exposure contract: one plate-gain knob in stops, before the imager,
// for EVERY mode — film stacks it with the stock trim, NIR modes stack it
// with their own irExposure mode trim.
for (const mode of ['digital', 'analog', 'film', 'infrared', 'nightshot']) {
    let appliedStops = null;
    setInputExposure({ setInputExposure: (stops) => { appliedStops = stops; } }, mode, 2, {
        inputExposure: -0.25,
    });
    assert.equal(appliedStops, 0.75, `${mode} stacks its PowerShot exposure with viewer exposure`);
}
// Published-version fallbacks: old FilmPipelines (no setInputExposure) must
// stay untouched — their only knob is the stock trim, and writing host gain
// there is the reset-on-preset-swap bug the contract exists to fix.
const legacyFilmExposure = { value: 5 };
setInputExposure({ ctx: { P: { exposure: legacyFilmExposure } } }, 'film', 2, {
    inputExposure: -0.25,
});
assert.equal(legacyFilmExposure.value, 5, 'legacy film pipelines keep their stock trim untouched');
const legacyInfraredExposure = { value: 0 };
setInputExposure({ ctx: { P: { exposure: legacyInfraredExposure } } }, 'infrared', 2, {
    inputExposure: -0.25, irExposure: 3,
});
assert.equal(legacyInfraredExposure.value, 3.75, 'legacy NIR pipelines fold plate gain into their mode trim');
assert.match(
    source,
    /key: 'inputExposure', label: 'Exposure \(stops\)', min: -12, max: 12, step: 0\.05, realtime: true \}/,
    'the -12 to +12 Exposure (stops) slider is visible in every PowerShot mode',
);
const powerShotSectionSource = source.match(
    /key: 'powershot',[\s\S]+?(?=\r?\n\s*\{\r?\n\s*key: 'dof')/,
)?.[0];
assert.ok(powerShotSectionSource, 'PowerShot section remains testable');
assert.doesNotMatch(
    powerShotSectionSource,
    /\{ key: '(?:brightness|contrast)', label:/,
    'PowerShot has no duplicate grade controls; the main Look controls own them',
);
// filmExposure has no control row on purpose: film.js sums P.exposure with
// ctx.inputExposure into ONE gain at ONE point (exp2(a + b), before the H&D
// curve), so a second slider was the same knob twice. The key stays live in
// state so saved scenes keep round-tripping; only the duplicate UI is gone.
// (Print Exposure is unrelated — a printer-light offset in the log10 density
// domain after the negative develops.)
assert.doesNotMatch(
    source,
    /key: 'filmExposure', label:/,
    'film exposure has no duplicate slider next to the plate gain',
);
assert.match(
    adapterSource,
    /p\.filmExposure = THREE\.MathUtils\.clamp\(finiteOr\(p\.filmExposure, 0\), -12, 12\)/,
    'filmExposure still normalizes so existing scenes keep their baked trim',
);
// Same duplication in infrared.js:142 — exp2u(P.exposure.add(inputExposure)).
// irExposure keeps carrying the tube preset's baked trim (unlike the film
// stocks it is non-zero, ~0.85) and still feeds the legacy no-setInputExposure
// fallback above; it just has no redundant slider of its own.
assert.doesNotMatch(
    source,
    /key: 'irExposure', label:/,
    'NIR exposure has no duplicate slider next to the plate gain',
);
assert.match(
    adapterSource,
    /irExposure: preset\.exposure \?\? 0\.85/,
    'NIR presets still seed their own exposure trim',
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
