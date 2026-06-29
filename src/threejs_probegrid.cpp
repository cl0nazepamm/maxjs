#include "threejs_probegrid.h"
#include "threejs_probegrid_res.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <maxapi.h>
#include <object.h>

extern HINSTANCE hInstance;

namespace {

class MaxJSProbeGrid;

class MaxJSProbeGridClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL) override;
    const TCHAR* ClassName() override { return _T("HALO-GI Probe Grid"); }
    const TCHAR* NonLocalizedClassName() override { return _T("HALO-GI Probe Grid"); }
    SClass_ID SuperClassID() override { return HELPER_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_PROBE_GRID_CLASS_ID; }
    const TCHAR* Category() override { return _T("max.js"); }
    const TCHAR* InternalName() override { return _T("MaxJSProbeGrid"); }
    HINSTANCE HInstance() override { return hInstance; }
};

static MaxJSProbeGridClassDesc g_probeGridDesc;

// Box + interior grid gizmo (also the in-Max diagnostics view).
void DrawBoxGrid(GraphicsWindow* gw, float l, float w, float h, int dx, int dy, int dz) {
    const float hx = l * 0.5f, hy = w * 0.5f, hz = h * 0.5f;
    const Point3 c[8] = {
        Point3(-hx, -hy, -hz), Point3(hx, -hy, -hz), Point3(hx, hy, -hz), Point3(-hx, hy, -hz),
        Point3(-hx, -hy, hz),  Point3(hx, -hy, hz),  Point3(hx, hy, hz),  Point3(-hx, hy, hz),
    };
    const int edges[12][2] = { {0,1},{1,2},{2,3},{3,0},{4,5},{5,6},{6,7},{7,4},{0,4},{1,5},{2,6},{3,7} };
    for (const auto& e : edges) { Point3 ln[2] = { c[e[0]], c[e[1]] }; gw->polyline(2, ln, nullptr, nullptr, FALSE, nullptr); }

    auto stepOf = [](int n) { int s = (n - 1) / 8; return s < 1 ? 1 : s; };
    const int sx = stepOf(dx), sy = stepOf(dy), sz = stepOf(dz);
    auto coord = [](int i, int n, float half, float full) { return n > 1 ? (-half + full * (float)i / (float)(n - 1)) : 0.0f; };
    for (int i = 0; i < dx; i += sx) { float x = coord(i, dx, hx, l);
        for (int j = 0; j < dy; j += sy) { float y = coord(j, dy, hy, w);
            Point3 ln[2] = { Point3(x, y, -hz), Point3(x, y, hz) }; gw->polyline(2, ln, nullptr, nullptr, FALSE, nullptr); } }
    for (int j = 0; j < dy; j += sy) { float y = coord(j, dy, hy, w);
        for (int k = 0; k < dz; k += sz) { float z = coord(k, dz, hz, h);
            Point3 ln[2] = { Point3(-hx, y, z), Point3(hx, y, z) }; gw->polyline(2, ln, nullptr, nullptr, FALSE, nullptr); } }
    for (int i = 0; i < dx; i += sx) { float x = coord(i, dx, hx, l);
        for (int k = 0; k < dz; k += sz) { float z = coord(k, dz, hz, h);
            Point3 ln[2] = { Point3(x, -hy, z), Point3(x, hy, z) }; gw->polyline(2, ln, nullptr, nullptr, FALSE, nullptr); } }
}

