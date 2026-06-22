# max.js Blender Sync Report

Date: 2026-06-22

This report describes the current Blender translation layer in this checkout.
The goal is to keep Blender as a producer for the same max.js runtime contract:
`scene_bin`, `delta_bin`, and `geo_fast`, with the shared `web/` runtime served
by reference and not forked.

## Current Architecture

- `extract_blender.py` is the only Blender-coupled scene reader.
- `serialize.py` converts neutral IR into `snapshot.json` and `scene.bin`.
- `contract.py` mirrors the max.js binary and MXJB delta wire contracts.
- `pump.py` emits change-detected live MXJB deltas and `geo_fast` mesh packets.
- `server.py` serves the shared `web/` runtime, overlays generated snapshot
  files, and transports live packets over SSE.
- `webview2_shim.js` impersonates the 3ds Max WebView2 host so the real
  max.js editor consumes the same shared-buffer events it already understands.

## Synced Today

| Area | Static Export | Live IPR | Notes |
| --- | --- | --- | --- |
| Mesh geometry | Yes | Yes | Evaluated Blender mesh, triangulated, corner-deduped. Live mesh edits stream as Max-style `geo_fast`. |
| Topology changes | Yes | Yes | Live `geo_fast` can rebuild geometry when vertex/index counts change. |
| Object transforms | Yes | Yes | World matrices are emitted in the same Z-up basis expected by max.js. |
| Visibility | Yes | Yes | Object visibility maps to node visibility and `UpdateVisibility`. |
| Parent hierarchy | Yes | Yes | Meshes and empties carry parent handles. |
| Selection | Yes | Initial only | Selection flag is exported, but Blender live selection is not currently streamed as its own delta. |
| Normals | Yes | Yes | Split/corner normals are exported and live streamed when available. |
| UV0 | Yes | Yes | Active UV layer is exported and included in full `geo_fast` updates. |
| UV1 / UV2 | Yes | Static only currently | Second UV layer is written into `scene_bin`; `geo_fast` currently sends only primary UV. |
| Multi-material slots | Yes | Yes | Material groups and material arrays are emitted; live `geo_fast` carries `groups`/`mats` for grouped meshes. |
| Principled materials | Yes | Partial | Base color, roughness, metalness, IOR, transmission, emission, opacity are extracted. Live deltas only stream scalar color/rough/metal/opacity for the first material slot. |
| Material dedupe | Yes | Initial/full only | Static/full scene uses material library IDs and hashes. |
| Lights | Yes | Yes | Sun, point, spot, and area lights map to max.js light records and live `UpdateLight`. |
| Camera object | Yes | Yes | Blender camera objects appear in the max.js camera dropdown and can be locked from the IPR panel. |
| Viewport camera | N/A | Yes | `Viewport` in the max.js camera dropdown maps to Blender's active 3D View `RegionView3D`. |
| Camera list | Yes | Yes at IPR start | Blender cameras are emitted as `sceneCameras` with `lockedCamera: 0`. New cameras after IPR start require restart. |
| Tone/exposure hints | Yes | No live forward | Static snapshot stores Blender view exposure/tone hints. Live editor still owns its own post-FX state. |
| Transport | Yes | Yes | Initial scene uses `scene_bin`; live uses MXJB `delta_bin` and binary `geo_fast`, all over SSE. |

## Tracking Checklist

### Implemented

- [x] Static `scene_bin` export
- [x] Live `delta_bin` transform sync
- [x] Live `delta_bin` visibility sync
- [x] Live material scalar sync
- [x] Live light sync
- [x] Live Blender viewport camera sync
- [x] max.js IPR camera dropdown integration
- [x] Blender camera objects listed as `sceneCameras`
- [x] Live `geo_fast` mesh updates
- [x] Topology-changing mesh updates through `geo_fast`
- [x] Multi-material groups and material arrays
- [x] UV0 export and live update
- [x] Static UV2 export
- [x] Static material library dedupe

### Partial

- [ ] Live selection delta
- [ ] Live UV2 `geo_fast` updates
- [ ] Live material structure updates
- [ ] Camera list refresh without IPR restart
- [ ] Snapshot UI parity beyond the basic generated payload
- [ ] Tone/exposure forwarding into the live editor

### Missing

- [ ] Add/remove objects during IPR
- [ ] Texture map extraction
- [ ] Vertex color extraction
- [ ] Full Blender material graph translation
- [ ] Camera DOF forwarding
- [ ] Camera clip plane forwarding
- [ ] Environment, HDRI, and sky translation
- [ ] Fog and volume translation
- [ ] Animation export and timeline sync
- [ ] Armature/skinning payloads
- [ ] Blender instance collapse into max.js instances
- [ ] Hair, particles, and Geometry Nodes instance support
- [ ] Splats, audio, glTF, and WebApp payloads
- [ ] Runtime layers and project sidecars
- [ ] Render output and safe-frame sync

## Missing Or Partial

