# max.js 0.5.0 Release Notes

Baseline: `v0.2.5` (`5fb28463`, 2026-05-04).

This release is a large runtime and export update. The main focus is viewer stability, renderer-mode clarity, standalone snapshot parity, scene-local runtime layers, material/texture correctness, and build/package readiness.

## Headline Changes

- MaxJS now has a cleaner renderer model: `WGL2`, `WebGPU`, and `TSL_GL`.
- WebGPU and TSL_GL share the advanced MaxJS FX stack.
- WGL2 has its own smaller safe stack through `webgl_basicfx.js`.
- Snapshot export now produces a cleaner standalone runtime with non-destructive `index.html` handling.
- Scene-local `project.maxjs.json` and `inlines/*.js` layers are copied and replayed in snapshots.
- 3ds Max normal extraction now matches Max much more closely, including implicit/ngon normals.
- Video textures, Multi/Sub material mapping, separated material sync, bake overrides, and snapshot environment parity were tightened.
- Snapshot vendor packaging now separates required Three.js runtime files from optional Rapier physics files.

Path tracing remains experimental/live-only and is not part of the stable release contract.

## Renderer And UI

- Clear user-facing renderer modes: `WGL2`, `WebGPU`, and `TSL_GL`.
- `TSL_GL` is exposed as the WebGPU forced-WebGL path instead of a confusing separate top-level renderer.
- WGL2 hides incompatible advanced controls and keeps only stable lightweight features.
- WebGPU/TSL_GL preserve advanced Post FX settings when switching modes instead of deleting unavailable state.
- Viewport controls moved toward a 3ds Max-style viewport label/menu model.

## Post FX

- `web/js/maxjs_fx.js` now owns the unified WebGPU/TSL_GL FX path.
- `web/js/webgl_basicfx.js` owns the lightweight WGL2-safe path.
- Shader Lab is treated as optional custom pass state instead of a separate render pipeline.
- Renderer-gated UI now hides unavailable effects instead of exposing broken toggles.
- Common saved look state survives renderer switches.

Stable viewer effect areas:

- SSGI, SSR, GTAO
- TRAA, motion blur
- bloom
- depth of field
- toon outline
- contact shadows
- fog/look controls
- pixel, retro, CRT, film, color, exposure, and tone controls

## Snapshot Runtime

Snapshot export is the biggest practical change since `v0.2.5`.

New or improved standalone behavior:

- `snapshot.html` is the MaxJS-owned standalone runtime.
- `index.html` is seeded only when missing, so user-edited standalone sites are not overwritten on re-export.
- `snapshot.json`, `scene.bin`, and optional `scene_anim.bin` form the scene payload.
- Runtime files under `js/` and `vendor/` are refreshed by export.
- Scene-local `project.maxjs.json`, `postfx.maxjs.json`, and `inlines/` are copied when present.
- Snapshot UI now reports the saved output folder.
- Camera lock/camera cuts/runtime camera APIs are available during snapshot replay.
- Inline runtime layers replay from scene-local sidecars.
- Authored Max environment wins over local Post FX HDRI in both viewer and snapshots.
- Three.js sky and directional-sun linking are replayed more closely.
- Snapshot sky/environment reflection setup is closer to the live viewer.
- Required Three.js build/addon files are copied explicitly.
- Rapier vendor files are optional and only copied when enabled.

## Runtime Layers

- `skills/maxjs-runtime/SKILL.md` documents the runtime contract.
- Runtime layers read authored Max data through `ctx.maxScene`.
- Runtime-created objects are owned/cleaned through `ctx.js`.
- Scene-local project files live beside the `.max` scene:

```text
project.maxjs.json
inlines/*.js
```

- Project/inline layers are included in snapshots when exported sidecars exist.
- CSS3D and webapp-layer modules were added for controlled overlay/web UI behavior.

## Sync

