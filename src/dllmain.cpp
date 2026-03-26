#include <max.h>
#include <gup.h>
#include <iparamb2.h>
#include <plugapi.h>
#include <maxapi.h>
#include <triobj.h>
#include <notify.h>
#include <stdmat.h>
#include <maxscript/maxscript.h>
#include "threejs_material.h"
#include "threejs_renderer.h"

#include <wrl.h>
#include <WebView2.h>
#include <ShlObj.h>
#include <string>
#include <vector>
#include <sstream>
#include <unordered_set>
#include <unordered_map>
#include <map>
#include <algorithm>
#include <cmath>

using namespace Microsoft::WRL;

#define MAXJS_CLASS_ID  Class_ID(0x7F3A9B01, 0x4E2D8C05)
#define MAXJS_NAME      _T("MaxJS")
#define MAXJS_CATEGORY  _T("MaxJS")

#define SYNC_TIMER_ID     1
#define SYNC_INTERVAL_MS  150
#define WM_TOGGLE_PANEL   (WM_USER + 1)
#define SETUP_TIMER_ID    2

extern HINSTANCE hInstance;
HINSTANCE hInstance = nullptr;

class MaxJSPanel;
static MaxJSPanel* g_panel = nullptr;
static HWND g_helperHwnd = nullptr;

// Forward — used by renderer's ActiveShade
static void TogglePanel();
void ToggleMaxJSPanel() { TogglePanel(); }

// ══════════════════════════════════════════════════════════════
//  JSON Helpers
// ══════════════════════════════════════════════════════════════

static std::wstring EscapeJson(const wchar_t* s) {
    std::wstring out;
    out.reserve(wcslen(s) + 16);
    for (; *s; ++s) {
        switch (*s) {
            case L'"':  out += L"\\\""; break;
            case L'\\': out += L"\\\\"; break;
            case L'\n': out += L"\\n"; break;
            case L'\t': out += L"\\t"; break;
            default:    out += *s;
        }
    }
    return out;
}

static void WriteFloats(std::wostringstream& ss, const float* d, size_t n) {
    ss << L'[';
    for (size_t i = 0; i < n; i++) { if (i) ss << L','; ss << d[i]; }
    ss << L']';
}

static void WriteInts(std::wostringstream& ss, const int* d, size_t n) {
    ss << L'[';
    for (size_t i = 0; i < n; i++) { if (i) ss << L','; ss << d[i]; }
    ss << L']';
}

// ══════════════════════════════════════════════════════════════
//  Texture Path Finder — walks any texmap tree for Bitmap files
// ══════════════════════════════════════════════════════════════

static bool IsImageFile(const wchar_t* path) {
    if (!path || !path[0]) return false;
    const wchar_t* ext = wcsrchr(path, L'.');
    if (!ext) return false;
    return (_wcsicmp(ext, L".png") == 0 || _wcsicmp(ext, L".jpg") == 0 ||
            _wcsicmp(ext, L".jpeg") == 0 || _wcsicmp(ext, L".tga") == 0 ||
            _wcsicmp(ext, L".tif") == 0 || _wcsicmp(ext, L".tiff") == 0 ||
            _wcsicmp(ext, L".bmp") == 0 || _wcsicmp(ext, L".exr") == 0 ||
            _wcsicmp(ext, L".hdr") == 0 || _wcsicmp(ext, L".dds") == 0 ||
            _wcsicmp(ext, L".psd") == 0 || _wcsicmp(ext, L".tx") == 0);
}

static std::wstring FindBitmapFile(Texmap* map) {
    if (!map) return {};

    // Check paramblocks for filename-type params — skip non-image files (.osl etc)
    for (int pb = 0; pb < map->NumParamBlocks(); pb++) {
        IParamBlock2* pblock = map->GetParamBlock(pb);
        if (!pblock) continue;
        for (int i = 0; i < pblock->NumParams(); i++) {
            ParamID pid = pblock->IndextoID(i);
            const ParamDef& pd = pblock->GetParamDef(pid);
            if (pd.type == TYPE_FILENAME || pd.type == TYPE_FILENAME_TAB) {
                const MCHAR* fn = pblock->GetStr(pid);
                if (fn && fn[0] && IsImageFile(fn)) return fn;
            }
        }
    }

    // Recurse into sub-texmaps
    for (int i = 0; i < map->NumSubTexmaps(); i++) {
        Texmap* sub = map->GetSubTexmap(i);
        if (sub) {
            std::wstring f = FindBitmapFile(sub);
            if (!f.empty()) return f;
        }
    }
    return {};
}

// ── Wire Color helper ─────────────────────────────────────────

static void GetWireColor3f(INode* node, float out[3]) {
    COLORREF wc = node->GetWireColor();
    out[0] = GetRValue(wc)/255.0f; out[1] = GetGValue(wc)/255.0f; out[2] = GetBValue(wc)/255.0f;
}

