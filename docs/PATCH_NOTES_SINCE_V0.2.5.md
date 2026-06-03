# max.js 0.5.0 Release Notes

Baseline: `v0.2.5` (`5fb2846`, 2026-05-04).

Release candidate date: 2026-06-02.

This is a major viewer, sync, material, runtime, and snapshot release. The practical theme is that max.js now behaves less like a demo viewport and more like a deployable 3ds Max to Three.js runtime: clearer renderer modes, stronger native sync, scene-local scripting, snapshot parity, broader material coverage, and release packaging for current Max targets.

Path tracing remains experimental and live-only. Do not present it as part of the stable snapshot/export contract.

## Added

- Added a **Geospatial** sky model for the native `three.js Sky` environment texmap, backed by Takram's `@takram/three-atmosphere` and `@takram/three-geospatial` modules.
- Added WebGPU and WebGL geospatial sky paths, including sun direction, sky exposure, planetary altitude, sky light probe, and environment capture behavior.
- Added native TSL preset dropdowns for `three.js TSL` materials and `three.js TSL Texture` maps.
- Added 52 generated TSL presets from the vendored `tsl-textures` library: bitmap textures, material color-node presets, and displacement presets.
- Added TSL bitmap preset baking for WebGPU so procedural TSL color nodes can feed classic texture slots.
- Added a **Beauty Bake** workflow: a bake panel that bakes lighting/beauty passes to textures per object, material, or scene, carried into snapshot export.
- Added standalone WebGPU snapshot entrypoint support through `snapshot_webgpu.html`.
- Added scene-local runtime sidecar replay in snapshots through `project.maxjs.json` and `inlines/*.js`.
- Added snapshot QA utilities for validation, byte breakdowns, and deploy staging.
- Added `ctx.instances` for runtime access to synced instance groups.
- Added an **Export unused channels** snapshot option that drops non-canonical vertex-color map channels (map channel >= 3) from the export by default.
- Added dedicated Material/Map browser categories for max.js materials and texmaps.

## Headline Changes

- Stable renderer modes are now presented as `WGL2`, `WebGPU`, and `TSL_GL`.
- WebGPU and TSL_GL share the advanced max.js FX controller.
- WGL2 uses a smaller compatibility FX stack instead of exposing unsupported controls.
- Snapshot export was rebuilt around a standalone runtime contract with `snapshot.html`, `snapshot.json`, `scene.bin`, optional `scene_anim.bin`, and copied runtime sidecars.
- Scene-local runtime layers through `project.maxjs.json` and `inlines/*.js` are now part of the snapshot workflow.
- Runtime APIs now expose authored scene data, camera targets, JS-owned object tracking, clone helpers, surface sampling, and synced instancing.
- Native sync was split into smaller modules and hardened around binary deltas, fast material updates, slow debug polling, and packed snapshot data.
- Material JSON extraction is now driven by compile-time slot tables, with tighter texture path handling for V-Ray/OpenPBR/glTF/Shell materials, video, HTML, TSL, OSL Uber Bitmap, and bake override flows.
- TSL material and texture presets were added from the vendored `tsl-textures` library, with generated native presets and a shared JS compiler.
- Snapshot validation, deploy, and stats scripts were added for release QA.

## Renderer And UI

- Renderer labels now use the shipping names: `WGL2`, `WebGPU`, and `TSL_GL`.
- TSL_GL is the Three.js WebGPU renderer forced through WebGL, not a separate XR/fallback mode.
- Renderer switching preserves saved look state while hiding or disabling unsupported controls per renderer.
- The viewport UI moved toward a 3ds Max-style label/menu model.
- Background, viewport label, and renderer-mode state handling were cleaned up.
- Shader Lab is treated as an optional pass in the advanced FX stack rather than a separate renderer mode.

## Post FX

- `web/js/maxjs_fx.js` owns the unified WebGPU/TSL_GL effect stack.
- `web/js/webgl_basicfx.js` owns the WGL2-safe stack.
- Shader Lab output transform handling was fixed.
- Retro and pixel controls now update more parameters in real time without unnecessary pipeline rebuilds.
- Shader Lab and retro/post stack conflicts are handled more explicitly.
- Tone mapping exposure uses a log-style slider and EV display.
- Snapshot and viewer saved look state are preserved more consistently across renderer switches.

