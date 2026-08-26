// snapshot_boot.js — handwritten standalone snapshot bootstrapper.
//
// Stage 5 deliverable from docs/SNAPSHOT_REFACTOR.md.
//
// This module is the canonical entry point for *deployed* snapshot pages.
// Live mode (inside Max via WebView2) still goes through index.html.
// Both share the same `js/*` runtime modules; the only thing this file
// replaces is the 575 KB editor-hosted boot orchestration in index.html.
//
// CONTRACT
// --------
//   const player = await boot({ root, canvas, options? });
//
//   root      string  — folder containing snapshot.json + scene.m3 (e.g. '.')
//   canvas    HTMLCanvasElement — render target
//   options   object  — { rendererBackend?: 'webgpu' | 'tsl_gl' | 'webgl', debug?: boolean }
//
//   Returns: {
//     renderer, scene, camera, controls, layerManager,
//     applyDelta(buffer),     // re-apply binary buffer (live-mode parity hook)
//     dispose(),              // tear down renderer + DOM + animation loop
//   }
//
// PHASES (1:1 with SNAPSHOT_REFACTOR.md)
//   1. Fetch metadata
//   2. Pick backend, instantiate renderer
//   3. Core scene/camera/controls
//   4. Layer manager core
//   5. Conditional module registration (driven by runtimeFeatures)
//   6. Apply scene.m3 (legacy scene.bin is still accepted)
//   7. Apply snapshotUi block (tone mapping, exposure, env, fog, postfx/studio state)
//   8. Apply runtimeScene block (baked Object3D JSON)
//   9. Bind layer project (inlines/ + project.maxjs.json)
//  10. Run (setAnimationLoop)
//
// STAGE 5 STATUS (this file)
// --------------------------
// Real code:    1 (meta), 2 (renderer), 3 (scene/camera/controls),
//               4 (layer manager), 6 (applier with simple-PBR materials
//               via material_builder.js), 7 partial (tone-map/exposure/
//               bg/camera + scene lights + portable Studio state), 8 (baked
//               runtime scene fallback), 9 (layer project bind + dedupe),
//               10 (render loop), animation + timeline.
// Deferred:     5 (HTML textures / volumes / physics warn and continue),
//               7 deeper live editor panels / bake UI (warns),
//               and standalone fog replay.
//
// What WORKS today: snapshots with Max-authored meshes render with PBR
// materials — color, roughness, metalness, opacity, emissive, plus the
// six common map slots (diffuse / normal / roughness / metalness / AO /
// emissive). Multi/sub-object materials honor their groups. Lights from
// snapshot.json drive shading; shadows render for shadow-casters.
// Skinned meshes assemble (Skeleton + bind pose). Animations tick.
//
// Remaining gaps are live-host-only editor/event surfaces and the explicitly
// deferred optional modules above. Backend-incompatible material models still
// degrade to portable Three.js materials by design.

import * as THREE from 'three';

import { createLayerManager } from './layer_manager.js';
import { createMaxJSAnimationSystem } from './maxjs_animation.js?v=20260514-loop1';
import { maxTimeline } from './maxjs_timeline.js';
import {
    createRenderer as createRendererImpl,
    createScene as createSceneImpl,
    measureCanvasSize,
} from './scene_init.js';
import { applySceneBin } from './scene_applier.js';
import { createInstanceBuckets } from './instance_buckets.js';
import {
    createSceneLights,
    isIrEmitterClass,
    resolveLightEmitterClass,
} from './scene_lights.js';
import { createSnapshotEnvironment } from './snapshot_environment.js';
import { createMaterialBuilder } from './material_builder.js';
import { assignGatedMaterialScalar, isProgramGatedMaterialScalar } from './material_contract.js';
import { copyMaxArrayToWorld, copyMaxComponentsToWorld } from './max_basis.js';
import { binInRange, geometryFromNodeBinary, typedArrayCanStore } from './scene_binary.js';
import { sceneSpace } from './max_basis.js';
// Optional modules — imported lazily inside Phase 5 once runtimeFeatures
// declare them. Keep them out of the static import graph so Minimal mode
// does not pay for what the scene does not use.
//   import { createMaxJSAudioSystem } from './maxjs_audio.js';
//   import { createGltfRegistry }     from './maxjs_gltf.js';
//   import { createHtmlTextureSlot }  from './html_texture.js';
//   import { createMaxJSFxController } from './maxjs_fx.js';
//   import { VolumeRenderer }         from './VolumeRenderer.js';
//   import { createProjectRuntime }   from './project_runtime.js';

// ─── Stub helpers ──────────────────────────────────────────────────────
// `requireExtraction` is reserved for paths that genuinely cannot proceed
// without the extraction landing (e.g. trying to apply a non-empty
// scene.m3 without the applier). `noteExtractionDeferred` is the
// debug-and-continue variant used by phases where skipping is acceptable
// for the empty/minimal snapshot path that Stage 2 supports.
function requireExtraction(name, sourceLocation) {
    const message =
        `[snapshot_boot] '${name}' not yet extracted from index.html ` +
        `(${sourceLocation}). See docs/SNAPSHOT_REFACTOR.md → Implementation order.`;
    throw new Error(message);
}

function noteExtractionDeferred(name, sourceLocation, detail = '') {
    const tail = detail ? ` ${detail}` : '';
    console.debug(
        `[snapshot_boot] '${name}' not yet extracted from index.html ` +
        `(${sourceLocation}); skipping in Stage 2.${tail}`,
    );
}

export const DEFAULT_M3_PAYLOAD = 'scene.m3';
export const LEGACY_SCENE_BIN_PAYLOAD = 'scene.bin';
export const M3_FORMAT_VERSION = 1;
export const M3_SCHEMA_VERSION = 1;

export function validateM3Metadata(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        throw new TypeError('snapshot.json must contain an object');
    }
    if (meta.format != null && String(meta.format).toLowerCase() !== 'm3') {
        throw new Error(`Unsupported scene format: ${meta.format}`);
    }
    if (meta.formatVersion != null && meta.formatVersion !== M3_FORMAT_VERSION) {
        throw new Error(`Unsupported M3 format version: ${meta.formatVersion}`);
    }
    if (meta.schemaVersion != null && meta.schemaVersion !== M3_SCHEMA_VERSION) {
        throw new Error(`Unsupported M3 schema version: ${meta.schemaVersion}`);
    }
    if (meta.units != null) {
        const units = meta.units;
        if (!units || typeof units !== 'object' || Array.isArray(units) ||
            typeof units.label !== 'string' || !units.label.trim() ||
            !Number.isFinite(units.metersPerUnit) || units.metersPerUnit <= 0) {
            throw new Error('Invalid M3 units descriptor');
        }
    }
    return meta;
}

export function validateSnapshotScenePayloadName(value) {
    if (typeof value !== 'string') {
        throw new TypeError('M3 scene payload name must be a string');
    }
    const name = value.trim();
    if (!name || name !== value || name.startsWith('/') || name.includes('\\') ||
        name.includes('?') || name.includes('#') || /^[a-z][a-z0-9+.-]*:/i.test(name)) {
        throw new Error('M3 scene payload name must be a clean relative URL path');
    }
    const segments = name.split('/');
    for (const encodedSegment of segments) {
        let segment;
        try {
            segment = decodeURIComponent(encodedSegment);
        } catch {
            throw new Error('M3 scene payload name contains invalid URL encoding');
        }
        if (!segment || segment === '.' || segment === '..' ||
            segment.includes('/') || segment.includes('\\') ||
            segment.includes('\0') || segment.includes('?') || segment.includes('#')) {
            throw new Error('M3 scene payload name contains an unsafe path segment');
        }
    }
    return name;
}

export function snapshotScenePayloadCandidates(meta = {}) {
    if (meta?.bin == null) return [DEFAULT_M3_PAYLOAD, LEGACY_SCENE_BIN_PAYLOAD];
    const declared = validateSnapshotScenePayloadName(meta.bin);
    if (declared.toLowerCase() === DEFAULT_M3_PAYLOAD) {
        return [declared, LEGACY_SCENE_BIN_PAYLOAD];
    }
    return [declared];
}

export async function fetchSnapshotScenePayload(root, meta, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Snapshot scene loader requires fetch()');
    const rootUrl = String(root || '.').replace(/\/+$/, '');
    const candidates = snapshotScenePayloadCandidates(meta);
    for (let i = 0; i < candidates.length; i++) {
        const name = candidates[i];
        const url = `${rootUrl}/${name.replace(/^\/+/, '')}`;
        const response = await fetchImpl(url, { cache: 'no-cache' });
        if (response.ok) {
            return { buffer: await response.arrayBuffer(), name, url };
        }
        const canTryLegacy = i + 1 < candidates.length && response.status === 404;
        if (!canTryLegacy) {
            throw new Error(`M3 scene payload fetch failed (${name}): HTTP ${response.status}`);
        }
    }
    throw new Error('M3 scene payload fetch failed');
}

// ─── Default features — used when runtimeFeatures block is absent ──────
// Matches the old "load everything" behavior so existing snapshots that
// predate runtimeFeatures keep working. The exporter will populate this
// block in a later session and the wrapper will tighten its imports.
//
// Standalone snapshots are deployed as WebGL-first pages. Do not inherit
// the live editor's backend here: a WebGPU panel inside Max and a public
// WebGL snapshot are separate targets with different browser coverage and
// material/texture behavior.
function detectFeaturesLegacy(meta) {
    return Object.freeze({
        renderer_pref: 'webgl',
        post_fx: ['ssgi'], // index.html wires MaxJS FX today
        audio: true,
        html_textures: true,
        volumes: true,
        physics: true,
        three_addons: ['OrbitControls'],
        environment: true,
    });
}

function normalizeRuntimeFeatures(meta) {
    const raw = meta?.runtimeFeatures && typeof meta.runtimeFeatures === 'object'
        ? meta.runtimeFeatures
        : detectFeaturesLegacy(meta);
    const rendererPref = normalizeRendererBackend(
        raw.renderer_pref
        ?? raw.rendererPref
        ?? raw.rendererBackend
        ?? raw.backend
        ?? 'webgl',
    );
    const arrayOrEmpty = (value) => Array.isArray(value) ? value.slice() : [];

    return Object.freeze({
        ...raw,
        renderer_pref: rendererPref,
        post_fx: arrayOrEmpty(raw.post_fx),
        three_addons: arrayOrEmpty(raw.three_addons),
        audio: !!raw.audio,
        html_textures: !!(raw.html_textures ?? raw.htmlTextures),
        volumes: !!raw.volumes,
        physics: !!raw.physics,
        gltf: !!(raw.gltf ?? raw.gltfs),
        animations: !!raw.animations,
        environment: !!(raw.environment ?? raw.hdri ?? raw.sky),
        binary_instances: !!(raw.binary_instances ?? raw.binaryInstances),
        exports: raw.exports && typeof raw.exports === 'object' ? raw.exports : {},
        counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : {},
    });
}

function normalizeRendererBackend(value) {
    const raw = String(value || '').toLowerCase();
    if (raw.includes('webgpu')) return 'webgpu';
    if (raw.includes('tsl')) return 'tsl_gl';
    return 'webgl';
}

function resolveSnapshotAssetUrl(root, url) {
    if (typeof url !== 'string' || url.length === 0) return '';
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return url;
    if (url.startsWith('/')) return url;

    const rootText = String(root || '.');
    const base = new URL(rootText.endsWith('/') ? rootText : `${rootText}/`, window.location.href);
    return new URL(url, base).href;
}

function resolveSnapshotAudioUrls(audioData, root) {
    if (!Array.isArray(audioData) || audioData.length === 0) return [];
    return audioData.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        return {
            ...entry,
            url: resolveSnapshotAssetUrl(root, entry.url),
        };
    });
}

function resolveSnapshotGltfUrls(gltfData, root) {
    if (!Array.isArray(gltfData) || gltfData.length === 0) return [];
    return gltfData.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        return {
            ...entry,
            url: resolveSnapshotAssetUrl(root, entry.url),
        };
    });
}

