#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const volumetric = readFileSync(join(root, 'web/js/fx/effects/volumetric.js'), 'utf8');
const maxLights = readFileSync(join(root, 'web/js/max_lights_node.js'), 'utf8');
const vendoredThree = readFileSync(join(root, 'web/vendor/three-r185/build/three.webgpu.js'), 'utf8');
const pointBatch = readFileSync(
    join(root, 'web/vendor/three-r185/examples/tsl/lighting/data/PointLightDataNode.js'),
    'utf8',
);
const spotBatch = readFileSync(
    join(root, 'web/vendor/three-r185/examples/tsl/lighting/data/SpotLightDataNode.js'),
    'utf8',
);

assert.match(
    vendoredThree,
    /lightNode\.light\.distance === undefined/,
    'the upstream volume model guard changed; re-evaluate this compatibility fix',
);
assert.match(pointBatch, /lightNode:\s*\{\s*light:\s*\{\}/s);
assert.match(spotBatch, /lightNode:\s*\{\s*light:\s*\{\}/s);

assert.doesNotMatch(volumetric, /\.lightsNode\s*=/);
assert.match(maxLights, /const FINITE_DISTANCE_LIGHT_NODE/);
assert.match(maxLights, /class FinitePointLightDataNode extends PointLightDataNode/);
assert.match(maxLights, /class FiniteSpotLightDataNode extends SpotLightDataNode/);
assert.match(maxLights, /PointLight:\s*FinitePointLightDataNode/);
assert.match(maxLights, /SpotLight:\s*FiniteSpotLightDataNode/);
assert.ok(
    (maxLights.match(/lightNode:\s*FINITE_DISTANCE_LIGHT_NODE/g) ?? []).length >= 4,
    'all linked and unlinked point/spot batches must advertise finite-light semantics',
);
assert.match(volumetric, /volMat\.userData\.maxjsIgnoreLightLinks\s*=\s*true/);
assert.match(volumetric, /ctx\.camera\.getWorldPosition\(v\.cameraPosition\)/);
assert.match(volumetric, /v\.mesh\.position\.copy\(v\.cameraPosition\)/);
assert.match(volumetric, /v\.mesh\.scale\.setScalar\(diameter\)/);
assert.ok(
    (maxLights.match(/materialIgnoresLightLinks\(builder\)/g) ?? []).length >= 5,
    'linked batched and fallback lights must bypass masks for opted-out materials',
);

console.log('volumetric light source smoke: ok');
