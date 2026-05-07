// max_basis.js — 3ds Max (Z-up) ↔ Three.js (Y-up) basis conversion.
//
// Lifted from inline code in web/index.html (~lines 1587-1653) so that
// scene_init.js, scene_applier.js, and any future module can share one
// canonical set of helpers instead of re-deriving them.
//
// Math:
//   Max world basis is +Z up, right-handed.
//   Three.js world basis is +Y up, right-handed.
//   Conversion is a -90° rotation about the X axis applied to positions,
//   directions, and matrices.
//
// All scene content authored in Max should sit beneath a "max basis root"
// group with rotation.x = -PI/2; runtime objects (jsRoot) live outside that
// group and reason in standard Three.js Y-up world space.

import * as THREE from 'three/webgpu';
import * as THREE_STD from 'three';

export const MAX_TO_WORLD_ROTATION_X = -Math.PI / 2;

export const MAX_TO_WORLD_QUATERNION = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(MAX_TO_WORLD_ROTATION_X, 0, 0, 'XYZ'));

export const WORLD_TO_MAX_QUATERNION = MAX_TO_WORLD_QUATERNION.clone().invert();

export const MAX_TO_WORLD_MATRIX = new THREE.Matrix4()
    .makeRotationFromQuaternion(MAX_TO_WORLD_QUATERNION);

export const MAX_TO_WORLD_MATRIX_STD = new THREE_STD.Matrix4()
    .makeRotationX(MAX_TO_WORLD_ROTATION_X);

/** Reads `[x, y, z]` array, plain object, or typed-array into a Vector3 target. */
export function readVector3(target, value) {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        target.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
        return target;
    }
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
        target.set(value.x, value.y, value.z);
        return target;
    }
    target.set(0, 0, 0);
    return target;
}

/** Three-element array of Max-space coordinates → Y-up Vector3. */
export function copyMaxArrayToWorld(target, values) {
    target.set(values[0], values[1], values[2]);
    target.applyQuaternion(MAX_TO_WORLD_QUATERNION);
    return target;
}

/** Three Max-space scalars → Y-up Vector3. */
export function copyMaxComponentsToWorld(target, x, y, z) {
    target.set(x, y, z);
    target.applyQuaternion(MAX_TO_WORLD_QUATERNION);
    return target;
}

/** Max-space 16-float matrix array → Y-up Matrix4. */
export function copyMaxMatrixArrayToWorld(target, matrixArray) {
    target.fromArray(matrixArray);
    target.premultiply(MAX_TO_WORLD_MATRIX);
    return target;
}

export function copyMaxMatrixArrayToWorldStd(target, matrixArray) {
    target.fromArray(matrixArray);
    target.premultiply(MAX_TO_WORLD_MATRIX_STD);
    return target;
}

/** Frozen scene-space namespace mirroring index.html's `sceneSpace` object. */
export const sceneSpace = Object.freeze({
    maxUpAxis: Object.freeze(new THREE.Vector3(0, 0, 1)),
    worldUpAxis: Object.freeze(new THREE.Vector3(0, 1, 0)),
    toWorldPosition(value, target = new THREE.Vector3()) {
        return readVector3(target, value).applyQuaternion(MAX_TO_WORLD_QUATERNION);
    },
    toWorldDirection(value, target = new THREE.Vector3()) {
        return readVector3(target, value).applyQuaternion(MAX_TO_WORLD_QUATERNION);
    },
    toWorldMatrix(value, target = new THREE.Matrix4()) {
        return copyMaxMatrixArrayToWorld(target, value);
    },
    toMaxPosition(value, target = new THREE.Vector3()) {
        return readVector3(target, value).applyQuaternion(WORLD_TO_MAX_QUATERNION);
    },
});
