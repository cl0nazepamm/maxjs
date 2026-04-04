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
    pb_opacity_map, pb_lightmap, pb_ao_map, pb_sss_color_map, pb_matcap_map,
    pb_specular_map
};

static const MCHAR* kMapSlotNames[kNumMaps] = {
    _T("Color Map"), _T("Roughness Map"), _T("Metalness Map"), _T("Normal Map"),
    _T("Bump Map"), _T("Displacement Map"), _T("Parallax Map"), _T("Emissive Map"),
    _T("Opacity Map"), _T("Light Map"), _T("AO Map"), _T("SSS Color Map"), _T("Matcap Map"),
    _T("Specular Map")
};

struct SupportedMapSlots {
    const int* slots = nullptr;
    int count = 0;
};

static const int kStandardMapSlots[] = {
    kMap_Color, kMap_Roughness, kMap_Metalness, kMap_Normal, kMap_Bump,
    kMap_Displacement, kMap_Emissive, kMap_Opacity, kMap_Lightmap, kMap_AO
};

static const int kSSSMapSlots[] = {
    kMap_Color, kMap_Roughness, kMap_Metalness, kMap_Normal, kMap_Bump,
    kMap_Displacement, kMap_Emissive, kMap_Opacity, kMap_Lightmap, kMap_AO,
    kMap_SSSColor
};

static const int kUtilityDistanceDepthMapSlots[] = {
    kMap_Color, kMap_Displacement, kMap_Opacity
};

static const int kUtilityLambertPhongMapSlots[] = {
    kMap_Color, kMap_Normal, kMap_Bump, kMap_Displacement,
    kMap_Emissive, kMap_Opacity, kMap_Lightmap, kMap_AO, kMap_Specular
};

static const int kUtilityMatcapMapSlots[] = {
    kMap_Color, kMap_Normal, kMap_Bump, kMap_Displacement, kMap_Opacity, kMap_Matcap
};

static const int kUtilityNormalMapSlots[] = {
    kMap_Normal, kMap_Bump, kMap_Displacement
};

static const int kUtilityBackdropMapSlots[] = {
    kMap_Color, kMap_Opacity
};

