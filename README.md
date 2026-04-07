# max.js

Work with three.js directly inside 3dsmax. There is no glTF gymnastic it directly writes from 3dsmax data, what you see is what you get.
It's registered as a renderer so you can use activeshade or external max.js panel. 

Comes with a nice postfx stack and it's very fun to play around with! 

# Features

- **Realtime Sync**: Binary delta protocol over shared memory.
- **ActiveShade**: docks into a Max viewport like a real renderer (although its a hack and can get buggy)
- **Layer Manager**: inline JS layers you can toggle on/off. Persistent per scene.
- **Snapshots**: one-click export to self-contained HTML sites
- **Post-FX**: SSGI, SSR, AO, motion blur, DoF, chromatic aberration, vignette, CRT, dithering, TAA.
- **Materials**: Comes with nice set of three.js materials registered to interface.
- **Lights**: Directional, Point, Spot with shadow mapping. Contact shadows, light probes.
- **Environment**: HDRI maps, sky mesh, fog
- **Vibe Coding Potential**: "Claude add emitter to this object via layer manager"
- **Natural Integration**: It supports most 3dsmax parameters found in object parameters and allows you to easily art direct three.js.
- **Virtual Reality**: See your 3dsmax scene in VR! (WebGL fallback required)
- **Guassian Splats**: Spark.js is integrated.

# Exporting your scene standalone

- **Snapshot sites**: Click snapshot and it saves.

# Missing - To do

- Rendering (registers as renderer for ActiveShade slot but does not produce frames yet)
- Vertex Color processing
- Morpher (do not use morphers with skin modifier you will write vertex for every frame)
- Area lights (rect width/height data is tracked but not fully implemented)

# Bugs
- Spline creation mode mismatch / turning to mesh requires refresh
- Panel can bug out if you maximize or minimize windows. Just use registered "kill maxjs" command in search menu
- No orthographic view (yet)
- Post Processing can bug out, will fix that soon
- Volumetric Lights work but cannot be adjusted

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
