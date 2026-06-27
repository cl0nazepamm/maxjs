import assert from 'node:assert/strict';
import * as THREE from '../web/node_modules/three/build/three.webgpu.js';
import { buildSpectralScene } from '../web/js/spectral_scene.js';
import { buildKernels } from '../web/js/spectral_kernel.js';

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

const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    alphaTest: 0.1,
});
const mesh = new THREE.Mesh(geometry, material);
const scene = new THREE.Scene();
scene.add(mesh);
scene.add(new THREE.PointLight(0xffffff, 1));

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
const built = buildSpectralScene({ THREE, scene, camera });
assert.equal(built?.error, null, 'spectral scene builds for kernel construction');

const buffers = {
    bvhNodes: new THREE.StorageBufferAttribute(built.bvhNodes, 1),
    triIndex: new THREE.StorageBufferAttribute(built.triIndex, 1),
    vertexData: new THREE.StorageBufferAttribute(built.vertexData, 1),
    triMaterial: new THREE.StorageBufferAttribute(built.triMaterial, 1),
    materials: new THREE.StorageBufferAttribute(built.materials, 1),
    lights: new THREE.StorageBufferAttribute(built.lights, 1),
    accum: new THREE.StorageBufferAttribute(new Float32Array(4 * 4 * 4), 1),
    lightCount: built.lightCount,
    nodeCount: built.nodeCount,
};

const kernels = buildKernels({
    THREE,
    buffers,
    env: built.env,
    maps: built.maps,
    width: 4,
    height: 4,
});

assert.ok(kernels?.traceKernel, 'trace kernel constructs');
assert.ok(kernels?.clearKernel, 'clear kernel constructs');
assert.ok(kernels?.blitMaterial, 'blit material constructs');

console.log('spectral kernel construct smoke ok');