enum class ThreeJSMaterialKind {
    Physical,
    Utility,
    TSL,
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

static SupportedMapSlots GetSupportedMapSlots(ThreeJSMaterialKind kind, IParamBlock2* pb) {
    switch (kind) {
        case ThreeJSMaterialKind::Physical: {
            const int mode = GetOptionalInt(pb, pb_material_mode, 0, threejs_mode_standard);
            if (mode == threejs_mode_sss)
                return { kSSSMapSlots, static_cast<int>(std::size(kSSSMapSlots)) };
            return { kStandardMapSlots, static_cast<int>(std::size(kStandardMapSlots)) };
        }
        case ThreeJSMaterialKind::Utility: {
            const int utilityModel = GetOptionalInt(pb, pb_utility_model, 0, threejs_utility_lambert);
            switch (utilityModel) {
                case threejs_utility_depth:
                    return { kUtilityDistanceDepthMapSlots, static_cast<int>(std::size(kUtilityDistanceDepthMapSlots)) };
                case threejs_utility_matcap:
                    return { kUtilityMatcapMapSlots, static_cast<int>(std::size(kUtilityMatcapMapSlots)) };
                case threejs_utility_normal:
                    return { kUtilityNormalMapSlots, static_cast<int>(std::size(kUtilityNormalMapSlots)) };
                case threejs_utility_backdrop:
                    return { kUtilityBackdropMapSlots, static_cast<int>(std::size(kUtilityBackdropMapSlots)) };
                case threejs_utility_lambert:
                case threejs_utility_phong:
                default:
                    return { kUtilityLambertPhongMapSlots, static_cast<int>(std::size(kUtilityLambertPhongMapSlots)) };
            }
        }
        default:
            return {};
    }
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
            case ThreeJSMaterialKind::Utility: return THREEJS_UTILITY_MTL_CLASS_ID;
            case ThreeJSMaterialKind::TSL: return THREEJS_TSL_CLASS_ID;
            case ThreeJSMaterialKind::Physical:
            default: return THREEJS_ADV_MTL_CLASS_ID;
        }
    }
    SClass_ID SuperClassID() override { return MATERIAL_CLASS_ID; }
    void GetClassName(MSTR& s, bool localized) const override {
        switch (kind_) {
            case ThreeJSMaterialKind::Utility: s = _T("three.js Utility"); break;
            case ThreeJSMaterialKind::TSL: s = _T("three.js TSL"); break;
            case ThreeJSMaterialKind::Physical:
            default: s = _T("three.js"); break;
        }
    }

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle rtarg) override {
        if (i == 0) pblock = static_cast<IParamBlock2*>(rtarg);
    }

    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID& partID, RefMessage msg, BOOL) override {
        if (msg == REFMSG_CHANGE) {
            if ((kind_ == ThreeJSMaterialKind::Utility && partID == static_cast<PartID>(pb_utility_model)) ||
                (kind_ == ThreeJSMaterialKind::Physical && partID == static_cast<PartID>(pb_material_mode))) {
                NotifyDependents(FOREVER, PART_ALL, REFMSG_SUBANIM_STRUCTURE_CHANGED);
            }
        }
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

    int NumSubTexmaps() override {
        return GetSupportedMapSlots(kind_, pblock).count;
    }
    Texmap* GetSubTexmap(int i) override {
        if (!pblock) return nullptr;
        const int slotIndex = GetSupportedMapSlotIndex(i);
        if (slotIndex < 0) return nullptr;
        const ParamID pid = kMapParamIDs[slotIndex];
        return HasParam(pblock, pid) ? pblock->GetTexmap(pid) : nullptr;
    }
    void SetSubTexmap(int i, Texmap* m) override {
        if (!pblock) return;
        const int slotIndex = GetSupportedMapSlotIndex(i);
        if (slotIndex < 0) return;
        const ParamID pid = kMapParamIDs[slotIndex];
        if (HasParam(pblock, pid)) pblock->SetValue(pid, 0, m);
    }
    MSTR GetSubTexmapSlotName(int i, bool) override {
        const int slotIndex = GetSupportedMapSlotIndex(i);
        if (slotIndex >= 0) return MSTR(kMapSlotNames[slotIndex]);
        return MSTR(_T(""));
    }
    int MapSlotType(int) override { return MAPSLOT_TEXTURE; }

    // Sub-material support (TSL Source Material slot for MaterialX auto-compile)
    int NumSubMtls() override {
        return (kind_ == ThreeJSMaterialKind::TSL) ? 1 : 0;
    }
    Mtl* GetSubMtl(int i) override {
        if (kind_ != ThreeJSMaterialKind::TSL || i != 0 || !pblock) return nullptr;
        return HasParam(pblock, pb_tsl_source_mtl) ? pblock->GetMtl(pb_tsl_source_mtl) : nullptr;
    }
    void SetSubMtl(int i, Mtl* m) override {
        if (kind_ != ThreeJSMaterialKind::TSL || i != 0 || !pblock) return;
        if (HasParam(pblock, pb_tsl_source_mtl)) pblock->SetValue(pb_tsl_source_mtl, 0, m);
    }
    MSTR GetSubMtlSlotName(int i, bool) override {
        return (i == 0) ? MSTR(_T("Source Material")) : MSTR(_T(""));
    }

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
    int GetSupportedMapSlotIndex(int visibleIndex) const {
        const SupportedMapSlots visibleSlots = GetSupportedMapSlots(kind_, pblock);
        if (visibleIndex < 0 || visibleIndex >= visibleSlots.count || !visibleSlots.slots) {
            return -1;
        }
        return visibleSlots.slots[visibleIndex];
    }

    void DiscardTexHandle() {
        if (texHandle_) {
            texHandle_->DeleteThis();
            texHandle_ = nullptr;
        }
    }

    ClassDesc2* GetDescriptor() const {
        switch (kind_) {
            case ThreeJSMaterialKind::Utility: return GetThreeJSUtilityMtlDesc();
            case ThreeJSMaterialKind::TSL: return GetThreeJSTSLMtlDesc();
            case ThreeJSMaterialKind::Physical:
            default: return GetThreeJSAdvMtlDesc();
        }
    }

    bool texDisplayOn_ = false;
    TexHandle* texHandle_ = nullptr;
    ThreeJSMaterialKind kind_ = ThreeJSMaterialKind::Physical;
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
    ThreeJSMaterialKind kind_ = ThreeJSMaterialKind::Physical;
    Class_ID classID_;
    const TCHAR* className_ = nullptr;
    const TCHAR* internalName_ = nullptr;
};

static ThreeJSMtlClassDesc threeJSAdvMtlDesc(
    ThreeJSMaterialKind::Physical, THREEJS_ADV_MTL_CLASS_ID, _T("three.js"), _T("ThreeJSAdvMaterial"));
static ThreeJSMtlClassDesc threeJSUtilityMtlDesc(
    ThreeJSMaterialKind::Utility, THREEJS_UTILITY_MTL_CLASS_ID, _T("three.js Utility"), _T("ThreeJSUtilityMaterial"));
static ThreeJSMtlClassDesc threeJSTSLMtlDesc(
    ThreeJSMaterialKind::TSL, THREEJS_TSL_CLASS_ID, _T("three.js TSL"), _T("ThreeJSTSLMaterial"));

