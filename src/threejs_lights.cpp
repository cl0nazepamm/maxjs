#include "threejs_lights.h"
#include "threejs_lights_res.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <simpobj.h>
#include <plugapi.h>
#include <maxapi.h>
#include <object.h>

extern HINSTANCE hInstance;

namespace {

struct LightClassSpec {
    Class_ID classId;
    ThreeJSLightType type;
    const TCHAR* className;
    const TCHAR* internalName;
    const TCHAR* nodePrefix;
    int titleStringId;
    int dialogId;
    bool isPublic;
    bool usesTypeParam;
};

ThreeJSLightType ClampLightType(int rawType) {
    if (rawType < 0 || rawType >= kLight_COUNT) return kLight_Directional;
    return static_cast<ThreeJSLightType>(rawType);
}

const TCHAR* GetLightTypeLabel(ThreeJSLightType type) {
    switch (type) {
        case kLight_Directional: return _T("Directional");
        case kLight_Point: return _T("Point");
        case kLight_Spot: return _T("Spot");
        case kLight_RectArea: return _T("RectArea");
        case kLight_Hemisphere: return _T("Hemisphere");
        case kLight_Ambient: return _T("Ambient");
        default: return _T("Directional");
    }
}

bool LightTypeUsesDistance(ThreeJSLightType type) {
    return type == kLight_Point || type == kLight_Spot;
}

bool LightTypeUsesSpotCone(ThreeJSLightType type) {
    return type == kLight_Spot;
}

bool LightTypeUsesAreaSize(ThreeJSLightType type) {
    return type == kLight_RectArea;
}

bool LightTypeUsesGroundColor(ThreeJSLightType type) {
    return type == kLight_Hemisphere;
}

bool LightTypeSupportsShadows(ThreeJSLightType type) {
    return type == kLight_Directional || type == kLight_Point || type == kLight_Spot;
}

int GetMaxLightEvalType(ThreeJSLightType type) {
    switch (type) {
        case kLight_Directional: return DIRECT_LGT;
        case kLight_Point: return OMNI_LGT;
        case kLight_Spot: return SPOT_LGT;
        case kLight_RectArea: return OMNI_LGT;
        case kLight_Hemisphere: return DIRECT_LGT;
        case kLight_Ambient: return AMBIENT_LGT;
        default: return DIRECT_LGT;
    }
}

float GetDisplayExtent(IParamBlock2* pblock, ThreeJSLightType type) {
    switch (type) {
        case kLight_RectArea: {
            const float w = pblock ? pblock->GetFloat(pl_width) * 0.5f : 20.0f;
            const float h = pblock ? pblock->GetFloat(pl_height) * 0.5f : 20.0f;
            const float halfExtent = (w > h) ? w : h;
            return (halfExtent > 10.0f ? halfExtent : 10.0f) + 20.0f;
        }
        case kLight_Spot: return 42.0f;
        case kLight_Directional: return 36.0f;
        case kLight_Hemisphere: return 24.0f;
        case kLight_Ambient: return 18.0f;
        case kLight_Point:
        default:
            return 16.0f;
    }
}

const LightClassSpec kLegacyLightSpec = {
    THREEJS_LIGHT_LEGACY_CLASS_ID, kLight_Directional,
    _T("ThreeJS Light"), _T("ThreeJSLight"), _T("TJS_Light"),
    IDS_LIGHT_PARAMS_LEGACY, IDD_THREEJS_LIGHT_LEGACY, false, true
};

const LightClassSpec kDirectionalLightSpec = {
    THREEJS_DIRECTIONAL_LIGHT_CLASS_ID, kLight_Directional,
    _T("ThreeJS Directional Light"), _T("ThreeJSDirectionalLight"), _T("TJS_Directional"),
    IDS_DIRECTIONAL_LIGHT_PARAMS, IDD_THREEJS_DIRECTIONAL_LIGHT, true, false
};

const LightClassSpec kPointLightSpec = {
    THREEJS_POINT_LIGHT_CLASS_ID, kLight_Point,
    _T("ThreeJS Point Light"), _T("ThreeJSPointLight"), _T("TJS_Point"),
    IDS_POINT_LIGHT_PARAMS, IDD_THREEJS_POINT_LIGHT, true, false
};

const LightClassSpec kSpotLightSpec = {
    THREEJS_SPOT_LIGHT_CLASS_ID, kLight_Spot,
    _T("ThreeJS Spot Light"), _T("ThreeJSSpotLight"), _T("TJS_Spot"),
    IDS_SPOT_LIGHT_PARAMS, IDD_THREEJS_SPOT_LIGHT, true, false
};

const LightClassSpec kRectAreaLightSpec = {
    THREEJS_RECT_AREA_LIGHT_CLASS_ID, kLight_RectArea,
    _T("ThreeJS Rect Area Light"), _T("ThreeJSRectAreaLight"), _T("TJS_RectArea"),
    IDS_RECT_AREA_LIGHT_PARAMS, IDD_THREEJS_RECT_AREA_LIGHT, true, false
};

const LightClassSpec kHemisphereLightSpec = {
    THREEJS_HEMISPHERE_LIGHT_CLASS_ID, kLight_Hemisphere,
    _T("ThreeJS Hemisphere Light"), _T("ThreeJSHemisphereLight"), _T("TJS_Hemisphere"),
    IDS_HEMISPHERE_LIGHT_PARAMS, IDD_THREEJS_HEMISPHERE_LIGHT, true, false
};

const LightClassSpec kAmbientLightSpec = {
    THREEJS_AMBIENT_LIGHT_CLASS_ID, kLight_Ambient,
    _T("ThreeJS Ambient Light"), _T("ThreeJSAmbientLight"), _T("TJS_Ambient"),
    IDS_AMBIENT_LIGHT_PARAMS, IDD_THREEJS_AMBIENT_LIGHT, true, false
};

const LightClassSpec* FindLightClassSpec(const Class_ID& cid) {
    static const LightClassSpec* kSpecs[] = {
        &kLegacyLightSpec,
        &kDirectionalLightSpec,
        &kPointLightSpec,
        &kSpotLightSpec,
        &kRectAreaLightSpec,
        &kHemisphereLightSpec,
        &kAmbientLightSpec
    };

    for (const LightClassSpec* spec : kSpecs) {
        if (spec->classId == cid) return spec;
    }

    return nullptr;
}

class ThreeJSLight;

class ThreeJSLightClassDesc : public ClassDesc2 {
public:
    explicit ThreeJSLightClassDesc(const LightClassSpec* spec) : spec_(spec) {}

