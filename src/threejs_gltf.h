#pragma once

#include <max.h>
#include <iparamb2.h>

#define THREEJS_GLTF_CLASS_ID Class_ID(0x7F3A9B90, 0x4E2D8C90)

enum { threejs_gltf_params };

enum ThreeJSGLTFParamIDs {
    pg_display_size,
    pg_gltf_file,
    pg_root_scale,
    pg_autoplay,
    pg_display_name,
};

bool IsThreeJSGLTFClassID(const Class_ID& cid);
ClassDesc2* GetThreeJSGLTFDesc();
