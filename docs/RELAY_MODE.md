# Relay mode

Status: production contract, protocol version 1

Relay mode turns max.js into a live DCC-to-Three.js scene source. 3ds Max or
Blender produces the same M3 baseline, MXJB deltas, geometry fast-lane frames,
and JSON control messages that its local viewer would consume. A small Vite
plugin brokers those frames to one vanilla Three.js application.

The receiving application owns rendering, gameplay, editor UI, physics, and
asset policy. Relay does not introduce another renderer or a second scene
model.

```text
3ds Max or Blender
        |
        | ordered relay frames (HTTP POST)
        v
maxjsRelay Vite plugin on 127.0.0.1
        |
        | ordered relay frames (WebSocket)
        v
RelayClient -> the application's existing M3/MXJB/geo/JSON appliers
        |
        +--> Three.js renderer / level editor / Rapier
```

## Rendering and GPU behavior

Relay is an explicit mode, not a permanent mirror.

- In 3ds Max, choose **Tools > RELAY**. It starts OFF on every boot.
- The Max WebView remains the transport host, but its presentation loop fully
  suspends after the broker reports at least one ready consumer. It continues
  to ingest native scene messages and forwards them without rendering another
  viewport.
- If no consumer is ready, the Max viewport keeps rendering. A mistyped URL or
  an unopened game must not leave the artist looking at a dead viewport.
- When the last ready consumer disconnects or Relay is disabled, local
  presentation resumes.
- Blender has no hidden WebView. In the max.js Blender panel, use **Start Relay
  (No Viewer)**. The default **Broker** is
  `http://127.0.0.1:5173/maxjs-relay-in` and the default **Stream** is
  `default`. **Stop Live IPR** stops either Blender live mode.

The Blender button is the headless producer path: it starts extraction and
streaming without opening a browser viewer, so only the standalone application
uses GPU resources. See the sibling `maxjs-blender` repository README for its
installation and host-specific controls.

The Max runtime API is also available as `window.maxJS.relay`:

```js
window.maxJS.relay.enable();
window.maxJS.relay.disable();
window.maxJS.relay.toggle();
window.maxJS.relay.getState();
```

Advanced integrations may also use `emit` and `subscribe`. Persisted
`maxjs.liveRelayUrl` and `maxjs.liveRelayStream` values configure the producer;
they never auto-enable Relay.

## Minimal standalone setup

The broker runs inside the receiving Vite project. Start that project before
enabling Relay in Max or starting the headless Blender producer.

Install the ordinary application dependencies:

```powershell
npm install three
npm install --save-dev vite ws
```

Run Vite from the receiving project's root. The relay plugin deliberately
resolves `ws` from that project's `node_modules`, even when the plugin itself
is imported from a sibling max.js checkout.

Import the reusable plugin from a max.js checkout or vendored copy. Keep the
Vite server loopback-only:

```js
// vite.config.js
import { defineConfig } from 'vite';
import { maxjsRelay } from '../maxjs/tools/maxjs-relay-vite.mjs';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  plugins: [
    maxjsRelay({ streamId: 'default' }),
  ],
});
```

The defaults line up without configuration:

| Side | Default |
|---|---|
| Producer ingest | `http://127.0.0.1:5173/maxjs-relay-in` |
| Browser consumer | `/maxjs-relay?role=consumer&streamId=default&version=1` |
| Stream | `default` |

`maxjsRelayVite` and the plugin's default export are aliases of
`maxjsRelay`. Options include `allowedStreams`, `ingestPath`, `consumerPath`,
`allowedOrigins`, `producerLeaseMs`, `limits`, and the opt-in asset proxy
described below.

In the browser, use `RelayClient`. It is deliberately a small, ordered
transport client; it does not create a renderer or hide the scene application
behind a relay-specific abstraction.

