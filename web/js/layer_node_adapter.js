// Runtime Max node adapter and surface sampling helpers.

import { freezePlainObject } from './layer_utils.js';

const surfaceTopologyCache = new WeakMap();

function getSurfaceTopologyCache(geometry, THREE) {
    const position = geometry?.getAttribute?.('position') ?? geometry?.attributes?.position;
    if (!position || position.itemSize < 3 || position.count < 3) return null;

    const index = geometry.index ?? null;
    const topologyKey = `${index?.count ?? 0}:${position.count}`;
    const cached = surfaceTopologyCache.get(geometry);
    if (cached?.topologyKey === topologyKey) return cached;

    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    if (triangleCount <= 0) return null;

    const triangleIndices = new Uint32Array(triangleCount * 3);
    const cumulativeAreas = new Float32Array(triangleCount);
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const edgeAB = new THREE.Vector3();
    const edgeAC = new THREE.Vector3();
    const cross = new THREE.Vector3();

    let totalArea = 0;

    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
        const offset = triangleIndex * 3;
        const iA = index ? index.getX(offset) : offset;
        const iB = index ? index.getX(offset + 1) : offset + 1;
        const iC = index ? index.getX(offset + 2) : offset + 2;

        triangleIndices[offset] = iA;
        triangleIndices[offset + 1] = iB;
        triangleIndices[offset + 2] = iC;

        vA.fromBufferAttribute(position, iA);
        vB.fromBufferAttribute(position, iB);
        vC.fromBufferAttribute(position, iC);

        edgeAB.subVectors(vB, vA);
        edgeAC.subVectors(vC, vA);
        cross.crossVectors(edgeAB, edgeAC);
        totalArea += cross.length() * 0.5;
        cumulativeAreas[triangleIndex] = totalArea;
    }

    if (totalArea <= 0) {
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
            cumulativeAreas[triangleIndex] = triangleIndex + 1;
        }
        totalArea = triangleCount;
    }

    const nextCache = { topologyKey, triangleCount, triangleIndices, cumulativeAreas, totalArea };
    surfaceTopologyCache.set(geometry, nextCache);
    return nextCache;
}