// ══════════════════════════════════════════════════════════════
//  Material PBR Extraction
//  Priority: ThreeJS Material (direct) > Shell viewport sub > wire color
// ══════════════════════════════════════════════════════════════

struct PBRData {
    float color[3]    = {0.8f, 0.8f, 0.8f};
    float roughness   = 0.5f;
    float metalness   = 0.0f;
    float emission[3] = {0, 0, 0};
    float emIntensity = 0.0f;
    float opacity     = 1.0f;
    float normalScale = 1.0f;
    float aoIntensity = 1.0f;
    float lightmapIntensity = 1.0f;
    int   lightmapChannel = 2;
    bool  doubleSided = true;
    float envIntensity = 1.0f;
    std::wstring colorMap, roughnessMap, metalnessMap, normalMap;
    std::wstring aoMap, emissionMap, lightmapFile, opacityMap;
    std::wstring mtlName;
};

// Shell Material Class_ID = (597, 0)
#define SHELL_MTL_CLASS_ID Class_ID(597, 0)

// Find ThreeJS Material in material tree — uses ClassID only, no GetClassName
static Mtl* FindThreeJSMaterial(Mtl* mtl) {
    if (!mtl) return nullptr;

    Class_ID cid = mtl->ClassID();

    // Direct ThreeJS Material
    if (cid == THREEJS_MTL_CLASS_ID) return mtl;

    // Shell Material
    if (cid == SHELL_MTL_CLASS_ID && mtl->NumSubMtls() >= 2) {
        // Check both subs for ThreeJS Material
        for (int i = 0; i < mtl->NumSubMtls(); i++) {
            Mtl* sub = mtl->GetSubMtl(i);
            if (sub && sub->ClassID() == THREEJS_MTL_CLASS_ID)
                return sub;
        }
    }

    // Multi/Sub
    if (mtl->NumSubMtls() > 0 && cid != SHELL_MTL_CLASS_ID) {
        for (int i = 0; i < mtl->NumSubMtls(); i++) {
            Mtl* found = FindThreeJSMaterial(mtl->GetSubMtl(i));
            if (found) return found;
        }
    }

    return nullptr;
}

static void ExtractThreeJSMtl(Mtl* mtl, TimeValue t, PBRData& d) {
    IParamBlock2* pb = mtl->GetParamBlockByID(threejs_params);
    if (!pb) return;

    MSTR name = mtl->GetName();
    d.mtlName = name.data();

    Color c = pb->GetColor(pb_color, t);
    d.color[0] = c.r; d.color[1] = c.g; d.color[2] = c.b;
    d.roughness  = pb->GetFloat(pb_roughness, t);
    d.metalness  = pb->GetFloat(pb_metalness, t);
    d.opacity    = pb->GetFloat(pb_opacity, t);
    d.normalScale = pb->GetFloat(pb_normal_scale, t);
    d.doubleSided = pb->GetInt(pb_double_sided, t) != 0;
    d.envIntensity = pb->GetFloat(pb_env_intensity, t);

    Color em = pb->GetColor(pb_emissive_color, t);
    d.emission[0] = em.r; d.emission[1] = em.g; d.emission[2] = em.b;
    d.emIntensity = pb->GetFloat(pb_emissive_intensity, t);

    d.aoIntensity = pb->GetFloat(pb_ao_intensity, t);
    d.lightmapIntensity = pb->GetFloat(pb_lightmap_intensity, t);
    d.lightmapChannel = pb->GetInt(pb_lightmap_channel, t);

    // Texture maps
    auto getMap = [&](ParamID pid) -> std::wstring {
        Texmap* map = pb->GetTexmap(pid, t);
        return FindBitmapFile(map);
    };
    d.colorMap     = getMap(pb_color_map);
    d.roughnessMap = getMap(pb_roughness_map);
    d.metalnessMap = getMap(pb_metalness_map);
    d.normalMap    = getMap(pb_normal_map);
    d.emissionMap  = getMap(pb_emissive_map);
    d.opacityMap   = getMap(pb_opacity_map);
    d.lightmapFile = getMap(pb_lightmap);
    d.aoMap        = getMap(pb_ao_map);
}

static void ExtractPBR(INode* node, TimeValue t, PBRData& d) {
    Mtl* mtl = node->GetMtl();

    // Priority 1: ThreeJS Material (direct or inside Shell)
    Mtl* tjsMtl = FindThreeJSMaterial(mtl);
    if (tjsMtl) {
        ExtractThreeJSMtl(tjsMtl, t, d);
        return;
    }

    // Priority 2: Wire color fallback (old material conversion disabled for speed)
    GetWireColor3f(node, d.color);
}

// ══════════════════════════════════════════════════════════════
//  Mesh Extraction with UV coordinates
// ══════════════════════════════════════════════════════════════