```js
import RelayClient from '../maxjs/web/js/relay_client.js';
import { applySceneBin } from '../maxjs/web/js/scene_applier.js';
import { applyDeltaFrame } from '../maxjs/web/js/protocol.js';
import * as THREE from 'three';

const scene = new THREE.Scene();
let applied = null;
let metersPerUnit = null;
let rapierState = null;

// Replace these no-ops when Rapier is enabled. Build must stage a complete
// state without replacing the live physics world; activation is synchronous.
async function buildRapierState(maxRoot, scale, { signal }) { return null; }
function activateRapierState(state) {}
function disposeRapierState(state) {}
function updateRapierBodyPose(state, handle, object, scale) {}
function updateRapierBodyVisibility(state, handle, object, visible) {}

function applyMaterialScalars(object, { color, rough, metal, opacity }) {
  if (!object) return;
  const materials = Array.isArray(object.material)
    ? object.material
    : [object.material];
  for (const material of materials) {
    if (!material) continue;
    material.color?.fromArray(color);
    if ('roughness' in material) material.roughness = rough;
    if ('metalness' in material) material.metalness = metal;
    material.opacity = opacity;
    material.transparent = opacity < 1;
    material.needsUpdate = true;
  }
}

async function applyHostJsonMessage(data, envelope, { signal }) {
  signal.throwIfAborted?.();
  // Route mat_fast, camera/resource, and other JSON lanes used by your app.
  console.debug('relay JSON', data, envelope);
}

function makeStagingScene() {
  const stagingScene = new THREE.Scene();
  const basisRoot = new THREE.Group();
  basisRoot.rotation.x = -Math.PI / 2; // shared DCC Z-up -> Three.js Y-up
  const maxRoot = new THREE.Group();
  basisRoot.add(maxRoot);
  stagingScene.add(basisRoot);

  return {
    basisRoot,
    ctx: {
      scene: stagingScene,
      maxRoot,
      nodeMap: new Map(),
      forestMeshes: new Map(),
    },
  };
}

function disposeBaseline(baseline) {
  if (!baseline?.basisRoot) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  baseline.basisRoot.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of list) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
        else if (Array.isArray(value)) {
          for (const item of value) if (item?.isTexture) textures.add(item);
        }
      }
      for (const uniform of Object.values(material.uniforms ?? {})) {
        if (uniform?.value?.isTexture) textures.add(uniform.value);
      }
    }
  });
  baseline.basisRoot.removeFromParent();
  for (const geometry of geometries) geometry.dispose?.();
  for (const material of materials) material.dispose?.();
  for (const texture of textures) texture.dispose?.();
}

const transformScratch = {
  raw: new THREE.Matrix4(),
  parentInRoot: new THREE.Matrix4(),
  parentInv: new THREE.Matrix4(),
  rootInv: new THREE.Matrix4(),
};

function hierarchyDepth(object, maxRoot) {
  let depth = 0;
  for (let cursor = object?.parent; cursor && cursor !== maxRoot; cursor = cursor.parent) {
    depth += 1;
  }
  return depth;
}

// M3/MXJB matrices are authored in maxRoot space. Three.js child matrices are
// parent-local, so applying the raw matrix directly is wrong for hierarchies.
function applyRootSpaceTransform(object, matrix, maxRoot) {
  transformScratch.raw.fromArray(matrix);
  if (object.parent && object.parent !== maxRoot) {
    maxRoot.updateMatrixWorld(true);
    object.parent.updateMatrixWorld(true);
    transformScratch.rootInv.copy(maxRoot.matrixWorld).invert();
    transformScratch.parentInRoot
      .copy(transformScratch.rootInv)
      .multiply(object.parent.matrixWorld);
    transformScratch.parentInv.copy(transformScratch.parentInRoot).invert();
    transformScratch.raw.premultiply(transformScratch.parentInv);
  }
  object.matrix.copy(transformScratch.raw);
  object.matrixAutoUpdate = false;
  object.matrixWorldNeedsUpdate = true;
}

async function applyM3Baseline(frame, { signal }) {
  if (frame.format !== 'binary' || frame.meta?.type !== 'scene_bin') {
    throw new Error('This consumer requires a binary M3 baseline');
  }
  if (frame.meta.format !== 'm3' || frame.meta.formatVersion !== 1 ||
      frame.meta.schemaVersion !== 1) {
    throw new Error('Unsupported M3 descriptor version');
  }

  const scale = Number(frame.meta.units?.metersPerUnit);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('M3 units.metersPerUnit is required');
  }

  // Apply off-scene. Only replace the visible baseline after the complete M3
  // payload succeeds, so a malformed baseline cannot leave a half-built level.
  const next = makeStagingScene();
  let nextRapierState = null;
  try {
    signal.throwIfAborted?.();
    await applySceneBin({
      buffer: frame.payload.buffer,
      meta: frame.meta,
      ctx: next.ctx,
    });
    signal.throwIfAborted?.();
    next.ctx.maxRoot.updateMatrixWorld(true);
    nextRapierState = await buildRapierState(next.ctx.maxRoot, scale, { signal });
    signal.throwIfAborted?.();
  } catch (error) {
    disposeRapierState(nextRapierState);
    disposeBaseline(next);
    throw error;
  }

  // No await occurs between the last abort check and this synchronous swap.
  // Keep the previous visual/physics state alive until both replacements exist.
  const previous = applied;
  const previousRapierState = rapierState;
  try {
    scene.add(next.basisRoot);
    activateRapierState(nextRapierState);
  } catch (error) {
    next.basisRoot.removeFromParent();
    disposeRapierState(nextRapierState);
    disposeBaseline(next);
    throw error;
  }
  next.ctx.scene = scene;
  applied = next;
  rapierState = nextRapierState;
  metersPerUnit = scale;
  disposeBaseline(previous);
  disposeRapierState(previousRapierState);
}

function applyMXJB(buffer) {
  const pendingTransforms = [];
  const pendingVisibility = [];
  applyDeltaFrame(buffer, {
    onTransform(handle, matrix) {
      const object = applied?.ctx.nodeMap.get(handle);
      if (!object) return;
      // The protocol decoder may reuse scratch storage, so retain a copy.
      pendingTransforms.push({ handle, object, matrix: Float32Array.from(matrix) });
    },
    onVisibility(handle, visible) {
      const object = applied?.ctx.nodeMap.get(handle);
      if (!object) return;
      object.userData.maxjsVisible = visible;
      object.visible = true;
      object.layers.set(visible ? 0 : 31);
      pendingVisibility.push({ handle, object, visible });
    },
    onMaterialScalar(handle, values) {
      applyMaterialScalars(applied?.ctx.nodeMap.get(handle), values);
    },
    // Add camera, light, time, selection, audio, glTF, and WebApp handlers
    // used by the receiving application. protocol.js validates all opcodes.
  });
  if (!applied) return;

  // Parents must land before children because every incoming matrix is in the
  // shared root space and must be converted against the settled parent.
  pendingTransforms.sort((a, b) =>
    hierarchyDepth(a.object, applied.ctx.maxRoot) -
    hierarchyDepth(b.object, applied.ctx.maxRoot));
  for (const { object, matrix } of pendingTransforms) {
    applyRootSpaceTransform(object, matrix, applied.ctx.maxRoot);
  }
  applied.ctx.scene.updateMatrixWorld(true);

  // A parent-only MXJB update also moves every descendant body in world space.
  // De-duplicate descendants after the complete visual batch has settled.
  const physicsObjects = new Map();
  for (const { object } of pendingTransforms) {
    object.traverse((descendant) => {
      const handle = Number(descendant.userData?.maxjsHandle);
      if (Number.isSafeInteger(handle) && handle > 0) {
        physicsObjects.set(handle, descendant);
      }
    });
  }
  for (const [handle, object] of physicsObjects) {
    updateRapierBodyPose(rapierState, handle, object, metersPerUnit);
  }
  for (const { handle, object, visible } of pendingVisibility) {
    // Remove/disable hidden colliders and restore them when shown. If the
    // receiving app inherits parent visibility, apply the same effective-
    // visibility policy to this object's descendant bodies here.
    updateRapierBodyVisibility(rapierState, handle, object, visible);
  }
}

const relay = new RelayClient({
  streamId: 'default',

  // RelayClient awaits this promise. It sends baseline_ready only after this
  // function has successfully applied and committed the complete M3 scene.
  onScene: applyM3Baseline,

  async onFrame(frame, { signal }) {
    signal.throwIfAborted?.();
    if (frame.meta.type === 'delta_bin') {
      applyMXJB(frame.payload.buffer);
      signal.throwIfAborted?.();
      return;
    }
    if (frame.meta.type === 'geo_fast') {
      // Full products should route this to their existing geo_fast applier,
      // then rebuild the affected collider from the accepted Three.js mesh.
      // This minimal consumer remains correct by requesting a fresh M3 scene.
      relay.requestResync('geometry_update_requires_baseline');
      return;
    }
    throw new Error(`Unsupported relay frame: ${frame.meta.type}`);
  },

  async onMessage(data, envelope, { signal }) {
    await applyHostJsonMessage(data, envelope, { signal });
    signal.throwIfAborted?.();
  },

  onStatus(status) {
    document.body.dataset.relayState = status.state;
  },
});

// On application teardown:
// relay.dispose();
// disposeRapierState(rapierState);
// disposeBaseline(applied);
```

