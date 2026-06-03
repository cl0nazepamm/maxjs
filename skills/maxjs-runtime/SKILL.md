---
name: maxjs-runtime
description: Write max.js runtime code for scene scripts, project layers, TSL materials, TSL textures, HTML texmaps, gameplay layers, and snapshot-safe Three.js behavior. Use when touching layer ctx APIs, synced scene data, transform overrides, sampleSurface, TSL shader code, TSL parameters, lightmap UV channels, or live-vs-snapshot parity.
---

# max.js Runtime

max.js runs Three.js code against scene data synced from 3ds Max. Treat 3ds Max as the editor/source of truth, and write runtime behavior on top of the live synced scene.

## Naming

- Use `max.js` for the project/product name in prose, docs, release notes, and runtime guidance.
- Preserve code identifiers, filenames, symbols, macros, and data formats exactly as authored, such as `maxjs.gup`, `maxjs_web`, `project.maxjs.json`, `MaxJSPanel`, `MaxJSPBR`, and `MAXJS_SKIP_DEPLOY`.

## Core Rules

- Live viewport and standalone snapshot must match. No editor-only APIs, MCP calls, or hidden bridge dependencies in runtime layers.
- Read authored Max data through `ctx.maxScene` / node adapters.
- Add JS-owned runtime objects through `ctx.js`.
- Move authored synced objects only through `node.transform.*`; fastsync will overwrite raw `.position` / `.quaternion` edits.
- Prefer scene-local files: `inlines/*.js` for auto-discovered layers, or `project.maxjs.json` for explicit project layers.

## Layer Entry Shape

Inline/project layers are real ES modules. Export a factory; do not use top-level `return`.

```js
export default function layer(ctx, THREE) {
    const group = ctx.js.createGroup('fx');

    return {
        update(ctx, dt) {},
        dispose() {}
    };
}
```

Layers can mount before the scene is populated. Defer important lookups until `update()` if needed.

```js
let bee = null;
return {
    update(ctx) {
        bee ??= ctx.maxScene.findByName('Bee', { exact: true })[0];
        if (!bee) return;
    }
};
```

## How Scene Data Is Accessed

Normal live data flow:

```text
3ds Max -> native fastsync -> nodeMap/lightHandleMap -> ctx.maxScene facades -> layer code
```

`ctx.maxScene` is the authored scene read surface. It reads the same live maps fastsync updates; it is not a copied scene graph.

When the viewer is switched to `SLOW` sync, the same facades still update through low-frequency JSON `xform` polling, but material scalar/event fast paths and full rebuild scheduling are intentionally suppressed. Do not use `SLOW` mode as proof that structure, texture, or topology sync is broken.

Useful calls:

- `ctx.maxScene.getNode(handle)` returns a node adapter.
- `ctx.maxScene.findByName(name, { exact })` returns matching adapters; unwrap `[0]` when expecting one.
- `ctx.maxScene.findOne(name, { exact })` returns the first matching adapter; exact matching is the default.
- `ctx.maxScene.resolve(handleOrNameOrAdapter)` normalizes simple inputs to a node adapter.
- `ctx.maxScene.under(parent, { meshOnly, visibleOnly, includeSelf })` returns synced descendants under a parent name, handle, or adapter.
- `ctx.maxScene.listNodes()` / `listHandles()` enumerate synced meshes and lights.
- `ctx.maxScene.listJsmodNodes()` finds meshes with the three.js Deform/jsmod flag.
- `ctx.maxScene.raycast(origin, direction, { near, far })` hits visible synced meshes.
- `ctx.maxScene.createAnchor(handle, options)` creates a runtime object that follows a synced node.

`ctx.nodeMap` is a lower-level read-only handle facade when iteration over raw synced entries is useful.

## Node Adapters

Adapters represent synced Max objects.

