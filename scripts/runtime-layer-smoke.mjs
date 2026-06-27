import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');
const { createLayerManager } = await import(new URL('../web/js/layer_manager.js', import.meta.url).href);

function disposableMesh(name, flags) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    geometry.dispose = () => { flags.geometry = true; };
    material.dispose = () => { flags.material = true; };
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    return mesh;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
const renderer = {
    capabilities: {},
    info: {},
    domElement: { width: 800, height: 600 },
};
const maxNodeFlags = {};
const maxNode = disposableMesh('max-node', maxNodeFlags);
const nodeMap = new Map([[101, maxNode]]);
let visibilityEvents = 0;
let lastVisibilityEvent = null;
let runtimeSceneEvents = 0;
let lastRuntimeSceneEvent = null;

const manager = createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap,
    onRuntimeVisibilityChanged(event) {
        visibilityEvents++;
        lastVisibilityEvent = event;
    },
    onRuntimeSceneChanged(event) {
        runtimeSceneEvents++;
        lastRuntimeSceneEvent = event;
    },
});

const removedFlags = {};
const disposedFlags = {};
const trackedFlags = {};
let removed = null;
let disposed = null;
let tracked = null;
let params = null;
let paramEvent = null;

const mountResult = await manager.mount('runtime-smoke', (ctx) => {
    params = ctx.params.define({
        speed: { type: 'slider', value: 1, min: 0, max: 2, step: 0.1 },
        lift: { type: 'float', value: 3.5, step: 0.1 },
        tint: { type: 'color', value: '#336699' },
    });
    ctx.params.onChange((event) => {
        paramEvent = event;
    });
    assert.equal(params.speed, 1, 'ctx.params.define creates live numeric values');
    assert.equal(params.tint, '#336699', 'ctx.params.define normalizes color values');

    removed = ctx.js.add(disposableMesh('remove-me', removedFlags));
    assert.equal(removed.parent, ctx.group, 'ctx.js.add parents runtime objects under the layer group');
    assert.equal(ctx.js.remove(removed), true, 'ctx.js.remove returns true for JS-owned Object3Ds');
    assert.equal(removed.parent, null, 'ctx.js.remove detaches the object');
    assert.equal(removedFlags.geometry, true, 'ctx.js.remove disposes owned geometry');
    assert.equal(removedFlags.material, true, 'ctx.js.remove disposes owned material');

    disposed = ctx.js.add(disposableMesh('dispose-me', disposedFlags));
    ctx.js.dispose(disposed);
    assert.equal(disposed.parent, null, 'ctx.js.dispose detaches Object3Ds before freeing resources');
    assert.equal(disposedFlags.geometry, true, 'ctx.js.dispose disposes owned geometry');
    assert.equal(disposedFlags.material, true, 'ctx.js.dispose disposes owned material');

    tracked = ctx.js.add(disposableMesh('tracked-me', trackedFlags));
    ctx.js.track(tracked);
    assert.equal(tracked.parent, ctx.group, 'tracked Object3D starts parented for teardown test');

    const sceneEventBaseline = runtimeSceneEvents;
    assert.ok(sceneEventBaseline >= 5, 'ctx.js graph mutations notify host scene changes');

    const maxNodeAdapter = ctx.maxScene.getNode(101);
    assert.ok(maxNodeAdapter, 'ctx.maxScene exposes Max node adapters');
    maxNodeAdapter.hide();
    assert.equal(visibilityEvents, 1, 'runtime node hide notifies host visibility changes');
    assert.equal(lastVisibilityEvent?.handle, 101, 'visibility event includes node handle');
    assert.equal(lastVisibilityEvent?.visible, false, 'visibility event includes hidden state');
    assert.equal(maxNode.layers.mask, 0x80000000, 'runtime hide moves Max node to hidden layer');
    maxNodeAdapter.hide();
    assert.equal(visibilityEvents, 1, 'repeated runtime hide does not notify unchanged visibility');
    maxNodeAdapter.show();
    assert.equal(visibilityEvents, 2, 'runtime node show notifies host visibility changes');
    assert.equal(lastVisibilityEvent?.visible, true, 'visibility event includes visible state');
    assert.equal(maxNode.layers.mask, 1, 'runtime show restores visible layer');
    assert.equal(maxNodeAdapter.resetVisibility(), true, 'runtime visibility reset clears override');
    assert.equal(visibilityEvents, 3, 'runtime visibility reset notifies host visibility changes');
    assert.equal(lastVisibilityEvent?.reset, true, 'visibility reset event is flagged');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 3, 'visibility changes also notify runtime scene changes');

    assert.equal(maxNodeAdapter.transform.setPosition(2, 0, 0), true, 'runtime transform override applies');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 4, 'runtime transform override notifies host scene changes');
    assert.equal(lastRuntimeSceneEvent?.type, 'transform', 'runtime transform event is typed');
    assert.equal(maxNodeAdapter.resetTransform(), true, 'runtime transform reset clears override');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 5, 'runtime transform reset notifies host scene changes');

    const overrideTexture = new THREE.Texture();
    assert.equal(maxNodeAdapter.setMap('map', overrideTexture), true, 'runtime material map override applies');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 6, 'runtime material map override notifies host scene changes');
    assert.equal(lastRuntimeSceneEvent?.type, 'materialMap', 'runtime material map event is typed');
    assert.equal(maxNodeAdapter.setMap('map', overrideTexture), false, 'unchanged runtime material map override is ignored');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 6, 'unchanged runtime material map override does not notify');
    assert.equal(maxNodeAdapter.setMap('map', null), true, 'runtime material map override clears');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 7, 'runtime material map clear notifies host scene changes');

    assert.equal(maxNodeAdapter.overrides.setProperty('castShadow', true), true, 'runtime property override applies');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 8, 'runtime property override notifies host scene changes');
    assert.equal(lastRuntimeSceneEvent?.type, 'property', 'runtime property event is typed');
    assert.equal(maxNodeAdapter.overrides.setProperty('castShadow', true), true, 'unchanged runtime property override remains a valid override');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 8, 'unchanged runtime property override does not notify');
    assert.equal(maxNodeAdapter.overrides.clearProperty('castShadow', { restoreValue: false }), true, 'runtime property override clears');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 9, 'runtime property clear notifies host scene changes');

    return {};
});

