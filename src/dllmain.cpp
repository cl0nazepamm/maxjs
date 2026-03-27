#include <max.h>
#include <gup.h>
#include <iparamb2.h>
#include <plugapi.h>
#include <maxapi.h>
#include <triobj.h>
#include <notify.h>
#include <stdmat.h>
#include <ISceneEventManager.h>
#include <maxscript/maxscript.h>
#include "sync_protocol.h"
#include "threejs_material.h"
#include "threejs_renderer.h"

#include <wrl.h>
#include <WebView2.h>
#include <ShlObj.h>
#include <wincodec.h>
#include <string>
#include <vector>
#include <array>
#include <sstream>
#include <unordered_set>
#include <unordered_map>
#include <map>
#include <algorithm>
#include <numeric>
#include <functional>
#include <cmath>
#include <locale>

using namespace Microsoft::WRL;

#define MAXJS_CLASS_ID  Class_ID(0x7F3A9B01, 0x4E2D8C05)
#define MAXJS_NAME      _T("MaxJS")
#define MAXJS_CATEGORY  _T("MaxJS")

#define SYNC_TIMER_ID     1
#define SYNC_INTERVAL_MS  33   // background structural/material timer
#define WM_TOGGLE_PANEL   (WM_USER + 1)
#define WM_FAST_FLUSH     (WM_USER + 2)
#define WM_KILL_PANEL     (WM_USER + 3)
#define SETUP_TIMER_ID    2
#define AS_TIMER_ID       3
#define AS_INTERVAL_MS    66   // ~15fps ActiveShade

extern HINSTANCE hInstance;
HINSTANCE hInstance = nullptr;

class MaxJSPanel;
static MaxJSPanel* g_panel = nullptr;
static HWND g_helperHwnd = nullptr;

// Forward — used by renderer's ActiveShade
static void TogglePanel();
static void KillPanel();
void ToggleMaxJSPanel(); // defined after class
void StartMaxJSActiveShade(Bitmap* target); // defined after class
void StopMaxJSActiveShade(); // defined after class
HWND GetMaxJSWebViewHWND(); // defined after class
void ReparentMaxJSPanel(HWND newParent); // defined after class
void RestoreMaxJSPanel(); // defined after class

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

static float SafeJsonFloat(float value, float fallback = 0.0f) {
    if (!std::isfinite(value)) return fallback;
    if (std::fabs(value) > 1.0e15f) return fallback;
    return value;
}

static void WriteFloatValue(std::wostringstream& ss, float value, float fallback = 0.0f) {
    ss << SafeJsonFloat(value, fallback);
}

static void WriteFloats(std::wostringstream& ss, const float* d, size_t n) {
    ss << L'[';
    for (size_t i = 0; i < n; i++) {
        if (i) ss << L',';
        WriteFloatValue(ss, d[i]);
    }
    ss << L']';
}

static void WriteInts(std::wostringstream& ss, const int* d, size_t n) {
    ss << L'[';
    for (size_t i = 0; i < n; i++) { if (i) ss << L','; ss << d[i]; }
    ss << L']';
}

static uint64_t HashFNV1a(const void* data, size_t bytes, uint64_t seed = 1469598103934665603ULL) {
    const unsigned char* p = static_cast<const unsigned char*>(data);
    uint64_t h = seed;
    for (size_t i = 0; i < bytes; i++) {
        h ^= static_cast<uint64_t>(p[i]);
        h *= 1099511628211ULL;
    }
    return h;
}

static uint64_t HashMeshData(const std::vector<float>& verts,
                             const std::vector<int>& indices,
                             const std::vector<float>& uvs) {
    uint64_t h = 1469598103934665603ULL;
    if (!verts.empty())
        h = HashFNV1a(verts.data(), verts.size() * sizeof(float), h);
    if (!indices.empty())
        h = HashFNV1a(indices.data(), indices.size() * sizeof(int), h);
    if (!uvs.empty())
        h = HashFNV1a(uvs.data(), uvs.size() * sizeof(float), h);
    return h;
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

// WriteMaterialFull is a member function of MaxJSPanel

// ── Wire Color helper ──────────────────────────────────────────

static void GetWireColor3f(INode* node, float out[3]) {
    COLORREF wc = node->GetWireColor();
    out[0] = GetRValue(wc)/255.0f; out[1] = GetGValue(wc)/255.0f; out[2] = GetBValue(wc)/255.0f;
}

// ══════════════════════════════════════════════════════════════
//  Material PBR Extraction
//  Priority: ThreeJS Material (direct) > Shell viewport sub > wire color
// ══════════════════════════════════════════════════════════════

struct MaxJSPBR {
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
// glTF Material Class_ID = (943849874, 1174294043)
#define GLTF_MTL_CLASS_ID Class_ID(943849874, 1174294043)

static bool IsSupportedMaterial(Mtl* mtl) {
    if (!mtl) return false;
    Class_ID cid = mtl->ClassID();
    return cid == THREEJS_MTL_CLASS_ID || cid == GLTF_MTL_CLASS_ID;
}

// Find ThreeJS or glTF Material in material tree — uses ClassID only
static Mtl* FindSupportedMaterial(Mtl* mtl) {
    if (!mtl) return nullptr;

    Class_ID cid = mtl->ClassID();

    // Direct match
    if (IsSupportedMaterial(mtl)) return mtl;

    // Shell Material — check both subs
    if (cid == SHELL_MTL_CLASS_ID && mtl->NumSubMtls() >= 2) {
        for (int i = 0; i < mtl->NumSubMtls(); i++) {
            Mtl* sub = mtl->GetSubMtl(i);
            if (IsSupportedMaterial(sub)) return sub;
        }
    }

    // Multi/Sub
    if (mtl->NumSubMtls() > 0 && cid != SHELL_MTL_CLASS_ID) {
        for (int i = 0; i < mtl->NumSubMtls(); i++) {
            Mtl* found = FindSupportedMaterial(mtl->GetSubMtl(i));
            if (found) return found;
        }
    }

    return nullptr;
}

// Keep old name working for transform sync
static Mtl* FindThreeJSMaterial(Mtl* mtl) { return FindSupportedMaterial(mtl); }

static void ExtractThreeJSMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
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

// Extract PBR from glTF Material — generic paramblock reader
static void ExtractGltfMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();

    // glTF colors are 0-255 in Max, need /255
    auto readColor = [&](const MCHAR* pname, float out[3]) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) {
                    if (pd.type == TYPE_RGBA || pd.type == TYPE_FRGBA) {
                        Color c = pb->GetColor(pid, t);
                        out[0] = c.r; out[1] = c.g; out[2] = c.b;
                    }
                    return;
                }
            }
        }
    };
    auto readFloat = [&](const MCHAR* pname, float def) -> float {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_FLOAT)
                    return pb->GetFloat(pid, t);
            }
        }
        return def;
    };
    auto readInt = [&](const MCHAR* pname, int def) -> int {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_INT || pd.type == TYPE_BOOL))
                    return pb->GetInt(pid, t);
            }
        }
        return def;
    };
    auto readMap = [&](const MCHAR* pname) -> std::wstring {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    return FindBitmapFile(map);
                }
            }
        }
        return {};
    };

    readColor(_T("baseColor"), d.color);

    d.roughness   = readFloat(_T("roughness"), 0.5f);
    d.metalness   = readFloat(_T("metalness"), 0.0f);
    d.normalScale = readFloat(_T("normal"), 1.0f);
    d.aoIntensity = readFloat(_T("ambientOcclusion"), 1.0f);
    d.opacity     = 1.0f;  // glTF uses alphaMode, not direct opacity
    d.doubleSided = readInt(_T("DoubleSided"), 0) != 0;

    readColor(_T("emissionColor"), d.emission);
    d.emIntensity = (d.emission[0] + d.emission[1] + d.emission[2] > 0) ? 1.0f : 0.0f;

    d.colorMap     = readMap(_T("baseColorMap"));
    d.roughnessMap = readMap(_T("roughnessMap"));
    d.metalnessMap = readMap(_T("metalnessMap"));
    d.normalMap    = readMap(_T("normalMap"));
    d.aoMap        = readMap(_T("ambientOcclusionMap"));
    d.emissionMap  = readMap(_T("emissionMap"));
    d.opacityMap   = readMap(_T("AlphaMap"));
}