Stable advanced effect areas:

- SSGI, SSR, GTAO
- TRAA, motion blur, bloom
- Depth of field
- Toon outline
- Contact shadows
- Volumetric and fog look controls
- Pixel, retro, CRT, film grain, color, exposure, and tone controls
- Shader Lab custom passes where the active renderer supports them

## Snapshot Runtime

Snapshot export is the biggest functional change since `v0.2.5`.

Exported snapshots now use:

```text
snapshot.html
snapshot_webgpu.html
snapshot.json
scene.bin
scene_anim.bin
assets/
vendor/
project.maxjs.json
postfx.maxjs.json
inlines/
```

Changes:

- `snapshot.html` is the max.js-owned standalone runtime.
- `snapshot_webgpu.html` is copied for WebGPU snapshot targets.
- `index.html` is seeded only when missing so user-authored standalone pages are not overwritten.
- Runtime JS, vendor dependencies, textures, media, and sidecars are refreshed on export.
- Scene-local project layers replay in snapshots when `project.maxjs.json` and `inlines/` exist.
- Snapshot UI state can carry renderer, post-FX, HDRI, camera, clipping, and runtime scene data.
- Snapshot animation supports transform, scalar material, geometry, camera, and visibility payloads through optional `scene_anim.bin`.
- Offline validation and stats scripts were added:

```text
scripts/snapshot-verify.mjs
scripts/snapshot-stats.mjs
scripts/snapshot-deploy.mjs
scripts/deploy-web.mjs
```

## Runtime Layers

- `skills/maxjs-runtime/SKILL.md` documents the current runtime contract.
- Runtime layers can read authored scene data through `ctx.maxScene`.
- JS-owned objects are tracked through `ctx.js` and cleaned up with runtime ownership rules.
- Camera APIs expose target state and target-preserving movement.
- Runtime clone helpers support direct Max object cloning patterns.
- `ctx.instances` supports synced instanced groups.
- Inline hot reload was added for scene-local runtime scripts.
- CSS3D and webapp layer modules were added for controlled overlay/web UI work.
- Snapshot export replays runtime sidecars when present, instead of freezing all runtime-created effects.

## Sync And Native Architecture

- The old monolithic native implementation was split into focused headers and panel modules.
- Fast native sync remains the normal `LIVE` path.
- `SLOW` is now explicitly a debug mode: it suppresses fast callback/material churn and polls lightweight JSON state at low frequency.
- Material scalar/event fastsync was restored and broadened.
- Delta command payload sizes now derive from compile-time layouts.
- Material texture serialization now uses a compile-time slot table.
- Idle/audit behavior was hardened around interaction-heavy scenes.
- Runtime layer ownership cleanup was fixed.
- 2024 morpher/skinned export compatibility was hardened.
- SDK compatibility for the current 0.5.0 release line was prepared.

## Geometry, Animation, And Instances

- Native normal extraction now matches 3ds Max more closely, including implicit and ngon normals.
- Normal sync was trimmed so accurate normals do not slow realtime deltas.
- UV2 is excluded from vertex-color collection, preventing channel confusion.
- Sub-object material ID mapping now follows 3ds Max's 1-based material ID behavior before fallback.
- Separated Multi/Sub meshes preserve material assignment more reliably.
- Packed binary snapshot geometry and animation support were expanded.
- WebGPU-safe packed-normal expansion avoids invalid vertex stride issues.
- Hierarchy sync and non-destructive inline hot reload were added.
- Forest Pack and RailClone/tyFlow-style plugin instances can export as grouped `InstancedMesh` payloads instead of duplicated meshes.
- Plain Max instances can collapse into shared-geometry instance buckets in the viewer.
- Snapshot binary payloads now include typed ranges for skin weights, skin indices, bind data, and morph deltas where available.
- Spark splats are tracked as their own live/snapshot overlay path instead of being treated like ordinary mesh geometry.

## Materials And Textures

