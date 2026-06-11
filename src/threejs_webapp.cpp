#include "threejs_webapp.h"
#include "threejs_webapp_res.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <simpobj.h>
#include <plugapi.h>
#include <maxapi.h>
#include <commdlg.h>

extern HINSTANCE hInstance;

namespace {

class ThreeJSWebAppOrigin;
static ParamBlockDesc2* GetWebAppParamDesc();

class ThreeJSWebAppClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override;
    const TCHAR* ClassName() override { return _T("WebApp Animator"); }
    const TCHAR* NonLocalizedClassName() override { return _T("WebApp Animator"); }
    SClass_ID SuperClassID() override { return GEOMOBJECT_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_WEBAPP_CLASS_ID; }
    const TCHAR* Category() override { return _T("max.js"); }
    const TCHAR* InternalName() override { return _T("ThreeJSWebAppAnimator"); }
    HINSTANCE HInstance() override { return hInstance; }
};

class ThreeJSWebAppDlgProc : public ParamMap2UserDlgProc {
public:
    explicit ThreeJSWebAppDlgProc(ThreeJSWebAppOrigin* object) : object_(object) {}

    INT_PTR DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) override;
    void DeleteThis() override { delete this; }

private:
    void RefreshStringFields(HWND hWnd, IParamMap2* map) const;
    void CommitStringField(HWND hWnd, IParamMap2* map, int ctrlId, ParamID param) const;

    ThreeJSWebAppOrigin* object_ = nullptr;
};

class ThreeJSWebAppCreateCB : public CreateMouseCallBack {
public:
    void SetObj(ThreeJSWebAppOrigin* object) { object_ = object; }
    int proc(ViewExp* vpt, int msg, int point, int flags, IPoint2 m, Matrix3& mat) override;

private:
    ThreeJSWebAppOrigin* object_ = nullptr;
};

class ThreeJSWebAppOrigin : public SimpleObject2 {
public:
    explicit ThreeJSWebAppOrigin(BOOL loading) {
        GetThreeJSWebAppDesc()->MakeAutoParamBlocks(this);
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_WEBAPP_CLASS_ID; }
    SClass_ID SuperClassID() override { return GEOMOBJECT_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("WebApp Animator"); }
    const TCHAR* GetObjectName(bool localized) const override { return _T("WebApp Animator"); }

    void BuildMesh(TimeValue t) override;
    BOOL OKtoDisplay(TimeValue t) override;
    void InvalidateUI() override;
    RefTargetHandle Clone(RemapDir& remap) override;
    CreateMouseCallBack* GetCreateMouseCallBack() override;
    void BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) override;
    void EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) override;

    void BrowseForPage(HWND owner);

private:
    float GetDisplaySize(TimeValue t) const;
    float GetAspect() const;
};

static ThreeJSWebAppClassDesc g_webappDesc;
static ThreeJSWebAppCreateCB g_webappCreateCB;

