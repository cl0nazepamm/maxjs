import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');
const { createLayerManager } = await import(new URL('../web/js/layer_manager.js', import.meta.url).href);

function sequence(values) {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
}

function approximately(actual, expected, message, epsilon = 1e-6) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

function singleTriangleGeometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
    ], 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
        0, 0,
        1, 0,
        0, 1,
    ], 2));
    return geometry;
}

function tagged(object, handle, parentHandle = null) {
    object.userData.maxjsHandle = handle;
    if (parentHandle != null) object.userData.maxjsParentHandle = parentHandle;
    return object;
}

const scene = new THREE.Scene();
const maxRoot = new THREE.Group();
scene.add(maxRoot);
const nodeMap = new Map();

const uvMesh = tagged(new THREE.Mesh(singleTriangleGeometry(), new THREE.MeshBasicMaterial()), 401);
uvMesh.name = 'UV_Triangle';
maxRoot.add(uvMesh);
nodeMap.set(401, uvMesh);

const brick = new THREE.MeshBasicMaterial();
brick.name = 'Brick';
const glass = new THREE.MeshBasicMaterial();
glass.name = 'Glass';
const materialGeometry = new THREE.BufferGeometry();
materialGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
], 3));
materialGeometry.addGroup(0, 3, 0);
materialGeometry.addGroup(3, 3, 1);
const materialMesh = tagged(new THREE.Mesh(materialGeometry, [brick, glass]), 410);
materialMesh.name = 'Material_Triangles';
maxRoot.add(materialMesh);
nodeMap.set(410, materialMesh);

const areaRoot = tagged(new THREE.Group(), 420);
areaRoot.name = 'Area_Root';
const areaA = tagged(new THREE.Mesh(singleTriangleGeometry(), new THREE.MeshBasicMaterial()), 421, 420);
areaA.name = 'Area_A';
const areaB = tagged(new THREE.Mesh(singleTriangleGeometry(), new THREE.MeshBasicMaterial()), 422, 420);
areaB.name = 'Area_B';
areaB.position.set(10, 0, 0);
areaB.scale.setScalar(2);
// Deliberately reverse scene insertion. Sampling order must still follow the
// stable Max handles rather than Object3D child order.
areaRoot.add(areaB, areaA);
maxRoot.add(areaRoot);
nodeMap.set(420, areaRoot);
nodeMap.set(421, areaA);
nodeMap.set(422, areaB);

const indexedGeometry = new THREE.BufferGeometry();
indexedGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
], 3));
indexedGeometry.setIndex([0, 1, 2, 3, 4, 5]);
const indexedMesh = tagged(new THREE.Mesh(indexedGeometry, new THREE.MeshBasicMaterial()), 430);
maxRoot.add(indexedMesh);
nodeMap.set(430, indexedMesh);

const changingAreaGeometry = new THREE.BufferGeometry();
changingAreaGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 4, 0, 0, 0, 4, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
], 3));
const changingAreaMesh = tagged(new THREE.Mesh(changingAreaGeometry, new THREE.MeshBasicMaterial()), 431);
maxRoot.add(changingAreaMesh);
nodeMap.set(431, changingAreaMesh);

const replacementAreaGeometry = new THREE.BufferGeometry();
replacementAreaGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 4, 0, 0, 0, 4, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
], 3));
const replacementAreaMesh = tagged(new THREE.Mesh(replacementAreaGeometry, new THREE.MeshBasicMaterial()), 432);
maxRoot.add(replacementAreaMesh);
nodeMap.set(432, replacementAreaMesh);

const attributeIdentityGeometry = new THREE.BufferGeometry();
attributeIdentityGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 4, 0, 0, 0, 4, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
], 3));
const attributeIdentityMesh = tagged(new THREE.Mesh(attributeIdentityGeometry, new THREE.MeshBasicMaterial()), 433);
maxRoot.add(attributeIdentityMesh);
nodeMap.set(433, attributeIdentityMesh);

const indexIdentityGeometry = new THREE.BufferGeometry();
indexIdentityGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
], 3));
indexIdentityGeometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 3, 4, 5]), 1));
const indexIdentityMesh = tagged(new THREE.Mesh(indexIdentityGeometry, new THREE.MeshBasicMaterial()), 434);
maxRoot.add(indexIdentityMesh);
nodeMap.set(434, indexIdentityMesh);

const degenerateGeometry = new THREE.BufferGeometry();
degenerateGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
], 3));
const degenerateMesh = tagged(new THREE.Mesh(degenerateGeometry, new THREE.MeshBasicMaterial()), 435);
maxRoot.add(degenerateMesh);
nodeMap.set(435, degenerateMesh);
scene.updateMatrixWorld(true);

const manager = createLayerManager({
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { capabilities: {}, info: {}, domElement: { width: 1, height: 1 } },
    THREE,
    nodeMap,
    maxRoot,
});

