# Runtime packages

- Three.js: `0.187.0` in `vendor/three-r187` (stock build; four addon patches listed in `THREE_MIGRATION.md`).
- three-gpu-pathtracer: `main` at `1df8ec7b8a` (unreleased r187 port) in `vendor/three-gpu-pathtracer`; the editor's path tracing view only. `src/` is upstream except that `webgpu/nodes/aux.wgsl.js` is renamed `auxBuffers.wgsl.js` (imports updated): `aux` is a reserved Windows device name, which Git for Windows refuses to add or check out.
- three-mesh-bvh: `0.9.17` from `web/node_modules` (the path tracer's peer; also mapped for runtime layers in snapshots).
- PowerShot: `0.11.0`; runtime modules and the flare atlas match `PowerShot-threejs/src`, including the Aura infrared profile, `setNirBands`, and the NIR band model moved there from Speedball: `nir_band.js` (band integrals and the per-texel band LUT nodes, `createRasterNodes`), `nir_spectral.js` (Jakob-Hanika upsampler, photocathode band, `classifyNir`) and the lazily loaded `srgb_lut.js` (~0.9 MB, fetched only by `createNirBand()`), re-exported from `infrared.js`. `js/nir_band_view.js` renders the three bands while the imager senses NIR.
- Speedball GI: `0.11.0` in `vendor/speedball-gi`, the package's published files from the Speedball repo; the `speedball` light probe mode only.
- Sigils is a standalone package/demo, not a max.js runtime dependency.

Global illumination is stock three.js: `LightProbeGrid` / `LightProbeGridWebGL`
irradiance probes (`js/light_probes.js`) and `LightMapper` GI lightmaps
(`js/lightmap_baker.js`). Host integration stays in max.js: `editor/light_probe_glue.js`
fits grid volumes to Max Light Probe Grid helpers and schedules rebakes from native
scene events; `max_lights_node.js` owns lighting and light links; `ir_emitters.js`
gates IR illuminators for PowerShot's NIR modes. The Light Probes panel's Speedball
mode (`js/speedball_probes.js`, node renderers) swaps the grids for Speedball's live
traced probes in the same helper volumes; its probe node joins `MaxLightsNode`
through `setProbeGiNode`, and Speedball loads only when the mode is chosen.
Snapshots exported with the older `speedballGi` block replay it in this mode.

The path tracer is imported lazily on the first switch into the path tracing view
(`editor/path_tracer.js`), so neither it nor `three-mesh-bvh/webgpu` loads unless used.
Snapshots never include it. The snapshot exporter copies `vendor/three-r187` (build,
examples, LICENSE, README, package.json), `vendor/powershot-threejs`,
`vendor/speedball-gi` and `node_modules/three-mesh-bvh`.

Validation: the browser regressions and node smokes listed in `THREE_MIGRATION.md`.
