import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r184/build/three.cjs');
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

const manager = createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap: new Map(),
});

const removedFlags = {};
const disposedFlags = {};
const trackedFlags = {};
let removed = null;
let disposed = null;
let tracked = null;

const mountResult = await manager.mount('runtime-smoke', (ctx) => {
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

    return {};
});

assert.equal(mountResult.error, null, 'runtime layer mounted without lifecycle errors');
assert.equal(manager.remove('runtime-smoke'), true, 'layer remove succeeds');
assert.equal(tracked.parent, null, 'layer teardown detaches tracked Object3Ds');
assert.equal(trackedFlags.geometry, true, 'layer teardown disposes tracked geometry');
assert.equal(trackedFlags.material, true, 'layer teardown disposes tracked material');

console.log('runtime layer smoke ok');