`frame.payload` is an exact-offset `Uint8Array`, so `frame.payload.buffer` is
safe for the existing M3 and MXJB parsers. The simple `scene_applier.js`
defaults build visible geometry with portable materials. A production level
editor should inject its material/resource hooks or route callbacks into its
existing max.js scene-sync layer for full material, camera, light, audio,
glTF, WebApp, and `geo_fast` behavior.

`disposeBaseline` assumes the baseline owns the resources it disposes. If the
receiving app shares cached materials or textures across levels, replace that
function with the app's reference-counted resource teardown.

The example's explicit full-baseline fallback for `geo_fast` is correct but
more expensive than applying the geometry packet in place. It is a useful
first integration step, not the target for a deform-heavy production scene.

## Baseline and ordering contract

Relay protocol v1 is baseline-gated and strictly ordered:

1. A consumer connects and requests a baseline.
2. The producer emits one `scene_bin` M3 frame with sequence `0`, a new scene
   revision, and the request identity.
3. `RelayClient` awaits `onScene` in its single apply queue.
4. Only after `onScene` resolves does it send `baseline_ready`.
5. Ordered MXJB, `geo_fast`, and JSON continuations begin at sequence `1`.

The broker never declares the consumer ready merely because bytes arrived.
This is what lets the Max renderer suspend safely: the external Three.js scene
has actually accepted its baseline first.

