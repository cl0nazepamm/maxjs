---
name: maxjs-runtime
description: Write MaxJS runtime code for scene scripts, project layers, TSL materials, TSL textures, HTML texmaps, gameplay layers, and snapshot-safe Three.js behavior. Use when touching layer ctx APIs, synced scene data, transform overrides, sampleSurface, TSL shader code, TSL parameters, lightmap UV channels, or live-vs-snapshot parity.
---

# MaxJS Runtime

MaxJS runs Three.js code against scene data synced from 3ds Max. Treat 3ds Max as the editor/source of truth, and write runtime behavior on top of the live synced scene.

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

Data flow:

```text
3ds Max -> native fastsync -> nodeMap/lightHandleMap -> ctx.maxScene facades -> layer code
```

`ctx.maxScene` is the authored scene read surface. It reads the same live maps fastsync updates; it is not a copied scene graph.

Useful calls:

- `ctx.maxScene.getNode(handle)` returns a node adapter.
- `ctx.maxScene.findByName(name, { exact })` returns matching adapters; unwrap `[0]` when expecting one.
- `ctx.maxScene.listNodes()` / `listHandles()` enumerate synced meshes and lights.
- `ctx.maxScene.listJsmodNodes()` finds meshes with the three.js Deform/jsmod flag.
- `ctx.maxScene.raycast(origin, direction, { near, far })` hits visible synced meshes.
- `ctx.maxScene.createAnchor(handle, options)` creates a runtime object that follows a synced node.

`ctx.nodeMap` is a lower-level read-only handle facade when iteration over raw synced entries is useful.

## Node Adapters

Adapters represent synced Max objects.

- Metadata: `node.handle`, `node.name`, `node.isMesh`, `node.visible`, `node.jsmod`.
- Live reads: `node.position`, `node.quaternion`, `node.scale`, `node.matrixWorld`.
- Geometry sampling: `node.sampleSurface({ point, normal, rng })`.
- Anchors: `node.createAnchor(options)`.
- Orientation helpers: `getPivotWorldPosition()`, `getVisualCenter()`, `getPivotToVisualCenter()`, `getLocalAxesWorld()`, `getOrientationSnapshot()`.

Use orientation helpers before gameplay/rig work. MaxJS runtime is Three.js Y-up: ground plane is XZ, height is Y, and Max-space vectors map as `x,z,-y`.

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
- `ctx.js.cloneFromMax(handle)` only when the runtime clone should replace the authored render truth

## Moving Synced Objects

Use `node.transform`, not raw Three.js transforms:

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
- `ctx.input`: event helper with auto-cleanup.
- `ctx.clock`: JS runtime time, `{ dt, elapsed }`.
- `ctx.maxTime`: Max timeline, `{ seconds, frame, fps, playing, source }`.
- `ctx.bus`: shared event bus, auto-unsubscribed on dispose.
- `ctx.services`: shared service registry between layers.
- `ctx.runtime`: runtime metadata and helpers; includes `ctx.runtime.gltf`.
- `ctx.THREE`: same Three.js namespace passed as the second factory arg.

`ctx.camera` can lock to Max scene cameras and expose the live render camera:

- `ctx.camera.raw` returns the underlying Three.js camera for last-mile render offsets such as handheld shake. This does not claim script ownership by itself.
- `ctx.camera.listSceneCameras()` returns synced scene cameras as `{ handle, h, name, n }`.
- `ctx.camera.findSceneCamera(name, { exact })` searches the scene camera list. Do this for Physical Cameras; `ctx.maxScene.findByName()` only searches synced meshes/lights.
- `ctx.camera.usePhysicalCamera(handleOrEntry)` / `ctx.camera.usePhysicalCameraByName(name, { exact })` locks the viewer to a Max camera object while still allowing a layer to apply a post-sync camera offset through `ctx.camera.raw`.

`ctx.runtime.gltf` reads MaxJS glTF Origin objects:

- `get(handle)`
- `findByName(name)`
- `list()`
- `onReady(handle, cb)`

Check `entry.state` before using `entry.root` or `entry.clips`.

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
