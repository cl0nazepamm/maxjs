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

function manifest404(error) {
    return String(error?.message || error).includes('404');
}

function deriveProjectName(projectDir) {
    const normalized = String(projectDir ?? '').replace(/[\\/]+$/, '');
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || 'Active Project';
}

export function createProjectRuntime({ layerManager, bridge, perfHud }) {
    let projectDir = '';
    let projectRootUrl = '';
    let pollMs = 0;
    let lastManifestText = '';
    let lastStatus = '';
    let timer = 0;
    let revision = 0;
    let pollInFlight = false;
    let manifestState = null;
    let nextRequestId = 1;

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
        layerManager.remove(id);
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
            emitChange();
            return manifest;
        } catch (error) {
            if (!manifest404(error)) throw error;

            const mainUrl = projectUrl(projectRootUrl, 'main.js', `${Date.now()}`);
            let mainText = '';
            try {
                mainText = await fetchText(mainUrl);
            } catch (mainError) {
                throw error;
            }

            const fallbackManifest = implicitMainManifest();
            const fallbackText = stableStringify({
                implicit: true,
                entry: 'main.js',
                mainText,
            });
            if (!force && fallbackText === lastManifestText) return null;
            lastManifestText = fallbackText;
            manifestState = fallbackManifest;
            emitChange();
            return fallbackManifest;
        }
    }

    async function mountLayer(entry, manifest) {
        const layerId = entry.id;
        const entryPath = entry.entryPath;
        const moduleVersion = ++revision;
        const moduleUrl = isAbsolutePath(entryPath)
            ? `${toAssetUrl(entryPath)}?v=${moduleVersion}`
            : projectUrl(projectRootUrl, entryPath, `${moduleVersion}`);

        const moduleNamespace = await import(moduleUrl);
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
        const forceReload = !!options.forceReload;
        manifestState = manifest;
        const desiredLayers = buildManifestLayers(manifest).filter(entry => entry.enabled);
        const desiredIds = new Set(desiredLayers.map(entry => entry.id));

        for (const id of [...activeLayerIds]) {
            if (!desiredIds.has(id)) removeProjectLayer(id);
        }

        for (const entry of desiredLayers) {
            const current = activeProjectLayers.get(entry.id);
            if (!forceReload && current?.signature === entry.signature) continue;

            if (current) removeProjectLayer(entry.id);
            await mountLayer(entry, manifest);
        }

        emitChange();
    }

    async function reload(force = false) {
        if (!projectRootUrl || pollInFlight) return false;
        pollInFlight = true;
        try {
            const manifest = await loadManifest(force);
            if (!manifest) return false;

            await applyManifest(manifest, { forceReload: force });

            if (Number.isFinite(manifest.pollMs) && manifest.pollMs >= 0) {
                pollMs = manifest.pollMs;
                schedulePolling();
            }

            setStatus(`project loaded: ${manifest.name || projectDir}`);
            return true;
        } catch (error) {
            clearProjectLayers();
            manifestState = null;
            lastManifestText = '';
            emitChange();

            const is404 = manifest404(error);
            if (is404) {
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

    async function persistManifest(nextManifest) {
        const text = `${JSON.stringify(nextManifest, null, 2)}\n`;
        await requestHostAction('project_manifest_write', {
            contentBase64: toBase64Utf8(text),
        });

        lastManifestText = text;
        await applyManifest(nextManifest);
        setStatus(`project saved: ${nextManifest.name || projectDir}`);
        return true;
    }

    async function updateManifest(mutator) {
        const manifest = cloneManifest(await ensureManifestLoaded());
        mutator(manifest);
        if (!Array.isArray(manifest.layers)) manifest.layers = [];
        await persistManifest(manifest);
    }

    async function setLayerEnabled(id, enabled) {
        await updateManifest(manifest => {
            const layers = ensureMutableLayers(manifest);
            const entry = layers.find(layer => (layer?.id || layer?.name) === id);
            if (!entry) throw new Error(`Project layer not found: ${id}`);
            entry.enabled = !!enabled;
        });
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
        await requestHostAction('inline_layer_set_enabled', { id, enabled: !!enabled });
        const nextEnabled = !!enabled;
        const current = inlineLayerState.get(id) || { id, name: id };
        inlineLayerState.set(id, {
            ...current,
            enabled: nextEnabled,
        });
        if (!nextEnabled) {
            layerManager.remove(id);
        }
        emitChange();
    }

    async function clearInlineLayers() {
        await requestHostAction('inline_layer_clear');
    }

    function listEntries() {
        const runtimeLayers = new Map(layerManager.list().map(layer => [layer.id, layer]));
        return buildManifestLayers(manifestState ?? defaultManifest()).map(entry => {
            const runtime = runtimeLayers.get(entry.id);
            return {
                id: entry.id,
                name: entry.name,
                entry: entry.entryPath,
                source: 'project',
                persisted: true,
                enabled: entry.enabled,
                active: runtime?.active ?? false,
                loading: runtime?.loading ?? false,
                error: runtime?.error ?? null,
                anchors: runtime?.anchors ?? 0,
                tracked: runtime?.tracked ?? 0,
                profile: runtime?.profile ?? null,
            };
        });
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
        if (Number.isFinite(options.pollMs) && options.pollMs >= 0) {
            pollMs = options.pollMs;
        }

        manifestState = null;
        lastManifestText = '';
        if (projectChanged) clearProjectLayers();
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
        void setProjectDirectory(msg.dir || '', { pollMs: msg.pollMs });
    });

    bridge.on('project_reload', () => {
        void reload(true);
    });

    bridge.on('inline_layers_state', msg => {
        inlineLayerState.clear();
        const layers = Array.isArray(msg?.layers) ? msg.layers : [];
        for (const layer of layers) {
            if (!layer?.id) continue;
            inlineLayerState.set(layer.id, {
                id: layer.id,
                name: layer.name || layer.id,
                enabled: layer.enabled !== false,
            });
        }
        emitChange();
    });

    return {
        subscribe,
        listEntries,
        listInlineEntries,
        setLayerEnabled,
        removeLayer,
        clearPersistedLayers,
        setInlineLayerEnabled,
        removeInlineLayer,
        clearInlineLayers,
        setProjectDirectory,
        reload,
        clear() {
            clearTimer();
            clearProjectLayers();
            manifestState = null;
            lastManifestText = '';
            emitChange();
            setStatus('project runtime cleared');
        },
        getState() {
            return {
                projectDir,
                projectRootUrl,
                pollMs,
                activeLayers: Array.from(activeLayerIds),
                manifest: manifestState,
            };
        },
    };
}
