# max.js for Blender

A **translation layer** that lets a Blender scene drive the exact same `web/`
runtime that the 3ds Max plugin drives — so Blender becomes a first-class
producer for max.js's interactive viewer, snapshots, and standalone exports.

## The thesis

max.js is really two things fused together:

1. A **DCC-specific bridge** (the C++ that reads 3ds Max).
2. A **DCC-neutral runtime + format** — the Three.js `web/` runtime, the
   `snapshot.json` + `scene.bin` format, the Layer Manager, the standalone
   exporter. This is the crown jewel, and it does not care who produced the bytes.

Porting to Blender means writing **(1)** for Blender. **(2)** comes for free.

## How future max.js improvements arrive automatically

Two deliberate design choices keep this a *translation layer* and not a fork:

- **The runtime is shared by reference.** `server.py` serves the repo's live
  `web/` directory and only *overlays* the generated `snapshot.json` /
  `scene.bin`. Improve the runtime in max.js (GI, post-FX, Layer Manager, the
  snapshot loader) and the Blender preview gets it on the next reload — no copy,
  no sync step.
- **The format is one contract.** `contract.py` mirrors max.js's authoritative
  byte/JSON rules (`src/maxjs_main.cpp`, `src/sync_protocol.h`,
  `src/maxjs_panel_*`). It carries import-time `assert`s against the wire-layout
  sizes, so if max.js changes a layout the Blender side fails loudly instead of
  emitting silently-corrupt data.

## Architecture

```
blender/maxjs_blender/
  contract.py         spec + adaptive binary packers + DeltaFrameBuilder (MXJB) + conformance asserts   (pure)
  serialize.py        neutral IR → snapshot.json + scene.bin                  (pure, DCC-agnostic)
  extract_blender.py  Blender depsgraph → neutral IR    ← the ONLY bpy-coupled file
  pump.py             change-detecting live delta pump (emits MXJB frames)
  webview2_shim.js    fakes the 3ds Max WebView2 host so the REAL editor (index.html) runs in a browser
  ipr_client.js       (legacy) client for the snapshot-viewer IPR path
  server.py           overlay HTTP server (serves shared web/ + the export + SSE + shim injection)
  __init__.py         add-on: operators + N-panel
```

`extract_blender.py` is the Blender analog of max.js's
`src/maxjs_scene_extractors.h` + `maxjs_geometry_sync.h`. To port to yet another
DCC, reimplement only that file.

### Why this is clean

- **Coordinates are free.** Blender and 3ds Max are both +Z-up right-handed.
  The runtime keeps everything in Max/Z-up space and applies a single −90° X
  rotation at the basis root (`web/js/max_basis.js`), so Blender geometry,
  transforms, lights, and camera pass through with no axis conversion.
- **The binary is faithful, including size-adaptive types.** Indices pack to
  `u16` when every index fits in 16 bits and fall back to `int32` for huge
  meshes; UVs pack to `u16n` when in `[0,1]`; normals pack to `i16n`. These are
  the exact `CanPack*` rules from `src/maxjs_main.cpp`, with the same per-block
  byte alignment, so a Blender export is byte-format-identical to a Max export.
- **Materials.** A Blender Principled BSDF maps cleanly to the MaxJSPBR
  descriptor (`MeshPhysicalMaterial`: base color, roughness, metallic, IOR,
  transmission, emission). Materials are deduplicated into `materials[]` and
  referenced by `matRef`, exactly like the Max exporter.

## Usage

1. In Blender: **Edit ▸ Preferences ▸ Add-ons ▸ Install…**, pick this
   `maxjs_blender` folder (or zip it first), and enable **max.js (Blender bridge)**.
