import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');
const { createLayerManager } = await import(new URL('../web/js/layer_manager.js', import.meta.url).href);

function morphMesh(name, handle, blink = 0.2, squint = 0.1) {
    const mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial(),
    );
    mesh.name = name;
    mesh.userData.maxjsHandle = handle;
    mesh.morphTargetDictionary = { Blink: 0, Squint: 1 };
    mesh.morphTargetInfluences = [blink, squint];
    return mesh;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
const renderer = {
    capabilities: {},
    info: {},
    domElement: { width: 640, height: 480 },
};
const maxRoot = new THREE.Group();
const original = morphMesh('Face', 101);
maxRoot.add(original);
scene.add(maxRoot);
const nodeMap = new Map([[101, original]]);

const manager = createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap,
    maxRoot,
});

let morph = null;
const mounted = await manager.mount('morph-smoke', (ctx) => {
    morph = ctx.morph;
    return {};
});
assert.equal(mounted.error, null);

const retainedInfluences = original.morphTargetInfluences;
assert.deepEqual(
    morph.list(101).map(channel => [channel.name, channel.index, channel.value]),
    [['Blink', 0, 0.2], ['Squint', 1, 0.1]],
    'ctx.morph.list exposes snapshot delta channels and current weights',
);
assert.equal(morph.get('Face', 'Blink'), 0.2, 'targets resolve by exact object name');
assert.equal(morph.set(101, 'Blink', 0.8), true, 'named morph channel accepts an absolute override');
assert.strictEqual(
    original.morphTargetInfluences,
    retainedInfluences,
    'morph writes retain the original influence array',
);
assert.equal(original.morphTargetInfluences[0], 0.8);
assert.equal(morph.has(101, 'Blink'), true);

// Animation/fast-sync can write between frames. beforeRender must retain that
// newest authored value underneath the runtime override, then reapply the layer.
original.morphTargetInfluences[0] = 0.35;
manager.beforeRender(1);
assert.equal(original.morphTargetInfluences[0], 0.8, 'render-time reapply wins after animation');
assert.equal(morph.clear(101, 'Blink'), true);
assert.equal(original.morphTargetInfluences[0], 0.35, 'clear restores the newest authored value');

assert.equal(morph.set(original, 'Squint', 0.25, { mode: 'additive' }), true);
assert.equal(original.morphTargetInfluences[1], 0.35, 'additive mode offsets the authored weight');
assert.equal(morph.clear(original, 'Squint'), true);
assert.equal(original.morphTargetInfluences[1], 0.1);

// Full scene sync may replace the Three object and every morph container.
// The override resolves the fresh delta dictionary instead of holding old data.
assert.equal(morph.set(101, 'Blink', 0.7), true);
const replacement = morphMesh('Face', 101, 0.15, 0.05);
maxRoot.remove(original);
maxRoot.add(replacement);
nodeMap.set(101, replacement);
manager.beforeRender(2);
assert.equal(replacement.morphTargetInfluences[0], 0.7, 'override survives a rebuilt render object');

replacement.morphTargetInfluences[0] = 0.25;
manager.beforeRender(3);
assert.equal(replacement.morphTargetInfluences[0], 0.7);
assert.equal(morph.clear(101, 'Blink'), true);
assert.equal(replacement.morphTargetInfluences[0], 0.25, 'rebuilt object restores its own authored base');

assert.equal(morph.set(101, 0, 2, { clamp: true }), true, 'numeric channel indices are supported');
assert.equal(replacement.morphTargetInfluences[0], 1, 'optional clamp constrains a channel to 0..1');
assert.equal(morph.clear(101, 0), true);
assert.equal(replacement.morphTargetInfluences[0], 0.25);

assert.equal(morph.set(101, 'Blink', 0.9), true);
assert.equal(manager.remove('morph-smoke'), true);
assert.equal(replacement.morphTargetInfluences[0], 0.25, 'layer removal restores owned morph channels');

console.log('morph layer smoke: ok');
