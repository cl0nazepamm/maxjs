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
    pb_opacity_map, pb_lightmap, pb_ao_map, pb_sss_color_map, pb_matcap_map
};

static const MCHAR* kMapSlotNames[kNumMaps] = {
    _T("Color Map"), _T("Roughness Map"), _T("Metalness Map"), _T("Normal Map"),
    _T("Bump Map"), _T("Displacement Map"), _T("Parallax Map"), _T("Emissive Map"),
    _T("Opacity Map"), _T("Light Map"), _T("AO Map"), _T("SSS Color Map"), _T("Matcap Map")
};

enum class ThreeJSMaterialKind {
    Standard,
    Physical,
    SSS,
    Utility,
};

static bool HasParam(IParamBlock2* pb, ParamID id) {
    if (!pb) return false;
    for (int i = 0; i < pb->NumParams(); ++i) {
        if (pb->IndextoID(i) == id) return true;
    }
    return false;
}

static float GetOptionalFloat(IParamBlock2* pb, ParamID id, TimeValue t, float def) {
    return HasParam(pb, id) ? pb->GetFloat(id, t) : def;
}

static int GetOptionalInt(IParamBlock2* pb, ParamID id, TimeValue t, int def) {
    return HasParam(pb, id) ? pb->GetInt(id, t) : def;
}

static Color GetOptionalColor(IParamBlock2* pb, ParamID id, TimeValue t, const Color& def) {
    return HasParam(pb, id) ? pb->GetColor(id, t) : def;
}

class ThreeJSMtl : public Mtl, public MaxSDK::Graphics::ITextureDisplay {
public:
    explicit ThreeJSMtl(BOOL loading, ThreeJSMaterialKind kind)
        : kind_(kind) {
        GetDescriptor()->MakeAutoParamBlocks(this);
    }

