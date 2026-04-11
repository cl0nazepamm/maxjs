# MaxJS

MaxJS is a 3ds Max 2026 GUP plugin that embeds a Three.js viewport through WebView2. It gives you realtime scene sync, a post-FX stack, custom `three.js` / TSL materials, layer-driven runtime behavior, and snapshot export to a deployable website.

## Quick Start

### 1. Prerequisites

- 3ds Max 2026
- 3ds Max 2026 SDK at `C:\Program Files\Autodesk\3ds Max 2026 SDK\maxsdk`
- Visual Studio 2022 Build Tools with the `v143` toolset
- CMake 3.20+

### 2. Build and install

The shortest path is:

```bat
install.bat
```

That script:

1. Ensures the WebView2 SDK is present
2. Configures CMake if needed
3. Builds `maxjs.gup`
4. Deploys the plugin and `web/` runtime into the 3ds Max plugins folder

If deployment needs elevation, the script will prompt for it. Restart 3ds Max after deployment.

### 3. Manual build

```bat
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --target maxjs
```

The built plugin is:

`build\Release\maxjs.gup`

Default deploy targets:

- `C:\Program Files\Autodesk\3ds Max 2026\plugins\maxjs.gup`
- `C:\Program Files\Autodesk\3ds Max 2026\plugins\maxjs_web\`

## Main scripts

- `install.bat`
  Build + deploy. This is the normal entrypoint.
- `build.bat`
  Same as `install.bat`, but also supports `MAXJS_SKIP_DEPLOY=1` for build-only verification.
- `clean.bat`
  Removes the build directory.
- `snapshot-mcp.bat`
  Serves the checked-in sample snapshot for browser debugging.
- `snapshot-debug.bat`
  Starts the sample snapshot server and the configured Chromium/CDP browser.

## Features

- Binary realtime sync over WebView2
- ActiveShade / docked viewport workflow
- Layer Manager for runtime logic and effects
- `three.js` materials and TSL materials in the 3ds Max Material Editor
- MaterialX bridge path through the `MaterialX Compiler` slot on `MeshTSLNodeMaterial`
- Snapshot export to a self-contained website
- WebGPU-first renderer with WebGL fallback
- WebXR support in the Max viewport only
- Shipped web runtime uses a locally vendored `three@0.183.2` instead of CDN imports

## Project layout

### Repo-owned sample/export folders

Checked-in sample snapshots and cloned snapshot folders live under:

`projects/`

Example:

`projects/flowerandbee/dist`

### Scene-local authoring data

Real working project data lives next to the `.max` file, not in the repo:

- `project.maxjs.json`
- `postfx.maxjs.json`
- `inlines/`

This is the intended ownership split:

- repo `projects/` = samples / cloned snapshots
- scene folder = actual working MaxJS project state

## Snapshot contract

Snapshot export writes a website folder containing:

- `index.html`
- `snapshot.json`
- `scene.bin`
- optional `scene_anim.bin`

If **Debug Payload** is enabled during snapshot export, the export can also include:

- viewer UI state
- runtime scene/debug payload
- project sidecars such as `project.maxjs.json`, `postfx.maxjs.json`, and `inlines/`

If **Debug Payload** is off, those extras are omitted so the snapshot stays clean.

## Current boundaries

- WebXR is not part of the snapshot/export contract
- Heavy CPU layer simulations can replay in snapshots when debug/runtime payload is included, but they are not yet native runtime systems
- Generic procedural 3ds Max map baking fallback is intentionally disabled; use supported bitmap/TSL/MaterialX paths instead

## Known rough edges

- ActiveShade can misbehave after aggressive window maximize/minimize operations
- Orthographic view support is incomplete
- Volumetric lighting is still sensitive to scene setup
- Heavy post FX can cause realtime preview instability in some scenes
- Fur is still work-in-progress

## License

MIT
