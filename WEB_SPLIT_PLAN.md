# web/index.html Split Plan

Status: IN PROGRESS (2026-07-07). Waves 0 and 1 are DONE:
- Wave 0: `tools/check_esm_graph.mjs` (import/export graph tripwire) +
  `tools/split_smoke_server.mjs` / `split_smoke_shim.js` (boot smoke gate:
  serve web/ shimmed, assert ready handshake + zero page errors). Baseline was
  fully clean — 0 console errors/warnings; keep it that way.
- Wave 1: inline module script moved verbatim to `web/js/editor/boot.js`
  (index.html 17,002 → 456 lines; only import specifiers rewritten);
  `host_bridge.js` extracted (bridge core, handshake, requestHostAction,
  typed shared-buffer routing via onSharedBuffer/onSharedBufferFallback);
  minimal `context.js`; `web/HOST_CONTRACT.md` written (web root — `docs/` is
  gitignored at any depth, and the contract should travel with the web/
  submodule anyway); ready handshake stamps `contractVersion: 1`.
Next: Wave 2 (webxr, splats, render_capture, pathtracing_glue).

Line numbers below refer to the pre-split tree (~17,000 lines); they have
drifted — anchor on function names, not line numbers.

Goal (per AGENTS.md "Multi-platform: Python route"): reduce `web/index.html` to
markup + importmap + a thin boot module, with all editor logic in ES modules
under `web/js/editor/`, and the host boundary formalized so Max (WebView2),
Blender (webview2_shim.js), and the future standalone app are interchangeable
hosts. Adding a host must never again require edits to core `web/`.

## What is actually in index.html today

| Region | Lines (approx) | Content |
|---|---|---|
| Head bootstrap | 8–54 | Standalone check: no `chrome.webview` → redirect to `snapshot(.webgpu).html`. Runs pre-module, must stay inline. |
| Body markup | 57–333 | Panel/menu DOM. Stays in HTML. |
| Classic scripts | 333–334 | `startup_gate.js`, `viewport_menu.js`. Already external. |
| Importmap | 347–453 | Vendor three-rNNN mappings. Stays in HTML. |
| Module script | 454–17000 | 49 imports (~30 already from `./js/`), 576 top-level functions, ~400 module-level `const`/`let`. This is what we split. |

The repo already has the target shape in two places: `snapshot.html` (218 lines,
boots via `js/snapshot_boot.js`) and the existing factory modules
(`createLayerManager(...)`, `createCanvasPanel(...)`, etc.). The split follows
that established pattern — factory functions receiving a context — not a new one.

## The two load-bearing design rules

### 1. The editor context (`js/editor/context.js`)

~400 module-level vars can't become 20 modules of tangled imports. Instead:

- One `ctx` object created in the boot module. Cross-cutting mutable state
  lives on it: `ctx.renderer`, `ctx.scene`, `ctx.activeCamera`, `ctx.controls`,
  `ctx.postFx`, `ctx.bridge`, flags, etc.
- Each extracted module is a factory: `export function createSky(ctx) { ... return api; }`.
  State used by only that subsystem moves INTO the module as private state.
  Only genuinely shared state goes on `ctx`.
- Modules register their public API onto ctx in boot wiring
  (`ctx.sky = createSky(ctx)`), and call each other only through `ctx.*`.
- **RULE: never destructure or alias mutable ctx fields at module scope.**
  `const { renderer } = ctx` at top of a module captures a stale reference the
  first time the renderer is rebuilt (backend switch does exactly this).
  Always `ctx.renderer` at call time. This is the #1 expected bug class.
- Import direction is one-way: `context.js` and `host_bridge.js` import nothing
  from subsystems; subsystems import leaf utils only; all wiring happens in
  boot. No subsystem imports another subsystem — that's what ctx is for.

### 2. The host contract (`js/editor/host_bridge.js`)

What the Blender shim already reverse-documents becomes the explicit, versioned
contract. A host provides:

- `window.chrome.webview` with `addEventListener('message'|'sharedbufferreceived')`,
  `postMessage`, `releaseBuffer` (no-op ok), before the head bootstrap runs.
- Shared-buffer payloads: `scene_bin`, `delta_bin`, `gi_surface_bin` (+ meta JSON).
- JSON control messages: the 23 `bridge.on(...)` types (`scene`, `cam`, `xform`,
  `geo_fast`, `hair_fast`, `env_update`, `live_sync_settings`,
  `pathtracing_settings`, `render_to_image`, `host_action_result`, ...).
- The viewer emits `{type:'ready'}` handshake and `requestHostAction(action, data)`
  round-trips.

`host_bridge.js` owns: the `bridge` object (on/dispatch), handshake + ready
retry, `requestHostAction`, `reportBridgeError`, base64 helpers, the
WebView2/sharedbuffer event wiring, standalone fallback text, and
`window.maxJS` assignment. It exports `createHostBridge()` and a
`HOST_CONTRACT_VERSION`. Individual `bridge.on(...)` registrations do NOT move
here — they stay with their subsystems (scene sync registers `scene`/`xform`,
snapshot module registers `snapshot_export_request`, etc.).

