#pragma once

#include <max.h>
#include <iparamb2.h>

// Legacy single-rollout class kept hidden so existing scenes still load.
#define THREEJS_LIGHT_LEGACY_CLASS_ID       Class_ID(0x7F3A9B30, 0x4E2D8C30)
#define THREEJS_DIRECTIONAL_LIGHT_CLASS_ID  Class_ID(0x7F3A9B31, 0x4E2D8C30)
#define THREEJS_POINT_LIGHT_CLASS_ID        Class_ID(0x7F3A9B32, 0x4E2D8C30)
#define THREEJS_SPOT_LIGHT_CLASS_ID         Class_ID(0x7F3A9B33, 0x4E2D8C30)
#define THREEJS_RECT_AREA_LIGHT_CLASS_ID    Class_ID(0x7F3A9B34, 0x4E2D8C30)
#define THREEJS_HEMISPHERE_LIGHT_CLASS_ID   Class_ID(0x7F3A9B35, 0x4E2D8C30)
#define THREEJS_AMBIENT_LIGHT_CLASS_ID      Class_ID(0x7F3A9B36, 0x4E2D8C30)

enum { threejs_light_params };

enum ThreeJSLightType {
    kLight_Directional = 0,
    kLight_Point = 1,
    kLight_Spot = 2,
    kLight_RectArea = 3,
    kLight_Hemisphere = 4,
    kLight_Ambient = 5,
    kLight_COUNT
};

enum ThreeJSLightParamIDs {
    // Legacy only. Public classes derive the type from the ClassID.
    pl_type,

    // Shared
    pl_color,
    pl_intensity,

    // Point / Spot
    pl_distance,
    pl_decay,

    // Spot
    pl_angle,
    pl_penumbra,

    // Rect Area
    pl_width,
    pl_height,

    // Hemisphere
    pl_ground_color,

    // Shadow-capable lights
    pl_cast_shadow,
    pl_shadow_bias,
    pl_shadow_radius,
    pl_shadow_mapsize,
};

bool IsThreeJSLightClassID(const Class_ID& cid);
ThreeJSLightType GetThreeJSLightTypeFromClassID(const Class_ID& cid);
bool ThreeJSLightClassUsesTypeParam(const Class_ID& cid);

ClassDesc2* GetThreeJSLightLegacyDesc();
ClassDesc2* GetThreeJSDirectionalLightDesc();
ClassDesc2* GetThreeJSPointLightDesc();
ClassDesc2* GetThreeJSSpotLightDesc();
ClassDesc2* GetThreeJSRectAreaLightDesc();
ClassDesc2* GetThreeJSHemisphereLightDesc();
ClassDesc2* GetThreeJSAmbientLightDesc();
