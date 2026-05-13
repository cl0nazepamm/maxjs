// snapshot_environment.js - standalone snapshot HDRI / authored sky apply.
//
// This owns only data that comes from snapshot.json env. Scene-local sky
// scripts still belong to the layer/inlines path and are not synthesized here.

import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

const FALLBACK_BG = 0x353535;
const HDR_EXTS = new Set(['hdr', 'exr']);

function colorSpaceForEnvironmentTexture(ext) {
    return HDR_EXTS.has(ext) ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
}

function suppressKnownExrMetadataWarnings(loader) {
    if (!loader || loader.userData?.maxjsQuietM44fHeader) return loader;
    const originalParse = typeof loader.parse === 'function' ? loader.parse.bind(loader) : null;
    if (!originalParse) return loader;
    loader.parse = (...args) => {
        const previousWarn = console.warn;
        console.warn = (...warnArgs) => {
            const msg = String(warnArgs?.[0] ?? '');
            if (msg.includes('THREE.EXRLoader: Skipped unknown header attribute type') &&
                msg.includes('m44f')) {
                return;
            }
            previousWarn.apply(console, warnArgs);
        };
        try {
            return originalParse(...args);
        } finally {
            console.warn = previousWarn;
        }
    };
    loader.userData = { ...(loader.userData || {}), maxjsQuietM44fHeader: true };
    return loader;
}

function cloneBackground(background) {
    if (background?.clone) return background.clone();
    return new THREE.Color(FALLBACK_BG);
}

function resolveRootUrl(rootUrl) {
    try {
        return new URL(`${rootUrl || '.'}/`, location.href).href;
    } catch {
        return `${rootUrl || '.'}/`;
    }
}

function resolveUrl(url, rootUrl) {
    if (!url) return '';
    try {
        return new URL(url, resolveRootUrl(rootUrl)).href;
    } catch {
        return url;
    }
}

function getExtension(source) {
    try {
        const url = new URL(String(source || ''), location.href);
        return (url.pathname.split('.').pop() || '').toLowerCase();
    } catch {
        const clean = String(source || '').split(/[?#]/, 1)[0];
        return (clean.split('.').pop() || '').toLowerCase();
    }
}

function loadTexture(loader, url) {
    return new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
    });
}

function createPMREMGenerator(renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader?.();
    return pmrem;
}

function retainPMREMTexture(renderTarget) {
    const texture = renderTarget?.texture ?? null;
    if (!texture) {
        renderTarget?.dispose?.();
        return null;
    }
    texture.userData ??= {};
    if (!texture.userData.maxjsPMREMDisposeWrapped) {
        let disposed = false;
        const originalDispose = texture.dispose?.bind(texture);
        texture.dispose = () => {
            if (disposed) return;
            disposed = true;
            const target = texture.userData?.maxjsPMREMRenderTarget;
            if (target) target.dispose?.();
            else originalDispose?.();
            if (texture.userData) {
                delete texture.userData.maxjsPMREMRenderTarget;
                delete texture.userData.maxjsPMREMDisposeWrapped;
            }
        };
        texture.userData.maxjsPMREMDisposeWrapped = true;
    }
    texture.userData.maxjsPMREMRenderTarget = renderTarget;
    return texture;
}

function normalizeEnv(env, snapshotUi) {
    const hasSky = !!env?.sky;
    const hasHdri = typeof env?.hdri === 'string' && env.hdri.length > 0;
    const type = env?.type || (hasSky ? 'sky' : (hasHdri ? 'hdri' : 'none'));
    const enabled = env?.enabled !== false && (type === 'sky' || type === 'hdri');
    const backgroundVisible = typeof snapshotUi?.envVisible === 'boolean'
        ? snapshotUi.envVisible
        : (typeof env?.showBg === 'boolean' ? env.showBg : true);

    return {
        raw: env || null,
        type,
        enabled,
        backgroundVisible,
        source: hasHdri ? env.hdri : null,
    };
}

