# M3 scene format

- Status: production contract, version 1
- Canonical snapshot filename: `scene.m3`
- HTTP media type: `application/octet-stream`

M3 is max.js's packed full-scene payload for vanilla Three.js consumers. It is
used for the initial scene and structural resyncs. New snapshots store it as
`scene.m3`; snapshots made before the rename may contain `scene.bin`. The bytes
did not change during the rename.

M3 is descriptor-driven. The `.m3` file is an opaque, little-endian byte arena;
its offsets, counts, types, hierarchy, materials, and resources live in the
companion `scene_bin` metadata object. A bare `.m3` file without its descriptor
is not self-describing.

## Contract at a glance

```json
{
  "type": "scene_bin",
  "format": "m3",
  "formatVersion": 1,
  "schemaVersion": 1,
  "units": { "label": "cm", "metersPerUnit": 0.01 },
  "bin": "scene.m3",
  "nodes": [
    {
      "h": 42,
      "n": "Box001",
      "t": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      "geo": {
        "vOff": 0,
        "vN": 72,
        "iOff": 288,
        "iN": 36,
        "iType": "u16"
      },
      "matRef": 0
    }
  ],
  "materials": []
}
```

The same metadata is sent as WebView2/SSE shared-buffer `additionalData` during
a live full sync. Live metadata normally has no `bin` field because the bytes
are already attached to the message.

| Root field | Meaning |
|---|---|
| `type` | Remains `scene_bin` for host-contract compatibility. Do not rename it to `m3`. |
| `format` | `m3`. Missing on legacy descriptors; readers may treat missing as M3 v1. |
| `formatVersion` | Binary arena interpretation. Current value is `1`. |
| `schemaVersion` | Companion metadata schema. Current value is `1`. |
| `units` | Physical scale for all scene-space numeric distances. |
| `units.label` | Human-readable unit label such as `cm` or `m`. |
| `units.metersPerUnit` | Metres represented by one numeric scene unit. Must be finite and greater than zero. |
| `bin` | Snapshot-relative payload URL. New Max exports use `scene.m3`. |
| `frame` | Producer frame/revision marker; it is not an MXJB frame header. |
| `nodes` | Hierarchy and byte-range descriptors. |
| `materials`, `camera`, `sceneCameras`, `lights`, `audios`, `gltfs`, `webapps`, `env` | JSON-side scene descriptors; not embedded in M3. |
| `forestInstances` | Optional instanced geometry and transform ranges in M3. |
| `animations` | Animation manifest. Its optional binary is a separate file, normally `scene_anim.bin`. |

Unknown additive metadata fields must be ignored. A reader must reject an
unsupported non-missing `format`, `formatVersion`, or `schemaVersion` rather
than guessing a layout.

## Units and coordinate basis

Values are stored in the producer's scene unit; they are not silently converted
to metres. Use `units.metersPerUnit` at integration boundaries:

```js
const meters = sceneDistance * meta.units.metersPerUnit;
const sceneUnits = meters / meta.units.metersPerUnit;
```

The 3ds Max producer emits centimetres:

```json
{ "label": "cm", "metersPerUnit": 0.01 }
```

Blender may emit metres or a scene-specific scale. Consumers must use the
descriptor and must not hard-code the Max value when a different host is
connected. This is especially important when creating Rapier colliders,
gravity, character dimensions, or velocities.

Authored geometry and node matrices are in the shared DCC basis: right-handed,
Z-up. The max.js scene applier parents authored content under a `-90°` X-axis
basis root to expose standard Three.js right-handed, Y-up world space. Do not
apply that rotation twice. Runtime-owned Three.js objects outside the authored
root are already Y-up.

Node `t`, skin bind, and MXJB 4x4 matrices use 16 values in Three.js
column-major element order. The packed instance-transform channel is the one
exception: it preserves Max `Matrix3` row layout and is transposed by the
instance decoder as described below.

## Binary arena rules

- All numeric words are little-endian.
- Every `*Off` value is an absolute byte offset from byte zero of the M3 payload.
- Every `*N` value is a scalar element count, not a byte count and not a vertex count.
- A range occupies `N * bytesPerElement` bytes.
- `f32`/`i32`/`u32` ranges are 4-byte aligned; 16-bit ranges are 2-byte aligned; 8-bit ranges need no padding.
- Padding bytes have no meaning. Writers currently zero them.
- Ranges may appear in any order declared by metadata. Multiple descriptors
  may alias the exact same range; partial overlaps are suspicious and should be
  reported by audit tools, but per-range type/alignment/bounds validation is
  the safety requirement.
