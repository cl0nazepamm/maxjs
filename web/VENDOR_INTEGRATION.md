# Runtime packages

- Speedball GI: `0.8.0`; Three r185/r186, with `three-mesh-bvh` pinned to `0.9.14`.
- PowerShot: `0.9.0`; runtime modules and the flare atlas match `PowerShot-threejs/src`.
- Sigils is a standalone package/demo, not a max.js runtime dependency.

Speedball's published runtime modules match the sibling source. The unshipped
`gi_settings.js` demo helper retains max.js's continuous-solve control.
`docs/CHANGELOG.md` is the current upstream changelog; the root changelog is historical.

Keep host integration in max.js: `editor/gi_volume_glue.js` constructs probe fields
with automatic scene scanning disabled; `max_lights_node.js` owns lighting, light
links and NIR sensing. Native scene events drive targeted invalidations. Snapshot
boot installs the same lighting before restoring GI. Do not replace these paths
with the standalone installer.

Validation: GI budget/centroid tests, GI settings and hysteresis checks, timeline
and snapshot source checks, snapshot runtime parity, PowerShot persistence, and
`tools/gi-backends.html` against the actual vendored Three runtime.