    int IsPublic() override { return spec_->isPublic ? TRUE : FALSE; }
    void* Create(BOOL) override;
    const TCHAR* ClassName() override { return spec_->className; }
    const TCHAR* NonLocalizedClassName() override { return spec_->className; }
    SClass_ID SuperClassID() override { return LIGHT_CLASS_ID; }
    Class_ID ClassID() override { return spec_->classId; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return spec_->internalName; }
    HINSTANCE HInstance() override { return hInstance; }

private:
    const LightClassSpec* spec_;
};

class ThreeJSLight : public LightObject {
public:
    ThreeJSLight(const LightClassSpec* spec, ClassDesc2* descriptor)
        : spec_(spec), descriptor_(descriptor) {
        descriptor_->MakeAutoParamBlocks(this);
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return spec_->classId; }
    SClass_ID SuperClassID() override { return LIGHT_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = spec_->className; }

    RefResult EvalLightState(TimeValue t, Interval& valid, LightState* ls) override;
    void SetUseLight(int onOff) override { useLight_ = (onOff != 0); }
    BOOL GetUseLight() override { return useLight_ ? TRUE : FALSE; }
    void SetHotspot(TimeValue t, float f) override;
    float GetHotspot(TimeValue t, Interval& valid) override;
    void SetFallsize(TimeValue t, float f) override;
    float GetFallsize(TimeValue t, Interval& valid) override;
    void SetAtten(TimeValue t, int which, float f) override;
    float GetAtten(TimeValue t, int which, Interval& valid) override;
    void SetTDist(TimeValue, float) override {}
    float GetTDist(TimeValue, Interval& valid) override { valid = FOREVER; return 100.0f; }
    void SetConeDisplay(int show, int = TRUE) override { coneDisplay_ = (show != 0); }
    BOOL GetConeDisplay() override { return coneDisplay_ ? TRUE : FALSE; }
    void SetRGBColor(TimeValue t, const Point3& rgb) override;
    Point3 GetRGBColor(TimeValue t, Interval& valid) override;
    void SetIntensity(TimeValue t, float f) override;
    float GetIntensity(TimeValue t, Interval& valid) override;

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle rtarg) override;
    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID&, RefMessage, BOOL) override { return REF_SUCCEED; }
    RefTargetHandle Clone(RemapDir& remap) override;

    ObjectState Eval(TimeValue) override { return ObjectState(this); }
    void InitNodeName(MSTR& s) override;
    int IsRenderable() override { return 0; }
    int UsesWireColor() override { return 1; }

    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override { return id == threejs_light_params ? pblock : nullptr; }
    void BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) override;
    void EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) override;

    void GetWorldBoundBox(TimeValue t, INode* node, ViewExp*, Box3& box) override;
    void GetLocalBoundBox(TimeValue, INode*, ViewExp*, Box3& box) override;
    int Display(TimeValue t, INode* node, ViewExp* vpt, int flags) override;
    int HitTest(TimeValue t, INode* node, int type, int crossing, int flags, IPoint2* p, ViewExp* vpt) override;

    CreateMouseCallBack* GetCreateMouseCallBack() override;

