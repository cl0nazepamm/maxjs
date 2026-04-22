// maxjs_gltf.js — thin glTF loader driven by the C++ glTF Origin plugin.
// Each ThreeJSGLTFOrigin node in Max maps to one GLTFEntry here. Loading is
// independent per origin (no cross-origin asset cache); two origins pointing
// at the same file load twice. That's the v1 contract — glTF origins are
// aimed at pre-authored animated assets (hands, weapons, characters), not
// bulk-instanced props. Max geometry stays the right choice for that.
//
// Exposed to layers as `ctx.runtime.gltf` (see layer_manager.js). The system
// emits `gltf:loaded` and `gltf:error` on the shared layer-manager bus so
// layer scripts can drive behavior on top of the loaded scene graphs.

let _GLTFLoader = null;
let _gltfLoaderPromise = null;
const GLTF_TEXTURE_KEYS = [
    'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
    'aoMap', 'displacementMap', 'alphaMap', 'envMap', 'lightMap', 'clearcoatMap',
    'clearcoatNormalMap', 'clearcoatRoughnessMap', 'iridescenceMap', 'iridescenceThicknessMap',
    'sheenColorMap', 'sheenRoughnessMap', 'specularColorMap', 'specularIntensityMap',
    'thicknessMap', 'transmissionMap', 'anisotropyMap',
];

async function ensureGLTFLoader() {
    if (_GLTFLoader) return _GLTFLoader;
    if (!_gltfLoaderPromise) {
        _gltfLoaderPromise = import('three/addons/loaders/GLTFLoader.js').then(mod => {
            _GLTFLoader = mod.GLTFLoader;
            return _GLTFLoader;
        });
    }
    return _gltfLoaderPromise;
}