`RelayClient` automatically requests a new scene after a sequence gap, queue
overflow, callback rejection, reconnect, producer-session change, or scene
revision mismatch. Do not catch and discard an apply failure inside a callback;
let the promise reject so the client can resynchronize. Call `dispose()` during
application teardown.

Every apply callback receives a final context argument
`{signal, epoch, deadlineMs, requestResync}`. The default callback deadline is
60 seconds and is configurable with `callbackTimeoutMs`. Long asset, collider,
or worker jobs must observe `signal`; tag their output with `epoch` and discard
late work. The deadline still unwedges the ordered receive queue if a callback
fails to settle.

Binary relay frames preserve the producer payload byte-for-byte. Their outer
envelope is:

```text
u32 metadataByteLength, little-endian
metadataByteLength bytes of strict UTF-8 JSON
remaining bytes: M3, MXJB, or another declared fast-lane payload
```

See [M3 scene format](M3_FORMAT.md) for the descriptor, geometry ranges, MXJB
opcodes, validation rules, and versioning policy.

## Relay protocol v1 control schemas

All identifiers match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. All counters are
non-negative safe integers. Unknown versions, streams, origins, identities,
control kinds, and out-of-order frames fail closed.

Producer registration, heartbeat, and intentional release use the same
identity object:

```json
{"kind":"producer_hello","version":1,"streamId":"default","producerId":"max-01","sessionId":"abc"}
{"kind":"producer_ping","version":1,"streamId":"default","producerId":"max-01","sessionId":"abc"}
{"kind":"producer_goodbye","version":1,"streamId":"default","producerId":"max-01","sessionId":"abc"}
```