function pickWeightedIndex(cumulativeAreas, totalArea, rng) {
    const clamped = Math.min(Math.max(rng(), 0), 0.9999999999999999);
    const target = clamped * totalArea;
    let lo = 0;
    let hi = cumulativeAreas.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulativeAreas[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function getMeshVertexPosition(mesh, vertexIndex, target) {
    if (typeof mesh.getVertexPosition === 'function') {
        mesh.getVertexPosition(vertexIndex, target);
        return target;
    }

    const position = mesh.geometry?.getAttribute?.('position') ?? mesh.geometry?.attributes?.position;
    if (!position) return target.set(0, 0, 0);

    target.fromBufferAttribute(position, vertexIndex);
    if (mesh.isSkinnedMesh && typeof mesh.applyBoneTransform === 'function') {
        mesh.applyBoneTransform(vertexIndex, target);
    }
    return target;
}

function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function readVectorInput(value, target, fallbackX = 0, fallbackY = fallbackX, fallbackZ = fallbackX) {
    if (typeof value === 'number') {
        const scalar = finiteNumber(value, fallbackX);
        return target.set(scalar, scalar, scalar);
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        return target.set(
            finiteNumber(value[0], fallbackX),
            finiteNumber(value[1], fallbackY),
            finiteNumber(value[2], fallbackZ)
        );
    }
    if (value && typeof value === 'object') {
        return target.set(
            finiteNumber(value.x ?? value[0], fallbackX),
            finiteNumber(value.y ?? value[1], fallbackY),
            finiteNumber(value.z ?? value[2], fallbackZ)
        );
    }
    return target.set(fallbackX, fallbackY, fallbackZ);
}

function readQuaternionInput(value, target) {
    if (value?.isEuler) {
        return target.setFromEuler(value);
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        return target.set(
            finiteNumber(value[0], 0),
            finiteNumber(value[1], 0),
            finiteNumber(value[2], 0),
            finiteNumber(value[3], 1)
        ).normalize();
    }
    if (value && typeof value === 'object') {
        return target.set(
            finiteNumber(value.x ?? value[0], 0),
            finiteNumber(value.y ?? value[1], 0),
            finiteNumber(value.z ?? value[2], 0),
            finiteNumber(value.w ?? value[3], 1)
        ).normalize();
    }
    return target.identity();
}

function readEulerInput(value, target) {
    if (value?.isQuaternion) {
        return target.setFromQuaternion(value);
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        const order = typeof value[3] === 'string' ? value[3] : (target.order || 'XYZ');
        return target.set(
            finiteNumber(value[0], 0),
            finiteNumber(value[1], 0),
            finiteNumber(value[2], 0),
            order
        );
    }
    if (value && typeof value === 'object') {
        return target.set(
            finiteNumber(value.x ?? value[0], 0),
            finiteNumber(value.y ?? value[1], 0),
            finiteNumber(value.z ?? value[2], 0),
            value.order || target.order || 'XYZ'
        );
    }
    return target.set(0, 0, 0, target.order || 'XYZ');
}

const VECTOR3_MUTATORS = [
    'set', 'setScalar', 'setX', 'setY', 'setZ', 'setComponent',
    'copy', 'add', 'addScalar', 'addVectors', 'addScaledVector',
    'sub', 'subScalar', 'subVectors', 'multiply', 'multiplyScalar',
    'multiplyVectors', 'applyEuler', 'applyAxisAngle', 'applyMatrix3',
    'applyNormalMatrix', 'applyMatrix4', 'applyQuaternion', 'project',
    'unproject', 'transformDirection', 'divide', 'divideScalar', 'min',
    'max', 'clamp', 'clampScalar', 'clampLength', 'floor', 'ceil',
    'round', 'roundToZero', 'negate', 'normalize', 'setLength', 'lerp',
    'lerpVectors', 'cross', 'crossVectors', 'projectOnVector',
    'projectOnPlane', 'reflect', 'setFromMatrixPosition',
    'setFromMatrixScale', 'setFromMatrixColumn', 'setFromMatrix3Column',
    'fromArray', 'fromBufferAttribute', 'random', 'randomDirection',
];

const QUATERNION_MUTATORS = [
    'set', 'copy', 'setFromEuler', 'setFromAxisAngle', 'setFromRotationMatrix',
    'setFromUnitVectors', 'rotateTowards', 'identity', 'invert', 'conjugate',
    'normalize', 'multiply', 'premultiply', 'multiplyQuaternions', 'slerp',
    'slerpQuaternions', 'fromArray', 'random',
];

const EULER_MUTATORS = [
    'set', 'copy', 'setFromRotationMatrix', 'setFromQuaternion',
    'setFromVector3', 'reorder', 'fromArray',
];

function createLiveVector3Facade(THREE, readInto, writeFrom, fallback = [0, 0, 0]) {
    const vector = new THREE.Vector3();
    const backing = new THREE.Vector3();
    let suppressWrite = false;

    function syncFromScene() {
        if (!suppressWrite) readInto(backing);
        return backing;
    }

    function commitToScene() {
        writeFrom(backing);
    }

    function defineComponent(key, index) {
        Object.defineProperty(vector, key, {
            enumerable: true,
            configurable: true,
            get() {
                syncFromScene();
                return backing[key];
            },
            set(value) {
                if (!suppressWrite) syncFromScene();
                backing[key] = finiteNumber(value, fallback[index]);
                if (!suppressWrite) commitToScene();
            },
        });
    }

    defineComponent('x', 0);
    defineComponent('y', 1);
    defineComponent('z', 2);

    for (const method of VECTOR3_MUTATORS) {
        const original = THREE.Vector3.prototype[method];
        if (typeof original !== 'function') continue;
        Object.defineProperty(vector, method, {
            configurable: true,
            value(...args) {
                syncFromScene();
                suppressWrite = true;
                let result;
                try {
                    result = original.apply(vector, args);
                } finally {
                    suppressWrite = false;
                }
                commitToScene();
                return result === vector ? vector : result;
            },
        });
    }

    Object.defineProperty(vector, '_maxjsSync', {
        configurable: true,
        value() {
            syncFromScene();
            return vector;
        },
    });

    return vector;
}

function createLiveQuaternionFacade(THREE, readInto, writeFrom) {
    const quaternion = new THREE.Quaternion();
    const backing = new THREE.Quaternion();
    let suppressWrite = false;

    function syncFromScene() {
        if (!suppressWrite) {
            readInto(backing);
            quaternion._x = backing.x;
            quaternion._y = backing.y;
            quaternion._z = backing.z;
            quaternion._w = backing.w;
        }
        return backing;
    }

    function commitFromFacade() {
        backing.set(
            finiteNumber(quaternion._x, 0),
            finiteNumber(quaternion._y, 0),
            finiteNumber(quaternion._z, 0),
            finiteNumber(quaternion._w, 1)
        ).normalize();
        quaternion._x = backing.x;
        quaternion._y = backing.y;
        quaternion._z = backing.z;
        quaternion._w = backing.w;
        writeFrom(backing);
    }

    function defineComponent(key, internalKey, fallback) {
        Object.defineProperty(quaternion, key, {
            enumerable: true,
            configurable: true,
            get() {
                syncFromScene();
                return quaternion[internalKey];
            },
            set(value) {
                syncFromScene();
                quaternion[internalKey] = finiteNumber(value, fallback);
                if (!suppressWrite) commitFromFacade();
            },
        });
    }

    defineComponent('x', '_x', 0);
    defineComponent('y', '_y', 0);
    defineComponent('z', '_z', 0);
    defineComponent('w', '_w', 1);

    for (const method of QUATERNION_MUTATORS) {
        const original = THREE.Quaternion.prototype[method];
        if (typeof original !== 'function') continue;
        Object.defineProperty(quaternion, method, {
            configurable: true,
            value(...args) {
                syncFromScene();
                suppressWrite = true;
                let result;
                try {
                    result = original.apply(quaternion, args);
                } finally {
                    suppressWrite = false;
                }
                commitFromFacade();
                return result === quaternion ? quaternion : result;
            },
        });
    }

    Object.defineProperty(quaternion, '_maxjsSync', {
        configurable: true,
        value() {
            syncFromScene();
            return quaternion;
        },
    });

    return quaternion;
}

function createLiveEulerFacade(THREE, readInto, writeFrom) {
    const euler = new THREE.Euler();
    const backing = new THREE.Euler();
    let suppressWrite = false;

    function syncFromScene() {
        if (!suppressWrite) {
            readInto(backing);
            euler._x = backing.x;
            euler._y = backing.y;
            euler._z = backing.z;
            euler._order = backing.order || 'XYZ';
        }
        return backing;
    }

    function commitFromFacade() {
        backing.set(
            finiteNumber(euler._x, 0),
            finiteNumber(euler._y, 0),
            finiteNumber(euler._z, 0),
            euler._order || 'XYZ'
        );
        euler._x = backing.x;
        euler._y = backing.y;
        euler._z = backing.z;
        euler._order = backing.order;
        writeFrom(backing);
    }

    function defineComponent(key, internalKey, fallback) {
        Object.defineProperty(euler, key, {
            enumerable: true,
            configurable: true,
            get() {
                syncFromScene();
                return euler[internalKey];
            },
            set(value) {
                syncFromScene();
                euler[internalKey] = key === 'order' ? (value || 'XYZ') : finiteNumber(value, fallback);
                if (!suppressWrite) commitFromFacade();
            },
        });
    }

    defineComponent('x', '_x', 0);
    defineComponent('y', '_y', 0);
    defineComponent('z', '_z', 0);
    defineComponent('order', '_order', 'XYZ');

    for (const method of EULER_MUTATORS) {
        const original = THREE.Euler.prototype[method];
        if (typeof original !== 'function') continue;
        Object.defineProperty(euler, method, {
            configurable: true,
            value(...args) {
                syncFromScene();
                suppressWrite = true;
                let result;
                try {
                    result = original.apply(euler, args);
                } finally {
                    suppressWrite = false;
                }
                commitFromFacade();
                return result === euler ? euler : result;
            },
        });
    }

    Object.defineProperty(euler, '_maxjsSync', {
        configurable: true,
        value() {
            syncFromScene();
            return euler;
        },
    });

    return euler;
}

function createCameraAdapter(camera, THREE, ownForJs, cameraControl, layerId, debugWarn = () => {}) {
    const scratch = {
        position: new THREE.Vector3(),
        target: new THREE.Vector3(),
        direction: new THREE.Vector3(),
        up: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        euler: new THREE.Euler(),
        matrix: new THREE.Matrix4(),
    };

    function getActiveCamera() {
        return cameraControl.getCamera?.() ?? camera;
    }

    function ensureOwnership() {
        const owner = cameraControl.getOwner();
        if (owner && owner !== layerId) {
            debugWarn(`[Camera] Layer ${layerId} cannot control camera owned by ${owner}`);
            return false;
        }
        if (!owner) {
            cameraControl.claim(layerId);
        }
        return true;
    }

    function normalizeSceneCameraEntry(entry) {
        const handle = Number(entry?.handle ?? entry?.h ?? entry?.id ?? 0);
        const name = String(entry?.name ?? entry?.n ?? entry?.label ?? '').trim();
        return freezePlainObject({
            handle,
            h: handle,
            name,
            n: name,
        });
    }

    function listSceneCameras() {
        return Array.from(cameraControl.getSceneCameras?.() ?? [], normalizeSceneCameraEntry)
            .filter(entry => Number.isFinite(entry.handle) && entry.handle > 0);
    }

    function findSceneCamera(name, options = {}) {
        const query = String(name ?? '').trim().toLowerCase();
        if (!query) return null;
        const exact = options.exact === true;
        return listSceneCameras().find(entry => {
            const current = String(entry.name ?? '').toLowerCase();
            return exact ? current === query : current.includes(query);
        }) ?? null;
    }

    function usePhysicalCamera(handle) {
        const resolvedHandle = Number(handle?.handle ?? handle?.h ?? handle);
        return cameraControl.setMode('physical', { handle: resolvedHandle, layerId });
    }

    return freezePlainObject({
        get raw() { return getActiveCamera(); },
        get position() {
            const cam = getActiveCamera();
            return cam.position.clone();
        },
        get quaternion() {
            const cam = getActiveCamera();
            return cam.quaternion.clone();
        },
        get fov() { return getActiveCamera().fov; },
        get near() { return getActiveCamera().near; },
        get far() { return getActiveCamera().far; },
        get aspect() { return getActiveCamera().aspect; },
        get isPerspective() { return getActiveCamera().isPerspectiveCamera; },
        get isOrthographic() { return getActiveCamera().isOrthographicCamera; },

        getState() {
            const cam = getActiveCamera();
            return {
                type: cam.type,
                fov: cam.fov,
                near: cam.near,
                far: cam.far,
                up: cam.up.toArray(),
                position: cam.position.toArray(),
                quaternion: cam.quaternion.toArray(),
                matrix: cam.matrix.toArray(),
                matrixWorld: cam.matrixWorld.toArray(),
                projectionMatrix: cam.projectionMatrix.toArray(),
            };
        },

        clone(options = {}) {
            const cam = getActiveCamera();
            const clone = cam.clone();
            clone.matrix.copy(cam.matrix);
            clone.matrixWorld.copy(cam.matrixWorld);
            clone.projectionMatrix.copy(cam.projectionMatrix);
            clone.matrixAutoUpdate = cam.matrixAutoUpdate;
            if (options.name) clone.name = options.name;
            return ownForJs(clone, options.overlay ? OWNER_OVERLAY : OWNER_JS);
        },

        // Camera modes: 'viewport' (Max sync), 'physical' (Max camera object), 'script' (JS owned)
        get mode() { return cameraControl.getMode(); },
        get isViewportMode() { return cameraControl.isViewportMode(); },
        get isPhysicalMode() { return cameraControl.isPhysicalMode(); },
        get isScriptMode() { return cameraControl.isScriptMode(); },

        // Switch to viewport mode (synced from Max viewport)
        useViewport() {
            return cameraControl.setMode('viewport');
        },

        // Switch to physical camera mode (lock to Max camera object)
        usePhysicalCamera,

        listSceneCameras,
        findSceneCamera,
        usePhysicalCameraByName(name, options = {}) {
            const entry = findSceneCamera(name, options);
            return entry ? usePhysicalCamera(entry.handle) : false;
        },

        // Switch to script/game mode (full JS control)
        useScriptMode(options = {}) {
            return cameraControl.setMode('script', {
                layerId,
                enableControls: options.enableOrbitControls ?? false,
            });
        },

        // Legacy ownership API (maps to script mode)
        takeOver() { return cameraControl.claim(layerId); },
        release() { cameraControl.release(layerId); },
        get isOverridden() { return cameraControl.isClaimed(); },
        get isOwnedByMe() { return cameraControl.getOwner() === layerId; },

        // Position control
        setPosition(x, y, z) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            cam.position.set(x, y, z);
            cam.updateMatrixWorld();
            return true;
        },

        setPositionVec(vec) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            cam.position.copy(vec);
            cam.updateMatrixWorld();
            return true;
        },

        // Rotation control
        setQuaternion(x, y, z, w) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            cam.quaternion.set(x, y, z, w).normalize();
            cam.updateMatrixWorld();
            return true;
        },

        setQuaternionVec(quat) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            cam.quaternion.copy(quat).normalize();
            cam.updateMatrixWorld();
            return true;
        },

        setRotationEuler(x, y, z, order = 'YXZ') {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            scratch.euler.set(x, y, z, order);
            cam.quaternion.setFromEuler(scratch.euler);
            cam.updateMatrixWorld();
            return true;
        },

        // LookAt
        lookAt(x, y, z) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            if (typeof x === 'object' && x !== null) {
                cam.lookAt(x.x ?? x[0] ?? 0, x.y ?? x[1] ?? 0, x.z ?? x[2] ?? 0);
            } else {
                cam.lookAt(x, y, z);
            }
            cam.updateMatrixWorld();
            // Sync controls target if available
            const ctrl = cameraControl.getControls?.();
            if (ctrl?.target) {
                if (typeof x === 'object' && x !== null) {
                    ctrl.target.set(x.x ?? x[0] ?? 0, x.y ?? x[1] ?? 0, x.z ?? x[2] ?? 0);
                } else {
                    ctrl.target.set(x, y, z);
                }
            }
            return true;
        },

        // Combined position + lookAt
        setPositionAndLookAt(px, py, pz, tx, ty, tz) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            cam.position.set(px, py, pz);
            cam.lookAt(tx, ty, tz);
            cam.updateMatrixWorld();
            const ctrl = cameraControl.getControls?.();
            if (ctrl?.target) ctrl.target.set(tx, ty, tz);
            return true;
        },

        // Full transform
        setTransform(px, py, pz, qx, qy, qz, qw) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            cam.position.set(px, py, pz);
            cam.quaternion.set(qx, qy, qz, qw).normalize();
            cam.updateMatrixWorld();
            return true;
        },

        setMatrix(matrix) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            if (matrix?.isMatrix4) {
                cam.matrix.copy(matrix);
            } else if (Array.isArray(matrix) || ArrayBuffer.isView(matrix)) {
                cam.matrix.fromArray(matrix);
            }
            cam.matrix.decompose(cam.position, cam.quaternion, scratch.position); // scale to scratch
            cam.updateMatrixWorld();
            return true;
        },

        // Projection control
        setFov(fov) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            if (cam.isPerspectiveCamera) {
                cam.fov = fov;
                cam.updateProjectionMatrix();
            }
            return true;
        },

        setNearFar(near, far) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            cam.near = near;
            cam.far = far;
            cam.updateProjectionMatrix();
            return true;
        },

        // Orbit-style controls (works even when OrbitControls is disabled)
        orbit(deltaAzimuth, deltaPolar, target = null) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            const ctrl = cameraControl.getControls?.();
            const pivot = target
                ? scratch.target.set(target.x ?? target[0], target.y ?? target[1], target.z ?? target[2])
                : (ctrl?.target?.clone() ?? new THREE.Vector3(0, 0, 0));

            // Compute current spherical position relative to pivot
            scratch.position.copy(cam.position).sub(pivot);
            const radius = scratch.position.length();
            let theta = Math.atan2(scratch.position.x, scratch.position.z); // azimuth
            let phi = Math.acos(Math.min(1, Math.max(-1, scratch.position.y / radius))); // polar

            theta += deltaAzimuth;
            phi = Math.max(0.01, Math.min(Math.PI - 0.01, phi + deltaPolar));

            // Convert back to cartesian
            scratch.position.set(
                radius * Math.sin(phi) * Math.sin(theta),
                radius * Math.cos(phi),
                radius * Math.sin(phi) * Math.cos(theta)
            );
            cam.position.copy(scratch.position).add(pivot);
            cam.lookAt(pivot);
            cam.updateMatrixWorld();
            if (ctrl?.target) ctrl.target.copy(pivot);
            return true;
        },

        dolly(delta, target = null) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            const ctrl = cameraControl.getControls?.();
            const pivot = target
                ? scratch.target.set(target.x ?? target[0], target.y ?? target[1], target.z ?? target[2])
                : (ctrl?.target?.clone() ?? new THREE.Vector3(0, 0, 0));

            scratch.direction.copy(cam.position).sub(pivot).normalize();
            cam.position.addScaledVector(scratch.direction, delta);
            cam.updateMatrixWorld();
            return true;
        },

        pan(deltaX, deltaY) {
            if (!ensureOwnership()) return false;
            const cam = getActiveCamera();
            const ctrl = cameraControl.getControls?.();

            // Get camera right and up vectors
            scratch.direction.set(1, 0, 0).applyQuaternion(cam.quaternion);
            scratch.up.set(0, 1, 0).applyQuaternion(cam.quaternion);

            cam.position.addScaledVector(scratch.direction, deltaX);
            cam.position.addScaledVector(scratch.up, deltaY);
            cam.updateMatrixWorld();

            if (ctrl?.target) {
                ctrl.target.addScaledVector(scratch.direction, deltaX);
                ctrl.target.addScaledVector(scratch.up, deltaY);
            }
            return true;
        },

        // Get direction vectors
        getForward(out = new THREE.Vector3()) {
            const cam = getActiveCamera();
            return out.set(0, 0, -1).applyQuaternion(cam.quaternion);
        },

        getRight(out = new THREE.Vector3()) {
            const cam = getActiveCamera();
            return out.set(1, 0, 0).applyQuaternion(cam.quaternion);
        },

        getUp(out = new THREE.Vector3()) {
            const cam = getActiveCamera();
            return out.set(0, 1, 0).applyQuaternion(cam.quaternion);
        },

        // Access to underlying controls (when claimed)
        get controls() {
            if (cameraControl.getOwner() !== layerId) return null;
            return cameraControl.getControls?.() ?? null;
        },

        // Enable/disable controls temporarily
        setControlsEnabled(enabled) {
            const ctrl = cameraControl.getControls?.();
            if (ctrl) ctrl.enabled = enabled;
        },
    });
}

