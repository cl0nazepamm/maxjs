# max.js

**max.js** is a 3ds Max plugin that embeds a Three.js viewport through WebView2. It syncs the live 3ds Max scene into a browser renderer, supports WebGPU and WebGL pipelines, and exports scenes as standalone web snapshots.

It is built for using 3ds Max as the authoring tool and the web runtime as the final interactive presentation layer.

![max.js demo](img/maxjs.gif)

## Highlights

- **Live 3ds Max sync** using native callbacks, shared-buffer binary deltas, and a slow JSON debug mode.
- **Three.js viewport inside 3ds Max** with WGL2, WebGPU, and TSL_GL renderer paths.
- **ActiveShade viewport hosting** for live feedback inside a Max viewport.
- **Deployable snapshots** that export a scene to a clean standalone web folder.
- **Scene-local runtime layers** through `project.maxjs.json` and `inlines/*.js`.
- **Post FX and look controls** shared between WebGPU and TSL_GL, with a smaller WGL2-safe stack.
- **Material, texture, light, animation, HDRI, sky, fog, splat, audio, and glTF sync** from 3ds Max to Three.js.

Path tracing exists as an experimental live-only preview path. It is not part of the stable snapshot/export contract.

## Renderer Modes

MaxJS exposes three stable viewer pipelines:

| Mode | Purpose |
|---|---|
| **WGL2** | Simple WebGL2 compatibility path with a small safe FX stack. |
| **WebGPU** | Main advanced renderer path for the full MaxJS FX stack. |
| **TSL_GL** | Three.js WebGPU renderer forced to WebGL, used when TSL-style materials and the advanced FX controller should run through WebGL. |

WebGPU and TSL_GL share the advanced MaxJS FX state. WGL2 intentionally hides unsupported effects and keeps only the stable compatibility features.

## Supported Scene Data

### Geometry