class MaxJSProbeGrid : public HelperObject {
public:
    MaxJSProbeGrid() { g_probeGridDesc.MakeAutoParamBlocks(this); }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_PROBE_GRID_CLASS_ID; }
    SClass_ID SuperClassID() override { return HELPER_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("HALO-GI Probe Grid"); }
    void InitNodeName(MSTR& s) override { s = _T("maxjs_ProbeGrid"); }
    int IsRenderable() override { return 0; }
    int UsesWireColor() override { return 1; }

    int NumRefs() override { return 1; }
    RefTargetHandle GetReference(int i) override { return i == 0 ? pblock : nullptr; }
    void SetReference(int i, RefTargetHandle rtarg) override { if (i == 0) pblock = static_cast<IParamBlock2*>(rtarg); }
    RefResult NotifyRefChanged(const Interval&, RefTargetHandle, PartID&, RefMessage, BOOL) override { return REF_SUCCEED; }
    RefTargetHandle Clone(RemapDir& remap) override;

    int NumParamBlocks() override { return 1; }
    IParamBlock2* GetParamBlock(int i) override { return i == 0 ? pblock : nullptr; }
    IParamBlock2* GetParamBlockByID(BlockID id) override { return id == threejs_probegrid_params ? pblock : nullptr; }
    void BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) override { g_probeGridDesc.BeginEditParams(ip, this, flags, prev); }
    void EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) override { g_probeGridDesc.EndEditParams(ip, this, flags, next); }

    ObjectState Eval(TimeValue) override { return ObjectState(this); }

    void GetLocalBounds(Box3& box) {
        const float hx = GetF(pg_length) * 0.5f, hy = GetF(pg_width) * 0.5f, hz = GetF(pg_height) * 0.5f;
        box.Init();
        box += Point3(-hx, -hy, -hz);
        box += Point3(hx, hy, hz);
    }
    void GetLocalBoundBox(TimeValue, INode*, ViewExp*, Box3& box) override { GetLocalBounds(box); }
    void GetWorldBoundBox(TimeValue t, INode* node, ViewExp*, Box3& box) override {
        Matrix3 tm = node->GetObjectTM(t);
        Box3 local; GetLocalBounds(local);
        box.Init();
        const Point3 pmin = local.pmin, pmax = local.pmax;
        const Point3 corners[8] = {
            Point3(pmin.x, pmin.y, pmin.z), Point3(pmax.x, pmin.y, pmin.z),
            Point3(pmin.x, pmax.y, pmin.z), Point3(pmax.x, pmax.y, pmin.z),
            Point3(pmin.x, pmin.y, pmax.z), Point3(pmax.x, pmin.y, pmax.z),
            Point3(pmin.x, pmax.y, pmax.z), Point3(pmax.x, pmax.y, pmax.z),
        };
        for (const Point3& corner : corners) box += tm * corner;
    }

    int Display(TimeValue t, INode* node, ViewExp* vpt, int) override {
        GraphicsWindow* gw = vpt->getGW();
        gw->setTransform(node->GetObjectTM(t));
        Color color(node->GetWireColor());
        if (node->Selected()) color = Color(1.0f, 1.0f, 1.0f);
        else if (node->IsFrozen()) color = Color(0.5f, 0.5f, 0.5f);
        gw->setColor(LINE_COLOR, color);
        DrawBoxGrid(gw, GetF(pg_length), GetF(pg_width), GetF(pg_height), GetI(pg_div_x), GetI(pg_div_y), GetI(pg_div_z));
        Point3 origin(0.0f, 0.0f, 0.0f);
        gw->marker(&origin, PLUS_SIGN_MRKR);
        return 0;
    }
    int HitTest(TimeValue t, INode* node, int type, int crossing, int, IPoint2* p, ViewExp* vpt) override {
        GraphicsWindow* gw = vpt->getGW();
        HitRegion hr; MakeHitRegion(hr, type, crossing, 8, p);
        gw->setRndLimits(GW_PICK | GW_WIREFRAME);
        gw->setHitRegion(&hr);
        gw->setTransform(node->GetObjectTM(t));
        gw->clearHitCode();
        DrawBoxGrid(gw, GetF(pg_length), GetF(pg_width), GetF(pg_height), GetI(pg_div_x), GetI(pg_div_y), GetI(pg_div_z));
        Point3 origin(0.0f, 0.0f, 0.0f);
        gw->marker(&origin, PLUS_SIGN_MRKR);
        return gw->checkHitCode();
    }

    CreateMouseCallBack* GetCreateMouseCallBack() override;

    IParamBlock2* pblock = nullptr;

private:
    float GetF(ParamID id) { return pblock ? pblock->GetFloat(id, GetCOREInterface()->GetTime()) : 0.0f; }
    int GetI(ParamID id) { return pblock ? pblock->GetInt(id, GetCOREInterface()->GetTime()) : 0; }
};

RefTargetHandle MaxJSProbeGrid::Clone(RemapDir& remap) {
    MaxJSProbeGrid* copy = new MaxJSProbeGrid();
    BaseClone(this, copy, remap);
    copy->ReplaceReference(0, remap.CloneRef(pblock));
    return copy;
}

