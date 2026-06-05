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
//   root      string  — folder containing snapshot.json + scene.bin (e.g. '.')
//   canvas    HTMLCanvasElement — render target
//   options   object  — { rendererBackend?: 'webgpu' | 'webgl', debug?: boolean }
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
//   6. Apply scene.bin
//   7. Apply snapshotUi block (tone mapping, exposure, env, fog, postfx state)
//   8. Apply runtimeScene block (baked Object3D JSON)
//   9. Bind layer project (inlines/ + project.maxjs.json)
//  10. Run (setAnimationLoop)
//
// STAGE 5 STATUS (this file)
// --------------------------
// Real code:    1 (meta), 2 (renderer), 3 (scene/camera/controls),
//               4 (layer manager), 6 (applier with simple-PBR materials
//               via material_builder.js), 7 partial (tone-map/exposure/
//               bg/camera + scene lights via scene_lights.js), 9 (layer
//               project bind), 10 (render loop), animation + timeline.
// Deferred:     5 (optional modules — warns and continues),
//               7 fx/studio/bake (warns), 8 runtimeScene (warns),
//               TSL / MaterialX / VRay / OpenPBR / Toon material types
//               (degrade to MeshStandardMaterial), instance buckets,
//               vertex colors, fog, splats/gltf.
//
// What WORKS today: snapshots with Max-authored meshes render with PBR
// materials — color, roughness, metalness, opacity, emissive, plus the
// six common map slots (diffuse / normal / roughness / metalness / AO /
// emissive). Multi/sub-object materials honor their groups. Lights from
// snapshot.json drive shading; shadows render for shadow-casters.
// Skinned meshes assemble (Skeleton + bind pose). Animations tick.
//
// What's MISSING (visible regressions vs. live mode): TSL / MaterialX /
// VRay / OpenPBR materials (degrade to MeshStandardMaterial), post-FX,
// splats, instance bucket merging, vertex colors.

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
import { createSceneLights } from './scene_lights.js';
import { createSnapshotEnvironment } from './snapshot_environment.js';
import { createMaterialBuilder } from './material_builder.js';
import { copyMaxArrayToWorld, copyMaxComponentsToWorld } from './max_basis.js';
import { geometryFromNodeBinary } from './scene_binary.js';
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
// scene.bin without the applier). `noteExtractionDeferred` is the
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
        splats: true,
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
        splats: !!raw.splats,
        html_textures: !!(raw.html_textures ?? raw.htmlTextures),
        volumes: !!raw.volumes,
        physics: !!raw.physics,
        gltf: !!(raw.gltf ?? raw.gltfs),
        animations: !!raw.animations,
        environment: !!(raw.environment ?? raw.hdri ?? raw.sky),
        geospatial_sky: !!(raw.geospatial_sky ?? raw.geospatialSky),
        binary_instances: !!(raw.binary_instances ?? raw.binaryInstances),
        exports: raw.exports && typeof raw.exports === 'object' ? raw.exports : {},
        counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : {},
    });
}

function normalizeRendererBackend(value) {
    const raw = String(value || '').toLowerCase();
    if (raw.includes('webgpu')) return 'webgpu';
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
    const response = await fetch(`${root}/snapshot.json`, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`snapshot.json fetch failed: HTTP ${response.status}`);
    }
    const meta = await response.json();
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
    return false;
}

// ─── Phase 2: renderer ─────────────────────────────────────────────────
// WebGL2 snapshot renderer. WebGPU is a separate explicit target, not a
// transparent fallback, because backend switching changes material behavior.
async function createRenderer(canvas, features) {
    const backend = normalizeRendererBackend(features?.renderer_pref);
    const { renderer, backendLabel } = await createRendererImpl(canvas, { backend });
    renderer.userData ??= {};
    renderer.userData.maxjsBackendLabel = backendLabel;
    return renderer;
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
        debugLog: (...args) => console.debug('[snapshot_boot]', ...args),
        debugWarn: (...args) => console.warn('[snapshot_boot]', ...args),
    });
}

