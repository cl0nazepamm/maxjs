# max.js

Work with three.js directly inside 3dsmax. There is no glTF gymnastic it directly writes from 3dsmax data.
It's registered as a renderer so you can use activeshade or external max.js panel. 

Comes with a nice postfx stack and it's very fun to play around with! 

# Features

- **Realtime Sync** — Binary delta protocol over WebView2 shared memory
- **ActiveShade** — Docks into a Max viewport like a real renderer.
- **Layer Manager** — Inline JS layers you can toggle on/off.
- **Snapshots** — One-click export to self-contained HTML sites.
- **Virtual Reality** — See your 3ds Max scene in VR via WebXR (WebGL fallback required).

---

## Materials

MaxJS reads PBR properties directly from the 3ds Max material and maps them to three.js

### Supported Material Types

| 3ds Max Material | Three.js Output |
|---|---|
| **three.js Material** | MeshStandardMaterial / MeshPhysicalMaterial / MeshSSSNodeMaterial |
| **three.js Utility** | MeshDepthMaterial, MeshLambertMaterial, MeshMatcapMaterial, MeshNormalMaterial, MeshPhongMaterial, MeshBackdropNodeMaterial |
| **three.js TSL** | MeshTSLNodeMaterial (custom shader code) |
| **three.js Toon** | MeshToonMaterial |
| **Physical Material** | MeshStandardMaterial or MeshPhysicalMaterial (auto-promoted) |
| **glTF Material** | MeshStandardMaterial |
| **USD Preview Surface** | MeshStandardMaterial or MeshPhysicalMaterial |
| **VRay Material** | MeshPhysicalMaterial (refraction, coat, thin film mapped) |
| **OpenPBR Material** | MeshPhysicalMaterial (specular, coat, fuzz, transmission) |
| **MaterialX** | Load external MaterialX or compile directly using TSL input connection|
| **Shell Material** | Reads viewport slot so you don't have to overwrite existing scene |

Auto-promotion to MeshPhysicalMaterial triggers when clearcoat, sheen, transmission, iridescence, anisotropy, or non-default IOR is detected.

### PBR Properties

**Core:** color, roughness, metalness, opacity, double-sided

**Maps:** color, roughness, metalness, normal (tangent/object space), bump, displacement, parallax, emissive, opacity/alpha, lightmap, AO, specular, matcap, clearcoat, clearcoat roughness, clearcoat normal, transmission, SSS color

**Physical extras:** specular color/intensity, clearcoat, sheen + roughness + color, iridescence + IOR, transmission + IOR + thickness + dispersion, attenuation color/distance, anisotropy

**Texture transforms:** offset, scale, rotation, invert per map slot. Composite AO detection (auto-splits Diffuse x AO multiply patterns).

### Video Textures

Dedicated video texture map with playback, loop, and mute controls.

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

All shadow-casting lights support configurable bias, blur radius, and map resolution. Volumetric light contribution parameter included.

### Contact Shadows

Per-light contact shadows with configurable max distance, thickness, intensity, quality, and temporal mode. Requires a directional light.

---

## Post-Processing

Full post-FX stack built into the viewport. Most effects require WebGPU backend.

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
| **Retro / CRT** | wiggle, affine distortion, scanlines, curvature, vignette, color depth, dithering |
| **Pixel FX** | pixelation, chromatic aberration, sharpening, film grain, brightness, contrast, saturation |

---

## Geometry

- **Mesh types:** TriObject, PolyObject (MNMesh with n-gons), auto-conversion of primitives/patches/NURBS
- **Data:** vertices, indices, UVs (all channels), normals (smooth groups), material IDs
- **Splines:** sampled as line geometry (6 samples per segment)
- **Instancing:** automatic instance detection and WebGPU instanced rendering
- **Multi/Sub-Object:** per-face material group assignment
- **Skin modifier:** bone weights (vec4), bone indices, bind pose, bone hierarchy
- **Morph targets:** per-channel morpher influence with delta geometry
- **Deformation detection:** adaptive vertex hashing detects stack-driven deformation for auto-baking

### Node Properties

Per-node flags synced to Three.js: renderable, backface cull, cast shadows, receive shadows, camera visibility, reflection visibility, opacity.

### Plugin Geometry

- **ForestPack** — instance extraction with per-instance transforms
- **RailClone** — instance extraction
- **tyFlow** — particle instance extraction

---

## Animation

| Track Type | Data |
|---|---|
| **Transform** | position, rotation (quaternion), scale — per-frame matrix sampling |
| **Material** | color, roughness, metalness, opacity, clearcoat, sheen, transmission, IOR, attenuation, thickness, specular |
| **Geometry** | vertex animation baking (configurable 1-120 frame step) |
| **Morph** | per-channel blend shape influence |
| **Camera** | position, target, FOV, DOF params, camera cuts via State Sets |
| **Visibility** | boolean visibility track |

Interpolation modes: linear, discrete (step), smooth (cubic). Loop modes: repeat, once, pingpong.

---

## Environment

- **HDRI maps** with exposure, gamma, and rotation controls
- **Procedural sky** (ai_physical_sky): turbidity, rayleigh, mie coefficient/direction, sun elevation/azimuth, exposure
- **Fog:** linear (near/far), exponential (density), procedural noise (scale, speed, height falloff, animated turbulence)

---

## Gaussian Splats

Spark.js integration for `.splat` and `.ksplat` files. Dedicated splat helper object with file path and display size. Transforms, visibility, and instancing supported.

---

## Snapshots

One-click export to a self-contained HTML site with:
- Full scene hierarchy with transforms
- All PBR materials and texture assets
- Animation (transform, material, geometry, morph, camera cuts)
- Lights, environment (HDRI/sky), fog
- Gaussian splats
- Inline JS layers and runtime scene
- Automatic asset URL rewriting for portability

---

## Layer Manager

Dual-world architecture:
- **Max-owned layers** — read-only mirror of the 3ds Max scene
- **JS-authored layers** — full ownership, hot-loaded from project folder, vibe coding potential.
- **Overlay layers** — UI/HUD elements outside the scene graph

Per-resource disposal tracking for materials, textures, and geometries. Layers persist per scene file.

# Exporting your scene standalone

- **Snapshot sites**: Click snapshot and it saves. That's it.

# Missing - To do

- Vertex Color processing
- Morpher (do not use morphers with skin modifier you will write vertex for every frame)

# Rendering frames

This tool targets web development but since it's registered as renderer I added some functions to get pictures out.


# Bugs
- Spline creation mode mismatch / turning to mesh requires refresh
- Panel can bug out if you maximize or minimize windows. Just use registered "kill maxjs" command in search menu
- No orthographic view (yet)
- Volumetric Lights contribution

# Build

**Requirements:** Visual Studio 2022 (v143 toolset), CMake 3.20+, 3ds Max 2026 SDK

```bash
# 1. Pull WebView2 SDK (one time)
setup_webview2.bat

# 2. Configure
cmake -B build -G "Visual Studio 17 2022" -A x64 .

# If your SDK isn't in the default path:
# cmake -B build -G "Visual Studio 17 2022" -A x64 -DMAXSDK_PATH="D:/your/sdk/maxsdk" .

# 3. Build
cmake --build build --config Release

# 4. Deploy (needs admin if Max is in Program Files)
copy build\Release\maxjs.gup "C:\Program Files\Autodesk\3ds Max 2026\plugins\"
```

Restart Max to load the plugin.

## License

MIT

clone - 2026 Metaverse Makers