// Extract PBR from a single material (ThreeJS, glTF, or wire color fallback)
static void ExtractPBRFromMtl(Mtl* mtl, INode* node, TimeValue t, MaxJSPBR& d) {
    if (mtl) {
        Mtl* found = FindSupportedMaterial(mtl);
        if (found) {
            if (found->ClassID() == THREEJS_MTL_CLASS_ID)
                ExtractThreeJSMtl(found, t, d);
            else
                ExtractGltfMtl(found, t, d);
            return;
        }
    }
    if (node) GetWireColor3f(node, d.color);
}

// Find the Multi/Sub material if any (unwrap Shell if needed)
static Mtl* FindMultiSubMtl(Mtl* mtl) {
    if (!mtl) return nullptr;
    if (mtl->IsMultiMtl()) return mtl;
    if (mtl->ClassID() == SHELL_MTL_CLASS_ID) {
        for (int i = 0; i < mtl->NumSubMtls(); i++) {
            Mtl* sub = mtl->GetSubMtl(i);
            if (sub && sub->IsMultiMtl()) return sub;
        }
    }
    return nullptr;
}

static Mtl* GetSubMtlFromMatID(Mtl* multiMtl, int matID) {
    if (!multiMtl) return nullptr;
    const int subCount = multiMtl->NumSubMtls();
    if (subCount <= 0) return nullptr;
    int idx = matID % subCount;
    if (idx < 0) idx += subCount;
    return multiMtl->GetSubMtl(idx);
}

static void ExtractPBR(INode* node, TimeValue t, MaxJSPBR& d) {
    Mtl* mtl = node->GetMtl();

    // Priority 1: ThreeJS Material or glTF Material (direct or inside Shell)
    Mtl* found = FindSupportedMaterial(mtl);
    if (found) {
        if (found->ClassID() == THREEJS_MTL_CLASS_ID)
            ExtractThreeJSMtl(found, t, d);
        else
            ExtractGltfMtl(found, t, d);
        return;
    }

    // Priority 2: Wire color fallback (old material conversion disabled for speed)
    GetWireColor3f(node, d.color);
}

// ══════════════════════════════════════════════════════════════
//  Mesh Extraction with UV coordinates + Multi/Sub material groups
// ══════════════════════════════════════════════════════════════

struct MatGroup { int matID; int start; int count; };

struct MeshCornerKey {
    DWORD posIdx = 0;
    DWORD uvIdx = 0;
    DWORD smGroup = 0;

    bool operator==(const MeshCornerKey& other) const {
        return posIdx == other.posIdx &&
               uvIdx == other.uvIdx &&
               smGroup == other.smGroup;
    }
};

struct MeshCornerKeyHash {
    size_t operator()(const MeshCornerKey& key) const noexcept {
        size_t h = static_cast<size_t>(key.posIdx);
        h = h * 16777619u ^ static_cast<size_t>(key.uvIdx);
        h = h * 16777619u ^ static_cast<size_t>(key.smGroup);
        return h;
    }
};

