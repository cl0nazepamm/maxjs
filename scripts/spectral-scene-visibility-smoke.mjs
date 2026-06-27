import assert from 'node:assert/strict';
import * as THREE from '../web/node_modules/three/build/three.module.js';
import { buildSpectralScene } from '../web/js/spectral_scene.js';

function triangleGeometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
    ]), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
    ]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
        0, 0,
        1, 0,
        0, 1,
    ]), 2));
    return geometry;
}

function triangleMesh(name, material = new THREE.MeshBasicMaterial({ color: 0xffffff })) {
    const mesh = new THREE.Mesh(triangleGeometry(), material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    return mesh;
}

function twoMaterialMesh() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        1, 0, 0,
        1, 1, 0,
        0, 1, 0,
    ]), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
    ]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 0,
        1, 1,
        0, 1,
    ]), 2));
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    const visibleMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const hiddenMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    hiddenMat.visible = false;
    const mesh = new THREE.Mesh(geometry, [visibleMat, hiddenMat]);
    mesh.matrixAutoUpdate = false;
    return mesh;
}

function partialGroupedArrayMesh() {
    const mesh = twoMaterialMesh();
    mesh.name = 'partial-grouped-material-array';
    mesh.geometry.clearGroups();
    mesh.geometry.addGroup(0, 3, 0);
    return mesh;
}

function invalidGroupedArrayMesh() {
    const mesh = triangleMesh('invalid-grouped-material-array', [
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
    ]);
    mesh.geometry.addGroup(0, 3, 4);
    return mesh;
}

function ungroupedArrayMesh() {
    return triangleMesh('ungrouped-material-array', [
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
    ]);
}

function sharedVertexTwoMaterialMesh() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        1, 1, 0,
    ]), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
    ]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 1,
    ]), 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    const red = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const blue = new THREE.MeshBasicMaterial({ color: 0x0000ff });
    const mesh = new THREE.Mesh(geometry, [red, blue]);
    mesh.name = 'shared-vertex-two-material-array';
    mesh.matrixAutoUpdate = false;
    return mesh;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
camera.layers.enable(2);

scene.add(triangleMesh('visible-layer-0'));

const hiddenByLayer = triangleMesh('hidden-by-max-self-layer');
hiddenByLayer.visible = true;
hiddenByLayer.userData.maxjsVisible = false;
hiddenByLayer.layers.set(31);
scene.add(hiddenByLayer);

const hiddenByObject = triangleMesh('hidden-by-object-visible');
hiddenByObject.visible = false;
scene.add(hiddenByObject);

const hiddenMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
hiddenMaterial.visible = false;
scene.add(triangleMesh('hidden-by-material-visible', hiddenMaterial));

const hiddenParentSurface = triangleMesh('hidden-parent-surface-visible-child');
hiddenParentSurface.layers.set(31);
const visibleChild = triangleMesh('visible-child-under-hidden-surface');
hiddenParentSurface.add(visibleChild);
scene.add(hiddenParentSurface);

const layerTwo = triangleMesh('camera-layer-2');
layerTwo.layers.set(2);
scene.add(layerTwo);

scene.add(twoMaterialMesh());
scene.add(partialGroupedArrayMesh());
scene.add(invalidGroupedArrayMesh());
scene.add(ungroupedArrayMesh());
scene.add(sharedVertexTwoMaterialMesh());

const fullyTransparent = new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0, transparent: true });
scene.add(triangleMesh('hidden-by-zero-opacity', fullyTransparent));

const backSideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });
scene.add(triangleMesh('back-side-material-state', backSideMaterial));

const doubleSideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
scene.add(triangleMesh('double-side-material-state', doubleSideMaterial));

const alphaTestMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    opacity: 0.25,
    transparent: true,
    alphaTest: 0.5,
});
scene.add(triangleMesh('alpha-test-material-state', alphaTestMaterial));

const lightVisible = new THREE.PointLight(0xffffff, 1);
scene.add(lightVisible);
const lightHiddenByLayer = new THREE.PointLight(0xffffff, 1);
lightHiddenByLayer.layers.set(31);
scene.add(lightHiddenByLayer);
const lightHiddenByObject = new THREE.PointLight(0xffffff, 1);
lightHiddenByObject.visible = false;
scene.add(lightHiddenByObject);
const lightZeroIntensity = new THREE.PointLight(0xffffff, 0);
scene.add(lightZeroIntensity);
const lightBlack = new THREE.PointLight(0x000000, 1);
scene.add(lightBlack);

const built = buildSpectralScene({ THREE, scene, camera });
assert.equal(built?.error, null, 'spectral scene builds');
assert.equal(built.triCount, 10, 'PT flattener matches raster visibility for object, layer, material, group, and zero-opacity hides');
assert.equal(built.lightCount, 1, 'PT light collection respects object and layer visibility');

const stride = built.strides.MAT_STRIDE;
const materialRecords = [];
for (let i = 0; i < built.materialCount; i++) {
    const base = i * stride;
    materialRecords.push({
        opacity: built.materials[base + 10],
        side: built.materials[base + 22],
        alphaTest: built.materials[base + 23],
    });
}
const materialIdsByColor = new Map();
for (let i = 0; i < built.materialCount; i++) {
    const base = i * stride;
    const key = `${Math.round(built.materials[base] * 255)},${Math.round(built.materials[base + 1] * 255)},${Math.round(built.materials[base + 2] * 255)}`;
    if (!materialIdsByColor.has(key)) materialIdsByColor.set(key, []);
    materialIdsByColor.get(key).push(i);
}
const triMaterialIds = new Set([...built.triMaterial]);
assert.ok((materialIdsByColor.get('255,0,0') ?? []).some((id) => triMaterialIds.has(id)), 'PT preserves red material group on shared vertices');
assert.ok((materialIdsByColor.get('0,0,255') ?? []).some((id) => triMaterialIds.has(id)), 'PT preserves blue material group on shared vertices');
assert.ok(materialRecords.some((m) => m.side === THREE.BackSide), 'PT material table preserves BackSide');
assert.ok(materialRecords.some((m) => m.side === THREE.DoubleSide), 'PT material table preserves DoubleSide');
assert.ok(materialRecords.some((m) => Math.abs(m.opacity - 0.25) < 1e-6 && Math.abs(m.alphaTest - 0.5) < 1e-6), 'PT material table carries alpha-test state');

console.log('spectral scene visibility smoke ok');