function isKnownWebglPrecisionProgramLog(value) {
    const lines = String(value || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    return lines.length > 0 && lines.every(line =>
        line.includes('warning X4122:') &&
        line.toLowerCase().includes('double precision'));
}

function installThreeConsoleFilter({ debug = false } = {}) {
    if (debug ||
        typeof THREE.setConsoleFunction !== 'function' ||
        typeof THREE.getConsoleFunction !== 'function') {
        return () => {};
    }

    const previous = THREE.getConsoleFunction();
    const filter = (type, message, ...params) => {
        const detail = params
            .map(value => String(value ?? ''))
            .join('\n')
            .replace(/\u0000/g, '')
            .trim();
        if (type === 'warn' &&
            message === 'THREE.WebGLProgram: Program Info Log:' &&
            isKnownWebglPrecisionProgramLog(detail)) {
            return;
        }

        if (typeof previous === 'function') {
            previous(type, message, ...params);
            return;
        }

        const fn = console[type] || console.log;
        fn.call(console, message, ...params);
    };

    THREE.setConsoleFunction(filter);
    return () => {
        if (THREE.getConsoleFunction() === filter) {
            THREE.setConsoleFunction(previous);
        }
    };
}

function countVisibleLightPayload(lightsData) {
    if (!Array.isArray(lightsData)) return 0;
    return lightsData.reduce((count, light) => {
        if (!light || light.type < 0 || light.type > 5) return count;
        return light.v === false || light.v === 0 ? count : count + 1;
    }, 0);
}

function findSnapshotSkySunDirection(lightsData) {
    const directional = (Array.isArray(lightsData) ? lightsData : [])
        .filter(light => light?.type === 0 && light.v !== false && light.v !== 0 && Array.isArray(light.dir));
    if (!directional.length) return null;
    const named = directional.find((light) => {
        const name = String(light.name || '').toLowerCase();
        return /\b(sun|sunlight|solar|daylight)\b/.test(name)
            || name.includes('sun')
            || name.includes('solar')
            || name.includes('daylight');
    });
    const light = named || (directional.length === 1 ? directional[0] : null);
    if (!light) return null;
    const dir = light.dir;
    const world = copyMaxComponentsToWorld(
        new THREE.Vector3(),
        -Number(dir[0]),
        -Number(dir[1]),
        -Number(dir[2]),
    );
    return world.lengthSq() > 1.0e-8 ? world.normalize().toArray() : null;
}

function withSnapshotLinkedSkySun(env, lightsData) {
    if (!env?.sky) return env;
    const sunDirectionWorld = findSnapshotSkySunDirection(lightsData);
    if (!sunDirectionWorld) return env;
    return {
        ...env,
        sky: {
            ...env.sky,
            sunDirectionWorld,
            sunLinkedLight: true,
        },
    };
}

// ─── Phase 1: metadata ─────────────────────────────────────────────────
async function loadMeta(root) {
    const response = await fetch(`${root}/snapshot.json`, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`snapshot.json fetch failed: HTTP ${response.status}`);
    }
    const meta = validateM3Metadata(await response.json());
    resolveSnapshotMaterialRefs(meta);
    return meta;
}

// snapshot.json represents materials as an interned table:
//   meta.materials = [{ id: 1, hash: ..., mat: { ... } }, ...]
//   meta.nodes[i].matRef = 1                      // single material
//   meta.nodes[i].matRefs = [1, 2, 3]             // multi/sub-object
//
// The applier and material_builder both read `nd.mat` / `nd.mats`. Walk
// the table once on load and inline the descriptors. Live mode does the
// same in `resolveSnapshotMaterialRefs` (index.html) before applying.
function resolveSnapshotMaterialRefs(meta) {
    if (!meta?.nodes?.length) return;
    const byId = new Map();
    for (const entry of (meta.materials ?? [])) {
        if (entry?.id != null && entry.mat) byId.set(entry.id, entry.mat);
    }
    if (byId.size === 0) return;
    for (const nd of meta.nodes) {
        if (!nd) continue;
        if (nd.matRef != null && !nd.mat) {
            const md = byId.get(nd.matRef);
            if (md) nd.mat = md;
        }
        const matRefs = Array.isArray(nd.matRefs) ? nd.matRefs : nd.matsRef;
        if (Array.isArray(matRefs) && (!nd.mats || nd.mats.length === 0)) {
            nd.mats = matRefs.map((id) => byId.get(id)).filter(Boolean);
        }
    }
}

function valueReferencesTslTextures(value, seen = new Set()) {
    if (typeof value === 'string') return /\bTEXTURES\b/.test(value);
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
        return value.some((entry) => valueReferencesTslTextures(entry, seen));
    }
    return Object.values(value).some((entry) => valueReferencesTslTextures(entry, seen));
}

function snapshotNeedsTslTextures(meta) {
    for (const entry of (meta?.materials ?? [])) {
        if (valueReferencesTslTextures(entry?.mat)) return true;
    }
    for (const nd of (meta?.nodes ?? [])) {
        if (valueReferencesTslTextures(nd?.mat)) return true;
        if (valueReferencesTslTextures(nd?.mats)) return true;
    }
    for (const group of (meta?.forestInstances ?? [])) {
        if (valueReferencesTslTextures(group?.mat)) return true;
        if (valueReferencesTslTextures(group?.mats)) return true;
    }
    return false;
}

// ─── Phase 2: renderer ─────────────────────────────────────────────────
// WebGL2 snapshot renderer. WebGPU is a separate explicit target, not a
// transparent fallback, because backend switching changes material behavior.
// Canvas DPR ceiling, derived from the snapshot's own quality dials. PowerShot's
// resolutionScale is the authored undersample (analog/digital ISP) — when it is
// meaningfully below 1 the frame's detail ceiling sits well under canvas
// resolution, so a high-DPR canvas only multiplies work the ISP throws away.
function computePixelRatioCap(snapshotUi) {
    const ps = snapshotUi?.fx?.powershot;
    const psScale = Number(ps?.resolutionScale);
    const undersampling = ps?.enabled === true
        && Number.isFinite(psScale) && psScale <= 0.85;
    if (undersampling) return 1;
    const coarse = typeof matchMedia === 'function'
        && matchMedia('(pointer: coarse)').matches;
    return coarse ? 1.5 : 2;
}

async function createRenderer(canvas, features, snapshotUi) {
    const backend = normalizeRendererBackend(features?.renderer_pref);
    const { renderer, backendLabel } = await createRendererImpl(canvas, {
        backend,
        pixelRatioCap: computePixelRatioCap(snapshotUi),
    });
    renderer.userData ??= {};
    renderer.userData.maxjsBackendLabel = backendLabel;
    return renderer;
}

function snapshotHasIrEmitters(lights) {
    return Array.isArray(lights)
        && lights.some(light => isIrEmitterClass(resolveLightEmitterClass(light)));
}

async function installSnapshotIrLightGraph(renderer, lights) {
    if (!snapshotHasIrEmitters(lights)) return false;
    if (!renderer?.lighting?.createNode) {
        console.warn('[snapshot_boot] IR lights require the WebGPU/TSL lighting graph');
        return false;
    }
    try {
        const { installMaxLightsRenderer } = await import('./max_lights_node.js');
        const installed = installMaxLightsRenderer(renderer);
        if (!installed) {
            console.warn('[snapshot_boot] failed to install the IR-aware max.js lighting graph');
        }
        return installed;
    } catch (error) {
        console.warn('[snapshot_boot] IR-aware lighting graph unavailable', error);
        return false;
    }
}

// ─── Phase 3: scene + camera + controls ────────────────────────────────
// Lives in js/scene_init.js. Returns the canonical scene topology
// (scene + maxBasisRoot/maxRoot/jsRoot/overlayRoot), a perspective camera,
// OrbitControls (interactive by default in snapshot mode), and a default
// lights group hidden until the applier decides whether to use it.
function createScene({ meta, renderer, canvas } = {}) {
    return createSceneImpl({ renderer, canvas });
}

// ─── Phase 4: layer manager core ──────────────────────────────────────
// Already in js/layer_manager.js. The wiring requires inputs from phase 3.
function buildLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap,
    lightHandleMap,
    maxRoot,
    jsRoot,
    overlayRoot,
    controls,
    sceneCameras = [],
    onCameraModeChange = null,
    getAnimationSystem = () => null,
    getAudioSystem = () => null,
    getGLTFSystem = () => null,
    onRuntimeSceneChanged = null,
}) {
    return createLayerManager({
        scene,
        camera,
        renderer,
        THREE,
        nodeMap,
        lightHandleMap,
        maxRoot,
        jsRoot,
        overlayRoot,
        space: sceneSpace,
        controls,
        getCamera: () => camera,
        getCameraTarget: (target) => {
            if (controls?.target?.isVector3) return target?.copy(controls.target) ?? controls.target.clone();
            return null;
        },
        getSceneCameras: () => sceneCameras,
        onCameraModeChange,
        getAnimationSystem,
        getAudioSystem,
        getGLTFSystem,
        isSnapshot: true,
        debugLog: (...args) => console.debug('[snapshot_boot]', ...args),
        debugWarn: (...args) => console.warn('[snapshot_boot]', ...args),
        onRuntimeSceneChanged,
    });
}

// ─── Phase 5: conditional module registration ─────────────────────────
// Lazy-imports each optional module only when runtimeFeatures asks for it.
// post_fx is wired: a WebGPU snapshot with enabled effects dynamic-imports
// snapshot_fx.js, which in turn imports ONLY the enabled fx/effects/*
// descriptors (raw ESM — the import graph is the bundle). WebGL snapshots
// import zero post-FX code. The remaining subsystems are still skipped with
// a deferred-extraction note until their init/dispose lifecycle is
// documented and stubs in index.html are replaced with the same lazy
// imports.
async function registerOptionalModules(features, ctx) {
    const wanted = [];
    if (features.html_textures)    wanted.push('html_textures');
    if (features.volumes)          wanted.push('volumes');
    if (features.physics)          wanted.push('physics');
    if (wanted.length) {
        noteExtractionDeferred(
            'registerOptionalModules',
            'index.html — MaxJS FX / audio / html_texture / volume init',
            `(scene declares: ${wanted.join(', ')})`,
        );
    }

    const modules = {};

    // Post-FX replay needs the TSL node pipeline. Native WebGPU and TSL_GL
    // share it; snapshot.html / simple WebGL stays post-FX free by design.
    if (features.renderer_pref !== 'webgl' && features.post_fx?.length) {
        try {
            const { createSnapshotFx } = await import('./snapshot_fx.js');
            modules.maxjsFx = await createSnapshotFx({
                renderer: ctx.renderer,
                scene: ctx.scene,
                camera: ctx.camera,
                postFx: features.post_fx,
                backendLabel: ctx.renderer?.userData?.maxjsBackendLabel || '',
            });
        } catch (error) {
            console.warn('[snapshot_boot] post-FX module init failed', error);
        }
    }

    const hasAudioPayload = Array.isArray(ctx?.meta?.audios) && ctx.meta.audios.length > 0;
    if (features.audio || hasAudioPayload) {
        try {
            const { createMaxJSAudioSystem } = await import('./maxjs_audio.js');
            modules.audio = createMaxJSAudioSystem({
                THREE,
                parent: ctx.maxBasisRoot ?? ctx.scene,
                initialMuted: ctx.initialAudioMuted === true,
                getActiveCamera: () => ctx.renderer?.xr?.isPresenting
                    ? ctx.renderer.xr.getCamera(ctx.camera)
                    : ctx.camera,
            });
        } catch (error) {
            console.warn('[snapshot_boot] audio module init failed', error);
        }
    }

    const hasGltfPayload = Array.isArray(ctx?.meta?.gltfs) && ctx.meta.gltfs.length > 0;
    if (features.gltf || hasGltfPayload) {
        try {
            const { createMaxJSGLTFSystem } = await import('./maxjs_gltf.js');
            modules.gltf = createMaxJSGLTFSystem({
                THREE,
                parent: ctx.maxBasisRoot ?? ctx.scene,
                getBus: () => ctx.layerManager?.getBus?.(),
                debugWarn: (...args) => console.warn('[snapshot_boot]', ...args),
            });
        } catch (error) {
            console.warn('[snapshot_boot] glTF module init failed', error);
        }
    }

    return modules;
}

const SNAPSHOT_SPEEDBALL_GI_DEFAULTS = Object.freeze({
    enabled: false,
    intensity: 10,
    divisions: 16,
    rays: 64,
    cascades: 1,
    continuous: true,
    hysteresis: 0.9,
    hysteresisNormalize: true,
    normalBias: 1.75,
    radianceClamp: 8,
    depthSharpness: 40,
    cheby: 0.5,
    classify: 0,
    filter: 1,
    smoothness: 1,
    detail: 1,
    roughReflections: false,
    reflectionIntensity: 1.0,
    changeThreshold: 2.5,
    snapAmount: 0.30,
    fireflyClamp: 6.0,
    volumes: [],
});