Add `web/HOST_CONTRACT.md` describing the above, and stamp
`contractVersion` into the ready handshake so hosts can assert compatibility.
The head bootstrap (standalone redirect) stays inline in index.html but is
documented as part of the contract (the shim must be injected before it).

## Target modules

All under `web/js/editor/`. Names final unless noted. Ranges = current
first..last anchor functions.

| # | Module | Anchors (today) | ~Lines | Owned state examples |
|---|---|---|---|---|
| 1 | `host_bridge.js` | `bridge` def, `toBase64Utf8`..`reportBridgeError`, webview wiring block | 350 | handshake timers, pending host actions |
| 2 | `renderer_core.js` | `getEffectivePixelRatio`..`createRenderer`, `getViewportFrameRect`..`applyRenderViewportLayout`, `isWgl2FallbackBackendActive`..`getNextRendererPipelineMode`, `restartWithRendererBackend` | 900 | backend prefs, pixel-ratio state |
| 3 | `environment.js` | `loadEnvironmentTexture`, `getEnvironmentBackgroundMap`..`resetEnvironmentLighting`, `loadHDRI`..`syncHdriPanel`, HDRI IndexedDB stash | 900 | env maps, local-HDRI object URLs, PMREM retention |
| 4 | `sky.js` | `addSkyProbeSample`..`updateSkyAmbientLightProbe`, `skyNumber`..`removeSky` | 800 | sky mesh/params, sky probe scratch |
| 5 | `gi_volume_glue.js` | `clampHaloGiNumber`..`installStudioGiConsoleHandle`, `supportsWebGLLightProbeGrid`..`updateLightProbeFromHDRI`, `giVolumeNowMs`..`noteGiVolumeCameraSync`, `buildHaloProbeVolumes`..`setProbeHelpersVisible` | 1200 | haloGiSettings, giVolume debounce serials/tokens, probe helpers |
| 6 | `pathtracing_glue.js` | `isPathTracingViewActive`..`applyPathTracingSettings` | 300 | PT warmup/schedule state |
| 7 | `splats.js` | `queueSplatMutation`..`applySplatUpdates` | 200 | splat viewer handle, tracked splats |
| 8 | `texture_pipeline.js` | `normalizeTextureTransform`..`createHTMLTextureOverrideMaterial` (incl. MaterialX templates, video, bake-texture loaders, HTML texture sizing) | 1050 | texture caches, template cache, bake-load failures |
| 9 | `materials.js` | `rememberMaterialEmissiveBase`..`createMaterial`, `createSceneMaterial`..`ensureSceneRenderableMaterial`, registry fns | 1400 | materialRegistry, disposal queue, template cache keys |
| 10 | `bake_system.js` | `normalizeBakeState`..`applyBakeOverridesToSceneMaterial`, `withBakePersistenceSuppressed`..`rebuildBakePanel` | 1100 | bakeOverrides, uv2 resync timers, proxy renderer |
| 11 | `scene_sync.js` | `finalizeSceneNode`..`profileSceneNodes`, `finalizeSceneSnapshot`, `handleBinaryScene`..`applyMaterialScalar` (geometry build, xform, instance buckets) | 1600 | node/geometry maps, instance buckets, sync epochs |
| 12 | `lights.js` | `isShadowMapOriginObject`..`applyLights`, `applyLightUpdates`, `setLightLinkPanelVisible`..`rebuildLightLinkPanel` | 1350 | light registry/ids, helpers, shadow origin cache |
| 13 | `scene_extras.js` | hair `createHairBladeGeometry`..`applyHairInstances`, forest `getForestBinaryFloatView`..`applyForestInstances`, volumes `createSmokePalette`..`updateVolumeUniforms` | 700 | hair/forest entries, volume meshes. Split into 3 files later if it grows. |
| 14 | `camera_system.js` | `updateSceneCameraList`..`syncOrbitNavigationFeel` (incl. standalone camera state, fitCamera) | 600 | camera list, lock state, orbit feel params |
| 15 | `snapshot_export.js` | `sanitizeSnapshotSettings`..`serveSnapshotWithSettings` + diagnostics overlay | 650 | snapshot settings, diagnostics overlay state |
| 16 | `panels_misc.js` | rail buttons, clay/ascii modes, reflection paint panel, studio persistence, layers/web-panels/shader-lab/canvas visibility, dock width | 1300 | per-panel visibility + persistence timers. Candidate to split further; start as one. |
| 17 | `postfx_glue.js` | `applyCoreToneMappingState`, `exposureLinearToEv`..`restorePostFxState`, `syncProjectPostFxState` | 2100 | tone-mapping state, slider modes, persistence suppression |
| 18 | `webxr.js` | `createWebXRRuntime` | 370 | XR session state |
| 19 | `render_loop.js` | `renderViewerFrame`, `renderFrame` | 380 | frame timing, per-frame flags |
| 20 | `render_capture.js` | css3d mask fns, `renderCurrentFrameOnce`..`finishRenderImageFrame` | 430 | capture state machine |
| 21 | `boot.js` + `context.js` | imports, env patches (`patchEnvironmentNodeDiffuseSplit`), ctx creation, factory wiring, `window.maxJS.*` handle assignments, inspector/debug tail | 600 | ctx itself |

