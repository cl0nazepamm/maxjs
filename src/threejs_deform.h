#pragma once

#include <max.h>
#include <iparamb2.h>

#define THREEJS_DEFORM_CLASS_ID Class_ID(0x7F3A9B80, 0x4E2D8C80)

enum { threejs_deform_params };

bool IsThreeJSDeformClassID(const Class_ID& cid);
ClassDesc2* GetThreeJSDeformDesc();
