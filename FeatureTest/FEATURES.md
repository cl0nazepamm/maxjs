# max.js FeatureTest

`FeatureTest.max` (Max 2027, cm, 30 fps, frames 0-120). Every object is named `FT_*` and has a flat label in
front of it. Character animation is intentionally absent. tyFlow is intentionally absent (removed from max.js).

## How to export
1. Open the max.js viewer on **WebGPU** (TSL, SSS, MaterialX, Speedball, light linking and the NIR band
   view only run there).
2. Set the look in the viewer before exporting; the snapshot replays the viewer state at export time:
   bloom, SSR, GTAO, volumetric (the spot has `volContrib` 2), DOF, light probes (grid, then Speedball),
   and PowerShot `infrared` once to check NIR.
3. Export at frame 0.

## Rows
**A, y=350: core materials**
- Std_AllMaps: `three_js` Standard with colour map (tiled 2x2, U offset, W 15 degrees), Normal_Bump,
  roughness and emissive maps.
- Phys_CoatSheenIridAniso, Phys_Glass (transmission, IOR, thickness, dispersion, attenuation).
- SSS_Teapot.
- Toon (gradient map).
- Utility: Matcap, Lambert, Phong_Flat, NormalViz, Depth, Wireframe.
- glTF_Ext (clearcoat, sheen, specular, transmission, volume, IOR).
- MaxPhysical (metal, coat, thin film, emission, bump, cutout).
- OpenPBR (coat, fuzz, thin film).
- LegacyStandard (expect Lambert).

**B, y=600: special materials**
- MultiSub: sparse IDs 1/2/3/7 across glTF, Physical, OpenPBR and three_js.
- Shell (expect the original sub).
- MaterialX (velvet .mtlx).
- TSL preset Neon (material). TSL_Displacement is a hand-written `positionNode` displacement in cm
  (max.js dropped its displacement presets: they don't compile on three r187). TSLTexture_Box uses the
  Wood preset.
- TSL_VertexColors: map1, `@param`s, `maxVertexColor(0)`.
- OSL_UberBitmap: tiling 3, rotate 30.
- AlphaTest_Card: double sided.
- Video_Screen: same video in colour and emissive.
- LightMap_UV2: channel-2 UVW, exported as uv1.
- Opacity40.
- Displacement: 64x64 plane.
- AO_MetalRough maps.

**C, y=-250: geometry and animation**
- ExplicitNormals (Chamfer + Edit Normals), Faceted vs Smooth.
- Teapot instances A/B, plus C animated (C must not merge into the instanced draw).
- PRS keys, Visibility track, Parent > Child > GrandChild.
- Animated Bend (per-frame geometry cache), Morpher (channel 1 keyed 0-100-0).
- MaterialValues: three_js colour, roughness and emissive intensity keyed.
  - The material reports 0 sub-anims, but its values do change over time. Check that the export picks this up.
- PathConstraint (sampled controller).
- Spline_Helix (line segments), Spline_RenderMesh (thick renderable circle).

**D, y=-500: structure, flags, deform, NIR**
- Group.
- Flag_NoCastShadow, Flag_NoReceiveShadow (with a caster on it).
- UserProps: `speed=2`, `interactive=true`, `label=feature test`; read by the layer.
- Jsmod_Flag: three.js Deform + Vol. Select soft selection. Weight is 1 at the free edge and 0 at the pole.
- Jsmod_Sim: `ctx.deform.simulate`, WebGPU only.
- Kit_Block: source for the `instanceFromMax` scatter in the front-right strip.
- NIR metamers: same visible colour, different NIR.
  - Leaf_Foliage 0.55, Water_Pool 0.04, Asphalt_Road 0.06 (all by name).
  - TaggedByLayer 0.9 (`ctx.spectral`).
  - All four should look identical in RGB.

**Around the stage**
- Lights:
  - FT_Sun (directional, shadows; the sky links to it by name).
  - Spot (shadows, volumetric, cookie from the layer).
  - Point_Warm (shadows).
  - Point_IR_Illuminator (`emitterClass=ir`): black until PowerShot infrared/nightshot.
  - RectArea, Hemisphere, Ambient.
  - Point_Animated: position keys. Its intensity keys are expected NOT to export.
- Cameras:
  - FT_Cam_Main: boot camera, DOF on, manual clip 10-10000, animated FOV and dolly.
  - FT_Cam_Detail: press C in the viewer to switch.
- Environment: `three_js_Sky` with clouds and sun shadows.
  - HDRI variant: material editor slot 24 (OSL HDRI Environment, blouberg 1k). Drag it into Environment to test.
- Origins: Audio_Ambient (mp3, loop, distance rolloff), glTF_Spinner (generated uncompressed animated .glb,
  rootScale 100), LightProbeGrid, hidden `ShadowMapOrigin_r1400`.
- Scatter: ForestPack_Scatter (cone + pyramid, seed 4242), RailClone_Fence (Linear1S on FT_RC_Path).
  - RailClone reports its bays as non-instanced: the curved path bends them.

## Scripts (`scripts/`)
- `10_ft_core.js`:
  - every `ctx.params` type;
  - userProps;
  - `deform.attach` (timeline time, soft-selection weight);
  - `ctx.spectral`;
  - spot cookie through `overrides`;
  - runtime node-material orb with shadows;
  - seeded `instanceFromMax` scatter, raycast;
  - `ctx.anim` list, `max:selection`;
  - C cycles cameras, click plays a positional one-shot.
- `20_ft_sim.js`: `ctx.deform.simulate` spring sim with recomputed normals.

## Expected to be dropped (negative tests)
- `FT_NEG_ProceduralNoise`: procedural maps aren't baked, so it falls back to its base colour.
- `FT_NEG_HiddenMesh`: skipped.
- `FT_NEG_NonRenderable`: exported, invisible.
- Point_Animated intensity keys.

## Not covered
- Lightmap bake (`settings.maxjs.json` bake block).
- State Sets camera cuts.
- Light linking (a viewer Studio setting, not Max data).
