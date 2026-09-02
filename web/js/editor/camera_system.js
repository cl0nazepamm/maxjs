// camera_system.js - editor scene camera sync, standalone camera state, and orbit feel.
import * as THREE from 'three';

function createCameraSystem(deps = {}) {
        // ── Camera-only sync (30fps) ─────────────────────────
        deps.bridge.on('cam', msg => {
            if (msg.camera) applyCamera(msg.camera);
            if (msg.frame || msg.stats) {
                deps.updateSyncHud({
                    transport: 'json',
                    frameId: msg.frame ?? 0,
                    producerBytes: msg.stats?.producerBytes ?? 0,
                    decodeMs: 0,
                    applyMs: 0,
                });
            }
        });

        // ── Scene Camera Lock ────────────────────────────────
        const selSceneCamera = document.getElementById('selSceneCamera');
        let knownSceneCameras = [];
        let layerHostFrame = null;
        let viewportCameraSeeded = false;

        function updateSceneCameraList(cameras, lockedHandle) {
            knownSceneCameras = cameras || [];
            const current = selSceneCamera.value;
            selSceneCamera.innerHTML = '<option value="0">Viewport</option>';
            for (const c of knownSceneCameras) {
                const opt = document.createElement('option');
                opt.value = String(c.h);
                opt.textContent = c.n || `Camera ${c.h}`;
                selSceneCamera.appendChild(opt);
            }
            // Restore selection
            const target = lockedHandle != null ? String(lockedHandle) : current;
            if ([...selSceneCamera.options].some(o => o.value === target)) {
                selSceneCamera.value = target;
            } else {
                selSceneCamera.value = '0';
            }
        }

        selSceneCamera.addEventListener('change', () => {
            const handle = parseInt(selSceneCamera.value, 10) || 0;
            deps.bridge.send('lock_camera', { handle: String(handle) });
        });

        function syncCameraLockButtonUi() {
            const el = document.getElementById('btnCamLock');
            if (!el) return;
            const layerMode = deps.layerManager?.cameraMode ?? 'viewport';
            const layerOwned = layerMode !== 'viewport';
            el.classList.toggle('active', deps.camLock || layerOwned);
            el.disabled = layerOwned;
            el.title = layerOwned
                ? `Camera owned by runtime layer — ${layerMode} mode overrides viewer lock`
                : deps.camLock ? 'Camera lock on — navigation disabled' : 'Camera lock off — orbit/pan enabled';
            el.setAttribute('aria-pressed', deps.camLock ? 'true' : 'false');
            el.setAttribute('aria-label', layerOwned
                ? 'Camera controlled by runtime layer'
                : deps.camLock ? 'Camera lock on' : 'Camera lock off — orbit and pan');
        }

        function syncCameraControlAvailability() {
            if (!deps.controls || deps.xrRuntime?.active) return false;
            const layerMode = deps.layerManager?.cameraMode ?? 'viewport';
            if (layerMode === 'viewport') deps.controls.enableZoom = false;
            const enabled = layerMode === 'script'
                ? deps.layerManager?.cameraControlsMode === 'viewer'
                : layerMode === 'physical'
                    ? false
                    : !deps.camLock;
            deps.controls.enabled = enabled;
            return enabled;
        }

        function applyLayerCameraMode(mode, options = {}) {
            if (options.previousMode === 'viewport' && mode !== 'viewport' && !layerHostFrame) {
                layerHostFrame = {
                    camLock: deps.camLock,
                    selectedHandle: parseInt(selSceneCamera.value, 10) || 0,
                    camera: serializeCurrentCameraState(),
                    hostStateMutated: false,
                };
            }

            if (mode === 'physical') {
                const handle = parseInt(options.handle, 10) || 0;
                if (!handle) return false;
                if (layerHostFrame) layerHostFrame.hostStateMutated = true;
                deps.camLock = true;
                syncCameraLockButtonUi();
                syncCameraControlAvailability();
                if ([...selSceneCamera.options].some(o => o.value === String(handle))) {
                    selSceneCamera.value = String(handle);
                }
                deps.bridge.send('lock_camera', { handle: String(handle) });
                return true;
            }

            if (mode === 'script') {
                syncCameraLockButtonUi();
                syncCameraControlAvailability();
                return true;
            }

            if (mode === 'viewport') {
                const restore = layerHostFrame;
                layerHostFrame = null;
                if (restore?.hostStateMutated) {
                    const selectedHandle = restore.selectedHandle ?? 0;
                    deps.camLock = restore.camLock;
                    if ([...selSceneCamera.options].some(o => o.value === String(selectedHandle))) {
                        selSceneCamera.value = String(selectedHandle);
                    } else {
                        selSceneCamera.value = '0';
                    }
                    deps.bridge.send('lock_camera', { handle: selSceneCamera.value });
                    if (restore.camera && !deps.camLock && selectedHandle === 0) {
                        applyStandaloneCameraState(restore.camera);
                    }
                }
                syncCameraLockButtonUi();
                syncCameraControlAvailability();
                return true;
            }
            return false;
        }

        function getCameraProjectionAspect() {
            if (deps.renderToImageActive && deps.pendingRenderToImage?.width > 0 && deps.pendingRenderToImage?.height > 0) {
                return deps.pendingRenderToImage.width / deps.pendingRenderToImage.height;
            }
            if (deps.safeFrameEnabled) {
                const aspect = deps.getRenderOutputAspect();
                if (aspect) return aspect;
            }
            const rect = deps.getViewportFrameRect();
            if (Number.isFinite(rect?.aspect) && rect.aspect > 0) return rect.aspect;
            if (deps.camera?.isPerspectiveCamera && Number.isFinite(deps.camera.aspect) && deps.camera.aspect > 0) {
                return deps.camera.aspect;
            }
            return innerHeight > 0 ? innerWidth / innerHeight : 1;
        }

        function applyCameraProjectionFromMax(cam) {
            const aspect = getCameraProjectionAspect();
            if (deps.camera.isOrthographicCamera) {
                const vw = Number.isFinite(cam.viewWidth) && cam.viewWidth > 0 ? cam.viewWidth : 500;
                deps.camera.left = -vw / 2;
                deps.camera.right = vw / 2;
                deps.camera.top = vw / (2 * aspect);
                deps.camera.bottom = -vw / (2 * aspect);
                deps.camera.near = -100000;
                deps.camera.far = 100000;
            } else if (Number.isFinite(cam.fov) && cam.fov > 0 && cam.fov < 170) {
                const hRad = cam.fov * Math.PI / 180;
                deps.camera.aspect = aspect;
                deps.camera.fov = 2 * Math.atan(Math.tan(hRad / 2) / aspect) * 180 / Math.PI;
                deps.applySyncedCameraClip(deps.camera, cam);
            }
            deps.applyCameraClipOverrides(deps.camera);
        }

        function syncCameraConsumersAfterSwap() {
            if (!deps.renderToImageActive) {
                deps.applyRenderViewportLayout({ resizeBuffers: true, resizePostFx: false });
            }
            deps.maxjsFx.setCamera?.(deps.camera);
            deps.webglBasicFx.setCamera?.(deps.camera);
            deps.shaderLabFx.setCamera?.(deps.camera);
            deps.pathTracingFx.setCamera?.(deps.camera);
            if (!deps.renderToImageActive) {
                deps.maxjsFx.resize();
                deps.webglBasicFx.resize?.();
                deps.shaderLabFx.resize?.();
            }
        }

        // ── Camera Sync (Max view → world camera) ───────────
        function applyCamera(cam) {
            const layerCameraMode = deps.layerManager?.cameraMode ?? 'viewport';
            if (deps.xrRuntime?.active) return;
            if (layerCameraMode === 'script') return;
            // A persisted unlocked viewport still needs one authored Max camera
            // packet for its initial pose. After that seed, unlocked navigation
            // is fully local and later Max camera packets are ignored.
            const seedUnlockedViewport = layerCameraMode === 'viewport'
                && !deps.camLock
                && !viewportCameraSeeded;
            if (!deps.renderToImageActive
                && !deps.camLock
                && layerCameraMode !== 'physical'
                && !seedUnlockedViewport) return;
            if (!deps.isFiniteArray(cam?.pos, 3) || !deps.isFiniteArray(cam?.tgt, 3) || !deps.isFiniteArray(cam?.up, 3)) {
                return;
            }
            deps.noteGiVolumeCameraSync(cam);

            const wantOrtho = cam.persp === false;
            const isOrtho = deps.camera.isOrthographicCamera;
            let cameraSwapped = false;

            if (wantOrtho && !isOrtho) {
                deps.scene.remove(deps.camera);
                deps.camera = deps.orthoCamera;
                deps.scene.add(deps.camera);
                deps.controls.object = deps.camera;
                cameraSwapped = true;
            } else if (!wantOrtho && isOrtho) {
                deps.scene.remove(deps.camera);
                deps.camera = deps.perspCamera;
                deps.scene.add(deps.camera);
                deps.controls.object = deps.camera;
                cameraSwapped = true;
            }

            deps.copyMaxArrayToWorld(deps.camera.position, cam.pos);
            deps.copyMaxArrayToWorld(deps.camera.up, cam.up);
            deps.copyMaxArrayToWorld(deps.cameraTargetWorld, cam.tgt);
            deps.camera.lookAt(deps.cameraTargetWorld);

            applyCameraProjectionFromMax(cam);
            if (cameraSwapped) {
                syncCameraConsumersAfterSwap();
            }
            deps.controls.target.copy(deps.cameraTargetWorld);
            syncOrbitNavigationFeel();
            if (layerCameraMode === 'viewport') viewportCameraSeeded = true;

            // Forward Physical Camera DOF to post-fx when available
            deps.physicalCameraDofActive = !!cam.dofEnabled;
            if (deps.physicalCameraDofActive && deps.maxjsFx?.updateDofFromPhysicalCamera) {
                deps.maxjsFx.updateDofFromPhysicalCamera(cam, () => deps.syncPostFxPanel(false, { persist: false }));
            }
            deps.syncPathTracingDofFromPostFx();
        }

        const visibleNodeBounds = new THREE.Box3();

        function isEffectivelyVisible(object) {
            for (let current = object; current; current = current.parent) {
                if (!current.visible || current.userData?.maxjsVisible === false) return false;
            }
            return true;
        }

        function expandByNodeGeometry(target, object) {
            const geometry = object?.geometry;
            if (!geometry) return;
            object.updateWorldMatrix(true, false);

            let source = null;
            if (object.boundingBox !== undefined) {
                if (object.boundingBox === null) object.computeBoundingBox?.();
                source = object.boundingBox;
            } else {
                if (geometry.boundingBox === null) geometry.computeBoundingBox();
                source = geometry.boundingBox;
            }
            if (!source || source.isEmpty()) return;
            visibleNodeBounds.copy(source).applyMatrix4(object.matrixWorld);
            target.union(visibleNodeBounds);
        }

        function computeVisibleSceneBounds(target = new THREE.Box3()) {
            target.makeEmpty();
            const visited = new Set();
            const visit = (object) => {
                if (!object || visited.has(object) || !isEffectivelyVisible(object)) return;
                visited.add(object);
                expandByNodeGeometry(target, object);
                for (const child of object.children || []) visit(child);
            };
            // Producer visibility is applied through a render layer while
            // mesh.visible intentionally stays true (scene_applier.js). Walk
            // each object's own geometry so a visible parent cannot pull a
            // host-hidden child into the camera bounds through Box3's recursive
            // expandByObject implementation.
            for (const [, mesh] of deps.nodeMap) visit(mesh);
            return target;
        }

        function serializeCurrentCameraState() {
            return {
                perspective: !deps.camera.isOrthographicCamera,
                position: deps.camera.position.toArray(),
                up: deps.camera.up.toArray(),
                target: deps.controls.target.toArray(),
                fov: deps.camera.isPerspectiveCamera ? deps.camera.fov : null,
                viewWidth: deps.camera.isOrthographicCamera ? (deps.camera.right - deps.camera.left) : null,
                near: Number.isFinite(deps.camera.near) ? deps.camera.near : null,
                far: Number.isFinite(deps.camera.far) ? deps.camera.far : null,
            };
        }

        function applyStandaloneCameraState(savedCamera) {
            if (!savedCamera) { deps.maxjsDebugLog('[max.js] applyStandaloneCameraState: no savedCamera'); return; }
            if (!deps.isFiniteArray(savedCamera.position, 3) ||
                !deps.isFiniteArray(savedCamera.up, 3) ||
                !deps.isFiniteArray(savedCamera.target, 3)) {
                deps.maxjsDebugLog('[max.js] applyStandaloneCameraState: invalid arrays', savedCamera);
                return;
            }
            deps.maxjsDebugLog('[max.js] applyStandaloneCameraState: applying', savedCamera.position, savedCamera.target);

            const wantOrtho = savedCamera.perspective === false;
            const isOrtho = deps.camera.isOrthographicCamera;
            let cameraSwapped = false;
            if (wantOrtho && !isOrtho) {
                deps.scene.remove(deps.camera);
                deps.camera = deps.orthoCamera;
                deps.scene.add(deps.camera);
                deps.controls.object = deps.camera;
                cameraSwapped = true;
            } else if (!wantOrtho && isOrtho) {
                deps.scene.remove(deps.camera);
                deps.camera = deps.perspCamera;
                deps.scene.add(deps.camera);
                deps.controls.object = deps.camera;
                cameraSwapped = true;
            }

            deps.camera.position.fromArray(savedCamera.position);
            deps.camera.up.fromArray(savedCamera.up);
            deps.cameraTargetWorld.fromArray(savedCamera.target);
            deps.camera.lookAt(deps.cameraTargetWorld);

            if (wantOrtho) {
                const viewWidth = Number.isFinite(savedCamera.viewWidth) && savedCamera.viewWidth > 0
                    ? savedCamera.viewWidth
                    : 500;
                const aspect = getCameraProjectionAspect();
                deps.camera.left = -viewWidth / 2;
                deps.camera.right = viewWidth / 2;
                deps.camera.top = viewWidth / (2 * aspect);
                deps.camera.bottom = -viewWidth / (2 * aspect);
                deps.camera.near = -100000;
                deps.camera.far = 100000;
            } else if (Number.isFinite(savedCamera.fov) && savedCamera.fov > 0 && savedCamera.fov < 170) {
                deps.camera.fov = savedCamera.fov;
                deps.camera.aspect = getCameraProjectionAspect();
                deps.applySyncedCameraClip(deps.camera, savedCamera);
            }

            deps.applyCameraClipOverrides(deps.camera);
            if (cameraSwapped) {
                syncCameraConsumersAfterSwap();
            } else {
                deps.updateCameraProjectionForViewportRect();
            }
            deps.controls.target.fromArray(savedCamera.target);
            syncOrbitNavigationFeel();
            deps.controls.update();
        }

        function syncOrbitNavigationFeel() {
            const distance = Math.max(0.01, deps.camera.position.distanceTo(deps.controls.target));
            const box = computeVisibleSceneBounds(new THREE.Box3());
            const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
            const maxDim = Math.max(1, size.x, size.y, size.z);
            const scale = THREE.MathUtils.clamp(distance / maxDim, 0.15, 6.0);

            deps.controls.panSpeed = THREE.MathUtils.clamp(scale * 1.1, 0.15, 3.5);
            deps.controls.zoomSpeed = THREE.MathUtils.clamp(1.35 + Math.log2(scale + 1.0), 0.8, 3.0);
            deps.controls.rotateSpeed = THREE.MathUtils.clamp(0.42 + scale * 0.08, 0.35, 0.95);
            deps.controls.minDistance = Math.max(0.01, maxDim * 0.0025);
            deps.controls.maxDistance = Math.max(1000, maxDim * 25);
        }

        function getKnownSceneCameras() {
            return knownSceneCameras;
        }

        return {
            updateSceneCameraList,
            syncCameraLockButtonUi,
            syncCameraControlAvailability,
            applyLayerCameraMode,
            getCameraProjectionAspect,
            applyCameraProjectionFromMax,
            syncCameraConsumersAfterSwap,
            applyCamera,
            computeVisibleSceneBounds,
            serializeCurrentCameraState,
            applyStandaloneCameraState,
            syncOrbitNavigationFeel,
            getKnownSceneCameras,
        };
}

export { createCameraSystem };