- Metadata: `node.handle`, `node.name`, `node.isMesh`, `node.visible`, `node.jsmod`.
- Writable local transforms: `node.position`, `node.rotation`, `node.quaternion`, `node.scale`. They behave like Three.js `Vector3`/`Euler`/`Quaternion` handles and write through max.js runtime overrides so fastsync does not stomp the edit.
- Writable visibility: `node.visible = false` / `node.visible = true`, plus `node.hide()`, `node.show()`, and `node.resetVisibility()`.
- Read surfaces: `node.raw` / `node.object` for the current `Object3D`, `node.matrix`, `node.matrixWorld`, `node.base`, and `node.snapshot()`.
- Three-style world reads: `getWorldPosition(target)`, `getWorldQuaternion(target)`, `getWorldScale(target)`, `getWorldMatrix(target)`. Passing a target is safe; omitting it returns a new object.
- Geometry sampling: `node.sampleSurface({ point, normal, rng })` returns `{ point, normal, barycentric, triangleIndex, mesh, meshHandle, meshName }`. Use `count` for multiple area-weighted samples.
- Anchors: `node.createAnchor(options)`.
- Runtime clone: `node.clone(options)` mirrors `ctx.js.cloneFromMax(node, options)` and returns a runtime-owned `Object3D`.
- Reset: `node.resetTransform()` clears runtime transform overrides; `node.reset()` clears transform and visibility overrides.
- Orientation helpers: `getPivotWorldPosition()`, `getVisualCenter()`, `getPivotToVisualCenter()`, `getLocalAxesWorld()`, `getOrientationSnapshot()`.

Use orientation helpers before gameplay/rig work. max.js runtime is Three.js Y-up: ground plane is XZ, height is Y, and Max-space vectors map as `x,z,-y`.

## Writing Runtime Objects

`ctx.js` owns objects created by runtime code and cleans them up on dispose/hot reload.

- `ctx.js.root`, `ctx.js.overlayRoot`
- `ctx.js.add(obj, { overlay, snapshotId })`
- `ctx.js.remove(obj)`
- `ctx.js.createGroup(name, { overlay, snapshotId })`
- `ctx.js.createAnchor(handle, options)`
- `ctx.js.track(obj)` / `ctx.js.dispose(obj)`
- `ctx.js.own(resource)` for textures/materials/geometries
- `ctx.js.setSnapshotId(obj, id)` so snapshot export can target stable objects
- `ctx.js.cloneFromMax(handleOrNameOrAdapter, options)` creates a runtime-owned clone from a synced Max mesh and registers it under the layer root for cleanup/snapshot export.
- `ctx.js.cloneManyFromMax(nodes, optionsOrFn)` clones a list of adapters/handles/names.

After changing runtime object ownership, cleanup, clone placement, or layer teardown, run:

```powershell
node scripts/runtime-layer-smoke.mjs
```

Clone placement options are intentionally direct:

```js
const product = ctx.maxScene.findOne('items007');
const chute = ctx.maxScene.findOne('Emission_Guide');
const clone = ctx.js.cloneFromMax(product, {
    at: chute.getWorldPosition(),
    align: 'visualCenter',
    snapshotId: `vend-${product.handle}-${Date.now()}`
});
```

For parent-driven effects:

```js
const cans = ctx.maxScene.under('Items_Grp', { meshOnly: true });
const sample = ctx.maxScene.findOne('Shelf_Surface')?.sampleSurface();
if (sample) ctx.js.cloneFromMax(cans[0], { at: sample, align: 'visualCenter' });
```

## Moving Synced Objects

Use Three-style local properties for common authored-object edits:

```js
const node = ctx.maxScene.findOne('Door');
node.position.y += 12;
node.rotation.y += Math.PI * 0.5;
node.scale.setScalar(1.1);
node.visible = false;
```

Use `node.transform` when you need explicit modes or world-space writes:

