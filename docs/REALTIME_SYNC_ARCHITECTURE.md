# MaxJS Realtime Sync Architecture

This file records how realtime sync currently works in MaxJS and what was changed to make it reliable for live editing.

Date: 2026-04-02

## Goal

MaxJS keeps a Three.js scene inside WebView2 synchronized with the live 3ds Max scene.

The design goal is:

- use full sync only when structure changes
- use small delta messages for transforms, camera, visibility, selection, light changes, and material scalar changes
- use a dedicated geometry hot path for live vertex edits
- avoid depending on stale evaluated state when Max exposes a live edit mesh directly

## High-Level Design

There are two sync modes:

1. Full sync
   Sends the whole scene state.
   Used for scene bootstrap and structural changes.

2. Fast sync
   Sends only what changed.
   Used for transforms, camera, selection, visibility, lights, material scalars, and live geometry edits.

The producer is native C++ in `src/dllmain.cpp`.
The consumer is the Three.js app in `web/index.html` plus binary delta decoding in `web/js/protocol.js`.

## Transport Layers

### Full scene sync

- `scene`
  JSON full scene payload.
- `scene_bin`
  SharedBuffer full scene payload.

Full sync is used when scene structure changes in ways that are not safe to patch in place.

Examples:

- node create/delete
- topology changes
- structural material changes
- texture swaps and map layout changes
- Multi/Sub material layout changes

### Fast sync

- `xform`
  JSON transform delta with optional rich material scalar patches, lights, splats, and camera.
- `delta_bin`
  SharedBuffer binary delta frame.
  Supports `UpdateTransform`, `UpdateMaterialScalar`, `UpdateSelection`, `UpdateVisibility`, and `UpdateCamera`.
- `mat_fast`
  JSON material-only fast patch.
  Used to carry richer native ThreeJS material scalars that do not fit the compact binary `UpdateMaterialScalar` command.
- `geo_fast`
  Dedicated geometry hot update for a single mesh.
  Used for realtime vertex edits and mesh deformation updates.

### Other messages

- `env_update`
  Environment and fog changes.
- `clay_mode`
  Viewport clay mode toggle.
- `shadow_mode`
  Viewport shadow mode toggle.

## Core Native State

`MaxJSPanel` keeps the sync state.

Important flags and caches:

- `dirty_`
  Full sync required.
- `fastDirtyHandles_`
  Nodes that can be updated through the fast path.
- `geoFastDirtyHandles_`
  Geometry-only hot updates.
- `materialFastDirtyHandles_`
  Material scalar-only fast updates.
- `fastCameraDirty_`
  Camera delta needed.
- `lastSentTransforms_`
  Last transform per tracked handle.
- `geoHashMap_`
  Last mesh hash.
- `lightHashMap_`
  Last light state hash.
- `mtlHashMap_`
  Material structure hash.
- `mtlScalarHashMap_`
  Material scalar hash.
- `lastLiveGeomHash_`
  Live geometry signature used during redraw-driven vertex edit detection.

## Event Sources

Realtime sync is driven by a mix of callbacks and timer polling.

### Node event callback

`MaxJSFastNodeEventCallback`

Used for:

- controller changes
- link changes
- selection changes
- hide changes
- geometry changes
- topology changes

This is good for broad scene notifications but is not enough by itself for smooth live editing.

### Redraw callback

`MaxJSFastRedrawCallback`

This is the most important callback for interactive feel.
It runs on redraw and checks:

- selected transform changes
- tracked light transform changes
- tracked light scalar changes
- tracked material scalar changes
- tracked splat transform changes
- camera changes
- selected live geometry changes

This is what removes the "wait for timer cadence" feeling during interaction.

### Time change callback

`MaxJSFastTimeChangeCallback`

Used to keep animated playback responsive.

### Background timer

`SYNC_INTERVAL_MS = 33`

This still matters for:

- full sync debounce
- structural material detection
- light/material polling fallback
- environment and fog polling
- viewport mode polling
- background geometry scanning

The timer is now the fallback and safety net, not the main source of perceived realtime behavior.

