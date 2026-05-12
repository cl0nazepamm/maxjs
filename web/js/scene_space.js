// Max Z-up <-> Three.js Y-up coordinate boundary.

import * as THREE from 'three';
import * as THREE_STD from 'three-std';

const MAX_TO_WORLD_ROTATION_X = -Math.PI / 2;
const MAX_TO_WORLD_QUATERNION = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(MAX_TO_WORLD_ROTATION_X, 0, 0, 'XYZ'));
const WORLD_TO_MAX_QUATERNION = MAX_TO_WORLD_QUATERNION.clone().invert();
const MAX_TO_WORLD_MATRIX = new THREE.Matrix4()
    .makeRotationFromQuaternion(MAX_TO_WORLD_QUATERNION);
const MAX_TO_WORLD_MATRIX_STD = new THREE_STD.Matrix4()
    .makeRotationX(MAX_TO_WORLD_ROTATION_X);

function readVector3(target, value) {
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

function copyMaxArrayToWorld(target, values) {
    target.set(values[0], values[1], values[2]);
    target.applyQuaternion(MAX_TO_WORLD_QUATERNION);
    return target;
}

function copyMaxComponentsToWorld(target, x, y, z) {
    target.set(x, y, z);
    target.applyQuaternion(MAX_TO_WORLD_QUATERNION);
    return target;
}

function copyMaxMatrixArrayToWorld(target, matrixArray) {
    target.fromArray(matrixArray);
    target.premultiply(MAX_TO_WORLD_MATRIX);
    return target;
}

function copyMaxMatrixArrayToWorldStd(target, matrixArray) {
    target.fromArray(matrixArray);
    target.premultiply(MAX_TO_WORLD_MATRIX_STD);
    return target;
}

const sceneSpace = Object.freeze({
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

export {
    copyMaxArrayToWorld,
    copyMaxComponentsToWorld,
    copyMaxMatrixArrayToWorld,
    copyMaxMatrixArrayToWorldStd,
    sceneSpace,
};
