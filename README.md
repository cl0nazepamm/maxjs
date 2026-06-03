<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="img/Asset%2022%20white.png">
    <img src="img/Asset%2022.png" alt="max.js — Three.js Editor" width="640">
  </picture>
</p>

# max.js

**max.js** is a 3ds Max plugin that embeds a Three.js viewport through WebView2. Accelerated with shared buffers and compatible with modern 3ds Max workflows, it turns Autodesk 3ds Max into a seamless Three.js work environment.

Architecture is split between viewer and standalone into two optimized paths: the fully featured live viewer inside 3ds Max for authoring and the Snapshot Builder that builds a heavily optimized version of what you see in the viewer. Further optimizations can be made after export. 

It does not export the advanced post processing stack yet. But it is coming soon! 

## Features

- **Fast Sync** using native callbacks, shared buffer binary deltas.
- **Three.js Renderer** with WGL2, WebGPU and WebGPU with forced WebGL.
- **ActiveShade** can directly embed into 3ds Max viewport. Uses a custom workaround instead of Autodesk's API so it does not lag or choke 3ds Max down.
- **Snapshot Builder** exports your scene to a deployable website in one click, with optimized packed geometry, copied assets, runtime layers, camera/look state, lighting, materials, animation, and standalone viewer files ready to host.
- **Programmable (`ctx`)** — edit the live synced scene via `ctx.maxScene` (transforms, visibility, queries) and add JS-owned objects via `ctx.js`, wired from `project.maxjs.json` and `inlines/*.js`.
- **PostFX** includes SSGI, SSR, Bloom, Toon and much more. See full list below.
- **Materials** Huge material coverage including automatic translation of 3ds Max materials.

## Renderer

max.js exposes three stable viewer pipelines:

| Mode | Purpose |
|---|---|
| **WGL2** | Simple WebGL2 compatibility path with a small safe FX stack. Comes with the experimental pathtracer mode. |
| **WebGPU** | Main advanced renderer path for the full MaxJS FX stack. Supports forcing WebGL. |

## Scene Data

### Geometry

- Meshes, splines, and generated geometry with vertex color, normals and UV channels.
- Automatic instancing, includes Forest Pack and RailClone generated output.
- Gaussian splats through [Spark](https://github.com/sparkjsdev/spark).
- HTML loading as a texture or scene object. You can load webpages to viewer. (uses in-canvas API)

### Materials

Supported Max materials are extracted into a portable PBR descriptor (`materialModel`, maps, scalars) and rebuilt in Three.js for the live viewer and snapshots.

| 3ds Max material | Synced model | Notes |
|---|---|---|
| **Physical Material** | `MeshPhysicalMaterial` | Autodesk physical shading path |
| **OpenPBR Material** | `MeshPhysicalMaterial` | OpenPBR field mapping |
| **V-Ray Material** | `MeshPhysicalMaterial` | Mapped fields only; unmapped inputs are ignored |
| **glTF Material** | `MeshStandardMaterial` → `MeshPhysicalMaterial` | Promoted when clearcoat, specular, transmission, volume, or IOR extensions are enabled |
| **USD Preview Surface** | `MeshStandardMaterial` → `MeshPhysicalMaterial` | Promoted when clearcoat is used or IOR ≠ 1.5 |
| **MaterialX** | `MaterialXMaterial` | File path, inline export, or live graph |
| **Standard / legacy** | `MeshLambertMaterial` | Diffuse, opacity, self-illum, and common map slots |
| **three.js Material** | `MeshStandardMaterial`, `MeshPhysicalMaterial`, or `MeshSSSNodeMaterial` | Mode selected on the native max.js material |
| **three.js Utility** | `MeshDepthMaterial`, `MeshLambertMaterial`, `MeshMatcapMaterial`, `MeshNormalMaterial`, `MeshPhongMaterial`, `MeshBackdropNodeMaterial` | Per utility preset |
| **three.js TSL** | `MeshTSLNodeMaterial` | JS shader source and/or MaterialX compiler sub-slot |
| **three.js Toon** | `MeshToonMaterial` | Gradient, outline, and map slots |
| **Shell Material** | *(first supported sub-material)* | Walks Shell slots for a supported material above |
| **Multi/Sub-Object** | Per face/material ID | Emits per-group materials when mesh groups carry distinct IDs |

Unsupported assignments fall back to the object wire color. TSL and MaterialX compile on the active renderer path (WebGPU or WGPU forced WebGL).

### Textures

- `UberBitmap.osl` translation.
- Bitmap, video, HTML, and TSL code paths.
- MP4/WebM video textures.
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

## PostFX

WebGPU and TSL_GL use the unified max.js PostFX controller. WGL2 uses `webgl_basicfx.js`, a smaller compatibility stack.

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
- Shader Lab


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

Snapshot export preserves scene hierarchy, transforms, materials, textures, lights, shadows, camera state, environment, sky, fog, animation, splats, runtime layers, and selected viewer UI state. PostFX coming later.

max.js treats runtime files as plugin-owned and `index.html` as project-owned. Re-exporting should refresh the runtime and scene payload without destroying standalone edits.

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
- Geometry, bone and vertex-level animation.
- Camera animation.
- Visibility tracks.
- Runtime layer animation when replayed from project sidecars.

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

## Acknowledgments

- [three.js](https://threejs.org/)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
- [Spark](https://github.com/sparkjsdev/spark)
- [Shader Lab](https://github.com/basementstudio/shader-lab)
- [Rapier](https://rapier.rs/)

## License

MIT
