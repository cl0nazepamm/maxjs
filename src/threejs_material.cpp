#include "threejs_material.h"
#include "resource.h"
#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <imtl.h>
#include <plugapi.h>
#include <maxapi.h>
#include <stdmat.h>
#include <Graphics/ITextureDisplay.h>

extern HINSTANCE hInstance;

// ══════════════════════════════════════════════════════════════
//  ThreeJS Material — native PBR material for Three.js viewport
//
//  Shell Material workflow:
//    Shell Material
//    ├── Original (Render): Standard Surface / Arnold
//    └── Baked (Viewport):  ThreeJS Material  ← this
// ══════════════════════════════════════════════════════════════

static const ParamID kMapParamIDs[kNumMaps] = {
    pb_color_map, pb_roughness_map, pb_metalness_map, pb_normal_map,
    pb_emissive_map, pb_opacity_map, pb_lightmap, pb_ao_map
};

static const MCHAR* kMapSlotNames[kNumMaps] = {
    _T("Color Map"), _T("Roughness Map"), _T("Metalness Map"), _T("Normal Map"),
    _T("Emissive Map"), _T("Opacity Map"), _T("Light Map"), _T("AO Map")
};

// ── Material Class ────────────────────────────────────────────

class ThreeJSMtl : public Mtl, public MaxSDK::Graphics::ITextureDisplay {
public:
    IParamBlock2* pblock = nullptr;
    bool texDisplayOn_ = false;
    TexHandle* texHandle_ = nullptr;

    ThreeJSMtl(BOOL loading) {
        GetThreeJSMtlDesc()->MakeAutoParamBlocks(this);
    }

    ~ThreeJSMtl() {
        DiscardTexHandle();
    }