function numOrFallback(value, fallback, min = -Infinity, max = Infinity) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizeSnapshotSpeedballGiState(snapshotUi) {
    const source = snapshotUi?.speedballGi;
    if (!source || typeof source !== 'object') return null;
    return {
        enabled: source.enabled === true,
        intensity: numOrFallback(source.intensity, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.intensity, 0, 32),
        divisions: Math.round(numOrFallback(source.divisions, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.divisions, 2, 32)),
        rays: Math.round(numOrFallback(source.rays, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.rays, 32, 256) / 16) * 16,
        cascades: Math.round(Number(source.cascades)) === 2 ? 2 : 1,
        continuous: source.continuous !== false,
        hysteresis: numOrFallback(source.hysteresis, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.hysteresis, 0, 0.99),
        // Absent in pre-normalization exports — default ON to match the field.
        hysteresisNormalize: source.hysteresisNormalize !== false,
        normalBias: numOrFallback(source.normalBias, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.normalBias, 0, 8),
        radianceClamp: numOrFallback(source.radianceClamp, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.radianceClamp, 0, 64),
        depthSharpness: numOrFallback(source.depthSharpness, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.depthSharpness, 1, 200),
        cheby: numOrFallback(source.cheby, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.cheby, 0, 1),
        classify: numOrFallback(source.classify, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.classify, 0, 1),
        filter: numOrFallback(source.filter, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.filter, 0, 1),
        smoothness: numOrFallback(source.smoothness, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.smoothness, 0, 1),
        detail: numOrFallback(source.detail, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.detail, 0, 1),
        roughReflections: source.roughReflections === true,
        reflectionIntensity: numOrFallback(source.reflectionIntensity, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.reflectionIntensity, 0, 1),
        changeThreshold: numOrFallback(source.changeThreshold, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.changeThreshold, 0.5, 8),
        snapAmount: numOrFallback(source.snapAmount, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.snapAmount, 0, 0.9),
        fireflyClamp: numOrFallback(source.fireflyClamp, SNAPSHOT_SPEEDBALL_GI_DEFAULTS.fireflyClamp, 1, 20),
        volumes: Array.isArray(source.volumes) ? source.volumes : [],
    };
}

function snapshotSpeedballVolumeBoxes(volumes) {
    const out = [];
    for (const entry of Array.isArray(volumes) ? volumes : []) {
        if (!entry || !Array.isArray(entry.min) || !Array.isArray(entry.max)) continue;
        const min = new THREE.Vector3(
            Number(entry.min[0]), Number(entry.min[1]), Number(entry.min[2]),
        );
        const max = new THREE.Vector3(
            Number(entry.max[0]), Number(entry.max[1]), Number(entry.max[2]),
        );
        if (!Number.isFinite(min.x) || !Number.isFinite(min.y) || !Number.isFinite(min.z)
            || !Number.isFinite(max.x) || !Number.isFinite(max.y) || !Number.isFinite(max.z)) {
            continue;
        }
        const box = new THREE.Box3(min, max);
        if (box.isEmpty()) continue;
        if (Array.isArray(entry.res) && entry.res.length >= 3) {
            const res = new THREE.Vector3(
                Math.round(Number(entry.res[0])),
                Math.round(Number(entry.res[1])),
                Math.round(Number(entry.res[2])),
            );
            if (Number.isFinite(res.x) && Number.isFinite(res.y) && Number.isFinite(res.z)) {
                out.push({ box, res });
                continue;
            }
        }
        out.push(box);
    }
    return out;
}

function markSnapshotSpeedballGiMaterialsDirty(scene) {
    const seen = new WeakSet();
    const mark = (material) => {
        if (!material || seen.has(material)) return;
        seen.add(material);
        if (material.isMeshBasicMaterial || material.isLineBasicMaterial || material.isLineDashedMaterial) return;
        material.dispose?.();
        material.needsUpdate = true;
    };
    scene.traverse((object) => {
        const material = object?.material;
        if (!material) return;
        if (Array.isArray(material)) material.forEach(mark);
        else mark(material);
    });
}

function applySnapshotSpeedballGiSettings(field, settings) {
    field.setIntensity?.(settings.intensity);
    field.setDivisions?.(settings.divisions);
    field.setRays?.(settings.rays);
    field.setCascades?.(settings.cascades);
    field.setContinuous?.(settings.continuous);
    field.setHysteresis?.(settings.hysteresis);
    field.setHysteresisNormalization?.(settings.hysteresisNormalize);
    field.setNormalBias?.(settings.normalBias);
    field.setRadianceClamp?.(settings.radianceClamp);
    field.setDepthSharpness?.(settings.depthSharpness);
    field.setChebyStrength?.(settings.cheby);
    field.setClassifyStrength?.(settings.classify);
    field.setFilterStrength?.(settings.filter);
    field.setSmoothness?.(settings.smoothness);
    // The probe-field wrapper names this setNormalDetail (it forwards to the
    // node's setDetailStrength) — the old optional-chained name was a no-op.
    (field.setNormalDetail ?? field.setDetailStrength)?.call(field, settings.detail);
    field.setReflectionIntensity?.(settings.reflectionIntensity);
    field.setChangeThreshold?.(settings.changeThreshold);
    field.setSnapAmount?.(settings.snapAmount);
    field.setFireflyClamp?.(settings.fireflyClamp);
}

async function createSnapshotSpeedballGi({ renderer, scene, snapshotUi } = {}) {
    const settings = normalizeSnapshotSpeedballGiState(snapshotUi);
    if (!settings?.enabled) return null;
    if (renderer?.backend?.isWebGPUBackend !== true || !renderer?.lighting?.createNode) return null;
    try {
        // Live max.js always compiles through MaxLightsNode. Snapshot parity must
        // use that same lighting graph even when the portable Studio block has no
        // active links/paint; Speedball's generic GiLightsNode is intentionally a
        // library fallback, not the max.js runtime contract. This still lands
        // before the snapshot's first scene render/compile.
        if (renderer.lighting.createNode?.maxjsAdaptiveLighting !== true) {
            const { installMaxLightsRenderer } = await import('./max_lights_node.js');
            if (!installMaxLightsRenderer(renderer)) {
                console.warn('[snapshot_boot] Speedball GI needs the max.js WebGPU lighting graph');
                return null;
            }
        }

        const { createProbeField } = await import('speedball-gi');
        const field = createProbeField({
            renderer,
            scene,
            intensity: settings.intensity,
            hysteresis: settings.hysteresis,
            divisions: settings.divisions,
            roughReflections: settings.roughReflections,
            reflectionIntensity: settings.reflectionIntensity,
            onRebuilt: () => markSnapshotSpeedballGiMaterialsDirty(scene),
        });
        applySnapshotSpeedballGiSettings(field, settings);
        const volumes = snapshotSpeedballVolumeBoxes(settings.volumes);
        if (volumes.length) field.setVolumes(volumes);
        field.setEnabled(true);
        field.markTopologyDirty?.();
        let warmupPasses = 0;
        let tickPending = false;
        let updateFailureWarned = false;
        // Each accepted tick blends only (1 - hysteresis) of its solve into the
        // probe atlas, so "cascades + 1" passes leaves the field at a few
        // percent of its converged radiance — the snapshot rendered as if GI
        // (and the rough-reflection composite, filled by the same ticks) were
        // off. The editor only looks right because it keeps ticking while
        // idle; an auto-playing snapshot timeline never grants that idle, so
        // warm up until the exponential blend has actually converged (~97%)
        // before handing control to the editor-parity idle/playing gate.
        const warmupHysteresis = Math.min(0.99, Math.max(0.5, settings.hysteresis));
        const requiredWarmupPasses = Math.max(
            (settings.cascades === 2 ? 2 : 1) + 1,
            Math.min(240, Math.ceil(Math.log(0.03) / Math.log(warmupHysteresis))),
        );

        // Texture-late retrace: the warmup above can converge against a scene
        // whose material maps are still streaming — the trace then bounces off
        // untextured (bright) surfaces, and once the timeline gate takes over
        // the probes hold that washed-out field forever ("snapshot GI is
        // flat"). Every time the shared loader queue drains, re-trace and
        // re-run the warmup so the converged field reflects the textured
        // scene. Fires rarely (queue drains are coarse) and each pass rides
        // the same warmup path, so this never churns a settled field.
        const loadingManager = THREE.DefaultLoadingManager;
        const priorOnLoad = loadingManager.onLoad;
        let loadHookInstalled = true;
        const onTexturesSettled = () => {
            if (typeof priorOnLoad === 'function') priorOnLoad();
            warmupPasses = 0;
            field.markTopologyDirty?.();
        };
        loadingManager.onLoad = onTexturesSettled;

        return {
            field,
            settings,
            update() {
                if (!field.isSupported?.() || tickPending) return;
                const nowMs = performance.now();
                const timelineUpdateMs = maxTimeline.lastUpdateMs?.();
                const timelineIdleMs = Number.isFinite(timelineUpdateMs) && timelineUpdateMs > 0
                    ? nowMs - timelineUpdateMs
                    : Number.POSITIVE_INFINITY;
                const warmingUp = warmupPasses < requiredWarmupPasses;
                tickPending = true;
                void field.tick({
                    idleMs: warmingUp ? Number.POSITIVE_INFINITY : timelineIdleMs,
                    playing: !warmingUp && maxTimeline.playing?.() === true,
                }).then(() => {
                    if (field.hasData?.() && warmupPasses < requiredWarmupPasses) warmupPasses += 1;
                }).catch((error) => {
                    if (updateFailureWarned) return;
                    updateFailureWarned = true;
                    console.warn('[snapshot_boot] Speedball GI update failed', error);
                }).finally(() => {
                    tickPending = false;
                });
            },
            requestRebuild() {
                field.markTopologyDirty?.();
            },
            dispose() {
                if (loadHookInstalled && loadingManager.onLoad === onTexturesSettled) {
                    loadingManager.onLoad = priorOnLoad ?? undefined;
                }
                loadHookInstalled = false;
                try { field.dispose?.(); } catch {}
            },
        };
    } catch (error) {
        console.warn('[snapshot_boot] Speedball GI snapshot replay failed', error);
        return null;
    }
}

function normalizeMaxVertexColorChannel(channel = 0) {
    if (typeof channel === 'string') {
        const token = channel.trim().toLowerCase();
        if (token === 'color' || token === 'rgb') return 0;
        if (token === 'shading' || token === 'illum' || token === 'illumination') return -1;
        if (token === 'alpha') return -2;
        const parsed = Number.parseInt(token, 10);
        if (Number.isFinite(parsed)) return parsed;
        return 0;
    }
    if (!Number.isFinite(channel)) return 0;
    return Math.trunc(channel);
}

function maxVertexColorAttributeName(channel = 0) {
    const normalized = normalizeMaxVertexColorChannel(channel);
    if (normalized === 0) return 'color';
    if (normalized === -1) return 'maxjs_vc_shading';
    if (normalized === -2) return 'maxjs_vc_alpha';
    return `maxjs_vc_${normalized}`;
}

function normalizeVertexColorDescriptors(vertexColors) {
    if (!Array.isArray(vertexColors)) return [];
    return vertexColors.map((entry) => {
        const channel = normalizeMaxVertexColorChannel(entry?.ch ?? entry?.channel ?? 0);
        const name = (typeof entry?.name === 'string' && entry.name.length)
            ? entry.name
            : maxVertexColorAttributeName(channel);
        const itemSize = Number.isInteger(entry?.itemSize) && entry.itemSize > 0
            ? entry.itemSize
            : 4;
        let valueCount = 0;
        if (Number.isInteger(entry?.n) && entry.n >= 0) valueCount = entry.n;
        else if (Array.isArray(entry?.v) || ArrayBuffer.isView(entry?.v)) valueCount = entry.v.length;
        const count = itemSize > 0 ? Math.floor(valueCount / itemSize) : 0;
        return { ...entry, channel, name, itemSize, count, valueCount };
    }).filter((entry) => entry.count > 0);
}