static bool ExtractMesh(INode* node, TimeValue t,
                        std::vector<float>& verts,
                        std::vector<float>& uvs,
                        std::vector<int>& indices,
                        std::vector<MatGroup>& groups) {
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

    // Collect face order sorted by matID only when multiple IDs exist.
    std::vector<int> faceOrder;
    faceOrder.reserve(nf);
    int firstMatID = (int)mesh.faces[0].getMatID();
    bool multiMatIDs = false;
    for (int f = 0; f < nf; f++) {
        faceOrder.push_back(f);
        if ((int)mesh.faces[f].getMatID() != firstMatID) multiMatIDs = true;
    }
    if (multiMatIDs) {
        std::sort(faceOrder.begin(), faceOrder.end(), [&](int a, int b) {
            return mesh.faces[a].getMatID() < mesh.faces[b].getMatID();
        });
    }

    // Build indexed mesh with split vertices at UV seams
    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    verts.reserve(nv * 3);
    if (hasUVs) uvs.reserve(nv * 2);
    indices.reserve(nf * 3);

    int curMatID = -1;
    for (int fi = 0; fi < nf; fi++) {
        int f = faceOrder[fi];
        int matID = (int)mesh.faces[f].getMatID();

        // Track material groups
        if (matID != curMatID) {
            curMatID = matID;
            groups.push_back({ matID, (int)indices.size(), 0 });
        }

        for (int v = 0; v < 3; v++) {
            DWORD posIdx = mesh.faces[f].v[v];
            DWORD uvIdx  = hasUVs ? mesh.tvFace[f].t[v] : 0;
            MeshCornerKey key = {
                posIdx,
                uvIdx,
                mesh.faces[f].getSmGroup()
            };

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
        groups.back().count += 3;
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

static bool TransformEquals16(const float* a, const float* b, float epsilon = 1.0e-4f) {
    for (int i = 0; i < 16; ++i) {
        if (std::fabs(a[i] - b[i]) > epsilon) return false;
    }
    return true;
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

static bool NearlyEqualFloat(float a, float b, float epsilon = 1.0e-4f) {
    return std::fabs(a - b) <= epsilon;
}

static bool CameraEquals(const CameraData& a, const CameraData& b) {
    for (int i = 0; i < 3; ++i) {
        if (!NearlyEqualFloat(a.pos[i], b.pos[i])) return false;
        if (!NearlyEqualFloat(a.target[i], b.target[i])) return false;
        if (!NearlyEqualFloat(a.up[i], b.up[i])) return false;
    }
    if (!NearlyEqualFloat(a.fov, b.fov, 1.0e-3f)) return false;
    return a.perspective == b.perspective;
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

class MaxJSFastNodeEventCallback : public INodeEventCallback {
public:
    explicit MaxJSFastNodeEventCallback(MaxJSPanel* owner) : owner_(owner) {}

    void ControllerStructured(NodeKeyTab& nodes) override;
    void ControllerOtherEvent(NodeKeyTab& nodes) override;
    void LinkChanged(NodeKeyTab& nodes) override;
    void SelectionChanged(NodeKeyTab& nodes) override;
    void HideChanged(NodeKeyTab& nodes) override;

private:
    MaxJSPanel* owner_;
};

class MaxJSFastRedrawCallback : public RedrawViewsCallback {
public:
    explicit MaxJSFastRedrawCallback(MaxJSPanel* owner) : owner_(owner) {}

    void proc(Interface* ip) override;

private:
    MaxJSPanel* owner_;
};

class MaxJSFastTimeChangeCallback : public TimeChangeCallback {
public:
    explicit MaxJSFastTimeChangeCallback(MaxJSPanel* owner) : owner_(owner) {}

    void TimeChanged(TimeValue t) override;

private:
    MaxJSPanel* owner_;
};

// ══════════════════════════════════════════════════════════════
//  WebView2 Panel
// ══════════════════════════════════════════════════════════════

static const wchar_t* kWindowClass = L"MaxJSPanel";

class MaxJSPanel {
public:
    HWND hwnd_ = nullptr;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> webview_;
    ComPtr<ICoreWebView2Environment> env_;

    bool jsReady_ = false;
    bool dirty_ = true;
    bool useBinary_ = false;
    std::uint32_t nextFrameId_ = 1;
    int tickCount_ = 0;
    size_t geoScanCursor_ = 0;
    std::unordered_set<ULONG> geomHandles_;
    std::unordered_set<ULONG> fastDirtyHandles_;
    std::unordered_map<ULONG, std::array<float, 16>> lastSentTransforms_;
    std::unordered_map<ULONG, uintptr_t> mtlHashMap_;  // node handle → material state hash
    std::unordered_map<ULONG, uint64_t> geoHashMap_;   // node handle → geometry topology hash
    std::map<std::wstring, std::wstring> texDirMap_;    // dir → host
    int texDirCount_ = 0;
    bool fastCameraDirty_ = false;
    bool fastFlushPosted_ = false;
    bool haveLastSentCamera_ = false;
    CameraData lastSentCamera_ = {};
    SceneEventNamespace::CallbackKey fastNodeEventCallbackKey_ = 0;
    MaxJSFastNodeEventCallback fastNodeEvents_;
    MaxJSFastRedrawCallback fastRedrawCallback_;
    MaxJSFastTimeChangeCallback fastTimeChangeCallback_;

    MaxJSPanel()
        : fastNodeEvents_(this)
        , fastRedrawCallback_(this)
        , fastTimeChangeCallback_(this) {
    }

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
                    env_ = env;  // Store for SharedBuffer API
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

        // Prefer shared-buffer transport when the runtime supports it.
        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        useBinary_ = SUCCEEDED(webview_->QueryInterface(IID_PPV_ARGS(&wv17))) && wv17
                  && SUCCEEDED(env_->QueryInterface(IID_PPV_ARGS(&env12))) && env12;

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

    bool IsTrackedHandle(ULONG handle) const {
        return geomHandles_.find(handle) != geomHandles_.end();
    }

    void QueueFastFlush() {
        if (!hwnd_ || dirty_ || fastFlushPosted_) return;
        fastFlushPosted_ = true;
        if (!PostMessage(hwnd_, WM_FAST_FLUSH, 0, 0)) {
            fastFlushPosted_ = false;
        }
    }

    void CaptureCurrentCameraState() {
        GetViewportCamera(lastSentCamera_);
        haveLastSentCamera_ = true;
    }

    void RememberSentTransform(ULONG handle, const float* xform) {
        std::array<float, 16> cached = {};
        std::copy(xform, xform + 16, cached.begin());
        lastSentTransforms_[handle] = cached;
    }

    void ResetFastPathState(bool refreshCameraState = false) {
        fastDirtyHandles_.clear();
        fastCameraDirty_ = false;
        fastFlushPosted_ = false;
        if (refreshCameraState) CaptureCurrentCameraState();
        else haveLastSentCamera_ = false;
    }

    template <typename Fn>
    void VisitNodeSubtree(INode* node, Fn&& fn) {
        if (!node) return;
        fn(node);
        for (int i = 0; i < node->NumberOfChildren(); ++i) {
            VisitNodeSubtree(node->GetChildNode(i), std::forward<Fn>(fn));
        }
    }

    void MarkTrackedNodeDirty(INode* node) {
        bool changed = false;
        VisitNodeSubtree(node, [this, &changed](INode* current) {
            const ULONG handle = current->GetHandle();
            if (!IsTrackedHandle(handle)) return;
            if (fastDirtyHandles_.insert(handle).second) changed = true;
        });
        if (changed) QueueFastFlush();
    }

    void MarkTrackedNodesDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        for (int i = 0; i < nodes.Count(); ++i) {
            MarkTrackedNodeDirty(NodeEventNamespace::GetNodeByKey(nodes[i]));
        }
    }

    void MarkSelectedTransformsDirty() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const int selCount = ip->GetSelNodeCount();
        if (selCount <= 0) return;

        TimeValue t = ip->GetTime();
        bool changed = false;
        for (int i = 0; i < selCount; ++i) {
            INode* node = ip->GetSelNode(i);
            if (!node) continue;

            VisitNodeSubtree(node, [this, t, &changed](INode* current) {
                const ULONG handle = current->GetHandle();
                if (!IsTrackedHandle(handle)) return;

                float xform[16];
                GetTransform16(current, t, xform);

                auto it = lastSentTransforms_.find(handle);
                if (it == lastSentTransforms_.end() || !TransformEquals16(xform, it->second.data())) {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                }
            });
        }

        if (changed) QueueFastFlush();
    }

    void MarkVisibilityNodesDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        bool changed = false;
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;

            VisitNodeSubtree(node, [this, &changed](INode* current) {
                const ULONG handle = current->GetHandle();
                if (IsTrackedHandle(handle)) {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                    return;
                }

                // A node that becomes visible after being absent from the last full sync
                // needs geometry/bootstrap data, not just a transform delta.
                if (!current->IsNodeHidden(TRUE)) dirty_ = true;
            });
        }

        if (!dirty_ && changed) QueueFastFlush();
    }

    void MarkAllTrackedNodesDirty() {
        if (geomHandles_.empty()) return;
        fastDirtyHandles_.insert(geomHandles_.begin(), geomHandles_.end());
        QueueFastFlush();
    }

    void MarkCameraDirty() {
        fastCameraDirty_ = true;
        QueueFastFlush();
    }

    void MarkCameraDirtyIfChanged() {
        CameraData current = {};
        GetViewportCamera(current);
        if (!haveLastSentCamera_ || !CameraEquals(lastSentCamera_, current)) {
            fastCameraDirty_ = true;
            QueueFastFlush();
        }
    }

    void RegisterCallbacks() {
        RegisterNotification(OnSceneChanged, this, NOTIFY_SCENE_ADDED_NODE);
        RegisterNotification(OnSceneChanged, this, NOTIFY_SCENE_PRE_DELETED_NODE);
        RegisterNotification(OnSceneChanged, this, NOTIFY_FILE_POST_OPEN);
        RegisterNotification(OnSceneChanged, this, NOTIFY_SYSTEM_POST_RESET);

        Interface* ip = GetCOREInterface();
        if (ip) {
            ip->RegisterRedrawViewsCallback(&fastRedrawCallback_);
            ip->RegisterTimeChangeCallback(&fastTimeChangeCallback_);
        }

        ISceneEventManager* sceneEvents = GetISceneEventManager();
        if (sceneEvents && !fastNodeEventCallbackKey_) {
            fastNodeEventCallbackKey_ = sceneEvents->RegisterCallback(&fastNodeEvents_, FALSE, 0, FALSE);
        }

        SetTimer(hwnd_, SYNC_TIMER_ID, SYNC_INTERVAL_MS, nullptr);
    }

    void UnregisterCallbacks() {
        KillTimer(hwnd_, SYNC_TIMER_ID);

        ISceneEventManager* sceneEvents = GetISceneEventManager();
        if (sceneEvents && fastNodeEventCallbackKey_) {
            sceneEvents->UnRegisterCallback(fastNodeEventCallbackKey_);
            fastNodeEventCallbackKey_ = 0;
        }

        Interface* ip = GetCOREInterface();
        if (ip) {
            ip->UnRegisterRedrawViewsCallback(&fastRedrawCallback_);
            ip->UnRegisterTimeChangeCallback(&fastTimeChangeCallback_);
        }

        UnRegisterNotification(OnSceneChanged, this, NOTIFY_SCENE_ADDED_NODE);
        UnRegisterNotification(OnSceneChanged, this, NOTIFY_SCENE_PRE_DELETED_NODE);
        UnRegisterNotification(OnSceneChanged, this, NOTIFY_FILE_POST_OPEN);
        UnRegisterNotification(OnSceneChanged, this, NOTIFY_SYSTEM_POST_RESET);
    }

    void OnWebMessage(const wchar_t* json) {
        std::wstring msg(json);
        if (msg.find(L"\"kill\"") != std::wstring::npos) {
            if (hwnd_) PostMessage(hwnd_, WM_KILL_PANEL, 0, 0);
            return;
        }
        if (msg.find(L"\"ready\"") != std::wstring::npos) {
            jsReady_ = true; dirty_ = true;
            mtlHashMap_.clear();
            geoHashMap_.clear();  // force all geometry to be sent
            lastSentTransforms_.clear();
            geoScanCursor_ = 0;
            ResetFastPathState(false);
        }
    }

    void OnTimer() {
        if (!jsReady_ || !webview_) return;
        if (!hwnd_ || !IsWindowVisible(hwnd_)) return;
        tickCount_++;

        if (dirty_) {
            dirty_ = false;
            if (useBinary_) SendFullSyncBinary(); else SendFullSync();
        } else {
            if (tickCount_ % 50 == 0) DetectMaterialChanges();
            if (tickCount_ % 15 == 0) DetectGeometryChanges();
        }
    }

    void FlushFastPath() {
        fastFlushPosted_ = false;

        if (!jsReady_ || !webview_ || dirty_) return;
        if (!hwnd_ || !IsWindowVisible(hwnd_)) return;

        std::vector<ULONG> dirtyHandles;
        dirtyHandles.reserve(fastDirtyHandles_.size());
        for (ULONG handle : fastDirtyHandles_) dirtyHandles.push_back(handle);

        const bool hasDirtyNodes = !dirtyHandles.empty();
        const bool hasDirtyCamera = fastCameraDirty_;
        if (!hasDirtyNodes && !hasDirtyCamera) return;

        fastDirtyHandles_.clear();
        fastCameraDirty_ = false;

        if (!useBinary_) {
            if (hasDirtyNodes) SendTransformSync();
            else SendCameraSync();
            CaptureCurrentCameraState();
            return;
        }

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!wv17 || !env12) {
            if (hasDirtyNodes) SendTransformSync();
            else SendCameraSync();
            CaptureCurrentCameraState();
            return;
        }

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        const std::uint32_t frameId = AllocateFrameId();
        maxjs::sync::DeltaFrameBuilder frame(frameId);
        frame.BeginFrame();

        for (ULONG handle : dirtyHandles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                geomHandles_.erase(handle);
                lastSentTransforms_.erase(handle);
                dirty_ = true;
                continue;
            }

            float xform[16];
            GetTransform16(node, t, xform);
            RememberSentTransform(handle, xform);
            frame.UpdateTransform(static_cast<std::uint32_t>(handle), xform);
            frame.UpdateSelection(static_cast<std::uint32_t>(handle), node->Selected() != 0);
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), !node->IsNodeHidden(TRUE));
        }

        if (hasDirtyCamera) {
            CameraData cam = {};
            GetViewportCamera(cam);
            frame.UpdateCamera(cam.pos, cam.target, cam.up, cam.fov, cam.perspective);
            lastSentCamera_ = cam;
            haveLastSentCamera_ = true;
        }

        frame.EndFrame();
        if (frame.command_count() == 0) return;

        const auto& frameBytes = frame.bytes();
        const size_t totalBytes = frameBytes.empty() ? 4 : frameBytes.size();

        ComPtr<ICoreWebView2SharedBuffer> sharedBuf;
        HRESULT hr = env12->CreateSharedBuffer(totalBytes, &sharedBuf);
        if (FAILED(hr) || !sharedBuf) {
            if (hasDirtyNodes) SendTransformSync();
            else SendCameraSync();
            CaptureCurrentCameraState();
            return;
        }

        BYTE* bufPtr = nullptr;
        sharedBuf->get_Buffer(&bufPtr);
        if (bufPtr && !frameBytes.empty()) {
            memcpy(bufPtr, frameBytes.data(), frameBytes.size());
        }

        std::wostringstream meta;
        meta.imbue(std::locale::classic());
        meta << L"{\"type\":\"delta_bin\",\"frame\":" << frameId;
        meta << L",\"stats\":{\"producerBytes\":" << frameBytes.size();
        meta << L",\"commandCount\":" << frame.command_count() << L"}}";

        wv17->PostSharedBufferToScript(
            sharedBuf.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            meta.str().c_str());
    }

    void SendCameraSync() {
        const std::uint32_t frameId = AllocateFrameId();
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"cam\",\"frame\":" << frameId << L",";
        WriteCameraJson(ss);
        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void SendBinaryDeltaSync(bool includeMaterialScalars) {
        if (!webview_ || !env_) return;

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!wv17 || !env12) {
            if (geomHandles_.empty()) SendCameraSync();
            else SendTransformSync();
            return;
        }

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        const std::uint32_t frameId = AllocateFrameId();
        maxjs::sync::DeltaFrameBuilder frame(frameId);
        frame.BeginFrame();

        for (auto it = geomHandles_.begin(); it != geomHandles_.end(); ) {
            ULONG handle = *it;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                it = geomHandles_.erase(it);
                continue;
            }

            float xform[16];
            GetTransform16(node, t, xform);
            frame.UpdateTransform(static_cast<std::uint32_t>(handle), xform);
            frame.UpdateSelection(static_cast<std::uint32_t>(handle), node->Selected() != 0);
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), !node->IsNodeHidden(TRUE));

            if (includeMaterialScalars) {
                float col[3] = {0.8f, 0.8f, 0.8f};
                float rough = 0.5f;
                float metal = 0.0f;
                float opac = 1.0f;

                Mtl* foundMtl = FindSupportedMaterial(node->GetMtl());
                if (foundMtl && foundMtl->ClassID() == THREEJS_MTL_CLASS_ID) {
                    IParamBlock2* pb = foundMtl->GetParamBlockByID(threejs_params);
                    if (pb) {
                        Color c = pb->GetColor(pb_color, t);
                        col[0] = c.r; col[1] = c.g; col[2] = c.b;
                        rough = pb->GetFloat(pb_roughness, t);
                        metal = pb->GetFloat(pb_metalness, t);
                        opac = pb->GetFloat(pb_opacity, t);
                    }
                } else if (foundMtl && foundMtl->ClassID() == GLTF_MTL_CLASS_ID) {
                    MaxJSPBR tmp;
                    ExtractGltfMtl(foundMtl, t, tmp);
                    col[0] = tmp.color[0]; col[1] = tmp.color[1]; col[2] = tmp.color[2];
                    rough = tmp.roughness; metal = tmp.metalness; opac = tmp.opacity;
                } else {
                    GetWireColor3f(node, col);
                }

                Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                if (!(multiMtl && multiMtl->NumSubMtls() > 1)) {
                    frame.UpdateMaterialScalar(static_cast<std::uint32_t>(handle), col, rough, metal, opac);
                }
            }

            ++it;
        }

        CameraData cam = {};
        GetViewportCamera(cam);
        frame.UpdateCamera(cam.pos, cam.target, cam.up, cam.fov, cam.perspective);
        frame.EndFrame();

        const auto& frameBytes = frame.bytes();
        const size_t totalBytes = frameBytes.empty() ? 4 : frameBytes.size();

        ComPtr<ICoreWebView2SharedBuffer> sharedBuf;
        HRESULT hr = env12->CreateSharedBuffer(totalBytes, &sharedBuf);
        if (FAILED(hr) || !sharedBuf) {
            if (geomHandles_.empty()) SendCameraSync();
            else SendTransformSync();
            return;
        }

        BYTE* bufPtr = nullptr;
        sharedBuf->get_Buffer(&bufPtr);
        if (bufPtr && !frameBytes.empty()) {
            memcpy(bufPtr, frameBytes.data(), frameBytes.size());
        }

        std::wostringstream meta;
        meta.imbue(std::locale::classic());
        meta << L"{\"type\":\"delta_bin\",\"frame\":" << frameId;
        meta << L",\"stats\":{\"producerBytes\":" << frameBytes.size();
        meta << L",\"commandCount\":" << frame.command_count() << L"}}";

        wv17->PostSharedBufferToScript(sharedBuf.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            meta.str().c_str());
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
            std::function<void(Mtl*)> hashMtlTree = [&](Mtl* mtl) {
                if (!mtl) return;
                hash ^= (uintptr_t)mtl * 11400714819323198485ull;
                for (int b = 0; b < mtl->NumParamBlocks(); b++) {
                    IParamBlock2* pb = mtl->GetParamBlock(b);
                    if (!pb) continue;
                    for (int i = 0; i < pb->NumParams(); i++) {
                        ParamID pid = pb->IndextoID(i);
                        const ParamDef& pd = pb->GetParamDef(pid);
                        if (pd.type == TYPE_TEXMAP)
                            hash ^= (uintptr_t)pb->GetTexmap(pid, t) * 2654435761ULL;
                    }
                }
                for (int i = 0; i < mtl->NumSubMtls(); i++) {
                    hashMtlTree(mtl->GetSubMtl(i));
                }
            };
            hashMtlTree(rawMtl);

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

    // Detect geometry edits that keep the same topology counts (e.g. deforms)
    // and trigger a binary/full resync on the next tick.
    void DetectGeometryChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        if (geomHandles_.empty()) return;

        std::vector<ULONG> handles;
        handles.reserve(geomHandles_.size());
        for (ULONG h : geomHandles_) handles.push_back(h);
        if (handles.empty()) return;
        if (geoScanCursor_ >= handles.size()) geoScanCursor_ = 0;

        // Time-sliced scan to avoid long stalls on large scenes.
        const ULONGLONG deadlineMs = GetTickCount64() + 2; // ~2ms budget per check

        size_t checked = 0;
        size_t idx = geoScanCursor_;
        while (checked < handles.size()) {
            ULONG handle = handles[idx];
            INode* node = ip->GetINodeByHandle(handle);
            if (node) {
                std::vector<float> verts, uvs;
                std::vector<int> indices;
                std::vector<MatGroup> groups;
                if (ExtractMesh(node, t, verts, uvs, indices, groups)) {
                    uint64_t hash = HashMeshData(verts, indices, uvs);
                    auto it = geoHashMap_.find(handle);
                    if (it == geoHashMap_.end() || it->second != hash) {
                        dirty_ = true;
                        return;
                    }
                }
            }

            checked++;
            idx = (idx + 1) % handles.size();
            if (GetTickCount64() >= deadlineMs) break;
        }

        geoScanCursor_ = idx;
    }

    // ── Camera JSON fragment ─────────────────────────────────

    void WriteMaterialTextures(std::wostringstream& ss, const MaxJSPBR& pbr) {
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
        ss << L'}';
    }

    void WriteMaterialFull(std::wostringstream& ss, const MaxJSPBR& pbr) {
        ss << L"{\"name\":\"" << EscapeJson(pbr.mtlName.empty() ? L"default" : pbr.mtlName.c_str()) << L'"';
        ss << L",\"color\":[";
        WriteFloatValue(ss, pbr.color[0], 0.8f); ss << L',';
        WriteFloatValue(ss, pbr.color[1], 0.8f); ss << L',';
        WriteFloatValue(ss, pbr.color[2], 0.8f); ss << L']';
        ss << L",\"rough\":";
        WriteFloatValue(ss, pbr.roughness, 0.5f);
        ss << L",\"metal\":";
        WriteFloatValue(ss, pbr.metalness, 0.0f);
        if (pbr.opacity < 0.999f) {
            ss << L",\"opacity\":";
            WriteFloatValue(ss, pbr.opacity, 1.0f);
        }
        if (!pbr.doubleSided) ss << L",\"side\":0";
        ss << L",\"normScl\":";
        WriteFloatValue(ss, pbr.normalScale, 1.0f);
        ss << L",\"aoI\":";
        WriteFloatValue(ss, pbr.aoIntensity, 1.0f);
        ss << L",\"envI\":";
        WriteFloatValue(ss, pbr.envIntensity, 1.0f);
        if (pbr.emIntensity > 0) {
            ss << L",\"em\":[";
            WriteFloatValue(ss, pbr.emission[0], 0.0f); ss << L',';
            WriteFloatValue(ss, pbr.emission[1], 0.0f); ss << L',';
            WriteFloatValue(ss, pbr.emission[2], 0.0f); ss << L']';
            ss << L",\"emI\":";
            WriteFloatValue(ss, pbr.emIntensity, 0.0f);
        }
        if (pbr.lightmapIntensity > 0) {
            ss << L",\"lmI\":";
            WriteFloatValue(ss, pbr.lightmapIntensity, 1.0f);
            ss << L",\"lmCh\":" << pbr.lightmapChannel;
        }
        WriteMaterialTextures(ss, pbr);
    }

    void WriteCameraJson(std::wostringstream& ss) {
        CameraData cam = {};
        GetViewportCamera(cam);
        ss << L"\"camera\":{";
        ss << L"\"pos\":[";
        WriteFloatValue(ss, cam.pos[0]); ss << L',';
        WriteFloatValue(ss, cam.pos[1]); ss << L',';
        WriteFloatValue(ss, cam.pos[2]); ss << L']';
        ss << L",\"tgt\":[";
        WriteFloatValue(ss, cam.target[0]); ss << L',';
        WriteFloatValue(ss, cam.target[1]); ss << L',';
        WriteFloatValue(ss, cam.target[2]); ss << L']';
        ss << L",\"up\":[";
        WriteFloatValue(ss, cam.up[0], 0.0f); ss << L',';
        WriteFloatValue(ss, cam.up[1], 0.0f); ss << L',';
        WriteFloatValue(ss, cam.up[2], 1.0f); ss << L']';
        ss << L",\"fov\":";
        WriteFloatValue(ss, cam.fov, 60.0f);
        ss << L",\"persp\":" << (cam.perspective ? L"true" : L"false");
        ss << L'}';
    }

    std::uint32_t AllocateFrameId() {
        return nextFrameId_++;
    }

    // ── Full scene sync ──────────────────────────────────────

    void SendFullSync() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        INode* root = ip->GetRootNode();
        if (!root) return;
        const std::uint32_t frameId = AllocateFrameId();

        geomHandles_.clear();
        lastSentTransforms_.clear();

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"scene\",\"frame\":" << frameId << L",\"nodes\":[";
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
        if (!hdriUrl.empty()) {
            ss << L"\"hdri\":\"" << EscapeJson(hdriUrl.c_str()) << L'"';
            ss << L',';
        }
        ss << L"\"rot\":";
        WriteFloatValue(ss, envData.rotation, 0.0f);
        ss << L",\"exp\":";
        WriteFloatValue(ss, envData.exposure, 0.0f);
        ss << L",\"gamma\":";
        WriteFloatValue(ss, envData.gamma, 1.0f);
        ss << L",\"zup\":" << envData.zup;
        ss << L",\"flip\":" << envData.flip;
        ss << L'}';

        ss << L'}';

        webview_->PostWebMessageAsJson(ss.str().c_str());
        ResetFastPathState(true);
    }

    void WriteSceneNodes(INode* parent, TimeValue t,
                         std::wostringstream& ss, bool& first) {
        for (int i = 0; i < parent->NumberOfChildren(); i++) {
            INode* node = parent->GetChildNode(i);
            if (!node || node->IsNodeHidden(TRUE)) continue;

            std::vector<float> verts, uvs;
            std::vector<int> indices;
            std::vector<MatGroup> groups;
            if (ExtractMesh(node, t, verts, uvs, indices, groups)) {
                float xform[16]; GetTransform16(node, t, xform);

                if (!first) ss << L',';
                ss << L"{\"h\":" << node->GetHandle();
                ss << L",\"n\":\"" << EscapeJson(node->GetName()) << L'"';
                ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
                ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                RememberSentTransform(node->GetHandle(), xform);
                ss << L",\"v\":"; WriteFloats(ss, verts.data(), verts.size());
                ss << L",\"i\":"; WriteInts(ss, indices.data(), indices.size());
                if (!uvs.empty()) {
                    ss << L",\"uv\":"; WriteFloats(ss, uvs.data(), uvs.size());
                }

                // Multi/Sub material support
                Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                if (multiMtl && multiMtl->NumSubMtls() > 0 && groups.size() > 1) {
                    // Groups: [[start, count, groupIdx], ...]
                    ss << L",\"groups\":[";
                    for (size_t g = 0; g < groups.size(); g++) {
                        if (g) ss << L',';
                        ss << L'[' << groups[g].start << L',' << groups[g].count << L',' << g << L']';
                    }
                    ss << L"]";
                    // Materials array: one PBR per group
                    ss << L",\"mats\":[";
                    for (size_t g = 0; g < groups.size(); g++) {
                        if (g) ss << L',';
                        Mtl* subMtl = GetSubMtlFromMatID(multiMtl, groups[g].matID);
                        MaxJSPBR subPBR;
                        ExtractPBRFromMtl(subMtl, node, t, subPBR);
                        WriteMaterialFull(ss, subPBR);
                    }
                    ss << L"]";
                } else {
                    // Single material
                    MaxJSPBR pbr;
                    ExtractPBR(node, t, pbr);
                    ss << L",\"mat\":";
                    WriteMaterialFull(ss, pbr);
                }

                ss << L'}';  // end node
                first = false;
                geomHandles_.insert(node->GetHandle());
            }

            WriteSceneNodes(node, t, ss, first);
        }
    }

    // ── Binary scene sync via SharedBuffer ─────────────────

    void SendFullSyncBinary() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        INode* root = ip->GetRootNode();
        if (!root) return;
        const std::uint32_t frameId = AllocateFrameId();

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!wv17 || !env12) { SendFullSync(); return; }

        geomHandles_.clear();
        lastSentTransforms_.clear();

        // Collect all geometry nodes
        struct NodeGeo {
            ULONG handle;
            INode* node;
            std::vector<float> verts, uvs;
            std::vector<int> indices;
            std::vector<MatGroup> groups;
            bool changed;
            size_t vOff, iOff, uvOff;
        };
        std::vector<NodeGeo> geos;
        size_t totalBytes = 0;

        std::function<void(INode*)> collect = [&](INode* parent) {
            for (int i = 0; i < parent->NumberOfChildren(); i++) {
                INode* node = parent->GetChildNode(i);
                if (!node || node->IsNodeHidden(TRUE)) continue;
                NodeGeo ng;
                ng.node = node;
                ng.handle = node->GetHandle();
                ng.changed = false;
                if (ExtractMesh(node, t, ng.verts, ng.uvs, ng.indices, ng.groups)) {
                    // Content hash: catches deforms/UV edits even when counts are unchanged.
                    uint64_t hash = HashMeshData(ng.verts, ng.indices, ng.uvs);
                    auto it = geoHashMap_.find(ng.handle);
                    ng.changed = (it == geoHashMap_.end() || it->second != hash);
                    geoHashMap_[ng.handle] = hash;

                    if (ng.changed) {
                        ng.vOff = totalBytes;
                        totalBytes += ng.verts.size() * sizeof(float);
                        ng.iOff = totalBytes;
                        totalBytes += ng.indices.size() * sizeof(int);
                        ng.uvOff = totalBytes;
                        if (!ng.uvs.empty())
                            totalBytes += ng.uvs.size() * sizeof(float);
                    }
                    geos.push_back(std::move(ng));
                    geomHandles_.insert(ng.handle);
                }
                collect(node);
            }
        };
        collect(root);

        // Prevent stale hashes for deleted handles (important if handles are reused).
        for (auto it = geoHashMap_.begin(); it != geoHashMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = geoHashMap_.erase(it);
            else ++it;
        }
        for (auto it = mtlHashMap_.begin(); it != mtlHashMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = mtlHashMap_.erase(it);
            else ++it;
        }

        // Create shared buffer
        if (totalBytes == 0) totalBytes = 4;  // min size
        ComPtr<ICoreWebView2SharedBuffer> sharedBuf;
        HRESULT hr = env12->CreateSharedBuffer(totalBytes, &sharedBuf);
        if (FAILED(hr)) { SendFullSync(); return; }

        BYTE* bufPtr = nullptr;
        sharedBuf->get_Buffer(&bufPtr);

        // Build metadata JSON + copy geometry into buffer
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"scene_bin\",\"frame\":" << frameId;
        ss << L",\"stats\":{\"producerBytes\":" << totalBytes << L"}";
        ss << L",\"nodes\":[";
        bool first = true;

        for (auto& ng : geos) {
            float xform[16]; GetTransform16(ng.node, t, xform);
            RememberSentTransform(ng.handle, xform);
            MaxJSPBR pbr; ExtractPBR(ng.node, t, pbr);

            if (!first) ss << L',';
            ss << L"{\"h\":" << ng.handle;
            ss << L",\"n\":\"" << EscapeJson(ng.node->GetName()) << L'"';
            ss << L",\"s\":" << (ng.node->Selected() ? L'1' : L'0');
            ss << L",\"t\":"; WriteFloats(ss, xform, 16);

            // Geometry: byte offsets into shared buffer (or -1 if unchanged)
            if (ng.changed) {
                memcpy(bufPtr + ng.vOff, ng.verts.data(), ng.verts.size() * sizeof(float));
                memcpy(bufPtr + ng.iOff, ng.indices.data(), ng.indices.size() * sizeof(int));
                if (!ng.uvs.empty())
                    memcpy(bufPtr + ng.uvOff, ng.uvs.data(), ng.uvs.size() * sizeof(float));

                ss << L",\"geo\":{\"vOff\":" << ng.vOff;
                ss << L",\"vN\":" << ng.verts.size();
                ss << L",\"iOff\":" << ng.iOff;
                ss << L",\"iN\":" << ng.indices.size();
                if (!ng.uvs.empty()) {
                    ss << L",\"uvOff\":" << ng.uvOff;
                    ss << L",\"uvN\":" << ng.uvs.size();
                }
                ss << L'}';
            }

            // Multi/Sub material support
            Mtl* multiMtl = FindMultiSubMtl(ng.node->GetMtl());
            if (multiMtl && multiMtl->NumSubMtls() > 0 && ng.groups.size() > 1) {
                ss << L",\"groups\":[";
                for (size_t g = 0; g < ng.groups.size(); g++) {
                    if (g) ss << L',';
                    ss << L'[' << ng.groups[g].start << L',' << ng.groups[g].count << L',' << g << L']';
                }
                ss << L"],\"mats\":[";
                for (size_t g = 0; g < ng.groups.size(); g++) {
                    if (g) ss << L',';
                    Mtl* subMtl = GetSubMtlFromMatID(multiMtl, ng.groups[g].matID);
                    MaxJSPBR subPBR;
                    ExtractPBRFromMtl(subMtl, ng.node, t, subPBR);
                    WriteMaterialFull(ss, subPBR);
                }
                ss << L"]";
            } else {
                ss << L",\"mat\":";
                WriteMaterialFull(ss, pbr);
            }

            ss << L'}';  // node
            first = false;
        }

        ss << L"],";
        WriteCameraJson(ss);

        // Environment
        EnvData envData; GetEnvironment(envData);
        std::wstring hdriUrl = MapTexturePath(envData.hdriPath);
        ss << L",\"env\":{";
        if (!hdriUrl.empty()) {
            ss << L"\"hdri\":\"" << EscapeJson(hdriUrl.c_str()) << L'"';
            ss << L',';
        }
        ss << L"\"rot\":";
        WriteFloatValue(ss, envData.rotation, 0.0f);
        ss << L",\"exp\":";
        WriteFloatValue(ss, envData.exposure, 0.0f);
        ss << L",\"gamma\":";
        WriteFloatValue(ss, envData.gamma, 1.0f);
        ss << L",\"zup\":" << envData.zup;
        ss << L",\"flip\":" << envData.flip;
        ss << L'}';
        ss << L'}';

        wv17->PostSharedBufferToScript(sharedBuf.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            ss.str().c_str());
        ResetFastPathState(true);
    }

    // ── Transform-only sync ──────────────────────────────────

    void SendTransformSync() {
        if (geomHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        const std::uint32_t frameId = AllocateFrameId();

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"xform\",\"frame\":" << frameId << L",\"nodes\":[";
        bool first = true;
        for (auto it = geomHandles_.begin(); it != geomHandles_.end(); ) {
            ULONG handle = *it;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                lastSentTransforms_.erase(handle);
                it = geomHandles_.erase(it);
                continue;
            }
            float xform[16]; GetTransform16(node, t, xform);
            RememberSentTransform(handle, xform);

            // Lightweight material scalars (no texture walks)
            float col[3] = {0.8f,0.8f,0.8f};
            float rough = 0.5f, metal = 0.0f, opac = 1.0f;
            Mtl* foundMtl = FindSupportedMaterial(node->GetMtl());
            if (foundMtl && foundMtl->ClassID() == THREEJS_MTL_CLASS_ID) {
                IParamBlock2* pb = foundMtl->GetParamBlockByID(threejs_params);
                if (pb) {
                    Color c = pb->GetColor(pb_color, t);
                    col[0] = c.r; col[1] = c.g; col[2] = c.b;
                    rough = pb->GetFloat(pb_roughness, t);
                    metal = pb->GetFloat(pb_metalness, t);
                    opac  = pb->GetFloat(pb_opacity, t);
                }
            } else if (foundMtl && foundMtl->ClassID() == GLTF_MTL_CLASS_ID) {
                // Read glTF params via generic paramblock scan
                MaxJSPBR tmp;
                ExtractGltfMtl(foundMtl, t, tmp);
                col[0] = tmp.color[0]; col[1] = tmp.color[1]; col[2] = tmp.color[2];
                rough = tmp.roughness; metal = tmp.metalness; opac = tmp.opacity;
            } else {
                GetWireColor3f(node, col);
            }

            if (!first) ss << L',';
            ss << L"{\"h\":" << handle;
            ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
            ss << L",\"t\":"; WriteFloats(ss, xform, 16);
            // For Multi/Sub objects, skip scalar material pushes to avoid
            // corrupting material arrays on the web side.
            Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
            if (!(multiMtl && multiMtl->NumSubMtls() > 1)) {
                ss << L",\"mat\":{\"color\":[";
                WriteFloatValue(ss, col[0], 0.8f); ss << L',';
                WriteFloatValue(ss, col[1], 0.8f); ss << L',';
                WriteFloatValue(ss, col[2], 0.8f); ss << L']';
                ss << L",\"rough\":";
                WriteFloatValue(ss, rough, 0.5f);
                ss << L",\"metal\":";
                WriteFloatValue(ss, metal, 0.0f);
                if (opac < 0.999f) {
                    ss << L",\"opacity\":";
                    WriteFloatValue(ss, opac, 1.0f);
                }
                ss << L"}";
            }
            ss << L"}";
            first = false;
            ++it;
        }
        ss << L"],";
        WriteCameraJson(ss);
        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    // ── ActiveShade capture ─────────────────────────────────

    Bitmap* asTarget_ = nullptr;
    bool asCapturing_ = false;
    HWND originalParent_ = nullptr;
    LONG originalStyle_ = 0;
    RECT originalRect_ = {};

    void StartActiveShade(Bitmap* target) {
        asTarget_ = target;
        asCapturing_ = true;
        if (hwnd_) SetTimer(hwnd_, AS_TIMER_ID, AS_INTERVAL_MS, nullptr);
    }

    void StopActiveShade() {
        asCapturing_ = false;
        asTarget_ = nullptr;
        if (hwnd_) KillTimer(hwnd_, AS_TIMER_ID);
    }

    // Reparent WebView2 into a viewport HWND — true GPU overlay
    void ReparentIntoViewport(HWND viewportHwnd) {
        if (!hwnd_ || !viewportHwnd) return;

        // Save original state
        originalParent_ = GetParent(hwnd_);
        originalStyle_ = GetWindowLong(hwnd_, GWL_STYLE);
        GetWindowRect(hwnd_, &originalRect_);

        // Strip window chrome, make it a child of the viewport
        SetWindowLong(hwnd_, GWL_STYLE, WS_CHILD | WS_VISIBLE);
        SetParent(hwnd_, viewportHwnd);

        // Fill the viewport
        RECT vpRect;
        GetClientRect(viewportHwnd, &vpRect);
        SetWindowPos(hwnd_, HWND_TOP, 0, 0,
            vpRect.right, vpRect.bottom, SWP_SHOWWINDOW);
        Resize();
    }

    // Restore to original floating window
    void RestoreFromViewport() {
        if (!hwnd_ || !originalParent_) return;

        SetParent(hwnd_, originalParent_);
        SetWindowLong(hwnd_, GWL_STYLE, originalStyle_);
        SetWindowPos(hwnd_, nullptr,
            originalRect_.left, originalRect_.top,
            originalRect_.right - originalRect_.left,
            originalRect_.bottom - originalRect_.top,
            SWP_NOZORDER | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
        originalParent_ = nullptr;
        Resize();
    }

    void CaptureActiveShadeFrame() {
        if (!webview_ || !asTarget_ || !asCapturing_) return;

        ComPtr<IStream> stream;
        CreateStreamOnHGlobal(NULL, TRUE, &stream);

        webview_->CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
            stream.Get(),
            Callback<ICoreWebView2CapturePreviewCompletedHandler>(
                [this, stream](HRESULT hr) -> HRESULT {
                    if (FAILED(hr) || !asTarget_) return S_OK;

                    // Reset stream
                    LARGE_INTEGER zero = {};
                    stream->Seek(zero, STREAM_SEEK_SET, nullptr);

                    // Decode JPEG via WIC
                    ComPtr<IWICImagingFactory> wic;
                    CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic));
                    if (!wic) return S_OK;

                    ComPtr<IWICBitmapDecoder> decoder;
                    wic->CreateDecoderFromStream(stream.Get(), nullptr,
                        WICDecodeMetadataCacheOnLoad, &decoder);
                    if (!decoder) return S_OK;

                    ComPtr<IWICBitmapFrameDecode> frame;
                    decoder->GetFrame(0, &frame);
                    if (!frame) return S_OK;

                    UINT srcW, srcH;
                    frame->GetSize(&srcW, &srcH);

                    // Scale to target bitmap size
                    int dstW = asTarget_->Width();
                    int dstH = asTarget_->Height();

                    ComPtr<IWICBitmapScaler> scaler;
                    wic->CreateBitmapScaler(&scaler);
                    scaler->Initialize(frame.Get(), dstW, dstH,
                        WICBitmapInterpolationModeLinear);

                    // Convert to BGRA
                    ComPtr<IWICFormatConverter> converter;
                    wic->CreateFormatConverter(&converter);
                    converter->Initialize(scaler.Get(),
                        GUID_WICPixelFormat32bppBGRA,
                        WICBitmapDitherTypeNone, nullptr, 0,
                        WICBitmapPaletteTypeCustom);

                    // Read pixels
                    std::vector<BYTE> pixels(dstW * dstH * 4);
                    converter->CopyPixels(nullptr, dstW * 4,
                        (UINT)pixels.size(), pixels.data());

                    // Write to Max Bitmap
                    BMM_Color_64 line;
                    for (int y = 0; y < dstH; y++) {
                        for (int x = 0; x < dstW; x++) {
                            int idx = (y * dstW + x) * 4;
                            line.b = pixels[idx + 0] << 8;
                            line.g = pixels[idx + 1] << 8;
                            line.r = pixels[idx + 2] << 8;
                            line.a = 0xFFFF;
                            asTarget_->PutPixels(x, y, 1, &line);
                        }
                    }
                    asTarget_->RefreshWindow();

                    return S_OK;
                }).Get());
    }

    // ── Window management ────────────────────────────────────

    void Resize() {
        if (controller_) { RECT b; GetClientRect(hwnd_, &b); controller_->put_Bounds(b); }
    }

    void Destroy() {
        StopActiveShade();
        if (originalParent_) RestoreFromViewport();
        UnregisterCallbacks();
        if (controller_) { controller_->Close(); controller_ = nullptr; }
        webview_ = nullptr;
        env_ = nullptr;
        jsReady_ = false;
        useBinary_ = false;
        dirty_ = true;
        fastDirtyHandles_.clear();
        lastSentTransforms_.clear();
        geomHandles_.clear();
        mtlHashMap_.clear();
        geoHashMap_.clear();
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
        case WM_FAST_FLUSH:
            if (p) p->FlushFastPath();
            return 0;
        case WM_TIMER:
            if (wParam == SYNC_TIMER_ID && p) p->OnTimer();
            if (wParam == AS_TIMER_ID && p) p->CaptureActiveShadeFrame();
            return 0;
        case WM_KILL_PANEL:
            KillPanel();
            return 0;
        case WM_CLOSE: ShowWindow(hwnd, SW_HIDE); return 0;
        case WM_KEYDOWN:
            // Escape exits ActiveShade viewport mode
            if (wParam == VK_ESCAPE && p && p->originalParent_) {
                p->RestoreFromViewport();
                return 0;
            }
            break;
        }
        return DefWindowProc(hwnd, msg, wParam, lParam);
    }
};

