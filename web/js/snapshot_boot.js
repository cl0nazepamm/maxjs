// snapshot_boot.js — handwritten standalone snapshot bootstrapper.
//
// Stage 1 deliverable from docs/SNAPSHOT_REFACTOR.md.
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
// STAGE 1 STATUS (this file)
// --------------------------
// Skeleton with stubs. Heavy lifters that currently live inline in
// index.html — scene applier, material builder, renderer init, scene-graph
// math — are stubbed via `requireExtraction()` calls. Future sessions will
// extract them into real modules per the roadmap in SNAPSHOT_REFACTOR.md.
//
// What is wired right now:
//   - Phase 1: real
//   - Phases 2-9: stubbed; throw with a pointer to the extraction work
//   - Phase 10: real once 2-9 land
//
// What WORKS today: nothing renders. This file establishes the contract,
// the file layout, and the import surface so the extraction work in later
// sessions has a stable target.

import * as THREE from 'three/webgpu';
import * as THREE_STD from 'three';
import * as TSL from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createLayerManager } from './layer_manager.js';
import { createAnimationSystem } from './maxjs_animation.js';
import { maxTimeline } from './maxjs_timeline.js';
// Optional modules — imported lazily inside Phase 5 once runtimeFeatures
// declare them. Keep them out of the static import graph so Minimal mode
// does not pay for what the scene does not use.
//   import { createAudioSystem }      from './maxjs_audio.js';
//   import { createGltfRegistry }     from './maxjs_gltf.js';
//   import { createHtmlTextureSlot }  from './html_texture.js';
//   import { createSsgiFx }           from './ssgi_fx.js';
//   import { VolumeRenderer }         from './VolumeRenderer.js';
//   import { createProjectRuntime }   from './project_runtime.js';

// ─── Stub helper ────────────────────────────────────────────────────────
function requireExtraction(name, sourceLocation) {
    const message =
        `[snapshot_boot] '${name}' not yet extracted from index.html ` +
        `(${sourceLocation}). See docs/SNAPSHOT_REFACTOR.md → Implementation order.`;
    throw new Error(message);
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

// ─── Phase 2: renderer (STUB) ──────────────────────────────────────────
// Pure code-motion target: web/index.html lines ~1730-1810 (`createRenderer`,
// `configureRenderer`, `initializeRenderer`). Picks WebGPU > WebGL2 with
// a forceWebGL fallback on init failure.
async function createRenderer(canvas, features) {
    requireExtraction('createRenderer', 'index.html:1730-1810');
}

// ─── Phase 3: scene + camera + controls (STUB) ────────────────────────
// Code-motion target: web/index.html lines ~1565-1860 covering:
//   - the three rooted groups (maxBasisRoot, maxRoot, jsRoot, overlayRoot)
//   - max-basis quaternion / matrix helpers
//   - perspective + ortho cameras with persisted preference
//   - OrbitControls instantiation
function createScene(meta) {
    requireExtraction('createScene', 'index.html:1565-1860');
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

// ─── Phase 5: conditional module registration (STUB) ──────────────────
// Lazy-imports each optional module only when runtimeFeatures asks for it.
// In Stage 1 this is gated and returns nothing usable; the import shape
// below shows the eventual contract.
async function registerOptionalModules(features, ctx) {
    const registered = {};

    // if (features.post_fx?.length) {
    //     const { createSsgiFx } = await import('./ssgi_fx.js');
    //     registered.ssgiFx = createSsgiFx({ ...ctx, enabled: features.post_fx });
    // }
    // if (features.audio) {
    //     const { createAudioSystem } = await import('./maxjs_audio.js');
    //     registered.audio = createAudioSystem(ctx);
    // }
    // ...etc per the optional list at the top of this file.

    requireExtraction('registerOptionalModules', 'index.html:various — ssgiFx, audio, splat, html_texture, volume init');

    return registered;
}

// ─── Phase 6: apply scene.bin (STUB) ──────────────────────────────────
// Code-motion target: web/index.html `handleBinaryScene` at lines 6329-6556
// plus its closure dependencies (planMaxInstanceBuckets, geometry ref
// counting, material resolve helpers, etc.). The big one. Plan to extract
// to js/scene_applier.js.
async function applyDelta(buffer, ctx) {
    requireExtraction('applyDelta', 'index.html:6329-6556 (handleBinaryScene + closure helpers)');
}

// ─── Phase 7: snapshotUi (STUB) ───────────────────────────────────────
// Code-motion targets in index.html:
//   - applyBuildMode
//   - applySavedPostFxPayload
//   - applyStudioState
//   - applyBakeState
//   - applyStandaloneCameraState
//   - syncPostFxPanel
function applySnapshotUi(snapshotUi, ctx) {
    requireExtraction('applySnapshotUi', 'index.html: applyBuildMode / applySavedPostFxPayload / applyStudioState / applyBakeState / applyStandaloneCameraState');
}

// ─── Phase 8: runtimeScene (STUB) ─────────────────────────────────────
// Code-motion target: index.html lines 12174-12365 (runtimeScene parse +
// jsRoot/overlayRoot replay + TSL material rebind + transformOverrides).
async function applyRuntimeScene(runtimeScene, ctx) {
    requireExtraction('applyRuntimeScene', 'index.html:12174-12365');
}

// ─── Phase 9: layer project bind ──────────────────────────────────────
// Mirrors index.html `tryReplaySnapshotLayerModules` (lines 12213-12267).
// Snapshot mode imports every layer in the manifest regardless of the
// `enabled` flag — disable is a live-mode concept only.
async function bindLayerProject(root, meta, layerManager) {
    requireExtraction('bindLayerProject', 'index.html:12213-12267 (tryReplaySnapshotLayerModules)');
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
    const sceneCtx = createScene(meta);
    const { scene, camera, controls, maxRoot, jsRoot, overlayRoot } = sceneCtx;

    // Maps populated by the applier in phase 6, consumed by layer manager and animation.
    const nodeMap = new Map();
    const lightHandleMap = new Map();

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
    await applyDelta(buffer, { scene, meta, nodeMap, lightHandleMap, maxRoot });

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
        animationSystem, maxTimeline,
        applyDelta: (newBuffer) => applyDelta(newBuffer, { scene, meta, nodeMap, lightHandleMap, maxRoot }),
        dispose() {
            try { stopLoop(); } catch {}
            try { renderer?.dispose?.(); } catch {}
            try { renderer?.domElement?.remove?.(); } catch {}
        },
    };
}
