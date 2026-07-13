import assert from 'node:assert/strict';
import { createSpectralMaterialSystem } from '../web/js/layer_spectral.js';

const material = (name, nirAlbedo) => ({
    name,
    userData: nirAlbedo == null ? {} : { nirAlbedo },
});
const object = (name, handle, parent, materials = null) => ({
    name,
    isMesh: materials != null,
    material: materials,
    userData: { maxjsParentHandle: parent },
});

const leaf = material('Leaf_Oak');
const bark = material('Bark_Oak', 0.2);
const asphalt = material('Asphalt_Main');
const nodeMap = new Map([
    [1, object('Vegetation', 1, 0)],
    [2, object('Oak_01', 2, 1, [leaf, bark])],
    [3, object('Road_Main', 3, 0, asphalt)],
]);
const decorators = new Map();
const changes = [];
const setMaterialDecorator = (_layerId, handle, key, fn) => {
    decorators.set(`${handle}:${key}`, fn);
    fn(nodeMap.get(handle), handle);
};
const clearMaterialDecorator = (handle, key) => decorators.delete(`${handle}:${key}`);
const getAdapter = handle => ({ handle, name: nodeMap.get(handle)?.name });

const system = createSpectralMaterialSystem({
    nodeMap,
    setMaterialDecorator,
    clearMaterialDecorator,
    onChange: event => changes.push(event),
});
const spectral = system.createLayerFacade('test', getAdapter);

const foliage = spectral.setNirAlbedo({
    under: 'Vegetation',
    materials: 'Leaf*',
}, 0.55);
assert.deepEqual(foliage.matched, [2]);
assert.equal(leaf.userData.nirAlbedo, 0.55);
assert.equal(bark.userData.nirAlbedo, 0.2);

const lateLeaf = material('Leaf_Maple');
nodeMap.set(4, object('Maple_01', 4, 1, lateLeaf));
system.update();
assert.equal(lateLeaf.userData.nirAlbedo, 0.55);
assert.deepEqual(foliage.matched, [2, 4]);

const bakedLeaf = material('Runtime_Bake');
bakedLeaf.userData.maxjsSourceMaterialName = 'Leaf_Source';
nodeMap.set(5, object('Baked_Leaf', 5, 1, bakedLeaf));
system.update();
assert.equal(bakedLeaf.userData.nirAlbedo, 0.55);

const rebuiltLeaf = material('Leaf_Oak_Rebuilt');
nodeMap.get(2).material = [rebuiltLeaf, bark];
system.update();
assert.equal(leaf.userData.nirAlbedo, undefined);
assert.equal(rebuiltLeaf.userData.nirAlbedo, 0.55);

const road = spectral.setNirAlbedo({
    objects: 'Road*',
    materialPrefix: 'Asphalt',
}, 0.06);
assert.deepEqual(road.matched, [3]);
assert.equal(asphalt.userData.nirAlbedo, 0.06);
road.set(0.08);
assert.equal(asphalt.userData.nirAlbedo, 0.08);
road.set(2);
assert.equal(asphalt.userData.nirAlbedo, 1);
road.set(0.08);

const override = spectral.setNirAlbedo({ materials: /^Leaf_/ }, 0.9);
assert.equal(rebuiltLeaf.userData.nirAlbedo, 0.9);
override.dispose();
assert.equal(rebuiltLeaf.userData.nirAlbedo, 0.55);

foliage.dispose();
road.dispose();
assert.equal(rebuiltLeaf.userData.nirAlbedo, undefined);
assert.equal(lateLeaf.userData.nirAlbedo, undefined);
assert.equal(bakedLeaf.userData.nirAlbedo, undefined);
assert.equal(asphalt.userData.nirAlbedo, undefined);
assert.equal(bark.userData.nirAlbedo, 0.2);

const automatic = spectral.setNirAlbedo('Road*', 0.1);
assert.equal(asphalt.userData.nirAlbedo, 0.1);
system.disposeLayer('test');
assert.equal(automatic.active, false);
assert.equal(asphalt.userData.nirAlbedo, undefined);
assert.ok(changes.length >= 4);

console.log('spectral-layer-smoke: OK');
