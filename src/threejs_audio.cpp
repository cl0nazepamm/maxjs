#include "threejs_audio.h"
#include "threejs_audio_res.h"

#include <max.h>
#include <iparamb2.h>
#include <iparamm2.h>
#include <simpobj.h>
#include <plugapi.h>
#include <maxapi.h>
#include <commdlg.h>

extern HINSTANCE hInstance;

namespace {

class ThreeJSAudioOrigin;
static ParamBlockDesc2* GetAudioParamDesc();

class ThreeJSAudioClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL loading) override;
    const TCHAR* ClassName() override { return _T("Audio Origin"); }
    const TCHAR* NonLocalizedClassName() override { return _T("Audio Origin"); }
    SClass_ID SuperClassID() override { return GEOMOBJECT_CLASS_ID; }
    Class_ID ClassID() override { return THREEJS_AUDIO_CLASS_ID; }
    const TCHAR* Category() override { return _T("MaxJS"); }
    const TCHAR* InternalName() override { return _T("ThreeJSAudioOrigin"); }
    HINSTANCE HInstance() override { return hInstance; }
};

class ThreeJSAudioDlgProc : public ParamMap2UserDlgProc {
public:
    explicit ThreeJSAudioDlgProc(ThreeJSAudioOrigin* object) : object_(object) {}

    INT_PTR DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) override;
    void DeleteThis() override { delete this; }

private:
    void UpdatePathText(HWND hWnd, IParamMap2* map) const;

    ThreeJSAudioOrigin* object_ = nullptr;
};

class ThreeJSAudioCreateCB : public CreateMouseCallBack {
public:
    void SetObj(ThreeJSAudioOrigin* object) { object_ = object; }
    int proc(ViewExp* vpt, int msg, int point, int flags, IPoint2 m, Matrix3& mat) override;

private:
    ThreeJSAudioOrigin* object_ = nullptr;
};

class ThreeJSAudioOrigin : public SimpleObject2 {
public:
    explicit ThreeJSAudioOrigin(BOOL loading) {
        GetThreeJSAudioDesc()->MakeAutoParamBlocks(this);
    }

    void DeleteThis() override { delete this; }
    Class_ID ClassID() override { return THREEJS_AUDIO_CLASS_ID; }
    SClass_ID SuperClassID() override { return GEOMOBJECT_CLASS_ID; }
    void GetClassName(MSTR& s, bool) const override { s = _T("Audio Origin"); }
    const TCHAR* GetObjectName(bool localized) const override { return _T("Audio Origin"); }

    void BuildMesh(TimeValue t) override;
    BOOL OKtoDisplay(TimeValue t) override;
    void InvalidateUI() override;
    RefTargetHandle Clone(RemapDir& remap) override;
    CreateMouseCallBack* GetCreateMouseCallBack() override;
    void BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) override;
    void EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) override;

    void BrowseForAudioFile(HWND owner);
    void ClearAudioFile();

private:
    float GetDisplaySize(TimeValue t) const;
};

static ThreeJSAudioClassDesc g_audioDesc;
static ThreeJSAudioCreateCB g_audioCreateCB;

void* ThreeJSAudioClassDesc::Create(BOOL loading) {
    return new ThreeJSAudioOrigin(loading);
}

