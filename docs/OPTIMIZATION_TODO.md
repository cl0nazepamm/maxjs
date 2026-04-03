# MaxJS Optimization TODO

## Goal

Turn MaxJS from a live web viewport into a fast alternate viewport:

- one-time geometry upload
- binary delta commands after bootstrap
- proper geometry/material caching
- instancing
- measurable runtime stats
- two-way interaction with Max

## Priority Order

1. Binary delta transport
2. Triple-buffer shared memory
3. Geometry dedup and instancing
4. Material and texture residency cache
5. Perf HUD
6. Two-way picking and transform editing
7. Progressive sync
8. WebView2 composited overlay experiment

## Phase 1: Binary Delta Transport

### Objective

Replace normal full-scene resend with a binary command stream.

### Commands

- `BeginFrame`
- `CreateNode`
- `DestroyNode`
- `CreateGeometry`
- `DestroyGeometry`
- `BindGeometry`
- `CreateMaterial`
- `DestroyMaterial`
- `BindMaterial`
- `UpdateTransform`
- `UpdateMaterialScalar`
- `UpdateMaterialTextures`
- `UpdateSelection`
- `UpdateVisibility`
- `UpdateCamera`
- `UpdateEnvironment`
- `Stats`
- `EndFrame`

### C++ Tasks

- Add stable IDs:
  - `nodeHandle -> nodeState`
  - `geoHash -> geometryId`
  - `materialHash -> materialId`
- Add dirty flags per node:
  - topology dirty
  - transform dirty
  - material dirty
  - selection dirty
  - visibility dirty
- Add binary frame builder in the sync path
- Keep JSON full sync as fallback/debug path

### Web Tasks

- Add binary command decoder
- Add command apply layer
- Keep current `scene` and `scene_bin` handlers as fallback until the new path is stable

### Acceptance

- transform-only edits send only `UpdateTransform`
- camera motion does not resend geometry
- material scalar edits do not rebuild the whole scene
- topology changes only upload changed geometry

## Phase 2: Triple-Buffer Shared Memory

### Objective

Remove writer/reader stalls and make the binary path robust under bursty updates.

### Tasks

- Add 3 shared-buffer slots on the C++ side
- Add:
  - `bufferId`
  - `frameId`
  - `generation`
- JS sends ack after a frame is fully applied
- C++ writes only into free buffers
- Drop stale frames instead of blocking

### Acceptance

- no corruption from buffer reuse
- no obvious hitching while tumbling or dragging
- clean recovery if the browser falls behind

## Phase 3: Geometry Dedup and Instancing

### Objective

Upload geometry once and reuse it across repeated nodes.

### Tasks

- Separate node identity from geometry identity
- Reuse `BufferGeometry` by `geometryId`
- Detect:
  - real Max instances
  - identical geometry via hash
- First step:
  - shared geometry reuse
- Second step:
  - `InstancedMesh` for compatible materials

### Acceptance

- repeated assets do not duplicate geometry memory
- HUD shows:
  - node count
  - unique geometry count
  - instance count

## Phase 4: Material and Texture Residency Cache

### Objective

Stop recreating materials and textures unless something real changed.

### Tasks

- Add stable `materialId`
- Add `materialHash -> materialId`
- Add texture path hashing
- Separate:
  - material definition
  - material binding
  - texture residency
- Patch material scalars in place on the web side

### Acceptance

- roughness/metalness/opacity edits do not rebuild materials
- texture reload happens only when texture inputs change
- lower GC churn in the panel

## Phase 5: Perf HUD

### Objective

Expose actual runtime behavior in the viewport UI.

### Metrics

- transport mode
- frame id
- producer bytes
- decode ms
- apply ms
- render ms
- draw calls
- triangle count
- node count
- unique geometry count
- instance count
- dropped frames

### Acceptance

- transport is visible as `binary` or `json`
- perf regressions are obvious immediately

## Phase 6: Two-Way Interaction

### Objective

Make the Three.js panel interactive, not just reactive.

### Tasks

- raycast selection in the panel
- send `select_node` back to Max
- sync Max selection back to the panel
- add transform gizmo in Three.js
- send transform edits back to Max
- prevent feedback-loop jitter

### Acceptance