const mounted = await manager.mount('surface-sampling', (ctx) => {
    const uvNode = ctx.maxScene.getNode(401);
    const face = uvNode.sampleSurface({ rng: sequence([0, 0.2, 0.3]) });
    assert.equal(face.normalMode, 'face', 'face normals remain the compatibility default');
    approximately(face.normal.x, 0, 'face normal x');
    approximately(face.normal.y, 0, 'face normal y');
    approximately(face.normal.z, 1, 'face normal z');
    approximately(face.barycentric.x, 0.5, 'barycentric A');
    approximately(face.barycentric.y, 0.2, 'barycentric B');
    approximately(face.barycentric.z, 0.3, 'barycentric C');
    approximately(face.uv.x, 0.2, 'interpolated UV x');
    approximately(face.uv.y, 0.3, 'interpolated UV y');

    const smooth = uvNode.sampleSurface({
        rng: sequence([0, 0.2, 0.3]),
        normalMode: 'smooth',
    });
    const expectedNormal = new THREE.Vector3(0.5, 0.2, 0.3).normalize();
    assert.equal(smooth.normalMode, 'smooth');
    approximately(smooth.normal.x, expectedNormal.x, 'smooth normal x');
    approximately(smooth.normal.y, expectedNormal.y, 'smooth normal y');
    approximately(smooth.normal.z, expectedNormal.z, 'smooth normal z');

    const seededA = uvNode.sampleSurface({ count: 3, seed: 'building-42' });
    const seededB = uvNode.sampleSurface({ count: 3, seed: 'building-42' });
    const seededC = uvNode.sampleSurface({ count: 3, seed: 'building-43' });
    assert.deepEqual(
        seededA.map(hit => hit.point.toArray()),
        seededB.map(hit => hit.point.toArray()),
        'the same seed reproduces the complete sample stream',
    );
    assert.notDeepEqual(
        seededA.map(hit => hit.point.toArray()),
        seededC.map(hit => hit.point.toArray()),
        'different seeds produce different samples',
    );
    assert.notEqual(seededA[0].point, seededA[1].point, 'batch sample points do not alias');
    assert.notEqual(seededA[0].normal, seededA[1].normal, 'batch sample normals do not alias');
    assert.notEqual(seededA[0].uv, seededA[1].uv, 'batch sample UVs do not alias');
    assert.throws(
        () => uvNode.sampleSurface({ count: Infinity }),
        /count must be an integer between 0 and 100000/,
        'non-finite counts are rejected before entering a batch loop',
    );
    assert.throws(
        () => uvNode.sampleSurface({ count: Number.MAX_SAFE_INTEGER }),
        /count must be an integer between 0 and 100000/,
        'unbounded safe-integer counts cannot stall the viewport',
    );
    assert.throws(
        () => uvNode.sampleSurface({ count: 1.5 }),
        /count must be an integer between 0 and 100000/,
        'fractional counts are rejected instead of silently truncated',
    );

    const materialNode = ctx.maxScene.getNode(410);
    const glassHit = materialNode.sampleSurface({ materials: 'Glass', rng: sequence([0, 0.2, 0.2]) });
    assert.equal(glassHit.material, glass);
    assert.equal(glassHit.materialIndex, 1);
    assert.equal(glassHit.materialName, 'Glass');
    assert.ok(glassHit.point.x >= 10, 'material filtering samples only matching triangles');
    assert.equal(materialNode.sampleSurface({ materials: 'Gla*', rng: sequence([0, 0.2, 0.2]) }).material, glass);
    assert.equal(materialNode.sampleSurface({ materials: /lass/, rng: sequence([0, 0.2, 0.2]) }).material, glass);
    assert.equal(materialNode.sampleSurface({ materials: ['None', 'Glass'], rng: sequence([0, 0.2, 0.2]) }).material, glass);
    assert.equal(
        materialNode.sampleSurface({ materials: material => material === glass, rng: sequence([0, 0.2, 0.2]) }).material,
        glass,
    );
    assert.equal(materialNode.sampleSurface({ materials: 'Unknown', seed: 1 }), null, 'unknown material filters return null');
    assert.equal(
        materialNode.sampleSurface({ count: 100, materials: 'Glass', seed: 'filtered-batch' }).length,
        100,
        'filtered batch sampling reuses one prepared triangle distribution',
    );

    const areaNode = ctx.maxScene.getNode(420);
    const localAreaHit = areaNode.sampleSurface({
        areaSpace: 'local',
        rng: sequence([0.3, 0, 0.2, 0.2]),
    });
    assert.equal(localAreaHit.meshHandle, 421, 'stable handle ordering wins despite reversed child insertion');
    const exactHierarchyBoundary = areaNode.sampleSurface({
        areaSpace: 'local',
        rng: sequence([0.5, 0, 0.2, 0.2]),
    });
    assert.equal(
        exactHierarchyBoundary.meshHandle,
        422,
        'an exact hierarchy CDF boundary advances to the next positive-area child',
    );
    const worldAreaHit = areaNode.sampleSurface({
        areaSpace: 'world',
        rng: sequence([0.3, 0, 0.2, 0.2]),
    });
    assert.equal(worldAreaHit.meshHandle, 422, 'world-area weighting accounts for child scale');
    areaB.scale.setScalar(0.25);
    areaB.updateMatrixWorld(true);
    const rescaledWorldHit = areaNode.sampleSurface({
        areaSpace: 'world',
        rng: sequence([0.3, 0, 0.2, 0.2]),
    });
    assert.equal(rescaledWorldHit.meshHandle, 421, 'world-area cache invalidates after matrix scale changes');

    const indexedNode = ctx.maxScene.getNode(430);
    const beforeIndexChange = indexedNode.sampleSurface({ rng: sequence([0, 0.2, 0.2]) });
    assert.ok(beforeIndexChange.point.x < 2);
    indexedGeometry.index.array.set([3, 4, 5, 0, 1, 2]);
    indexedGeometry.index.needsUpdate = true;
    const afterIndexChange = indexedNode.sampleSurface({ rng: sequence([0, 0.2, 0.2]) });
    assert.ok(afterIndexChange.point.x >= 10, 'same-count index updates invalidate cached triangle indices');

    const changingAreaNode = ctx.maxScene.getNode(431);
    const beforeAreaChange = changingAreaNode.sampleSurface({ rng: sequence([0.5, 0.2, 0.2]) });
    assert.ok(beforeAreaChange.point.x < 5, 'initial CDF selects the initially large triangle');
    changingAreaGeometry.attributes.position.array.set([
        0, 0, 0, 0.1, 0, 0, 0, 0.1, 0,
        10, 0, 0, 14, 0, 0, 10, 4, 0,
    ]);
    changingAreaGeometry.attributes.position.needsUpdate = true;
    const afterAreaChange = changingAreaNode.sampleSurface({ rng: sequence([0.5, 0.2, 0.2]) });
    assert.ok(afterAreaChange.point.x >= 10, 'same-count position updates invalidate cached area weights');

    const replacementAreaNode = ctx.maxScene.getNode(432);
    const beforeGeometryReplacement = replacementAreaNode.sampleSurface({
        areaSpace: 'world',
        rng: sequence([0.5, 0.2, 0.2]),
    });
    assert.ok(beforeGeometryReplacement.point.x < 5);
    const sameShapeKeyReplacement = new THREE.BufferGeometry();
    sameShapeKeyReplacement.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0, 0.1, 0, 0, 0, 0.1, 0,
        10, 0, 0, 14, 0, 0, 10, 4, 0,
    ], 3));
    replacementAreaMesh.geometry = sameShapeKeyReplacement;
    const afterGeometryReplacement = replacementAreaNode.sampleSurface({
        areaSpace: 'world',
        rng: sequence([0.5, 0.2, 0.2]),
    });
    assert.ok(
        afterGeometryReplacement.point.x >= 10,
        'world-area cache invalidates when a same-shape-key geometry object replaces the source',
    );

    const attributeIdentityNode = ctx.maxScene.getNode(433);
    assert.ok(attributeIdentityNode.sampleSurface({ rng: sequence([0.5, 0.2, 0.2]) }).point.x < 5);
    attributeIdentityGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0, 0.1, 0, 0, 0, 0.1, 0,
        10, 0, 0, 14, 0, 0, 10, 4, 0,
    ], 3));
    assert.ok(
        attributeIdentityNode.sampleSurface({ rng: sequence([0.5, 0.2, 0.2]) }).point.x >= 10,
        'same-version position attribute replacement invalidates topology cache',
    );

    const indexIdentityNode = ctx.maxScene.getNode(434);
    assert.ok(indexIdentityNode.sampleSurface({ rng: sequence([0, 0.2, 0.2]) }).point.x < 2);
    indexIdentityGeometry.setIndex(new THREE.BufferAttribute(new Uint16Array([3, 4, 5, 0, 1, 2]), 1));
    assert.ok(
        indexIdentityNode.sampleSurface({ rng: sequence([0, 0.2, 0.2]) }).point.x >= 10,
        'same-version index attribute replacement invalidates topology cache',
    );

    const degenerateHit = ctx.maxScene.getNode(435).sampleSurface({ rng: sequence([0, 0.2, 0.2]) });
    assert.equal(degenerateHit.triangleIndex, 1, 'zero-area triangles are skipped at the CDF lower boundary');

    materialGeometry.clearGroups();
    materialGeometry.addGroup(0, 3, 1);
    materialGeometry.addGroup(3, 3, 0);
    const regroupedGlass = materialNode.sampleSurface({ materials: 'Glass', rng: sequence([0, 0.2, 0.2]) });
    assert.ok(regroupedGlass.point.x < 2, 'material group edits invalidate filtered distributions');
    return {};
});

assert.equal(mounted.error, null, 'surface sampling layer mounts');
manager.remove('surface-sampling');

console.log('layer surface sampling smoke: PASS');
