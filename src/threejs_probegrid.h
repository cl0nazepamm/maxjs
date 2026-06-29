#pragma once

#include <max.h>
#include <iparamb2.h>

// max.js HALO-GI Probe Grid — a HELPER object you draw in 3ds Max to define WHERE
// the realtime GI probe volume sits and how dense it is. Auto-fitting the whole
// scene makes interior GI coarse when far background assets balloon the bounds; a
// hand-placed box keeps probes dense where they matter. The box only bounds probe
// PLACEMENT — the GI ray-traced BVH is still the whole scene, so light from outside
// the box (e.g. through a window) still bounces in correctly.
#define THREEJS_PROBE_GRID_CLASS_ID  Class_ID(0x7F3A9B40, 0x4E2D8C30)

enum { threejs_probegrid_params };

enum ThreeJSProbeGridParamIDs {
    pg_length,   // box dimensions, world units (box is centred on the node pivot)
    pg_width,
    pg_height,
    pg_div_x,    // probe divisions per axis (manual density)
    pg_div_y,
    pg_div_z,
    pg_enabled,  // contribute this volume to HALO-GI
};

bool IsThreeJSProbeGridClassID(const Class_ID& cid);

// Read probe-grid params off a live object (for scene serialization). Returns false
// if obj is not a probe grid. dims = full length/width/height; div = per-axis counts.
bool GetThreeJSProbeGridInfo(Object* obj, float dims[3], int div[3], bool& enabled);

ClassDesc2* GetThreeJSProbeGridDesc();