- Max native object instances remain separate ordinary `nodes`. When their
  finalized geometry channels are byte-identical, the snapshot writer aliases
  their `geo` ranges to one M3 storage block, and consumers may reuse the same
  decoded `BufferGeometry` and typed arrays for those ordinary meshes. This
  does not emit `instOf` or `forestInstances`. Independently, the shared
  performance bucket engine may promote a sufficiently large alias family
  with one material signature into a real `THREE.InstancedMesh` draw. The
  ordinary nodes remain addressable (hidden as render substitutes), so the
  same payload wins both storage/allocation reuse and optional GPU draw reuse.
  Snapshot nodes with baked tracks or runtime visibility/transform overrides
  stay ordinary so handle-targeted behavior remains authoritative.
- Empty scenes still carry a small payload (currently four zero bytes); readers must not infer content from file size.
- Offsets and counts must be non-negative safe integers. Check multiplication and addition for overflow before constructing a typed array.

For every range, a reader must verify:

```text
off is aligned for the scalar type
count * bytesPerElement is an exact safe integer
off + count * bytesPerElement is an exact safe integer
off + count * bytesPerElement <= payload.byteLength
```

Then enforce the channel's item-size divisibility. Reject the affected geometry
instead of handing a fractional attribute count to Three.js.

## Geometry descriptors

`node.geo` and `forestInstances[].geo` use the following fields. A missing type
token means the legacy default shown below.

| Fields | Type | Item size | Required validation |
|---|---:|---:|---|
| `vOff`, `vN` | `f32` | 3 | `vN % 3 == 0` |
| `iOff`, `iN`, `iType` | default `i32`, optional `u16`; readers also accept explicit `u32` | 1 | Mesh `iN % 3 == 0`; spline `iN % 2 == 0`; every index `< vertexCount` |
| `uvOff`, `uvN`, `uvType` | default `f32`, optional `u16n` | 2 | `uvN % 2 == 0`; attribute count equals position count |
| `uv2Off`, `uv2N`, `uv2Type` | default `f32`, optional `u16n` | 2 | Same as UV. Loaded as Three.js `uv1` with `uv2` compatibility alias. |
| `nOff`, `nN`, `nType` | default `f32`, optional `i16n` | 3 | `nN % 3 == 0`; attribute count equals position count |
| `vc[].off`, `vc[].n` | default `f32` | `vc[].itemSize`, currently 4 | Count divisible by item size and equal vertex count |

Normalized encodings follow WebGL/Three.js conventions:

- `u16n`: `stored / 65535`, range `[0, 1]`.
- `i16n`: `max(-1, stored / 32767)`, range `[-1, 1]`.

Snapshot writers choose `u16` indices only when every index fits. UVs are
packed as `u16n` only when all values fit `[0,1]`; tiled or negative UVs remain
`f32`. Unit normals are normally `i16n`. Live full sync may use the wider
legacy defaults to minimize producer work.

`groups` is JSON, not an M3 range. Each entry is
`[indexStart, indexCount, materialSlot]`; `matRefs` resolves slots through the
root material library.

## Skin and morph ranges

`node.skin` describes four-influence skinning:

| Fields | Encoding | Rules |
|---|---|---|
| `wOff`, `wN`, `wType` | default `f32`, normally `u16n` | Four weights per vertex; `wN % 4 == 0`. Quantized groups are corrected to sum to 65535. |
| `iOff`, `iN`, `iType` | default `f32`, or `u8`/`u16` | Four bone indices per vertex; `iN == wN`. |
| `bindOff`, `bindN` | `f32` | One 16-float local bind matrix per bone; `bindN == bones.length * 16`. |
| `bones` | JSON handle array | Length must match bind matrix count. |
| `parent` | JSON parent-index array | `-1` means root. Indices must be in range, non-self, and acyclic. |

`node.morph` keeps names and initial influences in JSON. `dOff[i]`/`dN[i]`
select the `f32` relative-position delta stream for channel `i`. Each stream
must contain exactly `positionVertexCount * 3` floats.

## Instanced geometry

`forestInstances[]` can carry its own geometry plus an M3 transform stream:

| Field | Meaning |
|---|---|
| `xformOff` | Absolute byte offset. |
| `xformN` | Stored float count. |
| `xformType: "f32m16"` | `count * 16` floats preserving Max row-major `Matrix3` layout; transpose into a Three.js `Matrix4`. |
| `xformType: "affine12"` | `count * 12` row-layout floats; transpose the 3x4 affine values and reconstruct Three's last row as `[0,0,0,1]`. |

Validate that `xformN` is divisible by 16 or 12 as selected and that the
decoded instance count matches the descriptor's `count`.

## Filename and HTTP compatibility

New snapshot writers set `bin: "scene.m3"`. A loader must honor an explicit
custom `bin` value. For migration compatibility:

1. If `bin` names `scene.m3`, fetch it and retry legacy `scene.bin` only on 404.
2. If `bin` is missing, try `scene.m3`, then `scene.bin` on 404.
3. If `bin` names another path, treat that path as authoritative; do not mask a typo with an unrelated fallback.

`bin` is a clean snapshot-relative URL path. Reject a scheme, leading slash,
backslash, query, fragment, empty segment, `.`/`..` segment, or an encoded
segment that decodes to traversal or another path separator before fetching.

