#include "threejs_splat.h"
#include "threejs_splat_res.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <simpobj.h>
#include <plugapi.h>
#include <maxapi.h>
#include <commdlg.h>

extern HINSTANCE hInstance;

namespace {

class ThreeJSSplatOrigin;
static ParamBlockDesc2* GetSplatParamDesc();

class ThreeJSSplatClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override;
    const TCHAR* ClassName() override { return _T("Splat Origin"); }
    const TCHAR* NonLocalizedClassName() override { return _T("Splat Origin"); }
    SClass_ID SuperClassID() override { return GEOMOBJECT_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_SPLAT_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSSplatOrigin"); }
    HINSTANCE HInstance() override { return hInstance; }
};

class ThreeJSSplatDlgProc : public ParamMap2UserDlgProc {
public:
    explicit ThreeJSSplatDlgProc(ThreeJSSplatOrigin* object) : object_(object) {}

    INT_PTR DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) override;
    void DeleteThis() override { delete this; }

private:
    void UpdatePathText(HWND hWnd, IParamMap2* map) const;

    ThreeJSSplatOrigin* object_ = nullptr;
};

class ThreeJSSplatCreateCB : public CreateMouseCallBack {
public:
    void SetObj(ThreeJSSplatOrigin* object) { object_ = object; }
    int proc(ViewExp* vpt, int msg, int point, int flags, IPoint2 m, Matrix3& mat) override;

private:
    ThreeJSSplatOrigin* object_ = nullptr;
};

class ThreeJSSplatOrigin : public SimpleObject2 {
public:
    explicit ThreeJSSplatOrigin(BOOL loading) {
        GetThreeJSSplatDesc()->MakeAutoParamBlocks(this);
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_SPLAT_CLASS_ID; }
    SClass_ID SuperClassID() override { return GEOMOBJECT_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("Splat Origin"); }
    const TCHAR* GetObjectName(bool localized) const override { return _T("Splat Origin"); }

    void BuildMesh(TimeValue t) override;
    BOOL OKtoDisplay(TimeValue t) override;
    void InvalidateUI() override;
    RefTargetHandle Clone(RemapDir& remap) override;
    CreateMouseCallBack* GetCreateMouseCallBack() override;
    void BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) override;
    void EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) override;

    void BrowseForSplatFile(HWND owner);
    void ClearSplatFile();

private:
    float GetDisplaySize(TimeValue t) const;
};

static ThreeJSSplatClassDesc g_splatDesc;
static ThreeJSSplatCreateCB g_splatCreateCB;

void* ThreeJSSplatClassDesc::Create(BOOL loading) {
    return new ThreeJSSplatOrigin(loading);
}

INT_PTR ThreeJSSplatDlgProc::DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (map) {
        object_ = static_cast<ThreeJSSplatOrigin*>(map->GetParamBlock()->GetOwner());
    }

    switch (msg) {
        case WM_INITDIALOG:
            UpdatePathText(hWnd, map);
            return TRUE;

        case WM_COMMAND:
            switch (LOWORD(wParam)) {
                case IDC_SPLAT_LOAD:
                    if (object_) object_->BrowseForSplatFile(hWnd);
                    UpdatePathText(hWnd, map);
                    return TRUE;
                case IDC_SPLAT_CLEAR:
                    if (object_) object_->ClearSplatFile();
                    UpdatePathText(hWnd, map);
                    return TRUE;
                default:
                    break;
            }
            break;

        default:
            break;
    }

    return FALSE;
}

void ThreeJSSplatDlgProc::UpdatePathText(HWND hWnd, IParamMap2* map) const {
    if (!map) return;

    IParamBlock2* pb = map->GetParamBlock();
    const MCHAR* filePath = pb ? pb->GetStr(ps_splat_file) : nullptr;
    const wchar_t* label = (filePath && filePath[0]) ? filePath : L"(none)";
    SetWindowTextW(GetDlgItem(hWnd, IDC_SPLAT_PATH), label);
}

int ThreeJSSplatCreateCB::proc(ViewExp* vpt, int msg, int point, int flags, IPoint2 m, Matrix3& mat) {
    if (!vpt || !vpt->IsAlive() || !object_) return CREATE_ABORT;

    if (msg == MOUSE_FREEMOVE) {
        vpt->SnapPreview(m, m, nullptr, SNAP_IN_3D);
    }

    if (msg == MOUSE_POINT || msg == MOUSE_MOVE) {
        if (point == 0) {
            mat.SetTrans(vpt->SnapPoint(m, m, nullptr, SNAP_IN_3D));
            if (msg == MOUSE_POINT) {
                return CREATE_STOP;
            }
        }
        return TRUE;
    }

    if (msg == MOUSE_ABORT) {
        return CREATE_ABORT;
    }

    return TRUE;
}

float ThreeJSSplatOrigin::GetDisplaySize(TimeValue t) const {
    const float size = pblock2 ? pblock2->GetFloat(ps_display_size, t) : 25.0f;
    return size > 0.001f ? size : 0.001f;
}