```js
node.transform.setPosition(x, y, z);
node.transform.setPosition(x, y, z, { mode: 'additive' });
node.transform.offsetPosition(dx, dy, dz);
node.transform.setRotationEuler(x, y, z);
node.transform.setWorldPosition(x, y, z);
node.transform.setWorldMatrix(mat4);
node.transform.clear();
```

Modes:

- `absolute`: replace synced transform.
- `additive`: compose on top of the synced transform.
- `world`: target world space.

Clear overrides in `dispose()` if the layer temporarily owns authored objects.

## Other Important `ctx` APIs

- `ctx.camera`: camera adapter.
- `ctx.renderer`: renderer info/capabilities.
- `ctx.instances`: read/write synced instanced groups (ForestPack / RailClone / tyFlow scatters) that render as `THREE.InstancedMesh`.
- `ctx.input`: event helper with auto-cleanup.
- `ctx.clock`: JS runtime time, `{ dt, elapsed }`.
- `ctx.maxTime`: Max timeline, `{ seconds, frame, fps, playing, source }`.
- `ctx.bus`: shared event bus, auto-unsubscribed on dispose.
- `ctx.services`: shared service registry between layers.
- `ctx.runtime`: runtime metadata and helpers; includes `ctx.runtime.gltf`.
- `ctx.THREE`: same Three.js namespace passed as the second factory arg.

`ctx.camera` can lock to Max scene cameras and expose the live render camera:

- `ctx.camera.raw` returns the underlying Three.js camera for last-mile render offsets such as handheld shake. This does not claim script ownership by itself.
- `ctx.camera.target` / `ctx.camera.getTarget(out)` returns the viewer look-at point, not the Max camera target node. Max target nodes are exposed as regular transform-only scene graph nodes; use `ctx.camera.findSceneCamera(...).targetHandle` with `ctx.maxScene.getNode(handle)` to script them.
- Moving a Max camera target node should not dirty camera sync directly. Camera sync follows the Max camera transform; target nodes are regular scene graph data.
- `ctx.camera.setPositionKeepingTarget(positionOrX, y, z, target?)` moves the layer-owned camera and re-aims it at the current target, or at an explicit target if supplied.
- Camera near/far clipping may come from Max camera manual clipping, render `ViewParams`, or viewer UI overrides. Snapshot UI state persists camera clip overrides.
- `ctx.camera.listSceneCameras()` returns synced scene cameras as `{ handle, h, name, n, targetHandle, targetName }`.
- `ctx.camera.findSceneCamera(name, { exact })` searches the scene camera list. Do this for Physical Cameras; `ctx.maxScene.findByName()` only searches synced meshes/lights.
- `ctx.camera.usePhysicalCamera(handleOrEntry)` / `ctx.camera.usePhysicalCameraByName(name, { exact })` locks the viewer to a Max camera object while still allowing a layer to apply a post-sync camera offset through `ctx.camera.raw`.

`ctx.runtime.gltf` reads max.js glTF Origin objects:

- `get(handle)`
- `findByName(name)`
- `list()`
- `onReady(handle, cb)`

Check `entry.state` before using `entry.root` or `entry.clips`.

`ctx.instances` exposes synced instanced groups — ForestPack / RailClone / tyFlow scatters — which land as one `THREE.InstancedMesh` per source, tagged `userData.maxjsInstanceGroup`. It behaves identically in the live viewer and in exported standalone snapshots, so a layer that drives a scatter keeps working after export.

