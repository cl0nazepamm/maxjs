#include "threejs_toon.h"
#include "threejs_toon_res.h"
#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <imtl.h>
#include <plugapi.h>
#include <maxapi.h>

extern HINSTANCE hInstance;

// ══════════════════════════════════════════════════════════════
//  ThreeJS Toon Material — maps to MeshToonMaterial
//  Key feature: gradientMap for cel-shading steps
// ══════════════════════════════════════════════════════════════

static const ParamID kToonMapIDs[kToonNumMaps] = {
    tp_color_map, tp_gradient_map, tp_normal_map, tp_bump_map,
    tp_emissive_map, tp_opacity_map, tp_lightmap, tp_ao_map, tp_displacement_map
};

static const MCHAR* kToonMapNames[kToonNumMaps] = {
    _T("Color Map"), _T("Gradient Map"), _T("Normal Map"), _T("Bump Map"),
    _T("Emissive Map"), _T("Opacity Map"), _T("Light Map"), _T("AO Map"),
    _T("Displacement Map")
};

class ThreeJSToon : public Mtl {
public:
    IParamBlock2* pblock = nullptr;

    ThreeJSToon(BOOL loading) {
        GetThreeJSToonDesc()->MakeAutoParamBlocks(this);
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_TOON_CLASS_ID; }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("ThreeJS Toon"); }

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle r) override {
        if (i == 0) pblock = static_cast<IParamBlock2*>(r);
    }
    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID&, RefMessage, BOOL) override {
        return REF_SUCCEED;
    }
    RefTargetHandle Clone(RemapDir& remap) override {
        ThreeJSToon* m = new ThreeJSToon(FALSE);
        *static_cast<MtlBase*>(m) = *static_cast<MtlBase*>(this);
        BaseClone(this, m, remap);
        m->ReplaceReference(0, remap.CloneRef(pblock));
        return m;
    }

    // Viewport colors
    Color GetAmbient(int, BOOL) override {
        return pblock ? pblock->GetColor(tp_color, 0) * 0.3f : Color(0.2f, 0.2f, 0.2f);
    }
    Color GetDiffuse(int, BOOL) override {
        return pblock ? pblock->GetColor(tp_color, 0) : Color(0.8f, 0.8f, 0.8f);
    }
    Color GetSpecular(int, BOOL) override { return Color(0.5f, 0.5f, 0.5f); }
    float GetShininess(int, BOOL) override { return 0.2f; }
    float GetShinStr(int, BOOL) override { return 0.5f; }
    float GetXParency(int, BOOL) override {
        return pblock ? (1.0f - pblock->GetFloat(tp_opacity, 0)) : 0.0f;
    }
    void SetAmbient(Color, TimeValue) override {}
    void SetDiffuse(Color c, TimeValue t) override {
        if (pblock) pblock->SetValue(tp_color, t, c);
    }
    void SetSpecular(Color, TimeValue) override {}
    void SetShininess(float, TimeValue) override {}

    ParamDlg* CreateParamDlg(HWND hwMtlEdit, IMtlParams* imp) override {
        return GetThreeJSToonDesc()->CreateParamDlgs(hwMtlEdit, imp, this);
    }

    void Update(TimeValue, Interval& valid) override { valid = FOREVER; }
    Interval Validity(TimeValue) override { return FOREVER; }
    void Reset() override { GetThreeJSToonDesc()->MakeAutoParamBlocks(this); }

    // SubTexmap
    int NumSubTexmaps() override { return kToonNumMaps; }
    Texmap* GetSubTexmap(int i) override {
        if (!pblock || i < 0 || i >= kToonNumMaps) return nullptr;
        return pblock->GetTexmap(kToonMapIDs[i]);
    }
    void SetSubTexmap(int i, Texmap* m) override {
        if (!pblock || i < 0 || i >= kToonNumMaps) return;
        pblock->SetValue(kToonMapIDs[i], 0, m);
    }
    MSTR GetSubTexmapSlotName(int i, bool) override {
        if (i >= 0 && i < kToonNumMaps) return MSTR(kToonMapNames[i]);
        return MSTR(_T(""));
    }
    int MapSlotType(int) override { return MAPSLOT_TEXTURE; }

    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override {
        return (id == toon_params) ? pblock : nullptr;
    }

    void Shade(ShadeContext& sc) override {
        if (gbufID) sc.SetGBufferID(gbufID);
        Color c = pblock ? pblock->GetColor(tp_color, sc.CurTime()) : Color(0.8f, 0.8f, 0.8f);
        sc.out.c = c;
        sc.out.t = Color(0, 0, 0);
    }
    float EvalDisplacement(ShadeContext&) override { return 0.0f; }
    Interval DisplacementValidity(TimeValue) override { return FOREVER; }

    IOResult Save(ISave* s) override { return Mtl::Save(s); }
    IOResult Load(ILoad* l) override { return Mtl::Load(l); }
};