Serve `.m3` as `application/octet-stream` with `X-Content-Type-Options: nosniff`
where practical. M3 is identified by its descriptor and filename, not by MIME
sniffing. There is intentionally no unregistered vendor media type.

## What M3 is not

| Layer | Purpose | Identification |
|---|---|---|
| **M3** | Full-scene baseline and structural resync | `meta.type == "scene_bin"`, descriptor `format == "m3"` |
| **MXJB** | Ordered live deltas after a baseline | `meta.type == "delta_bin"`; bytes begin `MXJB` |
| **`scene_anim.bin`** | Optional sampled animation tracks referenced by snapshot metadata | `animations.bin` |
| **Relay envelope** | Carries one metadata object plus one untouched payload across a broker | `[u32 jsonLength][UTF-8 JSON][payload]` |

Never parse M3 as MXJB. M3 has no magic header; MXJB always does. The relay
envelope does not modify the payload it wraps.

## MXJB delta protocol v1

MXJB is documented here because M3 consumers commonly need both. Its frame
header is exactly 16 bytes:

| Offset | Type | Meaning |
|---:|---:|---|
| 0 | `u32` | Magic `0x424A584D`; little-endian bytes spell `MXJB`. |
| 4 | `u16` | Version `1`. |
| 6 | `u16` | Reserved, must be zero. |
| 8 | `u32` | Frame ID. |
| 12 | `u32` | Command count. |

Each command begins with `u16 opcode, u16 commandByteLength`. Length includes
the four-byte command header. A v1 decoder accepts only the exact sizes below,
must reject opcode 9, and must consume the frame exactly with no trailing bytes.

| Opcode | Command | Total bytes | Payload after command header |
|---:|---|---:|---|
| 1 | `BeginFrame` | 8 | `u32 frameId` (must equal header) |
| 2 | `UpdateTransform` | 72 | `u32 handle`, `f32 matrix[16]` |
| 3 | `UpdateMaterialScalar` | 32 | `u32 handle`, `f32 color[3]`, roughness, metalness, opacity |
| 4 | `UpdateSelection` | 12 | `u32 handle`, `u32 selected` |
| 5 | `UpdateVisibility` | 12 | `u32 handle`, `u32 visible` |
| 6 | `UpdateCamera` | 68 | `f32 pos[3], target[3], up[3], fov`, `u32 perspective`, `f32 viewWidth`, `u32 dofEnabled`, `f32 focusDistance, focalLength, bokehScale` |
| 7 | `EndFrame` | 4 | No payload |
| 8 | `UpdateLight` | 152 | Handle, matrix, visibility/type, light scalars, shadow settings, volumetric contribution |
| 9 | retired | — | Was `UpdateSplat`; never reuse |
| 10 | `UpdateAudio` | 76 | `u32 handle`, matrix, `u32 visible` |
| 11 | `UpdateTime` | 16 | `i32 ticks`, `i32 ticksPerFrame`, `u8 flags`, three zero pad bytes |
| 12 | `UpdateGLTF` | 76 | `u32 handle`, matrix, `u32 visible` |
| 13 | `UpdateWebApp` | 76 | `u32 handle`, matrix, `u32 visible` |

The legacy 52-byte `UpdateCamera` command (ending after `viewWidth`) remains
readable. No other alternate sizes are valid. Boolean `u32` fields are 0 or 1;
`UpdateTime.flags` currently uses only bit 0 (`playing`).

A decoder should preflight the complete frame before invoking handlers so a
malformed tail cannot partially mutate a scene. The canonical implementations
are `src/sync_protocol.h/.cpp` and `web/js/protocol.js`.

## Relay framing

Relay protocol v1 wraps either M3, MXJB, another binary fast lane, or a JSON
message without changing it:

```text
u32 metadataByteLength (little-endian)
metadataByteLength bytes of strict UTF-8 JSON
remaining bytes: payload
```

`metadata.relay` supplies `version`, `streamId`, `producerId`, `sessionId`,
`sceneRevision`, and `sequence`. A full-scene frame also echoes
`sceneRequestId`. See [Relay mode](RELAY_MODE.md) for lifecycle and integration.

## Versioning and validation

- `formatVersion` changes only when existing M3 bytes acquire a different interpretation.
- `schemaVersion` changes when existing required metadata changes incompatibly.
- New optional fields or channel tokens may be added without changing v1 readers; readers ignore unknown metadata but reject an unknown required encoding on geometry they apply.
- Producers must send a new full baseline before deltas from a new scene revision.
- Consumers must cap metadata, payload, node, channel, and allocation sizes before accepting untrusted relay input.
- Apply M3 transactionally: validate all descriptor ranges first, build the replacement scene, then acknowledge baseline readiness.

Focused regression coverage lives in `tools/m3-protocol-smoke.mjs` and runs with:

```powershell
node tools/m3-protocol-smoke.mjs
```
