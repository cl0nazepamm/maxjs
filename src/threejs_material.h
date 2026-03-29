#pragma once
#include <max.h>
#include <iparamb2.h>
#include <imtl.h>

#define THREEJS_MTL_CLASS_ID Class_ID(0x7F3A9B10, 0x4E2D8C10)
#define THREEJS_ADV_MTL_CLASS_ID Class_ID(0x7F3A9B11, 0x4E2D8C10)
#define THREEJS_SSS_MTL_CLASS_ID Class_ID(0x7F3A9B12, 0x4E2D8C10)
#define THREEJS_UTILITY_MTL_CLASS_ID Class_ID(0x7F3A9B13, 0x4E2D8C10)

enum { threejs_params };

enum ThreeJSParamIDs {
    // PBR Core
    pb_color, pb_color_map, pb_color_map_strength,
    pb_roughness, pb_roughness_map, pb_roughness_map_strength,
    pb_metalness, pb_metalness_map, pb_metalness_map_strength,
    pb_normal_map, pb_normal_scale,
    pb_bump_map, pb_bump_scale,
    pb_displacement_map, pb_displacement_scale, pb_displacement_bias,
    pb_parallax_map, pb_parallax_scale,
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
    // SSS
    pb_sss_color, pb_sss_color_map,
    pb_sss_distortion, pb_sss_ambient, pb_sss_attenuation,
    pb_sss_power, pb_sss_scale,
    // Utility stack
    pb_utility_model,
    pb_backdrop_mode,
    pb_matcap_map,
    pb_specular_color,
    pb_shininess,
    pb_flat_shading,
    pb_wireframe,
    // Physical extras
    pb_phys_specular_color,
    pb_phys_specular_intensity,
    pb_phys_clearcoat,
    pb_phys_clearcoat_roughness,
    pb_phys_sheen,
    pb_phys_sheen_roughness,
    pb_phys_sheen_color,
    pb_phys_iridescence,
    pb_phys_iridescence_ior,
    pb_phys_transmission,
    pb_phys_ior,
    pb_phys_thickness,
    pb_phys_dispersion,
    pb_phys_attenuation_color,
    pb_phys_attenuation_distance,
    pb_phys_anisotropy,
};

enum ThreeJSUtilityModel {
    threejs_utility_distance = 0,
    threejs_utility_depth,
    threejs_utility_lambert,
    threejs_utility_matcap,
    threejs_utility_normal,
    threejs_utility_phong,
    threejs_utility_backdrop,
};

enum ThreeJSBackdropMode {
    threejs_backdrop_blurred = 0,
    threejs_backdrop_depth,
    threejs_backdrop_texture,
    threejs_backdrop_pixel,
};

// Texmap slot indices (for SubTexmap)
enum ThreeJSMapSlots {
    kMap_Color = 0,
    kMap_Roughness,
    kMap_Metalness,
    kMap_Normal,
    kMap_Bump,
    kMap_Displacement,
    kMap_Parallax,
    kMap_Emissive,
    kMap_Opacity,
    kMap_Lightmap,
    kMap_AO,
    kMap_SSSColor,
    kMap_Matcap,
    kNumMaps
};

ClassDesc2* GetThreeJSMtlDesc();
ClassDesc2* GetThreeJSAdvMtlDesc();
ClassDesc2* GetThreeJSSSSMtlDesc();
ClassDesc2* GetThreeJSUtilityMtlDesc();