void ThreeJSSplatOrigin::BuildMesh(TimeValue t) {
    const float size = GetDisplaySize(t) * 0.5f;

    mesh.setNumVerts(6);
    mesh.setNumFaces(8);

    mesh.setVert(0, Point3(0.0f, 0.0f, size));
    mesh.setVert(1, Point3(size, 0.0f, 0.0f));
    mesh.setVert(2, Point3(0.0f, size, 0.0f));
    mesh.setVert(3, Point3(-size, 0.0f, 0.0f));
    mesh.setVert(4, Point3(0.0f, -size, 0.0f));
    mesh.setVert(5, Point3(0.0f, 0.0f, -size));

    const int faces[8][3] = {
        {0, 1, 2}, {0, 2, 3}, {0, 3, 4}, {0, 4, 1},
        {5, 2, 1}, {5, 3, 2}, {5, 4, 3}, {5, 1, 4}
    };

    for (int i = 0; i < 8; ++i) {
        mesh.faces[i].setVerts(faces[i][0], faces[i][1], faces[i][2]);
        mesh.faces[i].setEdgeVisFlags(1, 1, 1);
        mesh.faces[i].setSmGroup(0);
    }

    mesh.InvalidateGeomCache();
}

BOOL ThreeJSSplatOrigin::OKtoDisplay(TimeValue t) {
    return GetDisplaySize(t) > 0.0f;
}

void ThreeJSSplatOrigin::InvalidateUI() {
    GetSplatParamDesc()->InvalidateUI(pblock2 ? pblock2->LastNotifyParamID() : ps_display_size);
}

RefTargetHandle ThreeJSSplatOrigin::Clone(RemapDir& remap) {
    ThreeJSSplatOrigin* obj = new ThreeJSSplatOrigin(FALSE);
    obj->ReplaceReference(0, remap.CloneRef(pblock2));
    BaseClone(this, obj, remap);
    obj->ivalid.SetEmpty();
    return obj;
}

CreateMouseCallBack* ThreeJSSplatOrigin::GetCreateMouseCallBack() {
    g_splatCreateCB.SetObj(this);
    return &g_splatCreateCB;
}

void ThreeJSSplatOrigin::BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) {
    SimpleObject2::BeginEditParams(ip, flags, prev);
    GetSplatParamDesc()->SetUserDlgProc(new ThreeJSSplatDlgProc(this));
}

void ThreeJSSplatOrigin::EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) {
    GetSplatParamDesc()->SetUserDlgProc(nullptr);
    SimpleObject2::EndEditParams(ip, flags, next);
}

void ThreeJSSplatOrigin::BrowseForSplatFile(HWND owner) {
    wchar_t filePath[MAX_PATH] = {};
    if (pblock2) {
        const MCHAR* current = pblock2->GetStr(ps_splat_file);
        if (current && current[0]) {
            wcsncpy_s(filePath, current, _TRUNCATE);
        }
    }

    OPENFILENAMEW ofn = {};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = owner;
    ofn.lpstrFile = filePath;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrTitle = L"Load Gaussian Splat";
    ofn.lpstrFilter =
        L"Gaussian Splats (*.splat;*.ply;*.ksplat;*.spz)\0*.splat;*.ply;*.ksplat;*.spz\0"
        L"All Files (*.*)\0*.*\0\0";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY;

    if (!GetOpenFileNameW(&ofn) || !pblock2) return;

    pblock2->SetValue(ps_splat_file, 0, filePath);
    NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
    InvalidateUI();

    Interface* ip = GetCOREInterface();
    if (ip) ip->RedrawViews(ip->GetTime());
}

void ThreeJSSplatOrigin::ClearSplatFile() {
    if (!pblock2) return;
    pblock2->SetValue(ps_splat_file, 0, _T(""));
    NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
    InvalidateUI();

    Interface* ip = GetCOREInterface();
    if (ip) ip->RedrawViews(ip->GetTime());
}

static ParamBlockDesc2 threejs_splat_param_blk(
    threejs_splat_params,
    _T("ThreeJSSplatParameters"),
    IDS_SPLAT_PARAMS,
    &g_splatDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_SPLAT, IDS_SPLAT_PARAMS, 0, 0, nullptr,

    ps_display_size, _T("displaySize"), TYPE_WORLD, P_ANIMATABLE + P_RESET_DEFAULT, IDS_SPLAT_DISPLAY_SIZE,
        p_default, 25.0f,
        p_range, 0.1f, 1.0e30f,
        p_ui, TYPE_SPINNER, EDITTYPE_UNIVERSE, IDC_SPLAT_SIZE_EDIT, IDC_SPLAT_SIZE_SPIN, SPIN_AUTOSCALE,
        p_end,

    ps_splat_file, _T("splatFile"), TYPE_FILENAME, 0, IDS_SPLAT_FILE,
        p_default, _T(""),
        p_end,

    p_end
);

static ParamBlockDesc2* GetSplatParamDesc() {
    return &threejs_splat_param_blk;
}

} // namespace

bool IsThreeJSSplatClassID(const Class_ID& cid) {
    return cid == THREEJS_SPLAT_CLASS_ID;
}

ClassDesc2* GetThreeJSSplatDesc() {
    return &g_splatDesc;
}