- clicking in the panel selects the Max object
- moving in the panel updates Max cleanly

## Phase 7: Progressive Sync

### Objective

Make heavy scenes appear instantly, then refine.

### Levels

- `L0`: bounding boxes / proxies
- `L1`: reduced mesh
- `L2`: full mesh

### Tasks

- fast proxy extraction first
- later optional mesh reduction path
- swap geometry in place by `geometryId`

### Acceptance

- large scenes become visible almost immediately
- detail streams in progressively

## Phase 8: WebView2 Overlay Experiment

### Objective

Investigate compositing WebView2 directly over the Max viewport.

### Tasks

- separate experiment branch
- transparent WebView background
- viewport child/overlay hosting
- focus/input validation
- perf validation

### Acceptance

- transparent overlay works
- no obvious copy-path bottleneck
- no broken input routing

## Repo Refactor

### C++

- keep [src/dllmain.cpp](src/dllmain.cpp) for panel/bootstrap only
- add:
  - `src/sync_protocol.h`
  - `src/sync_protocol.cpp`
  - `src/sync_state.h`
  - `src/sync_state.cpp`
  - `src/mesh_extract.h`
  - `src/mesh_extract.cpp`
  - `src/material_extract.h`
  - `src/material_extract.cpp`
  - `src/shared_buffer_ring.h`
  - `src/shared_buffer_ring.cpp`

### Web

- keep [web/index.html](web/index.html) as shell
- add:
  - `web/js/bridge.js`
  - `web/js/protocol.js`
  - `web/js/scene_store.js`
  - `web/js/resource_cache.js`
  - `web/js/perf_hud.js`

## Recommended Implementation Sequence

1. Add stable IDs and dirty-state tracking
2. Add binary command stream alongside current sync
3. Move transforms, camera, and material scalars to binary deltas
4. Move geometry create/update to binary deltas
5. Add triple-buffer shared memory with ack
6. Add geometry dedup
7. Add instancing
8. Add perf HUD
9. Add picking and selection roundtrip
10. Add transform gizmo support
11. Add progressive sync
12. Do overlay experiment in a separate branch

## End-to-End Test Scenes

### Recommended Scene Set

Keep two canonical scenes:

1. `fast_path_smoke.max`
2. `fast_path_stress.max`

### `fast_path_smoke.max`

Purpose:

- correctness
- transform feel
- camera feel
- structural edge cases

Suggested contents:

- `10-20` visible nodes total
- `3` unique meshes with different pivots
- `3` instances of one mesh
- `1` parent-child chain such as `Dummy -> Mesh -> Mesh`
- `1` hidden object
- `1` frozen object
- `1` object with non-uniform scale
- `1` object far from origin
- `1` Multi/Sub material object
- `1` mapped or PBR object

Why:

- catches transform sync bugs
- catches parent/link issues
- catches instance handling
- catches hide/unhide recovery
- keeps performance feel obvious

### `fast_path_stress.max`

Purpose:

- cadence under load
- scaling behavior
- drag responsiveness with many tracked nodes

Suggested contents:

- `200-500` visible transform-tracked nodes
- around `50%` instances and `50%` unique nodes
- `20-50` selected nodes for multi-move tests
- `1` heavy mesh instanced many times
- `1` hierarchy cluster with `20-30` linked nodes
- objects spread over a large area

Why:

- exposes scene-size scaling problems
- shows whether redraw-driven sync holds under real load
- catches multi-selection drag degradation

### Manual Test Pass

Run these in both scenes:

1. camera orbit, pan, dolly
2. slow object drag
3. fast object drag
4. rotate gizmo drag
5. scale gizmo drag
6. multi-select move
7. parent move in a hierarchy
8. animated transform time scrub
9. hide and unhide a tracked object
10. add an object
11. delete an object
12. panel reload or reopen

### Success Criteria

- camera feels continuous
- selected object drag stays attached to the gizmo
- fast drag does not step badly
- multi-select does not collapse cadence
- add/delete/hide recover cleanly via full sync
- stress scene degrades gracefully instead of falling apart

## Best Next Milestone

Ship this next:

1. binary delta transform/material/camera commands
2. triple-buffer shared memory
3. runtime perf HUD
4. geometry dedup

That is the highest ROI set for the next visible leap.
