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
//  ThreeJS Materials — native PBR materials for the MaxJS viewport
//
//  Shell Material workflow:
//    Shell Material
//    ├── Original (Render): Standard Surface / Arnold
//    └── Baked (Viewport):  ThreeJS Material / ThreeJS Adv
// ══════════════════════════════════════════════════════════════

static const ParamID kMapParamIDs[kNumMaps] = {
    pb_color_map, pb_roughness_map, pb_metalness_map, pb_normal_map,
    pb_bump_map, pb_displacement_map, pb_parallax_map, pb_emissive_map,
    pb_opacity_map, pb_lightmap, pb_ao_map
};

static const MCHAR* kMapSlotNames[kNumMaps] = {
    _T("Color Map"), _T("Roughness Map"), _T("Metalness Map"), _T("Normal Map"),
    _T("Bump Map"), _T("Displacement Map"), _T("Parallax Map"), _T("Emissive Map"),
    _T("Opacity Map"), _T("Light Map"), _T("AO Map")
};

class ThreeJSMtl : public Mtl, public MaxSDK::Graphics::ITextureDisplay {
public:
    explicit ThreeJSMtl(BOOL loading, bool advanced)
        : advanced_(advanced) {
        GetDescriptor()->MakeAutoParamBlocks(this);
    }

    ~ThreeJSMtl() override {
        DiscardTexHandle();
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return advanced_ ? THREEJS_ADV_MTL_CLASS_ID : THREEJS_MTL_CLASS_ID; }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    void GetClassName(MSTR& s, bool localized) const override {
        s = advanced_ ? _T("ThreeJS Adv") : _T("ThreeJS Material");
    }

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle rtarg) override {
        if (i == 0) pblock = static_cast<IParamBlock2*>(rtarg);
    }

    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID&, RefMessage, BOOL) override {
        return REF_SUCCEED;
    }

    RefTargetHandle Clone(RemapDir& remap) override {
        ThreeJSMtl* m = new ThreeJSMtl(FALSE, advanced_);
        *static_cast<MtlBase*>(m) = *static_cast<MtlBase*>(this);
        BaseClone(this, m, remap);
        m->ReplaceReference(0, remap.CloneRef(pblock));
        return m;
    }

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

    BOOL SupportTexDisplay() override { return FALSE; }

    void ActivateTexDisplay(BOOL onoff) override {
        texDisplayOn_ = false;
        DiscardTexHandle();
    }

    DWORD_PTR GetActiveTexHandle(TimeValue t, TexHandleMaker& thmaker) override {
        DiscardTexHandle();
        return 0;
    }

    ULONG Requirements(int subMtlNum) override {
        return 0;
    }

    void SetupTextures(TimeValue t, MaxSDK::Graphics::DisplayTextureHelper& updater) override {
        (void)t;
        (void)updater;
    }

    BaseInterface* GetInterface(Interface_ID id) override {
        if (id == ITEXTURE_DISPLAY_INTERFACE_ID) {
            return static_cast<MaxSDK::Graphics::ITextureDisplay*>(this);
        }
        return Mtl::GetInterface(id);
    }

    ParamDlg* CreateParamDlg(HWND hwMtlEdit, IMtlParams* imp) override {
        return GetDescriptor()->CreateParamDlgs(hwMtlEdit, imp, this);
    }

    void Update(TimeValue t, Interval& valid) override { valid = FOREVER; }
    Interval Validity(TimeValue t) override { return FOREVER; }
    void Reset() override { GetDescriptor()->MakeAutoParamBlocks(this); }

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

    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override {
        return (id == threejs_params) ? pblock : nullptr;
    }

    void Shade(ShadeContext& sc) override {
        if (gbufID) sc.SetGBufferID(gbufID);
        const Color c = pblock ? pblock->GetColor(pb_color, sc.CurTime()) : Color(0.8f, 0.8f, 0.8f);
        sc.out.c = c;
        sc.out.t = Color(0, 0, 0);
    }
    float EvalDisplacement(ShadeContext&) override { return 0.0f; }
    Interval DisplacementValidity(TimeValue) override { return FOREVER; }

    IOResult Save(ISave* isave) override { return Mtl::Save(isave); }
    IOResult Load(ILoad* iload) override { return Mtl::Load(iload); }

    IParamBlock2* pblock = nullptr;