2. Open the **N** sidebar in the 3D Viewport → **max.js** tab.
3. (Optional) set **web/** to your max.js `web/` directory. Empty = auto-detect
   from the repo layout (`blender/../../web`).
4. Click **Export & Preview** for a static snapshot, or **Start Live IPR** to
   stream edits. Both open the browser against the shared runtime.

### Dev workflow — run the add-on straight from the repo (like `dev.bat`)

The root `dev.bat` launches Max with `MAXJS_WEB_DIR` pointed at the repo so the
plugin serves live `web/` from source — no copy step. The Blender side mirrors
that: **don't install the add-on, launch Blender pointed at the repo.**

```bash
./blender/dev.sh                 # macOS / Linux   (BLENDER=/path/to/blender to override)
blender\dev.bat                  # Windows
```

These set `MAXJS_WEB_DIR=<repo>/web` and run Blender with
`--python blender/dev_register.py`, which puts the repo on `sys.path`, imports
`maxjs_blender` **from the working copy**, and registers it. So:

- `git pull` (or any edit), then **relaunch `dev.sh`** → newest code + `web/`,
  no install/copy, nothing written into Blender's addons folder.
- To re-apply edits *without* restarting Blender: **Text Editor ▸ open
  `dev_register.py` ▸ Run** (it reloads every `maxjs_blender.*` submodule and
  re-registers).
- Don't *also* enable an installed copy in Preferences — pick one or the other,
  or they double-register.

(One-time install via zip/symlink still works for non-dev use; see git history /
the operators. The launcher is the day-to-day dev loop.)

### Live IPR (interactive preview render)

**Start Live IPR** opens the **actual max.js editor** (`web/index.html`, full
WebGPU post-FX pipeline) in the browser — not the stripped snapshot viewer. The
trick: the editor only ever talks to one thing, the 3ds Max WebView2 host, which
it reaches through `window.chrome.webview`. The add-on injects
`webview2_shim.js` (inline, right after `<head>`, before the editor's standalone
check) that **impersonates that host**:

- on the editor's `{type:'ready'}` handshake, it pushes `snapshot.json` +
  `scene.bin` as a `scene_bin` shared buffer → the editor's own
  `handleBinaryScene` builds the scene;
- it streams **MXJB delta frames** (SSE `/maxjs/stream`) as `delta_bin` shared
  buffers → the editor's own `handleBinaryDelta` (the same `protocol.js` +
  `applyDeltaFrame` the C++ host drives) applies transform / material / visibility
  / camera / light updates.

So **web/ is never touched** — the editor runs unmodified and does all the work;
the add-on just plays the part of Max. The pump is event-driven: a
`depsgraph_update_post` handler fires the instant you edit and diffs only the
dirty objects. Push transport is SSE (`EventSource`, auto-reconnecting) — no
polling, no websockets.

Exposure / post-FX use the editor's own defaults and FX panel (the snapshot's
`exposure` is a snapshot-viewer concept; the editor owns its post-FX state). A
cursor-based `/maxjs/delta` poll endpoint remains as a fallback.

Headless / scripted:

```python
import maxjs_blender.extract_blender as ex
import maxjs_blender.serialize as sz
ir = ex.extract_scene(bpy.context, backend="WebGL")
sz.write_snapshot(r"C:\path\to\out", ir)   # → out/snapshot.json + out/scene.bin
```

## Scope

**Now (v0.2):** snapshot parity — meshes (vertices, split normals, the active UV,
triangulated, corner-deduped), object hierarchy via parent handles, Principled
BSDF materials, point/spot/sun/area lights with the right photometric units, the
active camera — **plus live IPR in the real max.js editor** (WebGPU, full post-FX):
event-driven (depsgraph) MXJB transform / visibility / material-scalar / light
deltas pushed over SSE and applied by the editor's native handlers.

**Next:** forward post-FX / exposure state into the editor from the shim (match
the look automatically); drive the editor camera from the Blender *viewport*
(region_3d) so navigating in Blender moves the preview; multi-material (`groups`
+ `matRefs`); texture maps; live *geometry* topology updates (re-stream
`scene.bin` / `geo_fast` on mesh edits); add/remove of objects mid-session
(handles are currently fixed at IPR start).

**Out of scope (matches max.js):** WebXR; effects that depend on CPU project
layers unless their sidecars are exported.