INT_PTR ThreeJSAudioDlgProc::DlgProc(TimeValue t, IParamMap2* map, HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (map) {
        object_ = static_cast<ThreeJSAudioOrigin*>(map->GetParamBlock()->GetOwner());
    }

    switch (msg) {
        case WM_INITDIALOG:
            UpdatePathText(hWnd, map);
            return TRUE;

        case WM_COMMAND:
            switch (LOWORD(wParam)) {
                case IDC_AUDIO_LOAD:
                    if (object_) object_->BrowseForAudioFile(hWnd);
                    UpdatePathText(hWnd, map);
                    return TRUE;
                case IDC_AUDIO_CLEAR:
                    if (object_) object_->ClearAudioFile();
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

void ThreeJSAudioDlgProc::UpdatePathText(HWND hWnd, IParamMap2* map) const {
    if (!map) return;

    IParamBlock2* pb = map->GetParamBlock();
    const MCHAR* filePath = pb ? pb->GetStr(pa_audio_file) : nullptr;
    const wchar_t* label = (filePath && filePath[0]) ? filePath : L"(none)";
    SetWindowTextW(GetDlgItem(hWnd, IDC_AUDIO_PATH), label);
}

int ThreeJSAudioCreateCB::proc(ViewExp* vpt, int msg, int point, int flags, IPoint2 m, Matrix3& mat) {
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

float ThreeJSAudioOrigin::GetDisplaySize(TimeValue t) const {
    const float size = pblock2 ? pblock2->GetFloat(pa_display_size, t) : 30.0f;
    return size > 0.001f ? size : 0.001f;
}

void ThreeJSAudioOrigin::BuildMesh(TimeValue t) {
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

BOOL ThreeJSAudioOrigin::OKtoDisplay(TimeValue t) {
    return GetDisplaySize(t) > 0.0f;
}

void ThreeJSAudioOrigin::InvalidateUI() {
    GetAudioParamDesc()->InvalidateUI(pblock2 ? pblock2->LastNotifyParamID() : pa_display_size);
}

RefTargetHandle ThreeJSAudioOrigin::Clone(RemapDir& remap) {
    ThreeJSAudioOrigin* obj = new ThreeJSAudioOrigin(FALSE);
    obj->ReplaceReference(0, remap.CloneRef(pblock2));
    BaseClone(this, obj, remap);
    obj->ivalid.SetEmpty();
    return obj;
}

CreateMouseCallBack* ThreeJSAudioOrigin::GetCreateMouseCallBack() {
    g_audioCreateCB.SetObj(this);
    return &g_audioCreateCB;
}

void ThreeJSAudioOrigin::BeginEditParams(IObjParam* ip, ULONG flags, Animatable* prev) {
    g_audioDesc.BeginEditParams(ip, this, flags, prev);
    GetAudioParamDesc()->SetUserDlgProc(new ThreeJSAudioDlgProc(this));
}

void ThreeJSAudioOrigin::EndEditParams(IObjParam* ip, ULONG flags, Animatable* next) {
    GetAudioParamDesc()->SetUserDlgProc(nullptr);
    g_audioDesc.EndEditParams(ip, this, flags, next);
}

void ThreeJSAudioOrigin::BrowseForAudioFile(HWND owner) {
    wchar_t filePath[MAX_PATH] = {};
    if (pblock2) {
        const MCHAR* current = pblock2->GetStr(pa_audio_file);
        if (current && current[0]) {
            wcsncpy_s(filePath, current, _TRUNCATE);
        }
    }

    OPENFILENAMEW ofn = {};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = owner;
    ofn.lpstrFile = filePath;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrTitle = L"Load Spatial Audio";
    ofn.lpstrFilter =
        L"Audio Files (*.mp3;*.wav;*.ogg;*.m4a;*.aac;*.flac)\0*.mp3;*.wav;*.ogg;*.m4a;*.aac;*.flac\0"
        L"All Files (*.*)\0*.*\0\0";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY;

    if (!GetOpenFileNameW(&ofn) || !pblock2) return;

    pblock2->SetValue(pa_audio_file, 0, filePath);
    NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
    InvalidateUI();

    Interface* ip = GetCOREInterface();
    if (ip) ip->RedrawViews(ip->GetTime());
}

void ThreeJSAudioOrigin::ClearAudioFile() {
    if (!pblock2) return;
    pblock2->SetValue(pa_audio_file, 0, _T(""));
    NotifyDependents(FOREVER, PART_ALL, REFMSG_CHANGE);
    InvalidateUI();

    Interface* ip = GetCOREInterface();
    if (ip) ip->RedrawViews(ip->GetTime());
}

static ParamBlockDesc2 threejs_audio_param_blk(
    threejs_audio_params,
    _T("ThreeJSAudioParameters"),
    IDS_AUDIO_PARAMS,
    &g_audioDesc,
    P_AUTO_CONSTRUCT + P_AUTO_UI,
    0,
    IDD_THREEJS_AUDIO, IDS_AUDIO_PARAMS, 0, 0, nullptr,

    pa_display_size, _T("displaySize"), TYPE_WORLD, P_ANIMATABLE + P_RESET_DEFAULT, IDS_AUDIO_DISPLAY_SIZE,
        p_default, 30.0f,
        p_range, 0.1f, 1.0e30f,
        p_ui, TYPE_SPINNER, EDITTYPE_UNIVERSE, IDC_AUDIO_SIZE_EDIT, IDC_AUDIO_SIZE_SPIN, SPIN_AUTOSCALE,
        p_end,

    pa_audio_file, _T("audioFile"), TYPE_FILENAME, 0, IDS_AUDIO_FILE,
        p_default, _T(""),
        p_end,

    pa_volume, _T("volume"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_AUDIO_VOLUME,
        p_default, 1.0f,
        p_range, 0.0f, 4.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AUDIO_VOLUME_EDIT, IDC_AUDIO_VOLUME_SPIN, 0.01f,
        p_end,

    pa_loop, _T("loop"), TYPE_BOOL, P_RESET_DEFAULT, IDS_AUDIO_LOOP,
        p_default, TRUE,
        p_ui, TYPE_SINGLECHEKBOX, IDC_AUDIO_LOOP,
        p_end,

    pa_crossfade_ms, _T("crossfadeMs"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_AUDIO_CROSSFADE,
        p_default, 35.0f,
        p_range, 0.0f, 5000.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AUDIO_CROSSFADE_EDIT, IDC_AUDIO_CROSSFADE_SPIN, 1.0f,
        p_end,

    pa_ref_distance, _T("refDistance"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_AUDIO_REF_DISTANCE,
        p_default, 120.0f,
        p_range, 0.01f, 1.0e30f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AUDIO_REF_EDIT, IDC_AUDIO_REF_SPIN, 1.0f,
        p_end,

    pa_max_distance, _T("maxDistance"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_AUDIO_MAX_DISTANCE,
        p_default, 5000.0f,
        p_range, 0.01f, 1.0e30f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AUDIO_MAX_EDIT, IDC_AUDIO_MAX_SPIN, 10.0f,
        p_end,

    pa_rolloff_factor, _T("rolloffFactor"), TYPE_FLOAT, P_ANIMATABLE + P_RESET_DEFAULT, IDS_AUDIO_ROLLOFF,
        p_default, 1.0f,
        p_range, 0.0f, 16.0f,
        p_ui, TYPE_SPINNER, EDITTYPE_FLOAT, IDC_AUDIO_ROLLOFF_EDIT, IDC_AUDIO_ROLLOFF_SPIN, 0.01f,
        p_end,

    p_end
);

static ParamBlockDesc2* GetAudioParamDesc() {
    return &threejs_audio_param_blk;
}

} // namespace

bool IsThreeJSAudioClassID(const Class_ID& cid) {
    return cid == THREEJS_AUDIO_CLASS_ID;
}

ClassDesc2* GetThreeJSAudioDesc() {
    return &g_audioDesc;
}