// IDC → string-param mapping for the manually-bound edit fields (TYPE_STRING
// does not play well with TYPE_EDITBOX auto-binding; same approach as the
// glTF display-name field).
struct StringFieldBinding { int ctrlId; ParamID param; };
static const StringFieldBinding kWebAppStringFields[] = {
    { IDC_WEBAPP_URL_EDIT, pw_url },
    { IDC_WEBAPP_NAME1, pw_param1_name },
    { IDC_WEBAPP_NAME2, pw_param2_name },
    { IDC_WEBAPP_NAME3, pw_param3_name },
    { IDC_WEBAPP_NAME4, pw_param4_name },
    { IDC_WEBAPP_NAME5, pw_param5_name },
    { IDC_WEBAPP_NAME6, pw_param6_name },
    { IDC_WEBAPP_NAME7, pw_param7_name },
    { IDC_WEBAPP_NAME8, pw_param8_name },
    { IDC_WEBAPP_NAME9, pw_param9_name },
    { IDC_WEBAPP_NAME10, pw_param10_name },
    { IDC_WEBAPP_NAME11, pw_param11_name },
    { IDC_WEBAPP_NAME12, pw_param12_name },
    { IDC_WEBAPP_NAME13, pw_param13_name },
    { IDC_WEBAPP_NAME14, pw_param14_name },
    { IDC_WEBAPP_NAME15, pw_param15_name },
    { IDC_WEBAPP_NAME16, pw_param16_name },
    { IDC_WEBAPP_NAME17, pw_param17_name },
    { IDC_WEBAPP_NAME18, pw_param18_name },
    { IDC_WEBAPP_NAME19, pw_param19_name },
    { IDC_WEBAPP_NAME20, pw_param20_name },
    { IDC_WEBAPP_NAME21, pw_param21_name },
    { IDC_WEBAPP_NAME22, pw_param22_name },
    { IDC_WEBAPP_NAME23, pw_param23_name },
    { IDC_WEBAPP_NAME24, pw_param24_name },
    { IDC_WEBAPP_NAME25, pw_param25_name },
    { IDC_WEBAPP_NAME26, pw_param26_name },
    { IDC_WEBAPP_NAME27, pw_param27_name },
    { IDC_WEBAPP_NAME28, pw_param28_name },
    { IDC_WEBAPP_NAME29, pw_param29_name },
    { IDC_WEBAPP_NAME30, pw_param30_name },
    { IDC_WEBAPP_NAME31, pw_param31_name },
    { IDC_WEBAPP_NAME32, pw_param32_name },
};

void* ThreeJSWebAppClassDesc::Create(BOOL loading) {
    return new ThreeJSWebAppOrigin(loading);
}

INT_PTR ThreeJSWebAppDlgProc::DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (map) {
        object_ = static_cast<ThreeJSWebAppOrigin*>(map->GetParamBlock()->GetOwner());
    }

    switch (msg) {
        case WM_INITDIALOG:
            RefreshStringFields(hWnd, map);
            return TRUE;

        case WM_COMMAND: {
            const int ctrlId = LOWORD(wParam);
            if (ctrlId == IDC_WEBAPP_BROWSE) {
                if (object_) object_->BrowseForPage(hWnd);
                RefreshStringFields(hWnd, map);
                return TRUE;
            }
            if (HIWORD(wParam) == EN_KILLFOCUS) {
                for (const auto& field : kWebAppStringFields) {
                    if (field.ctrlId == ctrlId) {
                        CommitStringField(hWnd, map, field.ctrlId, field.param);
                        return TRUE;
                    }
                }
            }
            break;
        }

        default:
            break;
    }

    return FALSE;
}

void ThreeJSWebAppDlgProc::RefreshStringFields(HWND hWnd, IParamMap2* map) const {
    if (!map) return;
    IParamBlock2* pb = map->GetParamBlock();
    if (!pb) return;
    for (const auto& field : kWebAppStringFields) {
        const MCHAR* value = pb->GetStr(field.param);
        SetWindowTextW(GetDlgItem(hWnd, field.ctrlId), value ? value : L"");
    }
}

void ThreeJSWebAppDlgProc::CommitStringField(HWND hWnd, IParamMap2* map, int ctrlId, ParamID param) const {
    if (!map) return;
    IParamBlock2* pb = map->GetParamBlock();
    if (!pb) return;

    wchar_t buffer[1024] = {};
    GetWindowTextW(GetDlgItem(hWnd, ctrlId), buffer, 1023);

    const MCHAR* current = pb->GetStr(param);
    if (current && wcscmp(current, buffer) == 0) return;

    pb->SetValue(param, 0, buffer);
    if (object_) {
        object_->NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
    }
    Interface* ip = GetCOREInterface();
    if (ip) ip->RedrawViews(ip->GetTime());
}

int ThreeJSWebAppCreateCB::proc(ViewExp* vpt, int msg, int point, int flags, IPoint2 m, Matrix3& mat) {
    if (!vpt || !vpt->IsAlive() || !object_) return CREATE_ABORT;

    if (msg == MOUSE_FREEMOVE) {
        vpt->SnapPreview(m, m, nullptr, SNAP_IN_3D);
    }

    if (msg == MOUSE_POINT || msg == MOUSE_MOVE) {
        if (point == 0) {
            mat.SetTrans(vpt->SnapPoint(m, m, nullptr, SNAP_IN_3D));
            if (msg == MOUSE_POINT) return CREATE_STOP;
        }
        return TRUE;
    }

    if (msg == MOUSE_ABORT) {
        return CREATE_ABORT;
    }

    return TRUE;
}