// ─── Phase 5: conditional module registration ─────────────────────────
// Lazy-imports each optional module only when runtimeFeatures asks for it.
// Stage 2: skipped unconditionally with a deferred-extraction note. Empty
// snapshots and pure-Three.js host pages (where the user wires their own
// post-FX) work fine without this. Real wiring lands once each subsystem's
// init/dispose lifecycle is documented and stubs in index.html are
// replaced with the same lazy imports.
async function registerOptionalModules(features, ctx) {
    const wanted = [];
    if (features.post_fx?.length)  wanted.push('post_fx');
    if (features.splats)           wanted.push('splats');
    if (features.html_textures)    wanted.push('html_textures');
    if (features.volumes)          wanted.push('volumes');
    if (features.physics)          wanted.push('physics');
    if (wanted.length) {
        noteExtractionDeferred(
            'registerOptionalModules',
            'index.html — MaxJS FX / audio / splat / html_texture / volume init',
            `(scene declares: ${wanted.join(', ')})`,
        );
    }

    const modules = {};
    const hasAudioPayload = Array.isArray(ctx?.meta?.audios) && ctx.meta.audios.length > 0;
    if (features.audio || hasAudioPayload) {
        try {
            const { createMaxJSAudioSystem } = await import('./maxjs_audio.js');
            modules.audio = createMaxJSAudioSystem({
                THREE,
                parent: ctx.maxBasisRoot ?? ctx.scene,
                getActiveCamera: () => ctx.renderer?.xr?.isPresenting
                    ? ctx.renderer.xr.getCamera(ctx.camera)
                    : ctx.camera,
            });
        } catch (error) {
            console.warn('[snapshot_boot] audio module init failed', error);
        }
    }

    return modules;
}

// ─── Phase 6: apply scene.bin ──────────────────────────────────────────
// Stage 3: real applier landed. js/scene_applier.js does the geometry
// build / mesh creation / transform / removal pass. Defaults give every
// node a flat MeshStandardMaterial — visible but uncolored. Real material
// fidelity (PBR maps, TSL, MaterialX, VRay/OpenPBR mapping) lives in
// js/material_builder.js once it's extracted from index.html.
async function applyDelta(buffer, ctx) {
    const meta = ctx?.meta;
    if (meta?.type !== 'scene_bin') {
        console.warn('[snapshot_boot] meta.type is not "scene_bin"; skipping applier.');
        return;
    }
    if ((meta.nodes?.length ?? 0) === 0) {
        console.info('[snapshot_boot] empty scene.bin (0 nodes) — applier no-op.');
        return;
    }
    return applySceneBin({
        buffer,
        meta,
        ctx: {
            nodeMap: ctx.nodeMap,
            maxRoot: ctx.maxRoot,
            scene: ctx.scene,
            renderer: ctx.renderer,
            rendererBackendLabel: ctx.renderer?.userData?.maxjsBackendLabel,
            forestMeshes: ctx.forestMeshes,
            lastInstanceBucketSignature: '',
        },
        hooks: {
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
            markRuntimeTransformsDirty: () => {
                ctx.layerManager?.markRuntimeTransformsDirty?.();
            },
            finalizeSceneSnapshot: () => {
                ctx.animationSystem?.invalidateTargets?.();
            },
        },
    });
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
// Bake overrides are consumed by material_builder during scene.bin apply.
// The deeper post stack and studio lighting are still intentionally out of
// the lightweight snapshot boot path.
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

    // Defer the rest.
    if (snapshotUi.studio) {
        noteExtractionDeferred(
            'applySnapshotUi (studio)',
            'index.html applyStudioState',
            '(core look and bake overrides applied; studio lighting skipped)',
        );
    }
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
// Stage 2: deferred. Full implementation reuses index.html's ObjectLoader
// path (with NodeMaterial → standard-material rewrite) and the TSL re-bind
// pass. None of that is useful without phase 6 anyway, so noting and
// continuing is correct here.
async function applyRuntimeScene(runtimeScene, ctx) {
    noteExtractionDeferred(
        'applyRuntimeScene',
        'index.html:12174-12365',
        '(jsRoot/overlayRoot baked Object3D JSON + TSL re-bind + transform overrides)',
    );
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
        }));
}