// ── Class Descriptor ──────────────────────────────────────────

class ThreeJSToonClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override { return new ThreeJSToon(loading); }
    const TCHAR* ClassName() override { return _T("ThreeJS Toon"); }
    const TCHAR* NonLocalizedClassName() override { return _T("ThreeJS Toon"); }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_TOON_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSToon"); }
    HINSTANCE HInstance() override { return hInstance; }
};

static ThreeJSToonClassDesc threeJSToonDesc;
ClassDesc2* GetThreeJSToonDesc() { return &threeJSToonDesc; }

// ── ParamBlock ────────────────────────────────────────────────

static ParamBlockDesc2 toon_pb(
    toon_params,
    _T("ThreeJS Toon Parameters"),
    IDS_TOON_PARAMS,
    &threeJSToonDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_TOON, IDS_TOON_PARAMS, 0, 0, nullptr,

    tp_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(0.8f, 0.8f, 0.8f),
        p_ui, TYPE_COLORSWATCH, IDC_TOON_COLOR,
        p_end,
    tp_color_map, _T("colorMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_Color,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_COLOR_MAP,
        p_end,
    tp_gradient_map, _T("gradientMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_Gradient,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_GRAD_MAP,
        p_end,
    tp_normal_map, _T("normalMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_Normal,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_NORM_MAP,
        p_end,
    tp_normal_scale, _T("normalScale"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 5.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_TOON_NORMSCL_E, IDC_TOON_NORMSCL_S, 0.01f,
        p_end,
    tp_bump_map, _T("bumpMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_Bump,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_BUMP_MAP,
        p_end,
    tp_bump_scale, _T("bumpScale"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 5.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_TOON_BUMP_E, IDC_TOON_BUMP_S, 0.01f,
        p_end,
    tp_emissive_color, _T("emissiveColor"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(0.0f, 0.0f, 0.0f),
        p_ui, TYPE_COLORSWATCH, IDC_TOON_EM_COLOR,
        p_end,
    tp_emissive_map, _T("emissiveMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_Emissive,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_EM_MAP,
        p_end,
    tp_emissive_intensity, _T("emissiveIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 100.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_TOON_EM_INT_E, IDC_TOON_EM_INT_S, 0.1f,
        p_end,
    tp_opacity, _T("opacity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_TOON_OPAC_E, IDC_TOON_OPAC_S, 0.01f,
        p_end,
    tp_opacity_map, _T("opacityMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_Opacity,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_OPAC_MAP,
        p_end,
    tp_lightmap, _T("lightMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_Lightmap,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_LM_MAP,
        p_end,
    tp_lightmap_intensity, _T("lightMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_TOON_LM_INT_E, IDC_TOON_LM_INT_S, 0.1f,
        p_end,
    tp_lightmap_channel, _T("lightMapChannel"), TYPE_INT, 0, 0,
        p_default, 2,
        p_range, 1, 8,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_TOON_LM_CH_E, IDC_TOON_LM_CH_S, 1.0f,
        p_end,
    tp_ao_map, _T("aoMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_AO,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_AO_MAP,
        p_end,
    tp_ao_intensity, _T("aoIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 5.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_TOON_AO_INT_E, IDC_TOON_AO_INT_S, 0.1f,
        p_end,
    tp_displacement_map, _T("displacementMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kToon_Displacement,
        p_ui, TYPE_TEXMAPBUTTON, IDC_TOON_DISP_MAP,
        p_end,
    tp_displacement_scale, _T("displacementScale"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, -1000.0f, 1000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_TOON_DISP_E, IDC_TOON_DISP_S, 0.1f,
        p_end,
    tp_displacement_bias, _T("displacementBias"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, -1000.0f, 1000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_TOON_DISP_B_E, IDC_TOON_DISP_B_S, 0.01f,
        p_end,
    tp_double_sided, _T("doubleSided"), TYPE_BOOL, 0, 0,
        p_default, TRUE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_TOON_DBLSIDE,
        p_end,

    p_end
);