- Physical, glTF, USD Preview, V-Ray, OpenPBR, Shell, three.js, three.js TSL, three.js Toon, and MaterialX serializers were tightened.
- glTF alpha material handling was improved.
- V-Ray texture metadata and high-poly update behavior improved.
- Video textures now serve correct MIME types, support HTTP Range requests, and route bitmap paths to the video loader.
- HTML texture loading, interaction routing, override mode, and UV aspect behavior improved.
- Bake override maps support `_UV1` and `_UV2` suffix routing with UV2 fallback.
- Bake override loading fails closed instead of leaving stale output.
- OSL Uber Bitmap translation is preserved, including channel selection through Map Output Selector.
- TSL texture and material support was extracted into `web/js/tsl_materials.js`.
- Native TSL presets are generated by `scripts/gen-tsl-presets.mjs`.
- `scripts/tsl-materials-smoke.mjs` covers WebGL gating, WebGPU TSL material creation, `TEXTURES` preset injection, bitmap bake safety, displacement `positionNode`, displacement `normalNode`, and vector parameter generation.
- The vendored `tsl-textures` bundle is included under `web/vendor/tsl-textures/`.
- WebGPU TSL bitmap presets now bake into bind-safe `DataTexture` placeholders instead of assigning render-target textures directly.
- TSL material preset categories include bitmap, material, and displacement presets.
- Displacement presets now support vector parameters and emit normal nodes where the preset library provides them.

## Lights, Sky, Environment, And Cameras

- Directional, point, spot, rect area, hemisphere, and ambient lights sync core parameters.
- Shadow bias, radius, map size, and light cleanup behavior were tightened.
- Three.js sky, geospatial sky, fog, HDRI, environment reflection, and authored Max environment precedence were improved.
- Camera clipping and saved camera state survive snapshot UI serialization.
- Synced camera target data is available to runtime layers.

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
- Include required runtime vendor files: Spark, Rapier when enabled, and `tsl-textures` when presets are used.
- Exclude old Three.js r183 payloads.
- Exclude generic development `node_modules`, root package files, debug snapshots, and build folders.
- Restart 3ds Max after replacing the plugin; a locked `maxjs.gup` means native changes are not loaded even if web files deployed.

## Known Limits And Release Risks

- Path tracing is experimental, live-only, and not part of the stable export promise.
- `SLOW` sync is a debug mode and should not be treated as sync-off.
- Full arbitrary 3ds Max procedural texmap baking is still intentionally disabled.
- Color Correction wrapper pass-through is not enabled yet; a candidate bypass exists only as a documented TODO because wrapper slot behavior may vary across Max versions.
- Advanced WebGPU media and TSL behavior should be smoke-tested in the embedded WebView2 panel.
- TSL snapshot parity depends on copying the `tsl-textures` vendor bundle when preset snippets reference the `TEXTURES` namespace.
- Build both target Max versions before packaging.

## Minimum Shipping Smoke Test

- Boot WGL2, WebGPU, and TSL_GL.
- Switch renderer modes and confirm unsupported controls hide or disable cleanly.
- Toggle common Post FX in WebGPU and TSL_GL.
- Confirm WGL2 exposes only the simple stack.
- Enable Shader Lab, then confirm retro/pixel/advanced stack conflicts are handled cleanly.
- Test video texture playback and seek/range behavior.
- Test HTML texture loading and override mode.
- Test Multi/Sub material display and separated sub-object materials.
- Test glTF alpha material display.
- Test V-Ray/OpenPBR texture paths on a real scene.
- Test bake overrides with `_UV1` and `_UV2` map names.
- Test TSL material presets, TSL bitmap presets, and displacement presets: Rotator, Translator, and Supersphere.
- Confirm TSL bitmap presets do not crash WebGPU binding creation.
- Export a snapshot and open `snapshot.html`.
- Export a WebGPU snapshot and open `snapshot_webgpu.html`.
- Confirm exported `index.html` is not overwritten after manual edits.
- Confirm authored sky/HDRI/reflection behavior matches the live viewer closely.
- Confirm packed-normal WebGPU snapshots do not hit vertex-stride validation errors.
- Confirm runtime sidecars replay when `project.maxjs.json` and `inlines/` are present.
