// splats.js — Gaussian splat overlay viewer (Spark.js). Extracted verbatim
// from boot.js. Splats render in a separate transparent WebGL canvas overlaid
// on the viewport because Spark needs the classic-GLSL three build (three-std).
// `deps.camera` / `deps.performanceSettings` are getter properties — boot swaps
// the active camera and rebuilds the settings object live; read at call time.
import * as THREE_STD from 'three-std';
import { copyMaxMatrixArrayToWorldStd } from '../scene_space.js';

        // Spark.js uses GLSL3/ShaderChunk — needs WebGL THREE build (scoped in importmap).
        // Lazy-import to avoid crashing on page load.
        let Spark = null;

function createSplatsSystem(deps = {}) {
    const { perfHud, isFiniteArray, getViewportFrameRect,
            getEffectivePixelRatio, applyFrameElementStyle,
            reportBridgeError } = deps;

        const splatHandleMap = new Map();
        const splatMatrix = new THREE_STD.Matrix4();
        const splatPosition = new THREE_STD.Vector3();
        const splatQuaternion = new THREE_STD.Quaternion();
        const splatScale = new THREE_STD.Vector3();
        let splatMutationQueue = Promise.resolve();
        let splatOverlay = null;

        function queueSplatMutation(work) {
            splatMutationQueue = splatMutationQueue
                .then(() => work())
                .catch(error => {
                    reportBridgeError('splat sync error', error);
                });
            return splatMutationQueue;
        }

        function splatsViewerEnabled() {
            return deps.performanceSettings.splatsEnabled !== false;
        }

        async function shutdownSplatViewer() {
            const handles = [...splatHandleMap.keys()];
            for (const h of handles) await removeTrackedSplat(h);
            if (splatOverlay) {
                try {
                    splatOverlay.renderer?.dispose?.();
                    splatOverlay.renderer?.domElement?.remove?.();
                } catch (e) { /* ignore */ }
                splatOverlay = null;
            }
            Spark = null;
        }

        async function ensureSplatOverlay() {
            if (!splatsViewerEnabled()) return null;
            if (splatOverlay) return splatOverlay;

            if (!Spark) Spark = await import('@sparkjsdev/spark');

            const overlayRenderer = new THREE_STD.WebGLRenderer({
                antialias: true, alpha: true, premultipliedAlpha: true,
            });
            const rect = getViewportFrameRect();
            overlayRenderer.setPixelRatio(getEffectivePixelRatio());
            overlayRenderer.setSize(rect.width, rect.height, false);
            overlayRenderer.setClearColor(0x000000, 0);
            overlayRenderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5';
            applyFrameElementStyle(overlayRenderer.domElement, rect);
            overlayRenderer.outputColorSpace = THREE_STD.SRGBColorSpace;
            document.body.appendChild(overlayRenderer.domElement);

            const overlayScene = new THREE_STD.Scene();
            const overlayCamera = new THREE_STD.PerspectiveCamera(deps.camera.fov, deps.camera.aspect, deps.camera.near, deps.camera.far);
            const spark = new Spark.SparkRenderer({ renderer: overlayRenderer });
            spark.frustumCulled = false;
            overlayScene.add(spark);

            splatOverlay = { renderer: overlayRenderer, scene: overlayScene, camera: overlayCamera, spark };
            return splatOverlay;
        }

        function updateSplatCamera() {
            if (!splatOverlay) return;
            const oc = splatOverlay.deps.camera;
            oc.position.set(deps.camera.position.x, deps.camera.position.y, deps.camera.position.z);
            oc.quaternion.set(deps.camera.quaternion.x, deps.camera.quaternion.y, deps.camera.quaternion.z, deps.camera.quaternion.w);
            oc.up.set(deps.camera.up.x, deps.camera.up.y, deps.camera.up.z);
            oc.near = Math.max(deps.camera.near, 0.01);
            oc.far = Math.max(deps.camera.far, oc.near + 1.0);
            oc.aspect = deps.camera.aspect;
            oc.fov = deps.camera.fov;
            oc.updateProjectionMatrix();
            oc.updateMatrixWorld(true);
        }

        function applySplatTransform(mesh, splat) {
            if (!mesh) return;

            if (isFiniteArray(splat?.t, 16)) {
                copyMaxMatrixArrayToWorldStd(splatMatrix, splat.t);
                splatMatrix.decompose(splatPosition, splatQuaternion, splatScale);
                mesh.position.copy(splatPosition);
                mesh.quaternion.copy(splatQuaternion);
                mesh.scale.copy(splatScale);
            } else {
                mesh.position.set(0, 0, 0);
                mesh.quaternion.identity();
                mesh.scale.set(1, 1, 1);
            }

            mesh.visible = splat?.v == null ? true : !!splat.v;
        }

        async function removeTrackedSplat(handle) {
            const entry = splatHandleMap.get(handle);
            if (!entry) return;
            splatHandleMap.delete(handle);
            if (entry.mesh.parent) entry.mesh.parent.remove(entry.mesh);
            entry.mesh.dispose?.();
        }

        async function upsertTrackedSplat(splat) {
            const handle = splat?.h;
            if (handle == null) return;

            if (!splatsViewerEnabled()) {
                await removeTrackedSplat(handle);
                return;
            }

            const url = typeof splat.url === 'string' ? splat.url : '';
            if (!url) {
                await removeTrackedSplat(handle);
                return;
            }

            const existing = splatHandleMap.get(handle);

            if (existing && existing.url === url) {
                applySplatTransform(existing.mesh, splat);
                return;
            }

            if (existing) {
                await removeTrackedSplat(handle);
            }

            const overlay = await ensureSplatOverlay();
            if (!overlay) return;
            perfHud.setStatus(`max.js - Loading splat...`);
            const mesh = new Spark.SplatMesh({ url });
            mesh.name = splat.n || `Splat ${handle}`;
            overlay.scene.add(mesh);
            splatHandleMap.set(handle, { url, mesh });
            applySplatTransform(mesh, splat);
            perfHud.setStatus(`max.js - Splat ready: ${mesh.name}`);
        }

        function reconcileSplats(splats = []) {
            return queueSplatMutation(async () => {
                if (!splatsViewerEnabled()) {
                    await shutdownSplatViewer();
                    return;
                }
                const incomingHandles = new Set(splats.map(splat => splat.h));
                const staleHandles = [];

                for (const handle of splatHandleMap.keys()) {
                    if (!incomingHandles.has(handle)) staleHandles.push(handle);
                }

                for (const handle of staleHandles) {
                    await removeTrackedSplat(handle);
                }

                for (const splat of splats) {
                    await upsertTrackedSplat(splat);
                }
            });
        }

        function applySplatUpdates(splats = []) {
            if (!splats.length) return;
            if (!splatsViewerEnabled()) return;

            return queueSplatMutation(async () => {
                for (const splat of splats) {
                    await upsertTrackedSplat(splat);
                }
            });
        }

    // Binary xform fast path (delta sync): apply a transform to a tracked
    // splat. Returns true when a splat with that handle exists and was updated.
    function applyTrackedSplatTransform(handle, matrix, visible) {
        const entry = splatHandleMap.get(handle);
        if (!entry?.mesh) return false;
        applySplatTransform(entry.mesh, { t: matrix, v: visible ? 1 : 0 });
        return true;
    }

    // Abandon queued mutations so a shutdown doesn't wait behind pending loads
    // (splats-disabled toggle / restored settings path).
    function resetMutationQueue() {
        splatMutationQueue = Promise.resolve();
    }

    return {
        splatsViewerEnabled,
        shutdownSplatViewer,
        updateSplatCamera,
        reconcileSplats,
        applySplatUpdates,
        applyTrackedSplatTransform,
        resetMutationQueue,
        get overlay() { return splatOverlay; },
        get count() { return splatHandleMap.size; },
    };
}

export { createSplatsSystem };
