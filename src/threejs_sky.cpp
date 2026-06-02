#include "threejs_sky.h"
#include "threejs_sky_res.h"
#include "threejs_category.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <plugapi.h>
#include <maxapi.h>
#include <stdmat.h>

extern HINSTANCE hInstance;

// ═══════════════════════════════════════════════════════════════
//  ThreeJS Sky — Texmap plugin for the Environment Map slot
// ═══════════════════════════════════════════════════════════════

bool IsThreeJSSkyClassID(const Class_ID& cid) {
    return cid == THREEJS_SKY_CLASS_ID;
}

namespace {

class ThreeJSSky;

// ── Class Descriptor ──────────────────────────────────────────

class ThreeJSSkyClassDesc : public ClassDesc2 {
public:
    int         IsPublic() override { return TRUE; }
    void*       Create(BOOL) override;
    const TCHAR* ClassName() override { return _T("three.js Sky"); }
    const TCHAR* NonLocalizedClassName() override { return _T("three.js Sky"); }
    SClass_ID   SuperClassID() override { return TEXMAP_CLASS_ID; }
    Class_ID    ClassID() override { return THREEJS_SKY_CLASS_ID; }
    const TCHAR* Category() override { return THREEJS_MAP_CATEGORY; }
    const TCHAR* InternalName() override { return _T("ThreeJSSky"); }
    HINSTANCE   HInstance() override { return hInstance; }
};

static ThreeJSSkyClassDesc skyDesc;

// ── Param Block Descriptor ────────────────────────────────────

static ParamBlockDesc2 skyPBDesc(
    threejs_sky_params, _T("ThreeJS Sky Params"), IDS_THREEJS_SKY_PARAMS,
    &skyDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,  // ref index
    IDD_THREEJS_SKY, IDS_THREEJS_SKY_PARAMS, 0, 0, nullptr,

    // Sun
    psky_elevation, _T("elevation"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 2.0f,
        p_range, -5.0f, 90.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_SKY_ELEVATION_EDIT, IDC_SKY_ELEVATION_SPIN, 0.5f,
        p_end,

    psky_azimuth, _T("azimuth"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 180.0f,
        p_range, -180.0f, 180.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_SKY_AZIMUTH_EDIT, IDC_SKY_AZIMUTH_SPIN, 1.0f,
        p_end,

    // Atmosphere
    psky_turbidity, _T("turbidity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 10.0f,
        p_range, 0.0f, 20.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_SKY_TURBIDITY_EDIT, IDC_SKY_TURBIDITY_SPIN, 0.1f,
        p_end,

    psky_rayleigh, _T("rayleigh"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 3.0f,
        p_range, 0.0f, 4.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_SKY_RAYLEIGH_EDIT, IDC_SKY_RAYLEIGH_SPIN, 0.05f,
        p_end,

    psky_mie_coeff, _T("mieCoefficient"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.005f,
        p_range, 0.0f, 0.1f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_SKY_MIE_COEFF_EDIT, IDC_SKY_MIE_COEFF_SPIN, 0.001f,
        p_end,

    psky_mie_dir_g, _T("mieDirectionalG"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.7f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_SKY_MIE_DIR_G_EDIT, IDC_SKY_MIE_DIR_G_SPIN, 0.01f,
        p_end,

    // Exposure
    psky_exposure, _T("exposure"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.5f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_SKY_EXPOSURE_EDIT, IDC_SKY_EXPOSURE_SPIN, 0.05f,
        p_end,

    // Geospatial sky switch. Keep these appended so old .max files retain
    // their saved parameter IDs.
    psky_model, _T("skyModel"), TYPE_INT, 0, 0,
        p_default, threejs_sky_model_classic,
        p_ui, TYPE_INT_COMBOBOX, IDC_SKY_MODEL, 2,
            IDS_SKY_MODEL_CLASSIC,
            IDS_SKY_MODEL_PLANETARY,
        p_vals, threejs_sky_model_classic, threejs_sky_model_planetary,
        p_end,

    psky_show_sun_disc, _T("showSunDisc"), TYPE_BOOL, 0, 0,
        p_default, TRUE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_SKY_SHOW_SUN_DISC,
        p_end,

    // Deprecated saved-slot params. Keep them appended so old .max files retain
    // stable parameter IDs, but do not expose or export them.
    psky_reserved_legacy_0, _T("reservedSkyParam0"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1.0f,
        p_end,

    psky_reserved_legacy_1, _T("reservedSkyParam1"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1.0f,
        p_end,

    psky_reserved_legacy_2, _T("reservedSkyParam2"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 0.01f,
        p_end,

    psky_reserved_legacy_3, _T("reservedSkyParam3"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, -0.01f, 0.01f,
        p_end,

    psky_reserved_legacy_4, _T("reservedSkyParam4"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1.0f,
        p_end,

    psky_planet_altitude, _T("planetAltitude"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1200.0f,
        p_range, 0.0f, 200000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_SKY_PLANET_ALTITUDE_EDIT, IDC_SKY_PLANET_ALTITUDE_SPIN, 100.0f,
        p_end,

    p_end  // end of param block
);

// ── ThreeJS Sky Texmap class ──────────────────────────────────

class ThreeJSSky : public Texmap {
public:
    IParamBlock2* pblock = nullptr;

    ThreeJSSky() {
        skyDesc.MakeAutoParamBlocks(this);
    }

    // ── Animatable ───────────────────────────────────
    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_SKY_CLASS_ID; }
    SClass_ID SuperClassID() override { return TEXMAP_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("three.js Sky"); }

    int NumSubs() override { return 1; }
    Animatable* SubAnim(int i) override { return i == 0 ? pblock : nullptr; }
    MSTR SubAnimName(int i, bool) override { return i == 0 ? _T("Parameters") : _T(""); }

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle rtarg) override {
        if (i == 0) pblock = static_cast<IParamBlock2*>(rtarg);
    }

    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override {
        return id == threejs_sky_params ? pblock : nullptr;
    }

    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID&, RefMessage, BOOL) override {
        return REF_SUCCEED;
    }

    RefTargetHandle Clone(RemapDir& remap) override {
        ThreeJSSky* sky = new ThreeJSSky();
        sky->ReplaceReference(0, remap.CloneRef(pblock));
        BaseClone(this, sky, remap);
        return sky;
    }

    // ── Texmap virtuals — stub for viewport-only use ─
    AColor EvalColor(ShadeContext&) override { return AColor(0.6f, 0.7f, 0.9f, 1.0f); }
    Point3 EvalNormalPerturb(ShadeContext&) override { return Point3(0, 0, 0); }

    // Required by Texmap
    void Update(TimeValue, Interval& valid) override { valid = FOREVER; }
    void Reset() override {
        skyDesc.MakeAutoParamBlocks(this);
    }

    // SubTexmap — none
    int NumSubTexmaps() override { return 0; }
    Texmap* GetSubTexmap(int) override { return nullptr; }
    void SetSubTexmap(int, Texmap*) override {}

    Interval Validity(TimeValue) override { return FOREVER; }

    // Paramblock UI
    ParamDlg* CreateParamDlg(HWND hwMtlEdit, IMtlParams* imp) override {
        return skyDesc.CreateParamDlgs(hwMtlEdit, imp, this);
    }

    IOResult Save(ISave* isave) override { return Texmap::Save(isave); }
    IOResult Load(ILoad* iload) override { return Texmap::Load(iload); }
};

void* ThreeJSSkyClassDesc::Create(BOOL) { return new ThreeJSSky(); }

} // namespace

ClassDesc2* GetThreeJSSkyDesc() { return &skyDesc; }
