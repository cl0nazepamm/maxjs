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
//               vertex colors, env/HDRI/sky/fog, splats/audio/gltf.
//
// What WORKS today: snapshots with Max-authored meshes render with PBR
// materials — color, roughness, metalness, opacity, emissive, plus the
// six common map slots (diffuse / normal / roughness / metalness / AO /
// emissive). Multi/sub-object materials honor their groups. Lights from
// snapshot.json drive shading; shadows render for shadow-casters.
// Skinned meshes assemble (Skeleton + bind pose). Animations tick.
//
// What's MISSING (visible regressions vs. live mode): TSL / MaterialX /
// VRay / OpenPBR materials (degrade to MeshStandardMaterial), HDRI/sky
// environment, post-FX, splats, audio playback, instance bucket merging,
// vertex colors.

import * as THREE from 'three/webgpu';
import * as THREE_STD from 'three';
import * as TSL from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createLayerManager } from './layer_manager.js';
import { createAnimationSystem } from './maxjs_animation.js';
import { maxTimeline } from './maxjs_timeline.js';
import { createRenderer as createRendererImpl, createScene as createSceneImpl } from './scene_init.js';
import { applySceneBin } from './scene_applier.js';
import { createSceneLights } from './scene_lights.js';
import { createMaterialBuilder } from './material_builder.js';
// Optional modules — imported lazily inside Phase 5 once runtimeFeatures
// declare them. Keep them out of the static import graph so Minimal mode
// does not pay for what the scene does not use.
//   import { createAudioSystem }      from './maxjs_audio.js';
//   import { createGltfRegistry }     from './maxjs_gltf.js';
//   import { createHtmlTextureSlot }  from './html_texture.js';
//   import { createSsgiFx }           from './ssgi_fx.js';
//   import { VolumeRenderer }         from './VolumeRenderer.js';
//   import { createProjectRuntime }   from './project_runtime.js';

// ─── Stub helpers ──────────────────────────────────────────────────────
// `requireExtraction` is reserved for paths that genuinely cannot proceed
// without the extraction landing (e.g. trying to apply a non-empty
// scene.bin without the applier). `noteExtractionDeferred` is the
// warn-and-continue variant used by phases where skipping is acceptable
// for the empty/minimal snapshot path that Stage 2 supports.
function requireExtraction(name, sourceLocation) {
    const message =
        `[snapshot_boot] '${name}' not yet extracted from index.html ` +
        `(${sourceLocation}). See docs/SNAPSHOT_REFACTOR.md → Implementation order.`;
    throw new Error(message);
}

function noteExtractionDeferred(name, sourceLocation, detail = '') {
    const tail = detail ? ` ${detail}` : '';
    console.warn(
        `[snapshot_boot] '${name}' not yet extracted from index.html ` +
        `(${sourceLocation}); skipping in Stage 2.${tail}`,
    );
}

// ─── Default features — used when runtimeFeatures block is absent ──────
// Matches the old "load everything" behavior so existing snapshots that
// predate runtimeFeatures keep working. The exporter will populate this
// block in a later session and the wrapper will tighten its imports.
function detectFeaturesLegacy(meta) {
    return Object.freeze({
        renderer_pref: meta?.snapshotUi?.rendererBackend ?? 'webgpu',
        post_fx: ['ssgi'], // index.html always wires ssgiFx today
        audio: !!meta?.audioNodes?.length,
        splats: !!meta?.splats?.length,
        html_textures: !!meta?.htmlTextures?.length,
        volumes: !!meta?.volumes?.length,
        physics: false,
        three_addons: ['OrbitControls'],
    });
}

// ─── Phase 1: metadata ─────────────────────────────────────────────────
async function loadMeta(root) {
    const response = await fetch(`${root}/snapshot.json`, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`snapshot.json fetch failed: HTTP ${response.status}`);
    }
    return response.json();
}

