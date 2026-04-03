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

export function createProjectRuntime({ layerManager, bridge, perfHud }) {
    let projectDir = '';
    let projectRootUrl = '';
    let pollMs = 1200;
    let lastManifestText = '';
    let lastStatus = '';
    let timer = 0;
    let revision = 0;
    let pollInFlight = false;
    const activeLayerIds = new Set();

    function setStatus(message) {
        if (message === lastStatus) return;
        lastStatus = message;
        perfHud?.setStatus?.(`MaxJS - ${message}`);
    }

    function clearTimer() {
        if (!timer) return;
        clearInterval(timer);
        timer = 0;
    }

    function schedulePolling() {
        clearTimer();
        if (!projectRootUrl || pollMs <= 0) return;
        timer = setInterval(() => {
            void reload(false);
        }, pollMs);
    }

    function clearProjectLayers() {
        for (const id of [...activeLayerIds]) {
            layerManager.remove(id);
            activeLayerIds.delete(id);
        }
    }

    async function loadManifest(force = false) {
        if (!projectRootUrl) return null;

        const manifestUrl = projectUrl(projectRootUrl, 'project.maxjs.json', `${Date.now()}`);
        const manifestText = await fetchText(manifestUrl);
        if (!force && manifestText === lastManifestText) return null;

        const manifest = JSON.parse(manifestText);
        lastManifestText = manifestText;
        return manifest;
    }

    async function mountLayer(entry, manifest) {
        const layerId = entry.id || entry.name || `layer_${activeLayerIds.size}`;
        const entryPath = entry.entry || entry.path || 'main.js';
        const moduleUrl = isAbsolutePath(entryPath)
            ? `${toAssetUrl(entryPath)}?v=${revision}`
            : projectUrl(projectRootUrl, entryPath, `${revision}`);

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
    }

    async function reload(force = false) {
        if (!projectRootUrl || pollInFlight) return false;
        pollInFlight = true;
        try {
            const manifest = await loadManifest(force);
            if (!manifest) return false;

            revision += 1;
            clearProjectLayers();

            const layers = Array.isArray(manifest.layers) ? manifest.layers : [
                { id: 'main', name: manifest.name || 'main', entry: manifest.entry || 'main.js', enabled: true },
            ];

            for (const entry of layers) {
                if (entry?.enabled === false) continue;
                await mountLayer(entry, manifest);
            }

            if (Number.isFinite(manifest.pollMs) && manifest.pollMs > 0) {
                pollMs = manifest.pollMs;
                schedulePolling();
            }

            setStatus(`project loaded: ${manifest.name || projectDir}`);
            return true;
        } catch (error) {
            clearProjectLayers();
            const is404 = error?.message?.includes('404');
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

    async function setProjectDirectory(nextDir, options = {}) {
        const normalized = normalizeWindowsPath(nextDir).trim();
        projectDir = normalized;
        projectRootUrl = normalized ? toProjectRootUrl(normalized) : '';
        if (Number.isFinite(options.pollMs) && options.pollMs > 0) {
            pollMs = options.pollMs;
        }
        lastManifestText = '';
        schedulePolling();

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

    return {
        setProjectDirectory,
        reload,
        clear() {
            clearTimer();
            clearProjectLayers();
            lastManifestText = '';
            setStatus('project runtime cleared');
        },
        getState() {
            return {
                projectDir,
                projectRootUrl,
                pollMs,
                activeLayers: Array.from(activeLayerIds),
            };
        },
    };
}
