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
- Put layers in the scene-local `scripts/` folder next to the `.max` (see Scene-Local Layers and Modules). The `layers` array in `project.maxjs.json` is ignored by the live editor; the snapshot player reads it only as a fallback when `runtimeScene.layers` is empty.

## Layer Entry Shape

Inline/project layers are real ES modules. Export a factory; do not use top-level `return`.

```js
export default function layer(ctx, THREE) {
    const group = ctx.js.createGroup('fx');

    return {
        update(ctx, dt, elapsed) {},
        dispose() {}
    };
}
```

Other accepted shapes: top-level `export function init/update/dispose` (the module namespace is the hooks object), or a `default`/`createLayer`/`mount` export that is either the factory `(ctx, THREE, extra)` or a plain hooks object. A static `export const parameters` (or `params`) is passed to `ctx.params.define` before the factory runs. `extra.layer` differs between editor and snapshot; rely only on `extra.layer.id` and `extra.layer.name`. After 60 consecutive `update` throws the layer is deactivated.

Render hooks `onBeforeRender(ctx, elapsed)` / `onAfterRender(ctx, elapsed)` run after all updates and camera sync, right around the live draw. They do **not** run for Render to Image / Render Sequence output, so anything that must appear in rendered frames (camera shake, sim state) belongs in `update`.

The editor and snapshot player wait for their initial scene-ready signal before
running a layer factory. Nodes can still appear, disappear, or rebuild later, so
resolve dynamic scene references again when an adapter reports that its object
is gone.

An async `init()` context belongs to one exact mount. If hot reload or removal
happens while it is awaiting, managed writes from the stale context are ignored
and late unowned resources are cleaned up. Still cancel external async work in
`dispose()` and do not retain raw scene/camera references past the layer lifetime.

```js
let bee = null;
return {
    update(ctx) {
        bee ??= ctx.maxScene.findByName('Bee', { exact: true })[0];
        if (!bee) return;
    }
};
```

## Scene-Local Layers and Modules

Discovery is a host-side folder scan of `<sceneDir>\scripts\` (legacy `inlines\` only when `scripts\` has no layers), polled periodically:

- The scan is **recursive**, and **every `*.js` is a layer** (`*.js.disabled` = disabled layer). `scripts/sim/bag.js` mounts as layer `sim/bag`. There is no ignore list.
- Helper modules must not end in `.js`: name them `*.mjs`. They are served as JavaScript, resolved by relative imports, and copied into snapshots. Alternatively bundle the layer into one file.
- An `NN_` filename prefix sets priority (lower mounts first; default 100) and strips it from the display name: `10_bag.js` → `bag`.
- Any edit under `scripts/` changes a recursive directory stamp, which remounts **all** layers.
- Layers are imported from a real URL (`https://maxjs-assets.local/<abs path>/scripts/<id>.js?v=n`), so relative `import`s and `new URL('./file', import.meta.url)` work, live and in snapshots. Snapshot export copies the whole `scripts/` tree file by file (no bundling, `*.js.disabled` skipped). Nothing outside `scripts/` is exported.
- Only the entry URL is cache-busted. An edited helper keeps its first-loaded code (and module-level state) until the viewer page reloads. Keep mutable state inside the factory.
- `import * as THREE from 'three'` resolves to the same instance as the factory's `THREE` (the WebGPU build: `three.webgpu.js`). TSL: `import * as TSL from 'three/tsl'`, or `THREE.TSL`. There is no `ctx.TSL`. In a classic-WebGL snapshot (`snapshot.html`) node materials and `THREE.TSL` do not exist and `'three/tsl'` loads a second three copy, so gate on `typeof THREE.WebGPURenderer === 'function'` and fall back.

