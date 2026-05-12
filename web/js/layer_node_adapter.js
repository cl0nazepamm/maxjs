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

function createMaxNodeAdapter({ handle, getObject, THREE, createAnchor, layerId, getTransformApi, setMaterialMap }) {
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
        getBoundingBox() {
            const obj = getObject();
            return obj ? new THREE.Box3().setFromObject(obj) : null;
        },
        transform,
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
export { createMaxNodeAdapter };