static bool ExtractMesh(INode* node, TimeValue t,
                        std::vector<float>& verts,
                        std::vector<float>& uvs,
                        std::vector<int>& indices) {
    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;

    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    Mesh& mesh = tri->GetMesh();
    int nv = mesh.getNumVerts();
    int nf = mesh.getNumFaces();

    if (nv == 0 || nf == 0 || nv > 500000) {
        if (tri != os.obj) tri->DeleteThis();
        return false;
    }

    bool hasUVs = mesh.getNumTVerts() > 0;

    // Build indexed mesh with split vertices at UV seams
    std::unordered_map<uint64_t, int> vertMap;
    verts.reserve(nv * 3);
    if (hasUVs) uvs.reserve(nv * 2);
    indices.reserve(nf * 3);

    for (int f = 0; f < nf; f++) {
        for (int v = 0; v < 3; v++) {
            DWORD posIdx = mesh.faces[f].v[v];
            DWORD uvIdx  = hasUVs ? mesh.tvFace[f].t[v] : 0;
            uint64_t key = ((uint64_t)posIdx << 32) | uvIdx;

            auto it = vertMap.find(key);
            if (it != vertMap.end()) {
                indices.push_back(it->second);
            } else {
                int newIdx = (int)(verts.size() / 3);
                vertMap[key] = newIdx;

                Point3 p = mesh.getVert(posIdx);
                verts.push_back(p.x);
                verts.push_back(p.y);
                verts.push_back(p.z);

                if (hasUVs) {
                    UVVert uv = mesh.tVerts[uvIdx];
                    uvs.push_back(uv.x);
                    uvs.push_back(uv.y);
                }

                indices.push_back(newIdx);
            }
        }
    }

    if (tri != os.obj) tri->DeleteThis();
    return true;
}

// ══════════════════════════════════════════════════════════════
//  Transform + Color helpers
// ══════════════════════════════════════════════════════════════

static void GetTransform16(INode* node, TimeValue t, float out[16]) {
    // GetObjTMAfterWSM includes pivot offset — matches object-space vertices
    Matrix3 tm = node->GetObjTMAfterWSM(t);
    Point3 r0 = tm.GetRow(0), r1 = tm.GetRow(1), r2 = tm.GetRow(2), tr = tm.GetTrans();
    out[0]=r0.x; out[1]=r0.y; out[2]=r0.z; out[3]=0;
    out[4]=r1.x; out[5]=r1.y; out[6]=r1.z; out[7]=0;
    out[8]=r2.x; out[9]=r2.y; out[10]=r2.z; out[11]=0;
    out[12]=tr.x; out[13]=tr.y; out[14]=tr.z; out[15]=1;
}

// ══════════════════════════════════════════════════════════════
//  Viewport Camera Extraction
// ══════════════════════════════════════════════════════════════

struct CameraData {
    float pos[3];      // Y-up
    float target[3];   // Y-up
    float up[3];       // Y-up
    float fov;         // degrees (horizontal)
    bool perspective;
};

static void GetViewportCamera(CameraData& cam) {
    Interface* ip = GetCOREInterface();

    ViewExp& vp = ip->GetActiveViewExp();

    cam.perspective = vp.IsPerspView() != 0;
    cam.fov = vp.GetFOV() * (180.0f / 3.14159265f);

    Matrix3 viewTM;
    vp.GetAffineTM(viewTM);
    Matrix3 camTM = Inverse(viewTM);

    Point3 pos = camTM.GetTrans();
    Point3 fwd = -Normalize(camTM.GetRow(2));
    Point3 up  = Normalize(camTM.GetRow(1));
    Point3 tgt = pos + fwd * 100.0f;

    // Raw Z-up coordinates — JS handles conversion
    cam.pos[0] = pos.x;    cam.pos[1] = pos.y;    cam.pos[2] = pos.z;
    cam.target[0] = tgt.x; cam.target[1] = tgt.y;  cam.target[2] = tgt.z;
    cam.up[0] = up.x;      cam.up[1] = up.y;       cam.up[2] = up.z;
}

// ══════════════════════════════════════════════════════════════
//  Environment HDRI — full param extraction
// ══════════════════════════════════════════════════════════════

struct EnvData {
    std::wstring hdriPath;
    float rotation = 0;
    float exposure = 0;
    float gamma = 1.0f;
    int   zup = 0;
    int   flip = 0;
};

// Generic: find a named float/int/string in any paramblock of a map
static float FindPBFloat(Texmap* map, const MCHAR* name, float def) {
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 && pd.type == TYPE_FLOAT)
                return pb->GetFloat(pid);
        }
    }
    return def;
}

static int FindPBInt(Texmap* map, const MCHAR* name, int def) {
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 &&
                (pd.type == TYPE_INT || pd.type == TYPE_BOOL))
                return pb->GetInt(pid);
        }
    }
    return def;
}