ClassDesc2* GetThreeJSAdvMtlDesc() { return &threeJSAdvMtlDesc; }
ClassDesc2* GetThreeJSUtilityMtlDesc() { return &threeJSUtilityMtlDesc; }
ClassDesc2* GetThreeJSTSLMtlDesc() { return &threeJSTSLMtlDesc; }

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

static void ShowUtilityControl(HWND hWnd, int controlID, bool visible) {
    if (HWND child = GetDlgItem(hWnd, controlID)) {
        ShowWindow(child, visible ? SW_SHOW : SW_HIDE);
        EnableWindow(child, visible ? TRUE : FALSE);
    }
}

static void SetUtilityControlText(HWND hWnd, int controlID, const wchar_t* text) {
    if (HWND child = GetDlgItem(hWnd, controlID)) {
        SetWindowTextW(child, text);
    }
}

static void SetUtilityModeSummary(HWND hWnd, int utilityModel) {
    const wchar_t* summary = L"Models: Depth / Lambert / Matcap / Normal / Phong / Backdrop";
    switch (utilityModel) {
        case threejs_utility_depth:
            summary = L"Depth: map, alpha, depth packing, displacement, and wireframe.";
            break;
        case threejs_utility_lambert:
            summary = L"Lambert: color, emissive, AO, relief, spec map, env blend, flat, wireframe, and fog.";
            break;
        case threejs_utility_matcap:
            summary = L"Matcap: color, matcap, normal space, relief, flat, wireframe, and fog.";
            break;
        case threejs_utility_normal:
            summary = L"Normal: opacity, normal-space controls, relief, flat, and wireframe.";
            break;
        case threejs_utility_phong:
            summary = L"Phong: Lambert plus specular color, shininess, and reflect/refract controls.";
            break;
        case threejs_utility_backdrop:
            summary = L"Backdrop: tint, opacity, backdrop FX mode, and blur amount.";
            break;
    }
    SetDlgItemTextW(hWnd, IDC_MTL_MODEL_LABEL, summary);
}

