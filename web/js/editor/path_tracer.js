// path_tracer.js - progressive path tracing view on three-gpu-pathtracer's WebGPUPathTracer.
//
// Native WebGPU only. The tracer captures the scene on the first render; live edits mark
// what changed and the next render pushes them through the matching update* call.
// renderSample() blits into the bound render target: linear HDR for the post stack, or
// the canvas, where the renderer's own output transform tone maps it.

const ENVIRONMENT_KEYS = [
    ['environment', 'maxjsPathTraceEnvironment'],
    ['background', 'maxjsPathTraceBackground'],
];

export function normalizePathTracerSettings(input = {}, base = {}) {
    const n = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    const source = { ...base, ...input };
    return {
        bounces: Math.round(Math.min(32, Math.max(1, n(source.bounces, 8)))),
        giClamp: Math.min(1000, Math.max(0, n(source.giClamp, 10))),
        sampleLimit: Math.round(Math.min(100000, Math.max(0, n(source.sampleLimit, 0)))),
        freezeSync: source.freezeSync === true,
        paused: source.paused === true,
    };
}

export function createPathTracer({ renderer, scene, camera, settings, onStatus = () => {}, onError = () => {} }) {
    const supported = renderer?.backend?.isWebGPUBackend === true;
    let tracer = null;
    let loading = null;
    let started = false;
    let activeCamera = camera;
    let lensCamera = null;
    let dof = { enabled: false, focusDistance: 1, apertureRadius: 0 };
    let captureSamples = 0;
    let sampleCount = 0;
    let sampleQuery = null;
    let lastSampleQueryMs = 0;
    const dirty = { scene: true, deforms: false, transforms: false, materials: false, lights: false, environment: true };
    const lastCameraState = new Float64Array(33);

    function configure() {
        if (!tracer) return;
        tracer.maxBounces = settings.bounces;
        tracer.clampIndirect = settings.giClamp;
        tracer.maxSamples = captureSamples > 0 ? captureSamples : settings.sampleLimit;
        tracer.pause = settings.paused === true;
        // Capture accumulates at full resolution from the first sample.
        tracer.dynamicLowRes = captureSamples === 0;
        tracer.renderDelay = captureSamples > 0 ? 0 : 300;
        tracer.fadeDuration = captureSamples > 0 ? 0 : 300;
    }

    function load() {
        if (!supported) return Promise.resolve(null);
        loading ??= Promise.all([
            import('three-gpu-pathtracer/webgpu'),
            import('three-gpu-pathtracer/src/objects/PhysicalCamera.js'),
        ]).then(([{ WebGPUPathTracer }, { PhysicalCamera }]) => {
            tracer = new WebGPUPathTracer(renderer);
            lensCamera = new PhysicalCamera();
            configure();
            return tracer;
        }).catch((error) => {
            onError(error);
            return null;
        });
        return loading;
    }

    // The tracer reads scene.environment / scene.background. Point them at the raw
    // equirect sources (kept in scene.userData) instead of the prefiltered PMREMs.
    function withPathTraceEnvironment(fn) {
        const saved = ENVIRONMENT_KEYS.map(([key, source]) => {
            const previous = scene[key];
            const raw = scene.userData[source];
            if (raw && previous && !previous.isColor) scene[key] = raw;
            return previous;
        });
        try {
            return fn();
        } finally {
            ENVIRONMENT_KEYS.forEach(([key], i) => { scene[key] = saved[i]; });
        }
    }

    // In-place vertex edits keep the geometry, so its BVH is refit instead of rebuilt.
    function refitDeformedGeometry() {
        scene.traverse((object) => {
            const geometry = object.isMesh ? object.geometry : null;
            const bvh = geometry?.boundsTree;
            const position = geometry?.getAttribute('position');
            if (!bvh || !position) return;
            if (geometry.userData.maxjsPathTraceVersion === position.version) return;
            if (bvh.geometry?.index?.count === geometry.index?.count) bvh.refit();
            else geometry.boundsTree = null;
            geometry.userData.maxjsPathTraceVersion = position.version;
        });
    }

    function stampGeometryVersions() {
        scene.traverse((object) => {
            const position = object.isMesh ? object.geometry?.getAttribute('position') : null;
            if (position) object.geometry.userData.maxjsPathTraceVersion = position.version;
        });
    }

    function syncLensCamera() {
        if (!dof.enabled || !activeCamera?.isPerspectiveCamera) return activeCamera;
        lensCamera.copy(activeCamera, false);
        lensCamera.focusDistance = dof.focusDistance;
        // The tracer reads bokehSize in millimetres of a metre-scale scene.
        lensCamera.bokehSize = Math.max(1e-6, dof.apertureRadius * 2000);
        lensCamera.updateMatrixWorld();
        return lensCamera;
    }

    function cameraChanged(cam) {
        const state = lastCameraState;
        let changed = false;
        const write = (i, v) => { if (state[i] !== v) { state[i] = v; changed = true; } };
        cam.matrixWorld.elements.forEach((v, i) => write(i, v));
        cam.projectionMatrix.elements.forEach((v, i) => write(16 + i, v));
        write(32, dof.enabled ? dof.focusDistance * 1e3 + dof.apertureRadius : -1);
        return changed;
    }

    function flush() {
        const traced = syncLensCamera();
        if (dirty.scene || dirty.deforms) {
            if (dirty.deforms && !dirty.scene) refitDeformedGeometry();
            withPathTraceEnvironment(() => tracer.setScene(scene, traced));
            stampGeometryVersions();
            dirty.scene = dirty.deforms = dirty.transforms = dirty.materials = dirty.lights = dirty.environment = false;
            cameraChanged(traced);
            return;
        }
        if (dirty.transforms) tracer.updateTransforms();
        if (dirty.materials) tracer.updateMaterials();
        if (dirty.lights) tracer.updateLights();
        if (dirty.environment) withPathTraceEnvironment(() => tracer.updateEnvironment());
        dirty.transforms = dirty.materials = dirty.lights = dirty.environment = false;
        if (tracer.camera !== traced) tracer.setCamera(traced);
        else if (cameraChanged(traced)) tracer.updateCamera();
    }

    function pollSampleCount() {
        const now = performance.now();
        if (sampleQuery || now - lastSampleQueryMs < 250) return;
        lastSampleQueryMs = now;
        sampleQuery = tracer.getSampleCountsAsync()
            .then((counts) => { sampleCount = counts.min; })
            .catch(() => {})
            .finally(() => { sampleQuery = null; });
    }

    return {
        get supported() { return supported; },
        isEnabled: () => supported,
        isStarted: () => started,
        preload: () => { void load(); },

        start() {
            if (!supported) return false;
            started = true;
            void load().then((loaded) => {
                if (loaded) onStatus('max.js - path tracing (WebGPU)');
            });
            return true;
        },

        // Accumulates one round of samples into the bound render target.
        render() {
            if (!started || !tracer) return false;
            try {
                if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
                activeCamera.updateMatrixWorld();
                flush();
                tracer.renderSample();
                pollSampleCount();
                return true;
            } catch (error) {
                onError(error);
                return false;
            }
        },

        clearFrame() {
            renderer.setClearColor(0x000000, 1);
            renderer.clear();
            return true;
        },

        setOptions(next) {
            Object.assign(settings, normalizePathTracerSettings(next, settings));
            configure();
            tracer?.reset();
        },
        setPaused(paused) {
            settings.paused = paused === true;
            configure();
        },
        setCamera(nextCamera) {
            activeCamera = nextCamera;
        },
        setDOF(next) {
            dof = { ...dof, ...next };
        },

        markSceneDirty() { dirty.scene = true; },
        markDeformsDirty({ transforms = false } = {}) { dirty.deforms = true; if (transforms) dirty.transforms = true; },
        markTransformsDirty() { dirty.transforms = true; },
        markMaterialsDirty() { dirty.materials = true; },
        markLightsDirty() { dirty.lights = true; },
        markEnvironmentDirty() { dirty.environment = true; },

        // Render to Image / Sequence: accumulate exactly `samples` per pixel.
        setCaptureMode(on, samples = 64) {
            captureSamples = on ? Math.max(1, Math.round(samples)) : 0;
            sampleCount = 0;
            configure();
            tracer?.reset();
        },
        isCaptureReady() {
            return captureSamples > 0 && tracer?.complete === true;
        },
        getSampleCount() {
            return sampleCount;
        },

        dispose() {
            tracer?.dispose();
            tracer = null;
            loading = null;
            started = false;
        },
    };
}
