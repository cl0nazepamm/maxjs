#include "threejs_gltf.h"
#include "threejs_gltf_res.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <simpobj.h>
#include <plugapi.h>
#include <maxapi.h>
#include <commdlg.h>

extern HINSTANCE hInstance;

namespace {

class ThreeJSGLTFOrigin;
static ParamBlockDesc2* GetGLTFParamDesc();

class ThreeJSGLTFClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override;
    const TCHAR* ClassName() override { return _T("glTF Origin"); }
    const TCHAR* NonLocalizedClassName() override { return _T("glTF Origin"); }
    SClass_ID SuperClassID() override { return GEOMOBJECT_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_GLTF_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSGLTFOrigin"); }
    HINSTANCE HInstance() override { return hInstance; }
};

class ThreeJSGLTFDlgProc : public ParamMap2UserDlgProc {
public:
    explicit ThreeJSGLTFDlgProc(ThreeJSGLTFOrigin* object) : object_(object) {}

    INT_PTR DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) override;
    void DeleteThis() override { delete this; }

private:
    void UpdatePathText(HWND hWnd, IParamMap2* map) const;
    void UpdateDisplayNameText(HWND hWnd, IParamMap2* map) const;
    void CommitDisplayNameText(HWND hWnd, IParamMap2* map) const;

    ThreeJSGLTFOrigin* object_ = nullptr;
};

class ThreeJSGLTFCreateCB : public CreateMouseCallBack {
public:
    void SetObj(ThreeJSGLTFOrigin* object) { object_ = object; }
    int proc(ViewExp* vpt, int msg, int point, int flags, IPoint2 m, Matrix3& mat) override;

private:
    ThreeJSGLTFOrigin* object_ = nullptr;
};

class ThreeJSGLTFOrigin : public SimpleObject2 {
public:
    explicit ThreeJSGLTFOrigin(BOOL loading) {
        GetThreeJSGLTFDesc()->MakeAutoParamBlocks(this);
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_GLTF_CLASS_ID; }
    SClass_ID SuperClassID() override { return GEOMOBJECT_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("glTF Origin"); }
    const TCHAR* GetObjectName(bool localized) const override { return _T("glTF Origin"); }

    void BuildMesh(TimeValue t) override;
    BOOL OKtoDisplay(TimeValue t) override;
    void InvalidateUI() override;
    RefTargetHandle Clone(RemapDir& remap) override;
    CreateMouseCallBack* GetCreateMouseCallBack() override;
    void BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) override;
    void EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) override;

    void BrowseForGLTFFile(HWND owner);
    void ClearGLTFFile();

private:
    float GetDisplaySize(TimeValue t) const;
};

static ThreeJSGLTFClassDesc g_gltfDesc;
static ThreeJSGLTFCreateCB g_gltfCreateCB;

void* ThreeJSGLTFClassDesc::Create(BOOL loading) {
    return new ThreeJSGLTFOrigin(loading);
}

INT_PTR ThreeJSGLTFDlgProc::DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (map) {
        object_ = static_cast<ThreeJSGLTFOrigin*>(map->GetParamBlock()->GetOwner());
    }

    switch (msg) {
        case WM_INITDIALOG:
            UpdatePathText(hWnd, map);
            UpdateDisplayNameText(hWnd, map);
            return TRUE;

        case WM_COMMAND:
            switch (LOWORD(wParam)) {
                case IDC_GLTF_LOAD:
                    if (object_) object_->BrowseForGLTFFile(hWnd);
                    UpdatePathText(hWnd, map);
                    return TRUE;
                case IDC_GLTF_CLEAR:
                    if (object_) object_->ClearGLTFFile();
                    UpdatePathText(hWnd, map);
                    return TRUE;
                case IDC_GLTF_DISPLAY_NAME_EDIT:
                    // Commit the text when the edit loses focus. Typing in the field
                    // does not route through the Max param block auto-UI (TYPE_STRING
                    // does not play well with TYPE_EDITBOX auto-binding), so we pull
                    // the text manually and SetValue here.
                    if (HIWORD(wParam) == EN_KILLFOCUS) {
                        CommitDisplayNameText(hWnd, map);
                        return TRUE;
                    }
                    break;
                default:
                    break;
            }
            break;

        default:
            break;
    }

    return FALSE;
}