    void DiscardTexHandle() {
        if (texHandle_) { texHandle_->DeleteThis(); texHandle_ = nullptr; }
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_MTL_CLASS_ID; }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    void GetClassName(MSTR& s, bool localized) const override { s = _T("ThreeJS Material"); }

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle rtarg) override {
        if (i == 0) pblock = static_cast<IParamBlock2*>(rtarg);
    }

    RefResult NotifyRefChanged(const Interval&, RefTargetHandle,
                               PartID&, RefMessage, BOOL) override {
        return REF_SUCCEED;
    }

    RefTargetHandle Clone(RemapDir& remap) override {
        ThreeJSMtl* m = new ThreeJSMtl(FALSE);
        *static_cast<MtlBase*>(m) = *static_cast<MtlBase*>(this);
        BaseClone(this, m, remap);
        m->ReplaceReference(0, remap.CloneRef(pblock));
        BaseClone(this, m, remap);
        return m;
    }

    // Viewport display
    Color GetAmbient(int, BOOL) override {
        return pblock ? pblock->GetColor(pb_color, 0) * 0.2f : Color(0.1f, 0.1f, 0.1f);
    }
    Color GetDiffuse(int, BOOL) override {
        return pblock ? pblock->GetColor(pb_color, 0) : Color(0.8f, 0.8f, 0.8f);
    }
    Color GetSpecular(int, BOOL) override { return Color(1, 1, 1); }
    float GetShininess(int, BOOL) override {
        return pblock ? (1.0f - pblock->GetFloat(pb_roughness, 0)) : 0.5f;
    }
    float GetShinStr(int, BOOL) override { return 1.0f; }
    float GetXParency(int, BOOL) override {
        return pblock ? (1.0f - pblock->GetFloat(pb_opacity, 0)) : 0.0f;
    }

    void SetAmbient(Color, TimeValue) override {}
    void SetDiffuse(Color c, TimeValue t) override {
        if (pblock) pblock->SetValue(pb_color, t, c);
    }
    void SetSpecular(Color, TimeValue) override {}
    void SetShininess(float v, TimeValue t) override {
        if (pblock) pblock->SetValue(pb_roughness, t, 1.0f - v);
    }

    // ── Viewport Texture Display ────────────────────────────
    BOOL SupportTexDisplay() override { return TRUE; }

    void ActivateTexDisplay(BOOL onoff) override {
        texDisplayOn_ = (onoff != 0);
        if (!texDisplayOn_) DiscardTexHandle();
    }

    DWORD_PTR GetActiveTexHandle(TimeValue t, TexHandleMaker& thmaker) override {
        Texmap* colorMap = pblock ? pblock->GetTexmap(pb_color_map, t) : nullptr;
        if (!colorMap) { DiscardTexHandle(); return 0; }
        DiscardTexHandle();
        Interval valid;
        BITMAPINFO* bmi = colorMap->GetVPDisplayDIB(t, thmaker, valid);
        if (bmi) texHandle_ = thmaker.CreateHandle(bmi);
        return (DWORD_PTR)texHandle_;
    }

    ULONG Requirements(int subMtlNum) override {
        return MTLREQ_UV;
    }

    // ITextureDisplay (Nitrous)
    void SetupTextures(TimeValue t, MaxSDK::Graphics::DisplayTextureHelper& updater) override {
        Texmap* colorMap = pblock ? pblock->GetTexmap(pb_color_map, t) : nullptr;
        if (colorMap) {
            updater.UpdateTextureMapInfo(t, MaxSDK::Graphics::ISimpleMaterial::UsageDiffuse, colorMap);
        }
    }

    // ITextureDisplay interface via BaseInterface
    BaseInterface* GetInterface(Interface_ID id) override {
        if (id == ITEXTURE_DISPLAY_INTERFACE_ID)
            return static_cast<MaxSDK::Graphics::ITextureDisplay*>(this);
        return Mtl::GetInterface(id);
    }

    ParamDlg* CreateParamDlg(HWND hwMtlEdit, IMtlParams* imp) override {
        return GetThreeJSMtlDesc()->CreateParamDlgs(hwMtlEdit, imp, this);
    }

    void Update(TimeValue t, Interval& valid) override { valid = FOREVER; }
    Interval Validity(TimeValue t) override { return FOREVER; }
    void Reset() override { GetThreeJSMtlDesc()->MakeAutoParamBlocks(this); }

    // SubTexmap
    int NumSubTexmaps() override { return kNumMaps; }
    Texmap* GetSubTexmap(int i) override {
        if (!pblock || i < 0 || i >= kNumMaps) return nullptr;
        return pblock->GetTexmap(kMapParamIDs[i]);
    }
    void SetSubTexmap(int i, Texmap* m) override {
        if (!pblock || i < 0 || i >= kNumMaps) return;
        pblock->SetValue(kMapParamIDs[i], 0, m);
    }
    MSTR GetSubTexmapSlotName(int i, bool) override {
        if (i >= 0 && i < kNumMaps) return MSTR(kMapSlotNames[i]);
        return MSTR(_T(""));
    }
    int MapSlotType(int) override { return MAPSLOT_TEXTURE; }

    // ParamBlock
    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override {
        return (id == threejs_params) ? pblock : nullptr;
    }

    // Shade
    void Shade(ShadeContext& sc) override {
        if (gbufID) sc.SetGBufferID(gbufID);
        Color c = pblock ? pblock->GetColor(pb_color, sc.CurTime()) : Color(0.8f, 0.8f, 0.8f);
        sc.out.c = c;
        sc.out.t = Color(0, 0, 0);
    }
    float EvalDisplacement(ShadeContext&) override { return 0.0f; }
    Interval DisplacementValidity(TimeValue) override { return FOREVER; }

    IOResult Save(ISave* isave) override {
        return Mtl::Save(isave);  // Let base class + paramblock handle serialization
    }
    IOResult Load(ILoad* iload) override {
        return Mtl::Load(iload);
    }
};

// ── Class Descriptor ──────────────────────────────────────────

class ThreeJSMtlClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override { return new ThreeJSMtl(loading); }
    const TCHAR* ClassName() override { return _T("ThreeJS Material"); }
    const TCHAR* NonLocalizedClassName() override { return _T("ThreeJS Material"); }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_MTL_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSMaterial"); }
    HINSTANCE HInstance() override { return hInstance; }
};

static ThreeJSMtlClassDesc threeJSMtlDesc;
ClassDesc2* GetThreeJSMtlDesc() { return &threeJSMtlDesc; }

// ── ParamBlock Descriptor with UI ─────────────────────────────