static std::wstring FindPBString(Texmap* map, const MCHAR* name) {
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 &&
                (pd.type == TYPE_STRING || pd.type == TYPE_FILENAME)) {
                const MCHAR* s = pb->GetStr(pid);
                return s ? s : L"";
            }
        }
    }
    return {};
}

static void GetEnvironment(EnvData& env) {
    Texmap* envMap = GetCOREInterface()->GetEnvironmentMap();
    if (!envMap) return;

    // Try named string param "HDRI" first (OSL HDRI Environment)
    env.hdriPath = FindPBString(envMap, _T("HDRI"));
    if (env.hdriPath.empty() || !IsImageFile(env.hdriPath.c_str())) {
        // Fallback: walk for any image file
        env.hdriPath = FindBitmapFile(envMap);
    }

    // Read OSL HDRI Environment params
    env.rotation = FindPBFloat(envMap, _T("rotation"), 0);
    env.exposure = FindPBFloat(envMap, _T("exposure"), 0);
    env.gamma    = FindPBFloat(envMap, _T("gamma"), 1.0f);
    env.zup      = FindPBInt(envMap, _T("zup"), 0);
    env.flip     = FindPBInt(envMap, _T("flip"), 0);
}

// ── Scene change notification ─────────────────────────────────

static void OnSceneChanged(void* param, NotifyInfo*);

// ══════════════════════════════════════════════════════════════
//  WebView2 Panel
// ══════════════════════════════════════════════════════════════

static const wchar_t* kWindowClass = L"MaxJSPanel";

class MaxJSPanel {
public:
    HWND hwnd_ = nullptr;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> webview_;

    bool jsReady_ = false;
    bool dirty_ = true;
    int tickCount_ = 0;
    std::unordered_set<ULONG> geomHandles_;
    std::unordered_map<ULONG, uintptr_t> mtlHashMap_;  // node handle → material state hash
    std::map<std::wstring, std::wstring> texDirMap_;    // dir → host
    int texDirCount_ = 0;

    bool Create(HWND parent) {
        WNDCLASSEXW wc = {};
        wc.cbSize = sizeof(WNDCLASSEXW);
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = WndProc;
        wc.hInstance = hInstance;
        wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
        wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
        wc.lpszClassName = kWindowClass;
        RegisterClassExW(&wc);

        hwnd_ = CreateWindowExW(0, kWindowClass,
            L"MaxJS \u2014 Three.js Viewport",
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT, CW_USEDEFAULT, 1280, 800,
            parent, nullptr, hInstance, this);
        if (!hwnd_) return false;
        ShowWindow(hwnd_, SW_SHOW);
        UpdateWindow(hwnd_);
        InitWebView2();
        return true;
    }

    void InitWebView2() {
        wchar_t* localAppData = nullptr;
        SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData);
        std::wstring udf = std::wstring(localAppData) + L"\\MaxJS\\WebView2Data";
        CoTaskMemFree(localAppData);

