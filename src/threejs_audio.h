#pragma once

#include <max.h>
#include <iparamb2.h>

#define THREEJS_AUDIO_CLASS_ID Class_ID(0x7F3A9B51, 0x4E2D8C51)

enum { threejs_audio_params };

enum ThreeJSAudioParamIDs {
    pa_display_size,
    pa_audio_file,
    pa_volume,
    pa_loop,
    pa_crossfade_ms,
    pa_ref_distance,
    pa_max_distance,
    pa_rolloff_factor,
};

bool IsThreeJSAudioClassID(const Class_ID& cid);
ClassDesc2* GetThreeJSAudioDesc();
