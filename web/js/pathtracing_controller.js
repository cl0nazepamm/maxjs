import { BufferAttribute } from 'three';

// ─── Material support ─────────────────────────────────────────────────────
// The path tracer's MaterialsTexture reads PBR fields by name (duck typing
// over `color`, `roughness`, `metalness`, `map`, `normalMap`, …). Three's
// NodeMaterial subclasses inherit those scalar fields from their matching
// base material via `setDefaultValues(new MeshStandardMaterial())`, so a
// MeshPhysicalNodeMaterial in MaxJS path-traces correctly as long as a
// custom node graph hasn't replaced the visible behaviour.
//
// We reject materials whose visible output is defined by a TSL/WGSL node
// graph (MeshTSLNodeMaterial, backdrop materials, ShaderMaterial). For
// those the scalar fields are stale fallbacks and the result on disk
// would not resemble the live frame.

const PBR_MATERIAL_FLAGS = [
    'isMeshBasicMaterial',
    'isMeshLambertMaterial',
    'isMeshPhongMaterial',
    'isMeshStandardMaterial',
    'isMeshPhysicalMaterial',
    'isMeshBasicNodeMaterial',
    'isMeshLambertNodeMaterial',
    'isMeshPhongNodeMaterial',
    'isMeshStandardNodeMaterial',
    'isMeshPhysicalNodeMaterial',
];

const NODE_GRAPH_OVERRIDE_KEYS = [
    'colorNode',
    'fragmentNode',
    'vertexNode',
    'materialNode',
    'backdropNode',
    'outputNode',
];

const SCENE_REBUILD_COALESCE_MS = 25;
const SCENE_REBUILD_MIN_INTERVAL_MS = 50;
const SCENE_REBUILD_RETRY_MS = 1000;
const CAMERA_MATRIX_EPSILON = 1e-6;

function isPathTraceableMaterial(material) {
    if (!material) return false;
    if (material.isShaderMaterial || material.isRawShaderMaterial) return false;
    for (const key of NODE_GRAPH_OVERRIDE_KEYS) {
        if (material[key]) return false;
    }
    for (const flag of PBR_MATERIAL_FLAGS) {
        if (material[flag]) return true;
    }
    return false;
}