function createMaxNodeAdapter({
    handle,
    getObject,
    THREE,
    createAnchor,
    layerId,
    getTransformApi,
    setMaterialMap,
    getNodeAdapter,
    cloneFromMax,
    setVisibilityOverride,
    clearVisibilityOverride,
}) {
    const scratch = {
        vA: new THREE.Vector3(),
        vB: new THREE.Vector3(),
        vC: new THREE.Vector3(),
        edgeAB: new THREE.Vector3(),
        edgeAC: new THREE.Vector3(),
        localPoint: new THREE.Vector3(),
        localNormal: new THREE.Vector3(),
        normalMatrix: new THREE.Matrix3(),
        position: new THREE.Vector3(),
        scale: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        euler: new THREE.Euler(),
    };
    const transform = getTransformApi(handle, getObject, layerId);

    function readLocalPosition(target) {
        const obj = getObject();
        return obj?.isObject3D ? target.copy(obj.position) : target.set(0, 0, 0);
    }

    function readLocalScale(target) {
        const obj = getObject();
        return obj?.isObject3D ? target.copy(obj.scale) : target.set(1, 1, 1);
    }

    function readLocalQuaternion(target) {
        const obj = getObject();
        return obj?.isObject3D ? target.copy(obj.quaternion) : target.identity();
    }

    function readLocalRotation(target) {
        const obj = getObject();
        if (!obj?.isObject3D) return target.set(0, 0, 0, target.order || 'XYZ');
        return target.copy(obj.rotation);
    }

    function setLocalPosition(value) {
        readVectorInput(value, scratch.position, 0, 0, 0);
        return transform.setPosition(scratch.position.x, scratch.position.y, scratch.position.z);
    }

    function setLocalScale(value) {
        readVectorInput(value, scratch.scale, 1, 1, 1);
        return transform.setScale(scratch.scale.x, scratch.scale.y, scratch.scale.z);
    }

    function setLocalQuaternion(value) {
        readQuaternionInput(value, scratch.quaternion);
        return transform.setQuaternion(
            scratch.quaternion.x,
            scratch.quaternion.y,
            scratch.quaternion.z,
            scratch.quaternion.w
        );
    }

    function setLocalRotation(value) {
        readEulerInput(value, scratch.euler);
        return transform.setRotationEuler(
            scratch.euler.x,
            scratch.euler.y,
            scratch.euler.z,
            { order: scratch.euler.order }
        );
    }

    function applyLocalVisibility(obj, next) {
        if (!obj?.isObject3D) return false;
        obj.userData ??= {};
        obj.userData.maxjsVisible = next;
        obj.visible = true;
        obj.layers?.set?.(next ? 0 : 31);
        const materials = Array.isArray(obj.material)
            ? obj.material
            : (obj.material ? [obj.material] : []);
        for (const material of materials) {
            if (material) material.visible = true;
        }
        return true;
    }

    function setNodeVisible(value) {
        const obj = getObject();
        if (!obj) return false;
        const next = value !== false;
        setVisibilityOverride?.(handle, next, obj);
        return applyLocalVisibility(obj, next);
    }

    function resetNodeVisibility() {
        const obj = getObject();
        if (clearVisibilityOverride) return clearVisibilityOverride(handle, obj);
        if (obj?.isObject3D) {
            obj.userData ??= {};
            delete obj.userData.maxjsVisible;
            obj.visible = true;
            obj.layers?.set?.(0);
            return true;
        }
        return false;
    }

    const positionFacade = createLiveVector3Facade(
        THREE,
        readLocalPosition,
        value => transform.setPosition(value.x, value.y, value.z),
        [0, 0, 0]
    );
    const scaleFacade = createLiveVector3Facade(
        THREE,
        readLocalScale,
        value => transform.setScale(value.x, value.y, value.z),
        [1, 1, 1]
    );
    const quaternionFacade = createLiveQuaternionFacade(
        THREE,
        readLocalQuaternion,
        value => transform.setQuaternion(value.x, value.y, value.z, value.w)
    );
    const rotationFacade = createLiveEulerFacade(
        THREE,
        readLocalRotation,
        value => transform.setRotationEuler(value.x, value.y, value.z, { order: value.order })
    );

    function collectSampleableMeshes(root, includeInvisible = false) {
        if (!root?.isObject3D) return [];
        const meshes = [];
        root.updateWorldMatrix(true, true);
        root.traverse(obj => {
            if (!obj?.isMesh) return;
            if (!includeInvisible && !obj.visible) return;
            const topology = getSurfaceTopologyCache(obj.geometry, THREE);
            if (!topology) return;
            meshes.push({ mesh: obj, topology });
        });
        return meshes;
    }

    function sampleMeshSurface(mesh, topology, options = {}) {
        const rng = typeof options.rng === 'function' ? options.rng : Math.random;
        const point = options.point ?? new THREE.Vector3();
        const normal = options.normal ?? new THREE.Vector3();
        const barycentric = options.barycentric ?? new THREE.Vector3();

        const triangleIndex = pickWeightedIndex(topology.cumulativeAreas, topology.totalArea, rng);
        const base = triangleIndex * 3;
        const iA = topology.triangleIndices[base];
        const iB = topology.triangleIndices[base + 1];
        const iC = topology.triangleIndices[base + 2];

        getMeshVertexPosition(mesh, iA, scratch.vA);
        getMeshVertexPosition(mesh, iB, scratch.vB);
        getMeshVertexPosition(mesh, iC, scratch.vC);

        let u = rng();
        let v = rng();
        if (u + v > 1) {
            u = 1 - u;
            v = 1 - v;
        }
        const w = 1 - u - v;
        barycentric.set(w, u, v);

        scratch.localPoint
            .copy(scratch.vA).multiplyScalar(w)
            .addScaledVector(scratch.vB, u)
            .addScaledVector(scratch.vC, v);

        scratch.edgeAB.subVectors(scratch.vB, scratch.vA);
        scratch.edgeAC.subVectors(scratch.vC, scratch.vA);
        scratch.localNormal.crossVectors(scratch.edgeAB, scratch.edgeAC);
        if (scratch.localNormal.lengthSq() > 0) scratch.localNormal.normalize();
        else scratch.localNormal.set(0, 1, 0);

        if (options.local === true) {
            point.copy(scratch.localPoint);
            normal.copy(scratch.localNormal);
        } else {
            point.copy(scratch.localPoint).applyMatrix4(mesh.matrixWorld);
            scratch.normalMatrix.getNormalMatrix(mesh.matrixWorld);
            normal.copy(scratch.localNormal).applyMatrix3(scratch.normalMatrix).normalize();
        }

        return {
            point,
            normal,
            barycentric,
            triangleIndex,
            object: mesh,
            mesh,
            meshHandle: mesh.userData?.maxjsHandle ?? handle,
            meshName: mesh.name ?? '',
        };
    }

    return freezePlainObject({
        handle,
        get raw() { return getObject(); },
        get object() { return getObject(); },
        get exists() { return !!getObject(); },
        get name() { return getObject()?.name ?? ''; },
        get type() { return getObject()?.type ?? null; },
        get isMesh() { return !!getObject()?.isMesh; },
        get isHelper() { return !!getObject()?.userData?.maxjsHelper; },
        get position() {
            positionFacade._maxjsSync();
            return positionFacade;
        },
        set position(value) { setLocalPosition(value); },
        get rotation() {
            rotationFacade._maxjsSync();
            return rotationFacade;
        },
        set rotation(value) { setLocalRotation(value); },
        get quaternion() {
            quaternionFacade._maxjsSync();
            return quaternionFacade;
        },
        set quaternion(value) { setLocalQuaternion(value); },
        get scale() {
            scaleFacade._maxjsSync();
            return scaleFacade;
        },
        set scale(value) { setLocalScale(value); },
        get matrix() {
            const obj = getObject();
            return obj?.matrix?.clone?.() ?? null;
        },
        get matrixWorld() {
            const obj = getObject();
            return obj?.matrixWorld?.clone?.() ?? null;
        },
        get visible() {
            const obj = getObject();
            if (!obj) return false;
            return obj.userData?.maxjsVisible !== false && obj.visible !== false;
        },
        set visible(v) { setNodeVisible(v); },
        setVisible(v) { return setNodeVisible(v); },
        show() { setNodeVisible(true); return this; },
        hide() { setNodeVisible(false); return this; },
        resetVisibility() { return resetNodeVisibility(); },
        get jsmod() { return !!getObject()?.userData?.jsmod; },
        get parentHandle() {
            const h = Number(getObject()?.userData?.maxjsParentHandle);
            return Number.isFinite(h) && h > 0 ? h : null;
        },
        get parent() {
            const h = Number(getObject()?.userData?.maxjsParentHandle);
            return Number.isFinite(h) && h > 0 ? getNodeAdapter?.(h) ?? null : null;
        },
        get children() {
            const obj = getObject();
            if (!obj?.children?.length) return Object.freeze([]);
            const out = [];
            for (const child of obj.children) {
                const h = child?.userData?.maxjsHandle;
                if (h != null) {
                    const adapter = getNodeAdapter?.(h);
                    if (adapter) out.push(adapter);
                }
            }
            return Object.freeze(out);
        },
        descendants(options = {}) {
            const obj = getObject();
            if (!obj?.children?.length) return Object.freeze([]);
            const out = [];
            obj.traverse(child => {
                if (child === obj) return;
                const h = child?.userData?.maxjsHandle;
                if (h != null) {
                    const adapter = getNodeAdapter?.(h);
                    if (!adapter) return;
                    if (options.meshOnly === true && !adapter.isMesh) return;
                    if (options.visibleOnly === true && !adapter.visible) return;
                    out.push(adapter);
                }
            });
            return Object.freeze(out);
        },
        get materialType() {
            const obj = getObject();
            const mat = Array.isArray(obj?.material) ? obj.material[0] : obj?.material;
            return mat?.type ?? null;
        },
        getWorldMatrix(target = new THREE.Matrix4()) {
            const obj = getObject();
            return obj ? target.copy(obj.matrixWorld) : null;
        },
        getWorldPosition(target = new THREE.Vector3()) {
            const obj = getObject();
            if (!obj) return null;
            obj.getWorldPosition(target);
            return target;
        },
        getWorldQuaternion(target = new THREE.Quaternion()) {
            const obj = getObject();
            if (!obj) return null;
            obj.getWorldQuaternion(target);
            return target;
        },
        getWorldScale(target = new THREE.Vector3()) {
            const obj = getObject();
            if (!obj) return null;
            obj.getWorldScale(target);
            return target;
        },
        getPivotWorldPosition(target = new THREE.Vector3()) {
            const obj = getObject();
            return obj ? obj.getWorldPosition(target) : null;
        },
        getVisualCenter(target = new THREE.Vector3()) {
            const obj = getObject();
            return obj ? new THREE.Box3().setFromObject(obj).getCenter(target) : null;
        },
        getPivotToVisualCenter(target = new THREE.Vector3()) {
            const obj = getObject();
            if (!obj) return null;
            const pivot = obj.getWorldPosition(scratch.vA);
            const center = new THREE.Box3().setFromObject(obj).getCenter(target);
            return center.sub(pivot);
        },
        getLocalAxesWorld() {
            const obj = getObject();
            if (!obj) return null;
            const q = obj.getWorldQuaternion(new THREE.Quaternion());
            return {
                x: new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize(),
                y: new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize(),
                z: new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize(),
            };
        },
        getOrientationSnapshot() {
            const obj = getObject();
            if (!obj) return null;
            const pivot = obj.getWorldPosition(new THREE.Vector3());
            const bbox = new THREE.Box3().setFromObject(obj);
            const center = bbox.getCenter(new THREE.Vector3());
            const dimensions = bbox.getSize(new THREE.Vector3());
            const axes = this.getLocalAxesWorld();
            return {
                handle,
                name: obj.name,
                pivot: pivot.toArray(),
                visualCenter: center.toArray(),
                dimensions: dimensions.toArray(),
                pivotToVisualCenter: center.clone().sub(pivot).toArray(),
                localAxesWorld: {
                    x: axes.x.toArray(),
                    y: axes.y.toArray(),
                    z: axes.z.toArray(),
                },
                worldMatrix: obj.matrixWorld.toArray(),
            };
        },
        get isLight() { return !!getObject()?.isLight; },
        get isDirectionalLight() { return !!getObject()?.isDirectionalLight; },
        /** For directional/spot lights: the normalized world-space direction the light shines toward.
         *  For other lights/objects without a target: the object's local -Z transformed by world rotation. */
        getLightDirection(target = new THREE.Vector3()) {
            const obj = getObject();
            if (!obj) return null;
            if (obj.target) {
                const p = new THREE.Vector3();
                obj.getWorldPosition(p);
                obj.target.getWorldPosition(target);
                target.sub(p);
            } else {
                const q = new THREE.Quaternion();
                obj.getWorldQuaternion(q);
                target.set(0, 0, -1).applyQuaternion(q);
            }
            return target.lengthSq() > 0 ? target.normalize() : target.set(0, -1, 0);
        },
        getBoundingBox(target = new THREE.Box3()) {
            const obj = getObject();
            return obj ? target.setFromObject(obj) : null;
        },
        transform,
        get base() { return transform.baseSnapshot(); },
        resetTransform() { return transform.clear(); },
        reset() {
            const transformChanged = transform.clear();
            const visibilityChanged = resetNodeVisibility();
            return transformChanged || visibilityChanged;
        },
        clone(options = {}) {
            return cloneFromMax?.(handle, options) ?? null;
        },
        // Override a material map slot on the synced mesh. Survives
        // fastsync rebuilds — registered against the handle, reapplied
        // on every scene message after the material is rebuilt. Pass
        // texture=null to clear an override.
        setMap(slot, texture) {
            if (typeof slot !== 'string' || !slot) return;
            setMaterialMap?.(handle, slot, texture);
        },
        snapshot() {
            const obj = getObject();
            if (!obj) return null;
            const position = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            obj.matrixWorld.decompose(position, quaternion, scale);
            return {
                handle,
                name: obj.name,
                type: obj.type,
                visible: !!obj.visible,
                matrixWorld: obj.matrixWorld.toArray(),
                position: position.toArray(),
                quaternion: quaternion.toArray(),
                scale: scale.toArray(),
            };
        },
        createAnchor(options = {}) {
            return createAnchor(handle, options);
        },
        sampleSurface: function sampleSurface(options = {}) {
            const count = Math.max(0, Math.floor(Number(options.count) || 0));
            if (count > 1) {
                const out = [];
                const nextOptions = { ...options };
                delete nextOptions.count;
                for (let i = 0; i < count; i += 1) {
                    const hit = sampleSurface(nextOptions);
                    if (hit) out.push(hit);
                }
                return Object.freeze(out);
            }

            const obj = getObject();
            if (!obj?.isObject3D) return null;
            if (!options.includeInvisible && !obj.visible) return null;

            if (obj.isMesh) {
                const topology = getSurfaceTopologyCache(obj.geometry, THREE);
                return topology ? sampleMeshSurface(obj, topology, options) : null;
            }

            const meshes = collectSampleableMeshes(obj, options.includeInvisible === true);
            if (meshes.length === 0) return null;
            if (meshes.length === 1) {
                const { mesh, topology } = meshes[0];
                return sampleMeshSurface(mesh, topology, options);
            }

            const rng = typeof options.rng === 'function' ? options.rng : Math.random;
            let totalArea = 0;
            for (const entry of meshes) totalArea += entry.topology.totalArea;
            if (totalArea <= 0) return null;

            const target = Math.min(Math.max(rng(), 0), 0.9999999999999999) * totalArea;
            let running = 0;
            for (const entry of meshes) {
                running += entry.topology.totalArea;
                if (target <= running) return sampleMeshSurface(entry.mesh, entry.topology, options);
            }

            const last = meshes[meshes.length - 1];
            return sampleMeshSurface(last.mesh, last.topology, options);
        },
    });
}
export { createMaxNodeAdapter };