// ─── Phase 2: renderer ─────────────────────────────────────────────────
// Slim WebGPU > WebGL2 picker with forceWebGL fallback. Lives in
// js/scene_init.js. Pref source: runtimeFeatures.renderer_pref ('webgpu' default).
async function createRenderer(canvas, features) {
    const backend = features?.renderer_pref === 'webgl' ? 'webgl' : 'webgpu';
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
function buildLayerManager({ scene, camera, renderer, THREE, nodeMap, lightHandleMap, maxRoot, jsRoot, overlayRoot }) {
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
    if (features.audio)            wanted.push('audio');
    if (features.splats)           wanted.push('splats');
    if (features.html_textures)    wanted.push('html_textures');
    if (features.volumes)          wanted.push('volumes');
    if (features.physics)          wanted.push('physics');
    if (wanted.length) {
        noteExtractionDeferred(
            'registerOptionalModules',
            'index.html — ssgiFx / audio / splat / html_texture / volume init',
            `(scene declares: ${wanted.join(', ')})`,
        );
    }
    return {};
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
            lastInstanceBucketSignature: '',
        },
        hooks: {
            materialBuilder: ({ nd, geom, wantsLine }) =>
                ctx.materialBuilder.buildForNode({ nd, geom, wantsLine }),
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

// ─── Phase 7: snapshotUi ───────────────────────────────────────────────
// Stage 2 partial. Honors the simple, side-effect-free fields here:
//   - tone mapping & exposure on the renderer
//   - background color on the scene
//   - basic camera position/target if present
// The complex bits (postfx state restore, studio lighting, bake state)
// require their corresponding modules to land first; they are flagged via
// noteExtractionDeferred and skipped.
function applySnapshotUi(snapshotUi, ctx) {
    const { renderer, scene, camera, controls } = ctx;

    // Tone mapping
    const tm = snapshotUi.toneMapping;
    if (tm && THREE[tm.type] != null) {
        renderer.toneMapping = THREE[tm.type];
    }
    if (Number.isFinite(snapshotUi.exposure)) {
        renderer.toneMappingExposure = snapshotUi.exposure;
    }

    // Background — accept hex int or [r,g,b]
    const bg = snapshotUi.background;
    if (typeof bg === 'number') {
        scene.background = new THREE.Color(bg);
    } else if (Array.isArray(bg) && bg.length === 3) {
        scene.background = new THREE.Color(bg[0], bg[1], bg[2]);
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
            camera.updateProjectionMatrix();
        }
    }

    // Defer the rest.
    if (snapshotUi.fx || snapshotUi.studio || snapshotUi.bake) {
        noteExtractionDeferred(
            'applySnapshotUi (full)',
            'index.html applySavedPostFxPayload / applyStudioState / applyBakeState',
            '(simple tone-map/exposure/bg/camera applied; postfx/studio/bake skipped)',
        );
    }
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
// Snapshot mode imports EVERY layer in the manifest regardless of the
// `enabled` flag — disable is a live-mode concept only. The exporter
// already trims disabled layers out of the shipped folder when the user
// wants them gone.
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
    return rawLayers.map((entry, index) => ({
        id: entry?.id || entry?.name || `layer_${index}`,
        name: entry?.name || entry?.id || `layer_${index}`,
        entryPath: entry?.entry || entry?.path || 'main.js',
        source: 'project',
        enabled: entry?.enabled !== false,
    }));
}

function buildSnapshotInlineLayers(runtimeScene) {
    const rawLayers = Array.isArray(runtimeScene?.layers) ? runtimeScene.layers : [];
    return rawLayers
        .filter(entry => entry?.source === 'inline' && entry?.entry)
        .map((entry, index) => ({
            id: entry.id || entry.name || `inline_${index}`,
            name: entry.name || entry.id || `inline_${index}`,
            entryPath: entry.entry,
            source: 'inline',
            enabled: entry.active !== false,
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
            allLayers = buildSnapshotManifestLayers(manifest);
        }
    } catch {
        manifest = null;
    }

    if (allLayers.length === 0) {
        allLayers = buildSnapshotInlineLayers(meta.runtimeScene);
    }
    if (allLayers.length === 0) return { mounted: 0, manifest };

    const mountedIds = [];
    try {
        for (const entry of allLayers) {
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
function startRenderLoop({ renderer, scene, camera, controls, layerManager, ssgiFx, optionalModules }) {
    const inlineClock = new THREE.Clock();
    const loop = () => {
        const dt = inlineClock.getDelta();
        if (controls) controls.update();
        if (layerManager?.beforeRender) layerManager.beforeRender(dt);

        // Default render path. ssgiFx (when present) takes over.
        if (ssgiFx?.isEnabled?.()) {
            ssgiFx.render();
        } else {
            renderer.render(scene, camera);
        }

        if (layerManager?.afterRender) layerManager.afterRender(dt);
    };
    renderer.setAnimationLoop(loop);
    return () => renderer.setAnimationLoop(null);
}

// ─── boot() ───────────────────────────────────────────────────────────
export async function boot({ root = '.', canvas, options = {} } = {}) {
    if (!canvas) throw new Error('boot(): canvas is required');

    // Phase 1: meta
    const meta = await loadMeta(root);
    const features = meta.runtimeFeatures ?? detectFeaturesLegacy(meta);

    // Phase 2: renderer
    const renderer = await createRenderer(canvas, features);

    // Phase 3: scene
    const sceneCtx = createScene({ meta, renderer, canvas });
    const { scene, camera, controls, maxBasisRoot, maxRoot, jsRoot, overlayRoot, defaultLights, resize } = sceneCtx;

    // Wire window resize → renderer + camera. Custom-site embedders that
    // host the canvas in a non-fullscreen context can call resize(w, h)
    // directly via the returned player handle.
    const onResize = () => resize(innerWidth, innerHeight);
    addEventListener('resize', onResize);

    // Maps populated by the applier in phase 6, consumed by layer manager and animation.
    const nodeMap = new Map();
    const lightHandleMap = new Map();

    // Lights — bound here so phase 7 / phase 6 hooks can both reach in.
    const sceneLights = createSceneLights({ scene, lightHandleMap });

    // Material builder — owns the per-snapshot texture cache.
    const materialBuilder = createMaterialBuilder({ rootUrl: root });

    // Phase 4: layer manager
    const layerManager = buildLayerManager({
        scene, camera, renderer, THREE,
        nodeMap, lightHandleMap, maxRoot, jsRoot, overlayRoot,
    });

    const animationSystem = createAnimationSystem({
        nodeMap, lightHandleMap,
        getCamera: () => camera,
        getJsRoot: () => jsRoot,
        getOverlayRoot: () => overlayRoot,
    });

    // Phase 5: optional modules
    const optionalModules = await registerOptionalModules(features, {
        scene, camera, renderer, layerManager, nodeMap, lightHandleMap,
        jsRoot, overlayRoot,
    });

    // Phase 6: apply scene.bin
    const binResp = await fetch(`${root}/${meta.bin || 'scene.bin'}`, { cache: 'no-store' });
    if (!binResp.ok) throw new Error(`scene.bin fetch failed: HTTP ${binResp.status}`);
    const buffer = await binResp.arrayBuffer();
    const applierCtx = {
        scene, meta, nodeMap, lightHandleMap, maxRoot,
        layerManager, animationSystem, materialBuilder,
    };
    await applyDelta(buffer, applierCtx);

    // Lights from snapshot.json (Stage 4). Default lights remain visible
    // only when the scene declares none; once env/HDRI extraction lands
    // this condition tightens further.
    const lightsResult = sceneLights.apply(meta.lights);
    defaultLights.visible = lightsResult.count === 0;

    // Phase 7: snapshotUi
    if (meta.snapshotUi) {
        applySnapshotUi(meta.snapshotUi, {
            renderer, scene, camera, controls,
            ssgiFx: optionalModules.ssgiFx,
        });
    }

    // Phase 8: runtimeScene
    if (meta.runtimeScene) {
        await applyRuntimeScene(meta.runtimeScene, {
            scene, jsRoot, overlayRoot, layerManager, meta, nodeMap,
        });
    }

    // Phase 9: layer project
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
        ssgiFx: optionalModules.ssgiFx,
        optionalModules,
    });

    return {
        renderer, scene, camera, controls, layerManager,
        maxBasisRoot, maxRoot, jsRoot, overlayRoot, defaultLights,
        sceneLights,
        animationSystem, maxTimeline,
        resize,
        applyDelta: (newBuffer) => applyDelta(newBuffer, applierCtx),
        applyLights: (lightsData) => {
            const r = sceneLights.apply(lightsData);
            defaultLights.visible = r.count === 0;
            return r;
        },
        dispose() {
            try { stopLoop(); } catch {}
            try { removeEventListener('resize', onResize); } catch {}
            try { sceneLights.dispose(); } catch {}
            try { materialBuilder.dispose(); } catch {}
            try { renderer?.dispose?.(); } catch {}
        },
    };
}