Every accepted producer request returns:

```json
{
  "kind":"relay_status", "version":1, "relayId":"...",
  "streamId":"default", "producerId":"max-01", "sessionId":"abc",
  "consumers":1, "readyConsumers":0, "needScene":true,
  "sceneRequestId":4, "sceneRevision":2
}
```

`readyConsumers` counts only consumers that acknowledged the active producer,
session, revision, and request. `needScene` stays true until a sequence-0 scene
echoes the current `sceneRequestId`. Pending scene requests coalesce; a join or
error cannot repeatedly advance the request while one authoritative baseline
is already outstanding. `producer_goodbye` releases ownership immediately;
the 15-second producer lease is only a crash fallback.

JSON scene and continuation envelopes are:

```json
{"kind":"scene","relay":{"version":1,"streamId":"default","producerId":"max-01","sessionId":"abc","sceneRevision":3,"sequence":0,"sceneRequestId":4},"data":{"type":"scene"}}
{"kind":"msg","relay":{"version":1,"streamId":"default","producerId":"max-01","sessionId":"abc","sceneRevision":3,"sequence":1},"data":{"type":"env_update"}}
```

Binary frames carry the same `relay` object inside their metadata. A scene has
sequence `0`, must echo the current request id, and must advance the revision.
Every binary or JSON continuation then increments sequence exactly once.

On WebSocket connection the broker sends:

```json
{"kind":"relay_hello","version":1,"relayId":"...","streamId":"default","sceneRequestId":4}
{"kind":"resync_required","version":1,"relayId":"...","streamId":"default","sceneRequestId":5,"reason":"consumer_join"}
```

The consumer may request recovery:

```json
{"kind":"resync_request","version":1,"relayId":"...","streamId":"default","producerId":"max-01","sessionId":"abc","sceneRevision":3,"reason":"sequence_gap"}
```

After and only after `onScene` resolves, `RelayClient` sends:

```json
{"kind":"baseline_ready","version":1,"relayId":"...","streamId":"default","producerId":"max-01","sessionId":"abc","sceneRevision":3,"sceneRequestId":5}
```

The broker confirms that exact active identity:

```json
{"kind":"consumer_status","version":1,"relayId":"...","streamId":"default","ready":true,"sceneRevision":3,"readyConsumers":1}
```

The broker never caches a baseline for a future consumer. Every late join gets
a fresh producer baseline. Default safeguards cap consumers, bound queues and
bodies, coalesce outstanding requests, enforce both per-socket and per-stream
resync budgets across reconnect churn, and close a consumer that exceeds the
configured window. A producer goodbye tombstones that exact session for one
lease interval, so an older in-flight hello cannot reclaim the stream after an
intentional Max/Blender handoff.

## Units, basis, and Rapier

Never assume centimetres. Max currently publishes:

```json
{ "label": "cm", "metersPerUnit": 0.01 }
```

Blender can publish a different scale. Treat `units.label` as display text and
`units.metersPerUnit` as the conversion contract. Three.js content can remain
in producer scene units; convert every physics length, translation, velocity,
gravity-related dimension, and collider vertex to metres at the Rapier
boundary.

