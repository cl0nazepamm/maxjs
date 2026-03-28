#pragma once

#include <max.h>
#include <iparamb2.h>

#define THREEJS_SPLAT_CLASS_ID Class_ID(0x7F3A9B50, 0x4E2D8C50)

enum { threejs_splat_params };

enum ThreeJSSplatParamIDs {
    ps_display_size,
    ps_splat_file,
};

bool IsThreeJSSplatClassID(const Class_ID& cid);
ClassDesc2* GetThreeJSSplatDesc();
