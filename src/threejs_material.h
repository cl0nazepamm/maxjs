#pragma once
#include <max.h>
#include <iparamb2.h>
#include <imtl.h>

#define THREEJS_MTL_CLASS_ID Class_ID(0x7F3A9B10, 0x4E2D8C10)

enum { threejs_params };

enum ThreeJSParamIDs {
    // PBR Core
    pb_color, pb_color_map, pb_color_map_strength,
    pb_roughness, pb_roughness_map, pb_roughness_map_strength,
    pb_metalness, pb_metalness_map, pb_metalness_map_strength,
    pb_normal_map, pb_normal_scale,
    pb_bump_map, pb_bump_scale,
    pb_displacement_map, pb_displacement_scale, pb_displacement_bias,
    // Emission
    pb_emissive_color, pb_emissive_map, pb_emissive_intensity, pb_emissive_map_strength,
    // Transparency
    pb_opacity, pb_opacity_map, pb_opacity_map_strength,
    // Lightmap
    pb_lightmap, pb_lightmap_intensity, pb_lightmap_channel,
    // AO
    pb_ao_map, pb_ao_intensity,
    // Display
    pb_double_sided,
    // Environment
    pb_env_intensity,
};

// Texmap slot indices (for SubTexmap)
enum ThreeJSMapSlots {
    kMap_Color = 0,
    kMap_Roughness,
    kMap_Metalness,
    kMap_Normal,
    kMap_Bump,
    kMap_Displacement,
    kMap_Emissive,
    kMap_Opacity,
    kMap_Lightmap,
    kMap_AO,
    kNumMaps
};

ClassDesc2* GetThreeJSMtlDesc();
