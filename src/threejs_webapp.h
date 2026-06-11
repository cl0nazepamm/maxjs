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
    pw_param9, pw_param10, pw_param11, pw_param12,
    pw_param13, pw_param14, pw_param15, pw_param16,
    pw_param9_name, pw_param10_name, pw_param11_name, pw_param12_name,
    pw_param13_name, pw_param14_name, pw_param15_name, pw_param16_name,
    pw_param17, pw_param18, pw_param19, pw_param20,
    pw_param21, pw_param22, pw_param23, pw_param24,
    pw_param25, pw_param26, pw_param27, pw_param28,
    pw_param29, pw_param30, pw_param31, pw_param32,
    pw_param17_name, pw_param18_name, pw_param19_name, pw_param20_name,
    pw_param21_name, pw_param22_name, pw_param23_name, pw_param24_name,
    pw_param25_name, pw_param26_name, pw_param27_name, pw_param28_name,
    pw_param29_name, pw_param30_name, pw_param31_name, pw_param32_name,
};

constexpr int kWebAppParamChannels = 32;

bool IsThreeJSWebAppClassID(const Class_ID& cid);
ClassDesc2* GetThreeJSWebAppDesc();