    ~ThreeJSMtl() override {
        DiscardTexHandle();
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override {
        switch (kind_) {
            case ThreeJSMaterialKind::Physical: return THREEJS_ADV_MTL_CLASS_ID;
            case ThreeJSMaterialKind::SSS: return THREEJS_SSS_MTL_CLASS_ID;
            case ThreeJSMaterialKind::Utility: return THREEJS_UTILITY_MTL_CLASS_ID;
            case ThreeJSMaterialKind::Standard:
            default: return THREEJS_MTL_CLASS_ID;
        }
    }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    void GetClassName(MSTR& s, bool localized) const override {
        switch (kind_) {
            case ThreeJSMaterialKind::Physical: s = _T("ThreeJS Adv"); break;
            case ThreeJSMaterialKind::SSS: s = _T("ThreeJS SSS"); break;
            case ThreeJSMaterialKind::Utility: s = _T("ThreeJS Utility"); break;
            case ThreeJSMaterialKind::Standard:
            default: s = _T("ThreeJS Material"); break;
        }
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
        ThreeJSMtl* m = new ThreeJSMtl(FALSE, kind_);
        *static_cast<MtlBase*>(m) = *static_cast<MtlBase*>(this);
        BaseClone(this, m, remap);
        m->ReplaceReference(0, remap.CloneRef(pblock));
        return m;
    }

    Color GetAmbient(int, BOOL) override {
        return pblock ? GetOptionalColor(pblock, pb_color, 0, Color(0.8f, 0.8f, 0.8f)) * 0.2f : Color(0.1f, 0.1f, 0.1f);
    }
    Color GetDiffuse(int, BOOL) override {
        return pblock ? GetOptionalColor(pblock, pb_color, 0, Color(0.8f, 0.8f, 0.8f)) : Color(0.8f, 0.8f, 0.8f);
    }
    Color GetSpecular(int, BOOL) override {
        return pblock ? GetOptionalColor(pblock, pb_specular_color, 0, Color(1, 1, 1)) : Color(1, 1, 1);
    }
    float GetShininess(int, BOOL) override {
        if (!pblock) return 0.5f;
        if (HasParam(pblock, pb_shininess)) return GetOptionalFloat(pblock, pb_shininess, 0, 30.0f) / 100.0f;
        return 1.0f - GetOptionalFloat(pblock, pb_roughness, 0, 0.5f);
    }
    float GetShinStr(int, BOOL) override { return 1.0f; }
    float GetXParency(int, BOOL) override {
        return pblock ? (1.0f - GetOptionalFloat(pblock, pb_opacity, 0, 1.0f)) : 0.0f;
    }

    void SetAmbient(Color, TimeValue) override {}
    void SetDiffuse(Color c, TimeValue t) override {
        if (pblock && HasParam(pblock, pb_color)) pblock->SetValue(pb_color, t, c);
    }
    void SetSpecular(Color, TimeValue) override {}
    void SetShininess(float v, TimeValue t) override {
        if (!pblock) return;
        if (HasParam(pblock, pb_shininess)) {
            pblock->SetValue(pb_shininess, t, v * 100.0f);
        } else if (HasParam(pblock, pb_roughness)) {
            pblock->SetValue(pb_roughness, t, 1.0f - v);
        }
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
        const ParamID pid = kMapParamIDs[i];
        return HasParam(pblock, pid) ? pblock->GetTexmap(pid) : nullptr;
    }
    void SetSubTexmap(int i, Texmap* m) override {
        if (!pblock || i < 0 || i >= kNumMaps) return;
        const ParamID pid = kMapParamIDs[i];
        if (HasParam(pblock, pid)) pblock->SetValue(pid, 0, m);
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
        const Color c = pblock ? GetOptionalColor(pblock, pb_color, sc.CurTime(), Color(0.8f, 0.8f, 0.8f)) : Color(0.8f, 0.8f, 0.8f);
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
        switch (kind_) {
            case ThreeJSMaterialKind::Physical: return GetThreeJSAdvMtlDesc();
            case ThreeJSMaterialKind::SSS: return GetThreeJSSSSMtlDesc();
            case ThreeJSMaterialKind::Utility: return GetThreeJSUtilityMtlDesc();
            case ThreeJSMaterialKind::Standard:
            default: return GetThreeJSMtlDesc();
        }
    }

    bool texDisplayOn_ = false;
    TexHandle* texHandle_ = nullptr;
    ThreeJSMaterialKind kind_ = ThreeJSMaterialKind::Standard;
};

class ThreeJSMtlClassDesc : public ClassDesc2 {
public:
    ThreeJSMtlClassDesc(ThreeJSMaterialKind kind, Class_ID classID, const TCHAR* className, const TCHAR* internalName)
        : kind_(kind), classID_(classID), className_(className), internalName_(internalName) {}

    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override { return new ThreeJSMtl(loading, kind_); }
    const TCHAR* ClassName() override { return className_; }
    const TCHAR* NonLocalizedClassName() override { return className_; }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    Class_ID ClassID() override { return classID_; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return internalName_; }
    HINSTANCE HInstance() override { return hInstance; }

private:
    ThreeJSMaterialKind kind_ = ThreeJSMaterialKind::Standard;
    Class_ID classID_;
    const TCHAR* className_ = nullptr;
    const TCHAR* internalName_ = nullptr;
};

static ThreeJSMtlClassDesc threeJSMtlDesc(
    ThreeJSMaterialKind::Standard, THREEJS_MTL_CLASS_ID, _T("ThreeJS Material"), _T("ThreeJSMaterial"));
static ThreeJSMtlClassDesc threeJSAdvMtlDesc(
    ThreeJSMaterialKind::Physical, THREEJS_ADV_MTL_CLASS_ID, _T("ThreeJS Adv"), _T("ThreeJSAdvMaterial"));
static ThreeJSMtlClassDesc threeJSSSSMtlDesc(
    ThreeJSMaterialKind::SSS, THREEJS_SSS_MTL_CLASS_ID, _T("ThreeJS SSS"), _T("ThreeJSSSSMaterial"));
static ThreeJSMtlClassDesc threeJSUtilityMtlDesc(
    ThreeJSMaterialKind::Utility, THREEJS_UTILITY_MTL_CLASS_ID, _T("ThreeJS Utility"), _T("ThreeJSUtilityMaterial"));

ClassDesc2* GetThreeJSMtlDesc() { return &threeJSMtlDesc; }
ClassDesc2* GetThreeJSAdvMtlDesc() { return &threeJSAdvMtlDesc; }
ClassDesc2* GetThreeJSSSSMtlDesc() { return &threeJSSSSMtlDesc; }
ClassDesc2* GetThreeJSUtilityMtlDesc() { return &threeJSUtilityMtlDesc; }

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
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_MAPSTR_EDIT, IDC_MAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_roughness, _T("roughness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.5f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ROUGH_EDIT, IDC_ROUGH_SPIN, 0.01f, \
        p_end, \
    pb_roughness_map, _T("roughnessMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Roughness, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_ROUGH_MAP, \
        p_end, \
    pb_roughness_map_strength, _T("roughnessMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_RMAPSTR_EDIT, IDC_RMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_metalness, _T("metalness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_METAL_EDIT, IDC_METAL_SPIN, 0.01f, \
        p_end, \
    pb_metalness_map, _T("metalnessMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Metalness, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_METAL_MAP, \
        p_end, \
    pb_metalness_map_strength, _T("metalnessMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_MMAPSTR_EDIT, IDC_MMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_normal_map, _T("normalMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Normal, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_NORMAL_MAP, \
        p_end, \
    pb_normal_scale, _T("normalScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_NORMSCL_EDIT, IDC_NORMSCL_SPIN, 0.01f, \
        p_end, \
    pb_bump_map, _T("bumpMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Bump, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_BUMP_MAP, \
        p_end, \
    pb_bump_scale, _T("bumpScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
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
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_EM_INT_EDIT, IDC_EM_INT_SPIN, 0.1f, \
        p_end, \
    pb_emissive_map_strength, _T("emissiveMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_EMMAPSTR_EDIT, IDC_EMMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_opacity, _T("opacity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_OPACITY_EDIT, IDC_OPACITY_SPIN, 0.01f, \
        p_end, \
    pb_opacity_map, _T("opacityMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Opacity, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_OPACITY_MAP, \
        p_end, \
    pb_opacity_map_strength, _T("opacityMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_OPMAPSTR_EDIT, IDC_OPMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_lightmap, _T("lightMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Lightmap, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_LM_MAP, \
        p_end, \
    pb_lightmap_intensity, _T("lightMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
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
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AO_INT_EDIT, IDC_AO_INT_SPIN, 0.1f, \
        p_end, \
    pb_double_sided, _T("doubleSided"), TYPE_BOOL, 0, 0, \
        p_default, TRUE, \
        p_ui, TYPE_SINGLECHEKBOX, IDC_DOUBLE_SIDED, \
        p_end, \
    pb_env_intensity, _T("envMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ENV_INT_EDIT, IDC_ENV_INT_SPIN, 0.1f, \
        p_end

#define THREEJS_HIDDEN_LEGACY_PARAM_ITEMS \
    pb_parallax_map, _T("parallaxMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Parallax, \
        p_end, \
    pb_parallax_scale, _T("parallaxScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, -99999.0f, 99999.0f, \
        p_end

#define THREEJS_SSS_PARAM_ITEMS \
    pb_sss_color, _T("sssColor"), TYPE_RGBA, P_ANIMATABLE, 0, \
        p_default, Color(1.0f, 1.0f, 1.0f), \
        p_ui, TYPE_COLORSWATCH, IDC_SSS_COLOR, \
        p_end, \
    pb_sss_color_map, _T("sssColorMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_SSSColor, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_SSS_COLOR_MAP, \
        p_end, \
    pb_sss_distortion, _T("sssDistortion"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.1f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SSS_DIST_EDIT, IDC_SSS_DIST_SPIN, 0.01f, \
        p_end, \
    pb_sss_ambient, _T("sssAmbient"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SSS_AMB_EDIT, IDC_SSS_AMB_SPIN, 0.01f, \
        p_end, \
    pb_sss_attenuation, _T("sssAttenuation"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.1f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SSS_ATT_EDIT, IDC_SSS_ATT_SPIN, 0.01f, \
        p_end, \
    pb_sss_power, _T("sssPower"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 2.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SSS_PWR_EDIT, IDC_SSS_PWR_SPIN, 0.05f, \
        p_end, \
    pb_sss_scale, _T("sssScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 10.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SSS_SCALE_EDIT, IDC_SSS_SCALE_SPIN, 0.1f, \
        p_end

#define THREEJS_PHYSICAL_PARAM_ITEMS \
    pb_phys_specular_color, _T("physicalSpecularColor"), TYPE_RGBA, P_ANIMATABLE, 0, \
        p_default, Color(1.0f, 1.0f, 1.0f), \
        p_ui, TYPE_COLORSWATCH, IDC_PHYS_SPEC_COLOR, \
        p_end, \
    pb_phys_specular_intensity, _T("physicalSpecularIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_SPEC_INT_EDIT, IDC_PHYS_SPEC_INT_SPIN, 0.01f, \
        p_end, \
    pb_phys_clearcoat, _T("physicalClearcoat"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_CLEARCOAT_EDIT, IDC_PHYS_CLEARCOAT_SPIN, 0.01f, \
        p_end, \
    pb_phys_clearcoat_roughness, _T("physicalClearcoatRoughness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_CLEARCOAT_ROUGH_EDIT, IDC_PHYS_CLEARCOAT_ROUGH_SPIN, 0.01f, \
        p_end, \
    pb_phys_sheen, _T("physicalSheen"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_SHEEN_EDIT, IDC_PHYS_SHEEN_SPIN, 0.01f, \
        p_end, \
    pb_phys_sheen_roughness, _T("physicalSheenRoughness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_SHEEN_ROUGH_EDIT, IDC_PHYS_SHEEN_ROUGH_SPIN, 0.01f, \
        p_end, \
    pb_phys_sheen_color, _T("physicalSheenColor"), TYPE_RGBA, P_ANIMATABLE, 0, \
        p_default, Color(0.0f, 0.0f, 0.0f), \
        p_ui, TYPE_COLORSWATCH, IDC_PHYS_SHEEN_COLOR, \
        p_end, \
    pb_phys_iridescence, _T("physicalIridescence"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_IRIDESCENCE_EDIT, IDC_PHYS_IRIDESCENCE_SPIN, 0.01f, \
        p_end, \
    pb_phys_iridescence_ior, _T("physicalIridescenceIOR"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.3f, \
        p_range, 1.0f, 3.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_IRIDESCENCE_IOR_EDIT, IDC_PHYS_IRIDESCENCE_IOR_SPIN, 0.01f, \
        p_end, \
    pb_phys_transmission, _T("physicalTransmission"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_TRANSMISSION_EDIT, IDC_PHYS_TRANSMISSION_SPIN, 0.01f, \
        p_end, \
    pb_phys_ior, _T("physicalIOR"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.5f, \
        p_range, 1.0f, 2.333f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_IOR_EDIT, IDC_PHYS_IOR_SPIN, 0.01f, \
        p_end, \
    pb_phys_thickness, _T("physicalThickness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_THICKNESS_EDIT, IDC_PHYS_THICKNESS_SPIN, 0.01f, \
        p_end, \
    pb_phys_dispersion, _T("physicalDispersion"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 10.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_DISPERSION_EDIT, IDC_PHYS_DISPERSION_SPIN, 0.01f, \
        p_end, \
    pb_phys_attenuation_color, _T("physicalAttenuationColor"), TYPE_RGBA, P_ANIMATABLE, 0, \
        p_default, Color(1.0f, 1.0f, 1.0f), \
        p_ui, TYPE_COLORSWATCH, IDC_PHYS_ATT_COLOR, \
        p_end, \
    pb_phys_attenuation_distance, _T("physicalAttenuationDistance"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_ATT_DIST_EDIT, IDC_PHYS_ATT_DIST_SPIN, 0.1f, \
        p_end, \
    pb_phys_anisotropy, _T("physicalAnisotropy"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PHYS_ANISOTROPY_EDIT, IDC_PHYS_ANISOTROPY_SPIN, 0.01f, \
        p_end

#define THREEJS_UTILITY_PARAM_ITEMS \
    pb_utility_model, _T("utilityModel"), TYPE_INT, 0, 0, \
        p_default, threejs_utility_lambert, \
        p_ui, TYPE_INT_COMBOBOX, IDC_UTILITY_MODE, 7, \
            IDS_UTILITY_MODE_DISTANCE, IDS_UTILITY_MODE_DEPTH, IDS_UTILITY_MODE_LAMBERT, \
            IDS_UTILITY_MODE_MATCAP, IDS_UTILITY_MODE_NORMAL, IDS_UTILITY_MODE_PHONG, \
            IDS_UTILITY_MODE_BACKDROP, \
        p_vals, threejs_utility_distance, threejs_utility_depth, threejs_utility_lambert, \
            threejs_utility_matcap, threejs_utility_normal, threejs_utility_phong, \
            threejs_utility_backdrop, \
        p_end, \
    pb_backdrop_mode, _T("backdropMode"), TYPE_INT, 0, 0, \
        p_default, threejs_backdrop_blurred, \
        p_ui, TYPE_INT_COMBOBOX, IDC_UTILITY_BACKDROP_MODE, 4, \
            IDS_BACKDROP_MODE_BLURRED, IDS_BACKDROP_MODE_DEPTH, IDS_BACKDROP_MODE_TEXTURE, IDS_BACKDROP_MODE_PIXEL, \
        p_vals, threejs_backdrop_blurred, threejs_backdrop_depth, threejs_backdrop_texture, threejs_backdrop_pixel, \
        p_end, \
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
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_MAPSTR_EDIT, IDC_MAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_roughness, _T("roughness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.5f, \
        p_range, 0.0f, 99999.0f, \
        p_end, \
    pb_roughness_map, _T("roughnessMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Roughness, \
        p_end, \
    pb_roughness_map_strength, _T("roughnessMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_end, \
    pb_metalness, _T("metalness"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.0f, \
        p_range, 0.0f, 99999.0f, \
        p_end, \
    pb_metalness_map, _T("metalnessMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Metalness, \
        p_end, \
    pb_metalness_map_strength, _T("metalnessMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_end, \
    pb_normal_map, _T("normalMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Normal, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_NORMAL_MAP, \
        p_end, \
    pb_normal_scale, _T("normalScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_NORMSCL_EDIT, IDC_NORMSCL_SPIN, 0.01f, \
        p_end, \
    pb_bump_map, _T("bumpMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Bump, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_BUMP_MAP, \
        p_end, \
    pb_bump_scale, _T("bumpScale"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
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
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_EM_INT_EDIT, IDC_EM_INT_SPIN, 0.1f, \
        p_end, \
    pb_emissive_map_strength, _T("emissiveMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_EMMAPSTR_EDIT, IDC_EMMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_opacity, _T("opacity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_OPACITY_EDIT, IDC_OPACITY_SPIN, 0.01f, \
        p_end, \
    pb_opacity_map, _T("opacityMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Opacity, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_OPACITY_MAP, \
        p_end, \
    pb_opacity_map_strength, _T("opacityMapStrength"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_OPMAPSTR_EDIT, IDC_OPMAPSTR_SPIN, 0.01f, \
        p_end, \
    pb_lightmap, _T("lightMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Lightmap, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_LM_MAP, \
        p_end, \
    pb_lightmap_intensity, _T("lightMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
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
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AO_INT_EDIT, IDC_AO_INT_SPIN, 0.1f, \
        p_end, \
    pb_matcap_map, _T("matcapMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Matcap, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_UTILITY_MATCAP_MAP, \
        p_end, \
    pb_specular_color, _T("specularColor"), TYPE_RGBA, P_ANIMATABLE, 0, \
        p_default, Color(0.0666667f, 0.0666667f, 0.0666667f), \
        p_ui, TYPE_COLORSWATCH, IDC_UTILITY_SPECULAR, \
        p_end, \
    pb_shininess, _T("shininess"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 30.0f, \
        p_range, 0.0f, 1000.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_UTILITY_SHINE_EDIT, IDC_UTILITY_SHINE_SPIN, 1.0f, \
        p_end, \
    pb_flat_shading, _T("flatShading"), TYPE_BOOL, 0, 0, \
        p_default, FALSE, \
        p_ui, TYPE_SINGLECHEKBOX, IDC_UTILITY_FLAT, \
        p_end, \
    pb_wireframe, _T("wireframe"), TYPE_BOOL, 0, 0, \
        p_default, FALSE, \
        p_ui, TYPE_SINGLECHEKBOX, IDC_UTILITY_WIREFRAME, \
        p_end, \
    pb_double_sided, _T("doubleSided"), TYPE_BOOL, 0, 0, \
        p_default, TRUE, \
        p_ui, TYPE_SINGLECHEKBOX, IDC_DOUBLE_SIDED, \
        p_end, \
    pb_env_intensity, _T("envMapIntensity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 99999.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ENV_INT_EDIT, IDC_ENV_INT_SPIN, 0.1f, \
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
    THREEJS_HIDDEN_LEGACY_PARAM_ITEMS,
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
    THREEJS_PHYSICAL_PARAM_ITEMS,
    THREEJS_HIDDEN_LEGACY_PARAM_ITEMS,
    p_end
);

static ParamBlockDesc2 threejs_sss_pb_desc(
    threejs_params,
    _T("ThreeJS SSS Parameters"),
    IDS_SSS_PARAMS,
    &threeJSSSSMtlDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_SSS_MTL, IDS_SSS_PARAMS, 0, 0, nullptr,
    THREEJS_COMMON_PARAM_ITEMS,
    THREEJS_HIDDEN_LEGACY_PARAM_ITEMS,
    THREEJS_SSS_PARAM_ITEMS,
    p_end
);

static ParamBlockDesc2 threejs_utility_pb_desc(
    threejs_params,
    _T("ThreeJS Utility Parameters"),
    IDS_UTILITY_PARAMS,
    &threeJSUtilityMtlDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_UTILITY_MTL, IDS_UTILITY_PARAMS, 0, 0, nullptr,
    THREEJS_UTILITY_PARAM_ITEMS,
    THREEJS_HIDDEN_LEGACY_PARAM_ITEMS,
    p_end
);
