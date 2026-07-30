import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as THREE from '../web/node_modules/three/build/three.module.js';
import { createLayerParamController } from '../web/js/layer_params.js';

const changes = [];
const controller = createLayerParamController({
    THREE,
    emitChange: event => changes.push(event),
});
const layer = {
    id: 'params-smoke',
    loading: false,
    hooks: null,
    disposers: [],
};

controller.initLayer(layer);
const params = controller.createFacade(layer);
const values = params.define({
    count: 12,
    mode: 'orbit',
    numericLabel: '007',
    tint: '#336699',
    enabled: true,
    gain: { value: 0.5, min: 0, max: 1 },
});

assert.equal(values.count, 12, 'untyped numbers must infer as float, not color');
assert.equal(params.list().find(entry => entry.name === 'count')?.type, 'float');
assert.equal(values.mode, 'orbit', 'plain strings must round-trip');
assert.equal(params.list().find(entry => entry.name === 'mode')?.type, 'string');
assert.equal(values.numericLabel, '007');
assert.equal(params.list().find(entry => entry.name === 'numericLabel')?.type, 'string');
assert.equal(params.list().find(entry => entry.name === 'tint')?.type, 'color');
assert.equal(params.list().find(entry => entry.name === 'enabled')?.type, 'bool');
assert.equal(params.list().find(entry => entry.name === 'gain')?.type, 'slider');

assert.equal(params.set('mode', 'follow'), 'follow');
assert.equal(values.mode, 'follow');
assert.equal(params.set('count', '18'), 18);
assert.equal(values.count, 18);
assert.ok(changes.length >= 1);

const panelSource = readFileSync(
    new URL('../web/js/editor/panels_misc.js', import.meta.url),
    'utf8',
);
assert.match(panelSource, /param\?\.type === 'string'/,
    'layer panel preserves string display values');
assert.match(panelSource, /layer-param-text/,
    'layer panel renders a text input for string parameters');
assert.match(
    panelSource,
    /if \(param && commit\)[\s\S]*persistLayerParameterValue\?\.\(layerId, name, param\.value\)/,
    'layer panel persists only committed parameter values',
);

console.log('layer-params-smoke: OK');