- `ctx.instances.count` / `keys()` / `has(key)` / `forEach((group, key) => …)` / iteration enumerate the groups.
- `ctx.instances.get(key)` returns a group handle (or `null`). Resolve it once and hold it — the per-instance accessors then go straight to the mesh with no scene traversal.
- A group handle exposes `key`, `count`, `raw` (the `InstancedMesh`), `getMatrixAt(i, out?)`, `setMatrixAt(i, m)`, `getPositionAt(i, out?)`, `setPositionAt(i, x, y, z | vec)`, `forEach((i, matrix) => …)`, and `flush()`. The set/move helpers flag the GPU upload automatically; call `flush()` only if you wrote `raw.instanceMatrix` yourself.
- Groups are keyed by their baked source (`userData.maxjsSource`), currently derived from a `Mesh*` pointer C++-side — stable WITHIN one exported snapshot but not reproducible across re-exports. For code that must survive a re-export, resolve by iteration/index rather than a hard-coded key.
- `InstancedMesh` count is fixed at allocation: moving, hiding (scale-to-zero), or re-transforming existing instances is free; adding instances beyond the exported count needs a rebuild. All instances in a group share one geometry + material, so a single instance's model cannot be swapped in place.

## TSL Material Snippets

TSL material snippets are raw JS stored on a Max material. They are compiled as:

```js
new Function('material', 'THREE', 'TSL', 'loadTexture', 'maps', 'params', code)
```

Rules:

- No `import`, no `export`, no `return`.
- Mutate the provided `material` directly. It is a `THREE.MeshPhysicalNodeMaterial`.
- Texture slots are `maps.map1` through `maps.map16`.
- Use `loadTexture(url)` only for extra textures.
- If classic Max maps are still assigned, clear unwanted slots (`material.map = null`, etc.) or they may keep sampling mesh UVs.

Dynamic parameters:

```js
// @param float strength 0.5 0.0 2.0
// @param color tint 1.0 0.5 0.0
material.colorNode = params.tint.mul(params.strength);
```

Parameter comments create uniforms available through `params.name`. Keep parameter names stable because Max files may save them.

Common node assignments:

```js
material.colorNode = ...;
material.roughnessNode = ...;
material.metalnessNode = ...;
material.emissiveNode = ...;
material.normalNode = TSL.normalMap(TSL.texture(maps.map1));
material.opacityNode = ...; // also set material.transparent = true
material.alphaTestNode = ...;
material.positionNode = ...; // vertex displacement
```

TSL in this repo is Three.js `0.184`. Use method chaining, not JS infix operators:

```js
const t = TSL.time.mul(params.strength);
const v = TSL.vec3(0).toVar();
v.assign(TSL.vec3(1, 0, 0));
TSL.If(t.greaterThan(1), () => { v.y = TSL.float(2); });
```

Avoid reassigning JS variables when you need TSL graph mutation:

```js
// Bad: TSL does not see variable reassignment as graph mutation.
let v = someNode;
v = v.add(1);
```

Available basics include `TSL.time`, `TSL.deltaTime`, `TSL.positionLocal`, `TSL.positionWorld`, `TSL.normalWorld`, `TSL.uv()`, `TSL.vertexColor()`, `TSL.cameraPosition`, `TSL.screenUV`, `TSL.PI`, `TSL.TWO_PI`.

Not available: `TSL.timerLocal`, `TSL.timerGlobal`, `PI2`.

## TSL Texture Snippets

TSL texture snippets are compiled as:

```js
new Function('THREE', 'TSL', 'params', code)
```

They must return a `THREE.Texture` or `THREE.DataTexture`.

```js
const data = new Uint8Array([255, 0, 0, 255]);
const tex = new THREE.DataTexture(data, 1, 1);
tex.needsUpdate = true;
return tex;
```

No `ctx` is injected into TSL snippets. For timeline-driven shader values, use a runtime layer to update a uniform from `ctx.maxTime`, or build the material from an imported layer module instead of a raw Max material snippet.

## Quick Checklist

Before shipping runtime code:

- Can it run in standalone snapshot without Max?
- Does it read through `ctx.maxScene` and write through `ctx.js` or `node.transform`?
- Are all runtime objects tracked/owned for cleanup and snapshot export?
- Are TSL parameters declared with stable `// @param` names?
- Are TSL nodes valid for Three.js `0.184`?