private:
    ThreeJSLightType GetLightType() const;
    void GetLocalBounds(Box3& box) const;
    void DrawLightWire(GraphicsWindow* gw) const;

private:
    IParamBlock2* pblock = nullptr;
    const LightClassSpec* spec_ = nullptr;
    ClassDesc2* descriptor_ = nullptr;
    bool useLight_ = true;
    bool coneDisplay_ = false;
};

class ThreeJSLightCreateCB : public CreateMouseCallBack {
public:
    int proc(ViewExp* vpt, int msg, int point, int, IPoint2 m, Matrix3& mat) override;
};

static ThreeJSLightCreateCB g_lightCreateCB;
static ThreeJSLightClassDesc g_legacyLightDesc(&kLegacyLightSpec);
static ThreeJSLightClassDesc g_directionalLightDesc(&kDirectionalLightSpec);
static ThreeJSLightClassDesc g_pointLightDesc(&kPointLightSpec);
static ThreeJSLightClassDesc g_spotLightDesc(&kSpotLightSpec);
static ThreeJSLightClassDesc g_rectAreaLightDesc(&kRectAreaLightSpec);
static ThreeJSLightClassDesc g_hemisphereLightDesc(&kHemisphereLightSpec);
static ThreeJSLightClassDesc g_ambientLightDesc(&kAmbientLightSpec);

void* ThreeJSLightClassDesc::Create(BOOL) {
    return new ThreeJSLight(spec_, this);
}

RefResult ThreeJSLight::EvalLightState(TimeValue t, Interval& valid, LightState* ls) {
    if (!ls) return REF_SUCCEED;

    const ThreeJSLightType type = GetLightType();
    ls->color = pblock ? pblock->GetColor(pl_color, t) : Color(1.0f, 1.0f, 1.0f);
    ls->intens = pblock ? pblock->GetFloat(pl_intensity, t) : 1.0f;
    ls->on = useLight_ ? TRUE : FALSE;
    ls->type = static_cast<LightType>(GetMaxLightEvalType(type));
    valid = FOREVER;
    return REF_SUCCEED;
}

void ThreeJSLight::SetHotspot(TimeValue t, float f) {
    if (pblock && LightTypeUsesSpotCone(GetLightType())) pblock->SetValue(pl_angle, t, f);
}

float ThreeJSLight::GetHotspot(TimeValue t, Interval& valid) {
    valid = FOREVER;
    return (pblock && LightTypeUsesSpotCone(GetLightType())) ? pblock->GetFloat(pl_angle, t) : 60.0f;
}

void ThreeJSLight::SetFallsize(TimeValue t, float f) {
    if (pblock && LightTypeUsesSpotCone(GetLightType())) pblock->SetValue(pl_angle, t, f);
}

float ThreeJSLight::GetFallsize(TimeValue t, Interval& valid) {
    valid = FOREVER;
    return (pblock && LightTypeUsesSpotCone(GetLightType())) ? pblock->GetFloat(pl_angle, t) : 60.0f;
}

void ThreeJSLight::SetAtten(TimeValue t, int which, float f) {
    if (pblock && which == ATTEN_END && LightTypeUsesDistance(GetLightType())) {
        pblock->SetValue(pl_distance, t, f);
    }
}

float ThreeJSLight::GetAtten(TimeValue t, int which, Interval& valid) {
    valid = FOREVER;
    return (pblock && which == ATTEN_END && LightTypeUsesDistance(GetLightType()))
        ? pblock->GetFloat(pl_distance, t)
        : 0.0f;
}

void ThreeJSLight::SetRGBColor(TimeValue t, const Point3& rgb) {
    if (pblock) pblock->SetValue(pl_color, t, Color(rgb.x, rgb.y, rgb.z));
}

