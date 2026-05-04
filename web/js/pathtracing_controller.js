export function createPathTracingController({
    renderer,
    scene,
    camera,
    WebGLPathTracer,
    enabled = false,
    onStatus = () => {},
    onError = () => {},
} = {}) {
    let activeCamera = camera;
    let pathTracer = null;
    let sceneDirty = true;
    let warnedUnsupported = false;
    let lastCameraWorld = '';
    let lastProjection = '';

    function isEnabled() {
        return enabled === true;
    }

    function isSupported() {
        return renderer?.isWebGLRenderer === true && typeof WebGLPathTracer === 'function';
    }

    function matrixKey(matrix) {
        return Array.from(matrix?.elements || []).map(v => Number(v).toFixed(6)).join(',');
    }

    function resetCameraKeys() {
        lastCameraWorld = '';
        lastProjection = '';
    }

    function applyRayOffsetBias(material) {
        if (!material || typeof material.fragmentShader !== 'string') return;
        material.fragmentShader = material.fragmentShader.replace(
            '#define RAY_OFFSET 1e-4',
            '#define RAY_OFFSET 5e-4'
        );
        material.needsUpdate = true;
    }

    function ensureTracer() {
        if (!isEnabled()) return false;
        if (!isSupported()) {
            if (!warnedUnsupported) {
                warnedUnsupported = true;
                onStatus('max.js - Pathtracing uses the WebGL2 path tracer; switch backend to WebGL2');
            }
            return false;
        }
        if (pathTracer) return true;

        try {
            pathTracer = new WebGLPathTracer(renderer);
            pathTracer.bounces = 6;
            pathTracer.tiles.set(2, 2);
            pathTracer.minSamples = 1;
            pathTracer.renderDelay = 0;
            pathTracer.fadeDuration = 120;
            pathTracer.dynamicLowRes = true;
            applyRayOffsetBias(pathTracer._pathTracer?.material);
            sceneDirty = true;
            resetCameraKeys();
            onStatus('max.js - Pathtracing ready');
            return true;
        } catch (error) {
            pathTracer = null;
            onError(error);
            return false;
        }
    }

    function rebuildScene() {
        if (!ensureTracer()) return false;
        try {
            scene.updateMatrixWorld(true);
            activeCamera.updateMatrixWorld();
            // three-gpu-pathtracer 0.0.24 has a stale private material list
            // length check on repeated setScene() calls; clear it before rebuild.
            if (pathTracer?._generator) pathTracer._generator._materialUuids = null;
            pathTracer.setScene(scene, activeCamera);
            sceneDirty = false;
            resetCameraKeys();
            return true;
        } catch (error) {
            sceneDirty = true;
            onError(error);
            return false;
        }
    }

    function syncCameraIfNeeded() {
        if (!pathTracer || !activeCamera) return;
        activeCamera.updateMatrixWorld();
        const worldKey = matrixKey(activeCamera.matrixWorld);
        const projectionKey = matrixKey(activeCamera.projectionMatrix);
        if (worldKey !== lastCameraWorld || projectionKey !== lastProjection) {
            pathTracer.setCamera(activeCamera);
            lastCameraWorld = worldKey;
            lastProjection = projectionKey;
        }
    }

    function render() {
        if (!ensureTracer()) return false;
        if (sceneDirty && !rebuildScene()) return false;
        try {
            syncCameraIfNeeded();
            pathTracer.renderSample();
            return true;
        } catch (error) {
            onError(error);
            return false;
        }
    }

    function markSceneDirty() {
        sceneDirty = true;
        pathTracer?.reset?.();
    }

    function setCamera(nextCamera) {
        activeCamera = nextCamera || activeCamera;
        resetCameraKeys();
        pathTracer?.setCamera?.(activeCamera);
    }

    function dispose() {
        pathTracer?.dispose?.();
        pathTracer = null;
    }

    return {
        isEnabled,
        isSupported,
        render,
        markSceneDirty,
        setCamera,
        dispose,
    };
}