// Click-to-place creation; size/divisions are set in the Modify panel (spinners) or
// by transforming the box in the viewport.
class ProbeGridCreateCB : public CreateMouseCallBack {
public:
    int proc(ViewExp* vpt, int msg, int point, int, IPoint2 m, Matrix3& mat) override {
        if (msg == MOUSE_POINT && point == 0) { mat.SetTrans(vpt->SnapPoint(m, m, nullptr)); return CREATE_STOP; }
        if (msg == MOUSE_ABORT) return CREATE_ABORT;
        return CREATE_CONTINUE;
    }
};
static ProbeGridCreateCB g_probeGridCreateCB;
CreateMouseCallBack* MaxJSProbeGrid::GetCreateMouseCallBack() { return &g_probeGridCreateCB; }

void* MaxJSProbeGridClassDesc::Create(BOOL) { return new MaxJSProbeGrid(); }

static ParamBlockDesc2 g_probeGridPB(
    threejs_probegrid_params, _T("HALO-GI Probe Grid"), IDS_THREEJS_PROBEGRID_PARAMS, &g_probeGridDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI, 0,
    IDD_THREEJS_PROBEGRID, IDS_THREEJS_PROBEGRID_PARAMS, 0, 0, nullptr,
    pg_length, _T("length"), TYPE_WORLD, P_ANIMATABLE, 0,
        p_default, 100.0f, p_range, 0.01f, 1.0e9f,
        p_ui, TYPE_SPINNER, EDITTYPE_UNIVERSE, IDC_PG_LEN_EDIT, IDC_PG_LEN_SPIN, 1.0f,
        p_end,
    pg_width, _T("width"), TYPE_WORLD, P_ANIMATABLE, 0,
        p_default, 100.0f, p_range, 0.01f, 1.0e9f,
        p_ui, TYPE_SPINNER, EDITTYPE_UNIVERSE, IDC_PG_WID_EDIT, IDC_PG_WID_SPIN, 1.0f,
        p_end,
    pg_height, _T("height"), TYPE_WORLD, P_ANIMATABLE, 0,
        p_default, 100.0f, p_range, 0.01f, 1.0e9f,
        p_ui, TYPE_SPINNER, EDITTYPE_UNIVERSE, IDC_PG_HGT_EDIT, IDC_PG_HGT_SPIN, 1.0f,
        p_end,
    pg_div_x, _T("divX"), TYPE_INT, 0, 0,
        p_default, 12, p_range, 2, 64,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_PG_DIVX_EDIT, IDC_PG_DIVX_SPIN, 1.0f,
        p_end,
    pg_div_y, _T("divY"), TYPE_INT, 0, 0,
        p_default, 6, p_range, 2, 64,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_PG_DIVY_EDIT, IDC_PG_DIVY_SPIN, 1.0f,
        p_end,
    pg_div_z, _T("divZ"), TYPE_INT, 0, 0,
        p_default, 12, p_range, 2, 64,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_PG_DIVZ_EDIT, IDC_PG_DIVZ_SPIN, 1.0f,
        p_end,
    pg_enabled, _T("enabled"), TYPE_BOOL, 0, 0,
        p_default, TRUE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_PG_ENABLED,
        p_end,
    p_end
);

} // namespace

bool IsThreeJSProbeGridClassID(const Class_ID& cid) {
    return cid == THREEJS_PROBE_GRID_CLASS_ID;
}

bool GetThreeJSProbeGridInfo(Object* obj, float dims[3], int div[3], bool& enabled) {
    if (!obj || !IsThreeJSProbeGridClassID(obj->ClassID())) return false;
    IParamBlock2* pb = obj->GetParamBlockByID(threejs_probegrid_params);
    if (!pb) return false;
    const TimeValue t = GetCOREInterface()->GetTime();
    dims[0] = pb->GetFloat(pg_length, t);
    dims[1] = pb->GetFloat(pg_width, t);
    dims[2] = pb->GetFloat(pg_height, t);
    div[0] = pb->GetInt(pg_div_x, t);
    div[1] = pb->GetInt(pg_div_y, t);
    div[2] = pb->GetInt(pg_div_z, t);
    enabled = pb->GetInt(pg_enabled, t) != 0;
    return true;
}

ClassDesc2* GetThreeJSProbeGridDesc() { return &g_probeGridDesc; }