        CreateCoreWebView2EnvironmentWithOptions(nullptr, udf.c_str(), nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [this](HRESULT r, ICoreWebView2Environment* env) -> HRESULT {
                    if (FAILED(r) || !env) return r;
                    env->CreateCoreWebView2Controller(hwnd_,
                        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                            [this](HRESULT r, ICoreWebView2Controller* c) -> HRESULT {
                                if (FAILED(r) || !c) return r;
                                OnWebViewReady(c);
                                return S_OK;
                            }).Get());
                    return S_OK;
                }).Get());
    }

    void OnWebViewReady(ICoreWebView2Controller* ctrl) {
        controller_ = ctrl;
        controller_->get_CoreWebView2(&webview_);
        RECT b; GetClientRect(hwnd_, &b); controller_->put_Bounds(b);

        ComPtr<ICoreWebView2Settings> settings;
        webview_->get_Settings(&settings);
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDevToolsEnabled(TRUE);

        webview_->add_WebMessageReceived(
            Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                    LPWSTR json = nullptr;
                    args->get_WebMessageAsJson(&json);
                    if (json) { OnWebMessage(json); CoTaskMemFree(json); }
                    return S_OK;
                }).Get(), nullptr);

        RegisterCallbacks();
        LoadContent();
    }

    void LoadContent() {
        std::wstring webDir = GetWebDir();
        if (!webDir.empty()) {
            ComPtr<ICoreWebView2_3> wv3;
            webview_->QueryInterface(IID_PPV_ARGS(&wv3));
            if (wv3) {
                wv3->SetVirtualHostNameToFolderMapping(
                    L"maxjs.local", webDir.c_str(),
                    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                // Pre-map common drive roots for texture serving
                wv3->SetVirtualHostNameToFolderMapping(
                    L"maxjsdrvc.local", L"C:\\",
                    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                wv3->SetVirtualHostNameToFolderMapping(
                    L"maxjsdrvd.local", L"D:\\",
                    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                texDirMap_[L"c"] = L"maxjsdrvc.local";
                texDirMap_[L"d"] = L"maxjsdrvd.local";
                // Cache-bust: append tick count to URL so WebView2 never serves stale HTML
                wchar_t navUrl[128];
                swprintf_s(navUrl, L"https://maxjs.local/index.html?v=%lld", GetTickCount64());
                webview_->Navigate(navUrl);
                return;
            }
        }
        webview_->NavigateToString(L"<html><body style='background:#1a1a2e;color:#aaa;"
            L"font:14px monospace;display:flex;align-items:center;justify-content:center;"
            L"height:100vh'><div>MaxJS: web files not found</div></body></html>");
    }

    std::wstring GetWebDir() {
        wchar_t p[MAX_PATH];
        GetModuleFileNameW(hInstance, p, MAX_PATH);
        std::wstring d(p); d = d.substr(0, d.find_last_of(L"\\/"));
        std::wstring w = d + L"\\maxjs_web";
        return GetFileAttributesW(w.c_str()) != INVALID_FILE_ATTRIBUTES ? w : std::wstring{};
    }

    // ── Texture serving — drives pre-mapped in LoadContent ──

    std::wstring MapTexturePath(const std::wstring& filePath) {
        if (filePath.empty() || filePath.size() < 3 || filePath[1] != L':') return {};

        wchar_t drive = towlower(filePath[0]);
        std::wstring driveKey(1, drive);

        auto it = texDirMap_.find(driveKey);
        if (it == texDirMap_.end()) return {};

        // C:\foo\bar.png → https://maxjsdrvc.local/foo/bar.png
        std::wstring relPath = filePath.substr(3);
        std::replace(relPath.begin(), relPath.end(), L'\\', L'/');
        return L"https://" + it->second + L"/" + relPath;
    }

    // ── Callbacks & sync ─────────────────────────────────────

    void RegisterCallbacks() {
        RegisterNotification(OnSceneChanged, this, NOTIFY_SCENE_ADDED_NODE);
        RegisterNotification(OnSceneChanged, this, NOTIFY_SCENE_PRE_DELETED_NODE);
        RegisterNotification(OnSceneChanged, this, NOTIFY_FILE_POST_OPEN);
        RegisterNotification(OnSceneChanged, this, NOTIFY_SYSTEM_POST_RESET);
        RegisterNotification(OnSceneChanged, this, NOTIFY_SELECTIONSET_CHANGED);
        SetTimer(hwnd_, SYNC_TIMER_ID, SYNC_INTERVAL_MS, nullptr);
    }

    void UnregisterCallbacks() {
        KillTimer(hwnd_, SYNC_TIMER_ID);
        UnRegisterNotification(OnSceneChanged, this, NOTIFY_SCENE_ADDED_NODE);
        UnRegisterNotification(OnSceneChanged, this, NOTIFY_SCENE_PRE_DELETED_NODE);
        UnRegisterNotification(OnSceneChanged, this, NOTIFY_FILE_POST_OPEN);
        UnRegisterNotification(OnSceneChanged, this, NOTIFY_SYSTEM_POST_RESET);
        UnRegisterNotification(OnSceneChanged, this, NOTIFY_SELECTIONSET_CHANGED);
    }

    void OnWebMessage(const wchar_t* json) {
        std::wstring msg(json);
        if (msg.find(L"\"ready\"") != std::wstring::npos) {
            jsReady_ = true; dirty_ = true;
        }
    }

    void OnTimer() {
        if (!jsReady_ || !webview_) return;
        if (!hwnd_ || !IsWindowVisible(hwnd_)) return;
        tickCount_++;

        if (dirty_) {
            dirty_ = false;
            SendFullSync();
        } else {
            SendTransformSync();
            // Lightweight material change check every ~1.5s (just pointer comparisons)
            if (tickCount_ % 10 == 0) DetectMaterialChanges();
        }
    }

    // Check if any material's texmap pointers changed — triggers full sync on NEXT tick
    void DetectMaterialChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            // Build a quick hash from material identity + texmap pointers
            uintptr_t hash = 0;
            Mtl* rawMtl = node->GetMtl();
            hash ^= (uintptr_t)rawMtl;
            Mtl* tjsMtl = FindThreeJSMaterial(rawMtl);
            if (tjsMtl) {
                IParamBlock2* pb = tjsMtl->GetParamBlockByID(threejs_params);
                if (pb) {
                    static const ParamID mapIDs[] = {
                        pb_color_map, pb_roughness_map, pb_metalness_map,
                        pb_normal_map, pb_emissive_map, pb_opacity_map,
                        pb_lightmap, pb_ao_map
                    };
                    for (ParamID mid : mapIDs)
                        hash ^= (uintptr_t)pb->GetTexmap(mid, t) * 2654435761ULL;
                }
            }

            auto it = mtlHashMap_.find(handle);
            if (it == mtlHashMap_.end()) {
                mtlHashMap_[handle] = hash;
            } else if (it->second != hash) {
                it->second = hash;
                dirty_ = true;  // triggers full sync on next tick
                return;
            }
        }
    }

    // ── Camera JSON fragment ─────────────────────────────────

    void WriteCameraJson(std::wostringstream& ss) {
        CameraData cam = {};
        GetViewportCamera(cam);
        ss << L"\"camera\":{";
        ss << L"\"pos\":[" << cam.pos[0] << L',' << cam.pos[1] << L',' << cam.pos[2] << L']';
        ss << L",\"tgt\":[" << cam.target[0] << L',' << cam.target[1] << L',' << cam.target[2] << L']';
        ss << L",\"up\":[" << cam.up[0] << L',' << cam.up[1] << L',' << cam.up[2] << L']';
        ss << L",\"fov\":" << cam.fov;
        ss << L",\"persp\":" << (cam.perspective ? L"true" : L"false");
        ss << L'}';
    }

    // ── Full scene sync ──────────────────────────────────────

    void SendFullSync() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        INode* root = ip->GetRootNode();
        if (!root) return;

        geomHandles_.clear();

        std::wostringstream ss;
        ss << L"{\"type\":\"scene\",\"nodes\":[";
        bool first = true;
        WriteSceneNodes(root, t, ss, first);
        ss << L"],";

        // Camera
        WriteCameraJson(ss);

        // Environment
        EnvData envData;
        GetEnvironment(envData);
        std::wstring hdriUrl = MapTexturePath(envData.hdriPath);
        ss << L",\"env\":{";
        if (!hdriUrl.empty())
            ss << L"\"hdri\":\"" << EscapeJson(hdriUrl.c_str()) << L'"';
        ss << L",\"rot\":" << envData.rotation;
        ss << L",\"exp\":" << envData.exposure;
        ss << L",\"gamma\":" << envData.gamma;
        ss << L",\"zup\":" << envData.zup;
        ss << L",\"flip\":" << envData.flip;
        ss << L'}';

        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void WriteSceneNodes(INode* parent, TimeValue t,
                         std::wostringstream& ss, bool& first) {
        for (int i = 0; i < parent->NumberOfChildren(); i++) {
            INode* node = parent->GetChildNode(i);
            if (!node) continue;

            std::vector<float> verts, uvs;
            std::vector<int> indices;
            if (ExtractMesh(node, t, verts, uvs, indices)) {
                float xform[16]; GetTransform16(node, t, xform);

                // Material
                PBRData pbr;
                ExtractPBR(node, t, pbr);

                if (!first) ss << L',';
                ss << L"{\"h\":" << node->GetHandle();
                ss << L",\"n\":\"" << EscapeJson(node->GetName()) << L'"';
                ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
                ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                ss << L",\"v\":"; WriteFloats(ss, verts.data(), verts.size());
                ss << L",\"i\":"; WriteInts(ss, indices.data(), indices.size());
                if (!uvs.empty()) {
                    ss << L",\"uv\":"; WriteFloats(ss, uvs.data(), uvs.size());
                }

                // Material data
                ss << L",\"mat\":{";
                ss << L"\"name\":\"" << EscapeJson(pbr.mtlName.empty() ? L"default" : pbr.mtlName.c_str()) << L'"';
                ss << L",\"color\":[" << pbr.color[0] << L',' << pbr.color[1] << L',' << pbr.color[2] << L']';
                ss << L",\"rough\":" << pbr.roughness;
                ss << L",\"metal\":" << pbr.metalness;
                if (pbr.opacity < 0.999f) ss << L",\"opacity\":" << pbr.opacity;
                if (!pbr.doubleSided) ss << L",\"side\":0";
                ss << L",\"normScl\":" << pbr.normalScale;
                ss << L",\"aoI\":" << pbr.aoIntensity;
                ss << L",\"envI\":" << pbr.envIntensity;
                if (pbr.emIntensity > 0) {
                    ss << L",\"em\":[" << pbr.emission[0] << L',' << pbr.emission[1] << L',' << pbr.emission[2] << L']';
                    ss << L",\"emI\":" << pbr.emIntensity;
                }
                // Lightmap
                if (pbr.lightmapIntensity > 0) {
                    ss << L",\"lmI\":" << pbr.lightmapIntensity;
                    ss << L",\"lmCh\":" << pbr.lightmapChannel;
                }

                // Texture URLs
                auto writeMap = [&](const wchar_t* key, const std::wstring& path) {
                    if (path.empty()) return;
                    std::wstring url = MapTexturePath(path);
                    if (!url.empty())
                        ss << L",\"" << key << L"\":\"" << EscapeJson(url.c_str()) << L'"';
                };
                writeMap(L"map", pbr.colorMap);
                writeMap(L"roughMap", pbr.roughnessMap);
                writeMap(L"metalMap", pbr.metalnessMap);
                writeMap(L"normMap", pbr.normalMap);
                writeMap(L"aoMap", pbr.aoMap);
                writeMap(L"emMap", pbr.emissionMap);
                writeMap(L"lmMap", pbr.lightmapFile);
                writeMap(L"opMap", pbr.opacityMap);

                ss << L'}';  // end mat
                ss << L'}';  // end node
                first = false;
                geomHandles_.insert(node->GetHandle());
            }

            WriteSceneNodes(node, t, ss, first);
        }
    }

    // ── Transform-only sync ──────────────────────────────────

    void SendTransformSync() {
        if (geomHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        std::wostringstream ss;
        ss << L"{\"type\":\"xform\",\"nodes\":[";
        bool first = true;
        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;
            float xform[16]; GetTransform16(node, t, xform);

            // Lightweight material scalars (no texture walks)
            float col[3] = {0.8f,0.8f,0.8f};
            float rough = 0.5f, metal = 0.0f, opac = 1.0f;
            Mtl* tjsMtl = FindThreeJSMaterial(node->GetMtl());
            if (tjsMtl) {
                IParamBlock2* pb = tjsMtl->GetParamBlockByID(threejs_params);
                if (pb) {
                    Color c = pb->GetColor(pb_color, t);
                    col[0] = c.r; col[1] = c.g; col[2] = c.b;
                    rough = pb->GetFloat(pb_roughness, t);
                    metal = pb->GetFloat(pb_metalness, t);
                    opac  = pb->GetFloat(pb_opacity, t);
                }
            } else {
                GetWireColor3f(node, col);
            }

            if (!first) ss << L',';
            ss << L"{\"h\":" << handle;
            ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
            ss << L",\"t\":"; WriteFloats(ss, xform, 16);
            ss << L",\"mat\":{\"color\":[" << col[0] << L',' << col[1] << L',' << col[2] << L']';
            ss << L",\"rough\":" << rough;
            ss << L",\"metal\":" << metal;
            if (opac < 0.999f) ss << L",\"opacity\":" << opac;
            ss << L"}}";
            first = false;
        }
        ss << L"],";
        WriteCameraJson(ss);
        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    // ── Window management ────────────────────────────────────

    void Resize() {
        if (controller_) { RECT b; GetClientRect(hwnd_, &b); controller_->put_Bounds(b); }
    }

    void Destroy() {
        UnregisterCallbacks();
        if (controller_) { controller_->Close(); controller_ = nullptr; }
        webview_ = nullptr; jsReady_ = false;
        if (hwnd_) { HWND h = hwnd_; hwnd_ = nullptr; DestroyWindow(h); }
    }

    static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        MaxJSPanel* p = nullptr;
        if (msg == WM_CREATE) {
            auto cs = reinterpret_cast<CREATESTRUCT*>(lParam);
            p = static_cast<MaxJSPanel*>(cs->lpCreateParams);
            SetWindowLongPtr(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(p));
        } else {
            p = reinterpret_cast<MaxJSPanel*>(GetWindowLongPtr(hwnd, GWLP_USERDATA));
        }
        switch (msg) {
        case WM_SIZE:  if (p) p->Resize(); return 0;
        case WM_TIMER: if (wParam == SYNC_TIMER_ID && p) p->OnTimer(); return 0;
        case WM_CLOSE: ShowWindow(hwnd, SW_HIDE); return 0;
        }
        return DefWindowProc(hwnd, msg, wParam, lParam);
    }
};