async function bindLayerProject(root, meta, layerManager) {
    let manifest = null;
    let baseUrl = new URL('./', new URL(`${root}/`, location.href));
    let allLayers = [];

    try {
        const manifestUrl = new URL('./project.maxjs.json', baseUrl);
        const response = await fetch(manifestUrl, { cache: 'no-store' });
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
    if (allLayers.length === 0) return { mounted: 0, manifest };

    const mountedIds = [];
    try {
        for (const entry of allLayers) {
            if (entry?.enabled === false) continue;
            const entryPath = String(entry.entryPath || entry.entry || entry.path || '').replace(/\\/g, '/');
            if (!entryPath) throw new Error(`Missing layer entry path for ${entry.id}`);
            const moduleUrl = new URL(entryPath, baseUrl);
            moduleUrl.searchParams.set('v', `${Date.now()}_${entry.id}`);
            const moduleNamespace = await import(moduleUrl.toString());
            const factory = resolveSnapshotLayerFactory(moduleNamespace);
            const result = await layerManager.mount(
                entry.id,
                async (ctx, THREE_arg) => factory(ctx, THREE_arg, { manifest, layer: entry }),
                {
                    name: entry.name || entry.id,
                    code: moduleUrl.toString(),
                    source: entry.source || 'project',
                    entry: entry.entryPath,
                },
            );
            if (result?.error) throw new Error(result.error);
            mountedIds.push(entry.id);
        }
        return { mounted: mountedIds.length, manifest };
    } catch (error) {
        console.warn('[snapshot_boot] layer module replay failed', error);
        for (const id of mountedIds) {
            try { layerManager.remove(id); } catch {}
        }
        return { mounted: 0, manifest, error };
    }
}

// ─── Phase 10: render loop ────────────────────────────────────────────
function startRenderLoop({ renderer, scene, camera, controls, layerManager, animationSystem, maxjsFx, snapshotEnvironment, optionalModules }) {
    let lastTimeMs = performance.now();
    let elapsed = 0;
    const loop = () => {
        const nowMs = performance.now();
        const dt = Math.min(0.25, Math.max(0, (nowMs - lastTimeMs) / 1000));
        lastTimeMs = nowMs;
        elapsed += dt;
        if (controls) controls.update();
        layerManager?.update?.(dt, elapsed);
        animationSystem?.update?.(dt);
        for (const module of Object.values(optionalModules ?? {})) {
            module?.update?.(dt, elapsed);
        }
        snapshotEnvironment?.update?.(dt, elapsed, camera);

        layerManager?.beforeRender?.(elapsed);
        try {
            // Default render path. MaxJS FX (when present) takes over.
            if (maxjsFx?.isEnabled?.()) {
                maxjsFx.render();
            } else {
                renderer.render(scene, camera);
            }
        } finally {
            layerManager?.afterRender?.(elapsed);
        }
    };
    renderer.setAnimationLoop(loop);
    return () => renderer.setAnimationLoop(null);
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
    const renderer = await createRenderer(canvas, features);

    // Phase 3: scene
    const sceneCtx = createScene({ meta, renderer, canvas });
    const { scene, camera, controls, maxBasisRoot, maxRoot, jsRoot, overlayRoot, defaultLights } = sceneCtx;
    const snapshotCameraClip = meta.snapshotUi?.cameraClip ?? null;

    const getViewportAspect = (width, height) => getCanvasAspect(canvas, width, height);
    const resize = (width, height) => {
        const result = sceneCtx.resize(width, height);
        applyHorizontalFovToVertical(camera, result.aspect);
        applySnapshotCameraClip(camera, snapshotCameraClip);
        return result;
    };

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
        camera,
        rootUrl: root,
        allowGeospatialSky: !!features.geospatial_sky,
    });
    let authoredLightCount = 0;
    const syncDefaultLights = () => {
        defaultLights.visible = authoredLightCount === 0 && !snapshotEnvironment.isLightingActive();
    };

    // Phase 4: layer manager
    const layerManager = buildLayerManager({
        scene, camera, renderer, THREE,
        nodeMap, lightHandleMap, maxRoot, jsRoot, overlayRoot, controls,
        sceneCameras: Array.isArray(meta.sceneCameras) ? meta.sceneCameras : [],
    });

    const animationSystem = createMaxJSAnimationSystem({
        THREE,
        nodeMap, lightHandleMap,
        getCamera: () => camera,
        getControls: () => controls,
        getJsRoot: () => jsRoot,
        getOverlayRoot: () => overlayRoot,
        getViewportAspect,
        buildGeometry: (nd, buffer) => geometryFromNodeBinary(nd, buffer),
    });

    // Phase 5: optional modules
    const optionalModules = await registerOptionalModules(features, {
        scene, camera, renderer, layerManager, nodeMap, lightHandleMap,
        maxBasisRoot, jsRoot, overlayRoot, meta,
    });

    // Phase 6: apply scene.bin
    const binResp = await fetch(`${root}/${meta.bin || 'scene.bin'}`, { cache: 'no-store' });
    if (!binResp.ok) throw new Error(`scene.bin fetch failed: HTTP ${binResp.status}`);
    const buffer = await binResp.arrayBuffer();
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
    syncDefaultLights();

    // Phase 7b: top-level camera state. Lives at meta.camera independently
    // of snapshotUi (which is gated by the "Viewer UI State" export toggle
    // and may be absent). meta.camera shape:
    //   { pos:[x,y,z], tgt:[x,y,z], up:[x,y,z], fov, persp, dofEnabled, ... }
    // Coordinates are in Max world space (Z-up), so they get parented
    // under maxBasisRoot via the camera's existing position math, but
    // OrbitControls.target needs the world-space (Y-up) value.
    applyTopLevelCamera(meta.camera, { camera, controls, getAspect: getViewportAspect });
    resize();
    applySnapshotCameraClip(camera, snapshotCameraClip);

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
    const inferredLock = meta.lockedCamera != null;
    const locked = explicitLock === true || (explicitLock !== false && inferredLock);
    if (controls) {
        controls.enabled = !locked;
    }

    // Phase 8: runtimeScene
    if (meta.runtimeScene) {
        await applyRuntimeScene(meta.runtimeScene, {
            scene, jsRoot, overlayRoot, layerManager, meta, nodeMap,
        });
    }

    // Phase 9: layer project. Project sidecars are independent of the baked
    // runtimeScene payload: a snapshot may ship project.maxjs.json + inlines/
    // even when runtimeScene was omitted or empty.
    await bindLayerProject(root, meta, layerManager);

    // Animation tracks
    if (meta.animations) {
        let animationBuffer = null;
        if (meta.animations.bin) {
            const animResp = await fetch(`${root}/${meta.animations.bin}`, { cache: 'no-store' });
            if (animResp.ok) animationBuffer = await animResp.arrayBuffer();
        }
        animationSystem.loadSnapshotAnimations(meta.animations, animationBuffer);
    }

    // Standalone timeline — no Max bridge, drive locally.
    if (meta.snapshotUi?.timeline) {
        maxTimeline.initStandalone(meta.snapshotUi.timeline);
    } else {
        maxTimeline.initStandalone({ fps: 30, defaultPlaying: true });
    }

    // Phase 10: run
    const stopLoop = startRenderLoop({
        renderer, scene, camera, controls, layerManager,
        animationSystem,
        maxjsFx: optionalModules.maxjsFx ?? optionalModules.ssgiFx,
        snapshotEnvironment,
        optionalModules,
    });

    return {
        renderer, scene, camera, controls, layerManager,
        meta, features,
        nodeMap, lightHandleMap,
        maxBasisRoot, maxRoot, jsRoot, overlayRoot, defaultLights,
        sceneLights,
        environment: snapshotEnvironment,
        audioSystem: optionalModules.audio ?? null,
        animationSystem, maxTimeline,
        resize,
        applyDelta: (newBuffer) => applyDelta(newBuffer, applierCtx),
        applyLights: (lightsData) => {
            const r = sceneLights.apply(lightsData);
            authoredLightCount = countVisibleLightPayload(lightsData);
            syncDefaultLights();
            return r;
        },
        setEnvironmentEnabled: (enabled) => {
            const state = snapshotEnvironment.setEnabled(enabled);
            syncDefaultLights();
            return state;
        },
        setEnvironmentVisible: (visible) =>
            snapshotEnvironment.setBackgroundVisible(visible),
        setEnvironmentBackgroundVisible: (visible) =>
            snapshotEnvironment.setBackgroundVisible(visible),
        dispose() {
            try { stopLoop(); } catch {}
            try { removeEventListener('resize', onResize); } catch {}
            try { resizeObserver?.disconnect?.(); } catch {}
            try {
                for (const module of Object.values(optionalModules ?? {})) {
                    module?.dispose?.();
                }
            } catch {}
            try { snapshotEnvironment.dispose(); } catch {}
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