- Meshes, splines as lines, and generated geometry.
- Automatic instancing, including Forest Pack and RailClone-style generated output.
- Skinned geometry and morph targets when they evaluate into a compatible render mesh.
- Vertex color, UV1/UV2, normals, material groups, and packed binary snapshot geometry.
- Gaussian splats through [Spark](https://github.com/sparkjsdev/spark).

### Materials

MaxJS maps common 3ds Max materials to Three.js PBR output:

| 3ds Max Material | Three.js Output |
|---|---|
| Physical Material | `MeshStandardMaterial` / `MeshPhysicalMaterial` |
| glTF Material | `MeshStandardMaterial` |
| USD Preview Surface | `MeshStandardMaterial` / `MeshPhysicalMaterial` |
| V-Ray Material | `MeshPhysicalMaterial` where fields can be mapped |
| OpenPBR Material | `MeshPhysicalMaterial` |
| Shell Material | Viewport slot passthrough |
| three.js Material | Native Three.js material params |
| three.js TSL | Node/TSL material path |
| three.js Toon | `MeshToonMaterial` |
| MaterialX | External MaterialX loading where available |

Auto-promotion to `MeshPhysicalMaterial` is used when clearcoat, sheen, transmission, iridescence, anisotropy, or non-default IOR is detected.

### Textures

- `UberBitmap.osl` translation.
- Bitmap, video, HTML, and TSL texture paths.
- MP4/WebM video textures with MIME and HTTP Range support.
- HTML-in-canvas textures for controlled local UI surfaces.
- Bake override maps with `_UV1` / `_UV2` suffix routing and UV2 fallback.

### Lights And Environment

| Light Type | Shadows | Synced Parameters |
|---|---|---|
| Directional | Yes | color, intensity, bias, radius, map size |
| Point | Yes | color, intensity, distance, decay |
| Spot | Yes | color, intensity, distance, decay, angle, penumbra |
| Rect Area | No | color, intensity, width, height |
| Hemisphere | No | sky color, ground color, intensity |
| Ambient | No | color, intensity |

Environment support includes HDRI, authored Three.js sky, geospatial atmosphere where supported, fog, camera clipping, and sky/sun linking.

## Post FX

WebGPU and TSL_GL use the unified MaxJS FX controller. WGL2 uses `webgl_basicfx.js`, a smaller compatibility stack.

Stable viewer effects include:

- SSGI
- SSR
- GTAO
- TRAA
- Motion blur
- Bloom
- Depth of field
- Toon outline
- Contact shadows
- Volumetric/fog look controls
- Pixel, retro, CRT, film, color, exposure, and tone controls
- Shader Lab custom passes where the active renderer supports them

Unavailable effects are hidden or disabled per renderer mode without deleting saved settings.

## Snapshots

Snapshots export a standalone web package from the current 3ds Max scene.

Exported snapshot folders can include:

- `index.html` seeded only when missing, so user-authored standalone edits are not overwritten.
- `snapshot.html` as the MaxJS-owned standalone runtime.
- `snapshot.json` scene metadata.
- `scene.bin` packed scene payload.
- `scene_anim.bin` optional binary animation payload.
- `assets/` copied texture/media files.
- `project.maxjs.json` and `inlines/` for scene-local runtime replay.
- `postfx.maxjs.json` for saved look state.
- `vendor/` runtime dependencies.

Snapshot export preserves scene hierarchy, transforms, materials, textures, lights, shadows, camera state, environment, sky, fog, animation, splats, runtime layers, and selected viewer UI state.

MaxJS treats runtime files as plugin-owned and `index.html` as project-owned. Re-exporting should refresh the runtime and scene payload without destroying standalone site edits.

## Runtime Layers

Scene-local runtime code lives beside the `.max` scene:

```text
scene_folder/
  scene.max
  project.maxjs.json
  inlines/
    behavior.js
    effects.js
```

Runtime layers read authored Max data through `ctx.maxScene` and create JS-owned objects through `ctx.js`. Snapshot export replays project layers when `project.maxjs.json` and `inlines/` are present.

Use runtime layers for interactive behavior, particles, overlays, camera logic, UI, gameplay-style logic, and deployable scene-specific code.

## Animation

Snapshot animation can include:

- Transform animation.
- Material scalar animation.
- Geometry and vertex-level animation.
- Camera animation and camera cuts.
- Visibility tracks.
- Runtime-layer animation when replayed from project sidecars.

## Sync Modes

| Mode | Meaning |
|---|---|
| **LIVE** | Normal fast native sync using callbacks, shared buffers, and binary deltas. |
| **SLOW** | Debug mode that suppresses fast callback/material churn and polls lightweight JSON state. It is not sync-off. |

Use `LIVE` for normal work. Use `SLOW` only when isolating heavy-scene behavior or callback churn.

## Build

Requirements:

- Visual Studio 2022 with the v143 toolset.
- CMake 3.20 or newer.
- 3ds Max SDK for the target version.
- WebView2 Runtime.

Build and deploy for the installed target:

```bat
build.bat
build.bat 2027
```

Build without deploying:

```bat
set MAXJS_SKIP_DEPLOY=1
build.bat 2026
build.bat 2027
```

`build.bat` builds `maxjs.gup` and deploys `maxjs_web` unless `MAXJS_SKIP_DEPLOY=1` is set. Restart 3ds Max after replacing the plugin.

## Release Packaging

Release ZIP shape:

```text
maxjs.gup
maxjs_web/
```

Package one ZIP per Max target:

- `release/maxjs-2026.zip`
- `release/maxjs-2027.zip`

The web runtime should include Three.js r184 and the required MaxJS runtime files. Generic root `node_modules`, package manifests, and development-only files should not be shipped, except for explicitly required runtime modules such as Spark's bundled dist file.

## Acknowledgments

- [three.js](https://threejs.org/)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
- [Spark](https://github.com/sparkjsdev/spark)
- [Shader Lab](https://github.com/basementstudio/shader-lab)
- [Rapier](https://rapier.rs/)

## License

MIT
