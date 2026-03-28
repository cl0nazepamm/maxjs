#include "threejs_lights.h"
#include "threejs_lights_res.h"
#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <simpobj.h>
#include <plugapi.h>
#include <maxapi.h>
#include <object.h>
#include <mesh.h>

extern HINSTANCE hInstance;

// ══════════════════════════════════════════════════════════════
//  ThreeJS Light — helper object with light parameters
//  Shows up in Create → Helpers → MaxJS
//  Viewport wireframe: arrow (dir), sphere (point), cone (spot),
//  rectangle (area), half-dome (hemisphere)
// ══════════════════════════════════════════════════════════════

static const MCHAR* kLightTypeNames[] = {
    _T("Directional"), _T("Point"), _T("Spot"), _T("RectArea"), _T("Hemisphere")
};

class ThreeJSLight : public LightObject {
public:
    IParamBlock2* pblock = nullptr;
    Mesh meshRep;
    bool meshBuilt = false;
    int lastType = -1;
    bool useLight = true;
    bool coneDisplay = false;

    ThreeJSLight() {
        GetThreeJSLightDesc()->MakeAutoParamBlocks(this);
        BuildMesh();
    }

    // ── Animatable ───────────────────────────────────────────
    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_LIGHT_CLASS_ID; }
    SClass_ID SuperClassID() override { return LIGHT_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("ThreeJS Light"); }

    // ── LightObject pure virtuals ────────────────────────────
    RefResult EvalLightState(TimeValue t, Interval& valid, LightState* ls) override {
        if (!ls) return REF_SUCCEED;
        ls->color = pblock ? pblock->GetColor(pl_color, t) : Color(1, 1, 1);
        ls->intens = pblock ? pblock->GetFloat(pl_intensity, t) : 1.0f;
        ls->on = useLight;
        int type = pblock ? pblock->GetInt(pl_type) : 0;
        ls->type = (type == kLight_Directional || type == kLight_Hemisphere)
                   ? DIRECT_LGT : (type == kLight_Spot ? SPOT_LGT : OMNI_LGT);
        valid = FOREVER;
        return REF_SUCCEED;
    }
    void SetUseLight(int onOff) override { useLight = (onOff != 0); }
    BOOL GetUseLight() override { return useLight; }
    void SetHotspot(TimeValue t, float f) override {
        if (pblock) pblock->SetValue(pl_angle, t, f);
    }
    float GetHotspot(TimeValue t, Interval& valid) override {
        valid = FOREVER;
        return pblock ? pblock->GetFloat(pl_angle, t) : 60.f;
    }
    void SetFallsize(TimeValue t, float f) override {
        if (pblock) pblock->SetValue(pl_angle, t, f);
    }
    float GetFallsize(TimeValue t, Interval& valid) override {
        valid = FOREVER;
        return pblock ? pblock->GetFloat(pl_angle, t) : 60.f;
    }
    void SetAtten(TimeValue t, int which, float f) override {
        if (pblock && which == ATTEN_END) pblock->SetValue(pl_distance, t, f);
    }
    float GetAtten(TimeValue t, int which, Interval& valid) override {
        valid = FOREVER;
        return (pblock && which == ATTEN_END) ? pblock->GetFloat(pl_distance, t) : 0.f;
    }
    void SetTDist(TimeValue t, float f) override {}
    float GetTDist(TimeValue t, Interval& valid) override { valid = FOREVER; return 100.f; }
    void SetConeDisplay(int s, int notify = TRUE) override { coneDisplay = (s != 0); }
    BOOL GetConeDisplay() override { return coneDisplay; }
    void SetRGBColor(TimeValue t, const Point3& rgb) override {
        if (pblock) pblock->SetValue(pl_color, t, Color(rgb.x, rgb.y, rgb.z));
    }
    Point3 GetRGBColor(TimeValue t, Interval& valid) override {
        valid = FOREVER;
        Color c = pblock ? pblock->GetColor(pl_color, t) : Color(1, 1, 1);
        return Point3(c.r, c.g, c.b);
    }
    void SetIntensity(TimeValue t, float f) override {
        if (pblock) pblock->SetValue(pl_intensity, t, f);
    }
    float GetIntensity(TimeValue t, Interval& valid) override {
        valid = FOREVER;
        return pblock ? pblock->GetFloat(pl_intensity, t) : 1.f;
    }

    // ── ReferenceMaker ───────────────────────────────────────
    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle r) override {
        if (i == 0) pblock = static_cast<IParamBlock2*>(r);
    }
    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID&, RefMessage, BOOL) override {
        const int currentType = pblock ? pblock->GetInt(pl_type) : 0;
        if (!meshBuilt || currentType != lastType) {
            BuildMesh();
        }
        return REF_SUCCEED;
    }

    // ── ReferenceTarget ──────────────────────────────────────
    RefTargetHandle Clone(RemapDir& remap) override {
        ThreeJSLight* n = new ThreeJSLight();
        BaseClone(this, n, remap);
        n->ReplaceReference(0, remap.CloneRef(pblock));
        return n;
    }

    // ── Object ───────────────────────────────────────────────
    ObjectState Eval(TimeValue) override { return ObjectState(this); }
    void InitNodeName(MSTR& s) override {
        int type = pblock ? pblock->GetInt(pl_type) : 0;
        s = MSTR(_T("TJS_")) + MSTR(kLightTypeNames[type]);
    }
    int IsRenderable() override { return 0; }
    int UsesWireColor() override { return 1; }

    // ── ParamBlock ───────────────────────────────────────────
    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override {
        return id == threejs_light_params ? pblock : nullptr;
    }

    // ── Edit params (required for LightObject to show rollup) ─
    void BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) override {
        GetThreeJSLightDesc()->BeginEditParams(ip, this, flags, prev);
    }
    void EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) override {
        GetThreeJSLightDesc()->EndEditParams(ip, this, flags, next);
    }

    // ── Helper display ───────────────────────────────────────
    void GetWorldBoundBox(TimeValue t, INode* node, ViewExp*, Box3& box) override {
        Matrix3 tm = node->GetObjectTM(t);
        box.Init();
        for (int i = 0; i < meshRep.getNumVerts(); i++)
            box += tm * meshRep.getVert(i);
        box.EnlargeBy(5.0f);
    }

    void GetLocalBoundBox(TimeValue, INode*, ViewExp*, Box3& box) override {
        box.Init();
        for (int i = 0; i < meshRep.getNumVerts(); i++)
            box += meshRep.getVert(i);
        box.EnlargeBy(5.0f);
    }

    void DrawLightWire(GraphicsWindow* gw) {
        float s = 10.0f;
        int type = pblock ? pblock->GetInt(pl_type) : 0;

        switch (type) {
        case kLight_Directional: {
            // Cross + arrow down -Y (Max forward = light direction)
            Point3 pts1[] = { Point3(-s, 0.f, 0.f), Point3(s, 0.f, 0.f) };
            Point3 pts2[] = { Point3(0.f, 0.f, -s), Point3(0.f, 0.f, s) };
            Point3 pts3[] = { Point3(0.f, 0.f, 0.f), Point3(0.f, -s*3, 0.f) };
            Point3 pts4[] = { Point3(-s*0.4f, -s*2, 0.f), Point3(0.f, -s*3, 0.f), Point3(s*0.4f, -s*2, 0.f) };
            gw->polyline(2, pts1, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, pts2, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, pts3, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(3, pts4, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_Point: {
            // Starburst
            Point3 px[] = { Point3(-s, 0.f, 0.f), Point3(s, 0.f, 0.f) };
            Point3 py[] = { Point3(0.f, -s, 0.f), Point3(0.f, s, 0.f) };
            Point3 pz[] = { Point3(0.f, 0.f, -s), Point3(0.f, 0.f, s) };
            Point3 pd1[] = { Point3(-s*0.7f, -s*0.7f, 0.f), Point3(s*0.7f, s*0.7f, 0.f) };
            Point3 pd2[] = { Point3(s*0.7f, -s*0.7f, 0.f), Point3(-s*0.7f, s*0.7f, 0.f) };
            gw->polyline(2, px, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, py, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, pz, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, pd1, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, pd2, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_Spot: {
            // Cone lines
            float h = s * 3;
            float r = s * 1.2f;
            Point3 c1[] = { Point3(0.f, 0.f, 0.f), Point3(-r, -h, -r) };
            Point3 c2[] = { Point3(0.f, 0.f, 0.f), Point3(r, -h, -r) };
            Point3 c3[] = { Point3(0.f, 0.f, 0.f), Point3(r, -h, r) };
            Point3 c4[] = { Point3(0.f, 0.f, 0.f), Point3(-r, -h, r) };
            Point3 base[] = { Point3(-r,-h,-r), Point3(r,-h,-r), Point3(r,-h,r), Point3(-r,-h,r), Point3(-r,-h,-r) };
            gw->polyline(2, c1, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, c2, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, c3, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, c4, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(5, base, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_RectArea: {
            float w = pblock ? pblock->GetFloat(pl_width) * 0.5f : s;
            float h = pblock ? pblock->GetFloat(pl_height) * 0.5f : s;
            Point3 rect[] = { Point3(-w, 0.f, -h), Point3(w, 0.f, -h), Point3(w, 0.f, h), Point3(-w, 0.f, h), Point3(-w, 0.f, -h) };
            Point3 norm[] = { Point3(0.f, 0.f, 0.f), Point3(0.f, -s*2, 0.f) };
            gw->polyline(5, rect, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, norm, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        case kLight_Hemisphere: {
            Point3 px[] = { Point3(-s, 0.f, 0.f), Point3(s, 0.f, 0.f) };
            Point3 py[] = { Point3(0.f, -s, 0.f), Point3(0.f, s, 0.f) };
            Point3 up[] = { Point3(0.f, 0.f, 0.f), Point3(0.f, 0.f, s*2) };
            gw->polyline(2, px, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, py, nullptr, nullptr, FALSE, nullptr);
            gw->polyline(2, up, nullptr, nullptr, FALSE, nullptr);
            break;
        }
        }
    }

    int Display(TimeValue t, INode* node, ViewExp* vpt, int flags) override {
        GraphicsWindow* gw = vpt->getGW();
        gw->setTransform(node->GetObjectTM(t));

        Color color(node->GetWireColor());
        if (node->Selected()) color = Color(1.f, 1.f, 1.f);
        else if (node->IsFrozen()) color = Color(0.5f, 0.5f, 0.5f);
        gw->setColor(LINE_COLOR, color);

        DrawLightWire(gw);

        // Center marker
        Point3 zero(0.f, 0.f, 0.f);
        gw->marker(&zero, PLUS_SIGN_MRKR);

        return 0;
    }

    int HitTest(TimeValue t, INode* node, int type, int crossing,
                int flags, IPoint2* p, ViewExp* vpt) override {
        GraphicsWindow* gw = vpt->getGW();
        HitRegion hr;
        MakeHitRegion(hr, type, crossing, 8, p);
        gw->setRndLimits(GW_PICK | GW_WIREFRAME);
        gw->setHitRegion(&hr);
        gw->setTransform(node->GetObjectTM(t));
        gw->clearHitCode();

        DrawLightWire(gw);
        Point3 zero(0.f, 0.f, 0.f);
        gw->marker(&zero, PLUS_SIGN_MRKR);

        return gw->checkHitCode();
    }

    void BuildMesh() {
        int type = pblock ? pblock->GetInt(pl_type) : 0;
        lastType = type;
        meshRep.setNumVerts(0);
        meshRep.setNumFaces(0);

        float s = 10.0f;  // Scale factor for viewport display

        switch (type) {
        case kLight_Directional: {
            // Arrow pointing down -Z (light direction)
            meshRep.setNumVerts(6);
            meshRep.setNumFaces(4);
            meshRep.setVert(0, Point3(0.f, 0.f, 0.f));
            meshRep.setVert(1, Point3(0.f, 0.f, -s * 3));
            meshRep.setVert(2, Point3(-s * 0.5f, 0.f, -s * 2));
            meshRep.setVert(3, Point3(s * 0.5f, 0.f, -s * 2));
            meshRep.setVert(4, Point3(0.f, -s * 0.5f, -s * 2));
            meshRep.setVert(5, Point3(0.f, s * 0.5f, -s * 2));
            meshRep.faces[0].setVerts(0, 1, 2); meshRep.faces[0].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[1].setVerts(0, 1, 3); meshRep.faces[1].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[2].setVerts(0, 1, 4); meshRep.faces[2].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[3].setVerts(0, 1, 5); meshRep.faces[3].setEdgeVisFlags(1, 1, 1);
            break;
        }
        case kLight_Point: {
            // Small octahedron
            meshRep.setNumVerts(6);
            meshRep.setNumFaces(8);
            meshRep.setVert(0, Point3(s, 0.f,0.f));
            meshRep.setVert(1, Point3(-s, 0.f,0.f));
            meshRep.setVert(2, Point3(0.f, s,0.f));
            meshRep.setVert(3, Point3(0.f, -s,0.f));
            meshRep.setVert(4, Point3(0.f, 0.f, s));
            meshRep.setVert(5, Point3(0.f, 0.f, -s));
            meshRep.faces[0].setVerts(0, 2, 4); meshRep.faces[0].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[1].setVerts(2, 1, 4); meshRep.faces[1].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[2].setVerts(1, 3, 4); meshRep.faces[2].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[3].setVerts(3, 0, 4); meshRep.faces[3].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[4].setVerts(0, 5, 2); meshRep.faces[4].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[5].setVerts(2, 5, 1); meshRep.faces[5].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[6].setVerts(1, 5, 3); meshRep.faces[6].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[7].setVerts(3, 5, 0); meshRep.faces[7].setEdgeVisFlags(1, 1, 1);
            break;
        }
        case kLight_Spot: {
            // Cone pointing down -Z
            float r = s * 1.5f;
            float h = s * 3;
            meshRep.setNumVerts(5);
            meshRep.setNumFaces(4);
            meshRep.setVert(0, Point3(0.f, 0.f, 0.f));
            meshRep.setVert(1, Point3(-r, -r, -h));
            meshRep.setVert(2, Point3(r, -r, -h));
            meshRep.setVert(3, Point3(r, r, -h));
            meshRep.setVert(4, Point3(-r, r, -h));
            meshRep.faces[0].setVerts(0, 1, 2); meshRep.faces[0].setEdgeVisFlags(1, 1, 0);
            meshRep.faces[1].setVerts(0, 2, 3); meshRep.faces[1].setEdgeVisFlags(1, 1, 0);
            meshRep.faces[2].setVerts(0, 3, 4); meshRep.faces[2].setEdgeVisFlags(1, 1, 0);
            meshRep.faces[3].setVerts(0, 4, 1); meshRep.faces[3].setEdgeVisFlags(1, 1, 0);
            break;
        }
        case kLight_RectArea: {
            // Rectangle on XY plane
            float w = pblock ? pblock->GetFloat(pl_width) * 0.5f : s;
            float h = pblock ? pblock->GetFloat(pl_height) * 0.5f : s;
            meshRep.setNumVerts(4);
            meshRep.setNumFaces(2);
            meshRep.setVert(0, Point3(-w, -h,0.f));
            meshRep.setVert(1, Point3(w, -h,0.f));
            meshRep.setVert(2, Point3(w, h,0.f));
            meshRep.setVert(3, Point3(-w, h,0.f));
            meshRep.faces[0].setVerts(0, 1, 2); meshRep.faces[0].setEdgeVisFlags(1, 1, 1);
            meshRep.faces[1].setVerts(0, 2, 3); meshRep.faces[1].setEdgeVisFlags(1, 1, 1);
            break;
        }
        case kLight_Hemisphere: {
            // Up arrow
            meshRep.setNumVerts(3);
            meshRep.setNumFaces(1);
            meshRep.setVert(0, Point3(0.f, 0.f, 0.f));
            meshRep.setVert(1, Point3(-s, 0.f,0.f));
            meshRep.setVert(2, Point3(0.f, 0.f, s * 2));
            meshRep.faces[0].setVerts(0, 1, 2); meshRep.faces[0].setEdgeVisFlags(1, 1, 1);
            break;
        }
        }

        meshRep.buildNormals();
        meshRep.InvalidateGeomCache();
        meshBuilt = true;
    }

    // ── I/O ──────────────────────────────────────────────────
    IOResult Save(ISave* s) override { return LightObject::Save(s); }
    IOResult Load(ILoad* l) override { return LightObject::Load(l); }

    // ── CreateMouseCallBack (simple click-to-place) ──────────
    CreateMouseCallBack* GetCreateMouseCallBack() override;
};

// ── Click-to-place ────────────────────────────────────────────

class ThreeJSLightCreateCB : public CreateMouseCallBack {
    ThreeJSLight* obj = nullptr;
    IPoint2 sp0;
    Point3 p0;
public:
    int proc(ViewExp* vpt, int msg, int point, int flags,
             IPoint2 m, Matrix3& mat) override {
        if (msg == MOUSE_POINT && point == 0) {
            p0 = vpt->SnapPoint(m, m, nullptr);
            mat.SetTrans(p0);
            return CREATE_STOP;
        }
        return CREATE_ABORT;
    }
    void SetObj(ThreeJSLight* o) { obj = o; }
};

static ThreeJSLightCreateCB g_lightCreateCB;

CreateMouseCallBack* ThreeJSLight::GetCreateMouseCallBack() {
    g_lightCreateCB.SetObj(this);
    return &g_lightCreateCB;
}

// ── Class Descriptor ──────────────────────────────────────────

class ThreeJSLightClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL) override { return new ThreeJSLight(); }
    const TCHAR* ClassName() override { return _T("ThreeJS Light"); }
    const TCHAR* NonLocalizedClassName() override { return _T("ThreeJS Light"); }
    SClass_ID SuperClassID() override { return LIGHT_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_LIGHT_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSLight"); }
    HINSTANCE HInstance() override { return hInstance; }
};

static ThreeJSLightClassDesc threeJSLightDesc;
ClassDesc2* GetThreeJSLightDesc() { return &threeJSLightDesc; }

// ── ParamBlock Descriptor ─────────────────────────────────────

static ParamBlockDesc2 threejs_light_pb(
    threejs_light_params,
    _T("ThreeJS Light Parameters"),
    IDS_LIGHT_PARAMS,
    &threeJSLightDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_LIGHT, IDS_LIGHT_PARAMS, 0, 0, nullptr,

    // ═══ Type ═════════════════════════════════════════════════
    pl_type, _T("lightType"), TYPE_INT, 0, 0,
        p_default, kLight_Directional,
        p_ui, TYPE_INT_COMBOBOX, IDC_LIGHT_TYPE,
            kLight_COUNT,
            IDS_LIGHT_TYPE_DIRECTIONAL,
            IDS_LIGHT_TYPE_POINT,
            IDS_LIGHT_TYPE_SPOT,
            IDS_LIGHT_TYPE_RECT_AREA,
            IDS_LIGHT_TYPE_HEMISPHERE,
        p_vals,
            kLight_Directional, kLight_Point, kLight_Spot, kLight_RectArea, kLight_Hemisphere,
        p_end,

    // ═══ Color / Intensity ════════════════════════════════════
    pl_color, _T("color"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(1.0f, 1.0f, 1.0f),
        p_ui, TYPE_COLORSWATCH, IDC_LIGHT_COLOR,
        p_end,

    pl_intensity, _T("intensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 1.0f,
        p_range, 0.0f, 1000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_LIGHT_INT_EDIT, IDC_LIGHT_INT_SPIN, 0.1f,
        p_end,

    // ═══ Point / Spot ═════════════════════════════════════════
    pl_distance, _T("distance"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.0f,
        p_range, 0.0f, 100000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DIST_EDIT, IDC_DIST_SPIN, 1.0f,
        p_end,

    pl_decay, _T("decay"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 2.0f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_DECAY_EDIT, IDC_DECAY_SPIN, 0.1f,
        p_end,

    // ═══ Spot ═════════════════════════════════════════════════
    pl_angle, _T("angle"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 60.0f,
        p_range, 1.0f, 180.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_ANGLE_EDIT, IDC_ANGLE_SPIN, 1.0f,
        p_end,

    pl_penumbra, _T("penumbra"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.1f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_PENUM_EDIT, IDC_PENUM_SPIN, 0.01f,
        p_end,

    // ═══ RectArea ═════════════════════════════════════════════
    pl_width, _T("width"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 20.0f,
        p_range, 0.1f, 100000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WIDTH_EDIT, IDC_WIDTH_SPIN, 1.0f,
        p_end,

    pl_height, _T("height"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 20.0f,
        p_range, 0.1f, 100000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_HEIGHT_EDIT, IDC_HEIGHT_SPIN, 1.0f,
        p_end,

    // ═══ Hemisphere ═══════════════════════════════════════════
    pl_ground_color, _T("groundColor"), TYPE_RGBA, P_ANIMATABLE, 0,
        p_default, Color(0.2f, 0.15f, 0.1f),
        p_ui, TYPE_COLORSWATCH, IDC_GROUND_COLOR,
        p_end,

    // ═══ Shadows ══════════════════════════════════════════════
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

    // ═══ Volumetric ═══════════════════════════════════════════
    pl_volumetric, _T("volumetric"), TYPE_BOOL, 0, 0,
        p_default, FALSE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_VOLUMETRIC,
        p_end,

    pl_vol_density, _T("volDensity"), TYPE_FLOAT, P_ANIMATABLE, 0,
        p_default, 0.5f,
        p_range, 0.0f, 10.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_VOLDENS_EDIT, IDC_VOLDENS_SPIN, 0.01f,
        p_end,

    p_end
);