function setGeometryVertexColorAttributes(geometry, vertexColors, buffer = null) {
    if (!geometry) return;
    geometry.userData ??= {};
    const descriptors = normalizeVertexColorDescriptors(vertexColors);
    const previous = Array.isArray(geometry.userData.maxjsVertexColors)
        ? geometry.userData.maxjsVertexColors
        : [];
    const keepNames = new Set(descriptors.map((entry) => entry.name));

    if (descriptors.length > 0) {
        for (const entry of previous) {
            if (!keepNames.has(entry.name)) geometry.deleteAttribute(entry.name);
        }
    }

    for (const entry of descriptors) {
        const current = geometry.getAttribute(entry.name);
        const fastPath = current
            && current.itemSize === entry.itemSize
            && current.count === entry.count
            && typedArrayCanStore(current.array, entry.n || 0);

        if (fastPath) {
            if (buffer) {
                if (!binInRange(buffer, entry.off, entry.n || 0)) {
                    console.warn('[snapshot_boot] Invalid vertex color range for', entry.name);
                    continue;
                }
                current.array.set(new Float32Array(buffer, entry.off, entry.n));
                current.needsUpdate = true;
            } else if (Array.isArray(entry.v) || ArrayBuffer.isView(entry.v)) {
                current.array.set(entry.v);
                current.needsUpdate = true;
            }
            continue;
        }

        let values = null;
        if (buffer) {
            if (!binInRange(buffer, entry.off, entry.n || 0)) {
                console.warn('[snapshot_boot] Invalid vertex color range for', entry.name);
                continue;
            }
            values = new Float32Array(new Float32Array(buffer, entry.off, entry.n));
        } else if (Array.isArray(entry.v) || ArrayBuffer.isView(entry.v)) {
            values = new Float32Array(entry.v);
        } else {
            continue;
        }

        geometry.setAttribute(entry.name, new THREE.BufferAttribute(values, entry.itemSize));
    }

    geometry.userData.maxjsVertexColors = descriptors.map(({ channel, name, itemSize, count }) => ({
        channel, name, itemSize, count,
    }));
    geometry.userData.maxjsVertexColorChannels = geometry.userData.maxjsVertexColors.map(({ channel, name }) => ({
        channel, name,
    }));
}

// ─── Phase 6: apply scene.m3 ───────────────────────────────────────────
// Stage 3: real applier landed. js/scene_applier.js does the geometry
// build / mesh creation / transform / removal pass. Defaults give every
// node a flat MeshStandardMaterial — visible but uncolored. Real material
// fidelity (PBR maps, TSL, MaterialX, VRay/OpenPBR mapping) lives in
// js/material_builder.js once it's extracted from index.html.
// Stable per-node material identity for bucket grouping: the interned matRef
// when the snapshot carries one, else an identity id for the inline payload.
const snapshotMaterialKeyIds = new WeakMap();
let snapshotNextMaterialKeyId = 1;
function snapshotMaterialObjectKey(mat) {
    if (!mat || typeof mat !== 'object') return String(mat ?? 'default');
    let id = snapshotMaterialKeyIds.get(mat);
    if (id === undefined) {
        id = snapshotNextMaterialKeyId++;
        snapshotMaterialKeyIds.set(mat, id);
    }
    return `obj${id}`;
}
function snapshotNodeMaterialKey(nd) {
    const matRefs = Array.isArray(nd?.matRefs) ? nd.matRefs : nd?.matsRef;
    if (Array.isArray(matRefs)) return `refs:${matRefs.join(',')}`;
    if (nd?.matRef != null) return String(nd.matRef);
    if (Array.isArray(nd?.mats)) {
        return `multi:${nd.mats.map(snapshotMaterialObjectKey).join(',')}`;
    }
    const mat = nd?.mat;
    if (mat && typeof mat === 'object') return snapshotMaterialObjectKey(mat);
    return 'default';
}

export function snapshotInstanceBucketExcludedHandles(meta) {
    const excluded = new Set();
    for (const value of meta?.runtimeScene?.hideMaxSyncHandles ?? []) {
        const handle = Number(value);
        if (Number.isFinite(handle)) excluded.add(handle);
    }
    for (const entry of meta?.runtimeScene?.transformOverrides ?? []) {
        const handle = Number(entry?.handle);
        if (Number.isFinite(handle)) excluded.add(handle);
    }
    for (const clip of meta?.animations?.clips ?? []) {
        for (const target of clip?.targets ?? []) {
            const match = /^handle:(\d+)$/.exec(String(target?.target ?? ''));
            if (match) excluded.add(Number(match[1]));
        }
    }
    return excluded;
}

async function applyDelta(buffer, ctx) {
    const meta = ctx?.meta;
    if (meta?.type !== 'scene_bin') {
        console.warn('[snapshot_boot] meta.type is not "scene_bin"; skipping applier.');
        return;
    }
    if ((meta.nodes?.length ?? 0) === 0) {
        console.info('[snapshot_boot] empty M3 scene payload (0 nodes) — applier no-op.');
        return;
    }
    // Live instOf families and static exact-M3 alias families may collapse into
    // InstancedMesh buckets (shared engine, same as optimizeMaxInstances).
    // Originals stay hidden in nodeMap, so handle-based runtime APIs survive.
    const excludedBucketHandles = snapshotInstanceBucketExcludedHandles(meta);
    ctx.instanceBuckets ??= createInstanceBuckets({
        nodeMap: ctx.nodeMap,
        root: ctx.maxRoot,
        materialKey: snapshotNodeMaterialKey,
        buildMaterial: ({ nd, geom }) =>
            ctx.materialBuilder.buildForNode({ nd, geom, wantsLine: false }),
        // Baked tracks and runtime overrides address ordinary handles directly.
        // Keep those originals renderable; static siblings may still bucket.
        excludeNode: (nd) => excludedBucketHandles.has(Number(nd?.h)),
    });
    const buckets = ctx.instanceBuckets;
    const result = await applySceneBin({
        buffer,
        meta,
        ctx: {
            nodeMap: ctx.nodeMap,
            maxRoot: ctx.maxRoot,
            scene: ctx.scene,
            renderer: ctx.renderer,
            rendererBackendLabel: ctx.renderer?.userData?.maxjsBackendLabel,
            forestMeshes: ctx.forestMeshes,
            lastInstanceBucketSignature: buckets.signature,
        },
        hooks: {
            planInstanceBuckets: (nodes) => buckets.plan(nodes),
            getInstanceBucketFor: (handle) => buckets.getBucketFor(handle),
            updateInstanceBucketNode: (handle, nd) => buckets.updateNode(handle, nd),
            materialBuilder: ({ nd, geom, wantsLine }) =>
                ctx.materialBuilder.buildForNode({ nd, geom, wantsLine }),
            instanceMaterialBuilder: ({ grp, geom, materialDescriptor, materialIndex }) => {
                if (materialDescriptor) {
                    return ctx.materialBuilder.buildForNode({
                        nd: { mat: materialDescriptor },
                        geom,
                        wantsLine: false,
                    });
                }
                if (Array.isArray(grp?.mats) && Array.isArray(grp?.groups) && Number.isInteger(materialIndex)) {
                    return ctx.materialBuilder.buildForNode({
                        nd: { mat: grp.mats[materialIndex] },
                        geom,
                        wantsLine: false,
                    });
                }
                return ctx.materialBuilder.buildForNode({ nd: grp, geom, wantsLine: false });
            },
            materialUpdater: ({ mesh, nd, wantsLine }) => {
                if (!ctx.materialBuilder.shouldUpdate({ mesh, nd })) return false;
                const next = ctx.materialBuilder.buildForNode({ nd, geom: mesh.geometry, wantsLine });
                const old = mesh.material;
                mesh.material = next;
                // Defer disposal a tick to avoid pulling textures still bound
                // to in-flight WebGPU pipelines.
                queueMicrotask(() => {
                    if (Array.isArray(old)) old.forEach((m) => m?.dispose?.());
                    else old?.dispose?.();
                });
                return true;
            },
            stampMaterial: (mesh, nd) => {
                mesh.userData ??= {};
                mesh.userData.maxjsMaterialSignature =
                    ctx.materialBuilder ? ctx.materialBuilder['signature']?.(nd) : null;
                mesh.userData.maxjsLastNodePayload = nd;
            },
            onMaterialApplied: (handle, mesh) => {
                ctx.layerManager?.applyMaterialOverrides?.(handle, mesh);
            },
            setVertexColors: (geom, vc, sceneBuffer) => {
                setGeometryVertexColorAttributes(geom, vc, sceneBuffer);
            },
            markRuntimeTransformsDirty: () => {
                ctx.layerManager?.markRuntimeTransformsDirty?.();
            },
            finalizeSceneSnapshot: () => {
                ctx.animationSystem?.invalidateTargets?.();
            },
        },
    });
    if (buckets.build(meta.nodes)) {
        const stats = buckets.stats();
        if (stats.buckets > 0) {
            console.info(
                `[snapshot_boot] instance buckets: ${stats.instances} instances in ${stats.buckets} draws`,
            );
        }
    }
    return result;
}

const SNAPSHOT_TONE_MAPPING_MODES = Object.freeze({
    None: THREE.NoToneMapping,
    NoToneMapping: THREE.NoToneMapping,
    Linear: THREE.LinearToneMapping,
    LinearToneMapping: THREE.LinearToneMapping,
    Reinhard: THREE.ReinhardToneMapping,
    ReinhardToneMapping: THREE.ReinhardToneMapping,
    Cineon: THREE.CineonToneMapping,
    CineonToneMapping: THREE.CineonToneMapping,
    AgX: THREE.AgXToneMapping,
    AgXToneMapping: THREE.AgXToneMapping,
    Neutral: THREE.NeutralToneMapping,
    NeutralToneMapping: THREE.NeutralToneMapping,
});

function resolveSnapshotToneMapping(value) {
    if (Number.isFinite(value)) return value;
    const raw = typeof value === 'string' ? value : value?.type;
    if (!raw) return null;
    if (SNAPSHOT_TONE_MAPPING_MODES[raw] != null) return SNAPSHOT_TONE_MAPPING_MODES[raw];
    const canonical = raw.endsWith('ToneMapping') ? raw : `${raw}ToneMapping`;
    return THREE[canonical] ?? null;
}

