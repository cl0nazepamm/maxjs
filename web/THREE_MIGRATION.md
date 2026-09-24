# Three.js r186 migration

Based on the official [185 → 186 migration guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide#185--186)
and [r186 release notes](https://github.com/mrdoob/three.js/releases/tag/r186).

## Runtime and features

- Pin npm Three to `0.186.0`; editor, both snapshot entrypoints and native snapshot export use `vendor/three-r186`.
- Update `postprocessing` to `^6.39.5` for r186 peer compatibility and clean npm installs.
- Physical material: **Retroreflection / Strength** (`physicalRetroreflectivity` in Max, `retroreflectivity` in scene JSON). Includes live scalar updates and snapshot animation. Default zero preserves existing materials.
- Sky map: cloud coverage, density, scale and elevation; optional **Cascaded shadows** using native `SunLight` on all three backends. Shadow distance uses viewer scene units. Clouds and sun shadows default off. Clouds stay static; existing approximate sky lighting/reflections remain.
- Rename the classic GI grid to `LightProbeGridWebGL`; remove obsolete GTAO distance controls and `Sky.up`/`SkyMesh.upUniform` assignments.
- New Max parameter IDs are appended; retired IDs remain reserved.

## Vendor provenance

`vendor/three-r186/build` is `three@0.186.0` from npm with one backported
upstream fix and two local fixes filed upstream as open PRs (all below). Upstream
`examples/jsm` is stored as `examples` to preserve max.js import-map layout.
Existing extra decoder/encoder libraries and `examples/materialx` regression
fixtures are retained. The only edited upstream r186 addon files are below.

| File under `examples/` | Retained compatibility fix |
| --- | --- |
| `tsl/display/TemporalReprojectNode.js` | Size history from source depth and guard copies whose extents differ during resize. Upstream still sizes from the drawing buffer. |
| `tsl/display/RecurrentDenoiseNode.js` | Size denoise history from source depth in a reduced-resolution chain. |
| `tsl/display/TRAANode.js` | Skip an incompatible previous-depth copy during resize. |
| `loaders/materialx/MaterialXSurfaceMappings.js` | Convert opacity to float instead of indexing it. Stock r186 emits invalid scalar indexing for existing scalar-opacity documents; reproduced on WebGPU and TSL_GL. Color opacity still selects its first component. |
| `loaders/materialx/MaterialXDocument.js` | Carry the normalmap-result marker through references/type conversions. |
| `loaders/materialx/MaterialXNodeLibrary.js` | Avoid decoding Max's nested normalmap wrappers twice. Keep r186's world-space normal calculation and surface transform. |

The temporal fixes retain their inline max.js comments; MaterialX edits are also
marked inline. Recheck these six files against upstream on the next upgrade.

**Build backport — `build/three.webgpu.js` and `build/three.webgpu.nodes.js`,
`ContextNode.setup()`:** drop the `return node;` that r186 added. Upstream
`f6080cc6f0` ("ContextNode: Avoid redundant calls", #34251) made `setup()` return
the child's build result; on context-heavy graphs that re-runs subgraph setup, and
Speedball GI's traversal kernel went from 52 ms (r185) to ~8 s of synchronous
node building on r186 — DREAM's boot freeze. Found by bisecting 220 upstream
commits; `a32e4d658c` ("Nodes: Make build more efficient", #34531, 2026-09-11)
removes the `return` again, and this hunk is exactly that part of it. Drop the
backport when upgrading to a release that contains `a32e4d658c` (r187+). The
same bytes are mirrored to `clone-llc/vendor/three-r186/build/three.webgpu.js`.

**Build fix — same two files, `NodeBuilder.getSharedContext()`:** also delete
`nodeLoop` and `nodeBlock` (marked inline `max.js:`). Nodes that build a separate
material from `context( builder.getSharedContext() )` (`RTTNode`, SSGI, DOF, …)
inherited the parent's loop state when first set up inside a `Loop` body. DOF
samples its `convertToTexture()` input only inside `Loop( 64 )`, so an SSGI
composite under DOF built its whole material "inside a loop" and every top-level
`.toVar()` re-added itself to the stack being iterated — an infinite main-thread
loop (plastic-botanic never loaded; 26M → 41M stack nodes in 8 s). r186 made it
reachable by moving SSGI's shared context onto `material.contextNode` (#34025).
Filed upstream as [#34650](https://github.com/mrdoob/three.js/pull/34650) (open;
§21 in `docs/THREEJS_UPSTREAM_PR_CANDIDATES.md`) — the same two lines. Drop when a
release contains it. Mirrored to the clone-llc copy like the backport above.

**Build fix — same two files, `Renderer.renderObject()`:** a shadow override pass
without a `passId` now derives one from the resolved shadow side (`_shadowPassIds`,
marked inline `max.js:`). The shared shadow material's `side` is set per draw, and
all groups of a multi-material caster share one shadow RenderObject; with mixed
sides the render cache key flipped between groups and a new render pipeline was
created synchronously every frame (DREAM `Plane001`: ~120/s, forever). Separate
RenderObjects per side keep both pipelines cached. DREAM: 492 → 2 synchronous
`createRenderPipeline` calls per load, shadows unchanged. The two code lines are
exactly those of the open upstream PR
[#34647](https://github.com/mrdoob/three.js/pull/34647) (§20); only the comment
differs (marker). Drop when a release contains it. Mirrored to the clone-llc copy.

## Removed or reduced patches

- **SSR:** use unmodified r186 `SSRNode`. The old numeric-cast vendor change is removed; SSR and denoising render on WebGPU and TSL_GL at reduced resolution.
- **DOF:** remove `stabilizeDofSetup` and the manual CoC-blur reaper. Upstream now constructs and disposes the blur node ([PR #34188](https://github.com/mrdoob/three.js/pull/34188)). Keep max.js alpha composition and ownership of input RTT nodes.
- **MaterialX:** replace the old loader fork with r186's loader/modules, keeping only the compatibility edits listed above. Max's scalar-plus-map weighting and legacy IOR alias move to shared `js/materialx_compat.js`, used by editor and snapshot loading. This expresses weights as standard MaterialX multiplication and keeps zero-weight lobes disabled.
- **HDRI:** replace the copied `EnvironmentNode.setup` body with `js/environment_lighting.js`, a small diffuse-intensity hook around upstream setup. This preserves r186 specular/retroreflection behavior.
- **PostFX disposal:** let r186 `PassNode`, `RTTNode` and `RenderPipeline` release their own render targets/materials. Keep cleanup for detached temporal textures and explicit ownership of factory-created RTT inputs.

## App-side safeguards still present

| Area | Why retained |
| --- | --- |
| `js/fx/viewport_registry.js` | Per-render-target viewport texture clones still require explicit eviction. |
| `js/fx/core.js` | Retire the whole pipeline on graph changes; retain the historical stale-graph safeguard and detached temporal-texture cleanup. Long-duration leak elimination is not claimed by this migration. |
| `js/fx/effects/ssgi.js` | r186 still uses `UnsignedInt101111Type` for GI; retain the `rg11b10ufloat-renderable` device check. |
| `js/editor/renderer_core.js` | Request supported device limits needed by large scenes. |
| `js/gpu_normals.js` | Keep compute normals disabled while Three storage-buffer preparation mutates itemSize-3 attributes. |
| `js/editor/boot.js` | Keep per-material environment intensity policy and asynchronous Inspector detach/timestamp shutdown. r186 Inspector disposal does not restore timestamp tracking. |
| `js/max_lights_node.js` | Keep observer/light-linking markers, finite point/spot handling and volumetric link bypass. These are max.js behavior and regression protections. |
| Material/environment loaders | Keep pending-texture binding guards, PMREM render-target ownership wrappers, and EXR `m44f` warning filtering. |

The older local `docs/THREEJS_UPSTREAM_PR_CANDIDATES.md` is a historical r185
inventory. This file records the r186 migration decisions; retained historical
safeguards are not claims of newly reproduced upstream defects.

## Verification

- Build `maxjs` Release with the Max 2026 SDK. Installation into a running Max session is separate.
- `node tools/check_esm_graph.mjs`
- `node tools/volumetric-light-source-smoke.mjs`
- Runtime lifecycle, mesh reuse, surface sampling, vanilla runtime and M3 protocol smokes.
- `node tools/snapshot-runtime-parity-smoke.mjs`
- Browser regression: start `node tools/split_smoke_server.mjs 8901`, open that URL with `playwright-cli`, then run `tools/three-r186.playwright.js` and `tools/three-r186-materialx.playwright.js` with `run-code --filename=...`.

The browser checks render retroreflection, clouds and sun shadows with pixel
readback on WebGPU, TSL_GL and classic WebGL; exercise SSR/SSGI/GTAO/DOF/TRAA and
SSR denoising on both node backends; compile 24 MaterialX fixtures per node
backend; and compare pixels for Max-exported weighted/disabled lobes and nested
normal maps. These checks do not replace a newly exported scene from the native
plugin or a long-running GPU-memory soak.
