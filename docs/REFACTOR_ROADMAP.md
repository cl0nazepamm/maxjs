# MaxJS Refactor Roadmap

Date: 2026-04-04

## Purpose

This file turns the current codebase recommendations into a concrete refactor order.

The goal is not a rewrite.

The goal is to reduce change risk in the two oversized runtime centers:

- `src/maxjs_main.cpp`
- `web/index.html`

while keeping the current realtime sync, WebView2 host model, and native Three.js plugin surface working.

## Main Problems

### 1. Native host concentration

`src/maxjs_main.cpp` currently owns too many jobs:

- panel window lifecycle
- WebView2 boot and message bridge
- scene serialization
- fast/full sync scheduling
- geometry extraction
- inline layer file handling
- project runtime file watching
- panel kill / restore / ActiveShade glue

That makes every native change high-risk.

### 2. Web runtime concentration

`web/index.html` currently owns too many jobs:

- renderer bootstrap
- bridge dispatch
- scene graph creation
- material factory
- env / HDRI / sky / fog
- post FX UI
- splat integration
- sync consumers
- inline layer entrypoints

That makes the viewer easy to ship changes into, but expensive to reason about.

### 3. Protocol drift risk

The binary delta protocol is relatively clean, but the JSON message family is still implicit and spread across C++ and JS handlers.

### 4. Weak regression coverage

The project has fixture scenes, but not a named smoke-test matrix tied to the sync architecture.

### 5. Docs lag behind reality

The architecture docs are better than the README, but the onboarding path is still fragmented.

## Refactor Rules

These constraints should stay in force during the cleanup:

- No websocket transport.
- No full rewrite of sync.
- No change to the dual-world ownership model.
- No broad class/plugin registration churn unless needed.
- Preserve binary fast-sync behavior while moving code.
- Prefer extraction first, behavior changes second.

## Recommended Order

## Phase 0: Freeze Interfaces Before Moving Code

Estimated effort: 1 to 2 days

Deliverables:

- add a short architecture map doc naming the current authoritative modules
- list every native-to-web message currently used
- list every registered native MaxJS class
- define which parts are intentionally legacy and which are current direction

Why first:

- it lowers the chance of moving code and accidentally changing behavior
- it gives you a stable checklist for review

Good outputs:

- `docs/ARCHITECTURE_MAP.md`
- `docs/MESSAGE_CATALOG.md`

## Phase 1: Split Native Host Responsibilities

Estimated effort: 3 to 5 days

Target result:

`src/maxjs_main.cpp` becomes orchestration, not implementation.

Recommended extraction order:

1. `panel_host`
   - window creation
   - floating/docked state
   - kill/restore/reparent
   - WebView2 init

2. `project_host`
   - project dir detection
   - file stamps
   - inline layer folder scanning
   - manifest writes

3. `scene_serializer`
   - full scene JSON
   - full scene binary
   - env / fog / lights / splats serialization

4. `sync_engine`
   - dirty flags
   - fast/full scheduling
   - callback-driven invalidation
   - delta emission

5. `mesh_extract`
   - live Editable Poly / Edit Poly extraction
   - tri/poly fallback
   - topology hashes

Suggested file layout:

- `src/panel_host.cpp`
- `src/project_host.cpp`
- `src/scene_serializer.cpp`
- `src/sync_engine.cpp`
- `src/mesh_extract.cpp`

Keep in `maxjs_main.cpp`:

- plugin exports
- class registration
- thin global bridge hooks
- top-level `MaxJSPanel` composition if you still want one facade class

Success criteria:

- `maxjs_main.cpp` drops below roughly 2k lines
- no sync behavior changes are required to complete this phase

## Phase 2: Split Web Runtime by Domain

Estimated effort: 4 to 6 days

Target result:

`web/index.html` becomes a boot shell plus minimal wiring.

Recommended extraction order:

1. `viewer_boot`
   - renderer creation
   - camera
   - controls
   - root scene setup

2. `bridge_runtime`
   - message dispatch
   - shared buffer handling
   - ready/kill/refresh wiring

3. `material_factory`
   - `createMaterial`
   - utility material mapping
   - TSL material creation
   - video texture cache

4. `environment_runtime`
   - HDRI loading
   - light probe
   - sky
   - fog/environment state

5. `splat_runtime`
   - Gaussian splat overlay
   - splat add/remove/update

6. `sync_runtime`
   - full scene application
   - binary scene application
   - fast delta handlers
   - `geo_fast`