private:
    void DiscardTexHandle() {
        if (texHandle_) {
            texHandle_->DeleteThis();
            texHandle_ = nullptr;
        }
    }

    ClassDesc2* GetDescriptor() const {
        return advanced_ ? GetThreeJSAdvMtlDesc() : GetThreeJSMtlDesc();
    }

    bool texDisplayOn_ = false;
    TexHandle* texHandle_ = nullptr;
    bool advanced_ = false;
};

class ThreeJSMtlClassDesc : public ClassDesc2 {
public:
    ThreeJSMtlClassDesc(bool advanced, Class_ID classID, const TCHAR* className, const TCHAR* internalName)
        : advanced_(advanced), classID_(classID), className_(className), internalName_(internalName) {}

    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override { return new ThreeJSMtl(loading, advanced_); }
    const TCHAR* ClassName() override { return className_; }
    const TCHAR* NonLocalizedClassName() override { return className_; }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    Class_ID ClassID() override { return classID_; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return internalName_; }
    HINSTANCE HInstance() override { return hInstance; }

private:
    bool advanced_ = false;
    Class_ID classID_;
    const TCHAR* className_ = nullptr;
    const TCHAR* internalName_ = nullptr;
};

static ThreeJSMtlClassDesc threeJSMtlDesc(
    false, THREEJS_MTL_CLASS_ID, _T("ThreeJS Material"), _T("ThreeJSMaterial"));
static ThreeJSMtlClassDesc threeJSAdvMtlDesc(
    true, THREEJS_ADV_MTL_CLASS_ID, _T("ThreeJS Adv"), _T("ThreeJSAdvMaterial"));

ClassDesc2* GetThreeJSMtlDesc() { return &threeJSMtlDesc; }
ClassDesc2* GetThreeJSAdvMtlDesc() { return &threeJSAdvMtlDesc; }

