// project_runtime.js — file-backed Three.js project host for MaxJS.
// Loads JS-authored layers from an external project directory without touching Max-owned sync.

function normalizeWindowsPath(path) {
    return String(path ?? '').replace(/\//g, '\\');
}

function ensureTrailingSlash(path) {
    return path.endsWith('\\') ? path : `${path}\\`;
}

function isAbsolutePath(path) {
    return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function toAssetUrl(filePath) {
    const normalized = String(filePath ?? '').replace(/\\/g, '/');
    const segments = normalized.split('/').filter((segment, index) => segment.length > 0 || index === 0);
    const encoded = segments.map(segment => encodeURIComponent(segment)).join('/');
    return `https://maxjs-assets.local/${encoded}`;
}

function toProjectRootUrl(projectDir) {
    return `${toAssetUrl(ensureTrailingSlash(normalizeWindowsPath(projectDir)))}`;
}

function projectUrl(projectRootUrl, relativePath, versionTag = '') {
    const base = projectRootUrl.endsWith('/') ? projectRootUrl : `${projectRootUrl}/`;
    const url = new URL(relativePath.replace(/\\/g, '/'), base);
    if (versionTag) url.searchParams.set('v', versionTag);
    return url.toString();
}

function resolveFactory(moduleNamespace) {
    const directHooks = ['init', 'update', 'dispose'].some(key => typeof moduleNamespace?.[key] === 'function');
    if (directHooks) return async () => moduleNamespace;

    const candidate = moduleNamespace?.default
        ?? moduleNamespace?.createLayer
        ?? moduleNamespace?.mount;

    if (typeof candidate === 'function') return candidate;
    if (candidate && typeof candidate === 'object') return async () => candidate;

    throw new Error('Project module must export default/createLayer/mount or layer hooks');
}

async function fetchText(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.text();
}

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(item => stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function cloneManifest(manifest) {
    return JSON.parse(JSON.stringify(manifest));
}

function cloneJsonValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function manifest404(error) {
    return String(error?.message || error).includes('404');
}

function deriveProjectName(projectDir) {
    const normalized = String(projectDir ?? '').replace(/[\\/]+$/, '');
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || 'Active Project';
}

export function createProjectRuntime({ layerManager, bridge, perfHud, debugLog = () => {}, debugWarn = () => {} }) {
    let projectDir = '';
    let projectRootUrl = '';
    let manifestBaseUrl = '';
    let inlineDir = '';
    let pollMs = 0;
    let sceneSaved = false;
    let manifestExists = false;
    let transientPostFxState = null;
    let postFxState = null;
    let lastManifestText = '';
    let lastPostFxText = '';
    let lastStatus = '';
    let timer = 0;
    let revision = 0;
    let pollInFlight = false;
    /** Serializes manifest application so persist + poll reload cannot interleave mounts/removes. */
    let manifestApplyGate = Promise.resolve();
    let manifestState = null;
    let nextRequestId = 1;
    let suppressProjectReloadCount = 0;

    const activeLayerIds = new Set();
    const activeProjectLayers = new Map();
    const inlineLayerState = new Map();
    const listeners = new Set();
    const pendingHostActions = new Map();

    function emitChange() {
        for (const listener of listeners) {
            try {
                listener();
            } catch (error) {
                console.error('[ProjectRuntime] listener error', error);
            }
        }
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function setStatus(message) {
        if (message === lastStatus) return;
        lastStatus = message;
        const line = `MaxJS - ${message}`;
        if (typeof perfHud?.setProjectBanner === 'function') {
            perfHud.setProjectBanner(line);
        } else {
            perfHud?.setStatus?.(line);
        }
        emitChange();
    }

    function clearTimer() {
        if (!timer) return;
        clearInterval(timer);
        timer = 0;
    }

    function schedulePolling() {
        clearTimer();
        if (!projectRootUrl || !Number.isFinite(pollMs) || pollMs <= 0) return;
        timer = setInterval(() => {
            void reload(false);
        }, pollMs);
    }

    function removeProjectLayer(id) {
        try {
            layerManager.remove(id);
        } catch (err) {
            debugWarn('[ProjectRuntime] layer remove failed', id, err);
        }
        activeLayerIds.delete(id);
        activeProjectLayers.delete(id);
    }

    function clearProjectLayers() {
        for (const id of [...activeLayerIds]) {
            removeProjectLayer(id);
        }
    }

    function defaultManifest() {
        return {
            name: 'Active Project',
            pollMs: 0,
            layers: [],
        };
    }

    function implicitMainManifest() {
        return {
            name: deriveProjectName(projectDir),
            pollMs,
            layers: [
                {
                    id: 'main',
                    name: 'main',
                    entry: 'main.js',
                    enabled: true,
                },
            ],
            __implicit: true,
        };
    }

    function buildManifestLayers(manifest) {
        const rawLayers = Array.isArray(manifest?.layers)
            ? manifest.layers
            : (manifest?.entry || manifest?.name)
                ? [{ id: 'main', name: manifest.name || 'main', entry: manifest.entry || 'main.js', enabled: true }]
                : [];

        return rawLayers.map((entry, index) => {
            const layerId = entry?.id || entry?.name || `layer_${index}`;
            const name = entry?.name || layerId;
            const entryPath = entry?.entry || entry?.path || manifest?.entry || 'main.js';
            return {
                id: layerId,
                name,
                entryPath,
                enabled: entry?.enabled !== false,
                raw: entry && typeof entry === 'object' ? entry : {},
                signature: stableStringify({
                    ...(entry && typeof entry === 'object' ? entry : {}),
                    id: layerId,
                    name,
                    entry: entryPath,
                }),
            };
        });
    }

    function ensureMutableLayers(manifest) {
        if (Array.isArray(manifest.layers)) return manifest.layers;
        manifest.layers = buildManifestLayers(manifest).map(entry => ({
            ...(entry.raw ?? {}),
            id: entry.id,
            name: entry.name,
            entry: entry.entryPath,
            enabled: entry.enabled,
        }));
        delete manifest.entry;
        return manifest.layers;
    }

    async function requestHostAction(action, data = {}) {
        const requestId = `host_${nextRequestId++}`;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingHostActions.delete(requestId);
                reject(new Error(`${action} timed out`));
            }, 10000);

            pendingHostActions.set(requestId, { resolve, reject, timeout, action });
            bridge.send(action, { requestId, ...data });
        });
    }

    bridge.on('host_action_result', msg => {
        const pending = pendingHostActions.get(msg.requestId);
        if (!pending) return;
        pendingHostActions.delete(msg.requestId);
        clearTimeout(pending.timeout);

        if (msg.ok) {
            pending.resolve(msg);
        } else {
            pending.reject(new Error(msg.error || `${pending.action} failed`));
        }
    });

    async function loadManifest(force = false) {
        if (!projectRootUrl) return null;

        const manifestUrl = projectUrl(projectRootUrl, 'project.maxjs.json', `${Date.now()}`);
        try {
            const manifestText = await fetchText(manifestUrl);
            if (!force && manifestText === lastManifestText) return null;

            const manifest = JSON.parse(manifestText);
            lastManifestText = manifestText;
            manifestState = manifest;
            manifestBaseUrl = new URL('./', manifestUrl).toString();
            manifestExists = true;
            emitChange();
            return manifest;
        } catch (error) {
            if (!manifest404(error)) throw error;

            // No manifest — don't try main.js fallback (avoids console 404 noise)
            throw error;
        }
    }

    async function loadPostFxState(force = false) {
        if (!projectRootUrl) {
            postFxState = null;
            lastPostFxText = '';
            return false;
        }

        const postFxUrl = projectUrl(projectRootUrl, 'postfx.maxjs.json', `${Date.now()}`);
        try {
            const text = await fetchText(postFxUrl);
            if (!force && text === lastPostFxText) return false;

            lastPostFxText = text;
            postFxState = cloneJsonValue(JSON.parse(text));
            emitChange();
            return true;
        } catch (error) {
            if (!manifest404(error)) throw error;

            lastPostFxText = '';
            const fallback = cloneJsonValue(manifestState?.postFx ?? null);
            const changed = stableStringify(postFxState) !== stableStringify(fallback);
            postFxState = fallback;
            if (changed) emitChange();
            return changed;
        }
    }

    async function mountLayer(entry, manifest) {
        const layerId = entry.id;
        const entryPath = entry.entryPath;
        const moduleVersion = ++revision;
        const baseUrl = manifestBaseUrl || projectRootUrl;
        const moduleUrl = isAbsolutePath(entryPath)
            ? `${toAssetUrl(entryPath)}?v=${moduleVersion}`
            : projectUrl(baseUrl, entryPath, `${moduleVersion}`);

        let moduleNamespace;
        try {
            moduleNamespace = await import(moduleUrl);
        } catch (error) {
            const detail = error?.message || String(error);
            throw new Error(`layer import failed: ${layerId} (${entryPath}) -> ${detail}`);
        }
        const factory = resolveFactory(moduleNamespace);

        const result = await layerManager.mount(
            layerId,
            async (ctx, THREE) => factory(ctx, THREE, { manifest, layer: entry }),
            {
                name: entry.name || layerId,
                code: moduleUrl,
                source: 'project',
                entry: entryPath,
            },
        );

        if (result?.error) {
            throw new Error(result.error);
        }

        activeLayerIds.add(layerId);
        activeProjectLayers.set(layerId, {
            signature: entry.signature,
            moduleUrl,
        });
    }

    async function applyManifest(manifest, options = {}) {
        // Layer discovery is now driven by the C++ inline-folder scan
        // (inline_layers_state message), not by the manifest. We keep
        // applyManifest as a no-op for the layers field so the manifest
        // file can still carry name/pollMs/postFx without surprising us.
        // Drop any project-source layers from the legacy active sets so
        // they don't shadow the inline mount path.
        manifestState = manifest;
        if (activeLayerIds.size > 0) {
            for (const id of [...activeLayerIds]) {
                if (!mountedInlineLayers.has(id)) removeProjectLayer(id);
            }
        }
        emitChange();
    }

    async function reload(force = false) {
        if (!projectRootUrl || pollInFlight) return false;
        pollInFlight = true;
        try {
            const manifest = await loadManifest(force);
            if (!manifest) {
                return await loadPostFxState(force);
            }

            await applyManifest(manifest, { forceReload: force });
            await loadPostFxState(force);

            if (Number.isFinite(manifest.pollMs) && manifest.pollMs >= 0) {
                pollMs = manifest.pollMs;
                schedulePolling();
            }

            setStatus(`project loaded: ${manifest.name || projectDir}`);
            return true;
        } catch (error) {
            clearProjectLayers();
            manifestState = null;
            postFxState = null;
            lastManifestText = '';
            lastPostFxText = '';
            emitChange();

            const is404 = manifest404(error);
            if (is404) {
                manifestExists = false;
                clearTimer();
                setStatus('no project manifest');
            } else {
                setStatus(`project error: ${error?.message || String(error)}`);
                console.error('[ProjectRuntime]', error);
            }
            return false;
        } finally {
            pollInFlight = false;
        }
    }

    async function ensureManifestLoaded() {
        if (manifestState) return manifestState;
        try {
            const manifest = await loadManifest(true);
            if (manifest) return manifest;
        } catch (error) {
            if (!manifest404(error)) throw error;
        }

        manifestState = defaultManifest();
        return manifestState;
    }

    async function persistManifest(nextManifest, options = {}) {
        const text = `${JSON.stringify(nextManifest, null, 2)}\n`;
        // Always reload:false: we apply `nextManifest` locally below. Asking the host to
        // SendProjectReload in parallel races with this async applyManifest (and with poll
        // reload), overlapping layer teardown/mount and crashing WebView2.
        await requestHostAction('project_manifest_write', {
            contentBase64: toBase64Utf8(text),
            reload: false,
        });

        lastManifestText = text;
        manifestExists = true;
        if (options.apply !== false) {
            await applyManifest(nextManifest);
        } else {
            manifestState = nextManifest;
            emitChange();
        }
        if (!options.silent) {
            setStatus(`project saved: ${nextManifest.name || projectDir}`);
        }
        return true;
    }

    async function updateManifest(mutator, options = {}) {
        const manifest = cloneManifest(await ensureManifestLoaded());
        mutator(manifest);
        if (!Array.isArray(manifest.layers)) manifest.layers = [];
        await persistManifest(manifest, options);
    }

    async function setLayerEnabled(id, enabled) {
        await updateManifest(manifest => {
            const layers = ensureMutableLayers(manifest);
            const entry = layers.find(layer => (layer?.id || layer?.name) === id);
            if (!entry) throw new Error(`Project layer not found: ${id}`);
            entry.enabled = !!enabled;
        });
    }

    // Synchronous: flip the enabled flag in the in-memory manifest state so
    // listEntries() reflects the change immediately. Does NOT touch disk and
    // does NOT re-run applyManifest. Caller is responsible for actually
    // mounting/unmounting the layer. Used by the instant disable path in the
    // panel UI.
    function markLayerEnabled(id, enabled) {
        if (!manifestState) return false;
        const layers = Array.isArray(manifestState.layers) ? manifestState.layers : null;
        if (!layers) return false;
        const entry = layers.find(layer => (layer?.id || layer?.name) === id);
        if (!entry) return false;
        entry.enabled = !!enabled;
        emitChange();
        return true;
    }

    // Async: write the manifest to disk without re-running applyManifest.
    // Used together with markLayerEnabled in the instant-disable path so the
    // project file stays in sync with the runtime state.
    async function persistLayerEnabled(id, enabled) {
        if (!manifestState) return false;
        const nextManifest = cloneManifest(manifestState);
        const layers = ensureMutableLayers(nextManifest);
        const entry = layers.find(layer => (layer?.id || layer?.name) === id);
        if (!entry) return false;
        entry.enabled = !!enabled;
        // apply:false so persistManifest writes the file without re-running
        // applyManifest — we already applied state via the direct remove.
        await persistManifest(nextManifest, { apply: false, silent: true });
        return true;
    }

    async function removeLayer(id) {
        await updateManifest(manifest => {
            const layers = ensureMutableLayers(manifest);
            const nextLayers = layers.filter(layer => (layer?.id || layer?.name) !== id);
            if (nextLayers.length === layers.length) {
                throw new Error(`Project layer not found: ${id}`);
            }
            manifest.layers = nextLayers;
        });
    }

    async function clearPersistedLayers() {
        await updateManifest(manifest => {
            manifest.layers = [];
            delete manifest.entry;
        });
    }

    async function removeInlineLayer(id) {
        await requestHostAction('inline_layer_remove', { id });
    }

    async function setInlineLayerEnabled(id, enabled) {
        const nextEnabled = !!enabled;
        // Best-effort persistence — the runtime active flag is the source
        // of visual truth, set by the caller via layerManager.setActive.
        // We update local state immediately so the UI reflects the change
        // even if the host action is slow or fails.
        const current = inlineLayerState.get(id) || { id, name: id };
        inlineLayerState.set(id, { ...current, enabled: nextEnabled });
        emitChange();
        await requestHostAction('inline_layer_set_enabled', { id, enabled: nextEnabled });
    }

    async function clearInlineLayers() {
        await requestHostAction('inline_layer_clear');
    }

    function getPostFxState() {
        return cloneJsonValue(postFxState ?? transientPostFxState ?? manifestState?.postFx ?? null);
    }

    async function setPostFxState(nextState) {
        const cloned = cloneJsonValue(nextState);
        if (!sceneSaved || !manifestExists) {
            transientPostFxState = cloned;
            emitChange();
            return false;
        }

        transientPostFxState = null;
        const text = `${JSON.stringify(cloned, null, 2)}\n`;
        await requestHostAction('project_postfx_write', {
            contentBase64: toBase64Utf8(text),
        });
        lastPostFxText = text;
        postFxState = cloned;
        emitChange();
        return true;
    }

    async function releaseManifest() {
        const result = await requestHostAction('project_release_manifest');
        sceneSaved = true;
        manifestExists = true;
        if (result?.path) {
            projectDir = normalizeWindowsPath(result.path).trim();
            projectRootUrl = projectDir ? toProjectRootUrl(projectDir) : '';
            inlineDir = projectDir ? ensureTrailingSlash(`${projectDir}\\inlines`) : '';
        }
        emitChange();
        await reload(true);
        if (transientPostFxState != null) {
            await setPostFxState(transientPostFxState);
        }
        return true;
    }

    function listEntries() {
        // Layer list is the union of everything the C++ inline-folder scan
        // told us about. Each entry's enabled state is the layer's RUNTIME
        // active flag (live truth), with a fallback to the scan flag when
        // the layer hasn't been mounted yet (e.g. .js.disabled file).
        const runtimeLayers = new Map(layerManager.list().map(layer => [layer.id, layer]));
        const out = [];
        for (const [id, state] of inlineLayerState.entries()) {
            const runtime = runtimeLayers.get(id);
            const mounted = mountedInlineLayers.has(id);
            const enabled = mounted ? !!runtime?.active : state.enabled;
            out.push({
                id,
                name: runtime?.name || state.name || id,
                entry: `inlines/${id}.js`,
                source: 'project',
                persisted: true,
                enabled,
                active: !!runtime?.active,
                loading: !!runtime?.loading,
                error: runtime?.error ?? null,
                anchors: runtime?.anchors ?? 0,
                tracked: runtime?.tracked ?? 0,
                profile: runtime?.profile ?? null,
            });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    function listInlineEntries() {
        const runtimeLayers = new Map(
            layerManager.list()
                .filter(layer => layer.source !== 'project')
                .map(layer => [layer.id, layer]),
        );

        const entries = [];
        for (const [id, state] of inlineLayerState.entries()) {
            const runtime = runtimeLayers.get(id);
            runtimeLayers.delete(id);
            entries.push({
                id,
                name: runtime?.name || state.name || id,
                source: 'inline',
                persisted: true,
                enabled: state.enabled !== false,
                active: runtime?.active ?? false,
                loading: runtime?.loading ?? false,
                error: runtime?.error ?? null,
                anchors: runtime?.anchors ?? 0,
                tracked: runtime?.tracked ?? 0,
                profile: runtime?.profile ?? null,
            });
        }

        for (const runtime of runtimeLayers.values()) {
            entries.push({
                id: runtime.id,
                name: runtime.name || runtime.id,
                source: 'inline',
                persisted: false,
                enabled: true,
                active: runtime.active ?? true,
                loading: runtime.loading ?? false,
                error: runtime.error ?? null,
                anchors: runtime.anchors ?? 0,
                tracked: runtime.tracked ?? 0,
                profile: runtime.profile ?? null,
            });
        }

        return entries;
    }

    async function setProjectDirectory(nextDir, options = {}) {
        const normalized = normalizeWindowsPath(nextDir).trim();
        const projectChanged = normalized !== projectDir;
        projectDir = normalized;
        projectRootUrl = normalized ? toProjectRootUrl(normalized) : '';
        if (typeof options.inlineDir === 'string') {
            inlineDir = normalizeWindowsPath(options.inlineDir).trim();
        }
        if (typeof options.sceneSaved === 'boolean') {
            sceneSaved = options.sceneSaved;
        }
        if (typeof options.manifestExists === 'boolean') {
            manifestExists = options.manifestExists;
        }
        if (Number.isFinite(options.pollMs) && options.pollMs >= 0) {
            pollMs = options.pollMs;
        }

        manifestState = null;
        manifestBaseUrl = '';
        postFxState = null;
        lastManifestText = '';
        lastPostFxText = '';
        if (projectChanged) clearProjectLayers();
        if (projectChanged) transientPostFxState = null;
        schedulePolling();
        emitChange();

        if (!projectRootUrl) {
            clearProjectLayers();
            setStatus('project runtime idle');
            return false;
        }

        return reload(true);
    }

    bridge.on('project_config', msg => {
        void setProjectDirectory(msg.dir || '', {
            pollMs: msg.pollMs,
            inlineDir: msg.inlineDir || '',
            sceneSaved: msg.sceneSaved === true,
            manifestExists: msg.manifestExists === true,
        });
    });

    bridge.on('project_reload', () => {
        if (suppressProjectReloadCount > 0) {
            suppressProjectReloadCount -= 1;
            return;
        }
        void reload(true);
    });

    // Auto-mount layers discovered by C++ scanning the inlines/ folder.
    // No manifest entry needed — drop a .js into inlines/ and it loads.
    // Each call to inline_layers_state is the full current state of the
    // folder; we mount what's new, drop what's gone, and apply the
    // enabled flag as a runtime active state on what stays.
    const mountedInlineLayers = new Map(); // id -> { signature, moduleUrl }

    function inlineLayerUrl(id, version) {
        if (!inlineDir) return null;
        const baseUrl = toAssetUrl(inlineDir);
        const sep = baseUrl.endsWith('/') ? '' : '/';
        return `${baseUrl}${sep}${encodeURIComponent(id)}.js?v=${version}`;
    }

    async function mountInlineLayer(id, name) {
        const moduleVersion = ++revision;
        const moduleUrl = inlineLayerUrl(id, moduleVersion);
        if (!moduleUrl) throw new Error(`No inline directory configured for ${id}`);

        let moduleNamespace;
        try {
            moduleNamespace = await import(moduleUrl);
        } catch (error) {
            const detail = error?.message || String(error);
            throw new Error(`inline layer import failed: ${id} -> ${detail}`);
        }
        const factory = resolveFactory(moduleNamespace);

        const result = await layerManager.mount(
            id,
            async (ctx, THREE) => factory(ctx, THREE, { layer: { id, name } }),
            {
                name: name || id,
                code: moduleUrl,
                source: 'project',
                entry: `inlines/${id}.js`,
            },
        );
        if (result?.error) throw new Error(result.error);

        mountedInlineLayers.set(id, { moduleUrl });
    }

    function unmountInlineLayer(id) {
        try { layerManager.remove(id); }
        catch (err) { debugWarn('[ProjectRuntime] inline unmount failed', id, err); }
        mountedInlineLayers.delete(id);
    }

    bridge.on('inline_layers_state', async msg => {
        const layers = Array.isArray(msg?.layers) ? msg.layers : [];
        debugLog('[ProjectRuntime] inline_layers_state', {
            inlineDir,
            layerCount: layers.length,
            layers: layers.map(l => ({ id: l.id, enabled: l.enabled })),
        });

        inlineLayerState.clear();
        const seen = new Set();
        for (const layer of layers) {
            if (!layer?.id) continue;
            seen.add(layer.id);
            inlineLayerState.set(layer.id, {
                id: layer.id,
                name: layer.name || layer.id,
                enabled: layer.enabled !== false,
            });
        }

        // Drop layers whose files vanished from the folder.
        for (const id of [...mountedInlineLayers.keys()]) {
            if (!seen.has(id)) unmountInlineLayer(id);
        }

        // Mount whatever's new. Skip layers reported as disabled — the file
        // is renamed to .js.disabled and the URL would 404. Re-enable
        // happens via the rename host action which will trigger a fresh
        // inline_layers_state with enabled=true.
        for (const layer of layers) {
            if (!layer?.id) continue;
            if (layer.enabled === false) {
                if (mountedInlineLayers.has(layer.id)) unmountInlineLayer(layer.id);
                continue;
            }
            if (!mountedInlineLayers.has(layer.id)) {
                try {
                    await mountInlineLayer(layer.id, layer.name);
                    debugLog('[ProjectRuntime] mounted inline layer', layer.id);
                } catch (err) {
                    debugWarn('[ProjectRuntime] inline mount failed', layer.id, err);
                }
            }
            // Apply the enabled flag as a runtime active state. For layers
            // already mounted, this is just a flag flip — no remount.
            layerManager.setActive?.(layer.id, true);
        }

        emitChange();
    });

    return {
        subscribe,
        listEntries,
        listInlineEntries,
        setLayerEnabled,
        markLayerEnabled,
        persistLayerEnabled,
        removeLayer,
        clearPersistedLayers,
        setInlineLayerEnabled,
        removeInlineLayer,
        clearInlineLayers,
        getPostFxState,
        setPostFxState,
        releaseManifest,
        setProjectDirectory,
        reload,
        clear() {
            clearTimer();
            clearProjectLayers();
            manifestState = null;
            lastManifestText = '';
            projectDir = '';
            projectRootUrl = '';
            manifestBaseUrl = '';
            inlineDir = '';
            sceneSaved = false;
            manifestExists = false;
            emitChange();
            setStatus('project runtime cleared');
        },
        getState() {
            return {
                projectDir,
                projectRootUrl,
                inlineDir,
                pollMs,
                sceneSaved,
                manifestExists,
                activeLayers: Array.from(activeLayerIds),
                manifest: manifestState,
            };
        },
    };
}
