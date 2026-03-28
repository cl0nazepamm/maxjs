#pragma once
#include <max.h>
#include <iparamb2.h>

// All ThreeJS light types share one ClassID — type is a param
#define THREEJS_LIGHT_CLASS_ID Class_ID(0x7F3A9B30, 0x4E2D8C30)

enum { threejs_light_params };

enum ThreeJSLightType {
    kLight_Directional = 0,
    kLight_Point,
    kLight_Spot,
    kLight_RectArea,
    kLight_Hemisphere,
    kLight_COUNT
};

enum ThreeJSLightParamIDs {
    pl_type,
    pl_color,
    pl_intensity,
    // Point / Spot
    pl_distance,
    pl_decay,
    // Spot
    pl_angle,
    pl_penumbra,
    // RectArea
    pl_width,
    pl_height,
    // Hemisphere
    pl_ground_color,
    // Shadows
    pl_cast_shadow,
    pl_shadow_bias,
    pl_shadow_radius,
    pl_shadow_mapsize,
    // Volumetric
    pl_volumetric,
    pl_vol_density,
};

ClassDesc2* GetThreeJSLightDesc();