#define THREEJS_COMMON_PARAM_ITEMS \
    pb_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0, \
        p_default, Color(0.8f, 0.8f, 0.8f), \
        p_ui, TYPE_COLORSWATCH, IDC_COLOR, \
        p_end, \
    pb_color_map, _T("colorMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Color, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_COLOR_MAP, \
        p_end, \
    pb_color_map_strength, _T("colorMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_MAPSTR_EDIT, IDC_MAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_roughness, _T("roughness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.5f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ROUGH_EDIT, IDC_ROUGH_SPIN, 0.01f, \
        p_end, \
    pb_roughness_map, _T("roughnessMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Roughness, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_ROUGH_MAP, \
        p_end, \
    pb_roughness_map_strength, _T("roughnessMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_RMAPSTR_EDIT, IDC_RMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_metalness, _T("metalness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_METAL_EDIT, IDC_METAL_SPIN, 0.01f, \
        p_end, \
    pb_metalness_map, _T("metalnessMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Metalness, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_METAL_MAP, \
        p_end, \
    pb_metalness_map_strength, _T("metalnessMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_MMAPSTR_EDIT, IDC_MMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_normal_map, _T("normalMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Normal, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_NORMAL_MAP, \
        p_end, \
    pb_normal_scale, _T("normalScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 5.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_NORMSCL_EDIT, IDC_NORMSCL_SPIN, 0.01f, \
        p_end, \
    pb_bump_map, _T("bumpMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Bump, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_BUMP_MAP, \
        p_end, \
    pb_bump_scale, _T("bumpScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 5.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_BUMP_EDIT, IDC_BUMP_SPIN, 0.01f, \
        p_end, \
    pb_displacement_map, _T("displacementMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Displacement, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_DISP_MAP, \
        p_end, \
    pb_displacement_scale, _T("displacementScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, -1000.0f, 1000.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DISP_EDIT, IDC_DISP_SPIN, 0.01f, \
        p_end, \
    pb_displacement_bias, _T("displacementBias"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, -1000.0f, 1000.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DISP_BIAS_EDIT, IDC_DISP_BIAS_SPIN, 0.01f, \
        p_end, \
    pb_emissive_color, _T("emissiveColor"), TYPE_RGBA, P_ANIMATABLE, 0, \
        p_default, Color(0.0f, 0.0f, 0.0f), \
        p_ui, TYPE_COLORSWATCH, IDC_EM_COLOR, \
        p_end, \
    pb_emissive_map, _T("emissiveMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Emissive, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_EM_MAP, \
        p_end, \
    pb_emissive_intensity, _T("emissiveIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 100.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_EM_INT_EDIT, IDC_EM_INT_SPIN, 0.1f, \
        p_end, \
    pb_emissive_map_strength, _T("emissiveMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_EMMAPSTR_EDIT, IDC_EMMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_opacity, _T("opacity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_OPACITY_EDIT, IDC_OPACITY_SPIN, 0.01f, \
        p_end, \
    pb_opacity_map, _T("opacityMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Opacity, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_OPACITY_MAP, \
        p_end, \
    pb_opacity_map_strength, _T("opacityMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_OPMAPSTR_EDIT, IDC_OPMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_lightmap, _T("lightMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Lightmap, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_LM_MAP, \
        p_end, \
    pb_lightmap_intensity, _T("lightMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 10.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LM_INT_EDIT, IDC_LM_INT_SPIN, 0.1f, \
        p_end, \
    pb_lightmap_channel, _T("lightMapChannel"), TYPE_INT, 0, 0, \
        p_default, 2, \
        p_range, 1, 8, \
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_LM_CH_EDIT, IDC_LM_CH_SPIN, 1.0f, \
        p_end, \
    pb_ao_map, _T("aoMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_AO, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_AO_MAP, \
        p_end, \
    pb_ao_intensity, _T("aoIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 5.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AO_INT_EDIT, IDC_AO_INT_SPIN, 0.1f, \
        p_end, \
    pb_double_sided, _T("doubleSided"), TYPE_BOOL, 0, 0, \
        p_default, TRUE, \
        p_ui, TYPE_SINGLECHEKBOX, IDC_DOUBLE_SIDED, \
        p_end, \
    pb_env_intensity, _T("envMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 10.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ENV_INT_EDIT, IDC_ENV_INT_SPIN, 0.1f, \
        p_end

#define THREEJS_HIDDEN_ADV_PARAM_ITEMS \
    pb_parallax_map, _T("parallaxMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Parallax, \
        p_end, \
    pb_parallax_scale, _T("parallaxScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, -1.0f, 1.0f, \
        p_end

#define THREEJS_ADV_PARAM_ITEMS \
    pb_parallax_map, _T("parallaxMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Parallax, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_PARALLAX_MAP, \
        p_end, \
    pb_parallax_scale, _T("parallaxScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, -1.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PARALLAX_EDIT, IDC_PARALLAX_SPIN, 0.001f, \
        p_end

static ParamBlockDesc2 threejs_pb_desc(
    threejs_params,
    _T("ThreeJS Material Parameters"),
    IDS_PARAMS,
    &threeJSMtlDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_MTL, IDS_PARAMS, 0, 0, nullptr,
    THREEJS_COMMON_PARAM_ITEMS,
    THREEJS_HIDDEN_ADV_PARAM_ITEMS,
    p_end
);

static ParamBlockDesc2 threejs_adv_pb_desc(
    threejs_params,
    _T("ThreeJS Adv Parameters"),
    IDS_ADV_PARAMS,
    &threeJSAdvMtlDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_ADV_MTL, IDS_ADV_PARAMS, 0, 0, nullptr,
    THREEJS_COMMON_PARAM_ITEMS,
    THREEJS_ADV_PARAM_ITEMS,
    p_end
);