function meshMaterials(mesh) {
    if (!mesh?.material) return [];
    return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function isCompatibleAttribute(attribute) {
    return !!attribute
        && Number.isFinite(attribute.count)
        && attribute.count > 0
        && Number.isFinite(attribute.itemSize)
        && attribute.itemSize > 0
        && !!attribute.array?.constructor;
}

function isPathTraceableGeometry(geometry) {
    if (!geometry?.attributes) return false;
    if (!isCompatibleAttribute(geometry.attributes.position)) return false;
    if (geometry.index && !isCompatibleAttribute(geometry.index)) return false;
    return true;
}

function isPathTraceableMesh(mesh) {
    if (!mesh?.isMesh) return false;
    if (mesh.name === '__maxjs_sky__') return false;
    if (!isPathTraceableGeometry(mesh.geometry)) return false;
    const materials = meshMaterials(mesh);
    if (materials.length === 0) return false;
    return materials.every(isPathTraceableMaterial);
}

// ─── Submaterial remap ───────────────────────────────────────────────────
// three-gpu-pathtracer merges one geometry group per mesh, but flattens
// materials across every mesh. That makes Multi/Sub meshes collapse to a
// wrong global material offset. Do not split or clone scene meshes here:
// patch the generated materialIndex attribute on the tracer's internal
// merged geometry instead.

function groupsForMaterialRemap(source) {
    const geom = source.geometry;
    const explicit = Array.isArray(geom.groups) ? geom.groups.filter(g => (g?.count | 0) > 0) : [];
    if (explicit.length > 0) return explicit;
    const total = geom.index ? geom.index.count : geom.attributes.position.count;
    return [{ start: 0, count: total, materialIndex: 0 }];
}

function getGeneratorSourceMeshes(tracer) {
    const generator = tracer?._generator?.staticGeometryGenerator;
    if (!generator) return [];
    if (Array.isArray(generator._maxjsLastMeshes)) return generator._maxjsLastMeshes;
    if (typeof generator._getMeshes === 'function') return generator._getMeshes();
    return [];
}

function ensureMaterialIndexAttribute(geometry, materialCount) {
    const vertexCount = geometry.attributes.position.count;
    const current = geometry.getAttribute('materialIndex');
    const ArrayType = materialCount <= 255 ? Uint8Array : Uint16Array;
    if (current && current.count === vertexCount && current.array instanceof ArrayType) {
        return current;
    }

    const attribute = new BufferAttribute(new ArrayType(vertexCount), 1, false);
    geometry.deleteAttribute('materialIndex');
    geometry.setAttribute('materialIndex', attribute);
    return attribute;
}

function writeMaterialIndexRange(geometry, materialArray, start, count, materialIndex) {
    const indexAttr = geometry.index;
    const total = indexAttr ? indexAttr.count : geometry.attributes.position.count;
    const begin = Math.max(0, start | 0);
    const end = Math.min(total, begin + Math.max(0, count | 0));

    for (let i = begin; i < end; i += 1) {
        const vertexIndex = indexAttr ? indexAttr.getX(i) : i;
        materialArray[vertexIndex] = materialIndex;
    }
}

function patchGeneratedMaterialIndices(tracer, results) {
    const geometry = results?.geometry;
    const materials = results?.materials;
    const sourceMeshes = getGeneratorSourceMeshes(tracer);
    if (!geometry?.attributes?.position || !Array.isArray(materials) || !Array.isArray(sourceMeshes)) return false;
    if (sourceMeshes.length === 0) return false;

    const groups = Array.isArray(geometry.groups) ? geometry.groups : [];
    if (groups.length < sourceMeshes.length) return false;

    // mergeGeometries appends groups without clearing. Use the latest merge
    // range, then clear it to avoid unbounded group accumulation.
    const targetGroups = groups.slice(groups.length - sourceMeshes.length);
    const materialIndexAttribute = ensureMaterialIndexAttribute(geometry, materials.length);
    const materialArray = materialIndexAttribute.array;

    let materialOffset = 0;
    for (let i = 0; i < sourceMeshes.length; i += 1) {
        const source = sourceMeshes[i];
        const targetGroup = targetGroups[i];
        const sourceMaterials = meshMaterials(source);
        const sourceMaterialCount = Math.max(1, sourceMaterials.length);
        const targetStart = targetGroup.start | 0;
        const targetCount = targetGroup.count | 0;

        // Fill the whole merged mesh range first. If Max sends partial
        // material groups, uncovered faces still use the mesh's first slot.
        writeMaterialIndexRange(geometry, materialArray, targetStart, targetCount, materialOffset);

        for (const group of groupsForMaterialRemap(source)) {
            const localIndex = Math.max(0, Math.min(sourceMaterialCount - 1, group.materialIndex | 0));
            writeMaterialIndexRange(
                geometry,
                materialArray,
                targetStart + (group.start | 0),
                group.count | 0,
                materialOffset + localIndex,
            );
        }

        materialOffset += sourceMaterialCount;
    }

    materialIndexAttribute.needsUpdate = true;
    results.needsMaterialIndexUpdate = true;

    geometry.clearGroups();
    for (let i = 0; i < targetGroups.length; i += 1) {
        const group = targetGroups[i];
        geometry.addGroup(group.start, group.count, i);
    }

    return true;
}

function compactGeneratedGroups(tracer, results) {
    const geometry = results?.geometry;
    const sourceMeshes = getGeneratorSourceMeshes(tracer);
    if (!geometry || !Array.isArray(sourceMeshes) || sourceMeshes.length === 0) return false;

    const groups = Array.isArray(geometry.groups) ? geometry.groups : [];
    if (groups.length <= sourceMeshes.length) return false;

    const targetGroups = groups.slice(groups.length - sourceMeshes.length);
    geometry.clearGroups();
    for (let i = 0; i < targetGroups.length; i += 1) {
        const group = targetGroups[i];
        geometry.addGroup(group.start, group.count, i);
    }
    return true;
}

function materialIndexSignature(tracer) {
    const sourceMeshes = getGeneratorSourceMeshes(tracer);
    if (!Array.isArray(sourceMeshes)) return '';
    return sourceMeshes.map(source => {
        const geom = source.geometry;
        const materialKey = meshMaterials(source).map(material => material?.uuid || 'null').join(',');
        const groupKey = groupsForMaterialRemap(source)
            .map(group => `${group.start | 0},${group.count | 0},${group.materialIndex | 0}`)
            .join(';');
        return `${source.uuid}:${geom?.uuid || ''}:${materialKey}:${groupKey}`;
    }).join('|');
}

// ─── Controller ───────────────────────────────────────────────────────────

const RAY_OFFSET_BIAS = '#define RAY_OFFSET 1e-4';
const RAY_OFFSET_BIAS_TARGET = '#define RAY_OFFSET 5e-4';

const DEPRECATED_CLOCK_WARNING = 'THREE.Clock: This module has been deprecated';

function matrixChanged(matrix, cache, epsilon = CAMERA_MATRIX_EPSILON) {
    const elements = matrix?.elements;
    if (!elements) return false;
    if (!cache.initialized) {
        cache.values.set(elements);
        cache.initialized = true;
        return true;
    }
    for (let i = 0; i < 16; i += 1) {
        if (Math.abs(cache.values[i] - elements[i]) > epsilon) {
            cache.values.set(elements);
            return true;
        }
    }
    return false;
}

function resetMatrixCache(cache) {
    cache.initialized = false;
}

function suppressClockDeprecationWarning(fn) {
    const originalWarn = console.warn;
    console.warn = (...args) => {
        const first = args.length > 0 ? String(args[0]) : '';
        if (first.includes(DEPRECATED_CLOCK_WARNING)) return;
        originalWarn.apply(console, args);
    };
    try {
        return fn();
    } finally {
        console.warn = originalWarn;
    }
}

export function createPathTracingController({
    renderer,
    scene,
    camera,
    enabled = false,
    loadWebGLPathTracer = null,
    onStatus = () => {},
    onError = () => {},
} = {}) {
    let activeCamera = camera;
    let tracer = null;
    let PathTracerCtor = null;
    let modulePromise = null;
    let disposed = false;

    let sceneDirty = true;
    let sceneDirtyAt = 0;
    let hasSceneBuilt = false;
    let lastSceneRebuildAt = -Infinity;
    let nextRebuildRetryAt = 0;
    let lastRebuildErrorKey = '';
    const lastCameraWorld = { initialized: false, values: new Float64Array(16) };
    const lastCameraProj = { initialized: false, values: new Float64Array(16) };
    let warnedUnsupportedRenderer = false;

    const visibilityScratch = [];

    function isEnabled() {
        return enabled === true && !disposed;
    }

    function hasLegacyWebGLRenderer() {
        return renderer?.isWebGLRenderer === true;
    }

    function isSupported() {
        return hasLegacyWebGLRenderer()
            && (typeof PathTracerCtor === 'function' || typeof loadWebGLPathTracer === 'function');
    }

    function resetCameraKeys() {
        resetMatrixCache(lastCameraWorld);
        resetMatrixCache(lastCameraProj);
    }

    function requestSceneRebuild({ immediate = false, reset = false } = {}) {
        const wasDirty = sceneDirty;
        sceneDirty = true;
        const now = performance.now();
        if (immediate) {
            sceneDirtyAt = now;
        } else if (!wasDirty || sceneDirtyAt <= now) {
            sceneDirtyAt = now + SCENE_REBUILD_COALESCE_MS;
        }
        if (reset) tracer?.reset?.();
    }

    function shouldRebuildSceneNow(now = performance.now()) {
        if (!sceneDirty) return false;
        if (now < nextRebuildRetryAt) return false;
        if (now < sceneDirtyAt) return false;
        if (Number.isFinite(lastSceneRebuildAt) && now - lastSceneRebuildAt < SCENE_REBUILD_MIN_INTERVAL_MS) {
            sceneDirtyAt = lastSceneRebuildAt + SCENE_REBUILD_MIN_INTERVAL_MS;
            return false;
        }
        return true;
    }

    // ─── Lazy module load ──────────────────────────────────────
    // Kick off the network/parse work as soon as we know we're
    // going to be enabled. Subsequent calls return the cached
    // ctor immediately.

    function loadModule() {
        if (PathTracerCtor) return Promise.resolve(PathTracerCtor);
        if (modulePromise) return modulePromise;
        if (typeof loadWebGLPathTracer !== 'function') return Promise.resolve(null);

        onStatus('max.js - Loading pathtracer...');
        modulePromise = Promise.resolve()
            .then(() => loadWebGLPathTracer())
            .then(mod => {
                if (disposed) return null;
                PathTracerCtor = mod?.WebGLPathTracer || mod?.default || mod;
                if (typeof PathTracerCtor !== 'function') {
                    throw new Error('three-gpu-pathtracer: WebGLPathTracer export not found');
                }
                onStatus('max.js - Pathtracer ready');
                requestSceneRebuild({ immediate: true });
                return PathTracerCtor;
            })
            .catch(error => {
                modulePromise = null;
                onError(error);
                return null;
            });
        return modulePromise;
    }

    // Eagerly start loading if we know we're enabled — this overlaps
    // with the rest of the boot sequence so we have pixels on first
    // render-mode flip instead of waiting for the dynamic import.
    if (isEnabled()) loadModule();

    // ─── Tracer setup ──────────────────────────────────────────

    function configureForLowLatency(t) {
        // tiles=3x3     : one ninth of a pass per frame; much better viewport
        //                  responsiveness than tracing the full canvas per tick.
        // minSamples=1  : show the first sample immediately.
        // renderDelay=0 : start tracing the moment reset completes.
        // fadeDuration  : short cross-fade so movement→still looks alive.
        // dynamicLowRes : show a low-res traced preview during compilation.
        // rasterizeScene=false + no-op rasterizer:
        //   the legacy WebGL2 renderer cannot draw NodeMaterials, so any
        //   fallback raster pass would paint a black/garbled frame for
        //   most MaxJS scenes. We rely entirely on the path traced output
        //   plus the low-res fallback during shader compilation.
        t.bounces = 6;
        t.tiles.set(3, 3);
        t.minSamples = 1;
        t.renderDelay = 0;
        t.fadeDuration = 120;
        t.dynamicLowRes = true;
        t.rasterizeScene = false;
        t.rasterizeSceneCallback = () => {};
    }

    function biasRayOffset(material) {
        if (!material || typeof material.fragmentShader !== 'string') return;
        if (!material.fragmentShader.includes(RAY_OFFSET_BIAS)) return;
        material.fragmentShader = material.fragmentShader.replace(RAY_OFFSET_BIAS, RAY_OFFSET_BIAS_TARGET);
        material.needsUpdate = true;
    }

    function installGeneratorGuards(t) {
        const generator = t?._generator?.staticGeometryGenerator;
        if (!generator || generator._maxjsGeneratorGuardsInstalled) return;

        if (typeof generator._getMeshes === 'function') {
            const originalGetMeshes = generator._getMeshes.bind(generator);
            generator._getMeshes = () => {
                const meshes = originalGetMeshes();
                generator._maxjsLastMeshes = meshes;
                return meshes;
            };
        }

        if (typeof generator._updateIntermediateGeometries === 'function') {
            const originalUpdateIntermediateGeometries = generator._updateIntermediateGeometries.bind(generator);
            generator._updateIntermediateGeometries = () => {
                const before = new Map(generator._intermediateGeometry || []);
                originalUpdateIntermediateGeometries();
                const current = generator._intermediateGeometry;
                if (!current) return;
                for (const [key, geometry] of before) {
                    if (!current.has(key)) geometry?.dispose?.();
                }
            };
        }

        generator._maxjsGeneratorGuardsInstalled = true;
    }

    function installMaterialIndexPatch(t) {
        if (!t || t._maxjsMaterialIndexPatchInstalled) return;
        const originalUpdateFromResults = t._updateFromResults.bind(t);
        let lastMaterialIndexSignature = '';
        t._updateFromResults = (nextScene, nextCamera, results) => {
            const nextSignature = materialIndexSignature(t);
            if (results?.needsMaterialIndexUpdate || nextSignature !== lastMaterialIndexSignature) {
                if (patchGeneratedMaterialIndices(t, results)) {
                    lastMaterialIndexSignature = nextSignature;
                }
            } else {
                compactGeneratedGroups(t, results);
            }
            return originalUpdateFromResults(nextScene, nextCamera, results);
        };
        t._maxjsMaterialIndexPatchInstalled = true;
    }

    function ensureTracer() {
        if (!isEnabled() || disposed) return false;
        if (!hasLegacyWebGLRenderer()) {
            if (!warnedUnsupportedRenderer) {
                warnedUnsupportedRenderer = true;
                onStatus('max.js - Pathtracing requires the legacy WebGL2 backend (Render Mode: PT)');
            }
            return false;
        }
        if (tracer) return true;
        if (typeof PathTracerCtor !== 'function') {
            // First-frame race: module hasn't resolved yet. Kick the
            // loader if it hasn't started, but skip this frame so the
            // caller falls back to the standard renderer.
            loadModule();
            return false;
        }

        try {
            tracer = suppressClockDeprecationWarning(() => new PathTracerCtor(renderer));
            configureForLowLatency(tracer);
            // Library defaults are correct: ['position','normal','color','tangent','uv','uv2'].
            // setCommonAttributes runs computeTangents when normal+uv exist (gives correct
            // normal mapping) and zero/one-fills color/uv2 when meshes don't carry them.
            // The earlier `['position','normal','uv']` override stripped those and replaced
            // them with constants, which broke normal mapping and vertex colors.
            installGeneratorGuards(tracer);
            installMaterialIndexPatch(tracer);
            biasRayOffset(tracer._pathTracer?.material);
            requestSceneRebuild({ immediate: true });
            resetCameraKeys();
            return true;
        } catch (error) {
            tracer = null;
            onError(error);
            return false;
        }
    }

    // ─── Scene preparation ─────────────────────────────────────
    // We don't mutate the user's scene. We only:
    //  - flip `visible` to false on meshes we can't path trace
    //    (sky, ShaderMaterial, custom-graph NodeMaterials)
    //  - swap `scene.environment` / `scene.background` for the raw
    //    equirect HDRI when one is stashed in userData
    //
    // All changes are undone in the same render call.

    function rememberSceneProperty(restorers, name) {
        if (restorers.some(r => r.kind === 'scene' && r.name === name)) return;
        restorers.push({ kind: 'scene', name, value: scene[name] });
    }

    function hideUnsupportedMeshes(restorers) {
        const list = visibilityScratch;
        list.length = 0;
        scene.traverseVisible(object => {
            if (object?.isMesh && !isPathTraceableMesh(object)) list.push(object);
        });
        for (const mesh of list) {
            restorers.push({ kind: 'visible', object: mesh, value: mesh.visible });
            mesh.visible = false;
        }
        list.length = 0;
    }

    function bindPathTraceEnvironment(restorers) {
        const env = scene.userData?.maxjsPathTraceEnvironment;
        if (env?.isTexture) {
            rememberSceneProperty(restorers, 'environment');
            scene.environment = env;
        }
        const bg = scene.userData?.maxjsPathTraceBackground;
        if (bg?.isTexture) {
            rememberSceneProperty(restorers, 'background');
            scene.background = bg;
        }
    }

    function rememberUserData(restorers, target, seen) {
        if (!target || seen.has(target)) return;
        seen.add(target);
        if (!target.userData || Object.keys(target.userData).length === 0) return;
        restorers.push({ kind: 'userData', object: target, value: target.userData });
        target.userData = {};
    }

    function rememberMaterialUserData(restorers, material, seen) {
        if (!material) return;
        rememberUserData(restorers, material, seen);
        for (const key in material) {
            const value = material[key];
            if (value?.isTexture) rememberUserData(restorers, value, seen);
        }
    }

    function scrubPathTraceUserData(restorers) {
        const seen = new WeakSet();
        rememberUserData(restorers, scene, seen);
        rememberUserData(restorers, scene.environment, seen);
        rememberUserData(restorers, scene.background, seen);
        scene.traverseVisible(object => {
            rememberUserData(restorers, object, seen);
            if (!object?.isMesh) return;
            const materials = meshMaterials(object);
            for (const material of materials) rememberMaterialUserData(restorers, material, seen);
        });
    }

    function withPreparedScene(callback) {
        const restorers = [];
        try {
            hideUnsupportedMeshes(restorers);
            bindPathTraceEnvironment(restorers);
            scrubPathTraceUserData(restorers);
            return callback();
        } finally {
            for (let i = restorers.length - 1; i >= 0; i -= 1) {
                const r = restorers[i];
                if (r.kind === 'visible') r.object.visible = r.value;
                else if (r.kind === 'scene') scene[r.name] = r.value;
                else if (r.kind === 'userData') r.object.userData = r.value;
            }
        }
    }

    // ─── Frame loop ────────────────────────────────────────────

    function rebuildScene() {
        if (!ensureTracer()) return false;
        try {
            scene.updateMatrixWorld(true);
            activeCamera.updateMatrixWorld(true);
            withPreparedScene(() => tracer.setScene(scene, activeCamera));
            sceneDirty = false;
            hasSceneBuilt = true;
            sceneDirtyAt = 0;
            lastSceneRebuildAt = performance.now();
            nextRebuildRetryAt = 0;
            lastRebuildErrorKey = '';
            resetCameraKeys();
            return true;
        } catch (error) {
            sceneDirty = true;
            const key = error?.stack || error?.message || String(error);
            const now = performance.now();
            nextRebuildRetryAt = now + SCENE_REBUILD_RETRY_MS;
            if (key !== lastRebuildErrorKey) {
                lastRebuildErrorKey = key;
                onError(error);
            }
            return false;
        }
    }

    function syncCameraIfChanged() {
        if (!tracer || !activeCamera) return;
        activeCamera.updateMatrixWorld();
        const worldChanged = matrixChanged(activeCamera.matrixWorld, lastCameraWorld);
        const projectionChanged = matrixChanged(activeCamera.projectionMatrix, lastCameraProj);
        if (!worldChanged && !projectionChanged) return;
        tracer.setCamera(activeCamera);
    }

    function clearFrame() {
        // Black frame while we warm up. The legacy WebGL renderer cannot
        // raster MaxJS NodeMaterials, so we must NOT fall back to
        // `renderer.render(scene, camera)`; we claim the frame instead.
        try { renderer.clear(true, true, true); } catch {}
    }

    function render() {
        if (!isEnabled()) return false;
        if (!hasLegacyWebGLRenderer()) return false;

        if (!tracer && !ensureTracer()) {
            clearFrame();
            return true;
        }
        if (sceneDirty) {
            if (shouldRebuildSceneNow()) {
                if (!rebuildScene()) {
                    clearFrame();
                    return true;
                }
            } else if (!hasSceneBuilt) {
                clearFrame();
                return true;
            }
        }
        try {
            syncCameraIfChanged();
            tracer.renderSample();
            return true;
        } catch (error) {
            onError(error);
            clearFrame();
            return true;
        }
    }

    function markSceneDirty() {
        requestSceneRebuild();
    }

    function setCamera(nextCamera) {
        if (!nextCamera) return;
        activeCamera = nextCamera;
        resetCameraKeys();
        if (tracer) tracer.setCamera(activeCamera);
    }

    function disposeGeneratedSceneState(t) {
        const sceneGenerator = t?._generator;
        const staticGenerator = sceneGenerator?.staticGeometryGenerator;
        staticGenerator?._intermediateGeometry?.forEach(geometry => geometry?.dispose?.());
        staticGenerator?._intermediateGeometry?.clear?.();
        if (staticGenerator) staticGenerator._maxjsLastMeshes = null;
        sceneGenerator?.geometry?.dispose?.();
        if (sceneGenerator) sceneGenerator.bvh = null;
    }

    function dispose() {
        disposed = true;
        if (tracer) {
            disposeGeneratedSceneState(tracer);
            tracer._internalBackground?.dispose?.();
            tracer._colorBackground?.dispose?.();
            tracer._lowResPathTracer?.dispose?.();
            tracer.dispose?.();
        }
        tracer = null;
        hasSceneBuilt = false;
        sceneDirty = false;
        modulePromise = null;
    }

    if (typeof window !== 'undefined' && isEnabled()) {
        window.addEventListener('pagehide', dispose, { once: true });
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