Collider generation must follow the applied scene, not raw packet metadata:

1. Await a complete accepted M3 baseline and update Three.js world matrices.
2. Traverse the resulting `maxRoot`, respecting hierarchy, basis conversion,
   object scale, instancing, visibility policy, and the final BufferGeometry.
3. Convert spatial values with `units.metersPerUnit` and build Rapier bodies and
   colliders keyed by `userData.maxjsHandle`.
4. After each accepted `geo_fast` update, rebuild only the affected handle's
   collider from its now-updated Three.js geometry.
5. For MXJB transform updates, move the existing rigid body or collider pose;
   do not remesh unchanged geometry.
6. For MXJB visibility updates, disable/remove the matching body and collider,
   then restore it when visible. Apply the same rule to descendants only when
   the receiving application's visibility policy is inherited.

If collider work runs in a worker, tag jobs with the relay scene revision and
sequence. Discard results made obsolete by a newer baseline or geometry frame.

## Assets

Relay forwards scene/resource descriptors; it does not silently expose the
DCC filesystem or rewrite arbitrary source paths. Prefer project-relative URLs
that the receiving application already serves.

For local development, the Vite plugin has an opt-in, allowlisted asset proxy:

```js
maxjsRelay({
  streamId: 'default',
  assetProxy: {
    path: '/maxjs-assets/',
    roots: ['D:/Project/ApprovedTextures'],
    extensions: ['.png', '.jpg', '.webp', '.hdr', '.exr', '.ktx2'],
    maxBytes: 256 * 1024 * 1024,
  },
});
```

Both `roots` and `extensions` must be explicit and non-empty. Requests are
loopback-only, path-contained after realpath resolution, extension-filtered,
and size-capped. The receiving application remains responsible for mapping a
metadata asset reference to `/maxjs-assets/...` or to its own asset pipeline.
Do not use the development proxy as a deployment asset strategy.

## Multiple projects and streams

The default stream is `default`. To isolate two running scenes, choose a stable
stream name in all three places:

```js
maxjsRelay({
  streamId: 'city-level',
  allowedStreams: ['city-level'],
});

new RelayClient({
  streamId: 'city-level',
  onScene,
  onFrame,
});
```

Set the same stream in the Max relay setting or Blender **Stream** field. A
consumer never accepts frames from another stream, producer session, or scene
revision.

## Failure checklist

- **Max does not suspend rendering:** confirm the consumer reached `ready`, not
  merely `connected`; inspect `onStatus` and make sure `onScene` resolves.
- **Repeated baseline loop:** let the real callback error surface. Common causes
  are an unsupported M3 version, bad byte range, missing units, or a consumer
  that does not implement a fast lane and requests resync for every packet.
- **Scene scale is wrong:** read `meta.units.metersPerUnit`; do not hard-code
  Max centimetres in a Blender-capable application.
- **Scene is rotated twice:** create exactly one `-PI / 2` X basis boundary for
  authored DCC content. Runtime-owned Three.js objects remain native Y-up.
- **Textures do not load:** use project-relative URLs or explicitly configure
  the allowlisted asset proxy. Relay does not grant browser access to local
  file paths.
- **Changes stop after reconnect:** keep RelayClient alive. It requests and
  gates a replacement baseline automatically; do not apply cached continuations.
- **High collider cost:** rebuild geometry colliders only after accepted M3 or
  `geo_fast` changes, and update body poses for transform-only MXJB frames.

## Security boundary

The production defaults deliberately bind relay transport to loopback. The
broker checks the HTTP Host, socket address, browser origin, consumer
role/version, stream identity, payload limits, producer lease, resync budget,
and strict frame sequence. Keep it local during development.
Exposing a relay outside the machine requires an application-level design for
authentication, TLS, authorization, rate limits, and asset isolation; changing
Vite's host alone is not that design.