export function createSnapshotEnvironment({ scene, renderer, rootUrl = '.' } = {}) {
    if (!scene) throw new Error('createSnapshotEnvironment: scene is required');
    if (!renderer) throw new Error('createSnapshotEnvironment: renderer is required');

    const textureLoader = new THREE.TextureLoader();
    const hdrLoader = new HDRLoader();
    const exrLoader = new EXRLoader();
    suppressKnownExrMetadataWarnings(exrLoader);
    textureLoader.setCrossOrigin?.('anonymous');
    hdrLoader.setCrossOrigin?.('anonymous');
    exrLoader.setCrossOrigin?.('anonymous');

    const pmremGenerator = createPMREMGenerator(renderer);
    let fallbackBackground = cloneBackground(scene.background);
    let skyController = null;
    let envMap = null;
    let lastSignature = '';
    let lastHdriRaw = null;
    let current = {
        type: 'none',
        enabled: false,
        backgroundVisible: false,
        source: null,
        active: false,
        error: null,
    };

    function getState() {
        return { ...current };
    }

    function restoreBackground() {
        scene.background = cloneBackground(fallbackBackground);
        if ('backgroundBlurriness' in scene) scene.backgroundBlurriness = 0;
        if ('backgroundIntensity' in scene) scene.backgroundIntensity = 1;
    }

    function resetSceneEnvironment() {
        scene.environment = null;
        if (scene.environmentRotation?.set) scene.environmentRotation.set(0, 0, 0);
        if (scene.backgroundRotation?.set) scene.backgroundRotation.set(0, 0, 0);
        if ('environmentIntensity' in scene) scene.environmentIntensity = 1;
        restoreBackground();
    }

    function disposeEnvMap() {
        const old = envMap;
        envMap = null;
        if (scene.environment === old) scene.environment = null;
        if (scene.background === old) restoreBackground();
        old?.dispose?.();
    }

    function disposeSky() {
        try { skyController?.dispose?.(); } catch {}
        skyController = null;
    }

    function setRotations(degrees, flip) {
        const rot = (Number.isFinite(degrees) ? degrees : 0) * Math.PI / 180;
        const y = -rot + (flip ? Math.PI : 0);
        scene.environmentRotation?.set?.(0, y, 0);
        scene.backgroundRotation?.set?.(0, y, 0);
    }

    function applyHdriState(params) {
        lastHdriRaw = params.raw || lastHdriRaw || { rot: 0, exp: 0, gamma: 1, flip: 0 };
        if (params.enabled && envMap) {
            scene.environment = envMap;
            if ('environmentIntensity' in scene) scene.environmentIntensity = 1;
            setRotations(Number(lastHdriRaw?.rot) || 0, !!lastHdriRaw?.flip);
            renderer.toneMappingExposure =
                Math.pow(2, Number(lastHdriRaw?.exp) || 0) * (Number(lastHdriRaw?.gamma) || 1);
            if (params.backgroundVisible) {
                scene.background = envMap;
                if ('backgroundIntensity' in scene) scene.backgroundIntensity = 1;
                if ('backgroundBlurriness' in scene) {
                    scene.backgroundBlurriness = Number(lastHdriRaw?.blur) || 0;
                }
            } else {
                restoreBackground();
            }
        } else {
            resetSceneEnvironment();
        }

        current = {
            type: 'hdri',
            enabled: !!params.enabled,
            backgroundVisible: !!params.backgroundVisible,
            source: params.source,
            active: !!params.enabled && !!envMap,
            error: null,
        };
        return getState();
    }

    async function applyHdri(params) {
        const url = resolveUrl(params.source, rootUrl);
        const ext = getExtension(url);
        const signature = JSON.stringify(['hdri', url, params.raw?.rot || 0, params.raw?.exp || 0,
            params.raw?.gamma || 1, params.raw?.flip || 0, params.backgroundVisible]);

        disposeSky();
        if (lastSignature === signature && envMap) {
            return applyHdriState({ ...params, source: url });
        }
        lastSignature = signature;
        disposeEnvMap();

        const loader = ext === 'exr' ? exrLoader : (ext === 'hdr' ? hdrLoader : textureLoader);
        const texture = await loadTexture(loader, url);
        texture.colorSpace = colorSpaceForEnvironmentTexture(ext);
        texture.mapping = THREE.EquirectangularReflectionMapping;

        const target = pmremGenerator.fromEquirectangular(texture);
        envMap = retainPMREMTexture(target);
        texture.dispose?.();

        if (!envMap) throw new Error(`PMREM failed for ${url}`);
        return applyHdriState({ ...params, source: url });
    }

    async function applySky(params) {
        disposeEnvMap();
        const signature = JSON.stringify(['sky', params.raw?.sky, params.enabled, params.backgroundVisible]);
        if (!skyController || lastSignature !== signature) {
            lastSignature = signature;
            const mod = await import('./scene_sky.js');
            skyController ??= mod.createSky({ scene, renderer });
            skyController.apply(params.raw.sky);
        }
        skyController.setVisible?.(params.enabled);
        current = {
            type: 'sky',
            enabled: !!params.enabled,
            backgroundVisible: !!params.enabled,
            source: null,
            active: !!params.enabled,
            error: null,
        };
        return getState();
    }

    async function apply(env, snapshotUi = null) {
        fallbackBackground = cloneBackground(scene.background);
        const params = normalizeEnv(env, snapshotUi);

        try {
            if (params.type === 'sky' && params.raw?.sky) {
                return await applySky(params);
            }
            if (params.type === 'hdri' && params.source) {
                return await applyHdri(params);
            }
        } catch (error) {
            console.error('[snapshot_environment] apply failed:', error);
            disposeSky();
            disposeEnvMap();
            resetSceneEnvironment();
            current = {
                type: params.type,
                enabled: false,
                backgroundVisible: false,
                source: params.source,
                active: false,
                error: error?.message || String(error),
            };
            return getState();
        }

        lastSignature = JSON.stringify(['none', params.raw?.type || 'none']);
        disposeSky();
        disposeEnvMap();
        resetSceneEnvironment();
        current = {
            type: 'none',
            enabled: false,
            backgroundVisible: false,
            source: null,
            active: false,
            error: null,
        };
        return getState();
    }

    function setEnabled(enabled) {
        const next = !!enabled;
        current.enabled = next;
        if (current.type === 'sky') {
            skyController?.setVisible?.(next);
            current.active = next;
        } else if (current.type === 'hdri') {
            applyHdriState({
                raw: lastHdriRaw,
                enabled: next,
                backgroundVisible: current.backgroundVisible,
                source: current.source,
            });
        } else if (!next) {
            resetSceneEnvironment();
        }
        return getState();
    }

    function setBackgroundVisible(visible) {
        current.backgroundVisible = !!visible;
        if (current.type === 'hdri') {
            if (current.enabled && envMap && current.backgroundVisible) {
                scene.background = envMap;
            } else {
                restoreBackground();
            }
        }
        return getState();
    }

    function dispose() {
        disposeSky();
        disposeEnvMap();
        try { pmremGenerator.dispose?.(); } catch {}
    }

    function update(dt, elapsed, camera) {
        skyController?.update?.(dt, elapsed, camera);
    }

    return {
        apply,
        update,
        setEnabled,
        setVisible: setEnabled,
        setBackgroundVisible,
        getState,
        isLightingActive: () => !!current.active,
        dispose,
    };
}