static void OnSceneChanged(void* param, NotifyInfo*) {
    auto* p = static_cast<MaxJSPanel*>(param);
    if (p) p->dirty_ = true;
}

// ══════════════════════════════════════════════════════════════
//  Panel toggle + MAXScript bridge
// ══════════════════════════════════════════════════════════════

void TogglePanel() {
    if (!g_panel) {
        g_panel = new MaxJSPanel();
        g_panel->Create(GetCOREInterface()->GetMAXHWnd());
    } else if (g_panel->hwnd_ && IsWindowVisible(g_panel->hwnd_)) {
        ShowWindow(g_panel->hwnd_, SW_HIDE);
    } else if (g_panel->hwnd_) {
        ShowWindow(g_panel->hwnd_, SW_SHOW);
        // Force hard reload so JS code updates without restarting Max
        if (g_panel->webview_) {
            g_panel->jsReady_ = false;
            g_panel->dirty_ = true;
            g_panel->mtlHashMap_.clear();
            // Clear virtual host cache by re-mapping, then navigate fresh
            ComPtr<ICoreWebView2_3> wv3;
            g_panel->webview_->QueryInterface(IID_PPV_ARGS(&wv3));
            if (wv3) {
                std::wstring webDir = g_panel->GetWebDir();
                if (!webDir.empty()) {
                    wv3->ClearVirtualHostNameToFolderMapping(L"maxjs.local");
                    wv3->SetVirtualHostNameToFolderMapping(
                        L"maxjs.local", webDir.c_str(),
                        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                }
            }
            g_panel->LoadContent();
        }
    } else {
        g_panel->Create(GetCOREInterface()->GetMAXHWnd());
    }
}

static void RegisterMaxScript() {
    wchar_t script[2048];
    swprintf_s(script, 2048,
        L"global MaxJS_HWND = %lld\r\n"
        L"macroScript MaxJS_Toggle category:\"MaxJS\" tooltip:\"Toggle MaxJS Viewport\" buttonText:\"MaxJS\" (\r\n"
        L"    windows.sendMessage MaxJS_HWND %d 0 0\r\n"
        L")\r\n"
        L"if menuMan.findMenu \"MaxJS\" == undefined do (\r\n"
        L"    local subMenu = menuMan.createMenu \"MaxJS\"\r\n"
        L"    local toggleItem = menuMan.createActionItem \"MaxJS_Toggle\" \"MaxJS\"\r\n"
        L"    subMenu.addItem toggleItem -1\r\n"
        L"    local mainMenu = menuMan.getMainMenuBar()\r\n"
        L"    local subMenuItem = menuMan.createSubMenuItem \"MaxJS\" subMenu\r\n"
        L"    mainMenu.addItem subMenuItem 0\r\n"
        L"    menuMan.updateMenuBar()\r\n"
        L")\r\n",
        (long long)(intptr_t)g_helperHwnd, (int)WM_TOGGLE_PANEL);
    ExecuteMAXScriptScript(script, MAXScript::ScriptSource::NonEmbedded);
}

static LRESULT CALLBACK HelperWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_TOGGLE_PANEL: TogglePanel(); return 0;
    case WM_TIMER:
        if (wParam == SETUP_TIMER_ID) { KillTimer(hwnd, SETUP_TIMER_ID); RegisterMaxScript(); }
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

// ── GUP Plugin ────────────────────────────────────────────────

class MaxJSGUP : public GUP {
public:
    DWORD Start() override {
        WNDCLASSEXW wc = {};
        wc.cbSize = sizeof(WNDCLASSEXW);
        wc.lpfnWndProc = HelperWndProc;
        wc.hInstance = hInstance;
        wc.lpszClassName = L"MaxJSHelper";
        RegisterClassExW(&wc);
        g_helperHwnd = CreateWindowExW(0, L"MaxJSHelper", L"", 0,0,0,0,0,
            HWND_MESSAGE, nullptr, hInstance, nullptr);
        SetTimer(g_helperHwnd, SETUP_TIMER_ID, 2000, nullptr);
        return GUPRESULT_KEEP;
    }

    void Stop() override {
        if (g_panel) { g_panel->Destroy(); delete g_panel; g_panel = nullptr; }
        if (g_helperHwnd) { DestroyWindow(g_helperHwnd); g_helperHwnd = nullptr; }
    }

    void DeleteThis() override { delete this; }
    DWORD_PTR Control(DWORD) override { return 0; }
};

// ── Class Descriptor + DLL ────────────────────────────────────

class MaxJSClassDesc : public ClassDesc2 {
public:
    int IsPublic() override { return TRUE; }
    void* Create(BOOL) override { return new MaxJSGUP(); }
    const TCHAR* ClassName() override { return MAXJS_NAME; }
    const TCHAR* NonLocalizedClassName() override { return MAXJS_NAME; }
    SClass_ID SuperClassID() override { return GUP_CLASS_ID; }
    Class_ID ClassID() override { return MAXJS_CLASS_ID; }
    const TCHAR* Category() override { return MAXJS_CATEGORY; }
    const TCHAR* InternalName() override { return MAXJS_NAME; }
    HINSTANCE HInstance() override { return hInstance; }
};
static MaxJSClassDesc maxJSDesc;

BOOL WINAPI DllMain(HINSTANCE hinstDLL, ULONG fdwReason, LPVOID) {
    if (fdwReason == DLL_PROCESS_ATTACH) { hInstance = hinstDLL; DisableThreadLibraryCalls(hinstDLL); }
    return TRUE;
}

__declspec(dllexport) const TCHAR* LibDescription()   { return MAXJS_NAME; }
__declspec(dllexport) int LibNumberClasses()           { return 3; }
__declspec(dllexport) ClassDesc* LibClassDesc(int i) {
    switch (i) {
        case 0: return &maxJSDesc;
        case 1: return GetThreeJSMtlDesc();
        case 2: return GetThreeJSRendererDesc();
        default: return nullptr;
    }
}
__declspec(dllexport) ULONG LibVersion()               { return VERSION_3DSMAX; }
__declspec(dllexport) int LibInitialize()              { return TRUE; }
__declspec(dllexport) int LibShutdown()                { return TRUE; }
