import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');
const { createLayerManager } = await import(new URL('../web/js/layer_manager.js', import.meta.url).href);

function positionOf(matrix) {
    return new THREE.Vector3().setFromMatrixPosition(matrix);
}

function approximately(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`);
}

const scene = new THREE.Scene();
const maxRoot = new THREE.Group();
maxRoot.name = '__max_root__';
scene.add(maxRoot);

const kitRoot = new THREE.Group();
kitRoot.name = 'KIT_Building';
kitRoot.position.set(10, 0, 0);
kitRoot.userData.maxjsHandle = 200;

const wallMaterialA = new THREE.MeshBasicMaterial({ color: 0x6699cc });
wallMaterialA.name = 'Wall_Base';
const wallMaterialB = new THREE.MeshStandardMaterial({ color: 0x223344 });
wallMaterialB.name = 'Wall_Trim';
const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.2), [wallMaterialA, wallMaterialB]);
wall.name = 'Wall_A';
wall.position.set(2, 0, 0);
wall.userData.maxjsHandle = 201;
wall.userData.maxjsParentHandle = 200;
wall.userData.maxjsUserProps = 'module = wall';

const corner = new THREE.Mesh(
    new THREE.BoxGeometry(1, 3, 1),
    new THREE.MeshStandardMaterial({ color: 0x777777 }),
);
corner.name = 'Corner_A';
corner.position.set(-3, 0, 0);
corner.userData.maxjsHandle = 202;
corner.userData.maxjsParentHandle = 200;
corner.userData.maxjsUserProps = 'module = corner';

const eastSocket = new THREE.Group();
eastSocket.name = 'Socket_East';
eastSocket.position.set(5, 0, 0);
eastSocket.userData.maxjsHandle = 203;
eastSocket.userData.maxjsParentHandle = 200;
eastSocket.userData.maxjsUserProps = 'socket = east\nsocketFor = wall\nsocketType = wall';

kitRoot.add(wall, corner, eastSocket);
maxRoot.add(kitRoot);

const classicMaterialA = new THREE.MeshBasicMaterial({ color: 0x884422 });
const classicMaterialB = new THREE.MeshStandardMaterial({ color: 0x228844 });
const classicSource = new THREE.Mesh(
    new THREE.BoxGeometry(1, 2, 1),
    [classicMaterialA, classicMaterialB],
);
classicSource.name = 'Classic_Block';
classicSource.userData.maxjsHandle = 204;
maxRoot.add(classicSource);

const shearedSource = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x555555 }),
);
shearedSource.name = 'Sheared_Block';
shearedSource.userData.maxjsHandle = 205;
shearedSource.matrixAutoUpdate = false;
shearedSource.matrix.set(
    1, 0.25, 0, 25,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
);
maxRoot.add(shearedSource);
scene.updateMatrixWorld(true);

const nodeMap = new Map([
    [200, kitRoot],
    [201, wall],
    [202, corner],
    [203, eastSocket],
    [204, classicSource],
    [205, shearedSource],
]);
const renderer = {
    capabilities: {},
    info: {},
    domElement: { width: 800, height: 600 },
};
let runtimeEvents = 0;
const manager = createLayerManager({
    scene,
    camera: new THREE.PerspectiveCamera(50, 1, 0.1, 1000),
    renderer,
    THREE,
    nodeMap,
    maxRoot,
    onRuntimeSceneChanged() { runtimeEvents += 1; },
});

let followBatch;
let isolatedBatch;
let mirroredBatch;
let detachedBatch;
let kit;
let kitBatch;
let moduleBatch;
let kitInstance;
let layerContext;

const mounted = await manager.mount('mesh-reuse', (ctx) => {
    layerContext = ctx;
    corner.userData.jsmod = true;
    assert.throws(
        () => ctx.js.instanceFromMax(202, { capacity: 1 }),
        /three\.js Deform/,
        'three.js Deform sources are rejected by the static-instancing v1 contract',
    );
    delete corner.userData.jsmod;

    followBatch = ctx.js.instanceFromMax(201, {
        capacity: 2,
        snapshotId: 'direct-walls',
    });
    assert.ok(followBatch, 'ctx.js.instanceFromMax creates a batch from a static Max mesh');
    assert.equal(followBatch.raw.parent, ctx.group, 'direct batches live under the layer root');
    assert.equal(followBatch.raw.geometry, wall.geometry, 'follow geometry binds the authoritative Max resource once');
    assert.equal(followBatch.raw.material, wall.material, 'follow materials preserve the authoritative Multi/Sub stack');
    assert.equal(followBatch.raw.userData.maxjsOwner, 'js', 'the InstancedMesh itself is layer-owned');
    assert.equal(wall.geometry.userData.maxjsOwner, 'max', 'followed geometry remains Max-owned');
    assert.equal(followBatch.raw.material[1], wallMaterialB, 'followed Multi/Sub material identity is preserved');

    const foreignParent = new THREE.Group();
    const childrenBeforeRejectedAllocations = ctx.group.children.length;
    assert.throws(
        () => ctx.js.instanceFromMax(201, { capacity: Infinity }),
        /capacity must be an integer between 1 and 100000/,
        'non-finite capacities are rejected before allocation',
    );
    assert.throws(
        () => ctx.js.instanceFromMax(201, { capacity: 100001 }),
        /capacity must be an integer between 1 and 100000/,
        'runaway instance allocations are bounded per batch',
    );
    assert.throws(
        () => ctx.js.instanceFromMax(201, { capacity: 1, parent: foreignParent }),
        /parent must belong to this layer/,
        'generated meshes cannot escape layer ownership or snapshot traversal',
    );
    assert.equal(foreignParent.children.length, 0);
    assert.throws(
        () => ctx.js.instanceFromMax(201, {
            capacity: 1,
            transforms: [new THREE.Matrix4().makeScale(-1, 1, 1)],
            space: 'local',
        }),
        /negatively scaled/,
        'invalid constructor transforms fail transactionally',
    );
    assert.equal(
        ctx.group.children.length,
        childrenBeforeRejectedAllocations,
        'failed constructors leave no registered or parented ghost batch',
    );

    assert.equal(followBatch.add({ at: [100, 0, 0] }), 0, 'first direct instance gets dense index zero');
    assert.equal(followBatch.add({ at: [110, 0, 0], rotationEuler: [0, Math.PI / 2, 0] }), 1);
    assert.equal(followBatch.add({ at: [120, 0, 0] }), -1, 'fixed capacity fails cleanly with -1');
    assert.throws(
        () => followBatch.setMatrixAt(0, new THREE.Matrix4().makeScale(-1, 1, 1), { space: 'local' }),
        /negatively scaled/,
        'negative determinant matrices are rejected explicitly',
    );
    followBatch.flush();
    approximately(positionOf(followBatch.getWorldMatrixAt(0)).x, 100, 'direct world-space placement');
    assert.equal(followBatch.removeAt(0), true, 'removeAt uses dense swap-last removal');
    assert.equal(followBatch.count, 1);
    approximately(positionOf(followBatch.getWorldMatrixAt(0)).x, 110, 'removeAt moves the last transform');
    followBatch.clear();
    followBatch.addMany([{ at: [100, 0, 0] }, { at: [110, 0, 0] }]);

    const mirroredParent = ctx.js.createGroup('mirrored-parent');
    mirroredParent.scale.set(-1, 1, 1);
    mirroredParent.updateMatrixWorld(true);
    mirroredBatch = ctx.js.instanceFromMax(201, { capacity: 1, parent: mirroredParent });
    assert.throws(
        () => mirroredBatch.add({ at: [130, 0, 0] }),
        /negatively scaled/,
        'validation checks the final batch-local matrix under mirrored parents',
    );
    const mirroredWorld = new THREE.Matrix4().makeScale(-1, 1, 1);
    mirroredWorld.setPosition(130, 0, 0);
    assert.equal(
        mirroredBatch.add(mirroredWorld),
        0,
        'a negative world matrix is valid when a mirrored parent yields a positive local determinant',
    );
    assert.ok(mirroredBatch.getMatrixAt(0).determinant() > 0);
    mirroredBatch.flush();

    isolatedBatch = ctx.js.instanceFromMax(204, {
        capacity: 1,
        geometry: 'clone',
        materials: 'clone',
        snapshotId: 'isolated-classic',
    });
    isolatedBatch.add({ at: [150, 0, 0] });
    isolatedBatch.flush();
    assert.notEqual(isolatedBatch.raw.geometry, classicSource.geometry, 'clone geometry is isolated once per batch');
    assert.notEqual(isolatedBatch.raw.material, classicSource.material, 'classic material arrays are isolated once per batch');

    const quaternionBatch = ctx.js.instanceFromMax(204, { capacity: 1 });
    quaternionBatch.add({ quaternion: [1, 0, 0, 0] }, { space: 'local' });
    const halfTurnMatrix = quaternionBatch.getMatrixAt(0);
    approximately(halfTurnMatrix.elements[5], -1, 'quaternion array preserves an exact zero w component');
    approximately(halfTurnMatrix.elements[10], -1, 'zero-w quaternion represents a 180 degree turn');

    const shearBatch = ctx.js.instanceFromMax(205, { count: 1 });
    assert.deepEqual(
        shearBatch.getWorldMatrixAt(0).toArray(),
        shearedSource.matrixWorld.toArray(),
        'default placement preserves an authored shear matrix exactly',
    );
    const shearCoefficient = shearBatch.getWorldMatrixAt(0).elements[4];
    shearBatch.setPositionAt(0, [30, 1, 2]);
    approximately(
        shearBatch.getWorldMatrixAt(0).elements[4],
        shearCoefficient,
        'setPositionAt changes translation without decomposing away shear',
    );
    assert.equal(shearBatch.getMatrixAt(0.5), null, 'fractional instance indices are rejected');

    detachedBatch = ctx.js.instanceFromMax(204, { capacity: 1 });
    detachedBatch.raw.removeFromParent();

    corner.userData.maxjsUserProps = 'module = wall';
    assert.throws(
        () => ctx.kits.capture('KIT_Building'),
        /duplicate module id "wall"/,
        'duplicate authored module ids fail early instead of becoming unstable selectors',
    );
    corner.userData.maxjsUserProps = 'module = corner';
    kit = ctx.kits.capture('KIT_Building');
    assert.ok(kit, 'ctx.kits.capture accepts a helper/group root');
    assert.deepEqual(kit.parts.map(part => part.id), ['wall', 'corner'], 'module user props provide stable part ids');
    assert.deepEqual(kit.sockets.map(socket => socket.id), ['wall:east'], 'kit socket ids are module-qualified');
    assert.equal(kit.getPart('wall').handle, 201);
    assert.equal(kit.module('wall').handle, 201, 'kit.module resolves a reusable module record');
    assert.equal(kit.module('wall').getSocket('east').handle, 203, 'module sockets use local ids');
    assert.equal(kit.getSocket('wall:east').handle, 203);
    assert.throws(
        () => kit.module('wall').instantiate({ parent: foreignParent }),
        /parent must belong to this layer/,
        'one-off module copies stay inside the owning layer',
    );

    moduleBatch = kit.module('wall').createInstances({ capacity: 1, snapshotId: 'wall-modules' });
    assert.equal(
        moduleBatch.addAtSocket('east', new THREE.Matrix4().makeTranslation(300, 0, 0)),
        0,
        'module batches can align an authored socket to a target matrix',
    );
    moduleBatch.flush();
    approximately(moduleBatch.getSocketPositionAt(0, 'east').x, 300, 'module socket alignment is exact');

    kitBatch = kit.createInstances({
        capacity: 2,
        snapshotId: 'building-blocks',
    });
    assert.equal(kitBatch.batches.length, 2, 'a multi-mesh kit uses one InstancedMesh per part');
    assert.equal(kitBatch.batches[0].removeAt, undefined, 'whole-kit child batches expose read-only views');
    assert.equal(kitBatch.batches[0].add, undefined, 'child structural mutation cannot corrupt kit index alignment');
    assert.equal(kitBatch.batches[0].raw, undefined, 'child views do not expose mutable InstancedMesh objects');
    assert.equal(kitBatch.add({ at: [50, 0, 0] }), 0);
    kitBatch.flush();
    const escapedWallRaw = kitBatch.raw.children.find(
        object => object.userData.maxjsSourceHandle === 201,
    );
    escapedWallRaw.count = 0;
    assert.throws(
        () => kitBatch.flush(),
        /mutated directly and lost index alignment/,
        'the explicit raw escape is detected before safe kit mutations continue',
    );
    escapedWallRaw.count = kitBatch.count;
    const wallPartBatch = kitBatch.batches[0];
    approximately(positionOf(wallPartBatch.getWorldMatrixAt(0)).x, 52, 'captured part-local transform composes with kit placement');
    approximately(kitBatch.getSocketPositionAt(0, 'wall:east').x, 55, 'socket query composes to world space');
    assert.equal(kitBatch.add({ at: [100, 0, 0] }), 1);
    assert.equal(kitBatch.removeAt(0), true);
    approximately(kitBatch.getSocketPositionAt(0, 'wall:east').x, 105, 'kit removal keeps part/socket indices aligned');
    kitBatch.flush();

    kitInstance = kit.instantiate({
        at: [200, 0, 0],
        snapshotId: 'building-copy',
    });
    assert.equal(kitInstance.clones.length, 2, 'one-off kit instantiation clones the captured hierarchy');
    approximately(positionOf(kitInstance.clones[0].matrixWorld).x, 202, 'one-off kit preserves part-local transforms');
    approximately(kitInstance.getSocketPosition('wall:east').x, 205, 'one-off kit exposes authored socket transforms');
    return {};
});

assert.equal(mounted.error, null, 'mesh reuse layer mounts');
assert.ok(runtimeEvents > 0, 'batch and kit mutations notify runtime scene serialization');

const snapshot = manager.serializeSnapshot();
assert.ok(snapshot.jsRoot, 'runtime snapshot includes generated kit content');
const parsedRoot = new THREE.ObjectLoader().parse(snapshot.jsRoot);
const parsedInstances = [];
parsedRoot.traverse(object => {
    if (object.isInstancedMesh) parsedInstances.push(object);
});
assert.ok(parsedInstances.length >= 4, 'InstancedMesh objects survive runtimeScene JSON round-trip');
const parsedDirect = parsedInstances.find(object => object.userData.maxjsSnapshotId === 'runtime:mesh-reuse:direct-walls');
assert.equal(parsedDirect?.count, 2, 'snapshot round-trip preserves logical instance count');
approximately(positionOf(parsedDirect.getMatrixAt(1, new THREE.Matrix4())).x, 110, 'snapshot round-trip preserves instance matrices');
assert.ok(
    parsedInstances.some(object => object.userData.maxjsSnapshotId === 'runtime:mesh-reuse:building-blocks:part:wall'),
    'kit part snapshot ids derive from stable authored module ids',
);
assert.ok(
    parsedInstances.some(object => object.userData.maxjsSnapshotId === 'runtime:mesh-reuse:building-blocks:part:corner'),
    'reordering captured parts cannot renumber snapshot ids',
);

const detachedKitClone = kitInstance.clones[0];
let detachedKitCloneGeometryDisposeCount = 0;
detachedKitClone.geometry.dispose = () => { detachedKitCloneGeometryDisposeCount += 1; };
detachedKitClone.removeFromParent();

const followedRaw = followBatch.raw;
const isolatedRaw = isolatedBatch.raw;
const moduleRaw = moduleBatch.raw;
const detachedRaw = detachedBatch.raw;
const isolatedGeometry = isolatedRaw.geometry;
const isolatedMaterials = isolatedRaw.material;
const kitPartRaws = kitBatch.raw.children
    .filter(object => object.isInstancedMesh)
    .sort((a, b) => Number(a.userData.maxjsSourceHandle) - Number(b.userData.maxjsSourceHandle));
let followedDisposeCount = 0;
let isolatedDisposeCount = 0;
let kitDisposeCount = 0;
let detachedDisposeCount = 0;
followedRaw.dispose = () => { followedDisposeCount += 1; };
isolatedRaw.dispose = () => { isolatedDisposeCount += 1; };
for (const raw of kitPartRaws) raw.dispose = () => { kitDisposeCount += 1; };
moduleRaw.dispose = () => { kitDisposeCount += 1; };
detachedRaw.dispose = () => { detachedDisposeCount += 1; };
let isolatedGeometryDisposeCount = 0;
isolatedGeometry.dispose = () => { isolatedGeometryDisposeCount += 1; };
let isolatedMaterialDisposeCount = 0;
for (const material of isolatedMaterials) {
    material.dispose = () => { isolatedMaterialDisposeCount += 1; };
}

const replacementGeometry = new THREE.BoxGeometry(4, 3, 0.2);
const replacementMaterial = new THREE.MeshBasicMaterial({ color: 0xff8844 });
replacementMaterial.name = 'Wall_Replaced';
let replacementGeometryDisposeCount = 0;
let replacementMaterialDisposeCount = 0;
replacementGeometry.dispose = () => { replacementGeometryDisposeCount += 1; };
replacementMaterial.dispose = () => { replacementMaterialDisposeCount += 1; };
wall.geometry = replacementGeometry;
wall.material = replacementMaterial;
const replacementClassicGeometry = new THREE.BoxGeometry(2, 2, 2);
const replacementClassicMaterials = [
    new THREE.MeshBasicMaterial({ color: 0xffcc00 }),
    new THREE.MeshStandardMaterial({ color: 0x00ccff }),
];
classicSource.geometry = replacementClassicGeometry;
classicSource.material = replacementClassicMaterials;
manager.update(1 / 60, 0);
assert.equal(followedRaw.geometry, replacementGeometry, 'follow batch adopts source geometry replacement before layer update');
assert.equal(followedRaw.material, replacementMaterial, 'follow batch adopts source material replacement before layer update');
assert.equal(isolatedRaw.geometry, isolatedGeometry, 'isolated classic batch ignores source geometry replacement');
assert.equal(isolatedRaw.material, isolatedMaterials, 'isolated classic batch ignores source material replacement');
assert.equal(kitPartRaws[0].geometry, replacementGeometry, 'captured kit batches follow the module source');
assert.equal(moduleRaw.geometry, replacementGeometry, 'module-only batches follow their source');

nodeMap.delete(201);
manager.update(1 / 60, 1 / 60);
assert.equal(followedRaw.visible, false, 'follow batch hides while its source resource is absent');
assert.equal(kitPartRaws[0].visible, false, 'kit part batch also hides while its source is absent');
assert.equal(moduleRaw.visible, false, 'module-only batch hides while its source is absent');
nodeMap.set(201, wall);
manager.update(1 / 60, 2 / 60);
assert.equal(followedRaw.visible, true, 'follow batch restores after source resync');
assert.equal(kitPartRaws[0].visible, true, 'kit part batch restores after source resync');
assert.equal(moduleRaw.visible, true, 'module-only batch restores after source resync');

assert.equal(isolatedBatch.refresh(), true, 'isolated batch supports explicit atomic source refresh');
assert.notEqual(isolatedRaw.geometry, replacementClassicGeometry, 'refresh still clones isolated geometry');
assert.notEqual(isolatedRaw.material, replacementClassicMaterials, 'refresh still clones isolated classic materials');
assert.equal(isolatedGeometryDisposeCount, 1, 'isolated refresh disposes the previous geometry clone');
assert.equal(isolatedMaterialDisposeCount, 2, 'isolated refresh disposes the previous material clones');

assert.equal(manager.remove('mesh-reuse'), true, 'mesh reuse layer removes');
assert.equal(followedDisposeCount, 1, 'layer teardown disposes InstancedMesh GPU state once');
assert.equal(isolatedDisposeCount, 1, 'isolated InstancedMesh GPU state is disposed once');
assert.equal(kitDisposeCount, 3, 'module and whole-kit InstancedMesh GPU state is disposed once');
assert.equal(detachedDisposeCount, 1, 'detached registered batches are still disposed during layer teardown');
assert.equal(
    detachedKitCloneGeometryDisposeCount,
    1,
    'detached one-off kit clones remain tracked and dispose their private geometry',
);
assert.equal(replacementGeometryDisposeCount, 0, 'layer teardown never disposes followed Max geometry');
assert.equal(replacementMaterialDisposeCount, 0, 'layer teardown never disposes followed Max material');
assert.equal(layerContext.js.instanceFromMax(201, { capacity: 1 }), null, 'stale contexts cannot allocate new batches');
assert.equal(kitBatch.disposed, true, 'whole-kit handles retire with their layer');
assert.equal(kitBatch.raw, null, 'retired whole-kit handles do not expose swept roots');
assert.equal(kitInstance.disposed, true, 'one-off kit handles retire with their layer');
assert.equal(kitInstance.raw, null, 'retired one-off kit handles do not expose swept roots');

// Use the real r185 WebGPU node-material class as a focused resource-policy
// check. The CJS fixture above intentionally stays classic so ObjectLoader can
// validate the baked emergency runtimeScene tree.
const THREE_WEBGPU = await import(new URL('../web/vendor/three-r185/build/three.webgpu.js', import.meta.url).href);
const tslScene = new THREE_WEBGPU.Scene();
const tslRoot = new THREE_WEBGPU.Group();
const tslMaterial = new THREE_WEBGPU.MeshStandardNodeMaterial({ color: 0x44aaff });
tslMaterial.userData.maxjsMaterialModel = 'MeshTSLNodeMaterial';
const tslSource = new THREE_WEBGPU.Mesh(new THREE_WEBGPU.BoxGeometry(1, 1, 1), tslMaterial);
tslSource.name = 'TSL_Block';
tslSource.userData.maxjsHandle = 900;
tslSource.userData.maxjsUserProps = 'module = tsl-block';
tslRoot.add(tslSource);
tslScene.add(tslRoot);
const tslManager = createLayerManager({
    scene: tslScene,
    camera: new THREE_WEBGPU.PerspectiveCamera(),
    renderer: { capabilities: {}, info: {}, domElement: { width: 1, height: 1 } },
    THREE: THREE_WEBGPU,
    nodeMap: new Map([[900, tslSource]]),
    maxRoot: tslRoot,
});
const tslMounted = await tslManager.mount('tsl-instance-policy', (ctx) => {
    const followed = ctx.js.instanceFromMax(900, { capacity: 1 });
    assert.equal(followed.raw.material, tslMaterial, 'follow mode keeps the exact real TSL material object');
    assert.equal(followed.raw.material.isNodeMaterial, true);
    assert.throws(
        () => ctx.js.instanceFromMax(900, { capacity: 1, materials: 'clone' }),
        /NodeMaterial cloning is shallow.*follow/,
        'real NodeMaterial clone mode fails explicitly instead of sharing its node graph accidentally',
    );
    const tslKit = ctx.kits.capture(900);
    assert.throws(
        () => tslKit.module('tsl-block').instantiate(),
        /NodeMaterial cloning is shallow.*createInstances/,
        'one-off module instantiation cannot shallow-clone a real TSL graph',
    );
    assert.throws(
        () => tslKit.instantiate(),
        /NodeMaterial cloning is shallow.*createInstances/,
        'one-off whole-kit instantiation cannot shallow-clone a real TSL graph',
    );
    followed.add({ at: [0, 0, 0] });
    followed.flush();
    return {};
});
assert.equal(tslMounted.error, null, 'real WebGPU TSL instance policy fixture mounts');
tslManager.remove('tsl-instance-policy');

console.log('layer mesh reuse smoke: PASS');