void ThreeJSGLTFDlgProc::UpdatePathText(HWND hWnd, IParamMap2* map) const {
    if (!map) return;

    IParamBlock2* pb = map->GetParamBlock();
    const MCHAR* filePath = pb ? pb->GetStr(pg_gltf_file) : nullptr;
    const wchar_t* label = (filePath && filePath[0]) ? filePath : L"(none)";
    SetWindowTextW(GetDlgItem(hWnd, IDC_GLTF_PATH), label);
}

void ThreeJSGLTFDlgProc::UpdateDisplayNameText(HWND hWnd, IParamMap2* map) const {
    if (!map) return;

    IParamBlock2* pb = map->GetParamBlock();
    const MCHAR* current = pb ? pb->GetStr(pg_display_name) : nullptr;
    SetWindowTextW(GetDlgItem(hWnd, IDC_GLTF_DISPLAY_NAME_EDIT), current ? current : L"");
}

void ThreeJSGLTFDlgProc::CommitDisplayNameText(HWND hWnd, IParamMap2* map) const {
    if (!map) return;
    IParamBlock2* pb = map->GetParamBlock();
    if (!pb) return;

    wchar_t buf[512] = {};
    GetWindowTextW(GetDlgItem(hWnd, IDC_GLTF_DISPLAY_NAME_EDIT), buf, _countof(buf));
    const MCHAR* current = pb->GetStr(pg_display_name);
    if (current && wcscmp(current, buf) == 0) return; // no change

    pb->SetValue(pg_display_name, 0, buf);
    if (object_) object_->NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
}

int ThreeJSGLTFCreateCB::proc(ViewExp* vpt, int msg, int point, int flags, IPoint2 m, Matrix3& mat) {
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

float ThreeJSGLTFOrigin::GetDisplaySize(TimeValue t) const {
    const float size = pblock2 ? pblock2->GetFloat(pg_display_size, t) : 30.0f;
    return size > 0.001f ? size : 0.001f;
}

void ThreeJSGLTFOrigin::BuildMesh(TimeValue t) {
    // Gizmo: a hollow wireframe box + a small origin cross. Non-renderable in JS;
    // the real asset shows up via GLTFLoader in the JS side.
    const float s = GetDisplaySize(t) * 0.5f;

    mesh.setNumVerts(8);
    mesh.setNumFaces(12);

    mesh.setVert(0, Point3(-s, -s, -s));
    mesh.setVert(1, Point3( s, -s, -s));
    mesh.setVert(2, Point3( s,  s, -s));
    mesh.setVert(3, Point3(-s,  s, -s));
    mesh.setVert(4, Point3(-s, -s,  s));
    mesh.setVert(5, Point3( s, -s,  s));
    mesh.setVert(6, Point3( s,  s,  s));
    mesh.setVert(7, Point3(-s,  s,  s));

    const int faces[12][3] = {
        {0, 2, 1}, {0, 3, 2},   // bottom
        {4, 5, 6}, {4, 6, 7},   // top
        {0, 1, 5}, {0, 5, 4},   // front
        {2, 3, 7}, {2, 7, 6},   // back
        {1, 2, 6}, {1, 6, 5},   // right
        {0, 4, 7}, {0, 7, 3},   // left
    };

    for (int i = 0; i < 12; ++i) {
        mesh.faces[i].setVerts(faces[i][0], faces[i][1], faces[i][2]);
        mesh.faces[i].setEdgeVisFlags(1, 1, 1);
        mesh.faces[i].setSmGroup(0);
    }

    mesh.InvalidateGeomCache();
}

BOOL ThreeJSGLTFOrigin::OKtoDisplay(TimeValue t) {
    return GetDisplaySize(t) > 0.0f;
}

void ThreeJSGLTFOrigin::InvalidateUI() {
    GetGLTFParamDesc()->InvalidateUI(pblock2 ? pblock2->LastNotifyParamID() : pg_display_size);
}

RefTargetHandle ThreeJSGLTFOrigin::Clone(RemapDir& remap) {
    ThreeJSGLTFOrigin* obj = new ThreeJSGLTFOrigin(FALSE);
    obj->ReplaceReference(0, remap.CloneRef(pblock2));
    BaseClone(this, obj, remap);
    obj->ivalid.SetEmpty();
    return obj;
}

CreateMouseCallBack* ThreeJSGLTFOrigin::GetCreateMouseCallBack() {
    g_gltfCreateCB.SetObj(this);
    return &g_gltfCreateCB;
}

void ThreeJSGLTFOrigin::BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) {
    g_gltfDesc.BeginEditParams(ip, this, flags, prev);
    GetGLTFParamDesc()->SetUserDlgProc(new ThreeJSGLTFDlgProc(this));
}