```text
scene.max
project.maxjs.json      host-written: { "name", "pollMs", "layers": [] }
settings.maxjs.json     host-written: runtimeLayerParams.layers["<folder/id>"] = { param: value }
scripts/
  10_bag_sim.js         the only layer entry
  lib/world.mjs         helper, imported as './lib/world.mjs'
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
- `ctx.maxScene.listSelected()` returns adapters for nodes currently selected in Max; the layer bus emits `max:selection` on changes.
- `ctx.maxScene.raycast(origin, direction, { near, far })` hits visible synced meshes.
- `ctx.maxScene.createAnchor(handle, options)` creates a runtime object that follows a synced node.

`ctx.nodeMap` is a lower-level read-only handle facade when iteration over raw synced entries is useful.

## Node Adapters

Adapters represent synced Max objects.

- Metadata: `node.handle`, `node.name`, `node.isMesh`, `node.visible`, `node.jsmod`, `node.selected`.
- Authoring metadata: `node.userProps` — Max user-defined properties (Object Properties → User Defined) parsed to a frozen `{ key: number|boolean|string }` object (`{}` when none); `node.userPropsRaw` is the raw buffer. This is the artist→runtime tagging channel (`speed=2`, `interactive=true`) — prefer it over name conventions when targeting behavior.
- Material read: `node.material` → `{ raw, list, count, snapshot() }` or `null`. `snapshot()` returns plain per-material summaries (name, type, color/emissive hex, roughness, metalness, opacity, transparent, side, assigned `maps`). Read-only — mutation goes through `setMap` / `overrides.setProperty` / `ctx.deform`.
- Writable local transforms: `node.position`, `node.rotation`, `node.quaternion`, `node.scale`. They behave like Three.js `Vector3`/`Euler`/`Quaternion` handles and write through max.js runtime overrides so fastsync does not stomp the edit.
- Writable visibility: `node.visible = false` / `node.visible = true`, plus `node.hide()`, `node.show()`, and `node.resetVisibility()`.
- Read surfaces: `node.raw` / `node.object` for the current `Object3D`, `node.matrix`, `node.matrixWorld`, `node.base`, and `node.snapshot()`.
- Three-style world reads: `getWorldPosition(target)`, `getWorldQuaternion(target)`, `getWorldScale(target)`, `getWorldMatrix(target)`. Passing a target is safe; omitting it returns a new object.
- Geometry sampling: `node.sampleSurface({ point, normal, rng })` returns `{ point, normal, barycentric, uv, triangleIndex, material, materialIndex, materialName, mesh, meshHandle, meshName }`. Use `count` for independent area-weighted samples; use `seed` instead of implicit randomness for snapshot-safe procedural placement. Add `normalMode: 'smooth'`, `materials`, or `areaSpace: 'world'` only when needed. Skinned/morph/GPU-deformed world-area and smooth-normal sampling are outside v1.
- Anchors: `node.createAnchor(options)`.
- Runtime clone: `node.clone(options)` mirrors `ctx.js.cloneFromMax(node, options)` and returns a runtime-owned `Object3D`.
- Path-scoped runtime property overrides: `node.overrides.setProperty(property, value, options)`, `node.overrides.clearProperty(property, options)`, and `node.overrides.hasProperty(property)`.
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
- `ctx.js.instanceFromMax(node, { capacity, geometry, materials, snapshotId })` creates a fixed-capacity layer-owned `THREE.InstancedMesh`. `geometry`/`materials` are `follow` (default) or `clone`; neither mode duplicates resources per instance. `materials: 'clone'` is intentionally rejected for NodeMaterial/TSL sources in v1 because Three.js only shallow-clones their node graphs.
- `ctx.js.traverse(cb)` / `ctx.js.traverseScene(cb)` traverse the layer's own group / the whole scene.

After changing runtime object ownership, cleanup, clone placement, or layer teardown, run:

```powershell
node tools/runtime-layer-lifecycle-smoke.mjs
node tools/layer-mesh-reuse-smoke.mjs
node tools/layer-surface-sampling-smoke.mjs
```

Clone placement options are intentionally direct:

```js
const product = ctx.maxScene.findOne('items007');
const chute = ctx.maxScene.findOne('Emission_Guide');
const clone = ctx.js.cloneFromMax(product, {
    at: chute.getWorldPosition(),
    align: 'visualCenter',
    snapshotId: `vend-${product.handle}` // stable per mount — NEVER Date.now(): export-time ids must match re-run ids
});
```

For parent-driven effects:

```js
const cans = ctx.maxScene.under('Items_Grp', { meshOnly: true });
const sample = ctx.maxScene.findOne('Shelf_Surface')?.sampleSurface();
if (sample) ctx.js.cloneFromMax(cans[0], { at: sample, align: 'visualCenter' });
```

## Procedural Mesh Reuse and Modular Kits

Use `ctx.js.instanceFromMax()` for one static source mesh. Capacity is fixed and
capped at 100,000 per batch to reject accidental runaway allocations,
placement is world-space by default (centimeters, Y-up), `add()` returns a dense
index or `-1`, and `removeAt()` swap-removes the last index. Call `flush()` after
a mutation batch. Negative-determinant matrices and three.js Deform, skinned,
batched, or morph-target sources are rejected in v1. A custom `parent` must be
inside the current layer's JS or overlay root. Passing no transform preserves an
authored matrix exactly, including shear; pass a full `Matrix4` when later
placements must preserve shear too.

```js
const blocks = ctx.js.instanceFromMax('Block_A', {
    capacity: 1000,
    geometry: 'follow',
    materials: 'follow',
    snapshotId: 'blocks',
});
blocks.addMany(transforms); // flushes once by default
```

Follow mode preserves the exact authoritative Multi/Sub/TSL resource identity
and adopts source replacements before layer update. Never mutate a followed
`raw.geometry` or `raw.material`. Classic materials can use
`{ geometry: 'clone', materials: 'clone' }` for one isolated resource set per
batch, and `refresh()` to recapture it. TSL/NodeMaterial sources must keep
`materials: 'follow'` in v1; clone mode fails early instead of sharing a mutable
node graph accidentally.

`sampleSurface({ count })` likewise accepts an integer up to 100,000. Split
larger procedural work into deterministic chunks instead of blocking a frame.

Use `ctx.kits.capture()` when a hierarchy contains several module meshes and
socket helpers. Prefer stable Max User Defined Properties over names:

```text
module = wall
socket = east
socketFor = wall
```

```js
const kit = ctx.kits.capture('KIT_Building');
const walls = kit.module('wall').createInstances({
    capacity: 512,
    snapshotId: 'walls',
});
const corners = kit.module('corner').createInstances({
    capacity: 128,
    snapshotId: 'corners',
});