| Area | Status | Notes |
| --- | --- | --- |
| Add/remove objects during IPR | Missing | Handles are seeded at IPR start. New or deleted objects need a fresh IPR session. |
| Texture maps | Missing | Blender node textures are not translated into max.js material texture slots yet. |
| Vertex colors | Missing | Mesh color attributes are not extracted into max.js vertex color descriptors. |
| UV2 live updates | Partial | Static export supports UV2; live `geo_fast` does not currently send `uv2Off`/`uv2N`. |
| Full material graph | Missing | Only a Principled BSDF scalar subset is mapped. No procedural nodes or image texture graph traversal. |
| Live material structure changes | Partial | Scalar edits stream live. Slot count, material assignment, texture, or material model changes may require full IPR restart or a future material-structure update path. |
| Camera DOF | Missing | Camera focus distance is used to pick a target point, but physical DOF fields are not forwarded. |
| Camera clip planes | Missing | Near/far clipping is not read from Blender cameras. |
| Scene environment/HDRI/sky | Missing | Export currently writes `env: none`; no world shader/HDRI/sky translation. |
| Fog/volumes | Missing | Blender fog/world volume data is not translated. |
| Animations | Missing | No timeline sampling, keyframes, skeletal animation, morph targets, or `scene_anim.bin`. |
| Armatures/skinning | Missing as rig data | Evaluated mesh can reflect current deformation, but no skeleton, weights, or skinned mesh payload is emitted. |
| Instances | Missing as instances | Blender object instances are not collapsed into max.js instance groups; they export as ordinary objects when present in the scene walk. |
| Hair/particles/geometry nodes instances | Missing | No hair, particle, or procedural instance packet support yet. Evaluated mesh output may capture some realized geometry only if Blender exposes it through `to_mesh`. |
| Splats/audio/glTF/webapps | Missing | Export writes empty arrays for these max.js feature families. |
| Runtime layers/project sidecars | Missing | No `runtimeScene`, `project.maxjs.json`, `postfx.maxjs.json`, or `inlines/` sidecar pipeline from Blender yet. |
| Layer Manager parity | Runtime only | The editor's Layer Manager exists because the shared runtime is used, but Blender does not author max.js runtime layers. |
| Snapshot UI parity | Partial | Basic `snapshotUi` is written; portable Studio/post-FX/HDRI/editor state from Max is not authored by Blender. |
| Render output / safe frame | Missing | Blender render resolution/aspect is not forwarded as live render-output settings. |
| Scene camera list live refresh | Missing | Camera dropdown is correct at IPR start; camera add/remove/rename needs IPR restart. |

## Mapping Details

### Geometry

- Blender meshable types are `MESH`, `CURVE`, `SURFACE`, `META`, and `FONT`.
- Extraction uses evaluated objects and `to_mesh()`.
- Meshes are triangulated through Blender loop triangles.
- Per-corner normals, UV0, UV1/UV2, and material indices are deduped into a
  max.js-compatible indexed mesh.
- Static snapshots use adaptive packing:
  - indices: `u16` when possible, otherwise `int32`
  - UVs: `u16n` when values fit `[0,1]`, otherwise `float32`
  - normals: `i16n` when possible, otherwise `float32`
- Live IPR initial `scene_bin` uses float32/int32 channel layout so later
  `geo_fast` packets can patch the same buffers exactly like the Max live path.

### Materials

- Blender Principled BSDF maps to `MeshPhysicalMaterial`.
- Supported scalar fields:
  - base color
  - roughness
  - metallic
  - IOR
  - transmission
  - emission color/intensity
  - opacity
  - side/backface culling
- Multi-material meshes use geometry groups plus `matRefs` in full scene data
  and `groups` plus `mats` in live `geo_fast`.

### Lights

- Blender Sun maps to max.js directional light.
- Blender Point maps to point light with candela conversion.
- Blender Spot maps to spot light with angle and penumbra.
- Blender Area maps to rectangular light with area-based intensity conversion.
- Shadow flags and basic shadow parameters are emitted.

### Cameras

- The max.js IPR camera dropdown controls camera mode.
- `Viewport` means Blender's active 3D View internal viewport.
- Camera entries come from Blender camera objects.
- The shim forwards max.js `lock_camera` host messages to the Blender bridge.
- The Blender bridge samples the active camera source and emits MXJB
  `UpdateCamera` packets.

## Priority Backlog

- [ ] Texture maps: image texture extraction for base color, normal, roughness,
   metallic, opacity, emission, and transmission where possible.
- [ ] Add/remove object support during IPR: handle table refresh or full-scene
   resync path without restarting IPR.
- [ ] Vertex colors and UV2 live `geo_fast` support.
- [ ] Live material structure updates for material assignment, slot count, and
   texture changes.
- [ ] Environment/HDRI/world color translation.
- [ ] Animation export and live timeline sync.
- [ ] Instancing and realized Geometry Nodes instance support.
- [ ] Camera DOF and clipping parity.

## Verification Used

- `python blender\test_translation_contract.py`
- `python blender\tests\test_serialize_smoke.py`
- `python -m py_compile blender\maxjs_blender\__init__.py blender\maxjs_blender\extract_blender.py blender\maxjs_blender\pump.py blender\maxjs_blender\serialize.py blender\maxjs_blender\server.py`
