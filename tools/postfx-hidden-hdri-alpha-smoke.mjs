import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const coreSource = readFileSync(
    new URL('../web/js/fx/core.js', import.meta.url),
    'utf8',
);
const ssrSource = readFileSync(
    new URL('../web/js/fx/effects/ssr.js', import.meta.url),
    'utf8',
);
const renderSources = [
    readFileSync(new URL('../web/js/maxjs_fx.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../web/js/snapshot_fx.js', import.meta.url), 'utf8'),
];

assert.doesNotMatch(coreSource, /useEnvironmentBackdropCompensation|applyBackdropCompensation/,
    'hidden HDRI must not erase far-depth transparent or additive beauty pixels');
assert.doesNotMatch(coreSource, /hasGeom\.select\(currentBeauty\.rgb,\s*(?:vec3\()?0/,
    'post-FX beauty must not be replaced with black based only on scene depth');

for (const source of renderSources) {
    assert.doesNotMatch(source, /scene\.background\s*=\s*scene\.environment/,
        'SSR must not force a hidden HDRI into the scene beauty background');
}

assert.match(ssrSource, /getFallbackEnvironment\(ctx\.THREE\)/,
    'stochastic SSR keeps a valid black miss texture');
assert.match(ssrSource, /ssrPass\.environmentIntensity\.value\s*=\s*0/,
    'SSR misses do not add HDRI lighting a second time');
assert.match(ssrSource, /ctx\.beauty\.rgb\.add\(reflectionNode\.rgb\),\s*ctx\.beautyAlpha/,
    'SSR remains additive and preserves the accumulated beauty alpha');

console.log('postfx-hidden-hdri-alpha-smoke: PASS');