static ParamBlockDesc2 threejs_pb_desc(
    threejs_params,
    _T("ThreeJS Material Parameters"),
    IDS_PARAMS,
    &threeJSMtlDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    // P_AUTO_CONSTRUCT ref index:
    0,
    // P_AUTO_UI params:
    IDD_THREEJS_MTL, IDS_PARAMS, 0, 0, nullptr,

    // ═══ PBR Core ═════════════════════════════════════════════
    pb_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(0.8f, 0.8f, 0.8f),
        p_ui, TYPE_COLORSWATCH, IDC_COLOR,
        p_end,
    pb_color_map, _T("colorMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kMap_Color,
        p_ui, TYPE_TEXMAPBUTTON, IDC_COLOR_MAP,
        p_end,

    pb_roughness, _T("roughness"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.5f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ROUGH_EDIT, IDC_ROUGH_SPIN, 0.01f,
        p_end,
    pb_roughness_map, _T("roughnessMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kMap_Roughness,
        p_ui, TYPE_TEXMAPBUTTON, IDC_ROUGH_MAP,
        p_end,

    pb_metalness, _T("metalness"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_METAL_EDIT, IDC_METAL_SPIN, 0.01f,
        p_end,
    pb_metalness_map, _T("metalnessMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kMap_Metalness,
        p_ui, TYPE_TEXMAPBUTTON, IDC_METAL_MAP,
        p_end,

    pb_normal_map, _T("normalMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kMap_Normal,
        p_ui, TYPE_TEXMAPBUTTON, IDC_NORMAL_MAP,
        p_end,
    pb_normal_scale, _T("normalScale"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 5.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_NORMSCL_EDIT, IDC_NORMSCL_SPIN, 0.01f,
        p_end,

    // ═══ Emission ═════════════════════════════════════════════
    pb_emissive_color, _T("emissiveColor"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(0.0f, 0.0f, 0.0f),
        p_ui, TYPE_COLORSWATCH, IDC_EM_COLOR,
        p_end,
    pb_emissive_map, _T("emissiveMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kMap_Emissive,
        p_ui, TYPE_TEXMAPBUTTON, IDC_EM_MAP,
        p_end,
    pb_emissive_intensity, _T("emissiveIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 100.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_EM_INT_EDIT, IDC_EM_INT_SPIN, 0.1f,
        p_end,

    // ═══ Transparency ═════════════════════════════════════════
    pb_opacity, _T("opacity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_OPACITY_EDIT, IDC_OPACITY_SPIN, 0.01f,
        p_end,
    pb_opacity_map, _T("opacityMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kMap_Opacity,
        p_ui, TYPE_TEXMAPBUTTON, IDC_OPACITY_MAP,
        p_end,

    // ═══ Lightmap ═════════════════════════════════════════════
    pb_lightmap, _T("lightMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kMap_Lightmap,
        p_ui, TYPE_TEXMAPBUTTON, IDC_LM_MAP,
        p_end,
    pb_lightmap_intensity, _T("lightMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LM_INT_EDIT, IDC_LM_INT_SPIN, 0.1f,
        p_end,
    pb_lightmap_channel, _T("lightMapChannel"), TYPE_INT, 0, 0,
        p_default, 2,
        p_range, 1, 8,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_LM_CH_EDIT, IDC_LM_CH_SPIN, 1.0f,
        p_end,

    // ═══ AO ═══════════════════════════════════════════════════
    pb_ao_map, _T("aoMap"), TYPE_TEXMAP, 0, 0,
        p_subtexno, kMap_AO,
        p_ui, TYPE_TEXMAPBUTTON, IDC_AO_MAP,
        p_end,
    pb_ao_intensity, _T("aoIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 5.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AO_INT_EDIT, IDC_AO_INT_SPIN, 0.1f,
        p_end,

    // ═══ Options ══════════════════════════════════════════════
    pb_double_sided, _T("doubleSided"), TYPE_BOOL, 0, 0,
        p_default, TRUE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_DOUBLE_SIDED,
        p_end,

    pb_env_intensity, _T("envMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ENV_INT_EDIT, IDC_ENV_INT_SPIN, 0.1f,
        p_end,

    p_end
);
