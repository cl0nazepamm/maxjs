# Three.js r187 migration

Based on the official [186 → 187 migration guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide#186--187)
and [r187 release notes](https://github.com/mrdoob/three.js/releases/tag/r187).

## Runtime and features

- Pin npm Three to `0.187.0`; editor, both snapshot entrypoints and native snapshot export use `vendor/three-r187`.
- Renderer backends: classic `WebGLRenderer` (WebGL mode) and `WebGPURenderer` (WebGPU, falling back to its WebGL2 backend, "TSL_GL"). The spectral render mode is gone.
- **Probe GI** (`js/light_probes.js`, editor glue `js/editor/light_probe_glue.js`): stock r187 irradiance probe grids on every renderer — `LightProbeGrid` on `WebGPURenderer`, `LightProbeGridWebGL` on `WebGLRenderer`. Max **Light Probe Grid** helpers (class ID unchanged; formerly "Speedball GI Probe Grid") set the grid volumes; without one the grid fits the visible meshes. Grids bake in time slices into staging grids that swap in once every bounce pass is done; scene, light and environment edits rebake once the scene rests (never during playback). While a grid lights the scene it owns the HDRI's diffuse irradiance (`environment_lighting.js`), because it captured the environment with occlusion. Snapshots export the settings and world-space volumes and rebake at boot.
- **GI lightmaps** (`js/lightmap_baker.js`, node renderers): r187 `LightMapper` bakes the probe grids' irradiance into per-mesh lightmaps on Max map channel 2 (`uv1`), sized by surface area. They apply through the bake system's per-mesh material instances; file lightmap overrides win while enabled. Lightmapped materials skip the probe grid in `MaxLightsNode` so bounce is not counted twice, and probe captures mute GI lightmaps so a rebake does not feed on its own output. Channel 2 UVs are outside the host's geometry change hash, so enabling lightmaps or a manual Rebake requests `sync_lightmap_uvs`.
- **Path tracing** (`js/editor/path_tracer.js`, glue `js/editor/pathtracing_glue.js`): three-gpu-pathtracer's `WebGPUPathTracer` (the tracer r187's `webgpu_renderer_pathtracer` example uses) replaces the spectral tracer. Native WebGPU only, live-viewer only. Edits flow through `updateTransforms` / `updateMaterials` / `updateLights` / `updateEnvironment`, in-place deformation refits the existing BVH, and new geometry rebuilds through `setScene`. The renderer rollout maps **Render samples** to Render to Image / Sequence capture samples, **Max bounces** to `maxBounces` and **GI clamp** to `clampIndirect`.
- **Speedball GI removed:** its probe field, surfel volume, BLAS cache and geometry content keys, sky feed, native `gi_surface_bin` / `gi_light_bin` / `gi_probe_refresh` packets and the snapshot replay. IR illuminators (`userData.emitterClass`) are plain lights gated by color in `js/ir_emitters.js`: black until PowerShot infrared/NightShot senses NIR, then white × illuminator gain, on every renderer.

## Migration guide items

- `Light.registerNode()` replaces `NodeLibrary.addLight()` / `getLightNodeClass()`: `sky_parameters.js` registers `SunLightNode` once; `MaxLightsNode` resolves per-light nodes through `light._lightNode`, like upstream `LightsNode`.
- r187 refactored `DynamicLightsNode` to build per-instance data nodes in `setLights()`. `MaxLightsNode` keeps its renderer-shared data nodes, calls `LightsNode.setLights` directly, and now keys its program from upstream `LightsNode.customCacheKey` (adds the shadow-version hashing from #35019) over its non-batched lights.
- PMREMs on cube render targets, `setViewport` / `setScissor` with a bound render target, `pixelationPass`, struct storage buffers, `iridescenceThicknessRange` and the r177 removals (`transformedNormal*`, `ColorManagement.{from,to}WorkingColorSpace`): no max.js usage.

## Vendor provenance

`vendor/three-r187/build` is `three@0.187.0` from npm, unmodified. The three r186
build patches are gone: the `ContextNode.setup()` backport (#34531) and the
`getSharedContext()` loop-state deletes (#34650) ship in r187, and the shadow
pipeline churn patch (#34647) was closed upstream in favor of #35232, which ships
in r187 (the source material is now part of override-pass render object keys).
The DREAM `Plane001` churn has not been re-measured on r187.

Upstream `examples/jsm` is stored as `examples` to preserve max.js import-map
layout, plus the `examples/materialx` regression fixtures. Libraries npm does not
ship (ammo, rhino3dm, ecsy, lottie, opentype, draco_encoder) are no longer vendored.
The only edited upstream r187 addon files:

| File under `examples/` | Retained compatibility fix |
| --- | --- |
| `tsl/display/TemporalReprojectNode.js` | Size history from source depth and copy depth only on an exact size match. |
| `tsl/display/RecurrentDenoiseNode.js` | Size denoise history from source depth in a reduced-resolution chain. |
| `tsl/display/TRAANode.js` | Copy previous depth only when the history target matches the depth source. |
| `loaders/materialx/MaterialXSurfaceMappings.js` | Convert opacity to float instead of indexing it; stock r187 still emits `0.7[0u]` for scalar opacity. |

Stock r187 temporal nodes still size from the drawing buffer (also on `dev`), so a
post stack at a reduced resolution scale fails WebGPU's full-subresource depth copy
rule (`tools/temporal-resize.playwright.js`). The r186 MaterialX normal-map edits
(`MaterialXDocument.js`, `MaterialXNodeLibrary.js`) are dropped: r187's loader passes
the Max-exported nested normal map pixel comparison unmodified.

`vendor/three-gpu-pathtracer` is three-gpu-pathtracer `main` at `1df8ec7b8a`
(2026-10-31, the r187 port; unreleased — 0.0.27 still binds struct storage buffers
the r186 way). It peers on `three-mesh-bvh` `0.9.17` from `web/node_modules`.

## App-side safeguards still present

Carried over from the r186 audit; not re-audited for r187 unless noted.

| Area | Why retained |
| --- | --- |
| `js/fx/viewport_registry.js` | Per-render-target viewport texture clones still require explicit eviction. |
| `js/fx/core.js` | Retire the whole pipeline on graph changes; retain the stale-graph safeguard and detached temporal-texture cleanup. |
| `js/fx/effects/ssgi.js` | Retain the `rg11b10ufloat-renderable` device check for the GI target. |
| `js/editor/renderer_core.js` | Request supported device limits needed by large scenes. |
| `js/gpu_normals.js` | Keep compute normals disabled while storage-buffer preparation mutates itemSize-3 attributes. |
| `js/editor/boot.js` | Keep per-material environment intensity policy and asynchronous Inspector detach/timestamp shutdown. |
| `js/max_lights_node.js` | Keep observer/light-linking markers, finite point/spot handling and volumetric link bypass. |
| `js/environment_lighting.js` | HDRI diffuse split hook; audited against r187 `EnvironmentNode.setup()`, now on both node backends. |
| Material/environment loaders | Keep pending-texture binding guards, PMREM render-target ownership wrappers, and EXR `m44f` warning filtering. |

## Verification

- Build `maxjs` Release (`build.bat 2027` here; Max 2026 is not installed on this machine).
- `node tools/check_esm_graph.mjs` and the node smokes in `tools/*-smoke.mjs`.
- Browser regressions: start `node tools/split_smoke_server.mjs 8901`, open it with `playwright-cli`, then `run-code --filename=` each of `tools/three-r187.playwright.js`, `tools/three-r187-materialx.playwright.js`, `tools/temporal-resize.playwright.js`, `tools/light-probes.playwright.js` and `tools/lightmap-pathtracer.playwright.js`.

The browser checks render retroreflection, clouds and sun shadows on WebGPU, TSL_GL
and classic WebGL; exercise SSR/SSGI/GTAO/DOF/TRAA and SSR denoising on both node
backends, also while resizing at a reduced resolution scale; compile the MaterialX
fixtures per node backend with Max-export pixel comparisons; bake probe grids on all
three backends (bounce reaches an unlit wall, staged swap, disable); bake GI lightmaps
on both node backends; and accumulate, update and capture the path tracer on WebGPU.
They do not replace a long-running GPU-memory soak.