void MaxJSFastNodeEventCallback::ControllerStructured(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkTrackedNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::ControllerOtherEvent(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkTrackedNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::LinkChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkTrackedNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::SelectionChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkTrackedNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::HideChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkVisibilityNodesDirty(nodes);
}

void MaxJSFastRedrawCallback::proc(Interface*) {
    if (!owner_) return;
    owner_->MarkSelectedTransformsDirty();
    owner_->MarkCameraDirtyIfChanged();
}

void MaxJSFastTimeChangeCallback::TimeChanged(TimeValue) {
    if (!owner_) return;
    owner_->MarkAllTrackedNodesDirty();
    owner_->MarkCameraDirty();
}

static void OnSceneChanged(void* param, NotifyInfo*) {
    auto* p = static_cast<MaxJSPanel*>(param);
    if (p) p->dirty_ = true;
}

// ══════════════════════════════════════════════════════════════
//  Panel toggle + MAXScript bridge
// ══════════════════════════════════════════════════════════════

static void KillPanel() {
    if (!g_panel) return;
    g_panel->Destroy();
    delete g_panel;
    g_panel = nullptr;
}

void TogglePanel() {
    if (!g_panel) {
        g_panel = new MaxJSPanel();
        g_panel->Create(GetCOREInterface()->GetMAXHWnd());
    } else if (g_panel->hwnd_ && IsWindowVisible(g_panel->hwnd_)) {
        ShowWindow(g_panel->hwnd_, SW_HIDE);
    } else {
        // Recreate the panel from scratch on reopen so web asset changes are guaranteed to load.
        KillPanel();
        g_panel = new MaxJSPanel();
        g_panel->Create(GetCOREInterface()->GetMAXHWnd());
    }
}

void ToggleMaxJSPanel() { TogglePanel(); }
void StartMaxJSActiveShade(Bitmap* target) {
    if (!g_panel) TogglePanel();
    if (g_panel) g_panel->StartActiveShade(target);
}
void StopMaxJSActiveShade() {
    if (g_panel) g_panel->StopActiveShade();
}
HWND GetMaxJSWebViewHWND() {
    return g_panel ? g_panel->hwnd_ : nullptr;
}
void ReparentMaxJSPanel(HWND newParent) {
    if (!g_panel) TogglePanel();
    if (g_panel) g_panel->ReparentIntoViewport(newParent);
}
void RestoreMaxJSPanel() {
    if (g_panel) g_panel->RestoreFromViewport();
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
        KillPanel();
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
