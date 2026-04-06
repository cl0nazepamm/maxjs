# MaxJS

Real-time Three.js viewport inside 3ds Max. No websockets, no external browser — a native C++ plugin that syncs your Max scene into a live Three.js renderer through WebView2, entirely in-process.

Build your scene in Max. See it in Three.js. Export it to the web.

## What it does

MaxJS embeds a full Three.js viewport as a docked panel in 3ds Max 2026. Every mesh, material, light, and camera in your scene is synced in real time through a binary protocol over WebView2 PostMessage. You get a live PBR preview that matches what your scene will look like on the web — not an approximation, the actual Three.js render.

### Scene sync
- Geometry with normals, UVs, and smooth groups — streamed as binary, not JSON
- PBR materials: Physical, Standard, Multi/Sub, with full texture pipeline
- All light types: omni, spot, directional, with real-time parameter updates
- Camera sync including orthographic, FOV, clipping planes
- Transform, visibility, and hierarchy changes reflected instantly
- GPU instancing detection — duplicate geometry is instanced automatically

### Materials
- MaterialX / TSL shader integration
- Toon shading pipeline
- Shell material support (viewport vs render materials)
- Texture caching with format conversion

### Environment
- HDRI sky and environment lighting
- Fog and atmospheric effects
- Screen-space global illumination (SSGI)

### Animation & export
- Snapshot capture of deformation, material, and camera animations from Max
- Export to glTF/GLB, OBJ, STL, USDZ
- Standalone runtime — exported scenes play back without Max

### Extras
- Gaussian splat (.ply) loading
- Volume rendering (smoke/fire via tyFlow)
- ForestPack and RailClone instance extraction
- Experimental WebXR
- Performance HUD

## Architecture

Two halves talking through WebView2:

```
┌─────────────────────────┐     PostMessage      ┌─────────────────────────┐
│     C++ GUP Plugin      │ ◄──── binary ──────► │    Three.js Frontend    │
│                         │ ◄──── JSON ────────► │                         │
│  Scene callbacks        │                      │  Three.js r182          │
│  Mesh serializer        │                      │  PBR renderer           │
│  Material extractor     │                      │  Animation runtime      │
│  Export pipeline        │                      │  Project layer system   │
│  WebView2 host          │                      │  SSGI / post-fx         │
└─────────────────────────┘                      └─────────────────────────┘
```

### Dual-world runtime

The scene graph has three roots:

- **`maxRoot`** — synced 3ds Max content. Authoritative. You don't touch this from JS.
- **`jsRoot`** — your Three.js code. Project layers loaded from disk, hot-reloadable.
- **`overlayRoot`** — transient helpers, gizmos, debug visuals.

Max owns the scene. JS owns the creative layer. They coexist without stepping on each other.

### Project system

Drop a `main.js` in your project folder and it runs in the Three.js viewport. For multi-layer setups, use `project.maxjs.json`:

```json
{
  "layers": [
    { "name": "effects", "src": "effects.js" },
    { "name": "ui", "src": "overlay.js" }
  ]
}
```

Layers reload on file change. No restart needed.

## Build

Requires:
- 3ds Max 2026 SDK
- Visual Studio 2022 Build Tools (v143)
- CMake 3.20+
- Windows SDK 10.0.19041.0+

```bat
setup_webview2.bat          # one-time: fetch WebView2 SDK
build.bat                   # configure + build + deploy to Max plugins
```

Or manually:

```bat
cmake -B build -G "Visual Studio 17 2022" -A x64 .
cmake --build build --config Release
```

Output: `build/Release/maxjs.gup` → deployed to your 3ds Max 2026 plugins directory.

## Repository layout

```
src/            C++ plugin — scene sync, material extraction, WebView2 host
web/            Three.js frontend — renderer, UI, post-processing, animation
projects/       Project examples and active JS layers
docs/           Architecture notes and roadmap
include/        SDK compatibility headers
```

## License

MIT

clone - 2026 Metaverse Makers