static void UpdateUtilityDialogUI(HWND hWnd, int utilityModel) {
    const bool isDistance = false; // Distance material removed
    const bool isDepth = utilityModel == threejs_utility_depth;
    const bool isLambert = utilityModel == threejs_utility_lambert;
    const bool isMatcap = utilityModel == threejs_utility_matcap;
    const bool isNormal = utilityModel == threejs_utility_normal;
    const bool isPhong = utilityModel == threejs_utility_phong;
    const bool isBackdrop = utilityModel == threejs_utility_backdrop;
    const bool showColorSwatch = isLambert || isMatcap || isPhong || isBackdrop;
    const bool showColorMap = isDistance || isDepth || isLambert || isMatcap || isPhong || isBackdrop;
    const bool showColorAmount = isBackdrop;
    const bool showOpacityMap = !isNormal;
    const bool showOpacityMapAmount = isBackdrop;
    const bool showNormalRow = isLambert || isMatcap || isNormal || isPhong;
    const bool showEmissionGroup = isLambert || isPhong;
    const bool showLightmapGroup = isLambert || isPhong;
    const bool showBumpRow = isLambert || isMatcap || isNormal || isPhong;
    const bool showDisplacementRow = !isBackdrop;
    const bool supportsNormalType = isLambert || isMatcap || isNormal || isPhong;
    const bool supportsReflect = isLambert || isPhong;
    const bool supportsFog = isLambert || isMatcap || isPhong;
    const bool supportsFlat = isLambert || isMatcap || isNormal || isPhong;
    const bool supportsWireframe = isDepth || isLambert || isMatcap || isNormal || isPhong;
    const bool showModeExtrasGroup = isDepth || isLambert || isMatcap || isNormal || isPhong || isBackdrop;
    const bool showReliefGroup = showBumpRow || showDisplacementRow;
    const bool showEnv = isLambert || isPhong;

    SetUtilityControlText(
        hWnd,
        IDC_UTILITY_COLOR_LABEL,
        isDistance || isDepth ? L"Map" : (isBackdrop ? L"Tint" : L"Color"));

    ShowUtilityControl(hWnd, IDC_UTILITY_GROUP_BASE, TRUE);
    ShowUtilityControl(hWnd, IDC_UTILITY_COLOR_LABEL, showColorMap || showColorSwatch);
    ShowUtilityControl(hWnd, IDC_COLOR, showColorSwatch);
    ShowUtilityControl(hWnd, IDC_COLOR_MAP, showColorMap);
    ShowUtilityControl(hWnd, IDC_UTILITY_MAPSTR_LABEL, showColorAmount);
    ShowUtilityControl(hWnd, IDC_MAPSTR_EDIT, showColorAmount);
    ShowUtilityControl(hWnd, IDC_MAPSTR_SPIN, showColorAmount);

    ShowUtilityControl(hWnd, IDC_UTILITY_OPACITY_LABEL, TRUE);
    ShowUtilityControl(hWnd, IDC_OPACITY_EDIT, TRUE);
    ShowUtilityControl(hWnd, IDC_OPACITY_SPIN, TRUE);
    ShowUtilityControl(hWnd, IDC_OPACITY_MAP, showOpacityMap);
    ShowUtilityControl(hWnd, IDC_UTILITY_OPMAPSTR_LABEL, showOpacityMapAmount);
    ShowUtilityControl(hWnd, IDC_OPMAPSTR_EDIT, showOpacityMapAmount);
    ShowUtilityControl(hWnd, IDC_OPMAPSTR_SPIN, showOpacityMapAmount);

    ShowUtilityControl(hWnd, IDC_UTILITY_NORMAL_LABEL, showNormalRow);
    ShowUtilityControl(hWnd, IDC_NORMAL_MAP, showNormalRow);
    ShowUtilityControl(hWnd, IDC_UTILITY_NORMSCL_LABEL, showNormalRow);
    ShowUtilityControl(hWnd, IDC_NORMSCL_EDIT, showNormalRow);
    ShowUtilityControl(hWnd, IDC_NORMSCL_SPIN, showNormalRow);

    ShowUtilityControl(hWnd, IDC_UTILITY_GROUP_EMISSION, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_EM_COLOR_LABEL, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_EM_COLOR, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_EM_MAP, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_EM_INT_LABEL, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_EM_INT_EDIT, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_EM_INT_SPIN, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_EMMAPSTR_LABEL, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_EMMAPSTR_EDIT, showEmissionGroup);
    ShowUtilityControl(hWnd, IDC_EMMAPSTR_SPIN, showEmissionGroup);

    ShowUtilityControl(hWnd, IDC_UTILITY_GROUP_MAPS, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_LM_LABEL, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_LM_MAP, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_LM_INT_LABEL, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_LM_INT_EDIT, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_LM_INT_SPIN, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_LM_CH_LABEL, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_LM_CH_EDIT, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_LM_CH_SPIN, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_AO_LABEL, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_AO_MAP, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_AO_INT_LABEL, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_AO_INT_EDIT, showLightmapGroup);
    ShowUtilityControl(hWnd, IDC_AO_INT_SPIN, showLightmapGroup);

    ShowUtilityControl(hWnd, IDC_UTILITY_GROUP_RELIEF, showReliefGroup);
    ShowUtilityControl(hWnd, IDC_UTILITY_BUMP_LABEL, showBumpRow);
    ShowUtilityControl(hWnd, IDC_BUMP_MAP, showBumpRow);
    ShowUtilityControl(hWnd, IDC_UTILITY_BUMP_SCALE_LABEL, showBumpRow);
    ShowUtilityControl(hWnd, IDC_BUMP_EDIT, showBumpRow);
    ShowUtilityControl(hWnd, IDC_BUMP_SPIN, showBumpRow);
    ShowUtilityControl(hWnd, IDC_UTILITY_DISP_LABEL, showDisplacementRow);
    ShowUtilityControl(hWnd, IDC_DISP_MAP, showDisplacementRow);
    ShowUtilityControl(hWnd, IDC_UTILITY_DISP_SCALE_LABEL, showDisplacementRow);
    ShowUtilityControl(hWnd, IDC_DISP_EDIT, showDisplacementRow);
    ShowUtilityControl(hWnd, IDC_DISP_SPIN, showDisplacementRow);
    ShowUtilityControl(hWnd, IDC_UTILITY_DISP_BIAS_LABEL, showDisplacementRow);
    ShowUtilityControl(hWnd, IDC_DISP_BIAS_EDIT, showDisplacementRow);
    ShowUtilityControl(hWnd, IDC_DISP_BIAS_SPIN, showDisplacementRow);

    ShowUtilityControl(hWnd, IDC_UTILITY_FX_LABEL, isBackdrop);
    ShowUtilityControl(hWnd, IDC_UTILITY_BACKDROP_MODE, isBackdrop);

    ShowUtilityControl(hWnd, IDC_UTILITY_GROUP_EXTRAS, showModeExtrasGroup);

    ShowUtilityControl(hWnd, IDC_UTILITY_MATCAP_LABEL, isMatcap);
    ShowUtilityControl(hWnd, IDC_UTILITY_MATCAP_MAP, isMatcap);

    ShowUtilityControl(hWnd, IDC_UTILITY_SPECMAP_LABEL, supportsReflect);
    ShowUtilityControl(hWnd, IDC_UTILITY_SPECMAP, supportsReflect);

    ShowUtilityControl(hWnd, IDC_UTILITY_SPECULAR_LABEL, isPhong);
    ShowUtilityControl(hWnd, IDC_UTILITY_SPECULAR, isPhong);
    ShowUtilityControl(hWnd, IDC_UTILITY_SHINE_LABEL, isPhong);
    ShowUtilityControl(hWnd, IDC_UTILITY_SHINE_EDIT, isPhong);
    ShowUtilityControl(hWnd, IDC_UTILITY_SHINE_SPIN, isPhong);

    ShowUtilityControl(hWnd, IDC_UTILITY_COMBINE_LABEL, supportsReflect);
    ShowUtilityControl(hWnd, IDC_UTILITY_COMBINE, supportsReflect);
    ShowUtilityControl(hWnd, IDC_UTILITY_REFLECT_LABEL, supportsReflect);
    ShowUtilityControl(hWnd, IDC_UTILITY_REFLECT_EDIT, supportsReflect);
    ShowUtilityControl(hWnd, IDC_UTILITY_REFLECT_SPIN, supportsReflect);
    ShowUtilityControl(hWnd, IDC_UTILITY_REFRACT_LABEL, supportsReflect);
    ShowUtilityControl(hWnd, IDC_UTILITY_REFRACT_EDIT, supportsReflect);
    ShowUtilityControl(hWnd, IDC_UTILITY_REFRACT_SPIN, supportsReflect);

    ShowUtilityControl(hWnd, IDC_UTILITY_NORMAL_TYPE_LABEL, supportsNormalType);
    ShowUtilityControl(hWnd, IDC_UTILITY_NORMAL_TYPE, supportsNormalType);

    ShowUtilityControl(hWnd, IDC_UTILITY_DEPTH_PACK_LABEL, isDepth);
    ShowUtilityControl(hWnd, IDC_UTILITY_DEPTH_PACK, isDepth);

    ShowUtilityControl(hWnd, IDC_UTILITY_BLUR_LABEL, isBackdrop);
    ShowUtilityControl(hWnd, IDC_UTILITY_BLUR_EDIT, isBackdrop);
    ShowUtilityControl(hWnd, IDC_UTILITY_BLUR_SPIN, isBackdrop);

    ShowUtilityControl(hWnd, IDC_UTILITY_FLAT, supportsFlat);
    ShowUtilityControl(hWnd, IDC_UTILITY_WIREFRAME, supportsWireframe);
    ShowUtilityControl(hWnd, IDC_UTILITY_FOG, supportsFog);

    ShowUtilityControl(hWnd, IDC_UTILITY_GROUP_OPTIONS, TRUE);
    ShowUtilityControl(hWnd, IDC_DOUBLE_SIDED, TRUE);
    ShowUtilityControl(hWnd, IDC_UTILITY_ENV_LABEL, showEnv);
    ShowUtilityControl(hWnd, IDC_ENV_INT_EDIT, showEnv);
    ShowUtilityControl(hWnd, IDC_ENV_INT_SPIN, showEnv);

    SetUtilityModeSummary(hWnd, utilityModel);
}