assert.equal(mountResult.error, null, 'runtime layer mounted without lifecycle errors');
const speedParam = manager.setParameter('runtime-smoke', 'speed', '1.7');
assert.equal(speedParam.value, 1.7, 'manager.setParameter updates slider values from UI strings');
assert.equal(params.speed, 1.7, 'ctx.params live proxy reflects manager updates');
assert.equal(paramEvent?.name, 'speed', 'ctx.params.onChange receives manager updates');
assert.equal(paramEvent?.value, 1.7, 'ctx.params.onChange receives coerced values');

const tintParam = manager.setParameter('runtime-smoke', 'tint', [1, 0.5, 0]);
assert.equal(tintParam.value, '#ff8000', 'manager.setParameter normalizes RGB array colors');
assert.equal(params.tint, '#ff8000', 'ctx.params live proxy reflects color updates');

const layerSnapshot = manager.getLayerSnapshot('runtime-smoke');
assert.equal(layerSnapshot.parameters.length, 3, 'layer snapshots include parameter metadata');
assert.equal(layerSnapshot.parameters.find(p => p.name === 'speed')?.value, 1.7, 'layer snapshots include current parameter values');

const runtimeSnapshot = manager.serializeSnapshot();
assert.equal(runtimeSnapshot.layers[0].parameters.find(p => p.name === 'tint')?.value, '#ff8000', 'runtime snapshots include parameter values');

const remountResult = await manager.mount('runtime-smoke', (ctx) => {
    params = ctx.params.define({
        speed: { type: 'slider', value: 0.2, min: 0, max: 2, step: 0.1 },
    });
    return {};
});
assert.equal(remountResult.error, null, 'runtime layer remounts without lifecycle errors');
assert.equal(params.speed, 1.7, 'hot reload preserves stored parameter values by layer id');

assert.equal(manager.remove('runtime-smoke'), true, 'layer remove succeeds');
assert.equal(tracked.parent, null, 'layer teardown detaches tracked Object3Ds');
assert.equal(trackedFlags.geometry, true, 'layer teardown disposes tracked geometry');
assert.equal(trackedFlags.material, true, 'layer teardown disposes tracked material');

console.log('runtime layer smoke ok');
