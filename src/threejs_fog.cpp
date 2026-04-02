#include "threejs_fog.h"
#include "threejs_fog_res.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <plugapi.h>
#include <maxapi.h>

extern HINSTANCE hInstance;

// ═══════════════════════════════════════════════════════════════
//  ThreeJS Fog — Atmospheric plugin for Rendering > Environment
// ═══════════════════════════════════════════════════════════════

bool IsThreeJSFogClassID(const Class_ID& cid) {
    return cid == THREEJS_FOG_CLASS_ID;
}

namespace {

class ThreeJSFog;

// ── Class Descriptor ──────────────────────────────────────────

class ThreeJSFogClassDesc : public ClassDesc2 {
public:
    int         IsPublic() override { return TRUE; }
    void*       Create(BOOL) override;
    const TCHAR* ClassName() override { return _T("three.js Fog"); }
    const TCHAR* NonLocalizedClassName() override { return _T("three.js Fog"); }
    SClass_ID   SuperClassID() override { return ATMOSPHERIC_CLASS_ID; }
    Class_ID    ClassID() override { return THREEJS_FOG_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSFog"); }
    HINSTANCE   HInstance() override { return hInstance; }
};

static ThreeJSFogClassDesc fogDesc;

// ── Dialog Proc — show/hide controls based on fog type ────────

class FogDlgProc : public ParamMap2UserDlgProc {
public:
    INT_PTR DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) override {
        switch (msg) {
            case WM_INITDIALOG:
                UpdateVisibility(hWnd, map);
                return TRUE;
            case WM_COMMAND:
                if (LOWORD(wParam) == IDC_FOG_TYPE && HIWORD(wParam) == CBN_SELCHANGE) {
                    UpdateVisibility(hWnd, map);
                    return TRUE;
                }
                break;
        }
        return FALSE;
    }
    void DeleteThis() override {}

private:
    void UpdateVisibility(HWND hWnd, IParamMap2* map) {
        if (!map || !map->GetParamBlock()) return;
        int type = map->GetParamBlock()->GetInt(pf_type);

        auto showCtrl = [hWnd](int id, bool show) {
            HWND h = GetDlgItem(hWnd, id);
            if (h) ShowWindow(h, show ? SW_SHOW : SW_HIDE);
        };

        bool isRange   = (type == kFog_Range);
        bool isDensity = (type == kFog_Density);
        bool isCustom  = (type == kFog_Custom);

        // Range controls
        showCtrl(IDC_LABEL_NEAR, isRange);
        showCtrl(IDC_FOG_NEAR_EDIT, isRange);
        showCtrl(IDC_FOG_NEAR_SPIN, isRange);
        showCtrl(IDC_LABEL_FAR, isRange);
        showCtrl(IDC_FOG_FAR_EDIT, isRange);
        showCtrl(IDC_FOG_FAR_SPIN, isRange);

        // Density controls
        showCtrl(IDC_LABEL_DENSITY, isDensity);
        showCtrl(IDC_FOG_DENSITY_EDIT, isDensity);
        showCtrl(IDC_FOG_DENSITY_SPIN, isDensity);

        // Custom/procedural controls
        showCtrl(IDC_LABEL_NOISE_SCALE, isCustom);
        showCtrl(IDC_FOG_NOISE_SCALE_EDIT, isCustom);
        showCtrl(IDC_FOG_NOISE_SCALE_SPIN, isCustom);
        showCtrl(IDC_LABEL_NOISE_SPEED, isCustom);
        showCtrl(IDC_FOG_NOISE_SPEED_EDIT, isCustom);
        showCtrl(IDC_FOG_NOISE_SPEED_SPIN, isCustom);
        showCtrl(IDC_LABEL_HEIGHT, isCustom);
        showCtrl(IDC_FOG_HEIGHT_EDIT, isCustom);
        showCtrl(IDC_FOG_HEIGHT_SPIN, isCustom);
    }
};

static FogDlgProc fogDlgProc;

// ── Param Block Descriptor ────────────────────────────────────

static ParamBlockDesc2 fogPBDesc(
    threejs_fog_params, _T("ThreeJS Fog Params"), IDS_THREEJS_FOG_PARAMS,
    &fogDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,  // ref index
    IDD_THREEJS_FOG, IDS_THREEJS_FOG_PARAMS, 0, 0, &fogDlgProc,

    // Type (dropdown)
    pf_type, _T("fogType"), TYPE_INT, 0, 0,
        p_default, kFog_Range,
        p_ui, TYPE_INT_COMBOBOX, IDC_FOG_TYPE, 3,
            IDS_FOG_TYPE_RANGE,
            IDS_FOG_TYPE_DENSITY,
            IDS_FOG_TYPE_CUSTOM,
        p_end,

    // Color
    pf_color, _T("fogColor"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(0.85f, 0.85f, 0.9f),
        p_ui, TYPE_COLORSWATCH, IDC_FOG_COLOR,
        p_end,

    // Opacity
    pf_opacity, _T("fogOpacity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_FOG_OPACITY_EDIT, IDC_FOG_OPACITY_SPIN, 0.01f,
        p_end,

    // Near (Range mode)
    pf_near, _T("fogNear"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 10.0f,
        p_range, 0.0f, 99999.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_FOG_NEAR_EDIT, IDC_FOG_NEAR_SPIN, 1.0f,
        p_end,

    // Far (Range mode)
    pf_far, _T("fogFar"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 500.0f,
        p_range, 0.1f, 99999.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_FOG_FAR_EDIT, IDC_FOG_FAR_SPIN, 5.0f,
        p_end,

    // Density (Density mode)
    pf_density, _T("fogDensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.01f,
        p_range, 0.0001f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_FOG_DENSITY_EDIT, IDC_FOG_DENSITY_SPIN, 0.001f,
        p_end,

    // Noise Scale (Custom mode)
    pf_noise_scale, _T("fogNoiseScale"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.005f,
        p_range, 0.0001f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_FOG_NOISE_SCALE_EDIT, IDC_FOG_NOISE_SCALE_SPIN, 0.001f,
        p_end,

    // Noise Speed (Custom mode)
    pf_noise_speed, _T("fogNoiseSpeed"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.2f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_FOG_NOISE_SPEED_EDIT, IDC_FOG_NOISE_SPEED_SPIN, 0.05f,
        p_end,

    // Height (Custom mode — ground fog boundary)
    pf_height, _T("fogHeight"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 20.0f,
        p_range, 0.0f, 99999.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT,
            IDC_FOG_HEIGHT_EDIT, IDC_FOG_HEIGHT_SPIN, 1.0f,
        p_end,

    p_end  // end of param block
);

// ── ThreeJS Fog Atmospheric class ─────────────────────────────

class ThreeJSFog : public Atmospheric {
public:
    IParamBlock2* pblock = nullptr;

    ThreeJSFog() {
        fogDesc.MakeAutoParamBlocks(this);
    }

    // ── Animatable ───────────────────────────────────
    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_FOG_CLASS_ID; }
    SClass_ID SuperClassID() override { return ATMOSPHERIC_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("three.js Fog"); }

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
        return id == threejs_fog_params ? pblock : nullptr;
    }

    RefTargetHandle Clone(RemapDir& remap) override {
        ThreeJSFog* fog = new ThreeJSFog();
        fog->ReplaceReference(0, remap.CloneRef(pblock));
        BaseClone(this, fog, remap);
        return fog;
    }

    // ── SpecialFX / Atmospheric ──────────────────────
    MSTR GetName(bool) const override { return _T("three.js Fog"); }
    BOOL Active(TimeValue t) override { return !TestAFlag(A_ATMOS_DISABLED); }

    void Update(TimeValue t, Interval& valid) override {
        // Nothing to cache — params are read live by the MaxJS panel
    }

    // Shade is called during scanline rendering — we don't modify Max rendering
    void Shade(ShadeContext& sc, const Point3& p0, const Point3& p1,
               Color& color, Color& trans, BOOL isBG) override {
        // No-op: fog is only applied in the Three.js viewport
    }

    IOResult Save(ISave* isave) override { return Atmospheric::Save(isave); }
    IOResult Load(ILoad* iload) override { return Atmospheric::Load(iload); }
};

void* ThreeJSFogClassDesc::Create(BOOL) { return new ThreeJSFog(); }

} // namespace

ClassDesc2* GetThreeJSFogDesc() { return &fogDesc; }
