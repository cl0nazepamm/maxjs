// Runtime camera facade exposed to layer contexts.

import { OWNER_JS, OWNER_OVERLAY } from './layer_ownership.js';
import { freezePlainObject } from './layer_utils.js';

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
export { createCameraAdapter };