- `LIVE` remains the normal fast native sync path.
- `SLOW` is now a debug mode, not sync-off. It suppresses fast callback/material churn while still polling lightweight JSON state.
- Material scalar/event fastsync was restored and broadened.
- Heavy polling is suppressed during active interaction.
- Geometry/material changes still fall back to full sync when the fast path would be unsafe.

## Geometry And Normals

- Native normal extraction was fixed to match 3ds Max more closely, especially implicit/ngon normals.
- The normal sync path was trimmed so accurate normals do not slow normal realtime deltas.
- Binary snapshot geometry packing was expanded.
- Packed snapshot animation support was added through `scene_anim.bin`.
- WebGPU-safe packed-normal expansion was added in `web/js/scene_binary.js` so 3-component normalized Int16 normals do not create invalid 6-byte vertex strides.

## Materials And Textures

- Multi/Sub material ID mapping now matches Max's 1-based material ID behavior before fallback handling.
- Separated sub-object meshes preserve groups/materials more reliably.
- `geo_fast` reapplies separated material state correctly.
- V-Ray texture metadata and high-poly update behavior improved.
- Video textures now serve correct MIME types, support HTTP Range requests, and route video bitmap paths to the video texture loader.
- HTML texture loading, interaction routing, and UV aspect behavior improved.
- Bake override loading fails closed instead of leaving stale output.
- Bake maps can route UVs by filename suffix: `_UV1` or `_UV2`, with UV2 fallback.

## Lights, Sky, And Environment

- Directional, point, spot, rect area, hemisphere, and ambient lights sync with core parameters.
- Shadow bias/radius/map-size handling was tightened.
- Authored HDRI/sky state now has clearer precedence over local viewer HDRI controls.
- Standalone snapshot sky/environment replay is closer to the live viewer.
- Camera clipping state is preserved through viewer/snapshot UI state.

## Build And Packaging

Build checks:

```bat
set MAXJS_SKIP_DEPLOY=1
build.bat 2026
build.bat 2027
```

Release ZIP shape:

```text
maxjs.gup
maxjs_web/
```

Expected ZIPs:

```text
release/maxjs-2026.zip
release/maxjs-2027.zip
```

Packaging rules:

- Include the target `maxjs.gup` at ZIP root.
- Include `maxjs_web/` beside it.
- Include Three.js r184 runtime files.
- Exclude old Three.js r183.2 payloads.
- Exclude generic development `node_modules`, root package files, debug snapshots, and build folders.
- Keep explicitly required runtime modules, including Spark's shipped dist module.

## Release Risks

- Path tracing is experimental/live-only and should not be positioned as a production render/export feature.
- `SLOW` sync is a debug mode and does not validate topology/material structure changes.
- Full advanced Post FX execution in standalone snapshots is still intentionally conservative.
- WebGPU media/video behavior depends on Chromium/WebView2 readiness and should be smoke-tested in the embedded Max panel.
- Build both 2026 and 2027 targets before packaging.

## Minimum Smoke Test

- Boot viewer in WGL2, WebGPU, and TSL_GL.
- Switch renderer modes and confirm gated UI stays clean.
- Toggle common Post FX in WebGPU and TSL_GL.
- Confirm WGL2 exposes only the simple stack.
- Test video texture playback.
- Test Multi/Sub material display and separated sub-object materials.
- Test bake overrides with `_UV1` and `_UV2` map names.
- Export a snapshot and open `snapshot.html`.
- Confirm exported `index.html` is not overwritten after manual edits.
- Confirm authored sky/HDRI/reflection behavior matches the viewer closely.
- Confirm packed-normal WebGPU snapshots do not hit vertex-stride validation errors.

## Current Local Release-Candidate Diff

The current working tree includes release-candidate edits in:

```text
README.md
docs/PATCH_NOTES_SINCE_V0.2.5.md
src/maxjs_main.cpp
src/maxjs_panel_sync.inl
web/index.html
web/js/scene_binary.js
```

Untracked local build folders are not release content:

```text
build-2027.local.bak/
build-2027/
```