const wall = walls.add({ at: [0, 0, 0] });
corners.addAtSocket('west', walls.getSocketMatrixAt(wall, 'east'));
walls.flush();
corners.flush();
```

`kit.module(id)` / `getPart(id)` returns a frozen module record with
`createInstances()`, `instantiate()`, `sockets`, and `getSocket()`. The kit also
has `instantiate()` for one hierarchy copy and `createInstances()` for repeating
the whole multi-part prefab. Explicit module IDs must be unique. Whole-kit
socket IDs are module-qualified (`wall:east`); module batches use local IDs
(`east`). Socket alignment is `targetWorld * inverse(socketLocal)`. Whole-kit
`batches` are read-only views so their dense indices cannot be structurally
desynchronized. One-off `instantiate()` paths are classic-material-only in v1;
use `createInstances()` for exact followed TSL materials. `kitBatch.raw` is the
explicit advanced Three.js escape hatch; traversing it and mutating child
InstancedMesh state bypasses the safe alignment API.

Generated InstancedMesh counts/matrices serialize through `runtimeScene` with
no M3 schema extension. Exact TSL parity depends on successful layer-sidecar
replay on a node-material-capable backend (WebGPU or TSL_GL); the baked emergency
runtime tree intentionally converts NodeMaterial types to classic materials.
Never describe the baked tree alone as exact TSL fallback.

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

## Runtime Property Overrides

Use `node.overrides` when a runtime layer must own one exact Three.js property on a synced Max object while the rest of the object continues to sync from Max. Overrides are keyed by `(handle, property)`, so setting `node.overrides.setProperty('map', texture)` on a synced `SpotLight` only protects `light.map`; position, intensity, color, angle, shadow settings, parenting, and visibility still update from fastsync/playback.

This is the preferred API for light cookies/gobos, runtime-only texture slots, and other layer-owned properties that native sync would otherwise overwrite.

```js
const spot = ctx.maxScene.findOne('TJS_Spot');
// resolve next to the layer file: a bare './scripts/…' resolves against the editor page and 404s live
const texture = ctx.js.own(new THREE.TextureLoader().load(new URL('./cookie.png', import.meta.url).href));
texture.colorSpace = THREE.SRGBColorSpace;