export function createMaxJSGLTFSystem({ THREE, parent, getBus = () => null, debugWarn = () => {} }) {
    const root = new THREE.Group();
    root.name = '__maxjs_gltf_origins__';
    root.matrixAutoUpdate = false;
    root.userData.maxjsExcludeFromRuntimeSnapshot = true;
    parent?.add?.(root);

    const entryMap = new Map(); // handle -> entry
    const readyWaiters = new Map(); // handle -> Set<cb>

    function fireBus(event, payload) {
        const bus = getBus?.();
        if (bus && typeof bus.emit === 'function') {
            try { bus.emit(event, payload); } catch (err) { debugWarn('[GLTF] bus emit', err); }
        }
    }

    function fireReadyWaiters(handle, entry) {
        const set = readyWaiters.get(handle);
        if (!set || set.size === 0) return;
        const waiters = [...set];
        readyWaiters.delete(handle);
        for (const cb of waiters) {
            try { cb(entry); } catch (err) { debugWarn('[GLTF] onReady waiter', err); }
        }
    }

    function collectMaterialTextures(material, textures) {
        for (const key of GLTF_TEXTURE_KEYS) {
            const texture = material?.[key];
            if (texture?.isTexture) textures.add(texture);
        }
        if (material?.uniforms && typeof material.uniforms === 'object') {
            for (const uniform of Object.values(material.uniforms)) {
                const texture = uniform?.value;
                if (texture?.isTexture) textures.add(texture);
            }
        }
    }

    function disposeMaterial(material, materials, textures) {
        if (!material) return;
        if (Array.isArray(material)) {
            for (const item of material) disposeMaterial(item, materials, textures);
            return;
        }
        if (materials.has(material)) return;
        materials.add(material);
        collectMaterialTextures(material, textures);
        material.dispose?.();
    }

    function disposeRootResources(rootNode) {
        if (!rootNode?.isObject3D) return;
        const geometries = new Set();
        const materials = new Set();
        const textures = new Set();
        rootNode.traverse(obj => {
            if (obj.geometry?.dispose && !geometries.has(obj.geometry)) {
                geometries.add(obj.geometry);
                obj.geometry.dispose();
            }
            disposeMaterial(obj.material, materials, textures);
        });
        for (const texture of textures) texture.dispose?.();
    }

    function makeEntry(handle, data) {
        return {
            handle,
            nodeName: data?.n ?? '',
            displayName: data?.displayName ?? '',
            filePath: data?.url ?? '',
            rootScale: Number.isFinite(Number(data?.rootScale)) ? Number(data.rootScale) : 1.0,
            autoplay: data?.autoplay !== false,
            visible: data?.v !== '0' && data?.v !== false,
            worldMatrix: new THREE.Matrix4(),
            container: new THREE.Group(),
            root: null,
            clips: [],
            mixer: null,
            actions: [],
            state: 'idle',
            error: null,
            loadToken: 0,
            lastTimeSeconds: 0,
        };
    }

    function applyEntryTransform(entry) {
        entry.container.matrixAutoUpdate = false;
        entry.container.matrix.copy(entry.worldMatrix);
        entry.container.matrixWorldNeedsUpdate = true;
        entry.container.visible = !!entry.visible;
    }

    function setMatrixFromData(entry, data) {
        if (Array.isArray(data?.t) && data.t.length === 16) {
            entry.worldMatrix.fromArray(data.t);
        }
        if (typeof data?.v !== 'undefined') entry.visible = !(data.v === '0' || data.v === false);
        applyEntryTransform(entry);
    }

    function stopEntryPlayback(entry) {
        if (!entry) return;
        if (Array.isArray(entry.actions)) {
            for (const action of entry.actions) {
                try { action?.stop?.(); } catch (err) { debugWarn('[GLTF] stop action', err); }
            }
        }
        if (entry.mixer) {
            try {
                if (entry.root) entry.mixer.uncacheRoot?.(entry.root);
                entry.mixer.stopAllAction?.();
            } catch (err) {
                debugWarn('[GLTF] stop mixer', err);
            }
        }
        entry.mixer = null;
        entry.actions = [];
    }

    function syncEntryPlayback(entry) {
        const shouldAutoplay = !!entry?.autoplay && !!entry?.root && Array.isArray(entry.clips) && entry.clips.length > 0;
        if (!shouldAutoplay) {
            stopEntryPlayback(entry);
            return;
        }

        const existingRoot = entry.mixer?.getRoot?.();
        if (entry.mixer && existingRoot === entry.root && entry.actions.length === entry.clips.length) {
            return;
        }

        stopEntryPlayback(entry);

        const mixer = new THREE.AnimationMixer(entry.root);
        const actions = [];
        for (const clip of entry.clips) {
            const action = mixer.clipAction(clip);
            action.enabled = true;
            action.clampWhenFinished = false;
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.play();
            actions.push(action);
        }
        entry.mixer = mixer;
        entry.actions = actions;
        mixer.setTime(entry.lastTimeSeconds || 0);
    }

    function setEntryTime(entry, timeSeconds) {
        if (!entry) return;
        const nextTime = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
        entry.lastTimeSeconds = nextTime;
        if (entry.mixer && entry.autoplay) {
            entry.mixer.setTime(nextTime);
        }
    }

    async function startLoad(entry) {
        if (!entry.filePath) {
            entry.state = 'error';
            entry.error = new Error('empty file path');
            fireBus('gltf:error', { handle: entry.handle, error: entry.error });
            return;
        }

        const token = ++entry.loadToken;
        entry.state = 'loading';
        entry.error = null;

        let GLTFLoader;
        try {
            GLTFLoader = await ensureGLTFLoader();
        } catch (err) {
            if (entry.loadToken !== token) return;
            entry.state = 'error';
            entry.error = err;
            fireBus('gltf:error', { handle: entry.handle, error: err });
            return;
        }

        const loader = new GLTFLoader();
        const url = entry.filePath;
        const slash = url.lastIndexOf('/');
        if (slash > 0) loader.setResourcePath(url.slice(0, slash + 1));

        loader.load(
            url,
            (gltf) => {
                if (entry.loadToken !== token) return; // stale
                const loadedRoot = gltf.scene || gltf.scenes?.[0];
                if (!loadedRoot) {
                    entry.state = 'error';
                    entry.error = new Error('gltf has no scene');
                    fireBus('gltf:error', { handle: entry.handle, error: entry.error });
                    return;
                }
                // Apply rootScale
                if (Number.isFinite(entry.rootScale) && entry.rootScale !== 1) {
                    loadedRoot.scale.multiplyScalar(entry.rootScale);
                }
                // Swap into the container (ditch any previous load)
                if (entry.root && entry.root.parent === entry.container) {
                    entry.container.remove(entry.root);
                    disposeRootResources(entry.root);
                }
                entry.container.add(loadedRoot);
                entry.root = loadedRoot;
                entry.clips = gltf.animations ?? [];
                entry.state = 'ready';
                applyEntryTransform(entry);
                syncEntryPlayback(entry);
                fireBus('gltf:loaded', { handle: entry.handle, entry });
                fireReadyWaiters(entry.handle, entry);
            },
            undefined,
            (err) => {
                if (entry.loadToken !== token) return;
                entry.state = 'error';
                entry.error = err || new Error('gltf load failed');
                fireBus('gltf:error', { handle: entry.handle, error: entry.error });
            },
        );
    }

    function upsertEntry(data) {
        if (!data || typeof data.h !== 'number') return null;
        const handle = data.h >>> 0;
        let entry = entryMap.get(handle);
        const prevFilePath = entry?.filePath;
        const prevRootScale = entry?.rootScale;
        const prevAutoplay = entry?.autoplay;

        if (!entry) {
            entry = makeEntry(handle, data);
            entry.container.name = `__maxjs_gltf_${handle}__`;
            root.add(entry.container);
            entryMap.set(handle, entry);
        } else {
            entry.nodeName = data?.n ?? entry.nodeName;
            entry.displayName = data?.displayName ?? entry.displayName;
            entry.filePath = data?.url ?? entry.filePath;
            entry.rootScale = Number.isFinite(Number(data?.rootScale)) ? Number(data.rootScale) : entry.rootScale;
            entry.autoplay = data?.autoplay !== false;
        }

        setMatrixFromData(entry, data);

        const fileChanged = prevFilePath !== entry.filePath;
        const scaleChanged = prevRootScale !== undefined && prevRootScale !== entry.rootScale;
        const autoplayChanged = prevAutoplay !== undefined && prevAutoplay !== entry.autoplay;
        if (fileChanged || (scaleChanged && !entry.root)) {
            startLoad(entry);
        } else if (scaleChanged && entry.root) {
            // Rescale the already-loaded root in place. Avoids a full reload
            // on slider drag but does lose any world-scaled children that the
            // user baked in via layer code. Acceptable v1.
            const ratio = entry.rootScale / (prevRootScale || 1);
            if (Number.isFinite(ratio) && ratio !== 1) {
                entry.root.scale.multiplyScalar(ratio);
            }
        }
        if (autoplayChanged || (!fileChanged && entry.root)) {
            syncEntryPlayback(entry);
        }

        return entry;
    }

    function applyGLTFs(gltfs = []) {
        const seen = new Set();
        for (const data of gltfs) {
            const entry = upsertEntry(data);
            if (entry) seen.add(entry.handle);
        }
        // Remove entries no longer present in the scene
        for (const [handle, entry] of [...entryMap.entries()]) {
            if (seen.has(handle)) continue;
            removeEntry(handle);
        }
    }

    function applyGLTFUpdates(gltfs = []) {
        for (const data of gltfs) upsertEntry(data);
    }

    function applyGLTFTransformBinary(handle, matrix16, visible) {
        const entry = entryMap.get(handle >>> 0);
        if (!entry) return;
        entry.worldMatrix.fromArray(matrix16);
        entry.visible = !!visible;
        applyEntryTransform(entry);
    }

    function removeEntry(handle) {
        const entry = entryMap.get(handle >>> 0);
        if (!entry) return;
        entry.loadToken++; // invalidate any in-flight load
        stopEntryPlayback(entry);
        if (entry.root && entry.root.parent === entry.container) {
            entry.container.remove(entry.root);
            disposeRootResources(entry.root);
        }
        root.remove(entry.container);
        entryMap.delete(handle >>> 0);
        readyWaiters.delete(handle >>> 0);
    }

    function update(dt) {
        const delta = Number.isFinite(dt) && dt > 0 ? dt : 0;
        if (delta <= 0) return;
        for (const entry of entryMap.values()) {
            if (!entry.mixer || !entry.autoplay) continue;
            entry.mixer.update(delta);
            entry.lastTimeSeconds += delta;
        }
    }

    function setTime(timeSeconds) {
        const nextTime = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
        for (const entry of entryMap.values()) {
            setEntryTime(entry, nextTime);
        }
    }

    function getEntry(handle) {
        return entryMap.get(handle >>> 0) ?? null;
    }

    function findByName(name) {
        if (!name) return null;
        for (const entry of entryMap.values()) {
            if (entry.displayName && entry.displayName === name) return entry;
        }
        for (const entry of entryMap.values()) {
            if (entry.nodeName === name) return entry;
        }
        return null;
    }

    function list() {
        return [...entryMap.values()];
    }

    function onReady(handle, cb) {
        if (typeof cb !== 'function') return () => {};
        const h = handle >>> 0;
        const entry = entryMap.get(h);
        if (entry && entry.state === 'ready') {
            try { cb(entry); } catch (err) { debugWarn('[GLTF] onReady immediate', err); }
            return () => {};
        }
        let set = readyWaiters.get(h);
        if (!set) { set = new Set(); readyWaiters.set(h, set); }
        set.add(cb);
        return () => {
            const cur = readyWaiters.get(h);
            if (cur) { cur.delete(cb); if (cur.size === 0) readyWaiters.delete(h); }
        };
    }

    function clear() {
        for (const [handle] of [...entryMap.entries()]) removeEntry(handle);
    }

    function dispose() {
        clear();
        root.parent?.remove(root);
    }

    return {
        root,
        applyGLTFs,
        applyGLTFUpdates,
        applyGLTFTransformBinary,
        removeEntry,
        getEntry,
        findByName,
        list,
        onReady,
        update,
        setTime,
        clear,
        dispose,
    };
}
