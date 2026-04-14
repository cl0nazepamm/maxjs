// layer_manager.js — dual-world JS runtime for MaxJS inline modules.
// Max-owned scene content stays read-only behind adapters.
// JS-authored content lives under its own roots and owns its own resources.

const MAX_CONSECUTIVE_ERRORS = 60;
const OWNER_KEY = 'maxjsOwner';
const OWNER_MAX = 'max';
const OWNER_JS = 'js';
const OWNER_OVERLAY = 'overlay';

const MATERIAL_MAP_KEYS = [
    'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap',
    'emissiveMap', 'aoMap', 'displacementMap', 'alphaMap', 'envMap',
    'lightMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
];
const MATRIX_EPSILON = 1e-6;

function setOwner(resource, owner) {
    if (!resource || typeof resource !== 'object') return resource;
    resource.userData ??= {};
    resource.userData[OWNER_KEY] = owner;
    return resource;
}

function getOwner(resource) {
    return resource?.userData?.[OWNER_KEY] ?? null;
}

function isDisposable(resource) {
    return !!resource && typeof resource.dispose === 'function';
}

function isOwnedByJs(resource) {
    const owner = getOwner(resource);
    return owner === OWNER_JS || owner === OWNER_OVERLAY;
}

function markMaterialOwned(material, owner) {
    if (!material) return material;
    setOwner(material, owner);
    for (const key of MATERIAL_MAP_KEYS) {
        if (material[key]) setOwner(material[key], owner);
    }
    return material;
}

function markOwned(resource, owner = OWNER_JS) {
    if (!resource) return resource;

    if (Array.isArray(resource)) {
        for (const item of resource) markOwned(item, owner);
        return resource;
    }

    if (resource.isObject3D) {
        resource.traverse(obj => {
            setOwner(obj, owner);
            if (obj.geometry) setOwner(obj.geometry, owner);
            if (Array.isArray(obj.material)) obj.material.forEach(mat => markMaterialOwned(mat, owner));
            else if (obj.material) markMaterialOwned(obj.material, owner);
        });
        return resource;
    }

    if (resource.isMaterial) return markMaterialOwned(resource, owner);
    if (resource.isBufferGeometry || resource.isTexture || resource.isRenderTarget) return setOwner(resource, owner);
    return setOwner(resource, owner);
}

function setSnapshotTargetId(resource, snapshotId) {
    if (!resource || typeof resource !== 'object') return resource;
    resource.userData ??= {};
    resource.userData.maxjsSnapshotId = snapshotId;
    return resource;
}

function disposeOwnedMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
        for (const item of material) disposeOwnedMaterial(item);
        return;
    }
    for (const key of MATERIAL_MAP_KEYS) {
        const map = material[key];
        if (isOwnedByJs(map) && isDisposable(map)) map.dispose();
    }
    if (isOwnedByJs(material) && isDisposable(material)) material.dispose();
}

function disposeOwnedResource(resource) {
    if (!resource) return;

    if (Array.isArray(resource)) {
        for (const item of resource) disposeOwnedResource(item);
        return;
    }

    if (resource.isObject3D) {
        while (resource.children.length > 0) {
            const child = resource.children[0];
            resource.remove(child);
            disposeOwnedResource(child);
        }
        if (isOwnedByJs(resource.geometry) && isDisposable(resource.geometry)) resource.geometry.dispose();
        disposeOwnedMaterial(resource.material);
        return;
    }

    if (resource.isMaterial) {
        disposeOwnedMaterial(resource);
        return;
    }

    if (isOwnedByJs(resource) && isDisposable(resource)) resource.dispose();
}

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

function matrixElementsAlmostEqual(a, b, epsilon = MATRIX_EPSILON) {
    if (!a || !b) return false;
    const ae = a.elements ?? a;
    const be = b.elements ?? b;
    if (!ae || !be || ae.length !== be.length) return false;
    for (let i = 0; i < ae.length; i++) {
        if (Math.abs(ae[i] - be[i]) > epsilon) return false;
    }
    return true;
}