function getSnapshotCoreBrightness(snapshotUi) {
    const candidates = [
        snapshotUi?.fx?.colorGrading?.brightness,
        snapshotUi?.postFx?.colorGrading?.brightness,
        snapshotUi?.postFx?.brightness,
        snapshotUi?.brightness,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function getSnapshotCoreContrast(snapshotUi) {
    const candidates = [
        snapshotUi?.fx?.colorGrading?.contrast,
        snapshotUi?.postFx?.colorGrading?.contrast,
        snapshotUi?.postFx?.contrast,
        snapshotUi?.contrast,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function applySnapshotCoreLook(snapshotUi, { renderer } = {}) {
    if (!snapshotUi || !renderer) return;

    const toneMapping = resolveSnapshotToneMapping(snapshotUi.toneMapping);
    if (toneMapping != null) renderer.toneMapping = toneMapping;
    if (Number.isFinite(snapshotUi.exposure)) {
        renderer.toneMappingExposure = snapshotUi.exposure;
    }

    const brightness = getSnapshotCoreBrightness(snapshotUi);
    const contrast = getSnapshotCoreContrast(snapshotUi);
    const canvas = renderer.domElement;
    if (canvas?.style) {
        const filters = [];
        if (Number.isFinite(brightness)) {
            const amount = Math.max(0, 1 + brightness);
            if (Math.abs(amount - 1) > 1.0e-6) filters.push(`brightness(${amount})`);
        }
        if (Number.isFinite(contrast)) {
            const amount = Math.max(0, 1 + contrast);
            if (Math.abs(amount - 1) > 1.0e-6) filters.push(`contrast(${amount})`);
        }
        canvas.style.filter = filters.join(' ');
    }

    renderer.userData ??= {};
    renderer.userData.maxjsSnapshotCoreLook = {
        toneMapping: snapshotUi.toneMapping ?? null,
        exposure: Number.isFinite(snapshotUi.exposure) ? snapshotUi.exposure : null,
        brightness,
        contrast,
    };
}

function normalizeSnapshotCameraClip(cameraClip) {
    const near = Number(cameraClip?.near);
    const far = Number(cameraClip?.far);
    return {
        near: Number.isFinite(near) && near > 0 ? near : null,
        far: Number.isFinite(far) && far > 0 ? far : null,
    };
}

function applySnapshotCameraClip(camera, cameraClip) {
    if (!camera) return;
    const clip = normalizeSnapshotCameraClip(cameraClip);
    let changed = false;
    if (clip.near != null && camera.near !== clip.near) {
        camera.near = clip.near;
        changed = true;
    }
    if (clip.far != null && clip.far > camera.near && camera.far !== clip.far) {
        camera.far = clip.far;
        changed = true;
    }
    if (changed) camera.updateProjectionMatrix();
}

// ─── Phase 7: snapshotUi ───────────────────────────────────────────────
// Honors the export-critical fields here:
//   - tone mapping, exposure, and brightness/contrast on the renderer/canvas
//   - background: solid viewport color (Display → Background slot)
//   - envVisible: show environment map on the viewport background (Environment btn)
//   - basic camera position/target and user clip planes if present
// Bake overrides are consumed by material_builder during M3 scene apply.
// The deeper live editor panels are intentionally out of the lightweight
// snapshot boot path; portable Studio state is replayed after camera/env apply.
export function applySnapshotSolidBackground(snapshotUi, scene) {
    if (!snapshotUi || !scene) return;
    // Environment map on the background wins when envVisible is true.
    if (snapshotUi.envVisible === true && scene.background && !scene.background.isColor) {
        return;
    }
    const bg = snapshotUi.background;
    if (typeof bg === 'number') {
        scene.background = new THREE.Color(bg >>> 0);
    } else if (Array.isArray(bg) && bg.length >= 3) {
        scene.background = new THREE.Color(bg[0], bg[1], bg[2]);
    }
}

function applySnapshotUi(snapshotUi, ctx) {
    const { renderer, scene, camera, controls } = ctx;

    applySnapshotCoreLook(snapshotUi, { renderer });
    applySnapshotSolidBackground(snapshotUi, scene);

    // Post-FX state replay (WebGPU snapshots only — module registered in
    // registerOptionalModules when runtimeFeatures.post_fx is non-empty).
    // Final-stylize stages ride along: fx.powershot is part of fx, the
    // Shader Lab composition lives at snapshotUi.shaderLab.
    if (ctx.maxjsFx) {
        ctx.maxjsFx.setEnvironmentVisible?.(snapshotUi.envVisible !== false);
        ctx.maxjsFx.setResolutionScale?.(snapshotUi.performance?.postFxScale);
        ctx.maxjsFx.restoreState?.(snapshotUi.fx ?? {}, { shaderLab: snapshotUi.shaderLab });
    }

    // Camera state — minimal subset; full applyStandaloneCameraState is bigger.
    const cam = snapshotUi.camera;
    if (cam) {
        if (Array.isArray(cam.position) && cam.position.length === 3) {
            camera.position.fromArray(cam.position);
        }
        if (Array.isArray(cam.target) && cam.target.length === 3 && controls) {
            controls.target.fromArray(cam.target);
            controls.update();
        }
        if (Number.isFinite(cam.fov) && camera.isPerspectiveCamera) {
            camera.fov = cam.fov;
        }
        if (camera.isPerspectiveCamera && Number.isFinite(cam.near) && cam.near > 0) {
            camera.near = cam.near;
        }
        if (camera.isPerspectiveCamera && Number.isFinite(cam.far) && cam.far > camera.near) {
            camera.far = cam.far;
        }
        camera.updateProjectionMatrix();
    }
    applySnapshotCameraClip(camera, snapshotUi.cameraClip);

    // Studio state is applied from boot() after authored environment and the
    // final camera state are both in place, so camera-relative constraints have
    // the same basis they had in the live viewer.
}

// Helper: re-derive vertical fov from the stashed horizontal Max fov +
// current canvas aspect. Called both at boot (initial apply) and on every
// window resize so framing doesn't drift as the canvas reshapes.
function getCanvasAspect(canvas, width, height) {
    const size = measureCanvasSize(canvas, width, height);
    return size.width / size.height;
}

function applyHorizontalFovToVertical(camera, aspect) {
    const hFov = Number.isFinite(camera?.userData?.maxjsHorizontalFov)
        ? camera.userData.maxjsHorizontalFov
        : camera?.userData?.maxjsHFovDeg;
    if (!camera?.isPerspectiveCamera) return;
    if (!Number.isFinite(hFov) || hFov <= 0 || hFov >= 170) return;
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : camera.aspect || 1;
    const hRad = hFov * Math.PI / 180;
    camera.aspect = safeAspect;
    camera.fov = 2 * Math.atan(Math.tan(hRad / 2) / safeAspect) * 180 / Math.PI;
    camera.updateProjectionMatrix();
}

// ─── Phase 7b: top-level camera ───────────────────────────────────────
// Mirrors the live-mode `applyCamera` / `applyStandaloneCameraState` from
// index.html. Sequence matters:
//
//   1. Convert pos/up/tgt from Max (Z-up) to world (Y-up).
//   2. position + up + lookAt(target) — single pass that resets rotation
//      cleanly (just setting position leaves stale quaternion).
//   3. Convert Max horizontal FOV → Three.js vertical FOV using current
//      canvas aspect; clamp out-of-range values.
//   4. controls.target = same target world vector; controls.update() so
//      OrbitControls re-anchors instead of snapping the camera back.
//
// Ortho persp is intentionally NOT supported here yet — snapshot mode is
// perspective-only. If the snapshot was authored in ortho, we log and
// fall through to perspective with a sensible default.
function applyTopLevelCamera(cam, { camera, controls, scratch, getAspect }) {
    if (!cam || !camera) return;

    const posOk = Array.isArray(cam.pos) && cam.pos.length === 3;
    const tgtOk = Array.isArray(cam.tgt) && cam.tgt.length === 3;
    const upOk  = Array.isArray(cam.up)  && cam.up.length  === 3;
    if (!posOk || !tgtOk || !upOk) {
        console.warn('[snapshot_boot] meta.camera missing pos/tgt/up arrays; skipping camera apply.', cam);
        return;
    }
    if (cam.persp === false) {
        console.warn('[snapshot_boot] orthographic camera in snapshot — falling back to perspective (ortho support pending).');
    }

    // Basis convert all three vectors first.
    copyMaxArrayToWorld(camera.position, cam.pos);
    copyMaxArrayToWorld(camera.up, cam.up);
    const targetWorld = scratch ?? new THREE.Vector3();
    copyMaxArrayToWorld(targetWorld, cam.tgt);

    // Single rotation reset: position + up + lookAt locks the basis cleanly.
    camera.lookAt(targetWorld);

    // Max stores HORIZONTAL fov; Three.js wants VERTICAL fov, derived from
    // the canvas aspect. Stash the source horizontal degrees on userData so
    // the resize handler can re-derive vertical fov on every aspect change
    // — without that, the framing skews inversely to window resize.
    if (camera.isPerspectiveCamera && Number.isFinite(cam.fov) && cam.fov > 0 && cam.fov < 170) {
        camera.userData ??= {};
        camera.userData.maxjsHorizontalFov = cam.fov;
        applyHorizontalFovToVertical(camera, getAspect?.());
    }
    if (camera.isPerspectiveCamera && Number.isFinite(cam.near) && cam.near > 0) {
        camera.near = cam.near;
    }
    if (camera.isPerspectiveCamera && Number.isFinite(cam.far) && cam.far > camera.near) {
        camera.far = cam.far;
    }
    camera.updateProjectionMatrix();

    if (controls) {
        controls.target.copy(targetWorld);
        controls.update();
    }

    // Stash DOF + persp for future post-FX consumer.
    camera.userData ??= {};
    camera.userData.maxjsCameraSnapshot = {
        persp: cam.persp,
        dofEnabled: cam.dofEnabled,
        dofFocusDistance: cam.dofFocusDistance,
        dofFocalLength: cam.dofFocalLength,
        dofBokehScale: cam.dofBokehScale,
    };
}

// ─── Phase 8: runtimeScene ────────────────────────────────────────────
// Baked trees are the durable fallback for layers that cannot be replayed from
// their shipped ESM sidecars. They load first; phase 9 removes only the baked
// layer roots whose sidecars mounted successfully.
const RUNTIME_NODE_MATERIAL_TYPES = Object.freeze({
    MeshPhysicalNodeMaterial: 'MeshPhysicalMaterial',
    MeshSSSNodeMaterial: 'MeshPhysicalMaterial',
    MeshStandardNodeMaterial: 'MeshStandardMaterial',
    MeshBasicNodeMaterial: 'MeshBasicMaterial',
    MeshLambertNodeMaterial: 'MeshLambertMaterial',
    MeshPhongNodeMaterial: 'MeshPhongMaterial',
    MeshToonNodeMaterial: 'MeshToonMaterial',
    MeshNormalNodeMaterial: 'MeshNormalMaterial',
    LineBasicNodeMaterial: 'LineBasicMaterial',
    LineDashedNodeMaterial: 'LineDashedMaterial',
    PointsNodeMaterial: 'PointsMaterial',
    SpriteNodeMaterial: 'SpriteMaterial',
});

function cloneRuntimeObjectJson(value) {
    return value && typeof value === 'object'
        ? JSON.parse(JSON.stringify(value))
        : null;
}

function patchRuntimeMaterialTypes(json) {
    for (const material of Array.isArray(json?.materials) ? json.materials : []) {
        const type = String(material?.type || '');
        if (!type) continue;
        if (RUNTIME_NODE_MATERIAL_TYPES[type]) {
            material.type = RUNTIME_NODE_MATERIAL_TYPES[type];
        } else if (type.includes('NodeMaterial')) {
            material.type = 'MeshStandardMaterial';
        }
    }
    return json;
}

async function parseRuntimeSubtree(json, root) {
    const payload = patchRuntimeMaterialTypes(cloneRuntimeObjectJson(json));
    if (!payload) return null;
    const LoaderCtor = THREE.ObjectLoader ?? THREE.NodeObjectLoader;
    if (!LoaderCtor) throw new Error('Three.js ObjectLoader is unavailable');
    const loader = new LoaderCtor();
    const resourceRoot = new URL(
        String(root || '.').replace(/\/?$/, '/'),
        window.location.href,
    ).href;
    loader.setResourcePath?.(resourceRoot);
    return typeof loader.parseAsync === 'function'
        ? loader.parseAsync(payload)
        : loader.parse(payload);
}

function normalizeRuntimeHiddenSourceHandles(handles) {
    const out = new Set();
    for (const rawHandle of Array.isArray(handles) ? handles : []) {
        const numericHandle = Number(rawHandle);
        out.add(Number.isFinite(numericHandle) ? numericHandle : rawHandle);
    }
    return out;
}

function enforceRuntimeHiddenSources(handles, nodeMap) {
    let hidden = 0;
    for (const handle of handles ?? []) {
        const object = nodeMap?.get?.(handle);
        if (!object?.isObject3D) continue;
        object.visible = false;
        object.userData ??= {};
        object.userData.maxjsVisible = false;
        object.layers?.set?.(31);
        hidden += 1;
    }
    return hidden;
}

function collectRuntimeResources(roots) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const skeletons = new Set();
    const collectMaterial = (material) => {
        if (!material || materials.has(material)) return;
        materials.add(material);
        for (const value of Object.values(material)) {
            if (value?.isTexture) textures.add(value);
        }
        for (const uniform of Object.values(material.uniforms ?? {})) {
            if (uniform?.value?.isTexture) textures.add(uniform.value);
        }
    };
    for (const root of Array.isArray(roots) ? roots : [roots]) {
        root?.traverse?.((object) => {
            if (object.geometry) geometries.add(object.geometry);
            if (object.skeleton) skeletons.add(object.skeleton);
            const objectMaterials = Array.isArray(object.material)
                ? object.material
                : [object.material];
            objectMaterials.forEach(collectMaterial);
        });
    }
    return { geometries, materials, textures, skeletons };
}

function disposeRuntimeObjects(roots, preserve = null) {
    const resources = collectRuntimeResources(roots);
    for (const geometry of resources.geometries) {
        if (!preserve?.geometries?.has(geometry)) geometry.dispose?.();
    }
    for (const material of resources.materials) {
        if (!preserve?.materials?.has(material)) material.dispose?.();
    }
    for (const texture of resources.textures) {
        if (!preserve?.textures?.has(texture)) texture.dispose?.();
    }
    for (const skeleton of resources.skeletons) {
        if (!preserve?.skeletons?.has(skeleton)) skeleton.dispose?.();
    }
}

async function applyRuntimeScene(runtimeScene, { root, jsRoot, overlayRoot, nodeMap }) {
    const hiddenSourceHandles = normalizeRuntimeHiddenSourceHandles(runtimeScene?.hideMaxSyncHandles);
    const state = {
        roots: [],
        transformOverrides: Array.isArray(runtimeScene?.transformOverrides)
            ? runtimeScene.transformOverrides
            : [],
        hiddenSourceHandles,
        hiddenSourceCount: enforceRuntimeHiddenSources(hiddenSourceHandles, nodeMap),
    };

    const entries = [
        ['jsRoot', runtimeScene?.jsRoot, jsRoot],
        ['overlayRoot', runtimeScene?.overlayRoot, overlayRoot],
    ];
    for (const [kind, json, parent] of entries) {
        if (!json || !parent?.add) continue;
        try {
            const parsed = await parseRuntimeSubtree(json, root);
            if (!parsed?.isObject3D) continue;
            parsed.visible = true;
            parsed.userData ??= {};
            parsed.userData.maxjsBakedRuntimeScene = true;
            parsed.userData.maxjsBakedRuntimeKind = kind;
            parent.add(parsed);
            parsed.updateMatrixWorld(true);
            state.roots.push(parsed);
        } catch (error) {
            console.warn(`[snapshot_boot] runtimeScene.${kind} parse failed`, error);
        }
    }
    return state;
}

function pruneEmptyRuntimeRoots(runtimeState) {
    if (!runtimeState?.roots?.length) return;
    for (const bakedRoot of [...runtimeState.roots]) {
        if (bakedRoot.children.length > 0) continue;
        bakedRoot.parent?.remove(bakedRoot);
        runtimeState.roots.splice(runtimeState.roots.indexOf(bakedRoot), 1);
    }
}

function detachBakedLayer(runtimeState, layerId) {
    const wanted = String(layerId ?? '');
    if (!wanted || !runtimeState?.roots?.length) return [];
    const matches = [];
    for (const bakedRoot of runtimeState.roots) {
        bakedRoot.traverse((object) => {
            if (object === bakedRoot) return;
            if (String(object.userData?.maxjsLayerId ?? '') === wanted) matches.push(object);
        });
    }

    const selected = new Set(matches);
    const records = [];
    for (const object of matches) {
        let ancestor = object.parent;
        let nested = false;
        while (ancestor) {
            if (selected.has(ancestor)) {
                nested = true;
                break;
            }
            ancestor = ancestor.parent;
        }
        if (nested || !object.parent) continue;
        const parent = object.parent;
        records.push({
            object,
            parent,
            index: parent.children.indexOf(object),
        });
    }
    for (const record of records) record.parent.remove(record.object);
    return records;
}

function restoreDetachedBakedLayer(records) {
    const ordered = [...(records ?? [])].sort((a, b) => a.index - b.index);
    for (const record of ordered) {
        const { object, parent, index } = record;
        if (!object?.isObject3D || !parent?.isObject3D) continue;
        parent.add(object);
        const currentIndex = parent.children.indexOf(object);
        const targetIndex = Math.max(0, Math.min(index, parent.children.length - 1));
        if (currentIndex !== targetIndex) {
            parent.children.splice(currentIndex, 1);
            parent.children.splice(targetIndex, 0, object);
        }
    }
}

function commitDetachedBakedLayer(runtimeState, records) {
    const objects = (records ?? []).map(record => record.object).filter(Boolean);
    if (objects.length === 0) return 0;
    const preserved = collectRuntimeResources(runtimeState.roots);
    disposeRuntimeObjects(objects, preserved);
    pruneEmptyRuntimeRoots(runtimeState);
    return objects.length;
}

function restoreSnapshotTransformOverrides(runtimeState, mountedIds, layerManager) {
    const mounted = new Set(Array.isArray(mountedIds) ? mountedIds.map(String) : []);
    const restore = runtimeState?.transformOverrides?.filter((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        if (mounted.size === 0) return true;
        const ownerLayer = entry.ownerLayer;
        // Legacy snapshots cannot prove whether the mounted sidecar already
        // re-applied a relative transform, so skip ownerless records here.
        if (ownerLayer == null || ownerLayer === '') return false;
        return !mounted.has(String(ownerLayer));
    }) ?? [];
    if (restore.length === 0) return 0;
    layerManager?.restoreTransformOverrides?.(restore);
    return restore.length;
}

function applySnapshotMaterialScalar(mesh, payload, materialIndex = null) {
    if (!mesh || !payload || typeof payload !== 'object') return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const targets = materialIndex == null
        ? materials
        : [materials[Number(materialIndex)]];
    const colorKeys = ['color', 'emissive', 'specularColor', 'sheenColor', 'attenuationColor'];
    // `reflectivity` is an alias setter onto `ior` in three's MeshPhysicalMaterial,
    // so it MUST be applied before `ior` or it overwrites the authored value.
    const scalarKeys = [
        'roughness', 'metalness', 'opacity', 'emissiveIntensity', 'envMapIntensity',
        'aoMapIntensity', 'clearcoat', 'clearcoatRoughness', 'sheen',
        'sheenRoughness', 'iridescence', 'iridescenceIOR', 'transmission',
        'thickness', 'reflectivity', 'specularIntensity', 'ior', 'dispersion',
        'attenuationDistance', 'anisotropy', 'alphaTest',
    ];
    const booleanKeys = ['depthWrite', 'depthTest'];

    for (const material of targets) {
        if (!material || material.userData?.maxjsHTMLTextureOverride) continue;
        for (const key of colorKeys) {
            const value = payload[key];
            if ((Array.isArray(value) || ArrayBuffer.isView(value)) && material[key]?.setRGB) {
                material[key].setRGB(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
            }
        }
        const roughness = payload.roughness ?? payload.rough;
        const metalness = payload.metalness ?? payload.metal;
        if (roughness != null && 'roughness' in material) material.roughness = Number(roughness);
        if (metalness != null && 'metalness' in material) material.metalness = Number(metalness);
        let materialNeedsUpdate = false;
        for (const key of scalarKeys) {
            if (key === 'roughness' || key === 'metalness') continue;
            // Program-gated lobes must bump the material version when they cross
            // zero, or an animation track raising sheen/clearcoat/iridescence/
            // anisotropy/transmission/dispersion off a zero export frame sets the
            // value and never compiles the lobe. The live viewer already does
            // this; the shared helper keeps both hosts on the same rule.
            if (isProgramGatedMaterialScalar(key)) {
                if (assignGatedMaterialScalar(material, key, payload[key])) materialNeedsUpdate = true;
                continue;
            }
            if (payload[key] != null && key in material) material[key] = Number(payload[key]);
        }
        // Mirror the live viewer's specular/IOR coupling: three derives F0 from
        // both, so a specular weight of zero also kills env reflections and pins
        // IOR to 1.0 (scene_sync.js applyMaterialScalar).
        if (payload.specularIntensity != null && Number(payload.specularIntensity) < 0.001) {
            if ('envMapIntensity' in material) material.envMapIntensity = 0;
            if ('ior' in material) material.ior = 1.0;
        }
        for (const key of booleanKeys) {
            if (payload[key] != null && key in material) material[key] = !!payload[key];
        }

        let nextTransparent = material.transparent;
        if (payload.opacity != null) {
            nextTransparent = payload.transparent === true || Number(payload.opacity) < 0.999;
        } else if (payload.transparent != null) {
            nextTransparent = payload.transparent === true;
        }
        if (Number(payload.transmission) > 0) nextTransparent = true;
        if (material.transparent !== nextTransparent) {
            material.transparent = nextTransparent;
            materialNeedsUpdate = true;
        }
        if (materialNeedsUpdate) material.needsUpdate = true;
    }
}

// ─── Phase 9: layer project bind ──────────────────────────────────────
// Real implementation — small enough to live here. Mirrors
// `tryReplaySnapshotLayerModules` from index.html.
//
// Snapshot mode honors disabled layer state. Disabled sources may still be
// archived into a snapshot, but they should not be imported or started.
function resolveSnapshotLayerFactory(moduleNamespace) {
    const directHooks = ['init', 'update', 'dispose']
        .some(key => typeof moduleNamespace?.[key] === 'function');
    if (directHooks) return async () => moduleNamespace;

    const candidate = moduleNamespace?.default
        ?? moduleNamespace?.createLayer
        ?? moduleNamespace?.mount;

    if (typeof candidate === 'function') return candidate;
    if (candidate && typeof candidate === 'object') return async () => candidate;

    throw new Error('Snapshot layer module must export default/createLayer/mount or layer hooks');
}

function resolveSnapshotStaticParameters(moduleNamespace) {
    const params = moduleNamespace?.parameters ?? moduleNamespace?.params;
    return params && typeof params === 'object' ? params : null;
}

function buildSnapshotManifestLayers(manifest) {
    const rawLayers = Array.isArray(manifest?.layers) ? manifest.layers : [];
    return rawLayers
        .filter(entry => entry?.enabled !== false)
        .map((entry, index) => ({
            id: entry?.id || entry?.name || `layer_${index}`,
            name: entry?.name || entry?.id || `layer_${index}`,
            entryPath: entry?.entry || entry?.path || 'main.js',
            source: 'project',
            enabled: true,
            paramValues: entry?.paramValues ?? entry?.parameters ?? entry?.params,
        }));
}

function buildSnapshotRuntimeLayers(runtimeScene) {
    const rawLayers = Array.isArray(runtimeScene?.layers) ? runtimeScene.layers : [];
    return rawLayers
        .filter(entry => entry?.entry && entry?.active !== false)
        .map((entry, index) => ({
            id: entry.id || entry.name || `inline_${index}`,
            name: entry.name || entry.id || `inline_${index}`,
            entryPath: entry.entry,
            source: entry.source || 'inline',
            enabled: true,
            parameters: entry.parameters ?? [],
            paramValues: entry.paramValues ?? entry.parameters ?? entry.params,
        }));
}

function bindSnapshotProjectRuntime(layerManager, root) {
    let warned = false;
    const warnReadOnly = () => {
        if (warned) return;
        warned = true;
        console.warn('[snapshot_boot] ctx.project is read-only in a deployed snapshot');
    };
    const state = Object.freeze({
        mode: 'snapshot',
        readOnly: true,
        root: new URL(
            String(root || '.').replace(/\/?$/, '/'),
            window.location.href,
        ).href,
    });
    layerManager?.bindProjectRuntime?.({
        setProjectDirectory() {
            warnReadOnly();
            return false;
        },
        reload() {
            warnReadOnly();
            return false;
        },
        getState() {
            return state;
        },
    });
}

async function bindLayerProject(root, meta, layerManager, runtimeState) {
    let manifest = null;
    let baseUrl = new URL('./', new URL(`${root}/`, location.href));
    let allLayers = [];

    try {
        const manifestUrl = new URL('./project.maxjs.json', baseUrl);
        const response = await fetch(manifestUrl, { cache: 'no-cache' });
        if (response.ok) {
            manifest = await response.json();
            baseUrl = new URL('./', manifestUrl);
        }
    } catch {
        manifest = null;
    }

    // Prefer runtimeScene because it reflects the live layer manager state at export
    // time. The project manifest can be stale when inline layers are disabled by
    // filename (foo.js.disabled), so it is only a fallback.
    allLayers = buildSnapshotRuntimeLayers(meta.runtimeScene);
    if (allLayers.length === 0) {
        allLayers = buildSnapshotManifestLayers(manifest);
    }
    if (allLayers.length === 0) return { mounted: 0, mountedIds: [], manifest };

    const mountedIds = [];
    const errors = [];
    const seenIds = new Set();
    for (const entry of allLayers) {
        if (entry?.enabled === false) continue;
        const id = String(entry.id ?? '');
        if (!id || seenIds.has(id)) {
            const error = new Error(id
                ? `Duplicate snapshot layer id: ${id}`
                : 'Snapshot layer is missing an id');
            errors.push({ id, error });
            console.warn('[snapshot_boot] layer module replay failed', error);
            continue;
        }
        seenIds.add(id);

        let detachedBaked = [];
        try {
            const entryPath = String(entry.entryPath || entry.entry || entry.path || '').replace(/\\/g, '/');
            if (!entryPath) throw new Error(`Missing layer entry path for ${id}`);
            const moduleUrl = new URL(entryPath, baseUrl);
            moduleUrl.searchParams.set('v', `${Date.now()}_${id}`);
            const moduleNamespace = await import(moduleUrl.toString());
            const factory = resolveSnapshotLayerFactory(moduleNamespace);
            // Remove only this layer's baked twin before its factory/init runs,
            // so scene traversal cannot capture an object that will be disposed
            // immediately after a successful live mount.
            detachedBaked = detachBakedLayer(runtimeState, id);
            const result = await layerManager.mount(
                id,
                async (ctx, THREE_arg) => {
                    const staticParams = resolveSnapshotStaticParameters(moduleNamespace);
                    if (staticParams) ctx.params.define(staticParams);
                    return factory(ctx, THREE_arg, { manifest, layer: entry });
                },
                {
                    name: entry.name || id,
                    code: moduleUrl.toString(),
                    source: entry.source || 'project',
                    entry: entry.entryPath,
                    paramValues: entry.paramValues ?? entry.parameters ?? entry.params,
                },
            );
            if (result?.error) throw new Error(result.error);
            mountedIds.push(id);
            commitDetachedBakedLayer(runtimeState, detachedBaked);
        } catch (error) {
            try { layerManager.remove(id); } catch {}
            restoreDetachedBakedLayer(detachedBaked);
            errors.push({ id, error });
            console.warn(`[snapshot_boot] layer "${id}" replay failed; keeping baked fallback`, error);
        }
    }
    return {
        mounted: mountedIds.length,
        mountedIds: [...mountedIds],
        manifest,
        errors,
        error: errors[0]?.error ?? null,
    };
}

// ─── Phase 10: render loop ────────────────────────────────────────────
async function createSnapshotNirSensingController({
    maxjsFx,
    layerManager,
    speedballGi,
} = {}) {
    // Keep Speedball out of minimal snapshot startup. PowerShot and/or the
    // probe field are the only standalone consumers of its shared IR gates.
    if (typeof maxjsFx?.getPowerShotOptions !== 'function' && !speedballGi?.field) {
        return { sync() {}, dispose() {} };
    }

    let setNirDirectSensing = null;
    let setNirIlluminatorGain = null;
    try {
        ({ setNirDirectSensing, setNirIlluminatorGain } = await import('speedball-gi'));
    } catch (error) {
        console.warn('[snapshot_boot] NIR sensing controls unavailable', error);
    }

    let disposed = false;
    const apply = (sensing, gain) => {
        setNirDirectSensing?.(sensing);
        setNirIlluminatorGain?.(gain);
        speedballGi?.field?.setNirSensing?.(sensing);
        speedballGi?.field?.setNirGain?.(gain);
        layerManager?.setSpectralRasterSensing?.(sensing);
    };

    return {
        sync() {
            if (disposed) return;
            const powerShot = maxjsFx?.getPowerShotOptions?.() ?? {};
            const sensing = maxjsFx?.isPowerShotEnabled?.() === true
                && (powerShot.mode === 'infrared' || powerShot.mode === 'nightshot');
            const rawGain = Number(powerShot.irIlluminator);
            apply(sensing, Number.isFinite(rawGain) ? Math.max(0, rawGain) : 1);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            // These are module-shared uniforms. Reset them so disposing one
            // player cannot leak NIR state into a later snapshot on the page.
            apply(false, 1);
        },
    };
}

async function startRenderLoop({
    renderer,
    scene,
    camera,
    controls,
    layerManager,
    animationSystem,
    maxjsFx,
    snapshotEnvironment,
    optionalModules,
    studioLighting,
    enforceHiddenSources,
    fpsCap,
}) {
    const nirSensing = await createSnapshotNirSensingController({
        maxjsFx,
        layerManager,
        speedballGi: optionalModules?.speedballGi,
    });
    // Set the sensed band before compileAsync and the shadow warmup render.
    // Otherwise true IR lights are correctly black in RGB and the first
    // standalone frame compiles/renders as an unilluminated visible scene.
    nirSensing.sync();
    let lastTimeMs = performance.now();
    let elapsed = 0;
    // Frame limiter: 60fps ceiling regardless of display refresh (240Hz panels
    // otherwise quadruple GPU work for a VHS look that gains nothing from it).
    // snapshotUi.performance.fpsCap below 60 lowers it further; never raises.
    const capHz = Math.min(Number(fpsCap) > 0 ? Number(fpsCap) : 60, 60);
    const minFrameMs = 1000 / capHz;
    let nextFrameMs = 0;
    const loop = () => {
        const nowMs = performance.now();
        if (nowMs < nextFrameMs) return;
        // Advance by exact steps so vsync quantization (144Hz etc.) averages
        // out to the cap instead of locking to the next-lower divisor; snap
        // forward after a stall so we never burst to catch up.
        nextFrameMs = (nowMs - nextFrameMs > minFrameMs ? nowMs : nextFrameMs) + minFrameMs;
        const dt = Math.min(0.25, Math.max(0, (nowMs - lastTimeMs) / 1000));
        lastTimeMs = nowMs;
        elapsed += dt;
        layerManager?.enforceCameraControls?.();
        if (controls) controls.update();
        layerManager?.update?.(dt, elapsed);
        animationSystem?.update?.(dt);
        enforceHiddenSources?.();
        for (const module of Object.values(optionalModules ?? {})) {
            module?.update?.(dt, elapsed);
        }
        studioLighting?.updateCameraConstraints?.();
        nirSensing.sync();

        layerManager?.beforeRender?.(elapsed);
        try {
            // Snapshot boot keeps the conservative FX gate; advanced live-viewer
            // post stacks are intentionally not replayed in deploy snapshots.
            if (maxjsFx?.isEnabled?.()) {
                maxjsFx.render();
            } else {
                renderer.render(scene, camera);
            }
        } finally {
            layerManager?.afterRender?.(elapsed);
        }
    };
    // Shadow warmup: the fx PassNode programs bake their lighting setup at first
    // build and never regain ShadowNode afterwards, so shadow maps never render
    // when every frame goes through maxjsFx. One direct render here builds the
    // shared lights node with shadows (lights are already applied); the fx
    // pipeline's programs then inherit it.
    //
    // Compile those pipelines ASYNC first: createRenderPipelineAsync runs on
    // driver worker threads, where a synchronous first render of a heavy scene
    // compiled everything in one GPU-process stall — long enough to freeze
    // video/audio in OTHER tabs. Cap the wait: a heavy scene (30+ materials)
    // can take >10s to fully compile — after the cap the remainder keeps
    // compiling in the background while the scene starts.
    if (typeof renderer.compileAsync === 'function') {
        try {
            await Promise.race([
                renderer.compileAsync(scene, camera),
                new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
        } catch (_) { /* fall through to the warmup render */ }
    }
    renderer.render(scene, camera);
    renderer.setAnimationLoop(loop);
    return () => {
        renderer.setAnimationLoop(null);
        nirSensing.dispose();
    };
}

// ─── boot() ───────────────────────────────────────────────────────────
export async function boot({ root = '.', canvas, options = {} } = {}) {
    if (!canvas) throw new Error('boot(): canvas is required');
    const restoreThreeConsole = installThreeConsoleFilter({ debug: !!options.debug });

    // Phase 1: meta
    const meta = await loadMeta(root);
    const normalizedFeatures = normalizeRuntimeFeatures(meta);
    const features = {
        ...normalizedFeatures,
        renderer_pref: options.rendererBackend != null
            ? normalizeRendererBackend(options.rendererBackend)
            : normalizedFeatures.renderer_pref,
    };

    // Phase 2: renderer
    const renderer = await createRenderer(canvas, features, meta.snapshotUi);
    // True IR emitters are deliberately black in RGB. Install the sensed-band
    // light graph whenever the payload declares one, independent of GI/Studio;
    // PowerShot's NIR gate then reveals it only in infrared/nightshot modes.
    // This must happen before scene materials see their first lighting compile.
    await installSnapshotIrLightGraph(renderer, meta.lights);
    let studioModule = null;
    if (meta.snapshotUi?.studio) {
        try {
            studioModule = await import('./studio_lighting.js');
            if (studioModule.studioStateNeedsMaxLightsNode?.(meta.snapshotUi.studio)) {
                const installed = studioModule.installStudioLightingRenderer?.(renderer);
                if (!installed) {
                    console.warn('[snapshot_boot] light linking requires the WebGPU/TSL renderer');
                }
            }
        } catch (error) {
            console.warn('[snapshot_boot] studio lighting module init failed', error);
        }
    }

    // Phase 3: scene
    const sceneCtx = createScene({ meta, renderer, canvas });
    const { scene, camera, controls, maxBasisRoot, maxRoot, jsRoot, overlayRoot, defaultLights } = sceneCtx;
    const snapshotCameraClip = meta.snapshotUi?.cameraClip ?? null;

    const getViewportAspect = (width, height) => getCanvasAspect(canvas, width, height);

    // Declared here rather than at Phase 4 (where it is populated) purely so
    // resize() below can read it without a temporal-dead-zone risk: a
    // ResizeObserver callback can land during any await between the two
    // points, and a `let` declared later would throw on access rather than
    // read undefined.
    let optionalModules = {};

    const resize = (width, height) => {
        const result = sceneCtx.resize(width, height);
        applyHorizontalFovToVertical(camera, result.aspect);
        applySnapshotCameraClip(camera, snapshotCameraClip);
        // Hand the size change to the fx layer ON THE RESIZE EVENT. Without
        // this the only thing that notices is the per-frame check at the top
        // of snapshot_fx.render(), and that path rebuilds the entire post-FX
        // pipeline — stranding a full set of effect targets on every resize.
        // The viewer has always done this (renderer_core.js calls
        // maxjsFx.resize() from its own resize path); the snapshot host never
        // did, which is the whole difference between the two.
        (optionalModules.maxjsFx ?? optionalModules.ssgiFx)?.resize?.();
        return result;
    };

    const snapshotSceneCameras = Array.isArray(meta.sceneCameras) ? meta.sceneCameras : [];
    const snapshotCameraByHandle = new Map(
        snapshotSceneCameras
            .map(entry => [Number(entry?.h ?? entry?.handle ?? 0), entry])
            .filter(([handle]) => Number.isFinite(handle) && handle > 0),
    );

    function hasPortableCameraState(entry) {
        return [entry?.pos, entry?.tgt, entry?.up]
            .every(value => Array.isArray(value) && value.length >= 3
                && value.slice(0, 3).every(Number.isFinite));
    }

    function applyPortableCameraRecord(record, handle = null) {
        if (!hasPortableCameraState(record)) return false;
        applyTopLevelCamera(record, { camera, controls, getAspect: getViewportAspect });
        camera.userData ??= {};
        camera.userData.maxjsSceneCameraHandle = Number.isFinite(Number(handle))
            && Number(handle) > 0
            ? Number(handle)
            : null;
        camera.userData.maxjsSceneCameraName = String(record?.n ?? record?.name ?? '');
        camera.updateMatrix();
        camera.updateMatrixWorld(true);
        resize();
        applySnapshotCameraClip(camera, snapshotCameraClip);
        return true;
    }

    function applySnapshotLayerCameraMode(mode, { handle } = {}) {
        if (mode === 'physical') {
            const resolvedHandle = Number(handle);
            const record = snapshotCameraByHandle.get(resolvedHandle);
            return applyPortableCameraRecord(record, resolvedHandle);
        }
        if (mode === 'viewport') {
            return applyPortableCameraRecord(meta.camera, Number(meta.activeCamera ?? 0));
        }
        return true;
    }

    // Wire window resize → renderer + camera. Custom-site embedders that
    // host the canvas in a non-fullscreen context can call resize(w, h)
    // directly via the returned player handle. ResizeObserver catches CSS
    // container changes that don't emit window.resize.
    const onResize = () => resize();
    addEventListener('resize', onResize);
    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => resize());
        resizeObserver.observe(canvas);
        if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);
    }

    // Maps populated by the applier in phase 6, consumed by layer manager and animation.
    const nodeMap = new Map();
    const lightHandleMap = new Map();

    // Lights — bound here so phase 7 / phase 6 hooks can both reach in.
    const sceneLights = createSceneLights({ scene, parent: maxRoot, lightHandleMap, nodeMap });

    // Material builder — owns the per-snapshot texture cache and applies
    // export-time bake overrides before meshes enter the scene.
    const materialBuilder = createMaterialBuilder({
        rootUrl: root,
        bakeState: meta.bake ?? meta.snapshotUi?.bake,
        renderer, // enables real TSL node materials + texture baking on the WebGPU target
    });
    // Only preset-authored TSL snippets need the vendored TEXTURES namespace.
    // Snapshots without those snippets intentionally do not bundle this vendor.
    await materialBuilder.loadTslTextures({ required: snapshotNeedsTslTextures(meta) });

    // Authored environment/HDRI from snapshot.json. This stays separate
    // from inlines: script-authored sky belongs to the layer runtime.
    const snapshotEnvironment = createSnapshotEnvironment({
        scene,
        renderer,
        rootUrl: root,
    });
    let authoredLightCount = 0;
    let studioLighting = null;
    let studioLightingRefreshQueued = false;
    const queueStudioLightingRefresh = () => {
        if (studioLightingRefreshQueued) return;
        studioLightingRefreshQueued = true;
        queueMicrotask(() => {
            studioLightingRefreshQueued = false;
            studioLighting?.refreshSceneBindings?.();
        });
    };
    const syncDefaultLights = () => {
        const studioLightingActive = studioLighting?.hasReflectionPaint?.() === true;
        defaultLights.visible = authoredLightCount === 0 && !snapshotEnvironment.isLightingActive() && !studioLightingActive;
    };

    const animationSystem = createMaxJSAnimationSystem({
        THREE,
        nodeMap, lightHandleMap,
        getCamera: () => camera,
        getControls: () => controls,
        getJsRoot: () => jsRoot,
        getOverlayRoot: () => overlayRoot,
        getViewportAspect,
        buildGeometry: (nd, buffer) => geometryFromNodeBinary(nd, buffer),
        applyMaterialScalar: applySnapshotMaterialScalar,
    });

    // Phase 4: layer manager. Getter closures keep the layer surface stable
    // while optional modules are loaded immediately after the manager exists.
    const layerManager = buildLayerManager({
        scene, camera, renderer, THREE,
        nodeMap, lightHandleMap, maxRoot, jsRoot, overlayRoot, controls,
        sceneCameras: snapshotSceneCameras,
        onCameraModeChange: applySnapshotLayerCameraMode,
        getAnimationSystem: () => animationSystem,
        getAudioSystem: () => optionalModules.audio ?? null,
        getGLTFSystem: () => optionalModules.gltf ?? null,
        onRuntimeSceneChanged: queueStudioLightingRefresh,
    });
    bindSnapshotProjectRuntime(layerManager, root);

    // Phase 5: optional modules
    optionalModules = await registerOptionalModules(features, {
        scene, camera, renderer, layerManager, nodeMap, lightHandleMap,
        maxBasisRoot, jsRoot, overlayRoot, meta,
        initialAudioMuted: options.initialAudioMuted === true,
    });

    // Phase 6: apply the metadata-declared M3 payload. Metadata-free exports
    // prefer scene.m3 and fall back once to the pre-M3 scene.bin filename.
    const { buffer } = await fetchSnapshotScenePayload(root, meta);
    const applierCtx = {
        scene, meta, nodeMap, lightHandleMap, maxRoot,
        layerManager, animationSystem, materialBuilder,
        forestMeshes: new Map(),
    };
    await applyDelta(buffer, applierCtx);

    // Lights from snapshot.json (Stage 4). Default lights remain visible
    // only when there are neither authored lights nor authored environment.
    sceneLights.apply(meta.lights);
    authoredLightCount = countVisibleLightPayload(meta.lights);
    syncDefaultLights();

    // Audio source URLs in snapshot.json are relative to the snapshot root.
    // A project site can host the player from a shell page above that root,
    // so rebase them before the audio system fetches buffers.
    optionalModules.audio?.applyAudios(resolveSnapshotAudioUrls(meta.audios ?? [], root));
    optionalModules.gltf?.applyGLTFs(resolveSnapshotGltfUrls(meta.gltfs ?? [], root));

    // Phase 7a: snapshotUi (postfx state, tone-map, exposure, bg)
    if (meta.snapshotUi) {
        applySnapshotUi(meta.snapshotUi, {
            renderer, scene, camera, controls,
            maxjsFx: optionalModules.maxjsFx ?? optionalModules.ssgiFx,
        });
    }

    // Phase 7d: authored environment / HDRI.
    // Explicit only: no default sky is synthesized here.
    const snapshotEnvironmentState = await snapshotEnvironment.apply(
        withSnapshotLinkedSkySun(meta.env, meta.lights),
        meta.snapshotUi,
    );
    if (meta.snapshotUi) {
        if (!snapshotEnvironmentState?.active || !snapshotEnvironmentState?.backgroundVisible) {
            applySnapshotSolidBackground(meta.snapshotUi, scene);
        }
        // HDRI import can author renderer exposure; snapshot UI is the final
        // artist look and must win for exported pages.
        applySnapshotCoreLook(meta.snapshotUi, { renderer });
    }
    // scene.environment lands after the snapshotUi post-FX replay above, so
    // rebuild the FX graph once: env-backdrop compensation (hidden HDRI +
    // ssr/fog) needs the final environment state.
    (optionalModules.maxjsFx ?? optionalModules.ssgiFx)?.notifyEnvironmentChanged?.();
    syncDefaultLights();

    const snapshotSpeedballGi = await createSnapshotSpeedballGi({
        renderer,
        scene,
        snapshotUi: meta.snapshotUi,
    });
    if (snapshotSpeedballGi) optionalModules.speedballGi = snapshotSpeedballGi;

    // Phase 7b: top-level camera state. Lives at meta.camera independently
    // of snapshotUi (which is gated by the "Viewer UI State" export toggle
    // and may be absent). meta.camera shape:
    //   { pos:[x,y,z], tgt:[x,y,z], up:[x,y,z], fov, persp, dofEnabled, ... }
    // Coordinates are in Max world space (Z-up), so they get parented
    // under maxBasisRoot via the camera's existing position math, but
    // OrbitControls.target needs the world-space (Y-up) value.
    if (!applyPortableCameraRecord(meta.camera, Number(meta.activeCamera ?? 0))) {
        resize();
        applySnapshotCameraClip(camera, snapshotCameraClip);
    }

    // Phase 7c: lock state. Snapshots authored with camera-lock active in
    // Max should ship without orbit controls — the snapshot represents a
    // directed view, not a free-orbit demo. Two possible signals:
    //   - meta.snapshotUi.camLock (authoritative when "Viewer UI State" is
    //     in the export)
    //   - meta.lockedCamera != null (proxy — present when the user locked
    //     onto a specific scene camera, even without snapshotUi)
    // Either says locked → disable controls. Custom-site embedders can
    // still call player.controls.enabled = true to override.
    const explicitLock = meta.snapshotUi?.camLock;
    const inferredLock = Number(meta.lockedCamera) > 0;
    const locked = explicitLock === true || (explicitLock !== false && inferredLock);
    if (controls) {
        controls.enabled = !locked;
    }

    if (meta.snapshotUi?.studio && studioModule?.createStudioLightingController) {
        try {
            studioLighting = studioModule.createStudioLightingController({
                renderer,
                scene,
                camera,
                nodeMap,
                lightHandleMap,
                getRenderableMeshes: () => applierCtx.forestMeshes?.values?.() ?? [],
                onSceneChanged: () => (optionalModules.maxjsFx ?? optionalModules.ssgiFx)?.markSceneChanged?.(),
                onOutputChanged: () => (optionalModules.maxjsFx ?? optionalModules.ssgiFx)?.markOutputChanged?.(),
            });
            studioLighting.applyState(meta.snapshotUi.studio);
            syncDefaultLights();
        } catch (error) {
            console.warn('[snapshot_boot] studio lighting apply failed', error);
        }
    }

    // Phase 8: baked runtime fallback. Load it before sidecars so an absent or
    // broken layer module still leaves the exported scene visible.
    let runtimeSceneState = {
        roots: [],
        transformOverrides: [],
        hiddenSourceHandles: new Set(),
        hiddenSourceCount: 0,
    };
    if (meta.runtimeScene) {
        runtimeSceneState = await applyRuntimeScene(meta.runtimeScene, {
            root, jsRoot, overlayRoot, nodeMap,
        });
        studioLighting?.refreshSceneBindings?.();
    }

    // Animation and timeline state must exist before layer init so ctx.anim
    // and ctx.maxTime reflect the exported snapshot from the first hook.
    if (meta.animations) {
        let animationBuffer = null;
        if (meta.animations.bin) {
            const animResp = await fetch(`${root}/${meta.animations.bin}`, { cache: 'no-cache' });
            if (animResp.ok) animationBuffer = await animResp.arrayBuffer();
        }
        animationSystem.loadSnapshotAnimations(meta.animations, animationBuffer);
    }
    if (meta.snapshotUi?.timeline) {
        maxTimeline.initStandalone(meta.snapshotUi.timeline);
    } else {
        maxTimeline.initStandalone({ fps: 30, defaultPlaying: true });
    }

    // Phase 9: layer project. Project sidecars are independent of the baked
    // runtimeScene payload: a snapshot may ship project.maxjs.json + inlines/
    // even when runtimeScene was omitted or empty.
    const layerReplay = await bindLayerProject(root, meta, layerManager, runtimeSceneState);
    restoreSnapshotTransformOverrides(runtimeSceneState, layerReplay.mountedIds, layerManager);
    animationSystem.invalidateTargets();
    studioLighting?.refreshSceneBindings?.();

    // Phase 10: run
    const stopLoop = await startRenderLoop({
        renderer, scene, camera, controls, layerManager,
        animationSystem,
        maxjsFx: optionalModules.maxjsFx ?? optionalModules.ssgiFx,
        snapshotEnvironment,
        optionalModules,
        studioLighting,
        enforceHiddenSources: () => {
            enforceRuntimeHiddenSources(runtimeSceneState.hiddenSourceHandles, nodeMap);
        },
        fpsCap: meta.snapshotUi?.performance?.fpsCap,
    });

    return {
        renderer, scene, camera, controls, layerManager,
        meta, features,
        nodeMap, lightHandleMap,
        maxBasisRoot, maxRoot, jsRoot, overlayRoot, defaultLights,
        sceneLights,
        environment: snapshotEnvironment,
        audioSystem: optionalModules.audio ?? null,
        gltfSystem: optionalModules.gltf ?? null,
        // Post-fx controller (setDofOptions/setSSROptions/…) — uniform-backed
        // options apply live, so site-side motion (zoom focus pulls) can drive
        // them per frame without touching the pipeline.
        postFx: optionalModules.maxjsFx ?? optionalModules.ssgiFx ?? null,
        animationSystem, maxTimeline,
        resize,
        applyDelta: async (newBuffer) => {
            const result = await applyDelta(newBuffer, applierCtx);
            enforceRuntimeHiddenSources(runtimeSceneState.hiddenSourceHandles, nodeMap);
            studioLighting?.refreshSceneBindings?.();
            syncDefaultLights();
            optionalModules.speedballGi?.requestRebuild?.();
            return result;
        },
        applyLights: (lightsData) => {
            const r = sceneLights.apply(lightsData);
            authoredLightCount = countVisibleLightPayload(lightsData);
            studioLighting?.refreshSceneBindings?.();
            syncDefaultLights();
            optionalModules.speedballGi?.requestRebuild?.();
            return r;
        },
        setEnvironmentEnabled: (enabled) => {
            const state = snapshotEnvironment.setEnabled(enabled);
            syncDefaultLights();
            optionalModules.speedballGi?.requestRebuild?.();
            return state;
        },
        setEnvironmentVisible: (visible) => {
            const state = snapshotEnvironment.setBackgroundVisible(visible);
            optionalModules.speedballGi?.requestRebuild?.();
            return state;
        },
        setEnvironmentBackgroundVisible: (visible) => {
            const state = snapshotEnvironment.setBackgroundVisible(visible);
            optionalModules.speedballGi?.requestRebuild?.();
            return state;
        },
        dispose() {
            try { stopLoop(); } catch {}
            try { removeEventListener('resize', onResize); } catch {}
            try { resizeObserver?.disconnect?.(); } catch {}
            try { layerManager?.clear?.(); } catch {}
            try { animationSystem?.clear?.(); } catch {}
            try {
                disposeRuntimeObjects(runtimeSceneState.roots);
                for (const bakedRoot of runtimeSceneState.roots) bakedRoot.parent?.remove(bakedRoot);
                runtimeSceneState.roots.length = 0;
            } catch {}
            for (const module of Object.values(optionalModules ?? {})) {
                try { module?.dispose?.(); } catch {}
            }
            try { snapshotEnvironment.dispose(); } catch {}
            try { studioLighting?.dispose?.(); } catch {}
            try { sceneLights.dispose(); } catch {}
            try {
                const disposedGeometries = new Set();
                const disposedMaterials = new Set();
                for (const mesh of applierCtx.forestMeshes.values()) {
                    mesh.parent?.remove(mesh);
                    if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
                        disposedGeometries.add(mesh.geometry);
                        mesh.geometry.dispose?.();
                    }
                    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                    for (const material of materials) {
                        if (!material || disposedMaterials.has(material)) continue;
                        disposedMaterials.add(material);
                        material.dispose?.();
                    }
                }
                applierCtx.forestMeshes.clear();
            } catch {}
            try { materialBuilder.dispose(); } catch {}
            try { renderer?.dispose?.(); } catch {}
            try { restoreThreeConsole(); } catch {}
        },
    };
}
