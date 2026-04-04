# MaxJS

MaxJS is a 3ds Max 2026 GUP plugin that embeds a Three.js viewport inside 3ds Max through WebView2. The current direction is a dual-world runtime: Max-owned scene content stays authoritative, while JS-authored layers can be loaded, reloaded, and iterated on without mutating the synced Max scene.

## Current capabilities

- Embedded Three.js viewport hosted in-process through WebView2
- Realtime scene sync from 3ds Max into a dedicated Max-owned runtime root
- JS-owned project layers with file-backed reloads via `project.maxjs.json`
- Implicit single-layer fallback when a project only contains `main.js`
- GPU instancing, Gaussian splat loading, and PBR-oriented material preview
- Experimental WebXR support on the WebGL backend

## Build

1. Run `setup_webview2.bat` once to fetch the WebView2 SDK into `thirdparty/`.
2. Configure the project:

```bat
cmake -B build -G "Visual Studio 17 2022" -A x64 .
```

3. Build the plugin:

```bat
cmake --build build --config Release
```

4. Or use the repository helper:

```bat
build.bat
```

The built plugin is written to `build/Release/maxjs.gup`. `build.bat` also deploys it to the 3ds Max 2026 plugins directory.

## Runtime model

- `maxRoot`: synced 3ds Max content
- `jsRoot`: project-authored Three.js content
- `overlayRoot`: transient helpers, gizmos, and debug visuals

Project code is loaded from the active project directory and can be driven either by:

- `project.maxjs.json` with one or more layer entries
- a bare `main.js`, which is treated as an implicit single-layer project

## Repository layout

- `src/`: native plugin host, scene sync, and WebView2 integration
- `web/`: embedded frontend runtime and UI
- `projects/`: file-backed project examples and active JS layers
- `docs/`: architecture and roadmap notes

## License

No repository license file is present yet.