void ThreeJSGLTFOrigin::EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) {
    GetGLTFParamDesc()->SetUserDlgProc(nullptr);
    g_gltfDesc.EndEditParams(ip, this, flags, next);
}

void ThreeJSGLTFOrigin::BrowseForGLTFFile(HWND owner) {
    wchar_t filePath[MAX_PATH] = {};
    if (pblock2) {
        const MCHAR* current = pblock2->GetStr(pg_gltf_file);
        if (current && current[0]) {
            wcsncpy_s(filePath, current, _TRUNCATE);
        }
    }

    OPENFILENAMEW ofn = {};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = owner;
    ofn.lpstrFile = filePath;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrTitle = L"Load glTF Model";
    ofn.lpstrFilter =
        L"glTF Models (*.gltf;*.glb)\0*.gltf;*.glb\0"
        L"All Files (*.*)\0*.*\0\0";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY;

    if (!GetOpenFileNameW(&ofn) || !pblock2) return;

    pblock2->SetValue(pg_gltf_file, 0, filePath);
    NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
    InvalidateUI();

    Interface* ip = GetCOREInterface();
    if (ip) ip->RedrawViews(ip->GetTime());
}

void ThreeJSGLTFOrigin::ClearGLTFFile() {
    if (!pblock2) return;
    pblock2->SetValue(pg_gltf_file, 0, _T(""));
    NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
    InvalidateUI();

    Interface* ip = GetCOREInterface();
    if (ip) ip->RedrawViews(ip->GetTime());
}

static ParamBlockDesc2 threejs_gltf_param_blk(
    threejs_gltf_params,
    _T("ThreeJSGLTFParameters"),
    IDS_GLTF_PARAMS,
    &g_gltfDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_GLTF, IDS_GLTF_PARAMS, 0, 0, nullptr,

    pg_display_size, _T("displaySize"), TYPE_WORLD, P_ANIMATABLE + P_RESET_DEFAULT, IDS_GLTF_DISPLAY_SIZE,
        p_default, 30.0f,
        p_range, 0.1f, 1.0e30f,
        p_ui, TYPE_SPINNER, EDITTYPE_UNIVERSE, IDC_GLTF_SIZE_EDIT, IDC_GLTF_SIZE_SPIN, SPIN_AUTOSCALE,
        p_end,

    pg_gltf_file, _T("gltfFile"), TYPE_FILENAME, 0, IDS_GLTF_FILE,
        p_default, _T(""),
        p_end,

    pg_root_scale, _T("rootScale"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_GLTF_ROOT_SCALE,
        p_default, 1.0f,
        p_range, 0.0001f, 10000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_GLTF_SCALE_EDIT, IDC_GLTF_SCALE_SPIN, 0.01f,
        p_end,

    pg_autoplay, _T("autoplay"), TYPE_BOOL, P_RESET_DEFAULT, IDS_GLTF_AUTOPLAY,
        p_default, TRUE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_GLTF_AUTOPLAY,
        p_end,

    pg_display_name, _T("displayName"), TYPE_STRING, 0, IDS_GLTF_DISPLAY_NAME,
        p_default, _T(""),
        p_end,

    p_end
);

static ParamBlockDesc2* GetGLTFParamDesc() {
    return &threejs_gltf_param_blk;
}

} // namespace

bool IsThreeJSGLTFClassID(const Class_ID& cid) {
    return cid == THREEJS_GLTF_CLASS_ID;
}

ClassDesc2* GetThreeJSGLTFDesc() {
    return &g_gltfDesc;
}