class ThreeJSUtilityDlgProc : public ParamMap2UserDlgProc {
public:
    INT_PTR DlgProc(TimeValue, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM) override {
        IParamBlock2* pb = map ? map->GetParamBlock() : nullptr;
        auto refresh = [&]() {
            const int utilityModel = pb ? GetOptionalInt(pb, pb_utility_model, 0, threejs_utility_lambert) : threejs_utility_lambert;
            UpdateUtilityDialogUI(hWnd, utilityModel);
        };

        switch (msg) {
            case WM_INITDIALOG:
                refresh();
                return TRUE;
            case WM_COMMAND:
                if (LOWORD(wParam) == IDC_UTILITY_MODE && HIWORD(wParam) == CBN_SELCHANGE) {
                    refresh();
                    return TRUE;
                }
                break;
        }
        return FALSE;
    }

    void DeleteThis() override {}
};

static ThreeJSUtilityDlgProc utilityDlgProc;

#define THREEJS_UTILITY_PARAM_ITEMS \
    pb_utility_model, _T("utilityModel"), TYPE_INT, 0, 0, \
        p_default, threejs_utility_lambert, \
        p_ui, TYPE_INT_COMBOBOX, IDC_UTILITY_MODE, 6, \
            IDS_UTILITY_MODE_DEPTH, IDS_UTILITY_MODE_LAMBERT, \
            IDS_UTILITY_MODE_MATCAP, IDS_UTILITY_MODE_NORMAL, IDS_UTILITY_MODE_PHONG, \
            IDS_UTILITY_MODE_BACKDROP, \
        p_vals, threejs_utility_depth, threejs_utility_lambert, \
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
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_UTILITY_BLUR_EDIT, IDC_UTILITY_BLUR_SPIN, 0.01f, \
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
    pb_specular_map, _T("specularMap"), TYPE_TEXMAP, 0, 0, \
        p_subtexno, kMap_Specular, \
        p_ui, TYPE_TEXMAPBUTTON, IDC_UTILITY_SPECMAP, \
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
    pb_reflectivity, _T("reflectivity"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 1.0f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_UTILITY_REFLECT_EDIT, IDC_UTILITY_REFLECT_SPIN, 0.01f, \
        p_end, \
    pb_refraction_ratio, _T("refractionRatio"), TYPE_FLOAT, P_ANIMATABLE, 0, \
        p_default, 0.98f, \
        p_range, 0.0f, 1.0f, \
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_UTILITY_REFRACT_EDIT, IDC_UTILITY_REFRACT_SPIN, 0.01f, \
        p_end, \
    pb_normal_map_type, _T("normalMapType"), TYPE_INT, 0, 0, \
        p_default, threejs_utility_normal_tangent, \
        p_ui, TYPE_INT_COMBOBOX, IDC_UTILITY_NORMAL_TYPE, 2, \
            IDS_UTILITY_NORMAL_TANGENT, IDS_UTILITY_NORMAL_OBJECT, \
        p_vals, threejs_utility_normal_tangent, threejs_utility_normal_object, \
        p_end, \
    pb_depth_packing, _T("depthPacking"), TYPE_INT, 0, 0, \
        p_default, threejs_utility_depth_packing_basic, \
        p_ui, TYPE_INT_COMBOBOX, IDC_UTILITY_DEPTH_PACK, 4, \
            IDS_UTILITY_DEPTH_PACK_BASIC, IDS_UTILITY_DEPTH_PACK_RGBA, IDS_UTILITY_DEPTH_PACK_RGB, IDS_UTILITY_DEPTH_PACK_RG, \
        p_vals, threejs_utility_depth_packing_basic, threejs_utility_depth_packing_rgba, threejs_utility_depth_packing_rgb, threejs_utility_depth_packing_rg, \
        p_end, \
    pb_fog, _T("fog"), TYPE_BOOL, 0, 0, \
        p_default, TRUE, \
        p_ui, TYPE_SINGLECHEKBOX, IDC_UTILITY_FOG, \
        p_end, \
    pb_combine, _T("combine"), TYPE_INT, 0, 0, \
        p_default, threejs_utility_combine_multiply, \
        p_ui, TYPE_INT_COMBOBOX, IDC_UTILITY_COMBINE, 3, \
            IDS_UTILITY_COMBINE_MULTIPLY, IDS_UTILITY_COMBINE_MIX, IDS_UTILITY_COMBINE_ADD, \
        p_vals, threejs_utility_combine_multiply, threejs_utility_combine_mix, threejs_utility_combine_add, \
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

static ParamBlockDesc2 threejs_adv_pb_desc(
    threejs_params,
    _T("three.js Parameters"),
    IDS_ADV_PARAMS,
    &threeJSAdvMtlDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_ADV_MTL, IDS_ADV_PARAMS, 0, 0, nullptr,
    pb_material_mode, _T("materialMode"), TYPE_INT, 0, 0,
        p_default, threejs_mode_standard,
        p_ui, TYPE_INT_COMBOBOX, IDC_MATERIAL_MODE, 3,
            IDS_MATERIAL_MODE_STANDARD, IDS_MATERIAL_MODE_PHYSICAL, IDS_MATERIAL_MODE_SSS,
        p_vals, threejs_mode_standard, threejs_mode_physical, threejs_mode_sss,
        p_end,
    THREEJS_COMMON_PARAM_ITEMS,
    THREEJS_PHYSICAL_PARAM_ITEMS,
    THREEJS_SSS_PARAM_ITEMS,
    THREEJS_HIDDEN_LEGACY_PARAM_ITEMS,
    p_end
);

static ParamBlockDesc2 threejs_utility_pb_desc(
    threejs_params,
    _T("three.js Utility Parameters"),
    IDS_UTILITY_PARAMS,
    &threeJSUtilityMtlDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_UTILITY_MTL, IDS_UTILITY_PARAMS, 0, 0, &utilityDlgProc,
    THREEJS_UTILITY_PARAM_ITEMS,
    THREEJS_HIDDEN_LEGACY_PARAM_ITEMS,
    p_end
);

// ── TSL Material DlgProc ────────────────────────────────────
class ThreeJSTSLDlgProc : public ParamMap2UserDlgProc {
public:
    INT_PTR DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) override {
        IParamBlock2* pb = map ? map->GetParamBlock() : nullptr;
        switch (msg) {
        case WM_INITDIALOG: {
            if (pb) {
                const MCHAR* code = pb->GetStr(pb_tsl_code);
                if (code && code[0]) SetDlgItemText(hWnd, IDC_TSL_CODE_EDIT, code);
            }
            return TRUE;
        }
        case WM_COMMAND:
            if (LOWORD(wParam) == IDC_TSL_LOAD_BTN && HIWORD(wParam) == BN_CLICKED) {
                OPENFILENAME ofn = {};
                wchar_t filePath[MAX_PATH] = {};
                ofn.lStructSize = sizeof(ofn);
                ofn.hwndOwner = hWnd;
                ofn.lpstrFilter = L"TSL Files (*.tsl;*.js)\0*.tsl;*.js\0All Files (*.*)\0*.*\0";
                ofn.lpstrFile = filePath;
                ofn.nMaxFile = MAX_PATH;
                ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
                if (GetOpenFileName(&ofn)) {
                    // Read file
                    HANDLE hFile = CreateFileW(filePath, GENERIC_READ, FILE_SHARE_READ, nullptr,
                        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
                    if (hFile != INVALID_HANDLE_VALUE) {
                        DWORD sz = GetFileSize(hFile, nullptr);
                        if (sz > 0 && sz != INVALID_FILE_SIZE) {
                            std::string buf(sz, '\0');
                            DWORD bytesRead = 0;
                            ReadFile(hFile, buf.data(), sz, &bytesRead, nullptr);
                            buf.resize(bytesRead);
                            // Convert UTF-8 to wide
                            int wLen = MultiByteToWideChar(CP_UTF8, 0, buf.data(), (int)buf.size(), nullptr, 0);
                            std::wstring wCode(wLen, L'\0');
                            MultiByteToWideChar(CP_UTF8, 0, buf.data(), (int)buf.size(), wCode.data(), wLen);
                            // Set code in edit + PB
                            SetDlgItemText(hWnd, IDC_TSL_CODE_EDIT, wCode.c_str());
                            if (pb) pb->SetValue(pb_tsl_code, 0, wCode.c_str());
                            // Show filename in label
                            const wchar_t* fname = wcsrchr(filePath, L'\\');
                            SetDlgItemText(hWnd, IDC_TSL_FILE_LABEL, fname ? fname + 1 : filePath);
                        }
                        CloseHandle(hFile);
                    }
                }
                return TRUE;
            }
            if (LOWORD(wParam) == IDC_TSL_CODE_EDIT && HIWORD(wParam) == EN_CHANGE) {
                int len = GetWindowTextLength(GetDlgItem(hWnd, IDC_TSL_CODE_EDIT));
                std::wstring text(static_cast<size_t>(len) + 1, L'\0');
                int copied = GetDlgItemText(hWnd, IDC_TSL_CODE_EDIT, text.data(), len + 1);
                if (copied >= 0) {
                    text.resize(static_cast<size_t>(copied));
                } else {
                    text.clear();
                }
                if (pb) pb->SetValue(pb_tsl_code, 0, text.c_str());
                return TRUE;
            }
            break;
        }
        return FALSE;
    }
    void DeleteThis() override {}
};

static ThreeJSTSLDlgProc tslDlgProc;

static ParamBlockDesc2 threejs_tsl_pb_desc(
    threejs_params,
    _T("three.js TSL Parameters"),
    IDS_TSL_PARAMS,
    &threeJSTSLMtlDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_TSL_MTL, IDS_TSL_PARAMS, 0, 0, &tslDlgProc,
    pb_tsl_code, _T("tslCode"), TYPE_STRING, 0, 0,
        p_end,
    pb_tsl_source_mtl, _T("sourceMaterial"), TYPE_MTL, 0, 0,
        p_end,
    p_end
);

// ══════════════════════════════════════════════════════════════
//  three.js Video Texture — Texmap for video files in material slots
// ══════════════════════════════════════════════════════════════

class ThreeJSVideoTex : public Texmap {
public:
    IParamBlock2* pblock = nullptr;

    ThreeJSVideoTex(BOOL /*loading*/) {
        GetThreeJSVideoTexDesc()->MakeAutoParamBlocks(this);
    }
    ~ThreeJSVideoTex() override = default;

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_VIDEO_TEX_CLASS_ID; }
    SClass_ID SuperClassID() override { return TEXMAP_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("three.js Video"); }

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle r) override { if (i == 0) pblock = static_cast<IParamBlock2*>(r); }
    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID&, RefMessage, BOOL) override { return REF_SUCCEED; }

    RefTargetHandle Clone(RemapDir& remap) override {
        auto* c = new ThreeJSVideoTex(FALSE);
        *static_cast<MtlBase*>(c) = *static_cast<MtlBase*>(this);
        BaseClone(this, c, remap);
        c->ReplaceReference(0, remap.CloneRef(pblock));
        return c;
    }

    int NumSubTexmaps() override { return 0; }
    Texmap* GetSubTexmap(int) override { return nullptr; }
    void SetSubTexmap(int, Texmap*) override {}

    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override { return id == threejs_video_params ? pblock : nullptr; }

    ParamDlg* CreateParamDlg(HWND hwMtlEdit, IMtlParams* imp) override {
        return GetThreeJSVideoTexDesc()->CreateParamDlgs(hwMtlEdit, imp, this);
    }

    void Update(TimeValue, Interval& valid) override { valid = FOREVER; }
    Interval Validity(TimeValue) override { return FOREVER; }
    void Reset() override { GetThreeJSVideoTexDesc()->MakeAutoParamBlocks(this); }

    AColor EvalColor(ShadeContext&) override { return AColor(0.5f, 0.5f, 0.5f, 1.0f); }
    float EvalMono(ShadeContext& sc) override { return Intens(EvalColor(sc)); }
    Point3 EvalNormalPerturb(ShadeContext&) override { return Point3(0, 0, 0); }

    IOResult Save(ISave* isave) override { return Texmap::Save(isave); }
    IOResult Load(ILoad* iload) override { return Texmap::Load(iload); }
};

class ThreeJSVideoTexClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override { return new ThreeJSVideoTex(loading); }
    const TCHAR* ClassName() override { return _T("three.js Video"); }
    const TCHAR* NonLocalizedClassName() override { return _T("three.js Video"); }
    SClass_ID SuperClassID() override { return TEXMAP_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_VIDEO_TEX_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSVideoTexture"); }
    HINSTANCE HInstance() override { return hInstance; }
};

static ThreeJSVideoTexClassDesc videoTexDesc;

class ThreeJSVideoDlgProc : public ParamMap2UserDlgProc {
public:
    INT_PTR DlgProc(TimeValue, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM) override {
        IParamBlock2* pb = map ? map->GetParamBlock() : nullptr;
        switch (msg) {
        case WM_INITDIALOG: {
            if (pb) {
                const MCHAR* fn = pb->GetStr(pvid_filename);
                if (fn && fn[0]) {
                    const wchar_t* name = wcsrchr(fn, L'\\');
                    SetDlgItemText(hWnd, IDC_VIDEO_FILE_LABEL, name ? name + 1 : fn);
                    SetDlgItemText(hWnd, IDC_VIDEO_FILE_BTN, name ? name + 1 : fn);
                }
            }
            return TRUE;
        }
        case WM_COMMAND:
            if (LOWORD(wParam) == IDC_VIDEO_FILE_BTN) {
                OPENFILENAME ofn = {};
                wchar_t filePath[MAX_PATH] = {};
                ofn.lStructSize = sizeof(ofn);
                ofn.hwndOwner = hWnd;
                ofn.lpstrFilter = L"Video Files (*.mp4;*.webm;*.ogg)\0*.mp4;*.webm;*.ogg\0All Files (*.*)\0*.*\0";
                ofn.lpstrFile = filePath;
                ofn.nMaxFile = MAX_PATH;
                ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
                if (GetOpenFileName(&ofn) && pb) {
                    pb->SetValue(pvid_filename, 0, filePath);
                    const wchar_t* name = wcsrchr(filePath, L'\\');
                    SetDlgItemText(hWnd, IDC_VIDEO_FILE_LABEL, name ? name + 1 : filePath);
                    SetDlgItemText(hWnd, IDC_VIDEO_FILE_BTN, name ? name + 1 : filePath);
                }
                return TRUE;
            }
            break;
        }
        return FALSE;
    }
    void DeleteThis() override {}
};

static ThreeJSVideoDlgProc videoDlgProc;

static ParamBlockDesc2 threejs_video_pb_desc(
    threejs_video_params,
    _T("three.js Video Params"),
    IDS_VIDEO_TEX_PARAMS,
    &videoTexDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_VIDEO_TEX, IDS_VIDEO_TEX_PARAMS, 0, 0, &videoDlgProc,

    pvid_filename, _T("filename"), TYPE_FILENAME, 0, 0,
        p_end,

    pvid_loop, _T("loop"), TYPE_BOOL, 0, 0,
        p_default, TRUE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_VIDEO_LOOP,
        p_end,

    pvid_muted, _T("muted"), TYPE_BOOL, 0, 0,
        p_default, TRUE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_VIDEO_MUTED,
        p_end,

    pvid_rate, _T("playbackRate"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.1f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_VIDEO_RATE_EDIT, IDC_VIDEO_RATE_SPIN, 0.1f,
        p_end,

    p_end
);

ClassDesc2* GetThreeJSVideoTexDesc() { return &videoTexDesc; }