spot.overrides.setProperty('map', texture, {
    needsUpdate: true,
    shadowNeedsUpdate: true,
    materialsNeedUpdate: true,
});
```

Clear the exact path on teardown when the runtime layer no longer owns it:

```js
dispose() {
    spot?.overrides.clearProperty('map', {
        restoreValue: null,
        needsUpdate: true,
        shadowNeedsUpdate: true,
    });
}
```

Do not replace whole synced objects or bypass the adapter for this pattern. Raw writes like `spot.raw.map = texture` are acceptable only as compatibility fallback for older viewer builds, because the next sync or playback update can overwrite them.

## Other Important `ctx` APIs

- `ctx.camera`: camera adapter.
- `ctx.renderer`: renderer info/capabilities.
- `ctx.instances`: read/write synced instanced groups (ForestPack / RailClone scatters) that render as `THREE.InstancedMesh`.
- `ctx.input`: event helper with auto-cleanup.
- `ctx.clock`: JS runtime time, `{ dt, elapsed }`.
- `ctx.maxTime`: Max timeline, `{ seconds, frame, fps, playing, source }`.
- `ctx.params`: layer-owned tweakable parameters shown in the Runtime Layers panel. Use `ctx.params.define({ speed: { type: 'slider', value: 1, min: 0, max: 4, step: 0.05 }, tint: { type: 'color', value: '#ff8844' }, mode: { type: 'string', value: 'orbit' } })`, then read the returned live values object or `ctx.params.values`. Supported UI types are `slider`, `float`, `color`, `bool`, and `string` (`text` is an alias). Committed panel edits are stored scene-locally in `settings.maxjs.json` and hydrate the layer before its factory runs after a restart; live slider/input movement is not written on every event. Values are also exported in `runtimeScene`, so snapshots remain self-contained and replay the tuned values before the layer factory runs. Always declare `type` for colors: a bare number is inferred as `float`, so `{ tint: { value: 0xff8844 } }` gives you a number field, not a swatch. Hex strings (`'#ff8844'`) infer as `color` on their own.
- `ctx.bus`: shared event bus, auto-unsubscribed on dispose. Max-driven events: `max:selection` `{ selected, added, removed }` (handle arrays), and `max:time:play` / `max:time:pause` / `max:time:seek` (timeline snapshot `{ seconds, frame, fps, playing }`).
- `ctx.anim`: Max authored-animation playback — `list()` (`{ id, name, duration, time, playing, speed, loop }`), `play(id)`, `pause(id)`, `stop(id)`, `setTime(id, seconds)`, `setSpeed(id, factor)`, `setLoop(id, mode)`, `seekAll(seconds)`, `isPlaying(id)`. Empty list / no-op false when no animations are loaded.
- `ctx.audio`: Max audio origins + layer SFX — `list()`, `play(handle)`, `stop(handle)`, `setVolume(handle, v)` (holds until Max re-syncs that origin), `muted`, and `playOneShot(url, { volume, position, refDistance, loop })` → `{ stop(), active }`. Positional when `position` (Vector3 or `[x,y,z]` world) is given; one-shots are silenced automatically on layer dispose. Audio requires a prior user gesture (browser autoplay policy) — one-shots fired before that are dropped.
- `ctx.services`: shared service registry between layers.
- `ctx.runtime`: runtime metadata and helpers; includes `ctx.runtime.gltf`.
- `ctx.spectral`: NIR material overrides for PowerShot infrared/NightShot. `setNirAlbedo(selector, value)` assigns scalar NIR reflectance without requiring a TSL material and returns a disposable live handle.
- `ctx.THREE`: same Three.js namespace passed as the second factory arg.

After changing `ctx.params` persistence or snapshot transport, run:

```powershell
node tools/runtime-layer-param-persistence-smoke.mjs
node tools/runtime-layer-lifecycle-smoke.mjs
node tools/snapshot-runtime-parity-smoke.mjs
```

## NIR Material Tags

Use `ctx.spectral.setNirAlbedo(selector, value)` to author the scalar NIR
reflectance PowerShot's infrared and NightShot modes see. Values clamp to `[0, 1]`
unless `{ max }` allows more. The
assignment follows late-synced nodes, survives material rebuilds, replays in
snapshots, and restores the previous material value when disposed. Cleanup is
also automatic when the owning layer unloads.

```js
export default function layer(ctx) {
    const foliage = ctx.spectral.setNirAlbedo({
        under: 'Vegetation',
        materials: ['Leaf*', 'Grass*'],
    }, 0.55);

    const road = ctx.spectral.setNirAlbedo({ objects: 'Road*' }, 0.06);

    return {
        dispose() {
            foliage.dispose();
            road.dispose();
        },
    };
}
```

Selectors support:

- Direct node adapter, handle, exact object name, `'Prefix*'`, `RegExp`, predicate, or an array.
- `{ under, objects, materials, includeSelf }`; each node/material selector accepts exact names, prefix wildcards, regexes, predicates, or arrays.
- Convenience keys: `objectName`, `objectPrefix`, `materialName`, and `materialPrefix`.

The returned handle exposes `value`, `matched`, `materials`, `set(value)`,
`refresh()`, and `dispose()`. A material shared outside the selected subtree is
still one Three.js material, so its NIR value changes everywhere it is used.
Material name selectors check both the current Three material name and the
original Max material name retained by baked/runtime replacements.

While PowerShot infrared or NightShot senses NIR, node renderers draw the scene
as three NIR bands (`web/js/nir_band_view.js`, PowerShot's `createNirBand`) and
the imager collapses them (`setNirBands`). Each material keeps its colour and
maps up to the red edge and takes its `nirAlbedo` level past it; an untagged
material falls back to `classifyNir`, then to the Jakob-Hanika extrapolation of
its colour. A TSL material can give per-pixel levels as
`userData.maxjsNirColorNode` (reflectance) / `maxjsNirEmissiveNode` (emission).
Lights, HDRI light, the background and fog take their band spectra, and probe GI
baked in visible light is suspended. Lights whose `emitterClass` marks them as
IR illuminators stay black until then and light the 850 nm band at the
PowerShot illuminator gain.

`ctx.camera` can lock to Max scene cameras and expose the live render camera:

- `ctx.camera.raw` returns the underlying Three.js camera for last-mile render offsets such as handheld shake. This does not claim script ownership by itself.
- `ctx.camera.target` / `ctx.camera.getTarget(out)` returns the viewer look-at point, not the Max camera target node. It differs by host: the editor returns the target of the last Max camera packet (stale while a layer owns the camera), the snapshot returns `OrbitControls.target`. Pass explicit targets to `lookAtTarget` / `setPositionKeepingTarget` when live and snapshot must match. Max target nodes are exposed as regular transform-only scene graph nodes; use `ctx.camera.findSceneCamera(...).targetHandle` with `ctx.maxScene.getNode(handle)` to script them.
- Moving a Max camera target node should not dirty camera sync directly. Camera sync follows the Max camera transform; target nodes are regular scene graph data.
- `ctx.camera.setPositionKeepingTarget(positionOrX, y, z, target?)` moves the layer-owned camera and re-aims it at the current target, or at an explicit target if supplied.
- Camera near/far clipping may come from Max camera manual clipping, render `ViewParams`, or viewer UI overrides. Snapshot UI state persists camera clip overrides.
- `ctx.camera.listSceneCameras()` returns synced scene cameras as `{ handle, h, name, n, targetHandle, targetName, targetH, targetN, active, hasSnapshotState }`.
- `ctx.camera.findSceneCamera(name, { exact })` searches the scene camera list. Do this for Physical Cameras; `ctx.maxScene.findByName()` only searches synced meshes/lights.
- `ctx.camera.usePhysicalCamera(handleOrEntry)` / `ctx.camera.usePhysicalCameraByName(name, { exact })` locks the viewer to a Max camera object while still allowing a layer to apply a post-sync camera offset through `ctx.camera.raw`.

`ctx.runtime.gltf` reads max.js glTF Origin objects:

- `get(handle)`
- `findByName(name)`
- `list()`
- `onReady(handle, cb)`

Check `entry.state` before using `entry.root` or `entry.clips`.

`ctx.instances` exposes synced instanced groups — ForestPack / RailClone scatters — which land as one `THREE.InstancedMesh` per source, tagged `userData.maxjsInstanceGroup`. It behaves identically in the live viewer and in exported standalone snapshots, so a layer that drives a scatter keeps working after export.

- `ctx.instances.count` / `keys()` / `has(key)` / `all()` / `forEach((group, key) => …)` / iteration enumerate the groups.
- `ctx.instances.get(key)` returns a group handle (or `null`). Resolve it once and hold it — the per-instance accessors then go straight to the mesh with no scene traversal.
- A group handle exposes `key`, `count`, `raw` (the `InstancedMesh`), `getMatrixAt(i, out?)`, `setMatrixAt(i, m)`, `getPositionAt(i, out?)`, `setPositionAt(i, x, y, z | vec)`, `forEach((i, matrix) => …)`, and `flush()`. The set/move helpers flag the GPU upload automatically; call `flush()` only if you wrote `raw.instanceMatrix` yourself.
- Groups are keyed by their baked source (`userData.maxjsSource`), currently derived from a `Mesh*` pointer C++-side — stable WITHIN one exported snapshot but not reproducible across re-exports. For code that must survive a re-export, resolve by iteration/index rather than a hard-coded key.
- `InstancedMesh` count is fixed at allocation: moving, hiding (scale-to-zero), or re-transforming existing instances is free; adding instances beyond the exported count needs a rebuild. All instances in a group share one geometry + material, so a single instance's model cannot be swapped in place.

## Camera Ownership (script mode)

A layer can drive the viewer camera without any Max camera. The adapter is frozen and its `fov`/`near`/`far`/`position`/`quaternion`/`target` are getters: `ctx.camera.fov = 40` throws in module strict mode. Use the setters.

- Claim: `ctx.camera.takeOver({ controls })` → `boolean` (there is no `claim()`); `useScriptMode({ controls, enableOrbitControls })`; `release()`. `controls`: `'viewer' | 'orbit' | true` keeps the user's OrbitControls, `'none' | false | 'manual'` disables them (default `'none'`). Any setter implicitly claims script mode with `'none'` if nobody owns the camera. A non-owner cannot steal or release. Release or layer removal restores the captured pose and controls.
- State: `mode` (`'viewport' | 'physical' | 'script'`), `isScriptMode`, `isOwnedByMe`, `getState()`, `getForward/getRight/getUp(out?)`, `controls` (owner only), `setControlsEnabled(bool)`.
- Setters (all return `boolean`, all update `matrixWorld`): `setPosition(x,y,z)`, `setPositionVec(v)`, `setQuaternion(x,y,z,w)`, `setQuaternionVec(q)`, `setRotationEuler(x,y,z, order='YXZ')`, `lookAt(x,y,z | vec | [x,y,z])` (also writes `OrbitControls.target`), `lookAtTarget(target?)`, `setPositionAndLookAt(px,py,pz, tx,ty,tz)`, `setPositionKeepingTarget(...)`, `setTransform(px,py,pz, qx,qy,qz,qw)`, `setMatrix(m)`, `setFov(deg)` (three's **vertical** fov; Max sync converts Max's horizontal fov), `setNearFar(near, far)` (cm), `orbit(dAz, dPolar, target?)`, `dolly(delta, target?)`, `pan(dx, dy)`.
- In script mode, Max viewport/camera packets are ignored (including the Render Sequence camera), so a Max camera is at most an authoring reference.
- `controls.update()` still runs every frame **before** layer `update` and re-aims at `controls.target`. Set the full pose every frame; `lookAt` keeps `controls.target` in sync, then `setQuaternionVec` can add roll/shake.
- The viewer's clip-override UI can rewrite near/far; re-assert if it matters.
- Exported active-camera animation runs after layer `update` with no script-mode guard: don't export Camera Animation for a scene whose camera a layer drives.

```js
export default function layer(ctx, THREE) {
    const rig = new THREE.PerspectiveCamera(30, 4 / 3, 5, 6000); // private pose source, cm
    return {
        update(ctx, dt, elapsed) {
            if (!ctx.camera.isOwnedByMe && !ctx.camera.takeOver({ controls: 'none' })) return;
            // ...move rig...
            ctx.camera.setPosition(rig.position.x, rig.position.y, rig.position.z);
            ctx.camera.lookAt(0, 100, 0);
            ctx.camera.setQuaternionVec(rig.quaternion);
            ctx.camera.setFov(rig.fov);
        },
        dispose() { if (ctx.camera.isOwnedByMe) ctx.camera.release(); },
    };
}
```

## Input

`ctx.input` is `{ element, document, on(target, type, fn, opts), dispose() }`. `element` is the viewer canvas; `on` accepts any EventTarget (`element`, `window`, `document`) and returns nothing. All listeners are removed when the layer unmounts. There are no NDC or picking helpers: compute NDC from `element.getBoundingClientRect()` (the canvas sits inside the viewport/safe-frame rect), and raycast runtime objects yourself (`ctx.maxScene.raycast` only hits synced Max meshes). OrbitControls listens on the same canvas; with `controls: 'none'` its handlers exit early.

```js
const el = ctx.input.element, ndc = new THREE.Vector2(), ray = new THREE.Raycaster();
ctx.input.on(el, 'pointerdown', (e) => {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, ctx.camera.raw);
    const hit = ray.intersectObjects(ctx.js.root.children, true)[0];
});
ctx.input.on(window, 'keydown', (e) => { if (e.key === 'r') reset(); });
```

## Time and Rendered Output

- Live editor: `update(ctx, dt, elapsed)` gets the unclamped `THREE.Timer` delta; `ctx.clock` / `ctx.runtime.dt|elapsed` hold the same values. Snapshot: dt clamped to 0.25 s, 60 fps cap.
- **Render to Image / Render Sequence call `update` with `dt = 0` and `elapsed = frame / fps`**, several times per output frame during warm-up. A sim that integrates `dt` freezes in rendered output, and `elapsed` jumps backwards when a sequence starts.
- `ctx.maxTime` `{ seconds, frame, fps, playing, source }`: live it extrapolates between Max pushes while playing; in snapshots it is a local clock from `startFrame` that auto-plays without looping.
- There is no fixed-step helper (only `ctx.deform`'s `timeMode: 'timeline'`). For stateful sims, seed every RNG and replay at a fixed step when `dt === 0`:

```js
const STEP = 1 / 60;
let replayT = -1;                         // -1 while running live
function replayTo(t) {
    if (replayT < 0 || t < replayT - 1e-6) { resetSim(SEED); replayT = 0; }  // fresh, seeded
    while (replayT + STEP <= t + 1e-9) { sim.step(STEP); replayT += STEP; }
}
// update(ctx, dt, elapsed): dt > 0 ? (replayT = -1, sim.step(Math.min(dt, 0.05))) : replayTo(elapsed)
// Guard: a live frame can rarely report dt = 0 at the live elapsed; skip the replay in that case.
```

## Renderer, Shadows and Environment

- Editor default is `THREE.WebGPURenderer` on WebGPU, falling back to `forceWebGL` ("TSL_GL"); a stored `webgl2` preference uses the classic `WebGLRenderer`. Snapshots follow the exported backend (`snapshot_webgpu.html` by default). `ctx.runtime.isWebGPU` reports `true` for classic WebGL too; test `typeof THREE.WebGPURenderer === 'function'` for node-material support.
- `material.onBeforeCompile` does nothing on WebGPU/TSL_GL. Use node materials and TSL nodes (`colorNode`, `positionNode`, …) for runtime meshes, `ctx.deform` for synced meshes, or plain `BufferAttribute` writes + `computeVertexNormals()` for CPU-deformed geometry. GLSL `ShaderMaterial` does not compile on WebGPU, and objects using `RawShaderMaterial` are removed every frame there. Node materials multiply `instanceColor` **after** `colorNode`.
- Runtime objects get no shadow flags: set `castShadow` / `receiveShadow` yourself. Synced Max lights cast shadows when their Max shadow is on.
- The directional shadow frustum fits the bounds of visible **synced Max meshes** only, so runtime meshes outside them are clipped and a large set spreads the map thin. A Max helper named `ShadowMapOrigin` (radius in the name, cm: `ShadowMapOrigin_r500`) pins the frustum center and radius.
- max.js lights (`Directional_lightlight`, `Hemisphere_Light`, `Point_Light`, `Spot_Light`, `Rect_Area_Light`, `Ambient_Light`) aim along the node's local **−Y**. Their colors reach `light.color.setRGB()` unconverted, so a Max swatch is read as linear.
- Background/environment are read-only to layers (`ctx.maxScene.background|environment|fog`). Raw writes to `ctx.renderer.sceneRoot` are overwritten by host environment sync. Author the environment in Max, or use a runtime sky mesh. `ctx.renderer.pmremFromScene()` / `pmremFromEquirectangular()` return untracked textures: `ctx.js.own()` them.
- Indirect light comes from three.js irradiance probe grids (`LightProbeGrid`, or `LightProbeGridWebGL` on classic WebGL) fitted to Max Light Probe Grid helpers, or to the scene when there are none. They light runtime meshes too. Bakes capture the scene as it was; layer mutations reschedule one once the scene rests, never during playback. Meshes with a Max map channel 2 UV set can take baked GI lightmaps instead (node renderers, Light Probes panel). The Light Probes panel's Speedball mode (node renderers) replaces the grids with Speedball GI's live traced probes, which follow layer edits by themselves and add bounce on top of the HDRI; snapshots replay it, including older exports' `speedballGi` block. The path tracing view (WebGPU, live viewer only) traces synced and runtime meshes alike.

## PowerShot

PowerShot is the final post-processing stage: an ISP/camera-look pipeline (`web/js/fx/final/powershot.js`, vendor `powershot-threejs`) with `digital`, `analog` (VHS/camcorder), `film`, `infrared` and `nightshot` modes plus an optional Solar Flare pass. It renders the scene untone-mapped into a half-float target at `resolutionScale` and needs a node renderer (WebGPU or TSL_GL). It does not control layer time: its grain advances per rendered frame unless Freeze Noise is on, so layer motion must follow the rendered-output rules above to be repeatable. A `DirectionalLight` with `userData.solarFlareSun = true` is preferred as the flare sun.

## `ctx.deform` — GPU Vertex Deformation

`ctx.deform` deforms synced Max meshes in place through TSL `material.positionNode` — GPU vertex stage, no geometry clone, no hide/unhide, no per-frame CPU vertex work. Fastsync keeps flowing (transforms, materials, `geo_fast`); the deform survives fastsync material rebuilds automatically and works identically in the live viewport and exported snapshots (the layer re-applies it on boot). This is the preferred path for wind, sway, ripple, breathing, and any procedural vertex motion.

```js
export default function layer(ctx, THREE) {
    const wind = ctx.deform.attach(n => n.jsmod, {
        params: { strength: 6, speed: 1.2, dir: [1, 0, 0.3] },
        position: ({ position, uv, time, params, TSL }) => {
            const sway = TSL.sin(position.x.mul(0.25).add(time.mul(params.speed)));
            const mask = uv.y;  // bottom-to-top weight straight from UVs
            return position.add(params.dir.mul(sway).mul(params.strength).mul(mask));
        },
    });
    return {
        update(ctx) { /* live tuning: wind.params.strength = 8; */ },
        dispose() { wind.dispose(); },
    };
}
```

Targets: a node adapter, a handle, an exact name, `'Prefix*'`, a predicate `(adapter) => bool`, or an array of those. Name/prefix/predicate targets keep matching as nodes sync in, so calling `attach()` at mount (before the scene is populated) is safe and the canonical pattern. `n => n.jsmod` targets everything the artist flagged with the three.js Deform modifier in Max.

Builder args (all TSL nodes unless noted):

- `position` — the existing position chain (a TSL snippet's `positionNode` or an earlier deform) or `positionLocal`. Displace THIS and return the result; do not start from `positionLocal` yourself.
- `normal` — `normalLocal` or the existing `normalNode`.
- `uv` — `TSL.uv()`; other channels via `TSL.uv(1)` etc.
- `color` — `TSL.vertexColor()`; painted vertex colors make good deform weight masks.
- `weight` — modifier-stack sub-object selection weight (float node, 1.0 when none synced). A Poly Select / Vol. Select with soft selection below the three.js Deform modifier (or an Edit Poly soft selection at the top of the stack) ships per-vertex falloff as the `deformWeight` attribute — `position.add(offset.mul(weight))` makes the effect respect the artist's selection, falloff included. Weights ride geometry sync, so changing the selection on an already-synced jsmod mesh needs a geometry re-sync (toggle the modifier). Binds per material at decorate time — keep meshes sharing one material consistently weighted.
- `time` — uniform seconds. `timeMode: 'clock'` (default) is wall-clock; `timeMode: 'timeline'` follows the Max timeline / snapshot playback — use it when render output must be deterministic (powershot/film).
- `params` — your `options.params` as uniform nodes.
- `TSL`, `THREE` — namespaces (no imports needed in the builder).

Rules and behavior:

- `options.params` values may be number, `[x,y]`, `[x,y,z]`, `[x,y,z,w]`, `Vector2/3/4`, or `Color` — each becomes a uniform, live-settable through `fx.params.name = value` with no shader rebuild.
- `options.normal`: optional builder for `normalNode`. Without it, displaced vertices keep rest-pose shading normals (fine for subtle motion). Setting it overrides the material's normal map.
- Returned handle: `fx.params`, `fx.uniform(name)`, `fx.matched` (handles), `fx.active`, `fx.dispose()` (restores the original material nodes). Disposal is automatic on layer dispose/hot reload.
- Deformation binds per material: meshes sharing one Max material deform together. Assign a unique material in Max to isolate one object.
- Geometry stays at rest on the CPU — `ctx.maxScene.raycast` and `sampleSurface` read undeformed positions.
- TSL nodes must follow the three.js r187 chaining rules (see TSL Material Snippets below).
- The three.js Deform modifier flag is NOT required for `ctx.deform.attach`. Use the flag as the authoring marker (`n => n.jsmod` / `listJsmodNodes()`); it IS mandatory for `ctx.deform.simulate` and any other buffer-writing deformation because it stops fastsync geometry rebuilds from stomping the buffers.

### `ctx.deform.simulate` — Stateful Compute Simulation

For deformation with memory (inertia, springs, damped recovery) where a pure function of time isn't enough. Rebuilds the target's geometry ONCE with GPU storage attributes, runs your TSL kernel per vertex per frame via WebGPU compute, and restores the original geometry on dispose.

```js
const sway = ctx.deform.simulate(n => n.jsmod, {
    params: { stiffness: 30, damping: 4, wind: [6, 0, 2] },
    state: { velocity: 3 },              // named per-vertex storage channels (value = itemSize), zero-initialized
    normals: 'recompute',                // or 'keep' (default)
    compute: ({ position, rest, state, dt, time, params, TSL }) => {
        const p = position.read().toVar();
        const v = state.velocity.read().toVar();
        const accel = rest.read().sub(p).mul(params.stiffness)
            .add(params.wind.mul(TSL.sin(time)))
            .sub(v.mul(params.damping));
        v.addAssign(accel.mul(dt));
        state.velocity.assign(v);
        position.assign(p.add(v.mul(dt)));
    },
});
// sway.reset() re-uploads rest pose and zeroes state; sway.dispose() restores the original geometry.
```

Rules:

- REQUIRES the three.js Deform/jsmod flag on every target mesh (non-flagged matches are skipped with a console error). WebGPU only — the WebGL backend fails the entry gracefully.
- The `compute` callback runs ONCE to build the kernel. Write TSL graph code: kernel args `position` / `rest` / `normal` / `state.<name>` are storage accessors with `.read()`, `.assign(node)`, and `.x/.y/.z` element access; `weight` is a read-only float node carrying the modifier-stack sub-object selection weight (1.0 when none). Use `TSL.If` for branching, never JS conditionals on per-vertex values.
- `dt` is a uniform clamped to 0.1 s; `time` follows `timeMode` like attach().
- `normals: 'recompute'` rebuilds smooth normals on the GPU from triangle adjacency each frame; requires triangle topology. Default `'keep'` leaves rest-pose normals.
- CPU reads (`raycast`, `sampleSurface`) see the rest pose — simulated positions live on the GPU only.
- `attach()` and `simulate()` share targeting, `params`, and `timeMode` semantics.

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

### Unit scale (cm)

max.js scenes sync from 3ds Max in **centimeters** (`ctx.runtime.units` is `'cm'`; there is no `ctx.space`, the space helpers are `ctx.runtime.space`; world transforms, camera clips, and raycasts all assume cm). **TSL materials and textures must be authored to match this scale** — do not tune parallax, displacement, noise tiling, or effect strength as if the scene were meters.

- Prefer **cm-native `@param` names** when a value is physical (`openingWidthCm`, `virtualDepthCm`, `displacementCm`) rather than abstract UV magic numbers.
- When UV size maps to a real opening, expose the mesh width/height in cm and **normalize** procedural density, parallax reach, and glitter pitch against it (e.g. reference width **80 cm** for a typical porthole/panel).
- **Parallax / fake-depth** materials: derive UV offset from `depthCm / openingWidthCm`, not a standalone `0.0–1.0` scale copied from meter-based Three.js examples.
- **Vertex `positionNode` / deform offsets**: express displacements in cm (small sway ≈ 1–8 cm; wind on foliage ≈ 5–30 cm), not unitless 0.01-style meter defaults.
- **World-space TSL** (`positionWorld`, `cameraPosition`): distances between samples are in cm — divide or multiply consciously when porting shaders from meter-based demos.

```js
// Example: cm-normalized parallax reach for an ~80 cm reference opening
// @param float virtualDepthCm 280.0 80.0 1200.0
// @param float openingWidthCm 80.0 20.0 300.0
// @param float parallaxStrength 1.0 0.4 2.0
const cmNorm = TSL.float(80.0).div(params.openingWidthCm);
const parallaxReach = params.virtualDepthCm
    .div(params.openingWidthCm.mul(TSL.float(35.0)))
    .mul(params.parallaxStrength);
```

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

TSL in this repo is Three.js r187 (`web/vendor/three-r187`). Use method chaining, not JS infix operators:

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

TSL texture snippets inherit the same **cm** scene scale when baked onto scene geometry — tile noise and feature size against expected physical UV footprint (cm), not generic 0–1 UV assumptions.

## Quick Checklist

Before shipping runtime code:

- Can it run in standalone snapshot without Max?
- Does it read through `ctx.maxScene` and write through `ctx.js` or `node.transform`?
- Are all runtime objects tracked/owned for cleanup and snapshot export?
- Are TSL parameters declared with stable `// @param` names?
- Are TSL nodes valid for Three.js r187 (`web/vendor/three-r187`)?
- Do TSL defaults and physical params match **max.js cm unit scale** (not meter-based Three.js example values)?
