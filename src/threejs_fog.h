#pragma once

#include <max.h>
#include <iparamb2.h>
#include <sfx.h>

#define THREEJS_FOG_CLASS_ID Class_ID(0x7F3A9B60, 0x4E2D8C60)

enum { threejs_fog_params };

enum ThreeJSFogType {
    kFog_Range    = 0,   // Linear (near/far)
    kFog_Density  = 1,   // Exponential (density)
    kFog_Custom   = 2,   // Procedural noise
    kFog_COUNT
};

enum ThreeJSFogParamIDs {
    pf_type,
    pf_color,
    pf_near,
    pf_far,
    pf_density,
    pf_noise_scale,
    pf_noise_speed,
    pf_height,
    pf_opacity,
};

bool IsThreeJSFogClassID(const Class_ID& cid);
ClassDesc2* GetThreeJSFogDesc();