Residual `index.html`: head bootstrap + markup + importmap + `<script type="module" src="./js/editor/boot.js">` ≈ **550 lines**.

## Extraction order

Bridge-first, then leaves inward, UI panels late, render loop last. Each step =
one module out, editor verified, one commit (user commits — agents don't).

**Wave 0 — guardrails (half a session)**
- `tools/check_esm_graph.mjs`: walks `web/js/**` import graph, verifies every
  named import resolves to a real export (per prior lesson: `node --check`
  misses missing exports). Run after every extraction.
- Browser smoke: serve `web/` + a ~100-line test shim (crib from
  `maxjs-blender/maxjs_blender/webview2_shim.js`), load a golden
  snapshot.json/scene.bin, assert zero console errors + a rendered frame.
  Automatable via playwright/chrome-devtools MCP. This is the per-step gate;
  launching Max is the per-wave gate.
- Export a golden snapshot from a real Max scene now (pre-split) for parity
  diffing at each wave boundary.

**Wave 1 — the seam:** `context.js`, `host_bridge.js`, `boot.js` skeleton.
index.html's module script becomes importable content loaded by boot; bridge
extracted; `HOST_CONTRACT.md` written; contractVersion stamped. Verify in Max
AND with the Blender shim (this wave is the only one that can break the shim's
injection assumptions).

**Wave 2 — self-contained subsystems:** `webxr.js`, `splats.js`,
`render_capture.js`, `pathtracing_glue.js`. Small owned-state clusters, few
cross-calls. Builds confidence in the ctx pattern cheaply.

**Wave 3 — environment stack:** `texture_pipeline.js`, `environment.js`,
`sky.js`, `gi_volume_glue.js`. These four cross-call heavily (HDRI → probe →
sky → GI); extract in that order within one wave so the churn is contained.

**Wave 4 — scene core:** `materials.js`, `bake_system.js`, `lights.js`,
`scene_sync.js`, `scene_extras.js`, `camera_system.js`. The riskiest wave —
`handleBinaryScene`/`handleBinaryDelta` and material lifecycle are the hot
paths (30–60 Hz; change-detection guards in `finalizeSceneSnapshot` handlers
are load-bearing — move them verbatim, no "cleanup" in the same commit).
Verify with the 3M-poly perf baseline scene before/after.

**Wave 5 — UI:** `renderer_core.js`, `snapshot_export.js`, `postfx_glue.js`,
`panels_misc.js`. Big but mechanical; postfx persistence must round-trip
(`project.maxjs.json` / `postfx.maxjs.json` save+restore unchanged).

**Wave 6 — the loop + tail:** `render_loop.js`, finalize `boot.js`, delete the
inline script. Full pass: Max live editing, Blender IPR, snapshot export +
standalone replay of the golden scene, WGL2/WebGPU/TSL_GL backend switching,
render-to-image.

## Rules during the split

- **Move code verbatim.** No renames, no cleanups, no param removals in
  extraction commits (".max file compat: stop removing parameters"). Refactors
  come after, as separate commits.
- Render-mode gating (Standard vs Spectral contract) stays in editor glue
  modules — never migrates into `web/vendor/**`.
- Exports use a single bottom `export { ... }` block per module (repo facade
  convention).
- One extraction per commit; run `check_esm_graph` + browser smoke before each
  commit request. Never leave the tree half-extracted at session end
  (uncommitted-tree clobber risk with parallel agents is documented and real).
- `snapshot_boot.js`/`snapshot*.html` share extracted modules where they
  already duplicate logic (texture loading, materials) — but ONLY after the
  editor extraction of that module is verified; don't couple both migrations
  in one step.
- Line numbers in this doc go stale immediately; re-grep anchors
  (`grep -n "function <name>"`) before each wave.

## Risks

| Risk | Mitigation |
|---|---|
| Stale captured references after renderer/camera swap | ctx-access-at-call-time rule; grep extracted modules for `= ctx.` aliasing at module scope |
| Hidden cross-cluster state (var used by 3 subsystems but named like one) | before each wave, grep every moved identifier across the remaining inline script; promote to ctx if hit count > own module |
| TDZ/order bugs (inline script relied on hoisting across 16k lines) | boot wiring makes init order explicit; keep factory call order = original code order within a wave |
| Hot-path regression in Wave 4 | perf HUD numbers on the 3M-poly baseline before/after; no logic changes in move commits |
| Blender shim breakage | shim only touches Wave 1 surface; run maxjs-blender viewer-contract smoke test at every wave boundary anyway |
| Parallel-agent tree clobber mid-split | commit per extraction; check `git status` before starting a step |
