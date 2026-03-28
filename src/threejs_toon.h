#pragma once
#include <max.h>
#include <iparamb2.h>
#include <imtl.h>

#define THREEJS_TOON_CLASS_ID Class_ID(0x7F3A9B40, 0x4E2D8C40)

enum { toon_params };

enum ToonParamIDs {
    tp_color, tp_color_map,
    tp_gradient_map,
    tp_normal_map, tp_normal_scale,
    tp_bump_map, tp_bump_scale,
    tp_emissive_color, tp_emissive_map, tp_emissive_intensity,
    tp_opacity, tp_opacity_map,
    tp_lightmap, tp_lightmap_intensity, tp_lightmap_channel,
    tp_ao_map, tp_ao_intensity,
    tp_displacement_map, tp_displacement_scale, tp_displacement_bias,
    tp_double_sided,
};

enum ToonMapSlots {
    kToon_Color = 0,
    kToon_Gradient,
    kToon_Normal,
    kToon_Bump,
    kToon_Emissive,
    kToon_Opacity,
    kToon_Lightmap,
    kToon_AO,
    kToon_Displacement,
    kToonNumMaps
};

ClassDesc2* GetThreeJSToonDesc();
