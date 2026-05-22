# max.js - Three.js integration for 3dsmax

Comes with a postfx stack, live 3ds Max scene sync, standalone snapshots, and switchable Three.js renderer pipelines.

![max.js demo](img/maxjs.gif)

# Features

- **Realtime Sync** — Binary delta protocol over WebView2 shared memory, with a slow JSON debug mode for heavy Max scenes.
- **ActiveShade** — Docks into a Max viewport for live feedback on your design.
- **Layer Manager** — Scene-local runtime layer system for project scripts, inline scripts, and overlays.
- **Snapshots** — Export a scene to a deployable standalone web package.
- **Renderer pipelines** — WGL2, WebGPU, and TSL_GL modes.
- **Pathtracing** — Live-only preview mode. Not part of snapshot export.

---

## Objects

Supports rendering of splines (as lines) and all types of meshes.

- **Splat Origin** — Gaussian Splat loading via [Spark](https://github.com/sparkjsdev/spark) (`@sparkjsdev/spark`).
- **Audio Origin** — Load audio tracks
- **Instancing** — Instance handling is automatic, including Forest Pack and RailClone-style generated geometry.

## Materials

Most 3ds Max materials are supported. Three.js materials can also be created in the Material Editor.

### Supported Material Types

| 3ds Max Material | Three.js Output |
|---|---|
| **three.js Material** | MeshStandardMaterial / MeshPhysicalMaterial / MeshSSSNodeMaterial |
| **three.js Utility** | MeshDepthMaterial, MeshLambertMaterial, MeshMatcapMaterial, MeshNormalMaterial, MeshPhongMaterial, MeshBackdropNodeMaterial |
| **three.js TSL** | MeshTSLNodeMaterial (Custom shader code for materials (Parameterization supported)) | 
| **three.js Toon** | MeshToonMaterial |
| **Physical Material** | MeshStandardMaterial or MeshPhysicalMaterial (auto-promoted) |
| **glTF Material** | MeshStandardMaterial <br>1:1 mapping |
| **USD Preview Surface** | MeshStandardMaterial or MeshPhysicalMaterial |
| **VRay Material** | MeshPhysicalMaterial (refraction, coat, thin film mapped) |
| **OpenPBR Material** | MeshPhysicalMaterial (specular, coat, fuzz, transmission) |
| **MaterialX** | Load external MaterialX | 
| **Shell Material** | Reads viewport slot so you don't have to overwrite existing |

Auto-promotion to MeshPhysicalMaterial triggers when clearcoat, sheen, transmission, iridescence, anisotropy, or non-default IOR is detected. For glTF and USD Preview materials, connected maps are treated as the authored color source and scalar color multipliers stay neutral.
MaterialX Compiler slot can be used to convert 3dsMax OSL into MaterialX quickly (via MtlxIOUtil).

---

## Bitmaps

- **UberBitmap.osl** — Main bitmap node supported and translated by max.js
- **three.js TSL bitmap** — Custom shader code for materials (Parameterization supported)
- **three.js video textures** — Load .mp4 or .webm directly
- **three.js HTML** — html-in-canvas 

---

## Lights

| Light Type | Shadows | Parameters |
|---|---|---|
| **Directional** | Yes | color, intensity, shadow bias/radius/mapsize |
| **Point** | Yes | color, intensity, distance, decay |
| **Spot** | Yes | color, intensity, distance, decay, angle, penumbra |
| **Rect Area** | No | color, intensity, width, height | 
| **Hemisphere** | No | color, intensity, ground color |
| **Ambient** | No | color, intensity |

All shadow-casting lights support configurable bias, blur radius, and map resolution.

---

## Post-Processing

Most screen-space effects require the WebGPU backend. Simpler viewer paths remain available through WGL2 and TSL_GL.

| Effect | Key Parameters |
|---|---|
| **SSGI** | radius, thickness, AO/GI intensity, slice count, step count, temporal jitter |
| **SSR** | quality, blur quality, max distance, opacity, thickness |
| **GTAO** | samples, distance exponent/falloff, radius, scale, thickness, resolution scale |
| **Motion Blur** | amount, sample count |
| **TRAA** | subpixel correction, depth threshold, edge depth diff, max velocity |
| **Bloom** | strength, radius, threshold |
| **Depth of Field** | focus distance, focal length, bokeh scale, auto-focus from camera |
| **Toon Outline** | thickness, alpha, color |
| **Contact Shadows** | max distance, thickness, intensity, quality, temporal |
| **Retro / CRT** | scanlines, curvature, vignette, color depth, dithering |
| **Pixel FX** | pixelation, chromatic aberration, sharpening, film grain, brightness, contrast, saturation |

### Node Properties

Per-node flags synced to Three.js: renderable, backface cull, cast shadows, receive shadows, camera visibility, reflection visibility, opacity.

### Shader Lab Backend in 0.2.0

An alternate post-fx stack powered by [Shader Lab](https://github.com/basementstudio/shader-lab) from [basement.studio](https://eng.basement.studio/tools/shader-lab) has been added.

# Canvas

HTML can be loaded directly to viewer with React support.


---

## Animation

| Track Type | Data |
|---|---|
| **Transform** | position, rotation (quaternion), scale — per-frame matrix sampling |
| **Material** | color, roughness, metalness, opacity, clearcoat, sheen, transmission, IOR, attenuation, thickness, specular |
| **Geometry** | vertex animation baking (configurable 1-120 frame step) |
| **Camera** | position, target, FOV, DOF params, camera cuts via State Sets |
| **Visibility** | boolean visibility track |
| **Vertex Level Animation** | samples per frame |

---

## Environment

- **HDRIEnviron.osl** with exposure, gamma, and rotation controls
- **Sky**: classic three.js sky plus geospatial atmosphere where supported by the active renderer mode. Directional sunlight can be linked to sky azimuth/elevation.
- **Fog (postfx):** linear (near/far), exponential (density), procedural noise (scale, speed, height falloff, animated turbulence)
- **Camera clipping:** manual near/far overrides persist with postfx/snapshot UI state. Default near plane is 1 for better depth precision.

---

## Snapshots

One-click export to a self-contained HTML site with:
- Full scene hierarchy with transforms
- All PBR materials and texture assets
- Animation (transform, material, geometry, vertex level animation, camera cuts)
- Lights, environment (HDRI/sky), fog
- Gaussian splats
- Layers
- Automatic asset URL rewriting for portability
- Viewer UI state, camera clipping, HDRI/post-FX state, and scene-local project sidecars when enabled

---

## Layer Manager

Layer Manager is the scene-local runtime system for max.js projects. A saved `.max` scene can own runtime code beside the scene file instead of relying on machine-global temp scripts.

Scene-local layout:

```text
scene_folder/
  your_scene.max
  project.maxjs.json
  inlines/
    behavior.js
    effects.js
```

Layer types:

- **Max scene layers** — read-only synced 3ds Max objects, cameras, lights, splats, audio, and generated geometry.
- **Project layers** — manifest-owned runtime modules declared in `project.maxjs.json`.
- **Inline layers** — hot-loaded scene-local scripts from `inlines/`, ordered and enabled through the manifest.
- **Overlay layers** — UI/HUD elements outside the scene graph.

Use **Release Project Manifest** to initialize a saved scene for scene-local runtime work. It creates `project.maxjs.json` and `inlines/` next to the `.max` file, migrates existing temporary inline layers when present, and reloads the runtime from the scene-owned project files.

Layer Manager tracks ownership and cleanup for runtime-created objects, materials, textures, and geometries. Layer state persists with the scene-local project files and is included by snapshot export when those sidecars exist.

# Exporting your scene standalone

- **Snapshot sites**: Click snapshot and export a deployable viewer folder.
- Runtime layers are replayed from `project.maxjs.json` and `inlines/` when those sidecars exist.

# Missing - To do

- Morpher under Skin (do not use morphers with skin modifier you will write vertex for every frame). Otherwise you can use it.

# Build

**Requirements:** Visual Studio 2022 (v143 toolset), CMake 3.20+, 3ds Max SDK

```bash
build.bat
build.bat 2027
```

`build.bat` configures, builds, and deploys the plugin plus `maxjs_web` runtime. Restart Max to load a replaced `.gup`.

## Acknowledgments

- [three.js](https://threejs.org/) by mrdoob
- [Spark](https://github.com/sparkjsdev/spark) by World Labs
- [Shader Lab](https://github.com/basementstudio/shader-lab) by [basement.studio] 
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) — by [Microsoft]
- [Rapier](https://rapier.rs/) — physics in runtime layers

## License

MIT

clone - 2026