## Geometry Architecture

### Old failure mode

The classic mistake was asking `EvalWorldState()` for live subobject edits and expecting Editable Poly or Edit Poly vertex drags to always appear there immediately.

That is not reliable enough for true live editing.

### Current live mesh path

For realtime geometry extraction, `ExtractMesh()` now first tries a live Editable Poly path:

- base Editable Poly:
  `EPoly::GetMeshPtr()`
- top-of-stack Edit Poly:
  `EPolyMod::EpModGetOutputMesh()`
  fallback `EPolyMod::EpModGetMesh()`

If that live path is not available, extraction falls back to:

- `PolyObject` / `MNMesh`
- `TriObject` conversion for non-poly geometry

### Why this matters

This asks Max for the actual edit-time `MNMesh`, not the last safe evaluated object state.

That is what made live vertex sync finally work.

### Live geometry detection

The old approach used geometry validity intervals as a cheap proxy.
That was too weak for live vertex drags.

Current approach:

- hash actual `Mesh` data when working with tri meshes
- hash actual `MNMesh` data when working with poly meshes
- compare those hashes during redraw for selected geometry

If the mesh changes:

- remove its old geometry hash
- mark it as `geo_fast` dirty
- send only that mesh

### Web-side geometry handling

`geo_fast` is consumed in two modes:

1. Same topology
   Update position, uv, and normal buffers in place and mark them dirty.

2. Topology changed
   Rebuild the `BufferGeometry`.

This is why the native side can aggressively resend geometry for live editing without forcing a full scene rebuild.

## Material Architecture

### Two material categories

Material sync is intentionally split into:

1. Scalar changes
   Safe to patch in place.

2. Structural changes
   Need a full sync.

### Scalar changes

Current scalar fast path covers the common base PBR fields plus richer native ThreeJS fields.

Base fast fields:

- `color`
- `roughness`
- `metalness`
- `opacity`

Additional rich fast fields:

- emissive color and intensity
- env intensity
- normal, bump, displacement, AO, and lightmap intensities
- physical material scalars such as clearcoat, sheen, transmission, IOR, thickness, dispersion, anisotropy, and specular color/intensity
- utility material scalars such as Phong specular color, shininess, flat shading, and wireframe
- SSS node scalars when the SSS material is not texture-driven

These are sent through:

- JSON `xform` payloads when MaxJS is already on the JSON fast path
- binary `delta_bin` using `UpdateMaterialScalar` for the compact base PBR subset
- JSON `mat_fast` as an overlay for richer native ThreeJS material scalars on top of binary delta sync

The web side applies these directly to existing Three.js materials and sets `needsUpdate`.

### Structural changes

Examples:

- texture path changes
- adding or removing a map
- changing material model
- switching shader type
- Multi/Sub layout changes

These still trigger full sync.
That is deliberate.

### Material hashing strategy

Material tracking now uses two hashes:

- structure hash
  Built from a `MaxJSPBR` snapshot with scalar fields normalized out.
- scalar hash
  Built from the fast-patchable material scalar payload.

Behavior:

- scalar changed, structure unchanged:
  fast sync
- structure changed:
  full sync

### Redraw-driven scalar updates

A redraw-driven material scalar check was added so scalar sliders do not wait for the material timer cadence.

That means material scalars now behave like lights: interactive changes flush on redraw, while structural changes stay on the safer structural detection path.

### Native ThreeJS material note

The binary material delta format is intentionally still small and only carries the compact base subset.

To avoid expanding the binary protocol for every advanced material feature, MaxJS now overlays a JSON `mat_fast` message on top of `delta_bin` whenever richer scalar-only native ThreeJS material fields changed.

This keeps:

- binary transforms, selection, visibility, and camera updates cheap
- common material deltas cheap
- advanced native ThreeJS material sliders realtime without forcing full sync

### Multi/Sub rule

Multi/Sub materials are intentionally excluded from scalar fast sync.

Reason:

- the web side can hold material arrays
- scalar deltas are node-level, not sub-material-index-level
- blindly patching one node-level scalar into a material array can corrupt the web-side material state