Point3 ThreeJSLight::GetRGBColor(TimeValue t, Interval& valid) {
    valid = FOREVER;
    const Color color = pblock ? pblock->GetColor(pl_color, t) : Color(1.0f, 1.0f, 1.0f);
    return Point3(color.r, color.g, color.b);
}

void ThreeJSLight::SetIntensity(TimeValue t, float f) {
    if (pblock) pblock->SetValue(pl_intensity, t, f);
}

float ThreeJSLight::GetIntensity(TimeValue t, Interval& valid) {
    valid = FOREVER;
    return pblock ? pblock->GetFloat(pl_intensity, t) : 1.0f;
}

void ThreeJSLight::SetReference(int i, RefTargetHandle rtarg) {
    if (i == 0) pblock = static_cast<IParamBlock2*>(rtarg);
}

RefTargetHandle ThreeJSLight::Clone(RemapDir& remap) {
    ThreeJSLight* copy = new ThreeJSLight(spec_, descriptor_);
    copy->useLight_ = useLight_;
    copy->coneDisplay_ = coneDisplay_;
    BaseClone(this, copy, remap);
    copy->ReplaceReference(0, remap.CloneRef(pblock));
    return copy;
}

void ThreeJSLight::InitNodeName(MSTR& s) {
    if (spec_->usesTypeParam) s = MSTR(_T("TJS_")) + MSTR(GetLightTypeLabel(GetLightType()));
    else s = spec_->nodePrefix;
}

void ThreeJSLight::BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) {
    descriptor_->BeginEditParams(ip, this, flags, prev);
}

void ThreeJSLight::EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) {
    descriptor_->EndEditParams(ip, this, flags, next);
}

ThreeJSLightType ThreeJSLight::GetLightType() const {
    if (spec_->usesTypeParam && pblock) return ClampLightType(pblock->GetInt(pl_type));
    return spec_->type;
}

void ThreeJSLight::GetLocalBounds(Box3& box) const {
    const float extent = GetDisplayExtent(pblock, GetLightType());
    box.Init();
    box += Point3(-extent, -extent, -extent);
    box += Point3(extent, extent, extent);
}

void ThreeJSLight::GetWorldBoundBox(TimeValue t, INode* node, ViewExp*, Box3& box) {
    Matrix3 tm = node->GetObjectTM(t);
    Box3 localBox;
    GetLocalBounds(localBox);
    box.Init();
    const Point3 pmin = localBox.pmin;
    const Point3 pmax = localBox.pmax;
    const Point3 corners[8] = {
        Point3(pmin.x, pmin.y, pmin.z),
        Point3(pmax.x, pmin.y, pmin.z),
        Point3(pmin.x, pmax.y, pmin.z),
        Point3(pmax.x, pmax.y, pmin.z),
        Point3(pmin.x, pmin.y, pmax.z),
        Point3(pmax.x, pmin.y, pmax.z),
        Point3(pmin.x, pmax.y, pmax.z),
        Point3(pmax.x, pmax.y, pmax.z)
    };
    for (const Point3& corner : corners) box += tm * corner;
}

void ThreeJSLight::GetLocalBoundBox(TimeValue, INode*, ViewExp*, Box3& box) {
    GetLocalBounds(box);
}