function freezePlainObject(obj) {
    return Object.freeze(obj);
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
        usePhysicalCamera(handle) {
            return cameraControl.setMode('physical', { handle });
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

function createMaxNodeAdapter({ handle, getObject, THREE, createAnchor, layerId, getTransformApi }) {
    const scratch = {
        vA: new THREE.Vector3(),
        vB: new THREE.Vector3(),
        vC: new THREE.Vector3(),
        edgeAB: new THREE.Vector3(),
        edgeAC: new THREE.Vector3(),
        localPoint: new THREE.Vector3(),
        localNormal: new THREE.Vector3(),
        normalMatrix: new THREE.Matrix3(),
    };
    const transform = getTransformApi(handle, getObject, layerId);

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
            meshHandle: mesh.userData?.maxjsHandle ?? handle,
            meshName: mesh.name ?? '',
        };
    }

    return freezePlainObject({
        handle,
        get exists() { return !!getObject(); },
        get name() { return getObject()?.name ?? ''; },
        get type() { return getObject()?.type ?? null; },
        get visible() { return !!getObject()?.visible; },
        setVisible(v) { const obj = getObject(); if (obj) obj.visible = !!v; },
        get isMesh() { return !!getObject()?.isMesh; },
        get jsmod() { return !!getObject()?.userData?.jsmod; },
        get materialType() {
            const obj = getObject();
            const mat = Array.isArray(obj?.material) ? obj.material[0] : obj?.material;
            return mat?.type ?? null;
        },
        getWorldMatrix() {
            const obj = getObject();
            return obj ? obj.matrixWorld.clone() : null;
        },
        getWorldPosition() {
            const obj = getObject();
            if (!obj) return null;
            const position = new THREE.Vector3();
            obj.getWorldPosition(position);
            return position;
        },
        getWorldQuaternion() {
            const obj = getObject();
            if (!obj) return null;
            const quaternion = new THREE.Quaternion();
            obj.getWorldQuaternion(quaternion);
            return quaternion;
        },
        getWorldScale() {
            const obj = getObject();
            if (!obj) return null;
            const scale = new THREE.Vector3();
            obj.getWorldScale(scale);
            return scale;
        },
        getBoundingBox() {
            const obj = getObject();
            return obj ? new THREE.Box3().setFromObject(obj) : null;
        },
        transform,
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
        sampleSurface(options = {}) {
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

function createNodeMapFacade(nodeMap, getAdapter) {
    const facade = {
        get size() { return nodeMap.size; },
        has(handle) { return nodeMap.has(handle); },
        get(handle) { return nodeMap.has(handle) ? getAdapter(handle) : null; },
        keys() { return nodeMap.keys(); },
        *values() {
            for (const handle of nodeMap.keys()) yield getAdapter(handle);
        },
        *entries() {
            for (const handle of nodeMap.keys()) yield [handle, getAdapter(handle)];
        },
        forEach(fn, thisArg) {
            for (const handle of nodeMap.keys()) {
                fn.call(thisArg, getAdapter(handle), handle, facade);
            }
        },
        [Symbol.iterator]() {
            return this.entries();
        },
    };
    return freezePlainObject(facade);
}

function createMaxSceneFacade({ scene, nodeMap, lightHandleMap, getAdapter, createAnchor, THREE }) {
    return freezePlainObject({
        get size() { return nodeMap.size; },
        get background() { return scene.background?.clone?.() ?? scene.background ?? null; },
        get environment() { return scene.environment?.clone?.() ?? null; },
        get fog() { return scene.fog?.clone?.() ?? null; },
        has(handle) { return nodeMap.has(handle); },
        getNode(handle) { return nodeMap.has(handle) ? getAdapter(handle) : null; },
        listHandles() { return Array.from(nodeMap.keys()); },
        listNodes() { return Array.from(nodeMap.keys(), handle => getAdapter(handle)); },
        /** Meshes whose Max stack has three.js Deform (bridge sets adapter.jsmod). Safe to poll every frame — nodeMap grows as sync arrives. */
        listJsmodNodes() {
            const out = [];
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                if (adapter?.isMesh && adapter.jsmod) out.push(adapter);
            }
            return out;
        },
        findByName(name, options = {}) {
            const query = String(name ?? '').toLowerCase();
            const exact = options.exact === true;
            const matches = [];
            // Search meshes in nodeMap
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                const current = String(adapter?.name ?? '').toLowerCase();
                if (!query) continue;
                if ((exact && current === query) || (!exact && current.includes(query))) {
                    matches.push(adapter);
                }
            }
            // Search lights in lightHandleMap
            if (lightHandleMap) {
                for (const [handle, light] of lightHandleMap.entries()) {
                    const current = String(light?.name ?? '').toLowerCase();
                    if (!query) continue;
                    if ((exact && current === query) || (!exact && current.includes(query))) {
                        matches.push(getAdapter(handle, light));
                    }
                }
            }
            return matches;
        },
        createAnchor(handle, options = {}) {
            return createAnchor(handle, options);
        },
        raycast(origin, direction, options = {}) {
            const rc = new THREE.Raycaster(origin, direction);
            if (Number.isFinite(options.near)) rc.near = options.near;
            if (Number.isFinite(options.far)) rc.far = options.far;
            const targets = [];
            for (const obj of nodeMap.values()) {
                if (obj?.visible) targets.push(obj);
            }
            return rc.intersectObjects(targets, true).map((hit) => {
                let normal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0);
                if (hit.face?.normal && hit.object?.matrixWorld) {
                    normal.transformDirection(hit.object.matrixWorld);
                    if (normal.lengthSq() > 0) normal.normalize();
                }
                return {
                    point: hit.point.clone(),
                    normal,
                    distance: hit.distance,
                    handle: hit.object?.userData?.maxjsHandle ?? null,
                    name: hit.object?.name ?? '',
                };
            });
        },
    });
}

function createRendererFacade(renderer) {
    return freezePlainObject({
        get capabilities() { return renderer.capabilities; },
        get info() { return renderer.info; },
        get domElement() { return renderer.domElement; },
        get width() { return renderer.domElement?.width ?? 0; },
        get height() { return renderer.domElement?.height ?? 0; },
    });
}

function createInputHelper(renderer) {
    const el = renderer.domElement;
    const listeners = [];
    function on(target, event, fn, opts) {
        target.addEventListener(event, fn, opts);
        listeners.push({ target, event, fn, opts });
    }
    return {
        get element() { return el; },
        get document() { return el?.ownerDocument; },
        on,
        dispose() {
            for (const { target, event, fn, opts } of listeners)
                target.removeEventListener(event, fn, opts);
            listeners.length = 0;
        },
    };
}

const SANDBOX_DOM_WHITELIST = new Set(['canvas', 'img', 'video', 'audio']);

const sandboxDocument = Object.freeze({
    createElement(tag) {
        const t = String(tag).toLowerCase();
        if (!SANDBOX_DOM_WHITELIST.has(t))
            throw new Error(`Sandbox: createElement("${t}") not allowed. Whitelist: ${[...SANDBOX_DOM_WHITELIST].join(', ')}`);
        return document.createElement(t);
    },
});

const SANDBOX_PRELUDE = [
    '"use strict";',
    'const window = undefined;',
    'const globalThis = undefined;',
    'const self = undefined;',
    'const chrome = undefined;',
    'const fetch = undefined;',
    'const XMLHttpRequest = undefined;',
    'const WebSocket = undefined;',
    'const localStorage = undefined;',
    'const sessionStorage = undefined;',
].join('\n');

function buildInlineFactory(code) {
    return new Function('ctx', 'THREE', 'document', `${SANDBOX_PRELUDE}\n${code}`);
}

export function createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap,
    lightHandleMap = null,
    maxRoot = null,
    jsRoot = null,
    overlayRoot = null,
    space = null,
    controls = null,
    getCamera = null,
    onCameraModeChange = null,
    debugLog = () => {},
    debugWarn = () => {},
}) {
    const layers = new Map();
    const listeners = new Set();
    let projectControl = null;
    let lastMountMs = 0;
    let lastStats = freezePlainObject({
        layerCount: 0,
        activeLayerCount: 0,
        anchorCount: 0,
        trackedCount: 0,
        updateMs: 0,
        lastMountMs: 0,
    });

    const jsWorldRoot = markOwned(jsRoot || new THREE.Group(), OWNER_JS);
    jsWorldRoot.name ||= '__maxjs_js_root__';
    if (!jsWorldRoot.parent) scene.add(jsWorldRoot);

    const overlayWorldRoot = markOwned(overlayRoot || new THREE.Group(), OWNER_OVERLAY);
    overlayWorldRoot.name ||= '__maxjs_overlay_root__';
    if (!overlayWorldRoot.parent) scene.add(overlayWorldRoot);

    if (maxRoot) setOwner(maxRoot, OWNER_MAX);

    // Camera modes:
    // - 'viewport': synced from Max viewport (default, controlled by Max navigation)
    // - 'physical': locked to a Max Physical Camera object in scene
    // - 'script': fully owned by Three.js layer code (game camera)
    let cameraMode = 'viewport';
    let cameraClaimOwner = null; // layer id that claimed camera (for 'script' mode)
    let physicalCameraHandle = null; // handle of locked physical camera (for 'physical' mode)
    let controlsEnabledBeforeClaim = true;

    const cameraControl = {
        getMode() { return cameraMode; },
        setMode(mode, options = {}) {
            if (mode !== 'viewport' && mode !== 'physical' && mode !== 'script') return false;
            if (mode === 'physical' && !Number.isFinite(Number(options.handle))) return false;
            const prevMode = cameraMode;
            cameraMode = mode;

            if (mode === 'viewport') {
                // Release any ownership, sync from Max viewport
                cameraClaimOwner = null;
                physicalCameraHandle = null;
                camera.matrixAutoUpdate = false;
                if (controls) controls.enabled = controlsEnabledBeforeClaim;
            } else if (mode === 'physical') {
                // Lock to physical camera object
                physicalCameraHandle = options.handle ?? null;
                cameraClaimOwner = null;
                camera.matrixAutoUpdate = false;
                if (controls) controls.enabled = false;
            } else if (mode === 'script') {
                // Full JS control
                cameraClaimOwner = options.layerId ?? null;
                physicalCameraHandle = null;
                camera.matrixAutoUpdate = true;
                if (controls) {
                    if (prevMode !== 'script') controlsEnabledBeforeClaim = controls.enabled;
                    controls.enabled = options.enableControls ?? false;
                }
            }
            try {
                onCameraModeChange?.(mode, {
                    handle: physicalCameraHandle,
                    owner: cameraClaimOwner,
                    enableControls: options.enableControls ?? false,
                });
            } catch (error) {
                console.error('[LayerManager] camera mode change callback error', error);
            }
            return true;
        },
        claim(layerId) {
            if (cameraMode === 'script' && cameraClaimOwner && cameraClaimOwner !== layerId) return false;
            return this.setMode('script', { layerId, enableControls: false });
        },
        release(layerId) {
            if (cameraMode === 'script' && (!layerId || cameraClaimOwner === layerId)) {
                return this.setMode('viewport');
            }
            return false;
        },
        isClaimed() { return cameraMode === 'script' && cameraClaimOwner !== null; },
        isScriptMode() { return cameraMode === 'script'; },
        isViewportMode() { return cameraMode === 'viewport'; },
        isPhysicalMode() { return cameraMode === 'physical'; },
        getOwner() { return cameraClaimOwner; },
        getPhysicalCameraHandle() { return physicalCameraHandle; },
        getControls() { return controls; },
        getCamera() { return getCamera ? getCamera() : camera; },
    };

    const isWebGPU = !!(renderer?.backend?.parameters?.forceWebGL === undefined
        && renderer?.backend?.constructor?.name !== 'WebGLBackend');

    let dt = 0;
    let elapsed = 0;
    const runtimeTransformOverrides = new Map();
    const transformScratch = {
        localMatrix: new THREE.Matrix4(),
        finalMatrix: new THREE.Matrix4(),
        baseInverse: new THREE.Matrix4(),
        parentWorldMatrix: new THREE.Matrix4(),
        parentWorldInverse: new THREE.Matrix4(),
        worldMatrix: new THREE.Matrix4(),
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(),
        deltaPosition: new THREE.Vector3(),
        deltaQuaternion: new THREE.Quaternion(),
        deltaScale: new THREE.Vector3(),
        euler: new THREE.Euler(),
    };

    function applyObjectLocalMatrix(obj, matrix) {
        if (!obj?.isObject3D) return false;
        obj.matrixAutoUpdate = false;
        obj.matrix.copy(matrix);
        obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
        obj.matrixWorldNeedsUpdate = true;
        obj.updateWorldMatrix(false, true);
        return true;
    }

    function createRuntimeTransformState(handle, layerId, obj = null) {
        const source = obj ?? nodeMap.get(handle) ?? null;
        const baseMatrix = source?.matrix?.clone?.() ?? new THREE.Matrix4();
        return {
            handle,
            ownerLayer: layerId ?? null,
            mode: 'additive',
            baseMatrix,
            lastAppliedMatrix: baseMatrix.clone(),
            position: new THREE.Vector3(0, 0, 0),
            quaternion: new THREE.Quaternion(),
            scale: new THREE.Vector3(1, 1, 1),
        };
    }

    function composeRuntimeTransformState(state, target, obj = null) {
        if (state.mode === 'absolute') {
            return target.compose(state.position, state.quaternion, state.scale);
        }
        if (state.mode === 'world') {
            // Build world matrix from world-space position/quaternion/scale
            transformScratch.worldMatrix.compose(state.position, state.quaternion, state.scale);
            // Get parent's world matrix (if object has a parent)
            const parent = obj?.parent;
            if (parent?.isObject3D) {
                parent.updateWorldMatrix(true, false);
                transformScratch.parentWorldInverse.copy(parent.matrixWorld).invert();
                // localMatrix = parentWorldInverse * worldMatrix
                return target.copy(transformScratch.parentWorldInverse).multiply(transformScratch.worldMatrix);
            }
            // No parent means world = local
            return target.copy(transformScratch.worldMatrix);
        }
        // additive mode: baseMatrix * localOffset
        transformScratch.localMatrix.compose(state.position, state.quaternion, state.scale);
        return target.copy(state.baseMatrix).multiply(transformScratch.localMatrix);
    }

    function syncRuntimeTransformBaseFromScene(state, obj) {
        if (!state || !obj?.isObject3D) return;
        if (!matrixElementsAlmostEqual(obj.matrix, state.lastAppliedMatrix)) {
            state.baseMatrix.copy(obj.matrix);
        }
    }

    function setRuntimeTransformStateMode(state, mode, obj, preserveCurrent = true) {
        if (!state || (mode !== 'additive' && mode !== 'absolute' && mode !== 'world') || state.mode === mode) return state;
        const currentMatrix = preserveCurrent
            ? composeRuntimeTransformState(state, transformScratch.finalMatrix, obj)
            : (obj?.matrix?.clone?.() ?? state.baseMatrix.clone());
        if (mode === 'world') {
            // Convert current local matrix to world space
            if (obj?.isObject3D) {
                obj.updateWorldMatrix(true, false);
                transformScratch.worldMatrix.copy(currentMatrix);
                if (obj.parent?.isObject3D) {
                    transformScratch.worldMatrix.premultiply(obj.parent.matrixWorld);
                }
                transformScratch.worldMatrix.decompose(state.position, state.quaternion, state.scale);
            } else {
                currentMatrix.decompose(state.position, state.quaternion, state.scale);
            }
        } else if (mode === 'absolute') {
            currentMatrix.decompose(state.position, state.quaternion, state.scale);
        } else {
            // additive
            transformScratch.baseInverse.copy(state.baseMatrix).invert();
            transformScratch.localMatrix.copy(transformScratch.baseInverse).multiply(currentMatrix);
            transformScratch.localMatrix.decompose(state.position, state.quaternion, state.scale);
        }
        state.mode = mode;
        return state;
    }

    function applyRuntimeTransformState(state, obj) {
        if (!state || !obj?.isObject3D) return false;
        syncRuntimeTransformBaseFromScene(state, obj);
        const finalMatrix = composeRuntimeTransformState(state, transformScratch.finalMatrix, obj);
        applyObjectLocalMatrix(obj, finalMatrix);
        state.lastAppliedMatrix.copy(finalMatrix);
        return true;
    }

    function getOrCreateRuntimeTransformState(handle, layerId, obj = null) {
        let state = runtimeTransformOverrides.get(handle);
        if (!state) {
            state = createRuntimeTransformState(handle, layerId, obj);
            runtimeTransformOverrides.set(handle, state);
        }
        if (layerId != null) state.ownerLayer = layerId;
        return state;
    }

    function clearRuntimeTransformOverride(handle) {
        const state = runtimeTransformOverrides.get(handle);
        if (!state) return false;
        const obj = nodeMap.get(handle);
        if (obj?.isObject3D) applyObjectLocalMatrix(obj, state.baseMatrix);
        runtimeTransformOverrides.delete(handle);
        return true;
    }

    function clearRuntimeTransformOverridesForLayer(layerId) {
        if (!layerId) return;
        for (const [handle, state] of [...runtimeTransformOverrides.entries()]) {
            if (state.ownerLayer === layerId) clearRuntimeTransformOverride(handle);
        }
    }

    function applyAllRuntimeTransformOverrides() {
        for (const [handle, state] of runtimeTransformOverrides.entries()) {
            const obj = nodeMap.get(handle);
            if (!obj?.isObject3D) continue;
            applyRuntimeTransformState(state, obj);
        }
    }

    function getRuntimeTransformStateSnapshot(handle) {
        const state = runtimeTransformOverrides.get(handle);
        if (!state) return null;
        const obj = nodeMap.get(handle);
        const currentMatrix = composeRuntimeTransformState(state, transformScratch.finalMatrix, obj);
        currentMatrix.decompose(transformScratch.position, transformScratch.quaternion, transformScratch.scale);
        return freezePlainObject({
            handle,
            mode: state.mode,
            position: transformScratch.position.toArray(),
            quaternion: transformScratch.quaternion.toArray(),
            scale: transformScratch.scale.toArray(),
            baseMatrix: state.baseMatrix.toArray(),
            matrix: currentMatrix.toArray(),
        });
    }

    function serializeRuntimeTransformOverrides() {
        const out = [];
        for (const [handle, state] of runtimeTransformOverrides.entries()) {
            const obj = nodeMap.get(handle);
            const currentMatrix = composeRuntimeTransformState(state, transformScratch.finalMatrix, obj);
            currentMatrix.decompose(transformScratch.position, transformScratch.quaternion, transformScratch.scale);
            out.push({
                handle,
                mode: state.mode,
                position: transformScratch.position.toArray(),
                quaternion: transformScratch.quaternion.toArray(),
                scale: transformScratch.scale.toArray(),
            });
        }
        return out;
    }

    function restoreRuntimeTransformOverrides(serialized = []) {
        if (!Array.isArray(serialized)) return 0;
        let restored = 0;
        for (const item of serialized) {
            const handle = item?.handle;
            const obj = nodeMap.get(handle);
            if (!obj?.isObject3D) continue;
            const state = getOrCreateRuntimeTransformState(handle, null, obj);
            state.mode = item.mode === 'world'
                ? 'world'
                : (item.mode === 'absolute' ? 'absolute' : 'additive');
            state.baseMatrix.copy(obj.matrix);
            state.lastAppliedMatrix.copy(obj.matrix);
            if (Array.isArray(item.position) && item.position.length >= 3) state.position.fromArray(item.position);
            else state.position.set(0, 0, 0);
            if (Array.isArray(item.quaternion) && item.quaternion.length >= 4) state.quaternion.fromArray(item.quaternion);
            else state.quaternion.identity();
            if (Array.isArray(item.scale) && item.scale.length >= 3) state.scale.fromArray(item.scale);
            else state.scale.set(1, 1, 1);
            applyRuntimeTransformState(state, obj);
            restored++;
        }
        return restored;
    }

    function createTransformApi(handle, getObject, layerId) {
        function getSceneObject() {
            const obj = getObject();
            return obj?.isObject3D ? obj : null;
        }

        function ensureState(mode, preserveCurrent = true) {
            const obj = getSceneObject();
            if (!obj) return null;
            const state = getOrCreateRuntimeTransformState(handle, layerId, obj);
            setRuntimeTransformStateMode(state, mode, obj, preserveCurrent);
            return { state, obj };
        }

        function mutate(mode, mutator, options = {}) {
            const payload = ensureState(mode, options.preserveCurrent !== false);
            if (!payload) return false;
            const { state, obj } = payload;
            mutator(state.position, state.quaternion, state.scale, state, obj);
            applyRuntimeTransformState(state, obj);
            return true;
        }

        return freezePlainObject({
            get hasOverride() { return runtimeTransformOverrides.has(handle); },
            get mode() { return runtimeTransformOverrides.get(handle)?.mode ?? null; },
            clear() { return clearRuntimeTransformOverride(handle); },
            snapshot() { return getRuntimeTransformStateSnapshot(handle); },
            setMode(mode, options = {}) {
                const validMode = mode === 'world' ? 'world' : (mode === 'absolute' ? 'absolute' : 'additive');
                const payload = ensureState(validMode, options.preserveCurrent !== false);
                if (!payload) return false;
                applyRuntimeTransformState(payload.state, payload.obj);
                return true;
            },
            setPosition(x = 0, y = 0, z = 0, options = {}) {
                return mutate(options.mode === 'additive' ? 'additive' : 'absolute', position => {
                    position.set(x, y, z);
                }, options);
            },
            offsetPosition(x = 0, y = 0, z = 0) {
                return mutate('additive', position => {
                    position.add(transformScratch.deltaPosition.set(x, y, z));
                });
            },
            setRotationEuler(x = 0, y = 0, z = 0, options = {}) {
                return mutate(options.mode === 'additive' ? 'additive' : 'absolute', (position, quaternion) => {
                    quaternion.setFromEuler(transformScratch.euler.set(x, y, z, 'XYZ'));
                }, options);
            },
            offsetRotationEuler(x = 0, y = 0, z = 0) {
                return mutate('additive', (position, quaternion) => {
                    transformScratch.deltaQuaternion.setFromEuler(transformScratch.euler.set(x, y, z, 'XYZ'));
                    quaternion.multiply(transformScratch.deltaQuaternion);
                });
            },
            setQuaternion(x = 0, y = 0, z = 0, w = 1, options = {}) {
                return mutate(options.mode === 'additive' ? 'additive' : 'absolute', (position, quaternion) => {
                    quaternion.set(x, y, z, w).normalize();
                }, options);
            },
            setScale(x = 1, y = x, z = x, options = {}) {
                return mutate(options.mode === 'additive' ? 'additive' : 'absolute', (position, quaternion, scale) => {
                    scale.set(x, y, z);
                }, options);
            },
            multiplyScale(x = 1, y = x, z = x) {
                return mutate('additive', (position, quaternion, scale) => {
                    scale.multiply(transformScratch.deltaScale.set(x, y, z));
                });
            },
            // World-space transform methods for physics
            setWorldPosition(x = 0, y = 0, z = 0) {
                return mutate('world', position => {
                    position.set(x, y, z);
                });
            },
            setWorldQuaternion(x = 0, y = 0, z = 0, w = 1) {
                return mutate('world', (position, quaternion) => {
                    quaternion.set(x, y, z, w).normalize();
                });
            },
            setWorldRotationEuler(x = 0, y = 0, z = 0) {
                return mutate('world', (position, quaternion) => {
                    quaternion.setFromEuler(transformScratch.euler.set(x, y, z, 'XYZ'));
                });
            },
            setWorldTransform(px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = sx, sz = sx) {
                return mutate('world', (position, quaternion, scale) => {
                    position.set(px, py, pz);
                    quaternion.set(qx, qy, qz, qw).normalize();
                    scale.set(sx, sy, sz);
                });
            },
            setWorldMatrix(matrix) {
                // matrix can be THREE.Matrix4 or Float32Array/Array of 16 elements
                return mutate('world', (position, quaternion, scale) => {
                    if (matrix?.isMatrix4) {
                        matrix.decompose(position, quaternion, scale);
                    } else if (Array.isArray(matrix) || ArrayBuffer.isView(matrix)) {
                        transformScratch.worldMatrix.fromArray(matrix);
                        transformScratch.worldMatrix.decompose(position, quaternion, scale);
                    }
                });
            },
        });
    }

    function emitChange(reason = 'state') {
        for (const listener of listeners) {
            try {
                listener(reason);
            } catch (error) {
                console.error('[LayerManager] listener error', error);
            }
        }
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function snapshotLayer(layer) {
        return {
            id: layer.id,
            name: layer.name,
            source: layer.source,
            entry: layer.entry,
            code: layer.code,
            active: layer.active,
            loading: layer.loading,
            error: layer.error,
            anchors: layer.anchors.length,
            tracked: layer.tracked.size,
            profile: freezePlainObject({
                mountMs: layer.profile.mountMs,
                lastUpdateMs: layer.profile.lastUpdateMs,
                avgUpdateMs: layer.profile.avgUpdateMs,
                maxUpdateMs: layer.profile.maxUpdateMs,
                updateCount: layer.profile.updateCount,
            }),
        };
    }

    function ownForLayer(resource, owner = OWNER_JS) {
        return markOwned(resource, owner);
    }

    function getOrCreateLayerInput(layer) {
        if (!layer.input) layer.input = createInputHelper(renderer);
        return layer.input;
    }

    function cloneMaterialForLayer(material, owner) {
        if (!material) return material;
        if (Array.isArray(material)) return material.map(item => cloneMaterialForLayer(item, owner));
        const clone = material.clone();
        for (const key of MATERIAL_MAP_KEYS) {
            if (material[key]?.clone) clone[key] = markOwned(material[key].clone(), owner);
        }
        return markOwned(clone, owner);
    }

    function cloneMaxNode(handle, options = {}) {
        const source = nodeMap.get(handle);
        if (!source?.isObject3D) return null;
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        const clone = source.clone(false);
        clone.name = options.name || `${source.name || 'node'}_clone`;
        clone.matrixAutoUpdate = false;
        clone.matrix.copy(source.matrixWorld);
        clone.matrixWorld.copy(source.matrixWorld);
        clone.matrixWorldNeedsUpdate = true;
        clone.visible = true;
        if (source.geometry?.clone) clone.geometry = markOwned(source.geometry.clone(), owner);
        if (source.material) {
            if (source.userData?.jsmod) {
                // three.js Deform layers own geometry, but material edits from Max
                // should keep flowing to the runtime clone without a refresh.
                clone.material = source.material;
                clone.userData.maxjsSourceHandle = handle;
                clone.userData.maxjsFollowSourceMaterial = true;
            } else {
                clone.material = cloneMaterialForLayer(source.material, owner);
            }
        }
        return markOwned(clone, owner);
    }

    function createAnchorForLayer(layer, handle, options = {}) {
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
        const anchor = markOwned(new THREE.Group(), owner);
        anchor.name = options.name || `anchor_${handle}`;
        anchor.matrixAutoUpdate = false;
        anchor.userData.maxjsAnchorHandle = handle;
        anchor.userData.maxjsFollowVisibility = options.followVisibility !== false;
        anchor.userData.maxjsCopyWorldMatrix = options.copyWorldMatrix !== false;
        if (options.snapshotId) setSnapshotTargetId(anchor, `runtime:${layer.id}:${options.snapshotId}`);
        layer.anchors.push(anchor);
        parent.add(anchor);
        return anchor;
    }

    function getLayerNodeAdapter(layer, handle, explicitObj = null) {
        // Check if handle exists in nodeMap or lightHandleMap
        const fromNodeMap = nodeMap.has(handle);
        const fromLightMap = lightHandleMap?.has(handle);
        if (!fromNodeMap && !fromLightMap && !explicitObj) return null;

        let adapter = layer.nodeAdapters.get(handle);
        if (!adapter) {
            adapter = createMaxNodeAdapter({
                handle,
                getObject: () => explicitObj ?? nodeMap.get(handle) ?? lightHandleMap?.get(handle) ?? null,
                THREE,
                createAnchor: (nextHandle, options) => createAnchorForLayer(layer, nextHandle, options),
                layerId: layer.id,
                getTransformApi: createTransformApi,
            });
            layer.nodeAdapters.set(handle, adapter);
        }
        return adapter;
    }

    function buildContext(layer) {
        const rendererFacade = createRendererFacade(renderer);
        const cameraFacade = createCameraAdapter(camera, THREE, ownForLayer, cameraControl, layer.id, debugWarn);
        const nodeMapFacade = createNodeMapFacade(nodeMap, handle => getLayerNodeAdapter(layer, handle));
        const maxSceneFacade = createMaxSceneFacade({
            scene,
            nodeMap,
            lightHandleMap,
            getAdapter: (handle, explicitObj) => getLayerNodeAdapter(layer, handle, explicitObj),
            createAnchor: (handle, options = {}) => createAnchorForLayer(layer, handle, options),
            THREE,
        });

        const runtimeFacade = freezePlainObject({
            get id() { return layer.id; },
            get name() { return layer.name; },
            get isWebGPU() { return isWebGPU; },
            get dt() { return dt; },
            get elapsed() { return elapsed; },
            // Scene coordinate info — world is Y-up (Three.js default), Max Z-up converted on input
            upAxis: Object.freeze(new THREE.Vector3(0, 1, 0)),
            gravity: Object.freeze(new THREE.Vector3(0, -980, 0)),
            space,
            units: 'cm',
            log: (...args) => debugLog(`[Layer:${layer.id}]`, ...args),
            warn: (...args) => debugWarn(`[Layer:${layer.id}]`, ...args),
            error: (...args) => console.error(`[Layer:${layer.id}]`, ...args),
        });

        const projectFacade = freezePlainObject({
            setDirectory(dir, options = {}) {
                if (!projectControl?.setProjectDirectory) {
                    throw new Error('Project runtime is not bound');
                }
                return projectControl.setProjectDirectory(dir, options);
            },
            reload(force = true) {
                if (!projectControl?.reload) {
                    throw new Error('Project runtime is not bound');
                }
                return projectControl.reload(force);
            },
            getState() {
                return projectControl?.getState?.() ?? null;
            },
        });

        const jsFacade = freezePlainObject({
            root: layer.group,
            overlayRoot: layer.overlayGroup,
            own(resource, options = {}) {
                return ownForLayer(resource, options.overlay ? OWNER_OVERLAY : OWNER_JS);
            },
            add(resource, options = {}) {
                if (!resource?.isObject3D) return null;
                const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
                const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
                markOwned(resource, owner);
                if (options.snapshotId) setSnapshotTargetId(resource, `runtime:${layer.id}:${options.snapshotId}`);
                parent.add(resource);
                return resource;
            },
            remove(resource) {
                if (!resource?.isObject3D || !isOwnedByJs(resource)) return false;
                resource.parent?.remove(resource);
                disposeOwnedResource(resource);
                return true;
            },
            createGroup(name = '', options = {}) {
                const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
                const group = markOwned(new THREE.Group(), owner);
                if (name) group.name = name;
                if (options.snapshotId) setSnapshotTargetId(group, `runtime:${layer.id}:${options.snapshotId}`);
                const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
                parent.add(group);
                return group;
            },
            createAnchor(handle, options = {}) {
                return createAnchorForLayer(layer, handle, options);
            },
            cloneFromMax(handle, options = {}) {
                const clone = cloneMaxNode(handle, options);
                if (!clone) return null;
                if (options.snapshotId) setSnapshotTargetId(clone, `runtime:${layer.id}:${options.snapshotId}`);
                const parent = options.overlay ? layer.overlayGroup : layer.group;
                parent.add(clone);
                if (clone.userData?.maxjsFollowSourceMaterial) layer.liveMaterialClones.add(clone);
                return clone;
            },
            track(resource, options = {}) {
                if (!resource) return resource;
                markOwned(resource, options.overlay ? OWNER_OVERLAY : OWNER_JS);
                if (options.snapshotId) setSnapshotTargetId(resource, `runtime:${layer.id}:${options.snapshotId}`);
                layer.tracked.add(resource);
                return resource;
            },
            setSnapshotId(resource, id) {
                if (!resource?.isObject3D || !id) return resource;
                return setSnapshotTargetId(resource, `runtime:${layer.id}:${id}`);
            },
            dispose(resource) {
                disposeOwnedResource(resource);
            },
        });

        return {
            layer: freezePlainObject({ id: layer.id, name: layer.name }),
            group: layer.group,
            overlayGroup: layer.overlayGroup,
            js: jsFacade,
            scene: maxSceneFacade,
            maxScene: maxSceneFacade,
            nodeMap: nodeMapFacade,
            camera: cameraFacade,
            renderer: rendererFacade,
            get input() {
                return getOrCreateLayerInput(layer);
            },
            THREE,
            clock: freezePlainObject({
                get dt() { return dt; },
                get elapsed() { return elapsed; },
            }),
            runtime: runtimeFacade,
            project: projectFacade,
            track(resource, options = {}) {
                return jsFacade.track(resource, options);
            },
        };
    }

    function syncAnchors(layer, syncCache) {
        for (const anchor of layer.anchors) {
            const handle = anchor.userData.maxjsAnchorHandle;
            let sourceState = syncCache.get(handle);
            if (sourceState === undefined) {
                const source = nodeMap.get(handle);
                if (!source) {
                    sourceState = null;
                } else {
                    source.updateWorldMatrix(true, false);
                    sourceState = {
                        visible: !!source.visible,
                        matrixWorld: source.matrixWorld,
                    };
                }
                syncCache.set(handle, sourceState);
            }

            if (!sourceState) {
                anchor.visible = false;
                continue;
            }
            anchor.visible = anchor.userData.maxjsFollowVisibility ? sourceState.visible : true;
            if (anchor.userData.maxjsCopyWorldMatrix) {
                anchor.matrix.copy(sourceState.matrixWorld);
                anchor.matrixWorldNeedsUpdate = true;
            }
        }
    }

    function syncLiveMaterialClones(layer) {
        for (const clone of [...layer.liveMaterialClones]) {
            if (!clone?.isObject3D || !clone.parent) {
                layer.liveMaterialClones.delete(clone);
                continue;
            }
            if (!clone.userData?.maxjsFollowSourceMaterial) {
                layer.liveMaterialClones.delete(clone);
                continue;
            }

            const handle = clone.userData.maxjsSourceHandle;
            const source = Number.isFinite(handle) ? nodeMap.get(handle) : null;
            if (!source?.isObject3D) {
                clone.visible = false;
                continue;
            }

            if (clone.material !== source.material) clone.material = source.material;
        }
    }

    function createLayerState(id, options = {}) {
        if (layers.has(id)) remove(id);

        const group = markOwned(new THREE.Group(), OWNER_JS);
        group.name = `__inline_${id}__`;
        group.matrixAutoUpdate = false;
        group.matrix.identity();
        setSnapshotTargetId(group, `runtime:${id}:root`);

        const overlayGroup = markOwned(new THREE.Group(), OWNER_OVERLAY);
        overlayGroup.name = `__inline_overlay_${id}__`;
        overlayGroup.matrixAutoUpdate = false;
        overlayGroup.matrix.identity();
        setSnapshotTargetId(overlayGroup, `runtime:${id}:overlay_root`);

        const layer = {
            id,
            name: options.name || id,
            code: options.code || '',
            group,
            overlayGroup,
            source: options.source || 'inline',
            entry: options.entry || '',
            hooks: null,
            active: true,
            loading: false,
            error: null,
            errorCount: 0,
            tracked: new Set(),
            anchors: [],
            liveMaterialClones: new Set(),
            nodeAdapters: new Map(),
            input: null,
            profile: {
                mountMs: 0,
                lastUpdateMs: 0,
                avgUpdateMs: 0,
                maxUpdateMs: 0,
                updateCount: 0,
            },
            ctx: null,
        };

        jsWorldRoot.add(group);
        overlayWorldRoot.add(overlayGroup);
        layer.ctx = buildContext(layer);
        layers.set(id, layer);
        emitChange('mounting');
        return layer;
    }

    async function mount(id, createHooks, options = {}) {
        const layer = createLayerState(id, options);
        const mountStart = performance.now();
        const mountToken = Symbol(id);
        layer.loading = true;
        layer.mountToken = mountToken;
        try {
            const hooks = await createHooks(layer.ctx, THREE);
            if (layers.get(id) !== layer || layer.mountToken !== mountToken) {
                return { id, error: 'Layer replaced during load' };
            }
            layer.hooks = hooks || {};
            if (typeof layer.hooks.init === 'function') {
                await layer.hooks.init(layer.ctx);
            }
        } catch (err) {
            layer.error = err?.message || String(err);
            layer.active = false;
            console.error(`[LayerManager] Layer "${id}" init error:`, err);
        } finally {
            if (layers.get(id) === layer) layer.loading = false;
        }
        layer.profile.mountMs = performance.now() - mountStart;
        lastMountMs = layer.profile.mountMs;
        emitChange('mounted');
        return { id, error: layer.error };
    }

    function inject(id, code, name) {
        return mount(id, async (ctx, runtimeThree) => {
            const factory = buildInlineFactory(code);
            return factory(ctx, runtimeThree, sandboxDocument);
        }, { name: name || id, code, source: 'inline' });
    }

    function remove(id, options = {}) {
        const layer = layers.get(id);
        if (!layer) return false;

        if (layer.hooks && typeof layer.hooks.dispose === 'function') {
            try {
                layer.hooks.dispose(layer.ctx);
            } catch (err) {
                debugWarn(`[LayerManager] Layer "${id}" dispose error:`, err);
            }
        }

        for (const resource of layer.tracked) {
            try {
                disposeOwnedResource(resource);
            } catch (err) {
                debugWarn(`[LayerManager] Layer "${id}" tracked dispose error:`, err);
            }
        }
        layer.tracked.clear();
        layer.anchors.length = 0;
        layer.nodeAdapters.clear();
        if (layer.input) { layer.input.dispose(); layer.input = null; }
        clearRuntimeTransformOverridesForLayer(id);

        jsWorldRoot.remove(layer.group);
        overlayWorldRoot.remove(layer.overlayGroup);
        disposeOwnedResource(layer.group);
        disposeOwnedResource(layer.overlayGroup);

        // Safety: release camera if this layer had claimed it
        if (cameraControl.getOwner() === id) {
            cameraControl.release(id);
        }

        layers.delete(id);
        if (!options.silent) emitChange('removed');
        return true;
    }

    function clearWhere(predicate = null) {
        let changed = false;
        for (const [id, layer] of [...layers.entries()]) {
            if (predicate && !predicate(layer)) continue;
            changed = remove(id, { silent: true }) || changed;
        }
        if (changed) emitChange('cleared');
    }

    function clear() {
        clearWhere();
    }

    function clearInline() {
        clearWhere(layer => layer.source === 'inline');
    }

    function list() {
        return [...layers.values()].map(layer => snapshotLayer(layer));
    }

    function getLayerSnapshot(id) {
        const layer = layers.get(id);
        return layer ? snapshotLayer(layer) : null;
    }

    function getStats() {
        return lastStats;
    }

    function update(frameDt, frameElapsed) {
        dt = frameDt;
        elapsed = frameElapsed;
        const anchorSyncCache = new Map();
        let activeLayerCount = 0;
        let anchorCount = 0;
        let trackedCount = 0;
        let totalUpdateMs = 0;

        applyAllRuntimeTransformOverrides();

        for (const layer of layers.values()) {
            anchorCount += layer.anchors.length;
            trackedCount += layer.tracked.size;
            if (layer.active) activeLayerCount++;

            if (layer.loading || !layer.active || !layer.hooks || typeof layer.hooks.update !== 'function') {
                syncAnchors(layer, anchorSyncCache);
                syncLiveMaterialClones(layer);
                continue;
            }
            try {
                const updateStart = performance.now();
                syncAnchors(layer, anchorSyncCache);
                syncLiveMaterialClones(layer);
                layer.hooks.update(layer.ctx, dt, elapsed);
                const updateMs = performance.now() - updateStart;
                totalUpdateMs += updateMs;
                layer.profile.lastUpdateMs = updateMs;
                layer.profile.updateCount += 1;
                layer.profile.avgUpdateMs += (updateMs - layer.profile.avgUpdateMs) / layer.profile.updateCount;
                layer.profile.maxUpdateMs = Math.max(layer.profile.maxUpdateMs, updateMs);
                layer.errorCount = 0;
            } catch (err) {
                layer.errorCount++;
                if (layer.errorCount >= MAX_CONSECUTIVE_ERRORS) {
                    layer.active = false;
                    layer.error = `Auto-deactivated after ${MAX_CONSECUTIVE_ERRORS} errors: ${err.message}`;
                    console.error(`[LayerManager] Layer "${layer.id}" deactivated:`, err);
                    emitChange('deactivated');
                }
            }
        }

        applyAllRuntimeTransformOverrides();

        // Re-sync anchors after runtime transform overrides are applied,
        // so anchors reflect the current frame's transforms, not the previous frame's.
        for (const layer of layers.values()) {
            syncAnchors(layer, anchorSyncCache);
        }

        lastStats = freezePlainObject({
            layerCount: layers.size,
            activeLayerCount,
            anchorCount,
            trackedCount,
            updateMs: totalUpdateMs,
            lastMountMs,
        });
    }

    function getLayerCode(id) {
        return layers.get(id)?.code ?? null;
    }

    function isDescendantOf(obj, ancestor) {
        let p = obj;
        while (p) {
            if (p === ancestor) return true;
            p = p.parent;
        }
        return false;
    }

    /** Max-bridge meshes currently hidden in the viewport (e.g. jsmod layers show JS clones instead). */
    function collectHiddenMaxSyncHandles() {
        if (!maxRoot) return [];
        const out = [];
        for (const [handle, obj] of nodeMap.entries()) {
            if (!obj?.isObject3D) continue;
            if (!isDescendantOf(obj, maxRoot)) continue;
            const drawable = obj.isMesh || obj.isLine || obj.isLineSegments;
            if (!drawable) continue;
            if (!obj.visible) out.push(handle);
        }
        return out;
    }

    /** Meshes driven by three.js Deform (jsmod); snapshot embeds JS clones under jsRoot — always hide these Max copies when jsRoot is present. */
    function collectJsmodMaxSyncHandles() {
        if (!maxRoot) return [];
        const out = [];
        for (const [handle, obj] of nodeMap.entries()) {
            if (!obj?.isObject3D) continue;
            if (!isDescendantOf(obj, maxRoot)) continue;
            const drawable = obj.isMesh || obj.isLine || obj.isLineSegments;
            if (!drawable) continue;
            if (obj.userData?.jsmod) out.push(handle);
        }
        return out;
    }

    /**
     * Snapshot everything under a runtime world root (all layer groups + any future direct children),
     * plus tracked Object3Ds that are not already in that subtree (e.g. ctx.track only).
     */
    function buildRuntimeSubtreeJson(worldRoot, snapshotName, trackedOwnerFilter) {
        const snapshot = new THREE.Group();
        snapshot.name = snapshotName;

        if (worldRoot?.isObject3D) {
            for (const child of worldRoot.children) {
                if (!child?.isObject3D) continue;
                if (child.userData?.maxjsExcludeFromRuntimeSnapshot) continue;
                snapshot.add(child.clone(true));
            }
        }

        if (trackedOwnerFilter != null) {
            for (const layer of layers.values()) {
                for (const t of layer.tracked) {
                    if (!t?.isObject3D) continue;
                    if (getOwner(t) !== trackedOwnerFilter) continue;
                    if (isDescendantOf(t, worldRoot)) continue;
                    snapshot.add(t.clone(true));
                }
            }
        }

        return snapshot.children.length > 0 ? snapshot.toJSON() : null;
    }

    function serializeSnapshot() {
        const jsRoot = buildRuntimeSubtreeJson(jsWorldRoot, '__maxjs_snapshot_js_root__', OWNER_JS);
        const overlayRoot = buildRuntimeSubtreeJson(overlayWorldRoot, '__maxjs_snapshot_overlay_root__', OWNER_OVERLAY);
        const payload = {
            version: 1,
            layers: [...layers.values()].map(layer => ({
                id: layer.id,
                name: layer.name,
                source: layer.source,
                active: layer.active,
                error: layer.error,
            })),
            jsRoot,
            overlayRoot,
        };
        const transformOverrides = serializeRuntimeTransformOverrides();
        if (transformOverrides.length > 0) payload.transformOverrides = transformOverrides;
        if (jsRoot || overlayRoot) {
            const hidden = new Set(collectHiddenMaxSyncHandles());
            if (jsRoot) {
                for (const h of collectJsmodMaxSyncHandles()) hidden.add(h);
            }
            payload.hideMaxSyncHandles = [...hidden];
        }
        return payload;
    }

    function serialize() {
        return [...layers.values()].map(layer => ({
            id: layer.id,
            name: layer.name,
            code: layer.code,
            enabled: layer.active,
        }));
    }

    return {
        mount,
        subscribe,
        bindProjectRuntime(control) {
            projectControl = control;
            emitChange('project_bound');
        },
        inject,
        remove,
        clear,
        clearInline,
        setActive(id, active) {
            const layer = layers.get(id);
            if (!layer) return false;
            const next = !!active;
            if (layer.active === next && !!layer.group?.visible === next) return false;
            layer.active = next;
            if (layer.group) layer.group.visible = next;
            if (layer.overlayGroup) layer.overlayGroup.visible = next;
            emitChange(next ? 'activated' : 'deactivated');
            return true;
        },
        list,
        getLayerSnapshot,
        getStats,
        update,
        getLayerCode,
        serializeSnapshot,
        restoreTransformOverrides: restoreRuntimeTransformOverrides,
        serialize,
        get isCameraOverridden() { return cameraControl.isScriptMode(); },
        get cameraMode() { return cameraControl.getMode(); },
        roots: freezePlainObject({
            maxRoot,
            jsRoot: jsWorldRoot,
            overlayRoot: overlayWorldRoot,
        }),
    };
}