7. `viewer_ui`
   - panel buttons
   - post FX controls
   - state persistence

Suggested files:

- `web/js/viewer_boot.js`
- `web/js/bridge_runtime.js`
- `web/js/material_factory.js`
- `web/js/environment_runtime.js`
- `web/js/splat_runtime.js`
- `web/js/sync_runtime.js`
- `web/js/viewer_ui.js`

Success criteria:

- `web/index.html` becomes mostly HTML plus startup composition
- new logic lands in modules, not back in the page script

## Phase 3: Normalize the Message Contract

Estimated effort: 2 to 3 days

Target result:

The transport contract is explicit rather than inferred.

Work:

- define message names and payload fields in one place
- separate full-scene messages from fast-scene messages from host-control messages
- document which messages are binary-backed and which are JSON-only

Suggested outputs:

- `docs/MESSAGE_CATALOG.md`
- `web/js/message_types.js`
- `src/message_types.h`

Important note:

Do not over-engineer this into a full serialization framework.
The win is shared naming and payload clarity, not abstraction for its own sake.

## Phase 4: Build a Realtime Sync Smoke Matrix

Estimated effort: 2 to 4 days

Target result:

You can verify changes against known breakage classes quickly.

Minimum matrix:

1. transform drag
2. animated camera playback
3. live Editable Poly vertex drag
4. topology change with same index count risk
5. hide/unhide burst
6. selection burst
7. material scalar tweak
8. material structural change
9. Forest Pack refresh
10. RailClone refresh
11. panel kill / restore / maximize
12. reconnect after WebView refresh

Suggested structure:

- `docs/SMOKE_TEST_MATRIX.md`
- named scenes under `test_scene/` tied to specific coverage areas

If you later automate anything, automate this matrix first.

## Phase 5: Promote the Dual-World Runtime as the Primary Extension Surface

Estimated effort: 1 to 2 days

Target result:

New authoring work goes through the layer/project runtime first.

Work:

- document `ctx.maxScene`, `ctx.nodeMap`, `ctx.js`, anchors, and ownership rules
- mark legacy `js_inline` as compatibility path, not preferred path
- add a tiny example set for file-backed layers

Suggested outputs:

- expand `docs/STAGE3_DUAL_WORLD_ARCHITECTURE.md`
- add `docs/LAYER_API.md`

## Phase 6: Documentation Cleanup

Estimated effort: 1 day

Target result:

A new person can open the repo and understand it from docs without reverse-engineering source first.

Work:

- rewrite `README.md`
- link the architecture docs in the right order
- document the plugin class surface and current status of each subsystem

Recommended read order:

1. `README.md`
2. `docs/ARCHITECTURE_MAP.md`
3. `docs/REALTIME_SYNC_ARCHITECTURE.md`
4. `docs/STAGE3_DUAL_WORLD_ARCHITECTURE.md`
5. `docs/SMOKE_TEST_MATRIX.md`

## Suggested Milestone Plan

### Milestone A: Safer Native Work

Scope:

- Phase 0
- Phase 1

Estimated effort:

- about 1 week

Best outcome:

- native sync bugs stop requiring edits in a 6k-line file

### Milestone B: Safer Viewer Work

Scope:

- Phase 2
- Phase 3

Estimated effort:

- about 1 week

Best outcome:

- material/env/viewer changes stop colliding inside `index.html`

### Milestone C: Stability and Onboarding

Scope:

- Phase 4
- Phase 5
- Phase 6

Estimated effort:

- 3 to 5 days

Best outcome:

- regressions become cheaper to catch
- JS-side extension work becomes the normal path

## What Not To Do First

Avoid these as early refactor targets:

- rewriting the sync protocol
- replacing WebView2 transport
- redesigning the material model surface
- rewriting Forest/RailClone integration
- building automation before the smoke matrix exists

Those are second-order improvements.
The first-order problem is structural concentration.

## Best First Move

If only one thing gets done next, do this:

1. extract native `panel_host`
2. extract native `mesh_extract`
3. document the full message catalog

That sequence reduces the most risk with the least product-level behavior change.

## Definition Of Done

This roadmap is successful when:

- `src/maxjs_main.cpp` is no longer the default place for every native change
- `web/index.html` is no longer the default place for every viewer change
- sync messages are documented and named in one place
- the scene corpus has a real smoke-test matrix
- the layer/project runtime is the documented extension path
