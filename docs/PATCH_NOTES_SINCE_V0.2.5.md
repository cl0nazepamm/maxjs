# max.js Release Notes 0.5.0

Baseline: `v0.2.5`, commit `5fb28463` (`Fix studio lighting state refresh`, 2026-05-04).

Current committed range summarized here:

```text
v0.2.5..HEAD
45 commits
67 files changed, 34300 insertions(+), 19876 deletions(-)
```

This is a release-note draft for the next public build after `v0.2.5`. It was prepared from git history, the current README, realtime-sync docs, snapshot docs, and the current working tree. The final section lists changes currently in the working tree that are not committed yet.

## Headline

This release turns MaxJS from a live viewer with export experiments into a more complete production runtime: scene-local layers, deployable snapshots, binary snapshot animation, WebGPU/WGL2/TSL_GL renderer isolation, live-only path tracing, improved material and bitmap handling, robust bake override export, Multi/Sub fixes, video texture improvements, and 1:1 normal extraction parity with 3ds Max.

## Major Highlights

- **Deployable snapshots:** `snapshot.html`, `snapshot_webgpu.html`, and `web/js/snapshot_boot.js` now form a real standalone boot path for exported scenes.
- **Runtime layers:** scene-local `project.maxjs.json` plus `inlines/*.js` are documented and replayed in snapshots when exported.
- **Renderer modes:** WGL2, WebGPU, and TSL_GL are explicit user-facing modes; path tracing is restored as a live-only preview mode.
- **Sync stability:** fast native callbacks, material scalar fastsync, slow JSON debug sync, and interactive polling rules were tightened.
- **Material fidelity:** V-Ray texture sync, Multi/Sub material mapping, separated sub-material payloads, video textures, HTML textures, bake overrides, and PBR snapshot replay all improved.
- **Geometry fidelity:** binary snapshot packing, vertex animation, high-poly update behavior, and 3ds Max normal extraction parity were improved.
- **Codebase structure:** the C++ plugin and web runtime were split into smaller modules.

## Runtime, Layers, And Scene APIs

### Scene-local runtime guidance

`c775fd8` added `skills/maxjs-runtime/SKILL.md`, documenting the runtime contract for scene scripts and agents:

- authored Max data is read through `ctx.maxScene`
- JS-owned objects are created and cleaned up through `ctx.js`
- scene-local layers live beside the `.max` scene under `project.maxjs.json` and `inlines/`
- snapshot parity is a first-class rule for runtime layers
- synced Max transforms must be changed through the runtime transform override API, not raw Three.js object transforms

### Camera and layer APIs

`224b797` and `f350569` exposed scene cameras to layers and cleaned up camera ownership:

- `ctx.camera.listSceneCameras()`
- `ctx.camera.findSceneCamera(name, { exact })`
- `ctx.camera.usePhysicalCamera(handleOrEntry)`
- `ctx.camera.usePhysicalCameraByName(name, { exact })`

The layer manager now has a cleaner boundary between Max-authored scene data and JS-owned runtime objects.

### Webapp and CSS3D layers

`07c7410` added:

- `web/js/css3d_overlay.js`
- `web/js/webapp_layer.js`

These are the first dedicated modules for controlled web/CSS overlay behavior without folding that code back into the main viewer file.

## Renderer Pipeline

### Explicit renderer modes

The README now describes the runtime as having three normal renderer pipelines:

- `WGL2`
- `WebGPU`
- `TSL_GL`

`9259628` routed the WebGL viewer path through the modern renderer stack and isolated the older legacy WebGL path to VR-specific usage. This reduces mode-crossing behavior and keeps user-facing renderer labels clear.

### Live-only path tracing

Path tracing moved through a few states after `v0.2.5`:

- `7093d64` added path tracing
- `986fd1b` removed the first merge from master
- `305a199` reintroduced path tracing as a live viewer mode
- `192a247` improved path tracer sync behavior

Current release-facing status:

- path tracing is live-viewer-only
- it does not participate in snapshot export
- it is separate from the normal WGL2/WebGPU/TSL_GL export contract

## Realtime Sync

### Slow JSON debug sync

`e142d35` added a `SLOW` sync mode. The realtime-sync docs now define it as a debug mode, not sync-off:

- native fast callbacks/material churn are disabled
- lightweight JSON `xform` polling continues
- existing transforms, camera, lights, splats, audio, and glTF state still update
- topology, structure, and texture edits should still be validated in normal `LIVE` mode

### Material event fastsync

`92ddbd7` restored material event fastsync and richer material scalar updates:

- structural material edits still trigger full sync
- scalar material edits can fastsync
- richer native Three.js material fields can ride a JSON `mat_fast` overlay
- Multi/Sub scalar fastsync remains conservative

### Viewer sync polling stability

`4cee88f` and the follow-up docs refresh tightened the polling model:

- redraw-driven checks are preferred for interactive operations
- timer polling is a fallback and safety net
- heavy polling is suppressed during interaction
- slow sync is documented separately from normal `LIVE` fastsync

## Geometry, Normals, And Packing

### High-poly update behavior

`7a3ce15` improved native high-poly handling and V-Ray texture sync. The native side now avoids oversized geometry delta work more carefully when objects cross expensive thresholds.

### Binary snapshot packing and animation

`48dca66` and `1158838` expanded binary snapshot support:

- packed scene payloads carry more compact typed arrays
- `scene_anim.bin` supports optional binary animation data
- snapshot readers in `web/js/scene_binary.js` and `web/js/maxjs_animation.js` understand the packed fields
- runtime replay no longer needs to inflate everything through slow JSON paths

### Normal extraction parity

`705249e` fixed MaxJS normal extraction to match 3ds Max much more closely, especially implicit/ngon normals.

`ab8dae9` then trimmed the normal sync fast path so the normal parity fix does not slow the common sync path. The important rule is that normals are extracted accurately when geometry is serialized, while the realtime delta path avoids sending stale or redundant normal data when it is not needed.

## Materials, Textures, And Maps

### V-Ray and bitmap metadata

`7a3ce15` improved V-Ray texture sync and high-poly geometry updates. The release-facing effect is better map metadata and transform information reaching the browser runtime.

### HTML textures

`017613a` and `1736f4b` improved HTML texture runtime support:

- more robust HTML texture loading
- improved pointer/interaction routing
- Max-side opacity and override behavior
- UV-aspect auto-fit for assigned surfaces
- safer generated texture dimensions

### Video textures

`3caf959` fixed the first major video-texture path:

- video MIME types are returned by the asset host
- HTTP Range requests are honored for media
- plain bitmap paths pointing at video files are routed to the video texture loader

The working tree currently contains an additional WebGPU video texture guard; see the pending section below.

### Multi/Sub and separated material fixes

`1158838` and `4e89b3b` fixed important Multi/Sub cases:

- separated meshes preserve `groups` and `mats`
- `geo_fast` reapplies separated material state correctly
- sub-object material IDs are mapped to Multi/Sub slots using Max's 1-based material ID behavior before fallback modulo handling

This fixes cases where Max data was correct but the viewer collapsed or misapplied material groups.

## Bake Overrides

### Bake texture loading

`582320e` fixed bake override texture loading:

- async bake texture loads are cached
- failed loads fail closed instead of leaving stale output
- bake overrides reapply after texture load completes
- output invalidation is triggered after bake state changes

### Bake export and deployment

`65a9617`, `e8f7617`, `cc0e887`, `4586919`, `61ac7f3`, and `a20eeeb` improved bake export:

- bake override state is included in snapshot export
- bake assets are copied more safely
- copied bake directories are filtered by extension
- beauty bake proxy encoding was added
- UV routing can be selected from map filename suffixes like `_UV1` and `_UV2`
- undefined bake UV routing falls back to UV2
- beauty bake UV export was optimized

The current behavior documented in the README is that snapshots carry viewer UI state, camera clipping, HDRI/post-FX state, and scene-local project sidecars where enabled.

## Standalone Snapshot Runtime

The snapshot refactor landed across:

```text
c6d1905 Snapshot refactor stage 1: boot contract + wrapper
e23154d Snapshot refactor stage 2: scene_init, scene_binary, max_basis
42dfbd7 Snapshot refactor stage 3: minimal-viable scene applier
8e5d26b Snapshot refactor stage 4: scene lights
147e855 Snapshot refactor stage 5: simple PBR material builder
6610373 Fix snapshot boot cleanup and resize handling
f1a4ce1 Fix snapshot inline sidecar replay
48dca66 Add binary snapshot animation features
```

