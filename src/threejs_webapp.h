#pragma once

#include <max.h>
#include <iparamb2.h>

#define THREEJS_WEBAPP_CLASS_ID Class_ID(0x5B7E2C19, 0x6D4A8F33)

enum { threejs_webapp_params };

enum ThreeJSWebAppParamIDs {
    pw_display_size,
    pw_url,
    pw_width,
    pw_height,
    pw_opacity,
    pw_interactive,
    pw_presentation,
    pw_param1, pw_param2, pw_param3, pw_param4,
    pw_param5, pw_param6, pw_param7, pw_param8,
    pw_param1_name, pw_param2_name, pw_param3_name, pw_param4_name,
    pw_param5_name, pw_param6_name, pw_param7_name, pw_param8_name,
    pw_depth_occlude,
    pw_layer_count,
    pw_layer_gap,
};

constexpr int kWebAppParamChannels = 8;

bool IsThreeJSWebAppClassID(const Class_ID& cid);
ClassDesc2* GetThreeJSWebAppDesc();
