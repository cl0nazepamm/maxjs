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
  ipr_client.js       injected browser client: decodes via shared protocol.js, applies via maxjsPlayer
  server.py           overlay HTTP server (serves shared web/ + the export + /maxjs/delta)
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

### Live IPR (interactive preview render)

**Start Live IPR** exports the initial snapshot, then runs a ~20 Hz pump
(`bpy.app.timers`) that diffs the scene and streams only what changed as **MXJB
delta frames — the exact wire format the 3ds Max plugin emits**. The browser
client (injected by the overlay server) decodes them with the *same*
`web/js/protocol.js` Max uses and applies them through `maxjsPlayer`. Transport
is a plain HTTP poll of `/maxjs/delta` (no websockets). Move/rotate objects or
tweak a Principled BSDF in Blender and the viewer updates live; the camera is
left under the viewer's own orbit controls. Snapshots fall out for free — IPR
starts from one and shares the same contract + extractors.

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
active camera — **plus live IPR** streaming MXJB transform / visibility /
material-scalar / light / camera deltas at ~20 Hz.

**Next:** multi-material (`groups` + `matRefs`), texture maps, second UV /
lightmap channel, live *geometry* topology updates (re-stream scene.bin on mesh
edits), and add/remove of objects mid-session (handles are currently fixed at
IPR start).

**Out of scope (matches max.js):** WebXR; effects that depend on CPU project
layers unless their sidecars are exported.