Release-facing snapshot improvements:

- canonical wrappers: `web/snapshot.html` and `web/snapshot_webgpu.html`
- reusable boot contract in `web/js/snapshot_boot.js`
- renderer setup in `web/js/scene_init.js`
- binary reader in `web/js/scene_binary.js`
- scene replay in `web/js/scene_applier.js`
- light replay in `web/js/scene_lights.js`
- sky/environment replay in `web/js/scene_sky.js` and `web/js/snapshot_environment.js`
- PBR material replay in `web/js/material_builder.js`
- inline sidecar replay from `project.maxjs.json` and `inlines/`
- snapshot polling/reload behavior in the wrapper pages

This is the biggest user-facing export change since `v0.2.5`.

## Sky, Environment, And Post FX

`46ecf81` fixed the renderer sky pipeline and added geospatial sky support:

- `web/js/geospatial_sky.js`
- `web/js/scene_sky.js`
- `web/js/snapshot_environment.js`
- updated `SkyMesh.js`
- native sky resource updates

The README now describes classic Three.js sky plus geospatial atmosphere where supported by the active renderer mode. Directional sunlight can be linked to sky azimuth/elevation.

Post-FX documentation was refreshed to reflect the current WebGPU-focused stack:

- SSGI
- SSR
- GTAO
- motion blur
- TRAA
- bloom
- DOF
- toon outline
- contact shadows
- retro/CRT
- pixel FX

## Codebase Structure And Tooling

### Web split

`741d3e9` split large web-side objects into modules:

- CSS moved to `web/css/index.css`
- layer adapter/facade/ownership modules were added
- runtime override and startup-gate modules were added
- scene-space helpers were added

### Native split

`29de02b` and `766ba6c` split native code out of `src/maxjs_main.cpp`:

- `src/maxjs_core_utils.h`
- `src/maxjs_geometry_sync.h`
- `src/maxjs_material_sync.h`
- `src/maxjs_panel_bridge.inl`
- `src/maxjs_panel_callbacks.inl`
- `src/maxjs_panel_fullsync.inl`
- `src/maxjs_panel_host.inl`
- `src/maxjs_panel_project.inl`
- `src/maxjs_panel_render_window.inl`
- `src/maxjs_panel_sync.inl`
- `src/maxjs_panel_sync_entry.inl`
- `src/maxjs_scene_extractors.h`

This is mostly internal, but it matters for maintainability and lowers the risk of future sync/material/snapshot changes touching unrelated systems.

### Deploy helpers

New scripts:

- `scripts/deploy-web.mjs`
- `scripts/snapshot-deploy.mjs`

`build.bat` was also adjusted so deployment skips/removes stale `web/snapshots` output instead of copying generated snapshot junk into the shipped runtime.

## Pending Working Tree Changes

These are present locally while this draft is being written, but they are not part of `HEAD` yet:

```text
src/maxjs_panel_callbacks.inl
src/maxjs_panel_sync.inl
web/css/index.css
web/index.html
web/js/material_contract.js
```

Pending changes:

- Snapshot panel now displays the saved export location, e.g. `Snapshot saved to <path>`.
- Native clay-mode polling now refreshes from redraw/deferred-interaction paths so selecting/interacting in Max does not leave the viewer stuck in stale clay state.
- WebGPU video textures now guard `copyExternalImageToTexture()` by avoiding premature uploads from not-yet-decoded video frames.
- Shared material texture helpers avoid forcing `needsUpdate` on video textures before the media element has a valid decoded frame.

Untracked local build output:

```text
build-2027/
```

That directory is not release-note content and should not be staged.

## Full Commit List