float ThreeJSWebAppOrigin::GetDisplaySize(TimeValue t) const {
    const float size = pblock2 ? pblock2->GetFloat(pw_display_size, t) : 50.0f;
    return size > 0.001f ? size : 0.001f;
}

float ThreeJSWebAppOrigin::GetAspect() const {
    const int w = pblock2 ? pblock2->GetInt(pw_width) : 1280;
    const int h = pblock2 ? pblock2->GetInt(pw_height) : 720;
    if (w <= 0 || h <= 0) return 9.0f / 16.0f;
    return static_cast<float>(h) / static_cast<float>(w);
}

// Upright panel in the local XZ plane facing -Y. This matches the viewer,
// which composes the synced node matrix with a +90° X rotation so the DOM
// plane stands up and faces the Max front view.
void ThreeJSWebAppOrigin::BuildMesh(TimeValue t) {
    const float w = GetDisplaySize(t);
    const float h = w * GetAspect();
    const float hw = w * 0.5f;
    const float hh = h * 0.5f;

    mesh.setNumVerts(7);
    mesh.setNumFaces(3);

    mesh.setVert(0, Point3(-hw, 0.0f, -hh));
    mesh.setVert(1, Point3(hw, 0.0f, -hh));
    mesh.setVert(2, Point3(hw, 0.0f, hh));
    mesh.setVert(3, Point3(-hw, 0.0f, hh));
    // Orientation tab on the top edge
    mesh.setVert(4, Point3(-w * 0.08f, 0.0f, hh));
    mesh.setVert(5, Point3(w * 0.08f, 0.0f, hh));
    mesh.setVert(6, Point3(0.0f, 0.0f, hh + w * 0.08f));

    mesh.faces[0].setVerts(0, 1, 2);
    mesh.faces[0].setEdgeVisFlags(1, 1, 0);
    mesh.faces[0].setSmGroup(0);
    mesh.faces[1].setVerts(0, 2, 3);
    mesh.faces[1].setEdgeVisFlags(0, 1, 1);
    mesh.faces[1].setSmGroup(0);
    mesh.faces[2].setVerts(4, 5, 6);
    mesh.faces[2].setEdgeVisFlags(1, 1, 1);
    mesh.faces[2].setSmGroup(0);

    mesh.InvalidateGeomCache();
}

BOOL ThreeJSWebAppOrigin::OKtoDisplay(TimeValue t) {
    return GetDisplaySize(t) > 0.0f;
}

void ThreeJSWebAppOrigin::InvalidateUI() {
    GetWebAppParamDesc()->InvalidateUI(pblock2 ? pblock2->LastNotifyParamID() : pw_display_size);
}

RefTargetHandle ThreeJSWebAppOrigin::Clone(RemapDir& remap) {
    ThreeJSWebAppOrigin* obj = new ThreeJSWebAppOrigin(FALSE);
    obj->ReplaceReference(0, remap.CloneRef(pblock2));
    BaseClone(this, obj, remap);
    obj->ivalid.SetEmpty();
    return obj;
}

CreateMouseCallBack* ThreeJSWebAppOrigin::GetCreateMouseCallBack() {
    g_webappCreateCB.SetObj(this);
    return &g_webappCreateCB;
}

void ThreeJSWebAppOrigin::BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) {
    g_webappDesc.BeginEditParams(ip, this, flags, prev);
    GetWebAppParamDesc()->SetUserDlgProc(new ThreeJSWebAppDlgProc(this));
}

void ThreeJSWebAppOrigin::EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) {
    GetWebAppParamDesc()->SetUserDlgProc(nullptr);
    g_webappDesc.EndEditParams(ip, this, flags, next);
}

