# max.js v0.5.1

max.js 0.5.1 is a focused stability release for heavy instancing workflows. It fixes large Forest Pack, RailClone, and tyFlow scenes in WebGPU while keeping the viewer's clean header, fast GPU instancing path, and runtime scripting surface intact.

Visit [clone.llc](https://clone.llc/) to see a website exported using max.js! More examples will be added soon!
Thank you for your support!

Note: PostFX stack cannot be exported using snapshots **yet**.

Baseline: `v0.5.0`.

## New Features

- **Instance group metadata** - synced Forest Pack, RailClone, and tyFlow instance payloads now include stable kind metadata and namespaced keys such as `forestpack:<source>` and `railclone:<source>`.

## Improved

- **WebGPU instancing** - large Forest Pack, RailClone, and tyFlow groups are batched into WebGPU-safe `THREE.InstancedMesh` slices to avoid `bindGroup_object` failures on very high instance counts.
- **Forest Pack material stability** - WebGPU Forest Pack instancing now uses a constrained material profile for complex tree sources, preserving diffuse/alpha cutout readability while avoiding advanced material bind-group failures.
- **Performance** - heavy scatters stay on the GPU instancing path and are not expanded into individual meshes. Large instance matrix uploads are chunked across frames so huge Forest Pack, RailClone, and tyFlow scenes do not freeze the viewer while loading.
- **Runtime layers** - `ctx.instances` aggregates sliced WebGPU batches back into one logical handle, so scripts can keep using global instance indices for `getMatrixAt`, `setMatrixAt`, position helpers, iteration, and flushing.
- **RailClone materials** - RailClone explicitly preserves subobject material grouping for segment material IDs and is excluded from Forest Pack's WebGPU material-collapse path.
- **Snapshot / Viewer parity** - standalone snapshot replay uses the same instance batching behavior as the live viewer.
- **Resource cleanup** - live and standalone instance rebuilds now retire old instanced geometry and materials through the deferred disposal path so WebGPU does not keep stale object bindings alive.

## Supported 3ds Max versions

- **Built & tested:** 2026, 2027.
- **2024 & 2025:** compile + link cleanly against their SDKs. Not tested as I don't have old 3dsmax versions installed. Please let me know about any issues.

## Install

1. Copy `maxjs.gup` and `maxjs_web/` into your `3ds Max <ver>\plugins` folder.

## Known limits

- Path tracing is experimental and live-only and not part of the stable snapshot/export contract.
- Arbitrary 3dsmax procedural texmap baking remains intentionally disabled.
- No PostFX in snapshots yet. Coming in a future release.

Each archive contains `maxjs.gup` + `maxjs_web/`. See **Install** above.