```text
c775fd8 2026-05-04 Add concise MaxJS runtime skill
7093d64 2026-05-04 Add pathtracing render mode
7a3ce15 2026-05-05 Improve V-Ray texture sync and high-poly geometry updates
017613a 2026-05-05 Improve HTML texture runtime support
ac4270a 2026-05-05 Merge branch 'Pathtracing'
986fd1b 2026-05-05 Remove pathtracing from master
8649d4f 2026-05-05 override mode
1736f4b 2026-05-05 Improve HTML texture auto-fit
582320e 2026-05-05 Fix bake override texture loading
224b797 2026-05-05 Expose scene cameras to layers
f350569 2026-05-05 camera/layer api
2787cd7 2026-05-07 Fix WebGL perf HUD calls/tris stuck at 0
c6d1905 2026-05-07 Snapshot refactor stage 1: boot contract + wrapper
e23154d 2026-05-07 Snapshot refactor stage 2: scene_init, scene_binary, max_basis
42dfbd7 2026-05-07 Snapshot refactor stage 3: minimal-viable scene applier
8e5d26b 2026-05-07 Snapshot refactor stage 4: scene lights
147e855 2026-05-07 Snapshot refactor stage 5: simple PBR material builder
6610373 2026-05-07 Fix snapshot boot cleanup and resize handling
f1a4ce1 2026-05-07 Fix snapshot inline sidecar replay
48dca66 2026-05-07 Add binary snapshot animation features
65a9617 2026-05-08 Add bake override export support and viewer stability fixes
e8f7617 2026-05-09 Harden snapshot bake deployment
cc0e887 2026-05-09 Add beauty bake proxy encoder
4586919 2026-05-09 Filter bake snapshot directory copy by extension
9259628 2026-05-09 Route WebGL viewer through modern renderer; isolate legacy WebGL to VR
305a199 2026-05-11 Add live pathtracing mode
dbb9904 2026-05-11 additional improvements to stability between mode switches
192a247 2026-05-12 pathtracer sync improvements
741d3e9 2026-05-12 Split MaxJS web god objects
29de02b 2026-05-12 Split C++ core utilities from MaxJS main
766ba6c 2026-05-13 Split MaxJS native runtime modules
46ecf81 2026-05-14 Fix renderer sky pipeline
4cee88f 2026-05-14 Stabilize viewer sync polling
92ddbd7 2026-05-14 Restore material event fastsync
e142d35 2026-05-14 Add slow JSON sync mode
3ad4bd0 2026-05-14 Expose animation loop control for snapshots
61ac7f3 2026-05-17 Support UV-tagged bake override maps
5cd70ce 2026-05-18 Refresh shipped-state docs and bake panel layout
a20eeeb 2026-05-18 Optimize beauty bake UV export
07c7410 2026-05-19 Add css3d_overlay + webapp_layer modules
1158838 2026-05-21 Fix snapshot packing and separated multisub materials
4e89b3b 2026-05-21 Fix sub-object material ID mapping for Multi/Sub meshes
3caf959 2026-05-21 Fix video textures: MIME types, HTTP range support, bitmap routing
705249e 2026-05-21 Fix MaxJS normal extraction parity
ab8dae9 2026-05-21 Trim normal sync fast path
```

## Verification To Run Before Publishing

Minimum release validation:

```text
MAXJS_SKIP_DEPLOY=1 .\build.bat 2026
MAXJS_SKIP_DEPLOY=1 .\build.bat 2027
```

Recommended smoke tests:

- Live viewer boot in WGL2, WebGPU, and TSL_GL.
- Switch renderer modes repeatedly and confirm no stale post-FX/sky state remains.
- Path tracing starts only as live preview and does not affect snapshot export.
- Export a static snapshot and open `snapshot.html`.
- Export/open a WebGPU snapshot through `snapshot_webgpu.html`.
- Verify `snapshot.json`, `scene.bin`, optional `scene_anim.bin`, `project.maxjs.json`, `postfx.maxjs.json`, and `inlines/` are copied when expected.
- Test bake overrides in beauty and lightmap modes, including `_UV1` and `_UV2` filename routing.
- Test Multi/Sub materials on separated sub-object meshes and `geo_fast` updates.
- Test a video texture in WGL2 and WebGPU.
- Test clay viewport mode after selection/interaction.
- Test live normal parity on ngon/Edit Poly cases.

## Release Risk Notes

- `SLOW` sync is a debug mode and intentionally does not validate topology/material structure changes.
- Path tracing is live-only and should not be marketed as snapshot-compatible.
- Multi/Sub scalar fastsync is still conservative; structural/full sync remains the safer path.
- WebGPU video textures depend on Chromium/WebView2 media readiness; the pending guard should be validated in the embedded Max panel before publishing.
- The codebase was heavily split into modules after `v0.2.5`; build both 2026 and 2027 targets before packaging.