void ThreeJSWebAppOrigin::BrowseForPage(HWND owner) {
    wchar_t filePath[MAX_PATH] = {};
    if (pblock2) {
        const MCHAR* current = pblock2->GetStr(pw_url);
        // Only prefill when the current value looks like a disk path —
        // GetOpenFileName rejects URLs in lpstrFile.
        if (current && current[0] && current[1] == L':') {
            wcsncpy_s(filePath, current, _TRUNCATE);
        }
    }

    OPENFILENAMEW ofn = {};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = owner;
    ofn.lpstrFile = filePath;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrTitle = L"Load Web Page";
    ofn.lpstrFilter =
        L"Web Pages (*.html;*.htm)\0*.html;*.htm\0"
        L"All Files (*.*)\0*.*\0\0";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY;

    if (!GetOpenFileNameW(&ofn) || !pblock2) return;

    pblock2->SetValue(pw_url, 0, filePath);
    NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
    InvalidateUI();

    Interface* ip = GetCOREInterface();
    if (ip) ip->RedrawViews(ip->GetTime());
}

static ParamBlockDesc2 threejs_webapp_param_blk(
    threejs_webapp_params,
    _T("ThreeJSWebAppParameters"),
    IDS_WEBAPP_PARAMS,
    &g_webappDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_WEBAPP, IDS_WEBAPP_PARAMS, 0, 0, nullptr,

    pw_display_size, _T("displaySize"), TYPE_WORLD, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_DISPLAY_SIZE,
        p_default, 50.0f,
        p_range, 0.1f, 1.0e30f,
        p_ui, TYPE_SPINNER, EDITTYPE_UNIVERSE, IDC_WEBAPP_SIZE_EDIT, IDC_WEBAPP_SIZE_SPIN, SPIN_AUTOSCALE,
        p_end,

    pw_url, _T("url"), TYPE_STRING, 0, IDS_WEBAPP_URL,
        p_default, _T(""),
        p_end,

    pw_width, _T("pixelWidth"), TYPE_INT, P_RESET_DEFAULT, IDS_WEBAPP_WIDTH,
        p_default, 1280,
        p_range, 16, 8192,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_WEBAPP_WIDTH_EDIT, IDC_WEBAPP_WIDTH_SPIN, 1.0f,
        p_end,

    pw_height, _T("pixelHeight"), TYPE_INT, P_RESET_DEFAULT, IDS_WEBAPP_HEIGHT,
        p_default, 720,
        p_range, 16, 8192,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_WEBAPP_HEIGHT_EDIT, IDC_WEBAPP_HEIGHT_SPIN, 1.0f,
        p_end,

    pw_opacity, _T("opacity"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_OPACITY,
        p_default, 1.0f,
        p_range, 0.0f, 1.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_OPACITY_EDIT, IDC_WEBAPP_OPACITY_SPIN, 0.01f,
        p_end,

    pw_interactive, _T("interactive"), TYPE_BOOL, P_RESET_DEFAULT, IDS_WEBAPP_INTERACTIVE,
        p_default, FALSE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_WEBAPP_INTERACTIVE,
        p_end,

    pw_presentation, _T("presentation"), TYPE_INT, P_RESET_DEFAULT, IDS_WEBAPP_PRESENTATION,
        p_default, 0,
        p_range, 0, 1,
        p_ui, TYPE_RADIO, 2, IDC_WEBAPP_PRES_CSS3D, IDC_WEBAPP_PRES_TEXTURE,
        p_end,

    pw_param1, _T("param1"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM1,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL1, IDC_WEBAPP_VALSPIN1, 0.01f,
        p_end,
    pw_param2, _T("param2"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM2,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL2, IDC_WEBAPP_VALSPIN2, 0.01f,
        p_end,
    pw_param3, _T("param3"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM3,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL3, IDC_WEBAPP_VALSPIN3, 0.01f,
        p_end,
    pw_param4, _T("param4"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM4,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL4, IDC_WEBAPP_VALSPIN4, 0.01f,
        p_end,
    pw_param5, _T("param5"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM5,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL5, IDC_WEBAPP_VALSPIN5, 0.01f,
        p_end,
    pw_param6, _T("param6"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM6,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL6, IDC_WEBAPP_VALSPIN6, 0.01f,
        p_end,
    pw_param7, _T("param7"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM7,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL7, IDC_WEBAPP_VALSPIN7, 0.01f,
        p_end,
    pw_param8, _T("param8"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM8,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL8, IDC_WEBAPP_VALSPIN8, 0.01f,
        p_end,

    pw_param1_name, _T("param1Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM1_NAME,
        p_default, _T(""),
        p_end,
    pw_param2_name, _T("param2Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM2_NAME,
        p_default, _T(""),
        p_end,
    pw_param3_name, _T("param3Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM3_NAME,
        p_default, _T(""),
        p_end,
    pw_param4_name, _T("param4Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM4_NAME,
        p_default, _T(""),
        p_end,
    pw_param5_name, _T("param5Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM5_NAME,
        p_default, _T(""),
        p_end,
    pw_param6_name, _T("param6Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM6_NAME,
        p_default, _T(""),
        p_end,
    pw_param7_name, _T("param7Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM7_NAME,
        p_default, _T(""),
        p_end,
    pw_param8_name, _T("param8Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM8_NAME,
        p_default, _T(""),
        p_end,

    pw_depth_occlude, _T("depthOcclude"), TYPE_BOOL, P_RESET_DEFAULT, IDS_WEBAPP_DEPTH_OCCLUDE,
        p_default, FALSE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_WEBAPP_DEPTH_OCCLUDE,
        p_end,

    pw_layer_count, _T("layerCount"), TYPE_INT, P_RESET_DEFAULT, IDS_WEBAPP_LAYER_COUNT,
        p_default, 1,
        p_range, 1, 8,
        p_ui, TYPE_SPINNER, EDITTYPE_INT, IDC_WEBAPP_LAYERS_EDIT, IDC_WEBAPP_LAYERS_SPIN, 1.0f,
        p_end,

    pw_layer_gap, _T("layerGap"), TYPE_WORLD, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_LAYER_GAP,
        p_default, 5.0f,
        p_range, -1.0e30f, 1.0e30f,
        p_ui, TYPE_SPINNER, EDITTYPE_UNIVERSE, IDC_WEBAPP_GAP_EDIT, IDC_WEBAPP_GAP_SPIN, SPIN_AUTOSCALE,
        p_end,

    pw_param9, _T("param9"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM9,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL9, IDC_WEBAPP_VALSPIN9, 0.01f,
        p_end,
    pw_param10, _T("param10"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM10,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL10, IDC_WEBAPP_VALSPIN10, 0.01f,
        p_end,
    pw_param11, _T("param11"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM11,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL11, IDC_WEBAPP_VALSPIN11, 0.01f,
        p_end,
    pw_param12, _T("param12"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM12,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL12, IDC_WEBAPP_VALSPIN12, 0.01f,
        p_end,
    pw_param13, _T("param13"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM13,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL13, IDC_WEBAPP_VALSPIN13, 0.01f,
        p_end,
    pw_param14, _T("param14"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM14,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL14, IDC_WEBAPP_VALSPIN14, 0.01f,
        p_end,
    pw_param15, _T("param15"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM15,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL15, IDC_WEBAPP_VALSPIN15, 0.01f,
        p_end,
    pw_param16, _T("param16"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM16,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL16, IDC_WEBAPP_VALSPIN16, 0.01f,
        p_end,

    pw_param9_name, _T("param9Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM9_NAME,
        p_default, _T(""),
        p_end,
    pw_param10_name, _T("param10Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM10_NAME,
        p_default, _T(""),
        p_end,
    pw_param11_name, _T("param11Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM11_NAME,
        p_default, _T(""),
        p_end,
    pw_param12_name, _T("param12Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM12_NAME,
        p_default, _T(""),
        p_end,
    pw_param13_name, _T("param13Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM13_NAME,
        p_default, _T(""),
        p_end,
    pw_param14_name, _T("param14Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM14_NAME,
        p_default, _T(""),
        p_end,
    pw_param15_name, _T("param15Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM15_NAME,
        p_default, _T(""),
        p_end,
    pw_param16_name, _T("param16Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM16_NAME,
        p_default, _T(""),
        p_end,

    pw_param17, _T("param17"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM17,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL17, IDC_WEBAPP_VALSPIN17, 0.01f,
        p_end,
    pw_param18, _T("param18"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM18,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL18, IDC_WEBAPP_VALSPIN18, 0.01f,
        p_end,
    pw_param19, _T("param19"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM19,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL19, IDC_WEBAPP_VALSPIN19, 0.01f,
        p_end,
    pw_param20, _T("param20"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM20,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL20, IDC_WEBAPP_VALSPIN20, 0.01f,
        p_end,
    pw_param21, _T("param21"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM21,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL21, IDC_WEBAPP_VALSPIN21, 0.01f,
        p_end,
    pw_param22, _T("param22"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM22,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL22, IDC_WEBAPP_VALSPIN22, 0.01f,
        p_end,
    pw_param23, _T("param23"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM23,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL23, IDC_WEBAPP_VALSPIN23, 0.01f,
        p_end,
    pw_param24, _T("param24"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM24,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL24, IDC_WEBAPP_VALSPIN24, 0.01f,
        p_end,
    pw_param25, _T("param25"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM25,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL25, IDC_WEBAPP_VALSPIN25, 0.01f,
        p_end,
    pw_param26, _T("param26"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM26,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL26, IDC_WEBAPP_VALSPIN26, 0.01f,
        p_end,
    pw_param27, _T("param27"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM27,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL27, IDC_WEBAPP_VALSPIN27, 0.01f,
        p_end,
    pw_param28, _T("param28"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM28,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL28, IDC_WEBAPP_VALSPIN28, 0.01f,
        p_end,
    pw_param29, _T("param29"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM29,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL29, IDC_WEBAPP_VALSPIN29, 0.01f,
        p_end,
    pw_param30, _T("param30"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM30,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL30, IDC_WEBAPP_VALSPIN30, 0.01f,
        p_end,
    pw_param31, _T("param31"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM31,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL31, IDC_WEBAPP_VALSPIN31, 0.01f,
        p_end,
    pw_param32, _T("param32"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_WEBAPP_PARAM32,
        p_default, 0.0f,
        p_range, -1.0e6f, 1.0e6f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_WEBAPP_VAL32, IDC_WEBAPP_VALSPIN32, 0.01f,
        p_end,

    pw_param17_name, _T("param17Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM17_NAME,
        p_default, _T(""),
        p_end,
    pw_param18_name, _T("param18Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM18_NAME,
        p_default, _T(""),
        p_end,
    pw_param19_name, _T("param19Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM19_NAME,
        p_default, _T(""),
        p_end,
    pw_param20_name, _T("param20Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM20_NAME,
        p_default, _T(""),
        p_end,
    pw_param21_name, _T("param21Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM21_NAME,
        p_default, _T(""),
        p_end,
    pw_param22_name, _T("param22Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM22_NAME,
        p_default, _T(""),
        p_end,
    pw_param23_name, _T("param23Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM23_NAME,
        p_default, _T(""),
        p_end,
    pw_param24_name, _T("param24Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM24_NAME,
        p_default, _T(""),
        p_end,
    pw_param25_name, _T("param25Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM25_NAME,
        p_default, _T(""),
        p_end,
    pw_param26_name, _T("param26Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM26_NAME,
        p_default, _T(""),
        p_end,
    pw_param27_name, _T("param27Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM27_NAME,
        p_default, _T(""),
        p_end,
    pw_param28_name, _T("param28Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM28_NAME,
        p_default, _T(""),
        p_end,
    pw_param29_name, _T("param29Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM29_NAME,
        p_default, _T(""),
        p_end,
    pw_param30_name, _T("param30Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM30_NAME,
        p_default, _T(""),
        p_end,
    pw_param31_name, _T("param31Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM31_NAME,
        p_default, _T(""),
        p_end,
    pw_param32_name, _T("param32Name"), TYPE_STRING, 0, IDS_WEBAPP_PARAM32_NAME,
        p_default, _T(""),
        p_end,

    p_end
);

static ParamBlockDesc2* GetWebAppParamDesc() {
    return &threejs_webapp_param_blk;
}

} // namespace

bool IsThreeJSWebAppClassID(const Class_ID& cid) {
    return cid == THREEJS_WEBAPP_CLASS_ID;
}

ClassDesc2* GetThreeJSWebAppDesc() {
    return &g_webappDesc;
}
