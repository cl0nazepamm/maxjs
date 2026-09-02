import assert from 'node:assert/strict';
import {
    normalMapOutputUsesYFlip,
    normalScaleVectorFromDescriptor,
    optimizedTextureTransformForSlot,
} from '../web/js/material_contract.js';

const invertLut = Array.from({ length: 256 }, (_, i) => Number((1 - i / 255).toFixed(3)));
const identityLut = Array.from({ length: 256 }, (_, i) => Number((i / 255).toFixed(3)));
const Vector2 = class {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }
};

assert.equal(normalMapOutputUsesYFlip({ outLut: invertLut }), true);
assert.equal(normalMapOutputUsesYFlip({ outLut: identityLut }), false);
assert.equal(normalMapOutputUsesYFlip({ outLut: invertLut, manualGamma: 2.2 }), false);
assert.equal(normalMapOutputUsesYFlip({
    outLutR: invertLut,
    outLutG: identityLut,
    outLutB: invertLut,
}), false);

const normalTransform = optimizedTextureTransformForSlot('normMap', {
    outLut: invertLut,
    tiling: [2, 3],
});
assert.equal(normalTransform.outLut, undefined);
assert.deepEqual(normalTransform.tiling, [2, 3]);

const colorTransform = optimizedTextureTransformForSlot('map', { outLut: invertLut });
assert.deepEqual(colorTransform.outLut, invertLut);

let scale = normalScaleVectorFromDescriptor({
    normScl: 0.75,
    normMapXf: { outLut: invertLut },
}, { Vector2 });
assert.deepEqual(scale, new Vector2(0.75, -0.75));

scale = normalScaleVectorFromDescriptor({
    normScl: 0.75,
    normFlipG: true,
    normMapXf: { outLut: invertLut },
}, { Vector2 });
assert.deepEqual(scale, new Vector2(0.75, 0.75));

scale = normalScaleVectorFromDescriptor({
    normScl: 0.75,
    normFlipR: true,
}, { Vector2 });
assert.deepEqual(scale, new Vector2(-0.75, 0.75));

console.log('normal-output-invert-smoke: PASS');
