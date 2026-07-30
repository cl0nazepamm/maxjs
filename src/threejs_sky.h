#pragma once

#include <max.h>
#include <iparamb2.h>
#include <imtl.h>

#define THREEJS_SKY_CLASS_ID Class_ID(0x7F3A9B70, 0x4E2D8C70)

enum { threejs_sky_params };

enum ThreeJSSkyParamIDs {
    psky_turbidity,
    psky_rayleigh,
    psky_mie_coeff,
    psky_mie_dir_g,
    psky_elevation,
    psky_azimuth,
    psky_exposure,
    // Retired geospatial-sky slot (was skyModel). Kept in place so old .max
    // files retain stable parameter IDs; no UI, not exported.
    psky_reserved_legacy_model,
    psky_show_sun_disc,
    psky_reserved_legacy_0,
    psky_reserved_legacy_1,
    psky_reserved_legacy_2,
    psky_reserved_legacy_3,
    psky_reserved_legacy_4,
    // Retired geospatial-sky slot (was planetAltitude).
    psky_reserved_legacy_altitude,
};

bool IsThreeJSSkyClassID(const Class_ID& cid);
ClassDesc2* GetThreeJSSkyDesc();
