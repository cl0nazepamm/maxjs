# Stage 3 Dual-World Runtime

This document describes the Stage 3 runtime split for file-backed Three.js projects inside MaxJS.

Usage-facing naming:

- `FastAPI`
  The layer-facing read/query surface for scene data.
  In code today this is mainly `ctx.maxScene`, `ctx.scene`, `ctx.nodeMap`,
  and the node adapters they return.
- `ctx.js`
  The JS ownership/write surface.
- `snapshot`
  The deployable exported runtime state.

## Goal

MaxJS needs two different authoring worlds:

- `maxRoot`: content mirrored from 3ds Max and owned by the native sync.
- `jsRoot`: content authored directly in Three.js by inline modules, AI, or project code.
- `overlayRoot`: transient helpers, gizmos, annotations, and debug visuals.

They render together in one viewport, but they do not share ownership.

## Ownership Rules

- Anything under `maxRoot` is authoritative 3ds Max state.
- JS project code must not receive raw references to synced meshes, materials, or the core scene graph.
- JS project code may inspect Max-owned data through adapters and may create anchors that follow Max nodes.
- Anything created by JS project code is owned by `jsRoot` or `overlayRoot`.
- Disposal is owner-aware. JS layer teardown only disposes resources tagged as JS-owned.

## Current Runtime Shape

The web runtime now creates three top-level roots in `web/index.html`:

- `__maxjs_max_root__`
- `__maxjs_js_root__`
- `__maxjs_overlay_root__`

Synced meshes, synced lights, Forest Pack instances, and volume meshes are attached to `maxRoot`.

The dual-world runtime in `web/js/layer_manager.js` now exposes:

- `ctx.maxScene` / `ctx.scene`
- `ctx.nodeMap`
- `ctx.camera`
- `ctx.js`
- `ctx.group`
- `ctx.overlayGroup`
- `ctx.runtime`

These are adapters, not the raw core objects.

The file-backed project host in `web/js/project_runtime.js` loads `project.maxjs.json` plus module entries from a project directory outside the watched `web/` tree. That means AI can edit project `.js` files directly without using MAXScript as a transport and without forcing a full page reload for every code change.

Current default dev path:

- `projects/active/project.maxjs.json`
- `projects/active/main.js`

If `project.maxjs.json` is missing but `main.js` exists, the runtime falls back to an implicit single-layer manifest for `main.js`.

## Adapter Contract

### `ctx.maxScene`

Read-only query surface for Max-authored content.

Available methods:

- `has(handle)`
- `getNode(handle)`
- `listHandles()`
- `listNodes()`
- `findByName(name, { exact })`
- `createAnchor(handle, options)`

Node adapters returned by `getNode(handle)` also expose:

- `sampleSurface(options)`

Available state snapshots:

- `background`
- `environment`
- `fog`

### `ctx.nodeMap`

Map-like facade over Max nodes.

- `size`
- `has(handle)`
- `get(handle)`
- `keys()`
- `values()`
- `entries()`
- `forEach(fn)`

`get(handle)` returns a node adapter, not the real mesh.

### Max Node Adapter

Each node adapter exposes:

- `handle`
- `exists`
- `name`
- `type`
- `visible`
- `isMesh`
- `materialType`
- `getWorldMatrix()`
- `getWorldPosition()`
- `getWorldQuaternion()`
- `getWorldScale()`
- `getBoundingBox()`
- `snapshot()`
- `sampleSurface(options)`

### `ctx.js`

Authoring surface for JS-owned content.

- `root`
- `overlayRoot`
- `own(resource, { overlay })`
- `add(object, { overlay })`
- `remove(object)`
- `createGroup(name, { overlay })`
- `createAnchor(handle, options)`
- `cloneFromMax(handle, options)`
- `track(resource, { overlay })`
- `dispose(resource)`

`cloneFromMax()` is the escape hatch for "use this Max object as a starting point, but make it JS-owned from now on."

It is not the preferred read path for geometry sampling.
For read-only mesh surface access, use `ctx.maxScene.getNode(handle).sampleSurface()`.

## Anchors

Anchors are JS-owned `THREE.Group`s that follow the world transform of a Max node each frame.

Use anchors when JS content needs to stay attached to a Max object without mutating it.

## Project Runtime

The runtime is manifest-driven.

`project.maxjs.json` can define:

- `name`
- `pollMs`
- `layers[]`

Each layer entry can define:

- `id`
- `name`
- `entry`
- `enabled`

Example:

```json
{
  "name": "Active Project",
  "pollMs": 1200,
  "layers": [
    { "id": "main", "name": "Main", "entry": "main.js", "enabled": true }
  ]
}
```

The native side sends the active project directory to the web runtime via `project_config` after the normal `ready` handshake. The web runtime then polls the manifest and remounts project layers when it changes.

For lightweight projects, `main.js` can also be used without a manifest. In that case the runtime synthesizes a single `main` layer and polls `main.js` directly for reloads.

## Execution Model

Inline modules are still executed in the page realm, but the runtime now:

- removes raw scene and node references from the context
- hides common global entry points in the inline wrapper
- constrains normal AI workflows toward `ctx.js` and `ctx.maxScene`

This is an ownership boundary first, not a perfect browser-security sandbox.

Legacy `js_inline` support may remain for compatibility, but it is no longer the intended primary authoring path.

## Persistence Direction

Recommended persistence model:

- `.max` file stores 3ds Max-authored scene data
- JS-authored content saves separately in a sidecar project
- the `.max` file may store only a reference to the JS sidecar manifest

That keeps Max scene integrity and lets AI regenerate JS layers without risking the native sync.

## Next Steps

- Remove the legacy temp-file/MAXScript inline transport after the project runtime is proven stable.
- Add project-side persistence switching so `.max` files can reference different JS projects cleanly.
- Add promotion/export rules from `jsRoot` to web targets.
- If true browser isolation is required, move inline execution into a sandboxed iframe/worker and keep the current adapter API as the message contract.