void ThreeJSLight::DrawLightWire(GraphicsWindow* gw) const {
    const ThreeJSLightType type = GetLightType();
    const float s = 10.0f;

    switch (type) {
        case kLight_Directional: {
            Point3 axisX[] = { Point3(-s, 0.0f, 0.0f), Point3(s, 0.0f, 0.0f) };
            Point3 axisZ[] = { Point3(0.0f, 0.0f, -s), Point3(0.0f, 0.0f, s) };
            Point3 stem[] = { Point3(0.0f, 0.0f, 0.0f), Point3(0.0f, -s * 3.0f, 0.0f) };
            Point3 arrow[] = { Point3(-s * 0.4f, -s * 2.0f, 0.0f), Point3(0.0f, -s * 3.0f, 0.0f), Point3(s * 0.4f, -s * 2.0f, 0.0f) };
            gw->polyline(2, axisX, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, axisZ, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, stem, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(3, arrow, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_Point: {
            Point3 px[] = { Point3(-s, 0.0f, 0.0f), Point3(s, 0.0f, 0.0f) };
            Point3 py[] = { Point3(0.0f, -s, 0.0f), Point3(0.0f, s, 0.0f) };
            Point3 pz[] = { Point3(0.0f, 0.0f, -s), Point3(0.0f, 0.0f, s) };
            Point3 pd1[] = { Point3(-s * 0.7f, -s * 0.7f, 0.0f), Point3(s * 0.7f, s * 0.7f, 0.0f) };
            Point3 pd2[] = { Point3(s * 0.7f, -s * 0.7f, 0.0f), Point3(-s * 0.7f, s * 0.7f, 0.0f) };
            gw->polyline(2, px, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, py, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, pz, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, pd1, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, pd2, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_Spot: {
            const float r = s * 1.2f;
            const float h = s * 3.0f;
            Point3 c1[] = { Point3(0.0f, 0.0f, 0.0f), Point3(-r, -h, -r) };
            Point3 c2[] = { Point3(0.0f, 0.0f, 0.0f), Point3(r, -h, -r) };
            Point3 c3[] = { Point3(0.0f, 0.0f, 0.0f), Point3(r, -h, r) };
            Point3 c4[] = { Point3(0.0f, 0.0f, 0.0f), Point3(-r, -h, r) };
            Point3 base[] = { Point3(-r, -h, -r), Point3(r, -h, -r), Point3(r, -h, r), Point3(-r, -h, r), Point3(-r, -h, -r) };
            gw->polyline(2, c1, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, c2, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, c3, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, c4, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(5, base, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_RectArea: {
            const float w = pblock ? pblock->GetFloat(pl_width) * 0.5f : s;
            const float h = pblock ? pblock->GetFloat(pl_height) * 0.5f : s;
            Point3 rect[] = { Point3(-w, 0.0f, -h), Point3(w, 0.0f, -h), Point3(w, 0.0f, h), Point3(-w, 0.0f, h), Point3(-w, 0.0f, -h) };
            Point3 normal[] = { Point3(0.0f, 0.0f, 0.0f), Point3(0.0f, -s * 2.0f, 0.0f) };
            gw->polyline(5, rect, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, normal, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_Hemisphere: {
            Point3 axisX[] = { Point3(-s, 0.0f, 0.0f), Point3(s, 0.0f, 0.0f) };
            Point3 axisY[] = { Point3(0.0f, -s, 0.0f), Point3(0.0f, s, 0.0f) };
            Point3 up[] = { Point3(0.0f, 0.0f, 0.0f), Point3(0.0f, 0.0f, s * 2.0f) };
            gw->polyline(2, axisX, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, axisY, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, up, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_Ambient: {
            Point3 outer[] = { Point3(-s, 0.0f, 0.0f), Point3(0.0f, s, 0.0f), Point3(s, 0.0f, 0.0f), Point3(0.0f, -s, 0.0f), Point3(-s, 0.0f, 0.0f) };
            Point3 inner[] = { Point3(0.0f, 0.0f, -s), Point3(0.0f, 0.0f, s) };
            gw->polyline(5, outer, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, inner, nullptr, nullptr, FALSE, nullptr);
            break;
        }
    }
}

int ThreeJSLight::Display(TimeValue t, INode* node, ViewExp* vpt, int) {
    GraphicsWindow* gw = vpt->getGW();
    gw->setTransform(node->GetObjectTM(t));

    Color color(node->GetWireColor());
    if (node->Selected()) color = Color(1.0f, 1.0f, 1.0f);
    else if (node->IsFrozen()) color = Color(0.5f, 0.5f, 0.5f);
    gw->setColor(LINE_COLOR, color);

    DrawLightWire(gw);
    Point3 origin(0.0f, 0.0f, 0.0f);
    gw->marker(&origin, PLUS_SIGN_MRKR);
    return 0;
}

int ThreeJSLight::HitTest(TimeValue t, INode* node, int type, int crossing, int, IPoint2* p, ViewExp* vpt) {
    GraphicsWindow* gw = vpt->getGW();
    HitRegion hr;
    MakeHitRegion(hr, type, crossing, 8, p);
    gw->setRndLimits(GW_PICK | GW_WIREFRAME);
    gw->setHitRegion(&hr);
    gw->setTransform(node->GetObjectTM(t));
    gw->clearHitCode();
    DrawLightWire(gw);
    Point3 origin(0.0f, 0.0f, 0.0f);
    gw->marker(&origin, PLUS_SIGN_MRKR);
    return gw->checkHitCode();
}

int ThreeJSLightCreateCB::proc(ViewExp* vpt, int msg, int point, int, IPoint2 m, Matrix3& mat) {
    if (msg == MOUSE_POINT && point == 0) {
        mat.SetTrans(vpt->SnapPoint(m, m, nullptr));
        return CREATE_STOP;
    }
    return CREATE_ABORT;
}

CreateMouseCallBack* ThreeJSLight::GetCreateMouseCallBack() {
    return &g_lightCreateCB;
}

static ParamBlockDesc2 g_legacyLightPB(
    threejs_light_params, _T("ThreeJS Light Parameters"), IDS_LIGHT_PARAMS_LEGACY, &g_legacyLightDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI, 0,
    IDD_THREEJS_LIGHT_LEGACY, IDS_LIGHT_PARAMS_LEGACY, 0, 0, nullptr,
    pl_type, _T("lightType"), TYPE_INT, 0, 0,
        p_default, kLight_Directional,
        p_ui, TYPE_INT_COMBOBOX, IDC_LIGHT_TYPE, 6,
            IDS_LIGHT_TYPE_DIRECTIONAL, IDS_LIGHT_TYPE_POINT, IDS_LIGHT_TYPE_SPOT,
            IDS_LIGHT_TYPE_RECT_AREA, IDS_LIGHT_TYPE_HEMISPHERE, IDS_LIGHT_TYPE_AMBIENT,
        p_vals, kLight_Directional, kLight_Point, kLight_Spot, kLight_RectArea, kLight_Hemisphere, kLight_Ambient,
        p_end,
    pl_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(1.0f, 1.0f, 1.0f),
        p_ui, TYPE_COLORSWATCH, IDC_LIGHT_COLOR,
        p_end,
    pl_intensity, _T("intensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LIGHT_INT_EDIT, IDC_LIGHT_INT_SPIN, 0.1f,
        p_end,
    pl_distance, _T("distance"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DIST_EDIT, IDC_DIST_SPIN, 1.0f,
        p_end,
    pl_decay, _T("decay"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 2.0f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DECAY_EDIT, IDC_DECAY_SPIN, 0.1f,
        p_end,
    pl_angle, _T("angle"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 60.0f,
        p_range, 1.0f, 179.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ANGLE_EDIT, IDC_ANGLE_SPIN, 1.0f,
        p_end,
    pl_penumbra, _T("penumbra"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PENUM_EDIT, IDC_PENUM_SPIN, 0.01f,
        p_end,
    pl_width, _T("width"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 100.0f,
        p_range, 0.1f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WIDTH_EDIT, IDC_WIDTH_SPIN, 1.0f,
        p_end,
    pl_height, _T("height"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 100.0f,
        p_range, 0.1f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_HEIGHT_EDIT, IDC_HEIGHT_SPIN, 1.0f,
        p_end,
    pl_ground_color, _T("groundColor"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(0.2666667f, 0.2666667f, 0.2666667f),
        p_ui, TYPE_COLORSWATCH, IDC_GROUND_COLOR,
        p_end,
    pl_cast_shadow, _T("castShadow"), TYPE_BOOL, 0, 0,
        p_default, FALSE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_CAST_SHADOW,
        p_end,
    pl_shadow_bias, _T("shadowBias"), TYPE_FLOAT, 0, 0,
        p_default, -0.0001f,
        p_range, -0.01f, 0.01f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SHBIAS_EDIT, IDC_SHBIAS_SPIN, 0.0001f,
        p_end,
    pl_shadow_radius, _T("shadowRadius"), TYPE_FLOAT, 0, 0,
        p_default, 1.0f,
        p_range, 0.0f, 20.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SHRAD_EDIT, IDC_SHRAD_SPIN, 0.1f,
        p_end,
    pl_shadow_mapsize, _T("shadowMapSize"), TYPE_INT, 0, 0,
        p_default, 1024,
        p_range, 128, 8192,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_SHMAP_EDIT, IDC_SHMAP_SPIN, 128.0f,
        p_end,
    p_end
);

static ParamBlockDesc2 g_directionalLightPB(
    threejs_light_params, _T("ThreeJS Directional Light Parameters"), IDS_DIRECTIONAL_LIGHT_PARAMS, &g_directionalLightDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI, 0,
    IDD_THREEJS_DIRECTIONAL_LIGHT, IDS_DIRECTIONAL_LIGHT_PARAMS, 0, 0, nullptr,
    pl_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(1.0f, 1.0f, 1.0f),
        p_ui, TYPE_COLORSWATCH, IDC_LIGHT_COLOR,
        p_end,
    pl_intensity, _T("intensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 10000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LIGHT_INT_EDIT, IDC_LIGHT_INT_SPIN, 0.1f,
        p_end,
    pl_cast_shadow, _T("castShadow"), TYPE_BOOL, 0, 0,
        p_default, FALSE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_CAST_SHADOW,
        p_end,
    pl_shadow_bias, _T("shadowBias"), TYPE_FLOAT, 0, 0,
        p_default, -0.0001f,
        p_range, -0.01f, 0.01f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SHBIAS_EDIT, IDC_SHBIAS_SPIN, 0.0001f,
        p_end,
    pl_shadow_radius, _T("shadowRadius"), TYPE_FLOAT, 0, 0,
        p_default, 1.0f,
        p_range, 0.0f, 20.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SHRAD_EDIT, IDC_SHRAD_SPIN, 0.1f,
        p_end,
    pl_shadow_mapsize, _T("shadowMapSize"), TYPE_INT, 0, 0,
        p_default, 2048,
        p_range, 128, 8192,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_SHMAP_EDIT, IDC_SHMAP_SPIN, 128.0f,
        p_end,
    p_end
);

static ParamBlockDesc2 g_pointLightPB(
    threejs_light_params, _T("ThreeJS Point Light Parameters"), IDS_POINT_LIGHT_PARAMS, &g_pointLightDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI, 0,
    IDD_THREEJS_POINT_LIGHT, IDS_POINT_LIGHT_PARAMS, 0, 0, nullptr,
    pl_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(1.0f, 1.0f, 1.0f),
        p_ui, TYPE_COLORSWATCH, IDC_LIGHT_COLOR,
        p_end,
    pl_intensity, _T("intensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LIGHT_INT_EDIT, IDC_LIGHT_INT_SPIN, 0.1f,
        p_end,
    pl_distance, _T("distance"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DIST_EDIT, IDC_DIST_SPIN, 1.0f,
        p_end,
    pl_decay, _T("decay"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 2.0f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DECAY_EDIT, IDC_DECAY_SPIN, 0.1f,
        p_end,
    pl_cast_shadow, _T("castShadow"), TYPE_BOOL, 0, 0,
        p_default, FALSE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_CAST_SHADOW,
        p_end,
    pl_shadow_bias, _T("shadowBias"), TYPE_FLOAT, 0, 0,
        p_default, -0.0001f,
        p_range, -0.01f, 0.01f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SHBIAS_EDIT, IDC_SHBIAS_SPIN, 0.0001f,
        p_end,
    pl_shadow_radius, _T("shadowRadius"), TYPE_FLOAT, 0, 0,
        p_default, 1.0f,
        p_range, 0.0f, 20.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SHRAD_EDIT, IDC_SHRAD_SPIN, 0.1f,
        p_end,
    pl_shadow_mapsize, _T("shadowMapSize"), TYPE_INT, 0, 0,
        p_default, 1024,
        p_range, 128, 4096,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_SHMAP_EDIT, IDC_SHMAP_SPIN, 128.0f,
        p_end,
    p_end
);

static ParamBlockDesc2 g_spotLightPB(
    threejs_light_params, _T("ThreeJS Spot Light Parameters"), IDS_SPOT_LIGHT_PARAMS, &g_spotLightDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI, 0,
    IDD_THREEJS_SPOT_LIGHT, IDS_SPOT_LIGHT_PARAMS, 0, 0, nullptr,
    pl_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(1.0f, 1.0f, 1.0f),
        p_ui, TYPE_COLORSWATCH, IDC_LIGHT_COLOR,
        p_end,
    pl_intensity, _T("intensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LIGHT_INT_EDIT, IDC_LIGHT_INT_SPIN, 0.1f,
        p_end,
    pl_distance, _T("distance"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DIST_EDIT, IDC_DIST_SPIN, 1.0f,
        p_end,
    pl_decay, _T("decay"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 2.0f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DECAY_EDIT, IDC_DECAY_SPIN, 0.1f,
        p_end,
    pl_angle, _T("angle"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 60.0f,
        p_range, 1.0f, 179.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ANGLE_EDIT, IDC_ANGLE_SPIN, 1.0f,
        p_end,
    pl_penumbra, _T("penumbra"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PENUM_EDIT, IDC_PENUM_SPIN, 0.01f,
        p_end,
    pl_cast_shadow, _T("castShadow"), TYPE_BOOL, 0, 0,
        p_default, FALSE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_CAST_SHADOW,
        p_end,
    pl_shadow_bias, _T("shadowBias"), TYPE_FLOAT, 0, 0,
        p_default, -0.0001f,
        p_range, -0.01f, 0.01f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SHBIAS_EDIT, IDC_SHBIAS_SPIN, 0.0001f,
        p_end,
    pl_shadow_radius, _T("shadowRadius"), TYPE_FLOAT, 0, 0,
        p_default, 1.0f,
        p_range, 0.0f, 20.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_SHRAD_EDIT, IDC_SHRAD_SPIN, 0.1f,
        p_end,
    pl_shadow_mapsize, _T("shadowMapSize"), TYPE_INT, 0, 0,
        p_default, 1024,
        p_range, 128, 4096,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_SHMAP_EDIT, IDC_SHMAP_SPIN, 128.0f,
        p_end,
    p_end
);

static ParamBlockDesc2 g_rectAreaLightPB(
    threejs_light_params, _T("ThreeJS Rect Area Light Parameters"), IDS_RECT_AREA_LIGHT_PARAMS, &g_rectAreaLightDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI, 0,
    IDD_THREEJS_RECT_AREA_LIGHT, IDS_RECT_AREA_LIGHT_PARAMS, 0, 0, nullptr,
    pl_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(1.0f, 1.0f, 1.0f),
        p_ui, TYPE_COLORSWATCH, IDC_LIGHT_COLOR,
        p_end,
    pl_intensity, _T("intensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LIGHT_INT_EDIT, IDC_LIGHT_INT_SPIN, 0.1f,
        p_end,
    pl_width, _T("width"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 100.0f,
        p_range, 0.1f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WIDTH_EDIT, IDC_WIDTH_SPIN, 1.0f,
        p_end,
    pl_height, _T("height"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 100.0f,
        p_range, 0.1f, 1000000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_HEIGHT_EDIT, IDC_HEIGHT_SPIN, 1.0f,
        p_end,
    p_end
);

static ParamBlockDesc2 g_hemisphereLightPB(
    threejs_light_params, _T("ThreeJS Hemisphere Light Parameters"), IDS_HEMISPHERE_LIGHT_PARAMS, &g_hemisphereLightDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI, 0,
    IDD_THREEJS_HEMISPHERE_LIGHT, IDS_HEMISPHERE_LIGHT_PARAMS, 0, 0, nullptr,
    pl_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(1.0f, 1.0f, 1.0f),
        p_ui, TYPE_COLORSWATCH, IDC_LIGHT_COLOR,
        p_end,
    pl_intensity, _T("intensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 10000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LIGHT_INT_EDIT, IDC_LIGHT_INT_SPIN, 0.1f,
        p_end,
    pl_ground_color, _T("groundColor"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(0.2666667f, 0.2666667f, 0.2666667f),
        p_ui, TYPE_COLORSWATCH, IDC_GROUND_COLOR,
        p_end,
    p_end
);

static ParamBlockDesc2 g_ambientLightPB(
    threejs_light_params, _T("ThreeJS Ambient Light Parameters"), IDS_AMBIENT_LIGHT_PARAMS, &g_ambientLightDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI, 0,
    IDD_THREEJS_AMBIENT_LIGHT, IDS_AMBIENT_LIGHT_PARAMS, 0, 0, nullptr,
    pl_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(1.0f, 1.0f, 1.0f),
        p_ui, TYPE_COLORSWATCH, IDC_LIGHT_COLOR,
        p_end,
    pl_intensity, _T("intensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 10000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LIGHT_INT_EDIT, IDC_LIGHT_INT_SPIN, 0.1f,
        p_end,
    p_end
);

} // namespace

bool IsThreeJSLightClassID(const Class_ID& cid) {
    return FindLightClassSpec(cid) != nullptr;
}

ThreeJSLightType GetThreeJSLightTypeFromClassID(const Class_ID& cid) {
    const LightClassSpec* spec = FindLightClassSpec(cid);
    return spec ? spec->type : kLight_Directional;
}

bool ThreeJSLightClassUsesTypeParam(const Class_ID& cid) {
    const LightClassSpec* spec = FindLightClassSpec(cid);
    return spec ? spec->usesTypeParam : false;
}

ClassDesc2* GetThreeJSLightLegacyDesc() { return &g_legacyLightDesc; }
ClassDesc2* GetThreeJSDirectionalLightDesc() { return &g_directionalLightDesc; }
ClassDesc2* GetThreeJSPointLightDesc() { return &g_pointLightDesc; }
ClassDesc2* GetThreeJSSpotLightDesc() { return &g_spotLightDesc; }
ClassDesc2* GetThreeJSRectAreaLightDesc() { return &g_rectAreaLightDesc; }
ClassDesc2* GetThreeJSHemisphereLightDesc() { return &g_hemisphereLightDesc; }
ClassDesc2* GetThreeJSAmbientLightDesc() { return &g_ambientLightDesc; }