So Multi/Sub remains full-sync-only for now.

## Light Architecture

Lights were already structurally sound, but they used to feel slightly laggy because updates were primarily noticed by the timer.

### Current light data

Light fast updates include:

- type
- position
- direction
- color
- intensity
- distance
- decay
- spot angle
- penumbra
- rect width and height
- hemisphere ground color
- visibility
- shadow toggles and shadow params
- volume contribution

### Current light detection

Lights now update from:

- redraw-driven transform checks
- redraw-driven light state hash checks
- timer polling fallback

This removes the small but noticeable delay caused by waiting for `LIGHT_DETECT_TICKS`.

## Camera, Selection, Visibility, and Transforms

These ride the fast path as deltas.

Tracked on redraw:

- node transforms
- selection
- visibility
- camera matrix and target

This is the simplest and cheapest part of the sync system.

## Full Sync vs Fast Sync Rules

Use fast sync for:

- transform changes
- camera changes
- selection changes
- visibility changes
- light changes
- material scalar changes
- live geometry position edits

Use full sync for:

- node create/delete
- topology changes
- structural material changes
- Multi/Sub material edits
- plugin-instance changes that affect generated structure
- anything where the web-side object graph must be rebuilt

## Recent Work Summary

### 1. Live Editable Poly geometry sync

Committed as:

- `84a1458` `Add live Editable Poly geometry sync`

What changed:

- added direct live Editable Poly and Edit Poly mesh extraction
- replaced validity-interval geometry detection with actual mesh hashing for redraw-driven live edit detection
- routed changed meshes through `geo_fast`

Result:

- realtime vertex movement and mesh edits now work for:
  - base Editable Poly
  - top-of-stack Edit Poly

### 2. Realtime material scalar sync

Committed as:

- `8749cf5` `Add realtime material scalar sync`

What changed:

- split material detection into scalar vs structural
- added material scalar dirty bookkeeping
- routed scalar-only material changes into fast delta sync
- kept structural changes on full sync
- extended scalar preview extraction to cover Physical materials through the general PBR path

Result:

- live material sliders for common scalar properties update without full scene rebuild

### 3. Redraw-driven lag removal

Working tree changes after the commits above:

- redraw-driven live light hash checks
- redraw-driven live material scalar checks
- rich native ThreeJS material fast patching via `mat_fast`

Why:

- the timer cadence was good enough for correctness but still felt slightly laggy
- redraw-driven checks make the UI feel immediate during interaction

## Known Limitations

- Editable Poly under higher modifiers is still conservative.
  If a higher modifier changes the final result, MaxJS falls back to the evaluated path rather than pretending the lower Edit Poly output is the final mesh.

- Multi/Sub material scalar fast updates are still disabled.

- Structural material edits still require full sync.

- Backdrop utility materials and texture-driven SSS materials are intentionally conservative and stay on the structural/full-sync path for now.

- Light and material fast sync rely on redraws for the best feel.
  If Max is not redrawing, timer polling is still the fallback.

- The MCP bridge is separate from MaxJS and is not required for this sync path.

## Design Principles To Keep

- Do not trust validity intervals for fine-grained live editing.
  Use actual state hashes when live correctness matters.

- Ask Max for the live edit mesh when available.
  For Editable Poly and Edit Poly, that means `MNMesh`, not just evaluated object state.

- Keep fast sync narrow and safe.
  Send tiny deltas for data that can be patched in place.

- Escalate to full sync when structure changes.
  Full sync is the fallback for correctness.

- Prefer redraw-driven checks for anything the user manipulates interactively.
  Timer polling is a fallback, not the primary interaction path.

## If Realtime Sync Breaks Again

Check these first:

1. Is the producer asking Max for live state or only evaluated state?
2. Is the dirty check based on actual data hash or only validity intervals?
3. Is the update going through the fast path or incorrectly escalating to full sync?
4. Is the web side mutating existing objects in place or rebuilding too much?
5. Is a timer cadence masking an otherwise-correct realtime path and making it feel laggy?
