#include <max.h>
#include <gup.h>
#include <iparamb2.h>
#include <plugapi.h>
#include <maxapi.h>
#include <units.h>
#include <triobj.h>
#include <polyobj.h>
#include <iepoly.h>
#include <iEPolyMod.h>
#include <mnmesh.h>
#include <splshape.h>
#include <notify.h>
#include <stdmat.h>
#include <ISceneEventManager.h>
#include <iInstanceMgr.h>
#include <modstack.h>
#include <Graphics/IViewportViewSetting.h>
#include <Graphics/GraphicsEnums.h>
#include <maxscript/maxscript.h>
#include "itreesinterface.h"
#include "ircinterface.h"
#include "tyParticleObjectExt.h"
#include "tyVolumeObjectExt.h"
#include "sync_protocol.h"
#include "threejs_material.h"
#include "threejs_lights.h"
#include "threejs_splat.h"
#include "threejs_toon.h"
#include "threejs_renderer.h"
#include "threejs_fog.h"
#include "threejs_sky.h"

#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <ShlObj.h>
#include <Shlwapi.h>
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
#include <cwctype>
#include <locale>

using namespace Microsoft::WRL;

#define MAXJS_CLASS_ID  Class_ID(0x7F3A9B01, 0x4E2D8C05)
#define MAXJS_NAME      _T("MaxJS")
#define MAXJS_CATEGORY  _T("MaxJS")

#define SYNC_TIMER_ID             1
#define SYNC_INTERVAL_MS          33   // background structural/material timer
#define MATERIAL_DETECT_TICKS     6    // ~200ms material refresh cadence
#define LIGHT_DETECT_TICKS        3    // ~100ms light parameter refresh cadence
#define WM_TOGGLE_PANEL           (WM_USER + 1)
#define WM_FAST_FLUSH             (WM_USER + 2)
#define WM_KILL_PANEL             (WM_USER + 3)
#define SETUP_TIMER_ID            2
#define AS_TIMER_ID               3
#define AS_INTERVAL_MS            66   // ~15fps ActiveShade

extern HINSTANCE hInstance;
HINSTANCE hInstance = nullptr;

class MaxJSPanel;
static MaxJSPanel* g_panel = nullptr;
static HWND g_helperHwnd = nullptr;

// Forward — used by renderer's ActiveShade
static void TogglePanel();
static void KillPanel();
static void RequestGlobalPanelKill();
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
            case L'\r': out += L"\\r"; break;
            case L'\t': out += L"\\t"; break;
            case L'\b': out += L"\\b"; break;
            case L'\f': out += L"\\f"; break;
            default:
                if (static_cast<unsigned>(*s) < 0x20) {
                    wchar_t buf[8];
                    swprintf_s(buf, 8, L"\\u%04x", static_cast<unsigned>(*s));
                    out += buf;
                } else {
                    out += *s;
                }
        }
    }
    return out;
}

static std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return {};
    int needed = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), needed);
    return out;
}

static bool DirectoryExists(const std::wstring& path) {
    if (path.empty()) return false;
    const DWORD attrs = GetFileAttributesW(path.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY);
}

static std::wstring GetEnvironmentString(const wchar_t* name) {
    DWORD needed = GetEnvironmentVariableW(name, nullptr, 0);
    if (needed == 0) return {};

    std::wstring value(static_cast<size_t>(needed), L'\0');
    const DWORD written = GetEnvironmentVariableW(name, value.data(), needed);
    if (written == 0) return {};
    value.resize(written);
    return value;
}

static std::uint64_t FileTimeToUint64(const FILETIME& ft) {
    ULARGE_INTEGER value = {};
    value.LowPart = ft.dwLowDateTime;
    value.HighPart = ft.dwHighDateTime;
    return value.QuadPart;
}

static std::uint64_t GetDirectoryWriteStamp(const std::wstring& dirPath) {
    if (!DirectoryExists(dirPath)) return 0;

    std::uint64_t latest = 0;
    WIN32_FIND_DATAW findData = {};
    const std::wstring pattern = dirPath + L"\\*";
    HANDLE findHandle = FindFirstFileW(pattern.c_str(), &findData);
    if (findHandle == INVALID_HANDLE_VALUE) return 0;

    do {
        if (wcscmp(findData.cFileName, L".") == 0 || wcscmp(findData.cFileName, L"..") == 0) {
            continue;
        }

        latest = std::max(latest, FileTimeToUint64(findData.ftLastWriteTime));

        if (findData.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            latest = std::max(latest, GetDirectoryWriteStamp(dirPath + L"\\" + findData.cFileName));
        }
    } while (FindNextFileW(findHandle, &findData));

    FindClose(findHandle);
    return latest;
}

static bool FileExists(const std::wstring& path) {
    if (path.empty()) return false;
    const DWORD attrs = GetFileAttributesW(path.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}

static bool EndsWithInsensitive(const std::wstring& value, const std::wstring& suffix) {
    if (suffix.size() > value.size()) return false;
    const size_t start = value.size() - suffix.size();
    for (size_t i = 0; i < suffix.size(); ++i) {
        if (towlower(value[start + i]) != towlower(suffix[i])) return false;
    }
    return true;
}

static bool IsProjectRuntimeFile(const std::wstring& fileName) {
    const size_t dot = fileName.find_last_of(L'.');
    if (dot == std::wstring::npos) return false;

    std::wstring ext = fileName.substr(dot);
    std::transform(ext.begin(), ext.end(), ext.begin(),
        [](wchar_t ch) { return static_cast<wchar_t>(towlower(ch)); });

    return ext == L".js" || ext == L".mjs" || ext == L".cjs" || ext == L".json";
}

static std::wstring GetInlineLayerFileName(const std::wstring& id, bool enabled) {
    return id + (enabled ? L".js" : L".js.disabled");
}

static bool TryParseInlineLayerFileName(const std::wstring& fileName, std::wstring& id, bool& enabled) {
    static const std::wstring enabledSuffix = L".js";
    static const std::wstring disabledSuffix = L".js.disabled";

    if (EndsWithInsensitive(fileName, disabledSuffix)) {
        id = fileName.substr(0, fileName.size() - disabledSuffix.size());
        enabled = false;
        return !id.empty();
    }
    if (EndsWithInsensitive(fileName, enabledSuffix)) {
        id = fileName.substr(0, fileName.size() - enabledSuffix.size());
        enabled = true;
        return !id.empty();
    }
    return false;
}

static std::uint64_t GetProjectRuntimeWriteStamp(const std::wstring& dirPath) {
    if (!DirectoryExists(dirPath)) return 0;

    std::uint64_t latest = 0;
    WIN32_FIND_DATAW findData = {};
    const std::wstring pattern = dirPath + L"\\*";
    HANDLE findHandle = FindFirstFileW(pattern.c_str(), &findData);
    if (findHandle == INVALID_HANDLE_VALUE) return 0;

    do {
        if (wcscmp(findData.cFileName, L".") == 0 || wcscmp(findData.cFileName, L"..") == 0) {
            continue;
        }

        if (findData.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            latest = std::max(latest, GetProjectRuntimeWriteStamp(dirPath + L"\\" + findData.cFileName));
            continue;
        }

        if (IsProjectRuntimeFile(findData.cFileName)) {
            latest = std::max(latest, FileTimeToUint64(findData.ftLastWriteTime));
        }
    } while (FindNextFileW(findHandle, &findData));

    FindClose(findHandle);
    return latest;
}

static bool WriteBinaryFile(const std::wstring& path, const std::string& data) {
    HANDLE hFile = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) return false;

    DWORD bytesWritten = 0;
    const BOOL ok = WriteFile(hFile, data.data(), static_cast<DWORD>(data.size()), &bytesWritten, nullptr);
    CloseHandle(hFile);
    return ok && bytesWritten == data.size();
}

static int Base64Value(wchar_t ch) {
    if (ch >= L'A' && ch <= L'Z') return static_cast<int>(ch - L'A');
    if (ch >= L'a' && ch <= L'z') return static_cast<int>(ch - L'a') + 26;
    if (ch >= L'0' && ch <= L'9') return static_cast<int>(ch - L'0') + 52;
    if (ch == L'+') return 62;
    if (ch == L'/') return 63;
    return -1;
}

static bool DecodeBase64Wide(const std::wstring& input, std::string& out) {
    out.clear();
    int accumulator = 0;
    int bits = -8;

    for (wchar_t ch : input) {
        if (ch == L'=') break;
        if (iswspace(ch)) continue;
        const int value = Base64Value(ch);
        if (value < 0) return false;
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<char>((accumulator >> bits) & 0xFF));
            bits -= 8;
        }
    }

    return true;
}

static bool TryGetFileWriteStamp(const std::wstring& path, ULONGLONG& outStamp) {
    WIN32_FILE_ATTRIBUTE_DATA data = {};
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) return false;
    outStamp = (static_cast<ULONGLONG>(data.ftLastWriteTime.dwHighDateTime) << 32)
             | static_cast<ULONGLONG>(data.ftLastWriteTime.dwLowDateTime);
    return true;
}

static bool ExtractJsonString(const std::wstring& json, const wchar_t* key, std::wstring& out) {
    const std::wstring needle = std::wstring(L"\"") + key + L"\":\"";
    size_t pos = json.find(needle);
    if (pos == std::wstring::npos) return false;
    pos += needle.size();

    out.clear();
    bool escape = false;
    for (; pos < json.size(); ++pos) {
        const wchar_t ch = json[pos];
        if (escape) {
            switch (ch) {
                case L'"': out += L'"'; break;
                case L'\\': out += L'\\'; break;
                case L'/': out += L'/'; break;
                case L'b': out += L'\b'; break;
                case L'f': out += L'\f'; break;
                case L'n': out += L'\n'; break;
                case L'r': out += L'\r'; break;
                case L't': out += L'\t'; break;
                default: out += ch; break;
            }
            escape = false;
            continue;
        }

        if (ch == L'\\') {
            escape = true;
            continue;
        }
        if (ch == L'"') {
            return true;
        }
        out += ch;
    }

    return false;
}

static bool ExtractJsonBool(const std::wstring& json, const wchar_t* key, bool& out) {
    const std::wstring needle = std::wstring(L"\"") + key + L"\":";
    size_t pos = json.find(needle);
    if (pos == std::wstring::npos) return false;
    pos += needle.size();
    while (pos < json.size() && iswspace(json[pos])) ++pos;
    if (json.compare(pos, 4, L"true") == 0) {
        out = true;
        return true;
    }
    if (json.compare(pos, 5, L"false") == 0) {
        out = false;
        return true;
    }
    return false;
}

static std::wstring UrlEncodePath(const std::wstring& path) {
    if (path.empty()) return {};

    int utf8Len = WideCharToMultiByte(CP_UTF8, 0, path.data(), static_cast<int>(path.size()), nullptr, 0, nullptr, nullptr);
    if (utf8Len <= 0) return {};

    std::string utf8(static_cast<size_t>(utf8Len), '\0');
    WideCharToMultiByte(CP_UTF8, 0, path.data(), static_cast<int>(path.size()), utf8.data(), utf8Len, nullptr, nullptr);

    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string encoded;
    encoded.reserve(utf8.size() * 3);

    for (unsigned char c : utf8) {
        const bool isUnreserved =
            (c >= 'A' && c <= 'Z') ||
            (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~' || c == '/';

        if (isUnreserved) {
            encoded.push_back(static_cast<char>(c));
        } else {
            encoded.push_back('%');
            encoded.push_back(kHex[(c >> 4) & 0xF]);
            encoded.push_back(kHex[c & 0xF]);
        }
    }

    return Utf8ToWide(encoded);
}

static int HexNibble(wchar_t c) {
    if (c >= L'0' && c <= L'9') return static_cast<int>(c - L'0');
    if (c >= L'a' && c <= L'f') return 10 + static_cast<int>(c - L'a');
    if (c >= L'A' && c <= L'F') return 10 + static_cast<int>(c - L'A');
    return -1;
}

static std::wstring UrlDecodePath(const std::wstring& path) {
    if (path.empty()) return {};

    std::string utf8;
    utf8.reserve(path.size());

    for (size_t i = 0; i < path.size(); ++i) {
        const wchar_t c = path[i];
        if (c == L'%' && i + 2 < path.size()) {
            const int hi = HexNibble(path[i + 1]);
            const int lo = HexNibble(path[i + 2]);
            if (hi >= 0 && lo >= 0) {
                utf8.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
                continue;
            }
        }

        if (c == L'+') {
            utf8.push_back(' ');
        } else if (c <= 0x7F) {
            utf8.push_back(static_cast<char>(c));
        } else {
            const std::wstring single(1, c);
            int utf8Len = WideCharToMultiByte(CP_UTF8, 0, single.data(), 1, nullptr, 0, nullptr, nullptr);
            if (utf8Len > 0) {
                std::string tmp(static_cast<size_t>(utf8Len), '\0');
                WideCharToMultiByte(CP_UTF8, 0, single.data(), 1, tmp.data(), utf8Len, nullptr, nullptr);
                utf8 += tmp;
            }
        }
    }

    return Utf8ToWide(utf8);
}

static const wchar_t* GetMimeTypeForPath(const std::wstring& path) {
    const wchar_t* ext = PathFindExtensionW(path.c_str());
    if (!ext || !*ext) return L"application/octet-stream";
    if (_wcsicmp(ext, L".png") == 0) return L"image/png";
    if (_wcsicmp(ext, L".jpg") == 0 || _wcsicmp(ext, L".jpeg") == 0) return L"image/jpeg";
    if (_wcsicmp(ext, L".webp") == 0) return L"image/webp";
    if (_wcsicmp(ext, L".gif") == 0) return L"image/gif";
    if (_wcsicmp(ext, L".bmp") == 0) return L"image/bmp";
    if (_wcsicmp(ext, L".hdr") == 0) return L"image/vnd.radiance";
    if (_wcsicmp(ext, L".exr") == 0) return L"image/x-exr";
    if (_wcsicmp(ext, L".ktx2") == 0) return L"image/ktx2";
    if (_wcsicmp(ext, L".ply") == 0) return L"application/octet-stream";
    if (_wcsicmp(ext, L".splat") == 0) return L"application/octet-stream";
    if (_wcsicmp(ext, L".ksplat") == 0) return L"application/octet-stream";
    if (_wcsicmp(ext, L".spz") == 0) return L"application/octet-stream";
    if (_wcsicmp(ext, L".json") == 0) return L"application/json";
    if (_wcsicmp(ext, L".bin") == 0) return L"application/octet-stream";
    return L"application/octet-stream";
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

static uint64_t HashIntervalState(const Interval& iv, uint64_t seed = 1469598103934665603ULL) {
    const int start = iv.Start();
    const int end = iv.End();
    uint64_t h = HashFNV1a(&start, sizeof(start), seed);
    return HashFNV1a(&end, sizeof(end), h);
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

static uint64_t HashMeshState(Mesh& mesh) {
    uint64_t h = 1469598103934665603ULL;
    const int numVerts = mesh.getNumVerts();
    const int numFaces = mesh.getNumFaces();
    h = HashFNV1a(&numVerts, sizeof(numVerts), h);
    h = HashFNV1a(&numFaces, sizeof(numFaces), h);

    for (int i = 0; i < numVerts; ++i) {
        Point3 p = mesh.getVert(i);
        h = HashFNV1a(&p, sizeof(p), h);
    }

    for (int i = 0; i < numFaces; ++i) {
        Face& face = mesh.faces[i];
        const DWORD smGroup = face.getSmGroup();
        const MtlID matID = face.getMatID();
        h = HashFNV1a(face.v, sizeof(face.v), h);
        h = HashFNV1a(&smGroup, sizeof(smGroup), h);
        h = HashFNV1a(&matID, sizeof(matID), h);
    }

    return h;
}

static uint64_t HashMNMeshState(MNMesh& mn) {
    uint64_t h = 1469598103934665603ULL;
    const int numVerts = mn.VNum();
    const int numFaces = mn.FNum();
    h = HashFNV1a(&numVerts, sizeof(numVerts), h);
    h = HashFNV1a(&numFaces, sizeof(numFaces), h);

    for (int i = 0; i < numVerts; ++i) {
        const MNVert* vert = mn.V(i);
        const DWORD dead = (vert && vert->GetFlag(MN_DEAD)) ? 1u : 0u;
        const Point3 p = mn.P(i);
        h = HashFNV1a(&dead, sizeof(dead), h);
        h = HashFNV1a(&p, sizeof(p), h);
    }

    for (int i = 0; i < numFaces; ++i) {
        const MNFace* face = mn.F(i);
        if (!face) continue;

        const DWORD dead = face->GetFlag(MN_DEAD) ? 1u : 0u;
        const int deg = face->deg;
        const DWORD smGroup = face->smGroup;
        const MtlID matID = face->material;
        h = HashFNV1a(&dead, sizeof(dead), h);
        h = HashFNV1a(&deg, sizeof(deg), h);
        h = HashFNV1a(&smGroup, sizeof(smGroup), h);
        h = HashFNV1a(&matID, sizeof(matID), h);
        if (deg > 0 && face->vtx) {
            h = HashFNV1a(face->vtx, sizeof(int) * static_cast<size_t>(deg), h);
        }
    }

    return h;
}

static MNMesh* TryGetLiveEditablePolyMesh(INode* node) {
    if (!node) return nullptr;

    Object* cursor = node->GetObjectRef();
    while (cursor &&
           (cursor->ClassID() == derivObjClassID || cursor->ClassID() == WSMDerivObjClassID)) {
        IDerivedObject* derived = static_cast<IDerivedObject*>(cursor);
        const int modCount = derived->NumModifiers();
        if (modCount <= 0) {
            cursor = derived->GetObjRef();
            continue;
        }

        Modifier* topModifier = derived->GetModifier(modCount - 1);
        if (!topModifier) return nullptr;

        if (auto* epMod = static_cast<EPolyMod*>(topModifier->GetInterface(EPOLY_MOD_INTERFACE))) {
            if (MNMesh* mesh = epMod->EpModGetOutputMesh(node)) return mesh;
            if (MNMesh* mesh = epMod->EpModGetMesh(node)) return mesh;
        }

        // A higher non-Edit Poly modifier sits above any deeper Editable Poly state.
        return nullptr;
    }

    if (!cursor) return nullptr;
    if (auto* epoly = static_cast<EPoly*>(cursor->GetInterface(EPOLY_INTERFACE))) {
        return epoly->GetMeshPtr();
    }

    return nullptr;
}

static bool ExtractSpline(INode* node, TimeValue t,
                          std::vector<float>& verts,
                          std::vector<int>& indices);

static uint64_t HashNodeGeometryState(INode* node, TimeValue t) {
    if (!node) return 0;

    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return HashMNMeshState(*liveMN);
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj) return 0;
    if (os.obj->SuperClassID() == SHAPE_CLASS_ID) {
        std::vector<float> verts;
        std::vector<int> indices;
        if (!ExtractSpline(node, t, verts, indices)) return 0;
        const std::vector<float> uvs;
        return HashMeshData(verts, indices, uvs);
    }
    if (os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return 0;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return 0;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        return HashMNMeshState(poly->GetMesh());
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return 0;

    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return 0;

    const uint64_t hash = HashMeshState(tri->GetMesh());
    if (tri != os.obj) tri->DeleteThis();
    return hash;
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

static std::wstring FindBitmapFileImpl(Texmap* map, std::unordered_set<Texmap*>& visited) {
    if (!map) return {};
    if (!visited.insert(map).second) return {};

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
            std::wstring f = FindBitmapFileImpl(sub, visited);
            if (!f.empty()) return f;
        }
    }
    return {};
}

static std::wstring FindBitmapFile(Texmap* map) {
    std::unordered_set<Texmap*> visited;
    return FindBitmapFileImpl(map, visited);
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
    struct TexTransform {
        bool  isUberBitmap = false;
        bool  hasChannelSelect = false;
        int   outputChannelIndex = 1;
        bool  invert = false;
        float scale = 1.0f;
        float tiling[2] = {1.0f, 1.0f};
        float offset[2] = {0.0f, 0.0f};
        float rotate = 0.0f;
        float center[2] = {0.5f, 0.5f};
        bool  realWorld = false;
        float realWidth = 0.2f;
        float realHeight = 0.2f;
        std::wstring wrapMode = L"periodic";
        std::wstring colorSpace;   // "sRGB", "Linear", "auto", etc.
        float manualGamma = 1.0f;
        bool  isVideo = false;
        bool  videoLoop = true;
        bool  videoMuted = true;
        float videoRate = 1.0f;
    };

    float color[3]    = {0.8f, 0.8f, 0.8f};
    float roughness   = 0.5f;
    float metalness   = 0.0f;
    float emission[3] = {0, 0, 0};
    float emIntensity = 0.0f;
    float opacity     = 1.0f;
    float colorMapStrength = 1.0f;
    float roughnessMapStrength = 1.0f;
    float metalnessMapStrength = 1.0f;
    float normalScale = 1.0f;
    float bumpScale = 1.0f;
    float displacementScale = 0.0f;
    float displacementBias = 0.0f;
    float emissiveMapStrength = 1.0f;
    float opacityMapStrength = 1.0f;
    float aoIntensity = 1.0f;
    float lightmapIntensity = 1.0f;
    int   lightmapChannel = 2;
    bool  doubleSided = true;
    float envIntensity = 1.0f;
    float sssColor[3] = {1.0f, 1.0f, 1.0f};
    float sssDistortion = 0.1f;
    float sssAmbient = 0.0f;
    float sssAttenuation = 0.1f;
    float sssPower = 2.0f;
    float sssScale = 10.0f;
    float physicalSpecularColor[3] = {1.0f, 1.0f, 1.0f};
    float physicalSpecularIntensity = 1.0f;
    float clearcoat = 0.0f;
    float clearcoatRoughness = 0.0f;
    float sheen = 0.0f;
    float sheenRoughness = 1.0f;
    float sheenColor[3] = {0.0f, 0.0f, 0.0f};
    float iridescence = 0.0f;
    float iridescenceIOR = 1.3f;
    float transmission = 0.0f;
    float ior = 1.5f;
    float thickness = 0.0f;
    float dispersion = 0.0f;
    float attenuationColor[3] = {1.0f, 1.0f, 1.0f};
    float attenuationDistance = 0.0f;
    float anisotropy = 0.0f;
    float specular[3] = {0.0666667f, 0.0666667f, 0.0666667f};
    float shininess = 30.0f;
    float reflectivity = 1.0f;
    float refractionRatio = 0.98f;
    bool  flatShading = false;
    bool  wireframe = false;
    bool  fog = true;
    int   backdropMode = 0;
    int   normalMapType = 0;
    int   depthPacking = 0;
    int   combine = 0;
    std::wstring colorMap, gradientMap, roughnessMap, metalnessMap, normalMap;
    std::wstring bumpMap, displacementMap, parallaxMap, sssColorMap, matcapMap, specularMap;
    std::wstring aoMap, emissionMap, lightmapFile, opacityMap;
    std::wstring transmissionMap;
    std::wstring clearcoatMap, clearcoatRoughnessMap, clearcoatNormalMap;
    TexTransform colorMapTransform, gradientMapTransform, roughnessMapTransform, metalnessMapTransform, normalMapTransform;
    TexTransform bumpMapTransform, displacementMapTransform, parallaxMapTransform, sssColorMapTransform;
    TexTransform aoMapTransform, emissionMapTransform, lightmapTransform, opacityMapTransform, matcapMapTransform, specularMapTransform;
    TexTransform transmissionMapTransform;
    TexTransform clearcoatMapTransform, clearcoatRoughnessMapTransform, clearcoatNormalMapTransform;
    std::wstring mtlName;
    std::wstring tslCode;
    std::wstring materialModel = L"MeshStandardMaterial";
    std::wstring materialXFile;
    std::wstring materialXMaterialName;
    int materialXMaterialIndex = 1;
    float parallaxScale = 0.0f;
};

static float FindPBFloat(Texmap* map, const MCHAR* name, float def);
static int FindPBInt(Texmap* map, const MCHAR* name, int def);
static std::wstring FindPBString(Texmap* map, const MCHAR* name);
static std::wstring FindPBString(Mtl* mtl, const MCHAR* name);
static int FindPBInt(Mtl* mtl, const MCHAR* name, int def);

// Shell Material Class_ID = (597, 0)
#define SHELL_MTL_CLASS_ID Class_ID(597, 0)
// glTF Material Class_ID = (943849874, 1174294043)
#define GLTF_MTL_CLASS_ID Class_ID(943849874, 1174294043)
// USD Preview Surface Class_ID = (1794787635, 1200091591)
#define USD_PREVIEW_SURFACE_CLASS_ID Class_ID(1794787635, 1200091591)
// Normal Bump texmap Class_ID = {243e22c6, 63f6a014}
#define NORMAL_BUMP_CLASS_ID Class_ID(0x243e22c6, 0x63f6a014)
// OpenPBR Material Class_ID
#define OPENPBR_MTL_CLASS_ID Class_ID(4048887347u, 939201335)
// VRayMtl Class_ID
#define VRAYMTL_CLASS_ID Class_ID(935280431, 1882483036)
// VRayBitmap Class_ID
#define VRAYBITMAP_CLASS_ID Class_ID(1734939723, 46203261)
// VRayNormalMap Class_ID
#define VRAYNORMALMAP_CLASS_ID Class_ID(1912237649, 1912962095)
// MaterialX Material Class_ID variants observed in Max runtime
#define MATERIALX_MTL_CLASS_ID Class_ID(0x37161b0b, 0x51c741cc)
#define MATERIALX_MTL_ALT_CLASS_ID Class_ID(0x20fb46dc, 0x30fd79bf)

static bool HasParam(IParamBlock2* pb, ParamID id) {
    if (!pb) return false;
    for (int i = 0; i < pb->NumParams(); ++i) {
        if (pb->IndextoID(i) == id) return true;
    }
    return false;
}

static bool IsThreeJSMaterialClass(const Class_ID& cid) {
    return cid == THREEJS_ADV_MTL_CLASS_ID ||
           cid == THREEJS_UTILITY_MTL_CLASS_ID ||
           cid == THREEJS_TSL_CLASS_ID;
}

static bool IsMaterialXMaterialClass(const Class_ID& cid) {
    return cid == MATERIALX_MTL_CLASS_ID || cid == MATERIALX_MTL_ALT_CLASS_ID;
}

static std::wstring GetUtilityMaterialModelName(int utilityModel) {
    switch (utilityModel) {
        case threejs_utility_depth: return L"MeshDepthMaterial";
        case threejs_utility_matcap: return L"MeshMatcapMaterial";
        case threejs_utility_normal: return L"MeshNormalMaterial";
        case threejs_utility_phong: return L"MeshPhongMaterial";
        case threejs_utility_backdrop: return L"MeshBackdropNodeMaterial";
        case threejs_utility_lambert:
        default:
            return L"MeshLambertMaterial";
    }
}

static bool IsUtilityMaterialModel(const std::wstring& materialModel) {
    return
           materialModel == L"MeshDepthMaterial" ||
           materialModel == L"MeshLambertMaterial" ||
           materialModel == L"MeshMatcapMaterial" ||
           materialModel == L"MeshNormalMaterial" ||
           materialModel == L"MeshPhongMaterial" ||
           materialModel == L"MeshBackdropNodeMaterial";
}

#define PHYSICAL_MTL_CLASS_ID Class_ID(1030429932, 3735928833)

static bool IsSupportedMaterial(Mtl* mtl) {
    if (!mtl) return false;
    Class_ID cid = mtl->ClassID();
    return IsThreeJSMaterialClass(cid) || cid == THREEJS_TOON_CLASS_ID || cid == GLTF_MTL_CLASS_ID
        || cid == USD_PREVIEW_SURFACE_CLASS_ID || cid == PHYSICAL_MTL_CLASS_ID
        || cid == VRAYMTL_CLASS_ID
        || cid == OPENPBR_MTL_CLASS_ID
        || IsMaterialXMaterialClass(cid);
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

static bool FindPBPoint3(Texmap* map, const MCHAR* name, Point3& out) {
    if (!map) return false;
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 && pd.type == TYPE_POINT3) {
                out = pb->GetPoint3(pid);
                return true;
            }
        }
    }
    return false;
}

static Texmap* FindPBMap(Texmap* map, const MCHAR* name) {
    if (!map) return nullptr;
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 && pd.type == TYPE_TEXMAP)
                return pb->GetTexmap(pid);
        }
    }
    return nullptr;
}

static bool IsAutodeskUberBitmap(Texmap* map) {
    if (!map) return false;

    const std::wstring shaderName = FindPBString(map, _T("OSLShaderName"));
    if (_wcsicmp(shaderName.c_str(), L"UberBitmap2b") == 0)
        return true;

    const std::wstring oslPath = FindPBString(map, _T("OSLpath"));
    const wchar_t* fileName = oslPath.empty() ? nullptr : wcsrchr(oslPath.c_str(), L'\\');
    fileName = fileName ? fileName + 1 : oslPath.c_str();
    return fileName && _wcsicmp(fileName, L"UberBitmap2.osl") == 0;
}

static void ExtractStdUVTransform(Texmap* map, MaxJSPBR::TexTransform& xf) {
    if (!map) return;

    UVGen* uvGen = map->GetTheUVGen();
    if (uvGen && uvGen->IsStdUVGen()) {
        auto* stdUv = static_cast<StdUVGen*>(uvGen);
        xf.tiling[0] = stdUv->GetUScl(0);
        xf.tiling[1] = stdUv->GetVScl(0);
        xf.offset[0] = stdUv->GetUOffs(0);
        xf.offset[1] = stdUv->GetVOffs(0);
        xf.rotate = stdUv->GetWAng(0) * (180.0f / PI);

        const int tilingFlags = stdUv->GetTextureTiling();
        if ((tilingFlags & (U_MIRROR | V_MIRROR)) != 0) {
            xf.wrapMode = L"mirror";
        } else if ((tilingFlags & (U_WRAP | V_WRAP)) != (U_WRAP | V_WRAP)) {
            xf.wrapMode = L"clamp";
        }
    }
}

static bool ExtractMaterialTexture(Texmap* map, std::wstring& filePath, MaxJSPBR::TexTransform& xf) {
    if (!map) return false;

    Texmap* resolved = map;
    const int outputChannelIndex = std::max(1, FindPBInt(map, _T("outputChannelIndex"), 1));
    if (Texmap* sourceMap = FindPBMap(map, _T("sourceMap")))
        resolved = sourceMap;

    if (IsAutodeskUberBitmap(resolved)) {
        const std::wstring filename = FindPBString(resolved, _T("filename"));
        if (filename.empty() || !IsImageFile(filename.c_str()))
            return false;

        Point3 tiling(1.0f, 1.0f, 1.0f);
        Point3 offset(0.0f, 0.0f, 0.0f);
        Point3 center(0.5f, 0.5f, 0.0f);
        FindPBPoint3(resolved, _T("tiling"), tiling);
        FindPBPoint3(resolved, _T("offset"), offset);
        FindPBPoint3(resolved, _T("RotCenter"), center);

        filePath = filename;
        xf.isUberBitmap = true;
        xf.hasChannelSelect = outputChannelIndex != 1;
        xf.outputChannelIndex = outputChannelIndex;
        xf.scale = FindPBFloat(resolved, _T("scale"), 1.0f);
        xf.tiling[0] = tiling.x;
        xf.tiling[1] = tiling.y;
        xf.offset[0] = offset.x;
        xf.offset[1] = offset.y;
        xf.rotate = FindPBFloat(resolved, _T("Rotate"), 0.0f);
        xf.center[0] = center.x;
        xf.center[1] = center.y;
        xf.realWorld = FindPBInt(resolved, _T("RealWorld"), 0) != 0;
        xf.realWidth = FindPBFloat(resolved, _T("RealWidth"), 0.2f);
        xf.realHeight = FindPBFloat(resolved, _T("RealHeight"), 0.2f);
        xf.wrapMode = FindPBString(resolved, _T("WrapMode"));
        if (xf.wrapMode.empty()) xf.wrapMode = L"periodic";
        xf.colorSpace = FindPBString(resolved, _T("Filename_ColorSpace"));
        xf.manualGamma = FindPBFloat(resolved, _T("ManualGamma"), 1.0f);
        return true;
    }

    if (resolved->ClassID() == Class_ID(BMTEX_CLASS_ID, 0)) {
        const std::wstring filename = FindBitmapFile(resolved);
        if (filename.empty() || !IsImageFile(filename.c_str()))
            return false;
        filePath = filename;
        xf = {};
        ExtractStdUVTransform(resolved, xf);
        xf.hasChannelSelect = outputChannelIndex != 1;
        xf.outputChannelIndex = outputChannelIndex;
        return true;
    }

    // VRayNormalMap — walk through to the inner normal map texture
    if (resolved->ClassID() == VRAYNORMALMAP_CLASS_ID) {
        Texmap* innerNormal = FindPBMap(resolved, _T("normal_map"));
        if (innerNormal) return ExtractMaterialTexture(innerNormal, filePath, xf);
        Texmap* innerBump = FindPBMap(resolved, _T("bump_map"));
        if (innerBump) return ExtractMaterialTexture(innerBump, filePath, xf);
        return false;
    }

    // VRayBitmap (VRayHDRI)
    if (resolved->ClassID() == VRAYBITMAP_CLASS_ID) {
        const std::wstring filename = FindPBString(resolved, _T("HDRIMapName"));
        if (filename.empty() || !IsImageFile(filename.c_str()))
            return false;
        filePath = filename;
        xf = {};
        ExtractStdUVTransform(resolved, xf);
        xf.hasChannelSelect = outputChannelIndex != 1;
        xf.outputChannelIndex = outputChannelIndex;
        xf.colorSpace = FindPBString(resolved, _T("color_space"));
        if (xf.colorSpace.empty())
            xf.colorSpace = FindPBString(resolved, _T("rgbColorSpace"));
        xf.manualGamma = FindPBFloat(resolved, _T("gamma"), 1.0f);
        return true;
    }

    // three.js Video Texture
    if (resolved->ClassID() == THREEJS_VIDEO_TEX_CLASS_ID) {
        IParamBlock2* vpb = resolved->GetParamBlockByID(threejs_video_params);
        if (!vpb) return false;
        const MCHAR* fn = vpb->GetStr(pvid_filename);
        if (!fn || !fn[0]) return false;
        filePath = fn;
        xf = {};
        xf.isVideo = true;
        xf.videoLoop = vpb->GetInt(pvid_loop, 0) != 0;
        xf.videoMuted = vpb->GetInt(pvid_muted, 0) != 0;
        xf.videoRate = vpb->GetFloat(pvid_rate, 0);
        return true;
    }

    return false;
}

static void ExtractWrappedNormalBumpMaps(
    Texmap* map,
    std::wstring& normalPath,
    MaxJSPBR::TexTransform& normalXf,
    std::wstring& bumpPath,
    MaxJSPBR::TexTransform& bumpXf)
{
    if (!map) return;

    if (map->ClassID() == NORMAL_BUMP_CLASS_ID || map->ClassID() == VRAYNORMALMAP_CLASS_ID) {
        Texmap* normalMap = FindPBMap(map, _T("normal_map"));
        Texmap* bumpMap = FindPBMap(map, _T("bump_map"));
        const bool normalEnabled = FindPBInt(map, _T("map1on"), 1) != 0;
        const bool bumpEnabled = FindPBInt(map, _T("map2on"), 1) != 0;

        if (!normalMap && map->NumSubTexmaps() > 0)
            normalMap = map->GetSubTexmap(0);
        if (!bumpMap && map->NumSubTexmaps() > 1)
            bumpMap = map->GetSubTexmap(1);

        if (normalEnabled && normalMap)
            ExtractMaterialTexture(normalMap, normalPath, normalXf);
        if (bumpEnabled && bumpMap)
            ExtractMaterialTexture(bumpMap, bumpPath, bumpXf);
        return;
    }

    ExtractMaterialTexture(map, bumpPath, bumpXf);
}

static void ExtractThreeJSMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    IParamBlock2* pb = mtl->GetParamBlockByID(threejs_params);
    if (!pb) return;
    auto getOptionalFloat = [&](ParamID id, float def) {
        return HasParam(pb, id) ? pb->GetFloat(id, t) : def;
    };
    auto getOptionalInt = [&](ParamID id, int def) {
        return HasParam(pb, id) ? pb->GetInt(id, t) : def;
    };

    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    const Class_ID cid = mtl->ClassID();
    if (cid == THREEJS_ADV_MTL_CLASS_ID) {
        const int mode = HasParam(pb, pb_material_mode) ? pb->GetInt(pb_material_mode, t) : threejs_mode_standard;
        if (mode == threejs_mode_physical) d.materialModel = L"MeshPhysicalMaterial";
        else if (mode == threejs_mode_sss) d.materialModel = L"MeshSSSNodeMaterial";
        else d.materialModel = L"MeshStandardMaterial";
    } else if (cid == THREEJS_TSL_CLASS_ID) {
        d.materialModel = L"MeshTSLNodeMaterial";
    } else if (cid == THREEJS_UTILITY_MTL_CLASS_ID) {
        d.materialModel = GetUtilityMaterialModelName(pb->GetInt(pb_utility_model, t));
    } else {
        d.materialModel = L"MeshStandardMaterial";
    }

    Color c = pb->GetColor(pb_color, t);
    d.color[0] = c.r; d.color[1] = c.g; d.color[2] = c.b;
    d.roughness  = pb->GetFloat(pb_roughness, t);
    d.metalness  = pb->GetFloat(pb_metalness, t);
    d.opacity    = pb->GetFloat(pb_opacity, t);
    d.colorMapStrength = pb->GetFloat(pb_color_map_strength, t);
    d.roughnessMapStrength = pb->GetFloat(pb_roughness_map_strength, t);
    d.metalnessMapStrength = pb->GetFloat(pb_metalness_map_strength, t);
    d.normalScale = pb->GetFloat(pb_normal_scale, t);
    d.bumpScale = pb->GetFloat(pb_bump_scale, t);
    d.displacementScale = pb->GetFloat(pb_displacement_scale, t);
    d.displacementBias = pb->GetFloat(pb_displacement_bias, t);
    d.parallaxScale = pb->GetFloat(pb_parallax_scale, t);
    d.doubleSided = pb->GetInt(pb_double_sided, t) != 0;
    d.envIntensity = pb->GetFloat(pb_env_intensity, t);

    Color em = pb->GetColor(pb_emissive_color, t);
    d.emission[0] = em.r; d.emission[1] = em.g; d.emission[2] = em.b;
    d.emIntensity = pb->GetFloat(pb_emissive_intensity, t);
    d.emissiveMapStrength = pb->GetFloat(pb_emissive_map_strength, t);
    d.opacityMapStrength = pb->GetFloat(pb_opacity_map_strength, t);

    d.aoIntensity = pb->GetFloat(pb_ao_intensity, t);
    d.lightmapIntensity = pb->GetFloat(pb_lightmap_intensity, t);
    d.lightmapChannel = pb->GetInt(pb_lightmap_channel, t);

    if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshPhysicalMaterial") {
        Color specColor = pb->GetColor(pb_phys_specular_color, t);
        d.physicalSpecularColor[0] = specColor.r; d.physicalSpecularColor[1] = specColor.g; d.physicalSpecularColor[2] = specColor.b;
        d.physicalSpecularIntensity = pb->GetFloat(pb_phys_specular_intensity, t);
        d.clearcoat = pb->GetFloat(pb_phys_clearcoat, t);
        d.clearcoatRoughness = pb->GetFloat(pb_phys_clearcoat_roughness, t);
        d.sheen = pb->GetFloat(pb_phys_sheen, t);
        d.sheenRoughness = pb->GetFloat(pb_phys_sheen_roughness, t);
        Color sheenColor = pb->GetColor(pb_phys_sheen_color, t);
        d.sheenColor[0] = sheenColor.r; d.sheenColor[1] = sheenColor.g; d.sheenColor[2] = sheenColor.b;
        d.iridescence = pb->GetFloat(pb_phys_iridescence, t);
        d.iridescenceIOR = pb->GetFloat(pb_phys_iridescence_ior, t);
        d.transmission = pb->GetFloat(pb_phys_transmission, t);
        d.ior = pb->GetFloat(pb_phys_ior, t);
        d.thickness = pb->GetFloat(pb_phys_thickness, t);
        d.dispersion = pb->GetFloat(pb_phys_dispersion, t);
        Color attenuationColor = pb->GetColor(pb_phys_attenuation_color, t);
        d.attenuationColor[0] = attenuationColor.r; d.attenuationColor[1] = attenuationColor.g; d.attenuationColor[2] = attenuationColor.b;
        d.attenuationDistance = pb->GetFloat(pb_phys_attenuation_distance, t);
        d.anisotropy = pb->GetFloat(pb_phys_anisotropy, t);
    } else if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshSSSNodeMaterial") {
        Color sss = pb->GetColor(pb_sss_color, t);
        d.sssColor[0] = sss.r; d.sssColor[1] = sss.g; d.sssColor[2] = sss.b;
        d.sssDistortion = pb->GetFloat(pb_sss_distortion, t);
        d.sssAmbient = pb->GetFloat(pb_sss_ambient, t);
        d.sssAttenuation = pb->GetFloat(pb_sss_attenuation, t);
        d.sssPower = pb->GetFloat(pb_sss_power, t);
        d.sssScale = pb->GetFloat(pb_sss_scale, t);
    } else if (cid == THREEJS_TSL_CLASS_ID) {
        const MCHAR* code = pb->GetStr(pb_tsl_code);
        if (code && code[0]) d.tslCode = code;
    } else if (cid == THREEJS_UTILITY_MTL_CLASS_ID) {
        Color spec = pb->GetColor(pb_specular_color, t);
        d.specular[0] = spec.r; d.specular[1] = spec.g; d.specular[2] = spec.b;
        d.shininess = getOptionalFloat(pb_shininess, 30.0f);
        d.reflectivity = getOptionalFloat(pb_reflectivity, 1.0f);
        d.refractionRatio = getOptionalFloat(pb_refraction_ratio, 0.98f);
        d.flatShading = getOptionalInt(pb_flat_shading, FALSE) != 0;
        d.wireframe = getOptionalInt(pb_wireframe, FALSE) != 0;
        d.fog = getOptionalInt(pb_fog, TRUE) != 0;
        d.backdropMode = getOptionalInt(pb_backdrop_mode, threejs_backdrop_blurred);
        d.normalMapType = getOptionalInt(pb_normal_map_type, threejs_utility_normal_tangent);
        d.depthPacking = getOptionalInt(pb_depth_packing, threejs_utility_depth_packing_basic);
        d.combine = getOptionalInt(pb_combine, threejs_utility_combine_multiply);
    }

    auto readMap = [&](ParamID pid, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        Texmap* map = pb->GetTexmap(pid, t);
        outPath.clear();
        outXf = {};
        ExtractMaterialTexture(map, outPath, outXf);
    };
    readMap(pb_color_map, d.colorMap, d.colorMapTransform);
    readMap(pb_roughness_map, d.roughnessMap, d.roughnessMapTransform);
    readMap(pb_metalness_map, d.metalnessMap, d.metalnessMapTransform);
    readMap(pb_normal_map, d.normalMap, d.normalMapTransform);
    readMap(pb_bump_map, d.bumpMap, d.bumpMapTransform);
    readMap(pb_displacement_map, d.displacementMap, d.displacementMapTransform);
    readMap(pb_parallax_map, d.parallaxMap, d.parallaxMapTransform);
    readMap(pb_emissive_map, d.emissionMap, d.emissionMapTransform);
    readMap(pb_opacity_map, d.opacityMap, d.opacityMapTransform);
    readMap(pb_lightmap, d.lightmapFile, d.lightmapTransform);
    readMap(pb_ao_map, d.aoMap, d.aoMapTransform);
    if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshSSSNodeMaterial") {
        readMap(pb_sss_color_map, d.sssColorMap, d.sssColorMapTransform);
    } else if (cid == THREEJS_UTILITY_MTL_CLASS_ID) {
        readMap(pb_matcap_map, d.matcapMap, d.matcapMapTransform);
        readMap(pb_specular_map, d.specularMap, d.specularMapTransform);
    }
}

static void ExtractMaterialXMtl(Mtl* mtl, TimeValue /*t*/, MaxJSPBR& d) {
    if (!mtl) return;

    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MaterialXMaterial";
    d.materialXFile = FindPBString(mtl, _T("MaterialXFile"));
    d.materialXMaterialName = FindPBString(mtl, _T("curMatName"));
    d.materialXMaterialIndex = std::max(1, FindPBInt(mtl, _T("curMatIdx"), 1));
}

static void ExtractThreeJSToonMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    IParamBlock2* pb = mtl->GetParamBlockByID(toon_params);
    if (!pb) return;

    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshToonMaterial";

    Color c = pb->GetColor(tp_color, t);
    d.color[0] = c.r; d.color[1] = c.g; d.color[2] = c.b;
    d.opacity = pb->GetFloat(tp_opacity, t);
    d.normalScale = pb->GetFloat(tp_normal_scale, t);
    d.bumpScale = pb->GetFloat(tp_bump_scale, t);
    d.displacementScale = pb->GetFloat(tp_displacement_scale, t);
    d.displacementBias = pb->GetFloat(tp_displacement_bias, t);
    d.doubleSided = pb->GetInt(tp_double_sided, t) != 0;
    d.aoIntensity = pb->GetFloat(tp_ao_intensity, t);
    d.lightmapIntensity = pb->GetFloat(tp_lightmap_intensity, t);
    d.lightmapChannel = pb->GetInt(tp_lightmap_channel, t);

    Color em = pb->GetColor(tp_emissive_color, t);
    d.emission[0] = em.r; d.emission[1] = em.g; d.emission[2] = em.b;
    d.emIntensity = pb->GetFloat(tp_emissive_intensity, t);

    auto readMap = [&](ParamID pid, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        Texmap* map = pb->GetTexmap(pid, t);
        outPath.clear();
        outXf = {};
        ExtractMaterialTexture(map, outPath, outXf);
    };
    readMap(tp_color_map, d.colorMap, d.colorMapTransform);
    readMap(tp_gradient_map, d.gradientMap, d.gradientMapTransform);
    readMap(tp_normal_map, d.normalMap, d.normalMapTransform);
    readMap(tp_bump_map, d.bumpMap, d.bumpMapTransform);
    readMap(tp_emissive_map, d.emissionMap, d.emissionMapTransform);
    readMap(tp_opacity_map, d.opacityMap, d.opacityMapTransform);
    readMap(tp_lightmap, d.lightmapFile, d.lightmapTransform);
    readMap(tp_ao_map, d.aoMap, d.aoMapTransform);
    readMap(tp_displacement_map, d.displacementMap, d.displacementMapTransform);
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
    auto readMap = [&](const MCHAR* pname, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear();
        outXf = {};
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return;
                }
            }
        }
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

    readMap(_T("baseColorMap"), d.colorMap, d.colorMapTransform);
    readMap(_T("roughnessMap"), d.roughnessMap, d.roughnessMapTransform);
    readMap(_T("metalnessMap"), d.metalnessMap, d.metalnessMapTransform);
    readMap(_T("normalMap"), d.normalMap, d.normalMapTransform);
    readMap(_T("ambientOcclusionMap"), d.aoMap, d.aoMapTransform);
    readMap(_T("emissionMap"), d.emissionMap, d.emissionMapTransform);
    readMap(_T("AlphaMap"), d.opacityMap, d.opacityMapTransform);
}

// Extract PBR from USD Preview Surface — generic paramblock reader
static void ExtractUsdPreviewSurfaceMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();

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
    auto readMap = [&](const MCHAR* pname, std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear();
        outXf = {};
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return;
                }
            }
        }
    };

    readColor(_T("diffuseColor"), d.color);

    d.roughness         = readFloat(_T("roughness"), 0.5f);
    d.metalness         = readFloat(_T("metallic"), 0.0f);
    d.opacity           = readFloat(_T("opacity"), 1.0f);
    d.normalScale       = readFloat(_T("bump_map_amt"), 1.0f);
    d.aoIntensity       = readFloat(_T("occlusion"), 1.0f);
    d.ior               = readFloat(_T("ior"), 1.5f);
    d.clearcoat         = readFloat(_T("clearcoat"), 0.0f);
    d.clearcoatRoughness = readFloat(_T("clearcoatRoughness"), 0.01f);
    d.displacementScale = readFloat(_T("displacement"), 0.0f);

    readColor(_T("emissiveColor"), d.emission);
    d.emIntensity = (d.emission[0] + d.emission[1] + d.emission[2] > 0) ? 1.0f : 0.0f;

    readMap(_T("diffuseColor_map"),      d.colorMap,        d.colorMapTransform);
    readMap(_T("roughness_map"),          d.roughnessMap,    d.roughnessMapTransform);
    readMap(_T("metallic_map"),           d.metalnessMap,    d.metalnessMapTransform);
    readMap(_T("normal_map"),             d.normalMap,       d.normalMapTransform);
    readMap(_T("occlusion_map"),          d.aoMap,           d.aoMapTransform);
    readMap(_T("emissiveColor_map"),      d.emissionMap,     d.emissionMapTransform);
    readMap(_T("opacity_map"),            d.opacityMap,      d.opacityMapTransform);
    readMap(_T("displacement_map"),       d.displacementMap, d.displacementMapTransform);

    // USD Preview Surface with clearcoat or IOR ≠ 1.5 → Physical material
    if (d.clearcoat > 0.0f || d.ior != 1.5f)
        d.materialModel = L"MeshPhysicalMaterial";
}

// ── Composite AO detection ──────────────────────────────────
#define COMPOSITE_TEX_CLASS_ID Class_ID(640, 0)
#define COMPOSITE_BLEND_MULTIPLY 5

static bool TrySplitCompositeAO(Texmap* map, TimeValue t,
                                std::wstring& colorPath, MaxJSPBR::TexTransform& colorXf,
                                std::wstring& aoPath, MaxJSPBR::TexTransform& aoXf) {
    if (!map || map->ClassID() != COMPOSITE_TEX_CLASS_ID) return false;
    IParamBlock2* pb = map->GetParamBlockByID(0);
    if (!pb) return false;

    auto getTabCount = [&](const MCHAR* pname) -> int {
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) return pb->Count(pid);
        }
        return 0;
    };
    auto getTabInt = [&](const MCHAR* pname, int idx) -> int {
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) return pb->GetInt(pid, t, idx);
        }
        return 0;
    };
    auto getTabTexmap = [&](const MCHAR* pname, int idx) -> Texmap* {
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) return pb->GetTexmap(pid, t, idx);
        }
        return nullptr;
    };

    if (getTabCount(_T("mapList")) < 2) return false;
    if (!getTabInt(_T("mapEnabled"), 0) || !getTabInt(_T("mapEnabled"), 1)) return false;
    if (getTabInt(_T("blendMode"), 1) != COMPOSITE_BLEND_MULTIPLY) return false;

    Texmap* layer1 = getTabTexmap(_T("mapList"), 0);
    Texmap* layer2 = getTabTexmap(_T("mapList"), 1);
    if (!layer1 || !layer2) return false;

    return ExtractMaterialTexture(layer1, colorPath, colorXf) &&
           ExtractMaterialTexture(layer2, aoPath, aoXf);
}

// Extract PBR from 3ds Max Physical Material
static void ExtractPhysicalMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshPhysicalMaterial";

    auto readColor = [&](const MCHAR* pname, float out[3]) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_RGBA || pd.type == TYPE_FRGBA)) {
                    Color c = pb->GetColor(pid, t);
                    out[0] = c.r; out[1] = c.g; out[2] = c.b;
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
    auto readBool = [&](const MCHAR* pname, bool def) -> bool {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_BOOL || pd.type == TYPE_INT))
                    return pb->GetInt(pid, t) != 0;
            }
        }
        return def;
    };
    auto readMap = [&](const MCHAR* pname, const MCHAR* onName,
                       std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear();
        outXf = {};
        // Check if map is enabled
        if (onName && !readBool(onName, true)) return;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return;
                }
            }
        }
    };

    // Core PBR
    readColor(_T("base_color"), d.color);
    d.roughness  = readFloat(_T("roughness"), 0.0f);
    d.metalness  = readFloat(_T("metalness"), 0.0f);
    d.opacity    = 1.0f - readFloat(_T("transparency"), 0.0f);
    d.ior        = readFloat(_T("trans_ior"), 1.52f);
    d.normalScale = readFloat(_T("bump_map_amt"), 0.3f);
    d.displacementScale = readFloat(_T("displacement_map_amt"), 1.0f);

    // Transmission
    d.transmission = readFloat(_T("transparency"), 0.0f);
    if (d.transmission > 0.0f) {
        readColor(_T("trans_color"), d.attenuationColor);
        d.attenuationDistance = readFloat(_T("trans_depth"), 0.0f);
    }

    // Clearcoat
    d.clearcoat = readFloat(_T("coating"), 0.0f);
    d.clearcoatRoughness = readFloat(_T("coat_roughness"), 0.0f);

    // Sheen
    d.sheen = readFloat(_T("sheen"), 0.0f);
    d.sheenRoughness = readFloat(_T("sheen_roughness"), 0.3f);
    readColor(_T("sheen_color"), d.sheenColor);

    // Emission
    float emWeight = readFloat(_T("emission"), 0.0f);
    readColor(_T("emit_color"), d.emission);
    d.emIntensity = emWeight;

    // Anisotropy
    d.anisotropy = readFloat(_T("anisotropy"), 0.0f);

    // Iridescence (thin film)
    d.iridescence = readFloat(_T("thin_film"), 0.0f);
    d.iridescenceIOR = readFloat(_T("thin_film_ior"), 1.3f);

    // Helper to get raw Texmap from PB
    auto getTexmap = [&](const MCHAR* pname, const MCHAR* onName) -> Texmap* {
        if (onName && !readBool(onName, true)) return nullptr;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP)
                    return pb->GetTexmap(pid, t);
            }
        }
        return nullptr;
    };

    // Texture maps — check diffuse for Composite AO pattern
    {
        Texmap* baseColorMap = getTexmap(_T("base_color_map"), _T("base_color_map_on"));
        if (!baseColorMap || !TrySplitCompositeAO(baseColorMap, t, d.colorMap, d.colorMapTransform, d.aoMap, d.aoMapTransform))
            readMap(_T("base_color_map"), _T("base_color_map_on"), d.colorMap, d.colorMapTransform);
    }
    readMap(_T("roughness_map"),     _T("roughness_map_on"),     d.roughnessMap,    d.roughnessMapTransform);
    readMap(_T("metalness_map"),     _T("metalness_map_on"),     d.metalnessMap,    d.metalnessMapTransform);
    readMap(_T("emit_color_map"),    _T("emit_color_map_on"),    d.emissionMap,     d.emissionMapTransform);
    readMap(_T("coat_map"),          _T("coat_map_on"),          d.clearcoatMap,             d.clearcoatMapTransform);
    readMap(_T("coat_rough_map"),    _T("coat_rough_map_on"),    d.clearcoatRoughnessMap,    d.clearcoatRoughnessMapTransform);
    readMap(_T("displacement_map"), _T("displacement_map_on"),  d.displacementMap, d.displacementMapTransform);
    readMap(_T("transparency_map"), _T("transparency_map_on"),  d.opacityMap,      d.opacityMapTransform);
    readMap(_T("cutout_map"),       _T("cutout_map_on"),        d.opacityMap,      d.opacityMapTransform);

    // Normal/Bump map — Physical Material "bump_map" slot can contain either:
    //   1) Normal Bump texmap (wrapper) → subtex 0 is normal map, subtex 1 is additional bump
    //   2) Plain bitmap → height-based bump map
    // Detect which one and route to the correct PBR field.
    Texmap* bumpSlot = getTexmap(_T("bump_map"), _T("bump_map_on"));
    if (bumpSlot) {
        ExtractWrappedNormalBumpMaps(
            bumpSlot,
            d.normalMap,
            d.normalMapTransform,
            d.bumpMap,
            d.bumpMapTransform
        );
        if (!d.bumpMap.empty()) {
            d.bumpScale = d.normalScale;
        }
    }

    // Clearcoat normal/bump — same detection logic
    Texmap* coatBumpSlot = getTexmap(_T("coat_bump_map"), _T("coat_bump_map_on"));
    if (coatBumpSlot) {
        std::wstring clearcoatBumpPath;
        MaxJSPBR::TexTransform clearcoatBumpXf;
        ExtractWrappedNormalBumpMaps(
            coatBumpSlot,
            d.clearcoatNormalMap,
            d.clearcoatNormalMapTransform,
            clearcoatBumpPath,
            clearcoatBumpXf
        );
        if (d.clearcoatNormalMap.empty() && !clearcoatBumpPath.empty()) {
            d.clearcoatNormalMap = clearcoatBumpPath;
            d.clearcoatNormalMapTransform = clearcoatBumpXf;
        }
    }
}

// Extract PBR from OpenPBR Material — same PB layout as Physical Material
static void ExtractOpenPBRMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshPhysicalMaterial";

    // Reuse the same generic PB reader pattern as Physical Material
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
    auto readColor = [&](const MCHAR* pname, float out[3]) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_RGBA || pd.type == TYPE_FRGBA)) {
                    Color c = pb->GetColor(pid, t);
                    out[0] = c.r; out[1] = c.g; out[2] = c.b;
                    return;
                }
            }
        }
    };
    auto readBool = [&](const MCHAR* pname, bool def) -> bool {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_BOOL || pd.type == TYPE_INT))
                    return pb->GetInt(pid, t) != 0;
            }
        }
        return def;
    };
    auto readMap = [&](const MCHAR* mapName, const MCHAR* onName,
                       std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear(); outXf = {};
        if (onName && !readBool(onName, true)) return;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, mapName) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return;
                }
            }
        }
    };

    // Core PBR
    readColor(_T("base_color"), d.color);
    d.roughness       = readFloat(_T("specular_roughness"), 0.3f);
    d.metalness       = readFloat(_T("base_metalness"), 0.0f);
    d.ior             = readFloat(_T("specular_ior"), 1.5f);
    d.normalScale     = readFloat(_T("bump_map_amt"), 1.0f);
    d.displacementScale = readFloat(_T("displacement_map_amt"), 1.0f);
    d.anisotropy      = readFloat(_T("specular_roughness_anisotropy"), 0.0f);

    // Specular
    readColor(_T("specular_color"), d.physicalSpecularColor);
    d.physicalSpecularIntensity = readFloat(_T("specular_weight"), 1.0f);

    // Transmission
    d.transmission = readFloat(_T("transmission_weight"), 0.0f);
    if (d.transmission > 0.0f) {
        readColor(_T("transmission_color"), d.attenuationColor);
        d.attenuationDistance = readFloat(_T("transmission_depth"), 0.0f);
        d.dispersion = readFloat(_T("transmission_dispersion_scale"), 0.0f);
    }

    // Coat
    d.clearcoat = readFloat(_T("coat_weight"), 0.0f);
    d.clearcoatRoughness = readFloat(_T("coat_roughness"), 0.0f);

    // Fuzz → Sheen
    d.sheen = readFloat(_T("fuzz_weight"), 0.0f);
    readColor(_T("fuzz_color"), d.sheenColor);
    d.sheenRoughness = readFloat(_T("fuzz_roughness"), 0.5f);

    // Emission
    float emWeight = readFloat(_T("emission_weight"), 0.0f);
    readColor(_T("emission_color"), d.emission);
    d.emIntensity = emWeight;

    // Thin film → Iridescence
    d.iridescence = readFloat(_T("thin_film_weight"), 0.0f);
    d.iridescenceIOR = readFloat(_T("thin_film_ior"), 1.4f);

    auto getTexmap = [&](const MCHAR* pname, const MCHAR* onName) -> Texmap* {
        if (onName && !readBool(onName, true)) return nullptr;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP)
                    return pb->GetTexmap(pid, t);
            }
        }
        return nullptr;
    };

    // Texture maps — check for Composite AO
    {
        Texmap* baseColorMap = getTexmap(_T("base_color_map"), _T("base_color_map_on"));
        if (!baseColorMap || !TrySplitCompositeAO(baseColorMap, t, d.colorMap, d.colorMapTransform, d.aoMap, d.aoMapTransform))
            readMap(_T("base_color_map"), _T("base_color_map_on"), d.colorMap, d.colorMapTransform);
    }
    readMap(_T("specular_roughness_map"), _T("specular_roughness_map_on"), d.roughnessMap,    d.roughnessMapTransform);
    readMap(_T("base_metalness_map"),     _T("base_metalness_map_on"),     d.metalnessMap,    d.metalnessMapTransform);
    readMap(_T("emission_color_map"),     _T("emission_color_map_on"),     d.emissionMap,     d.emissionMapTransform);
    readMap(_T("geometry_opacity_map"),   _T("geometry_opacity_map_on"),   d.opacityMap,      d.opacityMapTransform);
    readMap(_T("displacement_map"),       _T("displacement_map_on"),       d.displacementMap, d.displacementMapTransform);
    readMap(_T("coat_weight_map"),        _T("coat_weight_map_on"),        d.clearcoatMap,    d.clearcoatMapTransform);
    readMap(_T("coat_roughness_map"),     _T("coat_roughness_map_on"),     d.clearcoatRoughnessMap, d.clearcoatRoughnessMapTransform);
    readMap(_T("geometry_coat_normal_map"), _T("geometry_coat_normal_map_on"), d.clearcoatNormalMap, d.clearcoatNormalMapTransform);

    // geometry_normal_map is a dedicated normal map slot (no Normal Bump wrapper needed)
    readMap(_T("geometry_normal_map"), _T("geometry_normal_map_on"), d.normalMap, d.normalMapTransform);

    // bump_map can be Normal Bump or plain bump — same detection as Physical
    Texmap* bumpSlot = getTexmap(_T("bump_map"), _T("bump_map_on"));
    if (bumpSlot) {
        std::wstring wrappedNormalPath;
        MaxJSPBR::TexTransform wrappedNormalXf;
        std::wstring wrappedBumpPath;
        MaxJSPBR::TexTransform wrappedBumpXf;
        ExtractWrappedNormalBumpMaps(
            bumpSlot,
            wrappedNormalPath,
            wrappedNormalXf,
            wrappedBumpPath,
            wrappedBumpXf
        );

        if (d.normalMap.empty() && !wrappedNormalPath.empty()) {
            d.normalMap = wrappedNormalPath;
            d.normalMapTransform = wrappedNormalXf;
        }
        if (!wrappedBumpPath.empty()) {
            d.bumpMap = wrappedBumpPath;
            d.bumpMapTransform = wrappedBumpXf;
        } else if (d.normalMap.empty() && d.bumpMap.empty()) {
            d.bumpMap = wrappedNormalPath;
            d.bumpMapTransform = wrappedNormalXf;
        }
        if (!d.bumpMap.empty()) {
            d.bumpScale = d.normalScale;
        }
    }

    // Downgrade to Standard if no advanced features
    if (d.clearcoat == 0.0f && d.sheen == 0.0f && d.transmission == 0.0f &&
        d.iridescence == 0.0f && d.anisotropy == 0.0f)
        d.materialModel = L"MeshStandardMaterial";
}

// Extract PBR from VRayMtl
static void ExtractVRayMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d) {
    MSTR name = mtl->GetName();
    d.mtlName = name.data();
    d.materialModel = L"MeshPhysicalMaterial";

    // VRayMtl uses PB index 1 ("basic") for most params
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
    auto readColor = [&](const MCHAR* pname, float out[3]) {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0) {
                    if (pd.type == TYPE_RGBA || pd.type == TYPE_FRGBA || pd.type == TYPE_COLOR) {
                        Color c = pb->GetColor(pid, t);
                        out[0] = c.r; out[1] = c.g; out[2] = c.b;
                    }
                    return;
                }
            }
        }
    };
    auto readBool = [&](const MCHAR* pname, bool def) -> bool {
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 &&
                    (pd.type == TYPE_BOOL || pd.type == TYPE_INT))
                    return pb->GetInt(pid, t) != 0;
            }
        }
        return def;
    };
    auto readMap = [&](const MCHAR* mapName, const MCHAR* onName,
                       std::wstring& outPath, MaxJSPBR::TexTransform& outXf) {
        outPath.clear(); outXf = {};
        if (onName && !readBool(onName, true)) return;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, mapName) == 0 && pd.type == TYPE_TEXMAP) {
                    Texmap* map = pb->GetTexmap(pid, t);
                    ExtractMaterialTexture(map, outPath, outXf);
                    return;
                }
            }
        }
    };
    auto getTexmap = [&](const MCHAR* pname, const MCHAR* onName) -> Texmap* {
        if (onName && !readBool(onName, true)) return nullptr;
        for (int b = 0; b < mtl->NumParamBlocks(); b++) {
            IParamBlock2* pb = mtl->GetParamBlock(b);
            if (!pb) continue;
            for (int i = 0; i < pb->NumParams(); i++) {
                ParamID pid = pb->IndextoID(i);
                const ParamDef& pd = pb->GetParamDef(pid);
                if (pd.int_name && _tcsicmp(pd.int_name, pname) == 0 && pd.type == TYPE_TEXMAP)
                    return pb->GetTexmap(pid, t);
            }
        }
        return nullptr;
    };

    // Core PBR
    readColor(_T("diffuse"), d.color);
    const bool useRoughnessWorkflow = readBool(_T("brdf_useRoughness"), false);
    const float reflectionGlossiness = readFloat(_T("reflection_glossiness"), 1.0f);
    d.roughness = useRoughnessWorkflow ? reflectionGlossiness : (1.0f - reflectionGlossiness);
    d.metalness = readFloat(_T("reflection_metalness"), 0.0f);
    d.ior = readFloat(_T("refraction_ior"), readFloat(_T("reflection_ior"), 1.6f));
    d.normalScale = readFloat(_T("bump_multiplier"), 30.0f) / 30.0f; // normalize to ~1.0
    d.doubleSided = readBool(_T("option_doubleSided"), true);

    // Emission
    readColor(_T("selfIllumination"), d.emission);
    d.emIntensity = readFloat(_T("selfIllumination_multiplier"), 1.0f);
    if (d.emission[0] + d.emission[1] + d.emission[2] < 0.001f) d.emIntensity = 0.0f;

    // Refraction → transmission
    float refr[3] = {0, 0, 0};
    readColor(_T("refraction"), refr);
    d.transmission = (refr[0] + refr[1] + refr[2]) / 3.0f;
    if (d.transmission > 0.0f) {
        readColor(_T("refraction_fogColor"), d.attenuationColor);
        d.attenuationDistance = readFloat(_T("refraction_fogDepth"), readFloat(_T("refraction_fogMult"), 1.0f));
        if (readBool(_T("refraction_dispersion_on"), false))
            d.dispersion = readFloat(_T("refraction_dispersion"), 0.0f);
    }

    // Coat
    d.clearcoat = readFloat(_T("coat_amount"), 0.0f);
    d.clearcoatRoughness = 1.0f - readFloat(_T("coat_glossiness"), 1.0f);

    // Sheen
    float sheenCol[3] = {0, 0, 0};
    readColor(_T("sheen_color"), sheenCol);
    d.sheen = (sheenCol[0] + sheenCol[1] + sheenCol[2]) / 3.0f;
    d.sheenColor[0] = sheenCol[0]; d.sheenColor[1] = sheenCol[1]; d.sheenColor[2] = sheenCol[2];
    d.sheenRoughness = 1.0f - readFloat(_T("sheen_glossiness"), 0.8f);

    // Anisotropy
    d.anisotropy = readFloat(_T("anisotropy"), 0.0f);

    // Thin film → iridescence
    if (readBool(_T("thinFilm_on"), false)) {
        d.iridescence = 1.0f;
        d.iridescenceIOR = readFloat(_T("thinFilm_ior"), 1.47f);
    }

    // Texture maps
    // Diffuse — check for Composite AO pattern (Color × AO multiply)
    {
        Texmap* diffuseMap = nullptr;
        if (readBool(_T("texmap_diffuse_on"), true)) {
            for (int b = 0; b < mtl->NumParamBlocks(); b++) {
                IParamBlock2* pb = mtl->GetParamBlock(b);
                if (!pb) continue;
                for (int i = 0; i < pb->NumParams(); i++) {
                    ParamID pid = pb->IndextoID(i);
                    const ParamDef& pd = pb->GetParamDef(pid);
                    if (pd.int_name && _tcsicmp(pd.int_name, _T("texmap_diffuse")) == 0 && pd.type == TYPE_TEXMAP) {
                        diffuseMap = pb->GetTexmap(pid, t);
                        break;
                    }
                }
                if (diffuseMap) break;
            }
        }
        if (!diffuseMap || !TrySplitCompositeAO(diffuseMap, t, d.colorMap, d.colorMapTransform, d.aoMap, d.aoMapTransform))
            readMap(_T("texmap_diffuse"), _T("texmap_diffuse_on"), d.colorMap, d.colorMapTransform);
    }
    if (useRoughnessWorkflow) {
        readMap(_T("texmap_roughness"), _T("texmap_roughness_on"), d.roughnessMap, d.roughnessMapTransform);
    } else {
        readMap(_T("texmap_reflectionGlossiness"), _T("texmap_reflectionGlossiness_on"), d.roughnessMap, d.roughnessMapTransform);
        if (!d.roughnessMap.empty())
            d.roughnessMapTransform.invert = true;
    }
    readMap(_T("texmap_metalness"),        _T("texmap_metalness_on"),        d.metalnessMap,  d.metalnessMapTransform);
    readMap(_T("texmap_refraction"),       _T("texmap_refraction_on"),       d.transmissionMap, d.transmissionMapTransform);
    readMap(_T("texmap_self_illumination"),_T("texmap_self_illumination_on"),d.emissionMap,   d.emissionMapTransform);
    readMap(_T("texmap_opacity"),          _T("texmap_opacity_on"),          d.opacityMap,    d.opacityMapTransform);
    readMap(_T("texmap_displacement"),     _T("texmap_displacement_on"),     d.displacementMap, d.displacementMapTransform);
    readMap(_T("texmap_coat_amount"),      _T("texmap_coat_amount_on"),      d.clearcoatMap,  d.clearcoatMapTransform);
    readMap(_T("texmap_coat_glossiness"),  _T("texmap_coat_glossiness_on"),  d.clearcoatRoughnessMap, d.clearcoatRoughnessMapTransform);
    if (!d.clearcoatRoughnessMap.empty())
        d.clearcoatRoughnessMapTransform.invert = true;

    Texmap* bumpSlot = getTexmap(_T("texmap_bump"), _T("texmap_bump_on"));
    if (bumpSlot) {
        ExtractWrappedNormalBumpMaps(
            bumpSlot,
            d.normalMap,
            d.normalMapTransform,
            d.bumpMap,
            d.bumpMapTransform
        );
        if (!d.bumpMap.empty())
            d.bumpScale = d.normalScale;
    }

    Texmap* coatBumpSlot = getTexmap(_T("texmap_coat_bump"), _T("texmap_coat_bump_on"));
    if (coatBumpSlot) {
        std::wstring clearcoatBumpPath;
        MaxJSPBR::TexTransform clearcoatBumpXf;
        ExtractWrappedNormalBumpMaps(
            coatBumpSlot,
            d.clearcoatNormalMap,
            d.clearcoatNormalMapTransform,
            clearcoatBumpPath,
            clearcoatBumpXf
        );
        if (d.clearcoatNormalMap.empty() && !clearcoatBumpPath.empty()) {
            d.clearcoatNormalMap = clearcoatBumpPath;
            d.clearcoatNormalMapTransform = clearcoatBumpXf;
        }
    }

    // Downgrade to Standard if no advanced features used
    if (d.clearcoat == 0.0f && d.sheen == 0.0f && d.transmission == 0.0f &&
        d.iridescence == 0.0f && d.anisotropy == 0.0f)
        d.materialModel = L"MeshStandardMaterial";
}

// Extract PBR from a single material (ThreeJS, glTF, or wire color fallback)
static void ExtractPBRFromMtl(Mtl* mtl, INode* node, TimeValue t, MaxJSPBR& d) {
    if (mtl) {
        Mtl* found = FindSupportedMaterial(mtl);
        if (found) {
            const Class_ID cid = found->ClassID();
            if (IsThreeJSMaterialClass(cid))
                ExtractThreeJSMtl(found, t, d);
            else if (cid == THREEJS_TOON_CLASS_ID)
                ExtractThreeJSToonMtl(found, t, d);
            else if (IsMaterialXMaterialClass(cid))
                ExtractMaterialXMtl(found, t, d);
            else if (cid == USD_PREVIEW_SURFACE_CLASS_ID)
                ExtractUsdPreviewSurfaceMtl(found, t, d);
            else if (cid == PHYSICAL_MTL_CLASS_ID)
                ExtractPhysicalMtl(found, t, d);
            else if (cid == VRAYMTL_CLASS_ID)
                ExtractVRayMtl(found, t, d);
            else if (cid == OPENPBR_MTL_CLASS_ID)
                ExtractOpenPBRMtl(found, t, d);
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

    // Priority 1: ThreeJS Material, glTF Material, or USD Preview Surface (direct or inside Shell)
    Mtl* found = FindSupportedMaterial(mtl);
    if (found) {
        const Class_ID cid = found->ClassID();
        if (IsThreeJSMaterialClass(cid))
            ExtractThreeJSMtl(found, t, d);
        else if (cid == THREEJS_TOON_CLASS_ID)
            ExtractThreeJSToonMtl(found, t, d);
        else if (IsMaterialXMaterialClass(cid))
            ExtractMaterialXMtl(found, t, d);
        else if (cid == USD_PREVIEW_SURFACE_CLASS_ID)
            ExtractUsdPreviewSurfaceMtl(found, t, d);
        else if (cid == PHYSICAL_MTL_CLASS_ID)
            ExtractPhysicalMtl(found, t, d);
        else if (cid == VRAYMTL_CLASS_ID)
            ExtractVRayMtl(found, t, d);
        else if (cid == OPENPBR_MTL_CLASS_ID)
            ExtractOpenPBRMtl(found, t, d);
        else
            ExtractGltfMtl(found, t, d);
        return;
    }

    // Priority 2: Wire color fallback (old material conversion disabled for speed)
    GetWireColor3f(node, d.color);
}

static void ExtractMaterialScalarPreview(Mtl* foundMtl, INode* node, TimeValue t, float col[3], float& rough, float& metal, float& opac) {
    if (!foundMtl) {
        if (node) GetWireColor3f(node, col);
        return;
    }

    const Class_ID cid = foundMtl->ClassID();
    if (IsThreeJSMaterialClass(cid)) {
        IParamBlock2* pb = foundMtl->GetParamBlockByID(threejs_params);
        if (pb) {
            Color c = pb->GetColor(pb_color, t);
            col[0] = c.r; col[1] = c.g; col[2] = c.b;
            rough = pb->GetFloat(pb_roughness, t);
            metal = pb->GetFloat(pb_metalness, t);
            opac = pb->GetFloat(pb_opacity, t);
            return;
        }
    } else if (cid == THREEJS_TOON_CLASS_ID) {
        IParamBlock2* pb = foundMtl->GetParamBlockByID(toon_params);
        if (pb) {
            Color c = pb->GetColor(tp_color, t);
            col[0] = c.r; col[1] = c.g; col[2] = c.b;
            rough = 0.0f;
            metal = 0.0f;
            opac = pb->GetFloat(tp_opacity, t);
            return;
        }
    } else if (cid == GLTF_MTL_CLASS_ID) {
        MaxJSPBR tmp;
        ExtractGltfMtl(foundMtl, t, tmp);
        col[0] = tmp.color[0]; col[1] = tmp.color[1]; col[2] = tmp.color[2];
        rough = tmp.roughness;
        metal = tmp.metalness;
        opac = tmp.opacity;
        return;
    } else if (cid == USD_PREVIEW_SURFACE_CLASS_ID) {
        MaxJSPBR tmp;
        ExtractUsdPreviewSurfaceMtl(foundMtl, t, tmp);
        col[0] = tmp.color[0]; col[1] = tmp.color[1]; col[2] = tmp.color[2];
        rough = tmp.roughness;
        metal = tmp.metalness;
        opac = tmp.opacity;
        return;
    } else {
        MaxJSPBR tmp;
        ExtractPBRFromMtl(foundMtl, node, t, tmp);
        col[0] = tmp.color[0]; col[1] = tmp.color[1]; col[2] = tmp.color[2];
        rough = tmp.roughness;
        metal = tmp.metalness;
        opac = tmp.opacity;
        return;
    }

    if (node) GetWireColor3f(node, col);
}

static uint64_t HashMaterialScalarPreviewValues(const float col[3], float rough, float metal, float opac) {
    uint64_t h = 1469598103934665603ULL;
    h = HashFNV1a(col, sizeof(float) * 3, h);
    h = HashFNV1a(&rough, sizeof(rough), h);
    h = HashFNV1a(&metal, sizeof(metal), h);
    h = HashFNV1a(&opac, sizeof(opac), h);
    return h;
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

// ── MNMesh (PolyObject) extraction — handles ngons correctly ──
static bool ExtractMeshFromMNMesh(MNMesh& mn,
                                  std::vector<float>& verts,
                                  std::vector<float>& uvs,
                                  std::vector<int>& indices,
                                  std::vector<MatGroup>& groups,
                                  std::vector<float>* outNormals = nullptr) {
    const int numFaces = mn.FNum();
    const int numVerts = mn.VNum();
    if (numFaces == 0 || numVerts == 0) return false;

    // UV map channel 1
    MNMap* uvMap = mn.M(1);
    const bool hasUVs = uvMap && uvMap->GetFlag(MN_DEAD) == 0 && uvMap->numv > 0;

    // Count live faces + sort by matID
    struct FaceRef { int idx; MtlID matID; };
    std::vector<FaceRef> liveFaces;
    liveFaces.reserve(numFaces);
    for (int i = 0; i < numFaces; i++) {
        MNFace* f = mn.F(i);
        if (!f || f->GetFlag(MN_DEAD)) continue;
        liveFaces.push_back({ i, f->material });
    }
    if (liveFaces.empty()) return false;

    // Check for multi-mat and sort
    bool multiMat = false;
    MtlID firstMat = liveFaces[0].matID;
    for (auto& fr : liveFaces) {
        if (fr.matID != firstMat) { multiMat = true; break; }
    }
    if (multiMat) {
        std::sort(liveFaces.begin(), liveFaces.end(),
            [](const FaceRef& a, const FaceRef& b) { return a.matID < b.matID; });
    }

    // Compute face normals for all live faces
    std::vector<Point3> faceNormals(numFaces, Point3(0, 0, 0));
    for (auto& fr : liveFaces) {
        MNFace* face = mn.F(fr.idx);
        if (face->deg < 3) continue;
        Point3 a = mn.P(face->vtx[0]);
        Point3 b = mn.P(face->vtx[1]);
        Point3 c = mn.P(face->vtx[2]);
        faceNormals[fr.idx] = Normalize((b - a) ^ (c - a));
    }

    // Build per-vertex smooth normals respecting smoothing groups.
    // Key: {posIdx, smGroup} → accumulated normal
    struct SmNormKey { int posIdx; DWORD smGrp; };
    struct SmNormKeyHash {
        size_t operator()(const SmNormKey& k) const noexcept {
            return size_t(k.posIdx) * 16777619u ^ size_t(k.smGrp);
        }
    };
    struct SmNormKeyEq {
        bool operator()(const SmNormKey& a, const SmNormKey& b) const {
            return a.posIdx == b.posIdx && a.smGrp == b.smGrp;
        }
    };
    std::unordered_map<SmNormKey, Point3, SmNormKeyHash, SmNormKeyEq> smoothNormals;
    for (auto& fr : liveFaces) {
        MNFace* face = mn.F(fr.idx);
        const DWORD smGrp = face->smGroup;
        for (int v = 0; v < face->deg; v++) {
            SmNormKey key = { face->vtx[v], smGrp };
            smoothNormals[key] = smoothNormals[key] + faceNormals[fr.idx];
        }
    }
    // Normalize
    for (auto& kv : smoothNormals) {
        kv.second = Normalize(kv.second);
    }

    // Estimate output sizes
    int estTris = 0;
    for (auto& fr : liveFaces) estTris += mn.F(fr.idx)->deg - 2;
    verts.reserve(numVerts * 3);
    if (hasUVs) uvs.reserve(numVerts * 2);
    indices.reserve(estTris * 3);
    std::vector<float> normals;
    if (outNormals) normals.reserve(numVerts * 3);

    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    Tab<int> triTab;
    int curMatID = -1;

    for (auto& fr : liveFaces) {
        MNFace* face = mn.F(fr.idx);
        const int deg = face->deg;
        const DWORD smGrp = face->smGroup;
        const int matID = (int)face->material;

        if (matID != curMatID) {
            curMatID = matID;
            groups.push_back({ matID, (int)indices.size(), 0 });
        }

        MNMapFace* uvFace = (hasUVs && fr.idx < uvMap->numf) ? uvMap->F(fr.idx) : nullptr;

        triTab.SetCount(0);
        face->GetTriangles(triTab);
        const int numTris = triTab.Count() / 3;

        for (int ti = 0; ti < numTris; ti++) {
            for (int tv = 0; tv < 3; tv++) {
                int localIdx = triTab[ti * 3 + tv];
                DWORD posIdx = face->vtx[localIdx];
                DWORD uvIdx = (uvFace && localIdx < uvFace->deg) ? uvFace->tv[localIdx] : 0;

                MeshCornerKey key = { posIdx, uvIdx, smGrp };
                auto it = vertMap.find(key);
                if (it != vertMap.end()) {
                    indices.push_back(it->second);
                } else {
                    int newIdx = (int)(verts.size() / 3);
                    vertMap[key] = newIdx;

                    Point3 p = mn.P(posIdx);
                    verts.push_back(p.x);
                    verts.push_back(p.y);
                    verts.push_back(p.z);

                    if (outNormals) {
                        SmNormKey nk = { (int)posIdx, smGrp };
                        auto nit = smoothNormals.find(nk);
                        Point3 n = (nit != smoothNormals.end()) ? nit->second : faceNormals[fr.idx];
                        normals.push_back(n.x);
                        normals.push_back(n.y);
                        normals.push_back(n.z);
                    }

                    if (hasUVs && uvIdx < (DWORD)uvMap->numv) {
                        UVVert uv = uvMap->v[uvIdx];
                        uvs.push_back(uv.x);
                        uvs.push_back(uv.y);
                    } else if (hasUVs) {
                        uvs.push_back(0.0f);
                        uvs.push_back(0.0f);
                    }

                    indices.push_back(newIdx);
                }
            }
            groups.back().count += 3;
        }
    }
    if (outNormals) *outNormals = std::move(normals);
    return !indices.empty();
}

// ── TriObject (Mesh) extraction — standard triangle meshes ──
static bool ExtractMeshFromTriObject(TriObject* tri, Object* srcObj,
                                     std::vector<float>& verts,
                                     std::vector<float>& uvs,
                                     std::vector<int>& indices,
                                     std::vector<MatGroup>& groups) {
    Mesh& mesh = tri->GetMesh();
    int nv = mesh.getNumVerts();
    int nf = mesh.getNumFaces();

    if (nv == 0 || nf == 0) {
        if (tri != srcObj) tri->DeleteThis();
        return false;
    }

    bool hasUVs = mesh.getNumTVerts() > 0;

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

    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    verts.reserve(nv * 3);
    if (hasUVs) uvs.reserve(nv * 2);
    indices.reserve(nf * 3);

    int curMatID = -1;
    for (int fi = 0; fi < nf; fi++) {
        int f = faceOrder[fi];
        int matID = (int)mesh.faces[f].getMatID();

        if (matID != curMatID) {
            curMatID = matID;
            groups.push_back({ matID, (int)indices.size(), 0 });
        }

        for (int v = 0; v < 3; v++) {
            DWORD posIdx = mesh.faces[f].v[v];
            DWORD uvIdx  = hasUVs ? mesh.tvFace[f].t[v] : 0;
            MeshCornerKey key = { posIdx, uvIdx, mesh.faces[f].getSmGroup() };

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

    if (tri != srcObj) tri->DeleteThis();
    return true;
}

// ── Raw Mesh extraction — for Forest Pack fi.mesh pointers ──
static bool ExtractMeshFromRawMesh(Mesh& mesh,
                                   std::vector<float>& verts,
                                   std::vector<float>& uvs,
                                   std::vector<int>& indices,
                                   std::vector<MatGroup>& groups,
                                   std::vector<float>* outNormals = nullptr) {
    int nv = mesh.getNumVerts();
    int nf = mesh.getNumFaces();
    if (nv == 0 || nf == 0) return false;

    bool hasUVs = mesh.getNumTVerts() > 0;

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

    // Build smooth normals if requested
    std::vector<Point3> faceNormals;
    struct SmKey { int posIdx; DWORD smGrp; };
    struct SmKeyHash { size_t operator()(const SmKey& k) const noexcept {
        return size_t(k.posIdx) * 16777619u ^ size_t(k.smGrp); }};
    struct SmKeyEq { bool operator()(const SmKey& a, const SmKey& b) const {
        return a.posIdx == b.posIdx && a.smGrp == b.smGrp; }};
    std::unordered_map<SmKey, Point3, SmKeyHash, SmKeyEq> smoothNormals;
    if (outNormals) {
        faceNormals.resize(nf, Point3(0,0,0));
        for (int f = 0; f < nf; f++) {
            Point3 a = mesh.getVert(mesh.faces[f].v[0]);
            Point3 b = mesh.getVert(mesh.faces[f].v[1]);
            Point3 c = mesh.getVert(mesh.faces[f].v[2]);
            faceNormals[f] = Normalize((b - a) ^ (c - a));
        }
        for (int f = 0; f < nf; f++) {
            DWORD smGrp = mesh.faces[f].getSmGroup();
            for (int v = 0; v < 3; v++) {
                SmKey key = { (int)mesh.faces[f].v[v], smGrp };
                smoothNormals[key] = smoothNormals[key] + faceNormals[f];
            }
        }
        for (auto& kv : smoothNormals) kv.second = Normalize(kv.second);
    }

    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    verts.reserve(nv * 3);
    if (hasUVs) uvs.reserve(nv * 2);
    indices.reserve(nf * 3);
    std::vector<float> normals;
    if (outNormals) normals.reserve(nv * 3);

    int curMatID = -1;
    for (int fi = 0; fi < nf; fi++) {
        int f = faceOrder[fi];
        int matID = (int)mesh.faces[f].getMatID();

        if (matID != curMatID) {
            curMatID = matID;
            groups.push_back({ matID, (int)indices.size(), 0 });
        }

        for (int v = 0; v < 3; v++) {
            DWORD posIdx = mesh.faces[f].v[v];
            DWORD uvIdx  = hasUVs ? mesh.tvFace[f].t[v] : 0;
            DWORD smGrp  = mesh.faces[f].getSmGroup();
            MeshCornerKey key = { posIdx, uvIdx, smGrp };

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

                if (outNormals) {
                    SmKey nk = { (int)posIdx, smGrp };
                    auto nit = smoothNormals.find(nk);
                    Point3 n = (nit != smoothNormals.end()) ? nit->second : faceNormals[f];
                    normals.push_back(n.x);
                    normals.push_back(n.y);
                    normals.push_back(n.z);
                }

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
    if (outNormals) *outNormals = std::move(normals);
    return !indices.empty();
}

// ── Spline extraction — sample BezierShape curves into line vertices ──
static bool ExtractSpline(INode* node, TimeValue t,
                          std::vector<float>& verts,
                          std::vector<int>& indices) {
    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != SHAPE_CLASS_ID) return false;

    // Get BezierShape — either directly or via conversion
    SplineShape* converted = nullptr;
    BezierShape* bezShape = nullptr;

    if (os.obj->ClassID() == splineShapeClassID) {
        bezShape = &static_cast<SplineShape*>(os.obj)->shape;
    } else if (os.obj->CanConvertToType(splineShapeClassID)) {
        SplineShape* conv = static_cast<SplineShape*>(
            os.obj->ConvertToType(t, splineShapeClassID));
        if (conv && conv != os.obj) converted = conv;
        if (conv) bezShape = &conv->shape;
    }

    if (!bezShape || bezShape->SplineCount() == 0) {
        if (converted) converted->DeleteThis();
        return false;
    }

    const int STEPS = 6; // steps per spline segment
    int vertOffset = 0;

    for (int s = 0; s < bezShape->SplineCount(); s++) {
        Spline3D* spline = bezShape->GetSpline(s);
        if (!spline || spline->Segments() <= 0) continue;

        const int totalSteps = spline->Segments() * STEPS;
        const int startVert = vertOffset;

        for (int i = 0; i <= totalSteps; i++) {
            const float param = static_cast<float>(i) / static_cast<float>(totalSteps);
            Point3 pt = bezShape->InterpCurve3D(s, param, PARAM_SIMPLE);
            verts.push_back(pt.x);
            verts.push_back(pt.y);
            verts.push_back(pt.z);
            vertOffset++;
        }

        for (int i = startVert; i < vertOffset - 1; i++) {
            indices.push_back(i);
            indices.push_back(i + 1);
        }

        if (spline->Closed() && vertOffset - startVert > 2) {
            indices.push_back(vertOffset - 1);
            indices.push_back(startVert);
        }
    }

    if (converted) converted->DeleteThis();
    return !verts.empty();
}

// ── Unified ExtractMesh — MNMesh path for PolyObject, TriObject fallback ──
static bool ExtractMesh(INode* node, TimeValue t,
                        std::vector<float>& verts,
                        std::vector<float>& uvs,
                        std::vector<int>& indices,
                        std::vector<MatGroup>& groups,
                        std::vector<float>* normals = nullptr) {
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return ExtractMeshFromMNMesh(*liveMN, verts, uvs, indices, groups, normals);
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    // Prefer MNMesh path — handles ngons natively without ConvertToType
    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        MNMesh& mn = poly->GetMesh();
        return ExtractMeshFromMNMesh(mn, verts, uvs, indices, groups, normals);
    }

    // Fallback: convert to TriObject for non-poly geometry (primitives, patches, etc.)
    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;
    return ExtractMeshFromTriObject(tri, os.obj, verts, uvs, indices, groups);
}

static bool TryHashExtractedRenderableGeometry(INode* node, TimeValue t, uint64_t& outHash) {
    std::vector<float> verts, uvs;
    std::vector<int> indices;
    std::vector<MatGroup> groups;
    if (ExtractMesh(node, t, verts, uvs, indices, groups)) {
        outHash = HashMeshData(verts, indices, uvs);
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != SHAPE_CLASS_ID) return false;
    if (!ExtractSpline(node, t, verts, indices)) return false;

    outHash = HashMeshData(verts, indices, uvs);
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

static MaxSDK::Graphics::IViewportViewSetting* GetViewportSettings() {
    Interface* ip = GetCOREInterface();
    if (!ip) return nullptr;
    ViewExp& vp = ip->GetActiveViewExp();
    return static_cast<MaxSDK::Graphics::IViewportViewSetting*>(
        vp.GetInterface(IVIEWPORT_SETTINGS_INTERFACE_ID));
}

static bool IsClayModeActive() {
    auto* s = GetViewportSettings();
    return s && s->GetViewportVisualStyle() == MaxSDK::Graphics::VisualStyleClay;
}

static bool IsNitrousShadowsEnabled() {
    auto* s = GetViewportSettings();
    return s && s->GetShadowsEnabled();
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
//  Node Object Properties
// ══════════════════════════════════════════════════════════════

static uint64_t ComputeNodePropHash(INode* node, TimeValue t) {
    uint64_t h = 0;
    h = h * 31 + (uint64_t)node->Renderable();
    h = h * 31 + (uint64_t)node->GetBackCull();
    h = h * 31 + (uint64_t)node->CastShadows();
    h = h * 31 + (uint64_t)node->RcvShadows();
    h = h * 31 + (uint64_t)(node->GetPrimaryVisibility() ? 1 : 0);
    h = h * 31 + (uint64_t)(node->GetSecondaryVisibility() ? 1 : 0);
    float vis = node->GetVisibility(t);
    uint32_t visBits; memcpy(&visBits, &vis, 4);
    h = h * 31 + visBits;
    return h;
}

static uint64_t ComputeSyncRelevantNodeStateHash(INode* node, TimeValue t) {
    if (!node) return 0;

    uint64_t h = 1469598103934665603ULL;
    const ULONG handle = node->GetHandle();
    h = HashFNV1a(&handle, sizeof(handle), h);

    float xform[16];
    GetTransform16(node, t, xform);
    h = HashFNV1a(xform, sizeof(xform), h);

    const uint64_t props = ComputeNodePropHash(node, t);
    h = HashFNV1a(&props, sizeof(props), h);

    ObjectState os = node->EvalWorldState(t);
    if (os.obj) {
        const SClass_ID superClass = os.obj->SuperClassID();
        const Class_ID classId = os.obj->ClassID();
        h = HashFNV1a(&superClass, sizeof(superClass), h);
        h = HashFNV1a(&classId, sizeof(classId), h);
        h = HashIntervalState(os.obj->ChannelValidity(t, GEOM_CHAN_NUM), h);
        h = HashIntervalState(os.obj->ChannelValidity(t, TOPO_CHAN_NUM), h);
    }

    if (Mtl* mtl = node->GetMtl()) {
        const Class_ID mtlClass = mtl->ClassID();
        h = HashFNV1a(&mtlClass, sizeof(mtlClass), h);
        h = HashIntervalState(mtl->Validity(t), h);
    }

    return h;
}

static void CollectReferencedNodeHandlesRecursive(ReferenceMaker* maker,
                                                  ULONG ownerHandle,
                                                  std::unordered_set<ULONG>& out,
                                                  std::unordered_set<const void*>& visited,
                                                  int depth = 0) {
    if (!maker || depth > 8) return;
    if (!visited.insert(maker).second) return;

    if (maker->SuperClassID() == BASENODE_CLASS_ID) {
        INode* depNode = static_cast<INode*>(maker);
        const ULONG depHandle = depNode->GetHandle();
        if (depHandle != ownerHandle) out.insert(depHandle);
        return;
    }

    const int numRefs = maker->NumRefs();
    for (int i = 0; i < numRefs; ++i) {
        RefTargetHandle ref = maker->GetReference(i);
        if (!ref) continue;
        CollectReferencedNodeHandlesRecursive(ref, ownerHandle, out, visited, depth + 1);
    }
}

static uint64_t ComputePluginInstanceStateHash(INode* node, TimeValue t, Interface* ip) {
    if (!node) return 0;

    uint64_t h = ComputeSyncRelevantNodeStateHash(node, t);
    std::unordered_set<ULONG> deps;
    std::unordered_set<const void*> visited;

    Object* base = node->GetObjectRef();
    while (base && base->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
        base = reinterpret_cast<IDerivedObject*>(base)->GetObjRef();
    }
    ReferenceMaker* root = base
        ? static_cast<ReferenceMaker*>(base)
        : static_cast<ReferenceMaker*>(node->GetObjectRef());
    CollectReferencedNodeHandlesRecursive(root, node->GetHandle(), deps, visited);

    std::vector<ULONG> sortedDeps(deps.begin(), deps.end());
    std::sort(sortedDeps.begin(), sortedDeps.end());
    const size_t depCount = sortedDeps.size();
    h = HashFNV1a(&depCount, sizeof(depCount), h);

    for (ULONG depHandle : sortedDeps) {
        h = HashFNV1a(&depHandle, sizeof(depHandle), h);
        INode* depNode = ip ? ip->GetINodeByHandle(depHandle) : nullptr;
        const uint64_t depHash = depNode ? ComputeSyncRelevantNodeStateHash(depNode, t) : 0;
        h = HashFNV1a(&depHash, sizeof(depHash), h);
    }

    return h;
}

static void WriteNodePropsJson(std::wostringstream& ss, INode* node, TimeValue t) {
    ss << L"\"rend\":" << (node->Renderable() ? L'1' : L'0');
    ss << L",\"bcull\":" << (node->GetBackCull() ? L'1' : L'0');
    ss << L",\"cshadow\":" << (node->CastShadows() ? L'1' : L'0');
    ss << L",\"rshadow\":" << (node->RcvShadows() ? L'1' : L'0');
    ss << L",\"visCam\":" << (node->GetPrimaryVisibility() ? L'1' : L'0');
    ss << L",\"visRefl\":" << (node->GetSecondaryVisibility() ? L'1' : L'0');
    float opacity = node->GetVisibility(t);
    if (opacity < 0.0f) opacity = 0.0f;
    if (opacity > 1.0f) opacity = 1.0f;
    ss << L",\"opacity\":" << opacity;
}

// ══════════════════════════════════════════════════════════════
//  ForestPack Instance Extraction
// ══════════════════════════════════════════════════════════════

static bool IsForestPackClassID(const Class_ID& id) {
    return id == TFOREST_CLASS_ID || id == FIVY_CLASS_ID;
}

// Walk past modifiers/derived objects to find the base object
static Object* GetBaseObject(Object* obj) {
    while (obj && obj->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
        obj = reinterpret_cast<IDerivedObject*>(obj)->GetObjRef();
    }
    return obj;
}

// Check base object ClassID (EvalWorldState returns collapsed mesh, not Forest Pack)
static bool IsForestPackNode(INode* node) {
    if (!node) return false;
    Object* base = GetBaseObject(node->GetObjectRef());
    return base && IsForestPackClassID(base->ClassID());
}

// Check if ForestPack plugin is actually loaded before touching its interfaces
static bool IsForestPackAvailable() {
    static int cached = -1;
    if (cached < 0) {
        // ForestPack's main DLL — if not loaded, don't touch anything
        cached = (GetModuleHandleW(L"Forest.dlo") != nullptr ||
                  GetModuleHandleW(L"ForestPack.dlo") != nullptr ||
                  GetModuleHandleW(L"ForestPackPro.dlo") != nullptr ||
                  GetModuleHandleW(L"ForestPro.dlo") != nullptr) ? 1 : 0;
    }
    return cached == 1;
}

struct ForestInstanceGroup {
    uintptr_t groupKey;               // unique key: source node handle or mesh pointer
    std::vector<float> verts, uvs, norms;
    std::vector<int> indices;
    std::vector<MatGroup> groups;
    std::vector<float> transforms;    // flat array of 16-float matrices
    int instanceCount = 0;
    Mtl* mtl = nullptr;               // material for this group (may be multi-sub)
    INode* mtlNode = nullptr;         // node for wire color fallback
};

// Register MaxJS as a Forest Pack render engine (once per session)
static bool g_forestEngineRegistered = false;
static void RegisterForestPackEngine() {
    if (g_forestEngineRegistered) return;
    __try {
        IForestPackInterface* fpi = GetForestPackInterface();
        if (!fpi) return;
        fpi->IForestRegisterEngine();
        TForestEngineFeatures features;
        features.edgeMode = FALSE;
        features.meshesSupport = TRUE;
        features.animProxySupport = FALSE;
        features.ivySupport = TRUE;
        fpi->IForestSetEngineFeatures((INT_PTR)&features);
        g_forestEngineRegistered = true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
}

// SEH wrapper — isolates crash guard from C++ object unwinding
static bool SafeGetForestInterface(INode* fpNode, ITreesInterface** out) {
    __try {
        Object* base = GetBaseObject(fpNode->GetObjectRef());
        if (!base) return false;
        *out = GetTreesInterface(base);
        return *out != nullptr;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static bool SafeForestRenderBegin(ITreesInterface* itrees, TimeValue t,
                                   TForestInstance** outInstances, int* outCount) {
    __try {
        itrees->IForestRenderBegin(t);
        *outCount = 0;
        INT_PTR rawPtr = itrees->IForestGetRenderNodes(*outCount);
        *outInstances = reinterpret_cast<TForestInstance*>(rawPtr);
        return *outInstances != nullptr && *outCount > 0;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// Convert a Matrix3 to a 16-float row-major array
static void Matrix3To16(const Matrix3& m, float out[16]) {
    Point3 r0 = m.GetRow(0), r1 = m.GetRow(1), r2 = m.GetRow(2), tr = m.GetTrans();
    out[0]=r0.x; out[1]=r0.y; out[2]=r0.z; out[3]=0;
    out[4]=r1.x; out[5]=r1.y; out[6]=r1.z; out[7]=0;
    out[8]=r2.x; out[9]=r2.y; out[10]=r2.z; out[11]=0;
    out[12]=tr.x; out[13]=tr.y; out[14]=tr.z; out[15]=1;
}

// Extract ForestPack instances from a Forest object node.
// Instance TMs are in local coords of the Forest object — multiplied by the node's world TM.
static bool ExtractForestPackInstances(INode* fpNode, TimeValue t,
                                       std::vector<ForestInstanceGroup>& outGroups) {
    if (!IsForestPackAvailable()) return false;
    if (!IsForestPackNode(fpNode)) return false;
    RegisterForestPackEngine();

    ITreesInterface* itrees = nullptr;
    if (!SafeGetForestInterface(fpNode, &itrees)) return false;

    TForestInstance* instances = nullptr;
    int numInstances = 0;
    if (!SafeForestRenderBegin(itrees, t, &instances, &numInstances)) return false;

    // Forest node's world TM — instance TMs are in local coords, need world
    // API says "multiply by the INode TM" — GetNodeTM(), not GetObjTMAfterWSM()
    Matrix3 nodeTM = fpNode->GetNodeTM(t);

    std::unordered_map<uintptr_t, size_t> keyToGroupIdx;

    for (int i = 0; i < numInstances; i++) {
        TForestInstance& fi = instances[i];
        if (!fi.mesh && !fi.node) continue;

        // Group by mesh pointer when available, else by node handle
        uintptr_t groupKey = fi.mesh ? reinterpret_cast<uintptr_t>(fi.mesh)
                                     : static_cast<uintptr_t>(fi.node->GetHandle());
        size_t groupIdx;

        auto it = keyToGroupIdx.find(groupKey);
        if (it != keyToGroupIdx.end()) {
            groupIdx = it->second;
        } else {
            groupIdx = outGroups.size();
            keyToGroupIdx[groupKey] = groupIdx;
            outGroups.emplace_back();
            ForestInstanceGroup& grp = outGroups.back();
            grp.groupKey = groupKey;

            // Extract geometry — prefer fi.mesh (raw Mesh*), fall back to fi.node
            if (fi.mesh) {
                ExtractMeshFromRawMesh(*fi.mesh, grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
            } else if (fi.node) {
                ExtractMesh(fi.node, t, grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
            }

            // Material: per-instance mtl override, source node mtl, or FP node mtl
            grp.mtl = fi.mtl ? fi.mtl : (fi.node ? fi.node->GetMtl() : fpNode->GetMtl());
            grp.mtlNode = fi.node ? fi.node : fpNode;
        }

        ForestInstanceGroup& grp = outGroups[groupIdx];

        // Instance TM (local) * Forest node TM → world TM
        Matrix3 worldTM = fi.tm * nodeTM;
        float xform[16];
        Matrix3To16(worldTM, xform);
        grp.transforms.insert(grp.transforms.end(), xform, xform + 16);
        grp.instanceCount++;
    }

    itrees->IForestClearRenderNodes();
    itrees->IForestRenderEnd(t);
    return !outGroups.empty();
}

// ══════════════════════════════════════════════════════════════
//  RailClone Instance Extraction
// ══════════════════════════════════════════════════════════════

static bool IsRailCloneClassID(const Class_ID& id) {
    return id == TRAIL_CLASS_ID || id == TRAIL_PROXY_CLASS_ID;
}

static bool IsRailCloneNode(INode* node) {
    if (!node) return false;
    Object* base = GetBaseObject(node->GetObjectRef());
    return base && IsRailCloneClassID(base->ClassID());
}

static bool IsRailCloneAvailable() {
    static int cached = -1;
    if (cached < 0) {
        cached = (GetModuleHandleW(L"railclonepro.dlo") != nullptr ||
                  GetModuleHandleW(L"RailClone.dlo") != nullptr ||
                  GetModuleHandleW(L"RailClonePro.dlo") != nullptr) ? 1 : 0;
    }
    return cached == 1;
}

static bool g_rcEngineRegistered = false;
static TRCEngineFeatures g_rcFeatures;

static void RegisterRailCloneEngine() {
    if (g_rcEngineRegistered) return;
    __try {
        IRCStaticInterface* isrc = GetRCStaticInterface();
        if (!isrc) return;
        isrc->IRCRegisterEngine();
        g_rcFeatures.supportNoGeomObjects = false;
        if (isrc->functions.Count() > 2)
            isrc->IRCSetEngineFeatures((INT_PTR)&g_rcFeatures);
        g_rcEngineRegistered = true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
}

static bool SafeGetRCInterface(INode* rcNode, IRCInterface** out) {
    __try {
        Object* base = GetBaseObject(rcNode->GetObjectRef());
        if (!base) return false;
        *out = GetRCInterface(base);
        return *out != nullptr;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// SEH wrappers for RailClone API calls (can't mix __try with C++ objects)
static bool SafeRCRenderBegin(IRCInterface* irc, TimeValue t) {
    __try { irc->IRCRenderBegin(t); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static Mesh** SafeRCGetMeshes(IRCInterface* irc, int* numMeshes) {
    __try { return reinterpret_cast<Mesh**>(irc->IRCGetMeshes(*numMeshes)); }
    __except (EXCEPTION_EXECUTE_HANDLER) { *numMeshes = 0; return nullptr; }
}
static TRCInstance* SafeRCGetInstances(IRCInterface* irc, int* numInstances) {
    __try { return RCGetInstances(irc, g_rcFeatures, *numInstances); }
    __except (EXCEPTION_EXECUTE_HANDLER) { *numInstances = 0; return nullptr; }
}
static void SafeRCRenderEnd(IRCInterface* irc, TimeValue t) {
    __try { irc->IRCClearInstances(); irc->IRCClearMeshes(); irc->IRCRenderEnd(t); }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
}

// Reuses ForestInstanceGroup for output (same structure: mesh + transforms)
static bool ExtractRailCloneInstances(INode* rcNode, TimeValue t,
                                      std::vector<ForestInstanceGroup>& outGroups) {
    if (!IsRailCloneAvailable()) return false;
    if (!IsRailCloneNode(rcNode)) return false;
    RegisterRailCloneEngine();

    IRCInterface* irc = nullptr;
    if (!SafeGetRCInterface(rcNode, &irc)) return false;
    if (!SafeRCRenderBegin(irc, t)) return false;

    // Get unique meshes
    int numMeshes = 0;
    Mesh** pmeshes = SafeRCGetMeshes(irc, &numMeshes);

    // Build mesh pointer → group index map, extract geometry for each unique mesh
    std::unordered_map<uintptr_t, size_t> meshToGroupIdx;
    if (pmeshes && numMeshes > 0) {
        for (int m = 0; m < numMeshes; m++) {
            if (!pmeshes[m]) continue;
            uintptr_t key = reinterpret_cast<uintptr_t>(pmeshes[m]);
            if (meshToGroupIdx.count(key)) continue;
            size_t idx = outGroups.size();
            meshToGroupIdx[key] = idx;
            outGroups.emplace_back();
            ForestInstanceGroup& grp = outGroups.back();
            grp.groupKey = key;
            ExtractMeshFromRawMesh(*pmeshes[m], grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
            // RailClone: all segments use the RC node's material
            grp.mtl = rcNode->GetMtl();
            grp.mtlNode = rcNode;
        }
    }

    // Get instances
    int numInstances = 0;
    TRCInstance* inst = SafeRCGetInstances(irc, &numInstances);

    Matrix3 nodeTM = rcNode->GetNodeTM(t);

    if (inst && numInstances > 0) {
        for (int i = 0; i < numInstances; i++) {
            if (!inst->mesh) {
                inst = RCGetNextInstance(inst, g_rcFeatures);
                continue;
            }
            uintptr_t key = reinterpret_cast<uintptr_t>(inst->mesh);
            auto it = meshToGroupIdx.find(key);
            if (it == meshToGroupIdx.end()) {
                size_t idx = outGroups.size();
                meshToGroupIdx[key] = idx;
                outGroups.emplace_back();
                ForestInstanceGroup& grp = outGroups.back();
                grp.groupKey = key;
                ExtractMeshFromRawMesh(*inst->mesh, grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
                // Per-segment material override (RCv4+), or RC node material
                if (RCisV4(g_rcFeatures)) {
                    TRCInstanceV400* rci4 = static_cast<TRCInstanceV400*>(inst);
                    grp.mtl = rci4->mtl ? rci4->mtl : rcNode->GetMtl();
                } else {
                    grp.mtl = rcNode->GetMtl();
                }
                grp.mtlNode = rcNode;
                it = meshToGroupIdx.find(key);
            }

            ForestInstanceGroup& grp = outGroups[it->second];
            Matrix3 worldTM = inst->tm * nodeTM;
            float xform[16];
            Matrix3To16(worldTM, xform);
            grp.transforms.insert(grp.transforms.end(), xform, xform + 16);
            grp.instanceCount++;

            inst = RCGetNextInstance(inst, g_rcFeatures);
        }
    }

    SafeRCRenderEnd(irc, t);
    return !outGroups.empty();
}

// ══════════════════════════════════════════════════════════════
//  tyFlow Particle Instance Extraction
// ══════════════════════════════════════════════════════════════

#define TYFLOW_CLASS_ID   Class_ID(825370769, 1895152074)

static bool IsTyFlowClassID(const Class_ID& id) {
    return id == TYFLOW_CLASS_ID;
}

static bool IsTyFlowNode(INode* node) {
    if (!node) return false;
    Object* base = GetBaseObject(node->GetObjectRef());
    return base && IsTyFlowClassID(base->ClassID());
}

static bool IsTyFlowAvailable() {
    static int cached = -1;
    if (cached < 0) {
        cached = (GetModuleHandleW(L"tyFlow_2026.dlo") != nullptr ||
                  GetModuleHandleW(L"tyFlow.dlo") != nullptr) ? 1 : 0;
    }
    return cached == 1;
}

// SEH wrappers for tyFlow API
static tyFlow::tyParticleInterface* SafeGetTyInterface(INode* node) {
    __try {
        Object* base = GetBaseObject(node->GetObjectRef());
        if (!base) return nullptr;
        return tyFlow::GetTyParticleInterfaceForced(static_cast<BaseObject*>(base));
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { return nullptr; }
}

// Can't use __try here due to TSTR having a destructor — call directly
static tyFlow::tyVector<tyFlow::tyInstanceInfo>* SafeTyCollectInstances(
    tyFlow::tyParticleInterface* tyObj, INode* node, TimeValue t) {
    return tyObj->CollectInstances(
        node, tyFlow::DataFlags::mesh, t, t, _T("maxjs"));
}

static void SafeTyReleaseInstances(tyFlow::tyParticleInterface* tyObj,
                                   tyFlow::tyVector<tyFlow::tyInstanceInfo>* inst) {
    __try { tyObj->ReleaseInstances(inst); }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
}

static bool ExtractTyFlowInstances(INode* tyNode, TimeValue t,
                                   std::vector<ForestInstanceGroup>& outGroups) {
    if (!IsTyFlowAvailable()) return false;
    if (!IsTyFlowNode(tyNode)) return false;

    tyFlow::tyParticleInterface* tyObj = SafeGetTyInterface(tyNode);
    if (!tyObj) return false;

    tyFlow::tyVector<tyFlow::tyInstanceInfo>* infos =
        SafeTyCollectInstances(tyObj, tyNode, t);
    if (!infos || infos->size() == 0) return false;

    Matrix3 nodeTM = tyNode->GetNodeTM(t);

    std::unordered_map<uintptr_t, size_t> meshToGroupIdx;

    for (size_t g = 0; g < infos->size(); g++) {
        tyFlow::tyInstanceInfo& info = (*infos)[g];
        if (!(info.flags & tyFlow::DataFlags::mesh) || !info.data) continue;

        Mesh* srcMesh = static_cast<Mesh*>(info.data);
        uintptr_t key = reinterpret_cast<uintptr_t>(srcMesh);

        // Extract geometry once per unique mesh
        auto it = meshToGroupIdx.find(key);
        if (it == meshToGroupIdx.end()) {
            size_t idx = outGroups.size();
            meshToGroupIdx[key] = idx;
            outGroups.emplace_back();
            ForestInstanceGroup& grp = outGroups.back();
            grp.groupKey = key;
            ExtractMeshFromRawMesh(*srcMesh, grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
            // tyFlow: use node material (instance overrides handled below)
            grp.mtl = tyNode->GetMtl();
            grp.mtlNode = tyNode;
            it = meshToGroupIdx.find(key);
        }

        ForestInstanceGroup& grp = outGroups[it->second];

        // Each tyInstance has a tyVector<Matrix3> tms — use tms[0] for current frame
        for (size_t i = 0; i < info.instances.size(); i++) {
            tyFlow::tyInstance& inst = info.instances[i];
            if (inst.tms.size() == 0) continue;

            Matrix3 worldTM = inst.tms[0] * nodeTM;
            float xform[16];
            Matrix3To16(worldTM, xform);
            grp.transforms.insert(grp.transforms.end(), xform, xform + 16);
            grp.instanceCount++;
        }

        // Clean up mesh if flagged
        if (info.flags & tyFlow::DataFlags::pluginMustDelete) {
            delete srcMesh;
            info.data = nullptr;
        }
    }

    SafeTyReleaseInstances(tyObj, infos);
    return !outGroups.empty();
}

// ══════════════════════════════════════════════════════════════
//  tyFlow Volume Extraction (smoke/fire)
// ══════════════════════════════════════════════════════════════

struct VolumeData {
    ULONG handle;
    int dimX, dimY, dimZ;           // voxel counts
    float voxelSize[3];             // world-space size per voxel
    float origin[3];                // world origin (first voxel center)
    float transform[16];            // world transform of the volume
    std::vector<float> density;     // flat density array [dimX * dimY * dimZ]
    float stepSize = 1.0f;          // raymarching step size
};

static bool ExtractTyFlowVolumes(INode* tyNode, TimeValue t,
                                 std::vector<VolumeData>& outVolumes) {
    if (!IsTyFlowAvailable()) return false;
    if (!IsTyFlowNode(tyNode)) return false;

    Object* base = GetBaseObject(tyNode->GetObjectRef());
    if (!base) return false;

    // Try v3 first (has step size + fuel color), fall back to v1
    tyFlow::tyVolumeObjectExt_v3* volIf3 = tyFlow::GetTyVolumeInterface_v3(static_cast<BaseObject*>(base));
    tyFlow::tyVolumeObjectExt_v1* volIf = volIf3
        ? static_cast<tyFlow::tyVolumeObjectExt_v1*>(volIf3)
        : tyFlow::GetTyVolumeInterface_v1(static_cast<BaseObject*>(base));
    if (!volIf) return false;

    volIf->UpdateVolumes(t, _T("maxjs"));

    int numVolumes = volIf->NumVolumes();
    if (numVolumes <= 0) {
        volIf->ReleaseVolumes();
        return false;
    }

    float stepSize = volIf3 ? volIf3->GetVolumeRaymarchingStepSize() : 1.0f;

    // For the combined bounding box, all volumes share same dimensions/scale (axiom 1)
    tyFlow::tyVolume_v1* vol0 = volIf->GetVolume(0);
    if (!vol0) { volIf->ReleaseVolumes(); return false; }

    IPoint3 dim = vol0->dimensions;
    if (dim.x <= 0 || dim.y <= 0 || dim.z <= 0) {
        volIf->ReleaseVolumes();
        return false;
    }

    // Compute voxel size from the transform (scale of axes / dimensions)
    Matrix3 tm0 = vol0->transform;
    Point3 axisX = tm0.GetRow(0);
    Point3 axisY = tm0.GetRow(1);
    Point3 axisZ = tm0.GetRow(2);
    float voxelSizeX = axisX.Length() / (float)dim.x;
    float voxelSizeY = axisY.Length() / (float)dim.y;
    float voxelSizeZ = axisZ.Length() / (float)dim.z;

    // For MVP: extract each volume block as a separate VolumeData
    // (JS side will render each as a separate volume)
    for (int vi = 0; vi < numVolumes; vi++) {
        tyFlow::tyVolume_v1* vol = volIf->GetVolume(vi);
        if (!vol) continue;

        VolumeData vd;
        vd.handle = tyNode->GetHandle();
        vd.dimX = dim.x;
        vd.dimY = dim.y;
        vd.dimZ = dim.z;
        vd.voxelSize[0] = voxelSizeX;
        vd.voxelSize[1] = voxelSizeY;
        vd.voxelSize[2] = voxelSizeZ;
        vd.stepSize = stepSize;

        // Volume origin in world space
        Point3 orig = vol->transform.GetTrans();
        vd.origin[0] = orig.x;
        vd.origin[1] = orig.y;
        vd.origin[2] = orig.z;

        Matrix3To16(vol->transform, vd.transform);

        // Extract density voxels
        int totalVoxels = dim.x * dim.y * dim.z;
        vd.density.resize(totalVoxels);

        for (int z = 0; z < dim.z; z++) {
            for (int y = 0; y < dim.y; y++) {
                for (int x = 0; x < dim.x; x++) {
                    Point3 coord((float)x, (float)y, (float)z);
                    float d = vol->GetScalar(coord, tyFlow::tyVolume_v1::density);
                    vd.density[x + y * dim.x + z * dim.x * dim.y] = d;
                }
            }
        }

        outVolumes.push_back(std::move(vd));
    }

    volIf->ReleaseVolumes();
    return !outVolumes.empty();
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

    // ThreeJS Sky (when env map is ThreeJS Sky texmap)
    bool  isSky = false;
    float skyTurbidity  = 10.0f;
    float skyRayleigh   = 3.0f;
    float skyMieCoeff   = 0.005f;
    float skyMieDirG    = 0.7f;
    float skyElevation  = 2.0f;
    float skyAzimuth    = 180.0f;
    float skyExposure   = 0.5f;
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

static std::wstring FindPBString(Mtl* mtl, const MCHAR* name) {
    if (!mtl) return {};
    for (int b = 0; b < mtl->NumParamBlocks(); b++) {
        IParamBlock2* pb = mtl->GetParamBlock(b);
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

static int FindPBInt(Mtl* mtl, const MCHAR* name, int def) {
    if (!mtl) return def;
    for (int b = 0; b < mtl->NumParamBlocks(); b++) {
        IParamBlock2* pb = mtl->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 &&
                (pd.type == TYPE_INT || pd.type == TYPE_BOOL)) {
                return pb->GetInt(pid);
            }
        }
    }
    return def;
}

static void GetEnvironment(EnvData& env) {
    Texmap* envMap = GetCOREInterface()->GetEnvironmentMap();
    if (!envMap) return;

    // Check if env map is ThreeJS Sky
    if (IsThreeJSSkyClassID(envMap->ClassID())) {
        IParamBlock2* pb = envMap->GetParamBlock(0);
        if (pb) {
            env.isSky = true;
            env.skyTurbidity = pb->GetFloat(psky_turbidity);
            env.skyRayleigh  = pb->GetFloat(psky_rayleigh);
            env.skyMieCoeff  = pb->GetFloat(psky_mie_coeff);
            env.skyMieDirG   = pb->GetFloat(psky_mie_dir_g);
            env.skyElevation = pb->GetFloat(psky_elevation);
            env.skyAzimuth   = pb->GetFloat(psky_azimuth);
            env.skyExposure  = pb->GetFloat(psky_exposure);
        }
        return;
    }

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

// ══════════════════════════════════════════════════════════════
//  ThreeJS Fog — read from Rendering > Environment > Atmosphere
// ══════════════════════════════════════════════════════════════

struct FogData {
    bool active = false;
    int  type   = 0;        // 0=Range, 1=Density, 2=Custom
    float r = 0.85f, g = 0.85f, b = 0.9f;
    float opacity    = 1.0f;
    float nearDist   = 10.0f;
    float farDist    = 500.0f;
    float density    = 0.01f;
    float noiseScale = 0.005f;
    float noiseSpeed = 0.2f;
    float height     = 20.0f;
};

static void GetFogData(FogData& fog) {
    fog = FogData{};
    Interface* ip = GetCOREInterface();
    if (!ip) return;

    int numAtmos = ip->NumAtmospheric();
    for (int i = 0; i < numAtmos; i++) {
        Atmospheric* atm = ip->GetAtmospheric(i);
        if (!atm || !IsThreeJSFogClassID(atm->ClassID())) continue;
        if (!atm->Active(ip->GetTime())) continue;

        IParamBlock2* pb = atm->GetParamBlock(0);
        if (!pb) continue;

        fog.active   = true;
        fog.type     = pb->GetInt(pf_type);
        Color c      = pb->GetColor(pf_color);
        fog.r = c.r; fog.g = c.g; fog.b = c.b;
        fog.opacity    = pb->GetFloat(pf_opacity);
        fog.nearDist   = pb->GetFloat(pf_near);
        fog.farDist    = pb->GetFloat(pf_far);
        fog.density    = pb->GetFloat(pf_density);
        fog.noiseScale = pb->GetFloat(pf_noise_scale);
        fog.noiseSpeed = pb->GetFloat(pf_noise_speed);
        fog.height     = pb->GetFloat(pf_height);
        break;  // use first active ThreeJS Fog
    }
}

static void WriteFogJson(std::wostringstream& ss, const FogData& fog) {
    ss << L"\"fog\":{\"active\":" << (fog.active ? L'1' : L'0');
    ss << L",\"type\":" << fog.type;
    ss << L",\"color\":[" << fog.r << L',' << fog.g << L',' << fog.b << L']';
    ss << L",\"opacity\":" << fog.opacity;
    ss << L",\"near\":" << fog.nearDist;
    ss << L",\"far\":" << fog.farDist;
    ss << L",\"density\":" << fog.density;
    ss << L",\"noiseScale\":" << fog.noiseScale;
    ss << L",\"noiseSpeed\":" << fog.noiseSpeed;
    ss << L",\"height\":" << fog.height;
    ss << L'}';
}

// Helper: write full env JSON block (includes sky or HDRI data)
static void WriteEnvJson(std::wostringstream& ss, const EnvData& env,
                         const std::wstring& hdriUrl = {}) {
    ss << L"\"env\":{";
    if (env.isSky) {
        ss << L"\"sky\":{";
        ss << L"\"turbidity\":" << env.skyTurbidity;
        ss << L",\"rayleigh\":" << env.skyRayleigh;
        ss << L",\"mieCoefficient\":" << env.skyMieCoeff;
        ss << L",\"mieDirectionalG\":" << env.skyMieDirG;
        ss << L",\"elevation\":" << env.skyElevation;
        ss << L",\"azimuth\":" << env.skyAzimuth;
        ss << L",\"exposure\":" << env.skyExposure;
        ss << L'}';
    } else {
        if (!hdriUrl.empty()) {
            ss << L"\"hdri\":\"" << EscapeJson(hdriUrl.c_str()) << L"\",";
        }
        ss << L"\"rot\":";
        WriteFloatValue(ss, env.rotation, 0.0f);
        ss << L",\"exp\":";
        WriteFloatValue(ss, env.exposure, 0.0f);
        ss << L",\"gamma\":";
        WriteFloatValue(ss, env.gamma, 1.0f);
        ss << L",\"zup\":" << env.zup;
        ss << L",\"flip\":" << env.flip;
    }
    ss << L'}';
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
    void GeometryChanged(NodeKeyTab& nodes) override;
    void TopologyChanged(NodeKeyTab& nodes) override;

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
    std::unordered_set<ULONG> lightHandles_;
    std::unordered_set<ULONG> splatHandles_;
    std::unordered_set<ULONG> fastDirtyHandles_;
    std::unordered_set<ULONG> visibilityDirtyHandles_;
    std::unordered_map<ULONG, std::array<float, 16>> lastSentTransforms_;
    std::unordered_map<ULONG, uint64_t> mtlHashMap_;   // node handle → material structure hash
    std::unordered_map<ULONG, uint64_t> mtlScalarHashMap_; // node handle → fast-sync scalar hash
    std::unordered_map<ULONG, uint64_t> lightHashMap_; // node handle → light state hash
    std::unordered_map<ULONG, uint64_t> splatHashMap_; // node handle → splat source state hash
    std::unordered_map<ULONG, uint64_t> geoHashMap_;   // node handle → geometry topology hash
    std::unordered_map<ULONG, std::vector<MatGroup>> groupCache_; // cached material groups per node
    std::unordered_map<ULONG, uint64_t> propHashMap_;  // node handle → object properties hash
    std::unordered_set<ULONG> pluginInstHandles_;        // FP/RC/tyFlow node handles for change detection
    std::unordered_map<ULONG, uint64_t> pluginInstHash_; // plugin node → generated-instance dependency hash
    std::map<std::wstring, std::wstring> texDirMap_;    // dir → host
    int texDirCount_ = 0;
    bool lastClayMode_ = false;
    bool lastShadowMode_ = false;
    std::wstring activeWebDir_;
    std::uint64_t activeWebStamp_ = 0;
    std::wstring activeProjectDir_;
    std::uint64_t activeProjectStamp_ = 0;
    bool fastCameraDirty_ = false;
    bool fastFlushPosted_ = false;
    bool haveLastSentCamera_ = false;
    ULONGLONG dirtyStamp_ = 0;   // when dirty_ was last set (for debounce)
    CameraData lastSentCamera_ = {};
    SceneEventNamespace::CallbackKey fastNodeEventCallbackKey_ = 0;
    MaxJSFastNodeEventCallback fastNodeEvents_;
    MaxJSFastRedrawCallback fastRedrawCallback_;
    MaxJSFastTimeChangeCallback fastTimeChangeCallback_;

    // ── JS_Inline hot folder ──────────────────────────
    std::unordered_map<std::wstring, ULONGLONG> inlineFileStamps_;  // filename → last write time
    std::wstring inlineLayersStateSignature_;

    static std::wstring ReadUtf8File(const std::wstring& path) {
        HANDLE hFile = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (hFile == INVALID_HANDLE_VALUE) return {};
        DWORD fileSize = GetFileSize(hFile, nullptr);
        if (fileSize == 0 || fileSize == INVALID_FILE_SIZE) { CloseHandle(hFile); return {}; }
        std::string buf(fileSize, '\0');
        DWORD bytesRead = 0;
        ReadFile(hFile, buf.data(), fileSize, &bytesRead, nullptr);
        CloseHandle(hFile);
        buf.resize(bytesRead);
        return Utf8ToWide(buf);
    }

    static const std::wstring& GetInlineLayerDir() {
        static std::wstring dir;
        if (dir.empty()) {
            wchar_t temp[MAX_PATH];
            GetTempPathW(MAX_PATH, temp);
            dir = std::wstring(temp) + L"maxjs_layers\\";
            CreateDirectoryW(dir.c_str(), nullptr);
        }
        return dir;
    }

    void SendInlineLayersState(bool force = false) {
        if (!webview_ || !jsReady_) return;

        const std::wstring dir = GetInlineLayerDir();
        const std::wstring pattern = dir + L"*";
        std::vector<std::pair<std::wstring, bool>> layers;

        WIN32_FIND_DATAW fd = {};
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind != INVALID_HANDLE_VALUE) {
            do {
                if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;

                std::wstring id;
                bool enabled = false;
                if (!TryParseInlineLayerFileName(fd.cFileName, id, enabled)) continue;
                layers.emplace_back(id, enabled);
            } while (FindNextFileW(hFind, &fd));
            FindClose(hFind);
        }

        std::sort(layers.begin(), layers.end(), [](const auto& a, const auto& b) {
            if (a.first == b.first) return a.second > b.second;
            return a.first < b.first;
        });

        std::wostringstream ss;
        ss << L"{\"type\":\"inline_layers_state\",\"layers\":[";
        bool first = true;
        std::wstring lastId;
        for (const auto& layer : layers) {
            if (!lastId.empty() && layer.first == lastId) continue;
            lastId = layer.first;

            if (!first) ss << L',';
            first = false;
            ss << L"{\"id\":\"" << EscapeJson(layer.first.c_str())
               << L"\",\"name\":\"" << EscapeJson(layer.first.c_str())
               << L"\",\"enabled\":" << (layer.second ? L"true" : L"false") << L'}';
        }
        ss << L"]}";

        const std::wstring payload = ss.str();
        if (!force && payload == inlineLayersStateSignature_) return;
        inlineLayersStateSignature_ = payload;
        webview_->PostWebMessageAsJson(payload.c_str());
    }

    void ScanInlineLayers() {
        if (!webview_ || !jsReady_) return;

        const std::wstring dir = GetInlineLayerDir();
        const std::wstring pattern = dir + L"*";

        // Track which enabled layer files still exist this scan
        std::unordered_set<std::wstring> seenEnabled;

        WIN32_FIND_DATAW fd;
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind != INVALID_HANDLE_VALUE) {
            do {
                if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;

                const std::wstring filename(fd.cFileName);
                std::wstring id;
                bool enabled = false;
                if (!TryParseInlineLayerFileName(filename, id, enabled)) continue;
                if (!enabled) continue;

                seenEnabled.insert(filename);

                // Compute write stamp
                ULONGLONG stamp = ((ULONGLONG)fd.ftLastWriteTime.dwHighDateTime << 32)
                                | fd.ftLastWriteTime.dwLowDateTime;

                auto it = inlineFileStamps_.find(filename);
                if (it != inlineFileStamps_.end() && it->second == stamp) continue;

                // New or modified — inject
                const std::wstring filePath = dir + filename;
                std::wstring code = ReadUtf8File(filePath);
                if (code.empty()) continue;

                std::wostringstream ss;
                ss << L"{\"type\":\"js_inline\",\"action\":\"inject\",\"id\":\""
                   << EscapeJson(id.c_str()) << L"\",\"name\":\""
                   << EscapeJson(id.c_str()) << L"\",\"code\":\""
                   << EscapeJson(code.c_str()) << L"\"}";
                webview_->PostWebMessageAsJson(ss.str().c_str());
                inlineFileStamps_[filename] = stamp;
            } while (FindNextFileW(hFind, &fd));
            FindClose(hFind);
        }

        // Remove layers whose files were deleted
        for (auto it = inlineFileStamps_.begin(); it != inlineFileStamps_.end(); ) {
            if (seenEnabled.find(it->first) == seenEnabled.end()) {
                std::wstring id;
                bool enabled = false;
                if (!TryParseInlineLayerFileName(it->first, id, enabled)) {
                    ++it;
                    continue;
                }
                std::wostringstream ss;
                ss << L"{\"type\":\"js_inline\",\"action\":\"remove\",\"id\":\""
                   << EscapeJson(id.c_str()) << L"\"}";
                webview_->PostWebMessageAsJson(ss.str().c_str());
                it = inlineFileStamps_.erase(it);
            } else {
                ++it;
            }
        }

        SendInlineLayersState();
    }

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
        NormalizeFloatingWindow(true);
        InitWebView2();
        return true;
    }

    void InitWebView2() {
        wchar_t* localAppData = nullptr;
        SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData);
        std::wstring udf = std::wstring(localAppData) + L"\\MaxJS\\WebView2Data";
        CoTaskMemFree(localAppData);

        // Enable WebXR in WebView2
        auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
        options->put_AdditionalBrowserArguments(L"--enable-features=WebXR,WebXRARModule,OpenXR");

        CreateCoreWebView2EnvironmentWithOptions(nullptr, udf.c_str(), options.Get(),
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

        webview_->AddWebResourceRequestedFilter(L"https://maxjs-assets.local/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        webview_->add_WebResourceRequested(
            Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                [this](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                    if (!args || !env_) return S_OK;

                    ComPtr<ICoreWebView2WebResourceRequest> request;
                    if (FAILED(args->get_Request(&request)) || !request) return S_OK;

                    LPWSTR uri = nullptr;
                    if (FAILED(request->get_Uri(&uri)) || !uri) return S_OK;

                    const std::wstring_view prefix = L"https://maxjs-assets.local/";
                    const std::wstring uriView(uri);
                    CoTaskMemFree(uri);
                    if (uriView.rfind(prefix, 0) != 0) return S_OK;

                    std::wstring_view encodedPath = uriView.substr(prefix.size());
                    const size_t queryPos = encodedPath.find_first_of(L"?#");
                    if (queryPos != std::wstring_view::npos) {
                        encodedPath = encodedPath.substr(0, queryPos);
                    }

                    std::wstring decodedPath = UrlDecodePath(std::wstring(encodedPath));
                    std::replace(decodedPath.begin(), decodedPath.end(), L'/', L'\\');
                    const DWORD attrs = GetFileAttributesW(decodedPath.c_str());
                    if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
                        ComPtr<ICoreWebView2WebResourceResponse> response;
                        env_->CreateWebResourceResponse(nullptr, 404, L"Not Found",
                            L"Content-Type: text/plain\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: https://maxjs.local\r\nCross-Origin-Resource-Policy: cross-origin\r\n", &response);
                        args->put_Response(response.Get());
                        return S_OK;
                    }

                    ComPtr<IStream> stream;
                    if (FAILED(SHCreateStreamOnFileEx(decodedPath.c_str(), STGM_READ | STGM_SHARE_DENY_NONE,
                        FILE_ATTRIBUTE_NORMAL, FALSE, nullptr, &stream)) || !stream) {
                        ComPtr<ICoreWebView2WebResourceResponse> response;
                        env_->CreateWebResourceResponse(nullptr, 500, L"Open Failed",
                            L"Content-Type: text/plain\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: https://maxjs.local\r\nCross-Origin-Resource-Policy: cross-origin\r\n", &response);
                        args->put_Response(response.Get());
                        return S_OK;
                    }

                    std::wstring headers = L"Content-Type: ";
                    headers += GetMimeTypeForPath(decodedPath);
                    headers += L"\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: https://maxjs.local\r\nCross-Origin-Resource-Policy: cross-origin\r\n";

                    ComPtr<ICoreWebView2WebResourceResponse> response;
                    if (SUCCEEDED(env_->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), &response)) && response) {
                        args->put_Response(response.Get());
                    }
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
        activeWebDir_ = webDir;
        activeWebStamp_ = GetDirectoryWriteStamp(webDir);
        texDirMap_.clear();

        if (!webDir.empty()) {
            ComPtr<ICoreWebView2_3> wv3;
            webview_->QueryInterface(IID_PPV_ARGS(&wv3));
            if (wv3) {
                wv3->SetVirtualHostNameToFolderMapping(
                    L"maxjs.local", webDir.c_str(),
                    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
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
        std::wstring envWebDir = GetEnvironmentString(L"MAXJS_WEB_DIR");
        if (!envWebDir.empty() && DirectoryExists(envWebDir)) {
            return envWebDir;
        }

#ifdef MAXJS_SOURCE_WEB_DIR
        std::wstring sourceWebDir = Utf8ToWide(MAXJS_SOURCE_WEB_DIR);
        std::replace(sourceWebDir.begin(), sourceWebDir.end(), L'/', L'\\');
        if (DirectoryExists(sourceWebDir)) {
            return sourceWebDir;
        }
#endif

        wchar_t p[MAX_PATH];
        GetModuleFileNameW(hInstance, p, MAX_PATH);
        std::wstring d(p); d = d.substr(0, d.find_last_of(L"\\/"));
        std::wstring w = d + L"\\maxjs_web";
        return DirectoryExists(w) ? w : std::wstring{};
    }

    std::wstring GetProjectDir() {
        std::wstring envProjectDir = GetEnvironmentString(L"MAXJS_PROJECT_DIR");
        if (!envProjectDir.empty()) {
            return envProjectDir;
        }

#ifdef MAXJS_SOURCE_WEB_DIR
        std::wstring sourceWebDir = Utf8ToWide(MAXJS_SOURCE_WEB_DIR);
        std::replace(sourceWebDir.begin(), sourceWebDir.end(), L'/', L'\\');
        const size_t split = sourceWebDir.find_last_of(L"\\/");
        if (split != std::wstring::npos) {
            const std::wstring repoRoot = sourceWebDir.substr(0, split);
            const std::wstring repoProjectDir = repoRoot + L"\\projects\\active";
            if (DirectoryExists(repoProjectDir)) {
                return repoProjectDir;
            }
        }
#endif

        wchar_t p[MAX_PATH];
        GetModuleFileNameW(hInstance, p, MAX_PATH);
        std::wstring d(p); d = d.substr(0, d.find_last_of(L"\\/"));
        return d + L"\\maxjs_projects\\active";
    }

    std::wstring GetProjectManifestPath() {
        return GetProjectDir() + L"\\project.maxjs.json";
    }

    void SendHostActionResult(const std::wstring& action, const std::wstring& requestId,
                              bool ok, const std::wstring& error = {}) {
        if (!webview_) return;

        std::wostringstream ss;
        ss << L"{\"type\":\"host_action_result\",\"action\":\"" << EscapeJson(action.c_str()) << L"\"";
        if (!requestId.empty()) {
            ss << L",\"requestId\":\"" << EscapeJson(requestId.c_str()) << L"\"";
        }
        ss << L",\"ok\":" << (ok ? L"true" : L"false");
        if (!error.empty()) {
            ss << L",\"error\":\"" << EscapeJson(error.c_str()) << L"\"";
        }
        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void SendProjectReload() {
        if (!webview_) return;
        webview_->PostWebMessageAsJson(L"{\"type\":\"project_reload\"}");
    }

    void SendInlineLayerRemove(const std::wstring& id) {
        if (!webview_ || !jsReady_) return;
        std::wostringstream ss;
        ss << L"{\"type\":\"js_inline\",\"action\":\"remove\",\"id\":\""
           << EscapeJson(id.c_str()) << L"\"}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void SendInlineLayerClear() {
        if (!webview_ || !jsReady_) return;
        webview_->PostWebMessageAsJson(L"{\"type\":\"js_inline\",\"action\":\"clear\"}");
    }

    bool SendInlineLayerInject(const std::wstring& id, std::wstring& error) {
        if (!webview_ || !jsReady_) return true;

        const std::wstring fileName = GetInlineLayerFileName(id, true);
        const std::wstring filePath = GetInlineLayerDir() + fileName;
        std::wstring code = ReadUtf8File(filePath);
        if (code.empty()) {
            error = L"Inline layer file is empty or unreadable";
            return false;
        }

        std::wostringstream ss;
        ss << L"{\"type\":\"js_inline\",\"action\":\"inject\",\"id\":\""
           << EscapeJson(id.c_str()) << L"\",\"name\":\""
           << EscapeJson(id.c_str()) << L"\",\"code\":\""
           << EscapeJson(code.c_str()) << L"\"}";
        webview_->PostWebMessageAsJson(ss.str().c_str());

        ULONGLONG stamp = 0;
        if (TryGetFileWriteStamp(filePath, stamp)) {
            inlineFileStamps_[fileName] = stamp;
        } else {
            inlineFileStamps_.erase(fileName);
        }
        return true;
    }

    void SendProjectConfig() {
        if (!webview_) return;

        const std::wstring projectDir = GetProjectDir();
        SHCreateDirectoryExW(nullptr, projectDir.c_str(), nullptr);
        activeProjectDir_ = projectDir;
        activeProjectStamp_ = GetProjectRuntimeWriteStamp(projectDir);
        std::wostringstream ss;
        ss << L"{\"type\":\"project_config\",\"dir\":\""
           << EscapeJson(projectDir.c_str())
           << L"\",\"pollMs\":0}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void ClearWebMappings() {
        if (!webview_) return;

        ComPtr<ICoreWebView2_3> wv3;
        webview_->QueryInterface(IID_PPV_ARGS(&wv3));
        if (!wv3) return;

        wv3->ClearVirtualHostNameToFolderMapping(L"maxjs.local");
        for (const auto& entry : texDirMap_) {
            wv3->ClearVirtualHostNameToFolderMapping(entry.second.c_str());
        }
        texDirMap_.clear();
    }

    bool EnsureDriveMapping(wchar_t drive) {
        if (!webview_) return false;

        const wchar_t normalizedDrive = static_cast<wchar_t>(towlower(drive));
        if (normalizedDrive < L'a' || normalizedDrive > L'z') return false;

        std::wstring driveKey(1, normalizedDrive);
        if (texDirMap_.find(driveKey) != texDirMap_.end()) return true;

        ComPtr<ICoreWebView2_3> wv3;
        webview_->QueryInterface(IID_PPV_ARGS(&wv3));
        if (!wv3) return false;

        const std::wstring host = L"maxjsdrv" + driveKey + L".local";
        const std::wstring root = std::wstring(1, static_cast<wchar_t>(towupper(normalizedDrive))) + L":\\";
        if (FAILED(wv3->SetVirtualHostNameToFolderMapping(
                host.c_str(), root.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW))) {
            return false;
        }

        texDirMap_[driveKey] = host;
        return true;
    }

    void PrepareForWebReload() {
        jsReady_ = false;
        SetDirtyImmediate();
        tickCount_ = 0;
        geoScanCursor_ = 0;
        geomHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        fastDirtyHandles_.clear();
        lastSentTransforms_.clear();
        mtlHashMap_.clear();
        mtlScalarHashMap_.clear();
        lightHashMap_.clear();
        splatHashMap_.clear();
        propHashMap_.clear();
        geoHashMap_.clear();
        groupCache_.clear();
        lastBBoxHash_.clear();
        lastLiveGeomHash_.clear();
        ResetFastPathState(false);
    }

    void ReloadWebContent() {
        if (!webview_) return;
        PrepareForWebReload();
        ClearWebMappings();
        LoadContent();
    }

    void CheckWebContentChanges() {
        if (!webview_ || !jsReady_) return;

        const std::wstring webDir = GetWebDir();
        if (webDir.empty()) return;

        const std::uint64_t nextStamp = GetDirectoryWriteStamp(webDir);
        if (nextStamp == 0) return;

        if (activeWebDir_ != webDir || activeWebStamp_ == 0 || nextStamp != activeWebStamp_) {
            ReloadWebContent();
        }
    }

    void CheckProjectContentChanges() {
        if (!webview_ || !jsReady_) return;

        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) return;
        SHCreateDirectoryExW(nullptr, projectDir.c_str(), nullptr);

        const std::uint64_t nextStamp = GetProjectRuntimeWriteStamp(projectDir);
        if (activeProjectDir_ != projectDir) {
            activeProjectDir_ = projectDir;
            activeProjectStamp_ = nextStamp;
            SendProjectConfig();
            SendProjectReload();
            return;
        }

        if (activeProjectStamp_ == 0) {
            activeProjectStamp_ = nextStamp;
            if (nextStamp != 0) SendProjectReload();
            return;
        }

        if (nextStamp != activeProjectStamp_) {
            activeProjectStamp_ = nextStamp;
            SendProjectReload();
        }
    }

    bool RemoveInlineLayerFile(const std::wstring& id, std::wstring& error) {
        const std::wstring dir = GetInlineLayerDir();
        const std::wstring enabledFileName = GetInlineLayerFileName(id, true);
        const std::wstring disabledFileName = GetInlineLayerFileName(id, false);
        const std::wstring enabledPath = dir + enabledFileName;
        const std::wstring disabledPath = dir + disabledFileName;

        bool found = false;
        if (FileExists(enabledPath)) {
            found = true;
            if (!DeleteFileW(enabledPath.c_str())) {
                error = L"Failed to delete enabled inline layer file";
                return false;
            }
        }
        if (FileExists(disabledPath)) {
            found = true;
            if (!DeleteFileW(disabledPath.c_str())) {
                error = L"Failed to delete disabled inline layer file";
                return false;
            }
        }
        if (!found) {
            error = L"Inline layer file not found";
            return false;
        }

        inlineFileStamps_.erase(enabledFileName);
        SendInlineLayerRemove(id);
        SendInlineLayersState(true);
        return true;
    }

    bool SetInlineLayerEnabled(const std::wstring& id, bool enabled, std::wstring& error) {
        const std::wstring dir = GetInlineLayerDir();
        const std::wstring enabledFileName = GetInlineLayerFileName(id, true);
        const std::wstring disabledFileName = GetInlineLayerFileName(id, false);
        const std::wstring enabledPath = dir + enabledFileName;
        const std::wstring disabledPath = dir + disabledFileName;

        const bool hasEnabled = FileExists(enabledPath);
        const bool hasDisabled = FileExists(disabledPath);
        if (!hasEnabled && !hasDisabled) {
            error = L"Inline layer file not found";
            return false;
        }

        if ((enabled && hasEnabled && !hasDisabled) || (!enabled && hasDisabled && !hasEnabled)) {
            SendInlineLayersState(true);
            return true;
        }

        const std::wstring fromPath = enabled ? disabledPath : enabledPath;
        const std::wstring toPath = enabled ? enabledPath : disabledPath;
        if (!MoveFileExW(fromPath.c_str(), toPath.c_str(), MOVEFILE_REPLACE_EXISTING)) {
            error = enabled
                ? L"Failed to enable inline layer file"
                : L"Failed to disable inline layer file";
            return false;
        }

        inlineFileStamps_.erase(enabledFileName);
        if (jsReady_) {
            if (enabled) {
                if (!SendInlineLayerInject(id, error)) return false;
            } else {
                SendInlineLayerRemove(id);
            }
            SendInlineLayersState(true);
        } else {
            inlineLayersStateSignature_.clear();
        }
        return true;
    }

    bool ClearInlineLayerFiles(std::wstring& error) {
        const std::wstring dir = GetInlineLayerDir();
        const std::wstring pattern = dir + L"*";
        WIN32_FIND_DATAW fd = {};
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind != INVALID_HANDLE_VALUE) {
            do {
                if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
                std::wstring id;
                bool enabled = false;
                if (!TryParseInlineLayerFileName(fd.cFileName, id, enabled)) continue;
                const std::wstring filePath = dir + fd.cFileName;
                if (!DeleteFileW(filePath.c_str())) {
                    error = L"Failed to delete one or more inline layer files";
                    FindClose(hFind);
                    return false;
                }
            } while (FindNextFileW(hFind, &fd));
            FindClose(hFind);
        }

        inlineFileStamps_.clear();
        SendInlineLayerClear();
        SendInlineLayersState(true);
        return true;
    }

    bool WriteProjectManifestContent(const std::wstring& contentBase64, std::wstring& error) {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) {
            error = L"Project directory is empty";
            return false;
        }

        SHCreateDirectoryExW(nullptr, projectDir.c_str(), nullptr);

        std::string decoded;
        if (!DecodeBase64Wide(contentBase64, decoded)) {
            error = L"Invalid base64 manifest payload";
            return false;
        }

        const std::wstring manifestPath = GetProjectManifestPath();
        if (!WriteBinaryFile(manifestPath, decoded)) {
            error = L"Failed to write project manifest";
            return false;
        }

        activeProjectDir_ = projectDir;
        activeProjectStamp_ = GetProjectRuntimeWriteStamp(projectDir);
        SendProjectReload();
        return true;
    }

    // ── Same-origin asset serving via WebResourceRequested ──

    std::wstring MapAssetPath(const std::wstring& path, bool allowDirectory = false) {
        if (path.empty() || path.size() < 3 || path[1] != L':') return {};
        const DWORD attrs = GetFileAttributesW(path.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES) return {};

        const bool isDirectory = (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (isDirectory && !allowDirectory) return {};
        if (!isDirectory && allowDirectory) return {};

        std::wstring normalizedPath = path;
        std::replace(normalizedPath.begin(), normalizedPath.end(), L'\\', L'/');
        if (isDirectory && !normalizedPath.empty() && normalizedPath.back() != L'/')
            normalizedPath.push_back(L'/');
        std::wstring encodedPath = UrlEncodePath(normalizedPath);
        if (encodedPath.empty()) return {};
        return L"https://maxjs-assets.local/" + encodedPath;
    }

    std::wstring MapTexturePath(const std::wstring& filePath) {
        return MapAssetPath(filePath, false);
    }

    // ── Callbacks & sync ─────────────────────────────────────

    bool IsTrackedHandle(ULONG handle) const {
        return geomHandles_.find(handle) != geomHandles_.end()
            || lightHandles_.find(handle) != lightHandles_.end()
            || splatHandles_.find(handle) != splatHandles_.end();
    }

    bool HasTrackedNodes() const {
        return !geomHandles_.empty() || !lightHandles_.empty() || !splatHandles_.empty();
    }

    // Debounced dirty: coalesces rapid-fire notifications (e.g. clone) into one full sync
    static constexpr ULONGLONG DIRTY_DEBOUNCE_MS = 150;

    void SetDirty() {
        if (!dirty_) {
            dirty_ = true;
            dirtyStamp_ = GetTickCount64();
        }
    }

    void SetDirtyImmediate() {
        dirty_ = true;
        dirtyStamp_ = 0;  // bypass debounce — sync on next tick
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

    // Live geometry signature for redraw-driven edit detection
    std::unordered_map<ULONG, uint64_t> lastBBoxHash_;
    std::unordered_map<ULONG, uint64_t> lastLiveGeomHash_;

    // Handles that need geometry re-sent via fast path (not full sync)
    std::unordered_set<ULONG> geoFastDirtyHandles_;
    std::unordered_set<ULONG> materialFastDirtyHandles_;

    void CheckSelectedGeometryLive() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        const int selCount = ip->GetSelNodeCount();
        if (selCount <= 0) return;
        TimeValue t = ip->GetTime();

        bool changed = false;
        for (int i = 0; i < selCount; ++i) {
            INode* node = ip->GetSelNode(i);
            if (!node) continue;
            ULONG handle = node->GetHandle();
            if (!IsTrackedHandle(handle)) continue;

            const uint64_t geomHash = HashNodeGeometryState(node, t);
            auto it = lastLiveGeomHash_.find(handle);
            if (it != lastLiveGeomHash_.end() && it->second == geomHash) continue;
            lastLiveGeomHash_[handle] = geomHash;

            // Geometry changed — send ONLY this mesh via fast path, no full sync
            geoHashMap_.erase(handle);
            geoFastDirtyHandles_.insert(handle);
            fastDirtyHandles_.insert(handle);
            changed = true;
        }
        if (changed) QueueFastFlush();
    }

    void CheckTrackedLightsLive() {
        if (lightHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        bool changed = false;
        for (ULONG handle : lightHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                lightHashMap_.erase(handle);
                continue;
            }

            const uint64_t hash = ComputeLightStateHash(node, t);
            auto it = lightHashMap_.find(handle);
            if (it == lightHashMap_.end()) {
                lightHashMap_[handle] = hash;
                continue;
            }

            if (it->second != hash) {
                it->second = hash;
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        }

        if (changed) QueueFastFlush();
    }

    void CheckTrackedMaterialScalarsLive() {
        if (geomHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        bool changed = false;
        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlScalarHashMap_.erase(handle);
                materialFastDirtyHandles_.erase(handle);
                continue;
            }

            Mtl* rawMtl = node->GetMtl();
            Mtl* multiMtl = FindMultiSubMtl(rawMtl);
            if (multiMtl && multiMtl->NumSubMtls() > 1) continue;

            float col[3] = {0.8f, 0.8f, 0.8f};
            float rough = 0.5f;
            float metal = 0.0f;
            float opac = 1.0f;
            ExtractMaterialScalarPreview(FindSupportedMaterial(rawMtl), node, t, col, rough, metal, opac);

            const uint64_t scalarHash = HashMaterialScalarPreviewValues(col, rough, metal, opac);
            auto it = mtlScalarHashMap_.find(handle);
            if (it == mtlScalarHashMap_.end()) {
                mtlScalarHashMap_[handle] = scalarHash;
                continue;
            }

            if (it->second != scalarHash) {
                it->second = scalarHash;
                materialFastDirtyHandles_.insert(handle);
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        }

        if (changed) QueueFastFlush();
    }

    void RememberSentTransform(ULONG handle, const float* xform) {
        std::array<float, 16> cached = {};
        std::copy(xform, xform + 16, cached.begin());
        lastSentTransforms_[handle] = cached;
    }

    void ResetFastPathState(bool refreshCameraState = false) {
        fastDirtyHandles_.clear();
        visibilityDirtyHandles_.clear();
        materialFastDirtyHandles_.clear();
        fastCameraDirty_ = false;
        fastFlushPosted_ = false;
        if (refreshCameraState) CaptureCurrentCameraState();
        else haveLastSentCamera_ = false;
    }

    bool ShouldBootstrapVisibleNode(INode* node, TimeValue t) const {
        if (!node) return false;
        if (IsForestPackNode(node) || IsRailCloneNode(node) ||
            (IsTyFlowAvailable() && IsTyFlowNode(node))) {
            return true;
        }

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj) return false;
        if (IsThreeJSSplatClassID(os.obj->ClassID())) return true;

        const SClass_ID superClass = os.obj->SuperClassID();
        return superClass == GEOMOBJECT_CLASS_ID || superClass == LIGHT_CLASS_ID
            || superClass == SHAPE_CLASS_ID;
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

    // Geometry position change (deform/vertex edit) — fast path, no full sync
    void MarkGeometryPositionsDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        bool changed = false;
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;
            VisitNodeSubtree(node, [this, &changed](INode* current) {
                const ULONG handle = current->GetHandle();
                if (!IsTrackedHandle(handle)) return;
                geoHashMap_.erase(handle);
                geoFastDirtyHandles_.insert(handle);
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            });
        }
        if (changed) QueueFastFlush();
    }

    // Topology change (add/remove faces/verts) — needs full sync (debounced)
    void MarkGeometryTopologyDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        bool changed = false;
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;
            VisitNodeSubtree(node, [this, &changed](INode* current) {
                const ULONG handle = current->GetHandle();
                if (!IsTrackedHandle(handle)) return;
                geoHashMap_.erase(handle);
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            });
        }
        if (changed) SetDirty();
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

    void MarkTrackedLightTransformsDirty() {
        if (lightHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : lightHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            float xform[16];
            GetTransform16(node, t, xform);

            auto it = lastSentTransforms_.find(handle);
            if (it == lastSentTransforms_.end() || !TransformEquals16(xform, it->second.data())) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        }

        if (changed) QueueFastFlush();
    }

    void MarkTrackedSplatTransformsDirty() {
        if (splatHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : splatHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            float xform[16];
            GetTransform16(node, t, xform);

            auto it = lastSentTransforms_.find(handle);
            if (it == lastSentTransforms_.end() || !TransformEquals16(xform, it->second.data())) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        }

        if (changed) QueueFastFlush();
    }

    void MarkVisibilityNodesDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        Interface* ip = GetCOREInterface();
        const TimeValue t = ip ? ip->GetTime() : 0;
        bool changed = false;
        bool needsFullSync = false;
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;

            VisitNodeSubtree(node, [this, &changed](INode* current) {
                const ULONG handle = current->GetHandle();
                if (IsTrackedHandle(handle)) {
                    if (visibilityDirtyHandles_.insert(handle).second) changed = true;
                    return;
                }
            });

            VisitNodeSubtree(node, [this, t, &needsFullSync](INode* current) {
                if (needsFullSync) return;
                if (IsForestPackNode(current) || IsRailCloneNode(current) ||
                    (IsTyFlowAvailable() && IsTyFlowNode(current))) {
                    needsFullSync = true;
                    return;
                }
                if (IsTrackedHandle(current->GetHandle())) return;
                if (current->IsNodeHidden(TRUE)) return;

                // A newly visible supported scene node may need bootstrap data,
                // but helpers/non-renderables should not escalate visibility edits.
                if (ShouldBootstrapVisibleNode(current, t)) needsFullSync = true;
            });
        }

        if (needsFullSync) SetDirty();
        if (!dirty_ && changed) QueueFastFlush();
    }

    void MarkAllTrackedNodesDirty() {
        if (!HasTrackedNodes()) return;
        fastDirtyHandles_.insert(geomHandles_.begin(), geomHandles_.end());
        fastDirtyHandles_.insert(lightHandles_.begin(), lightHandles_.end());
        fastDirtyHandles_.insert(splatHandles_.begin(), splatHandles_.end());
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
        // Hide/unhide/isolate handled via visibility flag in xform sync — no full rebuild needed

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
        // Hide/unhide handled in xform sync — no notification needed
    }

    void OnWebMessage(const wchar_t* json) {
        std::wstring msg(json);
        std::wstring type;
        ExtractJsonString(msg, L"type", type);

        if (type == L"kill" || msg.find(L"\"kill\"") != std::wstring::npos) {
            RequestPanelKill();
            return;
        }
        if (type == L"refresh" || type == L"reload"
                || msg.find(L"\"refresh\"") != std::wstring::npos
                || msg.find(L"\"reload\"") != std::wstring::npos) {
            ReloadWebContent();
            return;
        }
        if (type == L"project_manifest_write") {
            std::wstring requestId;
            std::wstring contentBase64;
            ExtractJsonString(msg, L"requestId", requestId);
            if (!ExtractJsonString(msg, L"contentBase64", contentBase64)) {
                SendHostActionResult(type, requestId, false, L"Missing contentBase64");
                return;
            }

            std::wstring error;
            const bool ok = WriteProjectManifestContent(contentBase64, error);
            SendHostActionResult(type, requestId, ok, error);
            return;
        }
        if (type == L"inline_layer_remove") {
            std::wstring requestId;
            std::wstring id;
            ExtractJsonString(msg, L"requestId", requestId);
            if (!ExtractJsonString(msg, L"id", id) || id.empty()) {
                SendHostActionResult(type, requestId, false, L"Missing layer id");
                return;
            }

            std::wstring error;
            const bool ok = RemoveInlineLayerFile(id, error);
            SendHostActionResult(type, requestId, ok, error);
            return;
        }
        if (type == L"inline_layer_set_enabled") {
            std::wstring requestId;
            std::wstring id;
            bool enabled = true;
            ExtractJsonString(msg, L"requestId", requestId);
            if (!ExtractJsonString(msg, L"id", id) || id.empty()) {
                SendHostActionResult(type, requestId, false, L"Missing layer id");
                return;
            }
            if (!ExtractJsonBool(msg, L"enabled", enabled)) {
                SendHostActionResult(type, requestId, false, L"Missing enabled flag");
                return;
            }

            std::wstring error;
            const bool ok = SetInlineLayerEnabled(id, enabled, error);
            SendHostActionResult(type, requestId, ok, error);
            return;
        }
        if (type == L"inline_layer_clear") {
            std::wstring requestId;
            ExtractJsonString(msg, L"requestId", requestId);
            std::wstring error;
            const bool ok = ClearInlineLayerFiles(error);
            SendHostActionResult(type, requestId, ok, error);
            return;
        }
        if (type == L"ready" || msg.find(L"\"ready\"") != std::wstring::npos) {
            jsReady_ = true; SetDirtyImmediate();
            mtlHashMap_.clear();
            mtlScalarHashMap_.clear();
            lightHashMap_.clear();
            splatHashMap_.clear();
            propHashMap_.clear();
            geoHashMap_.clear();  // force all geometry to be sent
            inlineFileStamps_.clear();  // re-scan inline layers on reconnect
            inlineLayersStateSignature_.clear();
            lastSentTransforms_.clear();
            lightHandles_.clear();
            splatHandles_.clear();
            geoScanCursor_ = 0;
            ResetFastPathState(false);
            SendProjectConfig();
            ScanInlineLayers();
        }
    }

    void OnTimer() {
        if (!hwnd_ || !IsWindowVisible(hwnd_)) return;
        if (!MaintainWindowState()) return;
        if (!jsReady_ || !webview_) return;
        tickCount_++;

        // Poll env+fog at reduced cadence (~200ms)
        if (tickCount_ % ENV_FOG_POLL_TICKS == 0) PollEnvFog();

        if (dirty_) {
            // Debounce: wait for notifications to settle before expensive full sync
            if (GetTickCount64() - dirtyStamp_ >= DIRTY_DEBOUNCE_MS) {
                dirty_ = false;
                if (useBinary_) SendFullSyncBinary(); else SendFullSync();
            }
        } else {
            if (tickCount_ % 15 == 0) CheckWebContentChanges();
            if (tickCount_ % 15 == 0) CheckProjectContentChanges();
            if (tickCount_ % MATERIAL_DETECT_TICKS == 0) DetectMaterialChanges();
            if (tickCount_ % LIGHT_DETECT_TICKS == 0) DetectPropertyChanges();
            if (tickCount_ % LIGHT_DETECT_TICKS == 0) {
                DetectLightChanges();
                DetectSplatChanges();
            }
            if (tickCount_ % 15 == 0) DetectGeometryChanges();
            if (tickCount_ % 15 == 0) DetectPluginInstanceChanges();
            if (tickCount_ % LIGHT_DETECT_TICKS == 0) PollViewportModes();
            if (tickCount_ % 15 == 0) ScanInlineLayers();
        }
    }

    void PollViewportModes() {
        if (!webview_) return;

        bool clay = IsClayModeActive();
        if (clay != lastClayMode_) {
            lastClayMode_ = clay;
            std::wstring msg = clay
                ? L"{\"type\":\"clay_mode\",\"enabled\":true}"
                : L"{\"type\":\"clay_mode\",\"enabled\":false}";
            webview_->PostWebMessageAsJson(msg.c_str());
        }

        bool shadow = IsNitrousShadowsEnabled();
        if (shadow != lastShadowMode_) {
            lastShadowMode_ = shadow;
            std::wstring msg = shadow
                ? L"{\"type\":\"shadow_mode\",\"enabled\":true}"
                : L"{\"type\":\"shadow_mode\",\"enabled\":false}";
            webview_->PostWebMessageAsJson(msg.c_str());
        }
    }

    // Surgical geometry update — sends ONLY changed mesh data, no metadata for other nodes
    void SendGeometryFastUpdate(const std::unordered_set<ULONG>& handles) {
        if (!webview_) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        if (useBinary_ && env_) {
            webview_->QueryInterface(IID_PPV_ARGS(&wv17));
            env_->QueryInterface(IID_PPV_ARGS(&env12));
        }

        for (ULONG handle : handles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            std::vector<float> verts, uvs, norms;
            std::vector<int> indices;
            std::vector<MatGroup> groups;
            bool isSpline = false;
            if (!ExtractMesh(node, t, verts, uvs, indices, groups, &norms)) {
                ObjectState os = node->EvalWorldState(t);
                if (!os.obj || os.obj->SuperClassID() != SHAPE_CLASS_ID ||
                    !ExtractSpline(node, t, verts, indices)) {
                    continue;
                }
                isSpline = true;
                uvs.clear();
                norms.clear();
            }

            // Update hash so we don't re-send next frame
            uint64_t hash = HashMeshData(verts, indices, uvs);
            geoHashMap_[handle] = hash;

            if (wv17 && env12) {
                size_t totalBytes = verts.size() * 4 + indices.size() * 4 + uvs.size() * 4 + norms.size() * 4;
                if (totalBytes < 4) totalBytes = 4;

                ComPtr<ICoreWebView2SharedBuffer> buf;
                if (FAILED(env12->CreateSharedBuffer(totalBytes, &buf)) || !buf) continue;

                BYTE* ptr = nullptr;
                buf->get_Buffer(&ptr);
                size_t off = 0;
                memcpy(ptr + off, verts.data(), verts.size() * 4); size_t vOff = off; off += verts.size() * 4;
                memcpy(ptr + off, indices.data(), indices.size() * 4); size_t iOff = off; off += indices.size() * 4;
                size_t uvOff = off;
                if (!uvs.empty()) { memcpy(ptr + off, uvs.data(), uvs.size() * 4); off += uvs.size() * 4; }
                size_t nOff = off;
                if (!norms.empty()) { memcpy(ptr + off, norms.data(), norms.size() * 4); off += norms.size() * 4; }

                std::wostringstream ss;
                ss.imbue(std::locale::classic());
                ss << L"{\"type\":\"geo_fast\",\"h\":" << handle;
                if (isSpline) ss << L",\"spline\":true";
                ss << L",\"vOff\":" << vOff << L",\"vN\":" << verts.size();
                ss << L",\"iOff\":" << iOff << L",\"iN\":" << indices.size();
                if (!uvs.empty()) ss << L",\"uvOff\":" << uvOff << L",\"uvN\":" << uvs.size();
                if (!norms.empty()) ss << L",\"nOff\":" << nOff << L",\"nN\":" << norms.size();
                ss << L'}';

                wv17->PostSharedBufferToScript(buf.Get(),
                    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                    ss.str().c_str());
            } else {
                std::wostringstream ss;
                ss.imbue(std::locale::classic());
                ss << L"{\"type\":\"geo_fast\",\"h\":" << handle;
                if (isSpline) ss << L",\"spline\":true";
                ss << L",\"v\":"; WriteFloats(ss, verts.data(), verts.size());
                ss << L",\"i\":"; WriteInts(ss, indices.data(), indices.size());
                if (!uvs.empty()) { ss << L",\"uv\":"; WriteFloats(ss, uvs.data(), uvs.size()); }
                if (!norms.empty()) { ss << L",\"norm\":"; WriteFloats(ss, norms.data(), norms.size()); }
                ss << L'}';
                webview_->PostWebMessageAsJson(ss.str().c_str());
            }
        }
    }

    void FlushFastPath() {
        fastFlushPosted_ = false;

        if (!jsReady_ || !webview_ || dirty_) return;
        if (!hwnd_ || !IsWindowVisible(hwnd_)) return;

        std::vector<ULONG> dirtyHandles;
        dirtyHandles.reserve(fastDirtyHandles_.size());
        for (ULONG handle : fastDirtyHandles_) dirtyHandles.push_back(handle);

        const bool hasDirtyCamera = fastCameraDirty_;

        // Collect geometry-dirty handles before clearing
        std::unordered_set<ULONG> geoDirty;
        geoDirty.swap(geoFastDirtyHandles_);
        std::unordered_set<ULONG> materialDirty;
        materialDirty.swap(materialFastDirtyHandles_);
        std::unordered_set<ULONG> visibilityDirty;
        visibilityDirty.swap(visibilityDirtyHandles_);

        for (ULONG handle : dirtyHandles) visibilityDirty.erase(handle);
        fastDirtyHandles_.clear();
        fastCameraDirty_ = false;

        std::vector<ULONG> combinedNodeHandles = dirtyHandles;
        combinedNodeHandles.reserve(dirtyHandles.size() + visibilityDirty.size());
        for (ULONG handle : visibilityDirty) combinedNodeHandles.push_back(handle);

        const bool hasAnyNodeUpdates = !combinedNodeHandles.empty();
        if (!hasAnyNodeUpdates && !hasDirtyCamera) return;

        bool hasDirtyLights = false;
        bool hasDirtySplats = false;
        for (ULONG handle : combinedNodeHandles) {
            if (lightHandles_.find(handle) != lightHandles_.end()) {
                hasDirtyLights = true;
            }
            if (splatHandles_.find(handle) != splatHandles_.end()) {
                hasDirtySplats = true;
            }
        }

        // Geometry fast path: send ONLY the changed mesh(es), nothing else
        if (!geoDirty.empty()) {
            SendGeometryFastUpdate(geoDirty);
            if (materialDirty.empty() && visibilityDirty.empty() && !hasDirtyCamera && !hasDirtyLights && !hasDirtySplats) {
                return;
            }
        }

        if (!useBinary_ || hasDirtyLights || hasDirtySplats) {
            if (hasAnyNodeUpdates) SendTransformSync(&combinedNodeHandles);
            else SendCameraSync();
            CaptureCurrentCameraState();
            return;
        }

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!wv17 || !env12) {
            if (hasAnyNodeUpdates) SendTransformSync(&combinedNodeHandles);
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
                mtlScalarHashMap_.erase(handle);
                lightHashMap_.erase(handle);
                splatHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                geomHandles_.erase(handle);
                lightHandles_.erase(handle);
                splatHandles_.erase(handle);
                lastSentTransforms_.erase(handle);
                materialFastDirtyHandles_.erase(handle);
                SetDirty();
                continue;
            }

            float xform[16];
            GetTransform16(node, t, xform);
            RememberSentTransform(handle, xform);
            frame.UpdateTransform(static_cast<std::uint32_t>(handle), xform);
            frame.UpdateSelection(static_cast<std::uint32_t>(handle), node->Selected() != 0);
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), !node->IsNodeHidden(TRUE));

            if (materialDirty.find(handle) != materialDirty.end()) {
                float col[3] = {0.8f, 0.8f, 0.8f};
                float rough = 0.5f;
                float metal = 0.0f;
                float opac = 1.0f;

                ExtractMaterialScalarPreview(FindSupportedMaterial(node->GetMtl()), node, t, col, rough, metal, opac);

                Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                if (!(multiMtl && multiMtl->NumSubMtls() > 1)) {
                    frame.UpdateMaterialScalar(static_cast<std::uint32_t>(handle), col, rough, metal, opac);
                }
            }
        }

        for (ULONG handle : visibilityDirty) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;
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
            if (hasAnyNodeUpdates) SendTransformSync(&combinedNodeHandles);
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

    EnvData cachedEnv_;
    FogData cachedFog_;
    std::wstring cachedEnvJson_;   // pre-built JSON fragment
    std::wstring cachedFogJson_;   // pre-built JSON fragment
    std::wstring cachedHdriPath_;  // last HDRI path we mapped
    std::wstring cachedHdriUrl_;   // cached MapTexturePath result
    static constexpr int ENV_FOG_POLL_TICKS = 6;  // ~200ms at 33ms tick

    std::wstring lastEnvFogSig_;   // change-detection signature

    // Poll env+fog at reduced cadence; send standalone message ONLY when changed
    void PollEnvFog() {
        if (!webview_) return;

        EnvData env;
        GetEnvironment(env);
        FogData fog;
        GetFogData(fog);

        // Only re-map HDRI URL when path actually changes (avoids filesystem hit)
        std::wstring hdriUrl;
        if (!env.isSky && !env.hdriPath.empty()) {
            if (env.hdriPath != cachedHdriPath_) {
                cachedHdriPath_ = env.hdriPath;
                cachedHdriUrl_ = MapTexturePath(env.hdriPath);
            }
            hdriUrl = cachedHdriUrl_;
        } else if (env.isSky) {
            cachedHdriPath_.clear();
            cachedHdriUrl_.clear();
        }

        // Build env+fog JSON
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"env_update\",";
        WriteEnvJson(ss, env, hdriUrl);
        ss << L",";
        WriteFogJson(ss, fog);
        ss << L'}';
        std::wstring json = ss.str();

        // Only send if something changed
        if (json == lastEnvFogSig_) return;
        lastEnvFogSig_ = json;
        cachedEnv_ = env;
        cachedFog_ = fog;

        webview_->PostWebMessageAsJson(json.c_str());
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
            if (!HasTrackedNodes()) SendCameraSync();
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
                mtlScalarHashMap_.erase(handle);
                lightHashMap_.erase(handle);
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

                ExtractMaterialScalarPreview(FindSupportedMaterial(node->GetMtl()), node, t, col, rough, metal, opac);

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
            if (!HasTrackedNodes()) SendCameraSync();
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

    uint64_t HashMaterialPBRState(const MaxJSPBR& pbr) {
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        WriteMaterialFull(ss, pbr);
        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    uint64_t ComputeMaterialStateHash(INode* node, TimeValue t) {
        if (!node) return 0;

        std::wostringstream ss;
        ss.imbue(std::locale::classic());

        Mtl* rawMtl = node->GetMtl();
        Mtl* multiMtl = FindMultiSubMtl(rawMtl);
        if (multiMtl && multiMtl->NumSubMtls() > 0) {
            ss << L"{\"multi\":true,\"count\":" << multiMtl->NumSubMtls() << L",\"mats\":[";
            for (int i = 0; i < multiMtl->NumSubMtls(); ++i) {
                if (i) ss << L',';
                MaxJSPBR subPBR;
                ExtractPBRFromMtl(multiMtl->GetSubMtl(i), node, t, subPBR);
                WriteMaterialFull(ss, subPBR);
            }
            ss << L"]}";
        } else {
            MaxJSPBR pbr;
            ExtractPBR(node, t, pbr);
            WriteMaterialFull(ss, pbr);
        }

        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    struct MaterialSyncState {
        uint64_t structureHash = 0;
        uint64_t scalarHash = 0;
        bool canFastSync = false;
    };

    MaterialSyncState ComputeMaterialSyncState(INode* node, TimeValue t) {
        MaterialSyncState state;
        if (!node) return state;

        Mtl* rawMtl = node->GetMtl();
        Mtl* multiMtl = FindMultiSubMtl(rawMtl);
        if (multiMtl && multiMtl->NumSubMtls() > 1) {
            state.structureHash = ComputeMaterialStateHash(node, t);
            state.canFastSync = false;
            return state;
        }

        MaxJSPBR pbr;
        ExtractPBR(node, t, pbr);

        if (pbr.materialModel == L"MaterialXMaterial") {
            state.structureHash = HashMaterialPBRState(pbr);
            state.canFastSync = false;
            return state;
        }

        MaxJSPBR structurePbr = pbr;
        structurePbr.color[0] = 0.8f;
        structurePbr.color[1] = 0.8f;
        structurePbr.color[2] = 0.8f;
        structurePbr.roughness = 0.5f;
        structurePbr.metalness = 0.0f;
        structurePbr.opacity = 1.0f;

        state.structureHash = HashMaterialPBRState(structurePbr);
        state.scalarHash = HashMaterialScalarPreviewValues(
            pbr.color, pbr.roughness, pbr.metalness, pbr.opacity);
        state.canFastSync = true;
        return state;
    }

    uint64_t ComputeLightStateHash(INode* node, TimeValue t) {
        if (!node) return 0;

        std::wostringstream ss;
        ss.imbue(std::locale::classic());

        if (!WriteLightJson(ss, node, t, false, true, false)) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    uint64_t ComputeSplatStateHash(INode* node, TimeValue t) {
        if (!node) return 0;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSSplatClassID(os.obj->ClassID())) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_splat_params);
        const MCHAR* rawPath = pb ? pb->GetStr(ps_splat_file) : nullptr;
        std::wstring mappedPath = rawPath ? MapTexturePath(rawPath) : std::wstring{};

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"v\":" << (node->IsNodeHidden(TRUE) ? L'0' : L'1');
        ss << L",\"url\":\"" << EscapeJson(mappedPath.c_str()) << L"\"}";
        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    // Scalar-only edits stay on the fast path; structural material changes force a full sync.
    void DetectMaterialChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        bool fastChanged = false;

        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                mtlScalarHashMap_.erase(handle);
                materialFastDirtyHandles_.erase(handle);
                continue;
            }

            const MaterialSyncState state = ComputeMaterialSyncState(node, t);

            auto structureIt = mtlHashMap_.find(handle);
            auto scalarIt = mtlScalarHashMap_.find(handle);
            if (structureIt == mtlHashMap_.end() || scalarIt == mtlScalarHashMap_.end()) {
                mtlHashMap_[handle] = state.structureHash;
                mtlScalarHashMap_[handle] = state.scalarHash;
                continue;
            }

            const bool structureChanged = structureIt->second != state.structureHash;
            const bool scalarChanged = scalarIt->second != state.scalarHash;
            if (!structureChanged && !scalarChanged) continue;

            structureIt->second = state.structureHash;
            scalarIt->second = state.scalarHash;

            if (!structureChanged && scalarChanged && state.canFastSync) {
                materialFastDirtyHandles_.insert(handle);
                if (fastDirtyHandles_.insert(handle).second) fastChanged = true;
            } else {
                SetDirty();
                return;
            }
        }

        if (fastChanged) QueueFastFlush();
    }

    void DetectLightChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip || lightHandles_.empty()) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : lightHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                lightHashMap_.erase(handle);
                continue;
            }

            const uint64_t hash = ComputeLightStateHash(node, t);
            auto it = lightHashMap_.find(handle);
            if (it == lightHashMap_.end()) {
                lightHashMap_[handle] = hash;
            } else if (it->second != hash) {
                it->second = hash;
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        }

        if (changed) QueueFastFlush();
    }

    void DetectSplatChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip || splatHandles_.empty()) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : splatHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            const uint64_t hash = ComputeSplatStateHash(node, t);
            auto it = splatHashMap_.find(handle);
            if (it == splatHashMap_.end()) {
                splatHashMap_[handle] = hash;
            } else if (it->second != hash) {
                it->second = hash;
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        }

        if (changed) QueueFastFlush();
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
                uint64_t hash = 0;
                if (TryHashExtractedRenderableGeometry(node, t, hash)) {
                    auto it = geoHashMap_.find(handle);
                    if (it == geoHashMap_.end() || it->second != hash) {
                        SetDirty();
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

    // Detect changes to Forest Pack / RailClone / tyFlow plugin nodes.
    // These generators rebuild instance structure from referenced nodes, so they
    // stay on the conservative full-sync path instead of fast mesh deltas.
    void DetectPluginInstanceChanges() {
        if (pluginInstHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        for (ULONG handle : pluginInstHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;
            const uint64_t stateHash = ComputePluginInstanceStateHash(node, t, ip);

            auto it = pluginInstHash_.find(handle);
            if (it == pluginInstHash_.end()) {
                pluginInstHash_[handle] = stateHash;
            } else if (it->second != stateHash) {
                it->second = stateHash;
                SetDirty();
                return;
            }
        }
    }

    // Detect object property changes — triggers full sync (same pattern as DetectMaterialChanges)
    void DetectPropertyChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            uint64_t h = ComputeNodePropHash(node, t);
            auto it = propHashMap_.find(handle);
            if (it == propHashMap_.end()) {
                propHashMap_[handle] = h;
            } else if (it->second != h) {
                it->second = h;
                SetDirty();
                return;
            }
        }
    }

    // ── Camera JSON fragment ─────────────────────────────────

    void WriteMaterialTextures(std::wostringstream& ss, const MaxJSPBR& pbr) {
        auto hasTransformData = [](const MaxJSPBR::TexTransform& xf) {
            return xf.isUberBitmap ||
                   xf.hasChannelSelect ||
                   xf.isVideo ||
                   xf.invert ||
                   std::fabs(xf.scale - 1.0f) > 1.0e-6f ||
                   std::fabs(xf.tiling[0] - 1.0f) > 1.0e-6f ||
                   std::fabs(xf.tiling[1] - 1.0f) > 1.0e-6f ||
                   std::fabs(xf.offset[0]) > 1.0e-6f ||
                   std::fabs(xf.offset[1]) > 1.0e-6f ||
                   std::fabs(xf.rotate) > 1.0e-6f ||
                   std::fabs(xf.center[0] - 0.5f) > 1.0e-6f ||
                   std::fabs(xf.center[1] - 0.5f) > 1.0e-6f ||
                   xf.realWorld ||
                   _wcsicmp(xf.wrapMode.c_str(), L"periodic") != 0 ||
                   !xf.colorSpace.empty() ||
                   std::fabs(xf.manualGamma - 1.0f) > 1.0e-6f;
        };
        auto writeXf = [&](const wchar_t* key, const MaxJSPBR::TexTransform& xf) {
            if (!hasTransformData(xf)) return;
            ss << L",\"" << key << L"\":{";
            bool wroteField = false;
            ss << L"\"scale\":";
            WriteFloatValue(ss, xf.scale, 1.0f);
            ss << L",\"tiling\":[";
            WriteFloatValue(ss, xf.tiling[0], 1.0f); ss << L',';
            WriteFloatValue(ss, xf.tiling[1], 1.0f); ss << L']';
            ss << L",\"offset\":[";
            WriteFloatValue(ss, xf.offset[0], 0.0f); ss << L',';
            WriteFloatValue(ss, xf.offset[1], 0.0f); ss << L']';
            ss << L",\"rotate\":";
            WriteFloatValue(ss, xf.rotate, 0.0f);
            ss << L",\"center\":[";
            WriteFloatValue(ss, xf.center[0], 0.5f); ss << L',';
            WriteFloatValue(ss, xf.center[1], 0.5f); ss << L']';
            ss << L",\"realWorld\":" << (xf.realWorld ? L"true" : L"false");
            ss << L",\"realWidth\":";
            WriteFloatValue(ss, xf.realWidth, 0.2f);
            ss << L",\"realHeight\":";
            WriteFloatValue(ss, xf.realHeight, 0.2f);
            ss << L",\"wrap\":\"" << EscapeJson(xf.wrapMode.c_str()) << L"\"";
            if (xf.invert)
                ss << L",\"invert\":true";
            if (!xf.colorSpace.empty())
                ss << L",\"colorSpace\":\"" << EscapeJson(xf.colorSpace.c_str()) << L"\"";
            if (std::fabs(xf.manualGamma - 1.0f) > 1.0e-6f) {
                ss << L",\"manualGamma\":";
                WriteFloatValue(ss, xf.manualGamma, 1.0f);
            }
            wroteField = true;
            if (xf.hasChannelSelect) {
                if (wroteField) ss << L',';
                ss << L"\"channel\":";
                ss << xf.outputChannelIndex;
                wroteField = true;
            }
            if (xf.isVideo) {
                if (wroteField) ss << L',';
                ss << L"\"video\":true";
                ss << L",\"loop\":" << (xf.videoLoop ? L"true" : L"false");
                ss << L",\"muted\":" << (xf.videoMuted ? L"true" : L"false");
                ss << L",\"rate\":";
                WriteFloatValue(ss, xf.videoRate, 1.0f);
            }
            ss << L"}";
        };
        auto writeMap = [&](const wchar_t* key, const wchar_t* xfKey, const std::wstring& path, const MaxJSPBR::TexTransform& xf) {
            if (path.empty()) return;
            std::wstring url = MapTexturePath(path);
            if (!url.empty()) {
                ss << L",\"" << key << L"\":\"" << EscapeJson(url.c_str()) << L'"';
                if (xfKey) writeXf(xfKey, xf);
            }
        };
        writeMap(L"map", L"mapXf", pbr.colorMap, pbr.colorMapTransform);
        writeMap(L"gradMap", nullptr, pbr.gradientMap, pbr.gradientMapTransform);
        writeMap(L"roughMap", L"roughMapXf", pbr.roughnessMap, pbr.roughnessMapTransform);
        writeMap(L"metalMap", L"metalMapXf", pbr.metalnessMap, pbr.metalnessMapTransform);
        writeMap(L"normMap", L"normMapXf", pbr.normalMap, pbr.normalMapTransform);
        writeMap(L"bumpMap", L"bumpMapXf", pbr.bumpMap, pbr.bumpMapTransform);
        writeMap(L"dispMap", L"dispMapXf", pbr.displacementMap, pbr.displacementMapTransform);
        writeMap(L"parallaxMap", L"parallaxMapXf", pbr.parallaxMap, pbr.parallaxMapTransform);
        writeMap(L"aoMap", L"aoMapXf", pbr.aoMap, pbr.aoMapTransform);
        writeMap(L"sssMap", L"sssMapXf", pbr.sssColorMap, pbr.sssColorMapTransform);
        writeMap(L"matcapMap", L"matcapMapXf", pbr.matcapMap, pbr.matcapMapTransform);
        writeMap(L"specMap", L"specMapXf", pbr.specularMap, pbr.specularMapTransform);
        writeMap(L"emMap", L"emMapXf", pbr.emissionMap, pbr.emissionMapTransform);
        writeMap(L"lmMap", L"lmMapXf", pbr.lightmapFile, pbr.lightmapTransform);
        writeMap(L"opMap", L"opMapXf", pbr.opacityMap, pbr.opacityMapTransform);
        writeMap(L"transMap", L"transMapXf", pbr.transmissionMap, pbr.transmissionMapTransform);
        writeMap(L"ccMap", L"ccMapXf", pbr.clearcoatMap, pbr.clearcoatMapTransform);
        writeMap(L"ccRoughMap", L"ccRoughMapXf", pbr.clearcoatRoughnessMap, pbr.clearcoatRoughnessMapTransform);
        writeMap(L"ccNormMap", L"ccNormMapXf", pbr.clearcoatNormalMap, pbr.clearcoatNormalMapTransform);
    }

    void WriteMaterialFull(std::wostringstream& ss, const MaxJSPBR& pbr) {
        auto parentDirectoryOf = [](const std::wstring& path) -> std::wstring {
            const size_t pos = path.find_last_of(L"\\/");
            if (pos == std::wstring::npos) return {};
            return path.substr(0, pos);
        };
        ss << L"{\"name\":\"" << EscapeJson(pbr.mtlName.empty() ? L"default" : pbr.mtlName.c_str()) << L'"';
        ss << L",\"model\":\"" << EscapeJson(pbr.materialModel.c_str()) << L'"';
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
        if (pbr.colorMapStrength < 0.999f || pbr.colorMapStrength > 1.001f) {
            ss << L",\"mapS\":";
            WriteFloatValue(ss, pbr.colorMapStrength, 1.0f);
        }
        if (pbr.roughnessMapStrength < 0.999f || pbr.roughnessMapStrength > 1.001f) {
            ss << L",\"roughMapS\":";
            WriteFloatValue(ss, pbr.roughnessMapStrength, 1.0f);
        }
        if (pbr.metalnessMapStrength < 0.999f || pbr.metalnessMapStrength > 1.001f) {
            ss << L",\"metalMapS\":";
            WriteFloatValue(ss, pbr.metalnessMapStrength, 1.0f);
        }
        ss << L",\"normScl\":";
        WriteFloatValue(ss, pbr.normalScale, 1.0f);
        if (!pbr.bumpMap.empty() || std::fabs(pbr.bumpScale - 1.0f) > 1.0e-6f) {
            ss << L",\"bumpS\":";
            WriteFloatValue(ss, pbr.bumpScale, 1.0f);
        }
        if (!pbr.displacementMap.empty() || std::fabs(pbr.displacementScale) > 1.0e-6f || std::fabs(pbr.displacementBias) > 1.0e-6f) {
            ss << L",\"dispS\":";
            WriteFloatValue(ss, pbr.displacementScale, 0.0f);
            ss << L",\"dispB\":";
            WriteFloatValue(ss, pbr.displacementBias, 0.0f);
        }
        if (!pbr.parallaxMap.empty() || std::fabs(pbr.parallaxScale) > 1.0e-6f) {
            ss << L",\"parallaxS\":";
            WriteFloatValue(ss, pbr.parallaxScale, 0.0f);
        }
        ss << L",\"aoI\":";
        WriteFloatValue(ss, pbr.aoIntensity, 1.0f);
        ss << L",\"envI\":";
        WriteFloatValue(ss, pbr.envIntensity, 1.0f);
        if (pbr.materialModel == L"MeshPhysicalMaterial") {
            ss << L",\"specularColor\":[";
            WriteFloatValue(ss, pbr.physicalSpecularColor[0], 1.0f); ss << L',';
            WriteFloatValue(ss, pbr.physicalSpecularColor[1], 1.0f); ss << L',';
            WriteFloatValue(ss, pbr.physicalSpecularColor[2], 1.0f); ss << L']';
            ss << L",\"specularIntensity\":";
            WriteFloatValue(ss, pbr.physicalSpecularIntensity, 1.0f);
            ss << L",\"clearcoat\":";
            WriteFloatValue(ss, pbr.clearcoat, 0.0f);
            ss << L",\"clearcoatRoughness\":";
            WriteFloatValue(ss, pbr.clearcoatRoughness, 0.0f);
            ss << L",\"sheen\":";
            WriteFloatValue(ss, pbr.sheen, 0.0f);
            ss << L",\"sheenRoughness\":";
            WriteFloatValue(ss, pbr.sheenRoughness, 1.0f);
            ss << L",\"sheenColor\":[";
            WriteFloatValue(ss, pbr.sheenColor[0], 0.0f); ss << L',';
            WriteFloatValue(ss, pbr.sheenColor[1], 0.0f); ss << L',';
            WriteFloatValue(ss, pbr.sheenColor[2], 0.0f); ss << L']';
            ss << L",\"iridescence\":";
            WriteFloatValue(ss, pbr.iridescence, 0.0f);
            ss << L",\"iridescenceIOR\":";
            WriteFloatValue(ss, pbr.iridescenceIOR, 1.3f);
            ss << L",\"transmission\":";
            WriteFloatValue(ss, pbr.transmission, 0.0f);
            ss << L",\"ior\":";
            WriteFloatValue(ss, pbr.ior, 1.5f);
            ss << L",\"thickness\":";
            WriteFloatValue(ss, pbr.thickness, 0.0f);
            ss << L",\"dispersion\":";
            WriteFloatValue(ss, pbr.dispersion, 0.0f);
            ss << L",\"attenuationColor\":[";
            WriteFloatValue(ss, pbr.attenuationColor[0], 1.0f); ss << L',';
            WriteFloatValue(ss, pbr.attenuationColor[1], 1.0f); ss << L',';
            WriteFloatValue(ss, pbr.attenuationColor[2], 1.0f); ss << L']';
            ss << L",\"attenuationDistance\":";
            WriteFloatValue(ss, pbr.attenuationDistance, 0.0f);
            ss << L",\"anisotropy\":";
            WriteFloatValue(ss, pbr.anisotropy, 0.0f);
        } else if (pbr.materialModel == L"MeshSSSNodeMaterial") {
            ss << L",\"sssColor\":[";
            WriteFloatValue(ss, pbr.sssColor[0], 1.0f); ss << L',';
            WriteFloatValue(ss, pbr.sssColor[1], 1.0f); ss << L',';
            WriteFloatValue(ss, pbr.sssColor[2], 1.0f); ss << L']';
            ss << L",\"sssDistortion\":";
            WriteFloatValue(ss, pbr.sssDistortion, 0.1f);
            ss << L",\"sssAmbient\":";
            WriteFloatValue(ss, pbr.sssAmbient, 0.0f);
            ss << L",\"sssAttenuation\":";
            WriteFloatValue(ss, pbr.sssAttenuation, 0.1f);
            ss << L",\"sssPower\":";
            WriteFloatValue(ss, pbr.sssPower, 2.0f);
            ss << L",\"sssScale\":";
            WriteFloatValue(ss, pbr.sssScale, 10.0f);
        } else if (pbr.materialModel == L"MaterialXMaterial") {
            const std::wstring materialXUrl = MapAssetPath(pbr.materialXFile, false);
            if (!materialXUrl.empty()) {
                ss << L",\"materialXFile\":\"" << EscapeJson(materialXUrl.c_str()) << L"\"";
                const std::wstring baseDir = parentDirectoryOf(pbr.materialXFile);
                const std::wstring baseUrl = MapAssetPath(baseDir, true);
                if (!baseUrl.empty()) {
                    ss << L",\"materialXBase\":\"" << EscapeJson(baseUrl.c_str()) << L"\"";
                }
            }
            if (!pbr.materialXMaterialName.empty()) {
                ss << L",\"materialXName\":\"" << EscapeJson(pbr.materialXMaterialName.c_str()) << L"\"";
            }
            ss << L",\"materialXIndex\":" << std::max(1, pbr.materialXMaterialIndex);
        } else if (pbr.materialModel == L"MeshTSLNodeMaterial" && !pbr.tslCode.empty()) {
            ss << L",\"tslCode\":\"" << EscapeJson(pbr.tslCode.c_str()) << L"\"";
        } else if (IsUtilityMaterialModel(pbr.materialModel)) {
            if (pbr.materialModel == L"MeshBackdropNodeMaterial") {
                ss << L",\"backdropMode\":";
                ss << pbr.backdropMode;
            }
            if (pbr.materialModel == L"MeshDepthMaterial" && pbr.depthPacking != threejs_utility_depth_packing_basic) {
                ss << L",\"depthPacking\":";
                ss << pbr.depthPacking;
            }
            if ((pbr.materialModel == L"MeshLambertMaterial" ||
                 pbr.materialModel == L"MeshMatcapMaterial" ||
                 pbr.materialModel == L"MeshNormalMaterial" ||
                 pbr.materialModel == L"MeshPhongMaterial") &&
                pbr.normalMapType != threejs_utility_normal_tangent) {
                ss << L",\"normalMapType\":";
                ss << pbr.normalMapType;
            }
            if (pbr.materialModel == L"MeshLambertMaterial" || pbr.materialModel == L"MeshPhongMaterial") {
                if (pbr.combine != threejs_utility_combine_multiply) {
                    ss << L",\"combine\":";
                    ss << pbr.combine;
                }
                if (std::fabs(pbr.reflectivity - 1.0f) > 1.0e-6f) {
                    ss << L",\"reflectivity\":";
                    WriteFloatValue(ss, pbr.reflectivity, 1.0f);
                }
                if (std::fabs(pbr.refractionRatio - 0.98f) > 1.0e-6f) {
                    ss << L",\"refractionRatio\":";
                    WriteFloatValue(ss, pbr.refractionRatio, 0.98f);
                }
            }
            if (pbr.materialModel == L"MeshPhongMaterial") {
                ss << L",\"spec\":[";
                WriteFloatValue(ss, pbr.specular[0], 0.0666667f); ss << L',';
                WriteFloatValue(ss, pbr.specular[1], 0.0666667f); ss << L',';
                WriteFloatValue(ss, pbr.specular[2], 0.0666667f); ss << L']';
                ss << L",\"shininess\":";
                WriteFloatValue(ss, pbr.shininess, 30.0f);
            }
            if ((pbr.materialModel == L"MeshLambertMaterial" ||
                 pbr.materialModel == L"MeshMatcapMaterial" ||
                 pbr.materialModel == L"MeshPhongMaterial") &&
                !pbr.fog) {
                ss << L",\"fog\":false";
            }
            if (pbr.flatShading) ss << L",\"flat\":true";
            if (pbr.wireframe) ss << L",\"wireframe\":true";
        }
        if (pbr.emIntensity > 0) {
            ss << L",\"em\":[";
            WriteFloatValue(ss, pbr.emission[0], 0.0f); ss << L',';
            WriteFloatValue(ss, pbr.emission[1], 0.0f); ss << L',';
            WriteFloatValue(ss, pbr.emission[2], 0.0f); ss << L']';
            ss << L",\"emI\":";
            WriteFloatValue(ss, pbr.emIntensity, 0.0f);
        }
        if (pbr.emissiveMapStrength < 0.999f || pbr.emissiveMapStrength > 1.001f) {
            ss << L",\"emMapS\":";
            WriteFloatValue(ss, pbr.emissiveMapStrength, 1.0f);
        }
        if (pbr.opacityMapStrength < 0.999f || pbr.opacityMapStrength > 1.001f) {
            ss << L",\"opMapS\":";
            WriteFloatValue(ss, pbr.opacityMapStrength, 1.0f);
        }
        if (pbr.lightmapIntensity > 0) {
            ss << L",\"lmI\":";
            WriteFloatValue(ss, pbr.lightmapIntensity, 1.0f);
            ss << L",\"lmCh\":" << pbr.lightmapChannel;
        }
        WriteMaterialTextures(ss, pbr);
        ss << L'}';
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

    bool WriteLightJson(std::wostringstream& ss, INode* node, TimeValue t,
                        bool includeHandle = false, bool includeVisibility = false,
                        bool trackHandle = false) {
        if (!node) return false;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSLightClassID(os.obj->ClassID())) return false;

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_light_params);
        if (!pb) return false;

        const ULONG handle = node->GetHandle();
        Matrix3 tm = node->GetObjectTM(t);
        float xform[16];
        GetTransform16(node, t, xform);
        if (trackHandle) {
            lightHandles_.insert(handle);
            RememberSentTransform(handle, xform);
        }

        const Class_ID classId = os.obj->ClassID();
        ThreeJSLightType ltype = GetThreeJSLightTypeFromClassID(classId);
        if (ThreeJSLightClassUsesTypeParam(classId)) {
            int rawType = pb->GetInt(pl_type);
            if (rawType < 0) rawType = 0;
            if (rawType >= kLight_COUNT) rawType = kLight_Directional;
            ltype = static_cast<ThreeJSLightType>(rawType);
        }
        const bool supportsShadows =
            ltype == kLight_Directional || ltype == kLight_Point || ltype == kLight_Spot;
        const double metersPerUnit = GetSystemUnitScale(UNITS_METERS);
        const double pointSpotScale = metersPerUnit > 1.0e-9 ? 1.0 / (metersPerUnit * metersPerUnit) : 1.0;
        Point3 pos = tm.GetTrans();
        Point3 dir = -Normalize(tm.GetRow(1));
        Color c = pb->GetColor(pl_color, t);
        double intensity = pb->GetFloat(pl_intensity, t);
        if (ltype == kLight_Point || ltype == kLight_Spot) intensity *= pointSpotScale;

        ss << L'{';
        bool needsComma = false;
        auto appendComma = [&]() {
            if (needsComma) ss << L',';
            needsComma = true;
        };

        if (includeHandle) {
            appendComma();
            ss << L"\"h\":" << handle;
        }
        if (includeVisibility) {
            appendComma();
            ss << L"\"v\":" << (node->IsNodeHidden(TRUE) ? L'0' : L'1');
        }

        appendComma();
        ss << L"\"type\":" << static_cast<int>(ltype);
        ss << L",\"pos\":[" << pos.x << L',' << pos.y << L',' << pos.z << L']';
        ss << L",\"dir\":[" << dir.x << L',' << dir.y << L',' << dir.z << L']';
        ss << L",\"color\":[" << c.r << L',' << c.g << L',' << c.b << L']';
        ss << L",\"intensity\":" << intensity;

        if (ltype == kLight_Point || ltype == kLight_Spot) {
            ss << L",\"distance\":" << pb->GetFloat(pl_distance, t);
            ss << L",\"decay\":" << pb->GetFloat(pl_decay, t);
        }
        if (ltype == kLight_Spot) {
            ss << L",\"angle\":" << (pb->GetFloat(pl_angle, t) * 3.14159265f / 180.f);
            ss << L",\"penumbra\":" << pb->GetFloat(pl_penumbra, t);
        }
        if (ltype == kLight_RectArea) {
            ss << L",\"width\":" << pb->GetFloat(pl_width, t);
            ss << L",\"height\":" << pb->GetFloat(pl_height, t);
        }
        if (ltype == kLight_Hemisphere) {
            Color gc = pb->GetColor(pl_ground_color, t);
            ss << L",\"groundColor\":[" << gc.r << L',' << gc.g << L',' << gc.b << L']';
        }

        if (supportsShadows && pb->GetInt(pl_cast_shadow)) {
            ss << L",\"castShadow\":true";
            ss << L",\"shadowBias\":" << pb->GetFloat(pl_shadow_bias, t);
            ss << L",\"shadowRadius\":" << pb->GetFloat(pl_shadow_radius, t);
            ss << L",\"shadowMapSize\":" << pb->GetInt(pl_shadow_mapsize);
        }

        const float volContrib = pb->GetFloat(pl_vol_contrib, t);
        if (volContrib != 1.0f) {
            ss << L",\"volContrib\":" << volContrib;
        }

        ss << L'}';
        return true;
    }

    bool WriteSplatJson(std::wostringstream& ss, INode* node, TimeValue t,
                        bool includeHandle = false, bool includeVisibility = false,
                        bool trackHandle = false) {
        if (!node) return false;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSSplatClassID(os.obj->ClassID())) return false;

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_splat_params);
        if (!pb) return false;

        const MCHAR* rawPath = pb->GetStr(ps_splat_file);
        std::wstring url = rawPath ? MapTexturePath(rawPath) : std::wstring{};

        const ULONG handle = node->GetHandle();
        float xform[16];
        GetTransform16(node, t, xform);
        if (trackHandle) {
            splatHandles_.insert(handle);
            RememberSentTransform(handle, xform);
        }

        ss << L'{';
        bool needsComma = false;
        auto appendComma = [&]() {
            if (needsComma) ss << L',';
            needsComma = true;
        };

        if (includeHandle) {
            appendComma();
            ss << L"\"h\":" << handle;
        }

        appendComma();
        ss << L"\"n\":\"" << EscapeJson(node->GetName()) << L'"';

        if (includeVisibility) {
            appendComma();
            ss << L"\"v\":" << (node->IsNodeHidden(TRUE) ? L'0' : L'1');
        }

        appendComma();
        ss << L"\"t\":";
        WriteFloats(ss, xform, 16);

        appendComma();
        ss << L"\"url\":\"" << EscapeJson(url.c_str()) << L"\"";
        ss << L'}';
        return true;
    }

    void WriteLightsJson(std::wostringstream& ss, Interface* ip, TimeValue t,
                         bool includeHandle = false, bool includeVisibility = false,
                         bool trackHandles = false) {
        ss << L"\"lights\":[";
        bool firstLight = true;
        INode* root = ip ? ip->GetRootNode() : nullptr;
        if (root) {
            std::function<void(INode*)> collectLights = [&](INode* parent) {
                for (int i = 0; i < parent->NumberOfChildren(); i++) {
                    INode* node = parent->GetChildNode(i);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE) && !includeVisibility) {
                        collectLights(node);
                        continue;
                    }

                    std::wostringstream lightJson;
                    lightJson.imbue(std::locale::classic());
                    if (WriteLightJson(lightJson, node, t, includeHandle, includeVisibility, trackHandles)) {
                        if (!firstLight) ss << L',';
                        ss << lightJson.str();
                        firstLight = false;
                    }

                    collectLights(node);
                }
            };
            collectLights(root);
        }
        ss << L']';
    }

    void WriteSplatsJson(std::wostringstream& ss, Interface* ip, TimeValue t,
                         bool includeHandle = false, bool includeVisibility = false,
                         bool trackHandles = false) {
        ss << L"\"splats\":[";
        bool firstSplat = true;
        INode* root = ip ? ip->GetRootNode() : nullptr;
        if (root) {
            std::function<void(INode*)> collectSplats = [&](INode* parent) {
                for (int i = 0; i < parent->NumberOfChildren(); i++) {
                    INode* node = parent->GetChildNode(i);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE) && !includeVisibility) {
                        collectSplats(node);
                        continue;
                    }

                    std::wostringstream splatJson;
                    splatJson.imbue(std::locale::classic());
                    if (WriteSplatJson(splatJson, node, t, includeHandle, includeVisibility, trackHandles)) {
                        if (!firstSplat) ss << L',';
                        ss << splatJson.str();
                        firstSplat = false;
                    }

                    collectSplats(node);
                }
            };
            collectSplats(root);
        }
        ss << L']';
    }

    std::uint32_t AllocateFrameId() {
        return nextFrameId_++;
    }

    // Write material JSON for an instance group (handles Multi/Sub safely)
    void WriteInstanceGroupMaterial(std::wostringstream& ss,
                                    const ForestInstanceGroup& grp, TimeValue t) {
        if (!grp.mtl) {
            // No material — wire color fallback
            MaxJSPBR pbr;
            if (grp.mtlNode) GetWireColor3f(grp.mtlNode, pbr.color);
            ss << L",\"mat\":";
            WriteMaterialFull(ss, pbr);
            return;
        }

        Mtl* multiMtl = FindMultiSubMtl(grp.mtl);
        if (multiMtl && multiMtl->NumSubMtls() > 0 && grp.groups.size() > 1) {
            // Multi/Sub: write groups + per-group sub-materials
            ss << L",\"groups\":[";
            for (size_t g = 0; g < grp.groups.size(); g++) {
                if (g) ss << L',';
                ss << L'[' << grp.groups[g].start << L',' << grp.groups[g].count << L',' << g << L']';
            }
            ss << L"],\"mats\":[";
            for (size_t g = 0; g < grp.groups.size(); g++) {
                if (g) ss << L',';
                Mtl* subMtl = GetSubMtlFromMatID(multiMtl, grp.groups[g].matID);
                MaxJSPBR subPBR;
                ExtractPBRFromMtl(subMtl, grp.mtlNode, t, subPBR);
                WriteMaterialFull(ss, subPBR);
            }
            ss << L"]";
        } else {
            // Single material
            MaxJSPBR pbr;
            ExtractPBRFromMtl(grp.mtl, grp.mtlNode, t, pbr);
            ss << L",\"mat\":";
            WriteMaterialFull(ss, pbr);
        }
    }

    // ── Full scene sync ──────────────────────────────────────

    void SendFullSync() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        INode* root = ip->GetRootNode();
        if (!root) return;
        const std::uint32_t frameId = AllocateFrameId();

        std::unordered_set<ULONG> prevGeom = std::move(geomHandles_);
        geomHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        pluginInstHandles_.clear();
        pluginInstHash_.clear();
        lastSentTransforms_.clear();

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"scene\",\"frame\":" << frameId << L",\"nodes\":[";
        bool first = true;
        WriteSceneNodes(root, t, ss, first, prevGeom);
        ss << L"],";

        // Camera
        WriteCameraJson(ss);

        // Environment
        EnvData envData;
        GetEnvironment(envData);
        std::wstring hdriUrl;
        if (!envData.isSky && !envData.hdriPath.empty())
            hdriUrl = MapTexturePath(envData.hdriPath);

        ss << L",";
        WriteEnvJson(ss, envData, hdriUrl);

        FogData fogData;
        GetFogData(fogData);
        ss << L",";
        WriteFogJson(ss, fogData);
        ss << L",";
        WriteLightsJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteSplatsJson(ss, ip, t, true, false, true);

        // ForestPack + RailClone instance groups (GPU instancing)
        {
            std::vector<ForestInstanceGroup> allInstGroups;
            std::function<void(INode*)> collectInstances = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE)) {
                        collectInstances(node);
                        continue;
                    }
                    if (IsForestPackAvailable() && IsForestPackNode(node))
                        ExtractForestPackInstances(node, t, allInstGroups);
                    else if (IsRailCloneAvailable() && IsRailCloneNode(node))
                        ExtractRailCloneInstances(node, t, allInstGroups);
                    else if (IsTyFlowAvailable() && IsTyFlowNode(node))
                        ExtractTyFlowInstances(node, t, allInstGroups);
                    collectInstances(node);
                }
            };
            collectInstances(root);
            if (!allInstGroups.empty()) {
                ss << L",\"forestInstances\":[";
                bool firstGrp = true;
                for (auto& grp : allInstGroups) {
                    if (grp.verts.empty() || grp.transforms.empty()) continue;
                    if (!firstGrp) ss << L',';
                    firstGrp = false;
                    ss << L"{\"src\":" << grp.groupKey;
                    ss << L",\"count\":" << grp.instanceCount;
                    ss << L",\"v\":"; WriteFloats(ss, grp.verts.data(), grp.verts.size());
                    ss << L",\"i\":"; WriteInts(ss, grp.indices.data(), grp.indices.size());
                    if (!grp.uvs.empty()) {
                        ss << L",\"uv\":"; WriteFloats(ss, grp.uvs.data(), grp.uvs.size());
                    }
                    if (!grp.norms.empty()) {
                        ss << L",\"norm\":"; WriteFloats(ss, grp.norms.data(), grp.norms.size());
                    }
                    ss << L",\"xforms\":";
                    WriteFloats(ss, grp.transforms.data(), grp.transforms.size());
                    WriteInstanceGroupMaterial(ss, grp, t);
                    ss << L'}';
                }
                ss << L']';
            }
        }

        // TODO: tyFlow volume rendering (smoke/fire) — disabled pending shader fixes
        if (false && IsTyFlowAvailable()) {
            std::vector<VolumeData> volumes;
            std::function<void(INode*)> collectVolumes = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (IsTyFlowNode(node))
                        ExtractTyFlowVolumes(node, t, volumes);
                    collectVolumes(node);
                }
            };
            collectVolumes(root);
            if (!volumes.empty()) {
                ss << L",\"volumes\":[";
                for (size_t vi = 0; vi < volumes.size(); vi++) {
                    if (vi) ss << L',';
                    auto& vd = volumes[vi];
                    ss << L"{\"h\":" << vd.handle;
                    ss << L",\"dim\":[" << vd.dimX << L',' << vd.dimY << L',' << vd.dimZ << L']';
                    ss << L",\"voxSize\":[";
                    WriteFloats(ss, vd.voxelSize, 3);
                    ss << L"],\"origin\":[";
                    WriteFloats(ss, vd.origin, 3);
                    ss << L"],\"tm\":";
                    WriteFloats(ss, vd.transform, 16);
                    ss << L",\"step\":" << vd.stepSize;
                    ss << L",\"density\":";
                    WriteFloats(ss, vd.density.data(), vd.density.size());
                    ss << L'}';
                }
                ss << L']';
            }
        }

        ss << L'}';

        webview_->PostWebMessageAsJson(ss.str().c_str());
        ResetFastPathState(true);
    }

    void WriteSceneNodes(INode* parent, TimeValue t,
                         std::wostringstream& ss, bool& first,
                         const std::unordered_set<ULONG>& prevGeom) {
        for (int i = 0; i < parent->NumberOfChildren(); i++) {
            INode* node = parent->GetChildNode(i);
            if (!node || node->IsNodeHidden(TRUE)) continue;
            ObjectState os = node->EvalWorldState(t);
            if (os.obj && IsThreeJSSplatClassID(os.obj->ClassID())) {
                WriteSceneNodes(node, t, ss, first, prevGeom);
                continue;
            }
            // Skip Forest Pack / ForestIvy / RailClone / tyFlow — handled via GPU instancing
            if (IsForestPackNode(node) || IsRailCloneNode(node) ||
                (IsTyFlowAvailable() && IsTyFlowNode(node))) {
                pluginInstHandles_.insert(node->GetHandle());
                WriteSceneNodes(node, t, ss, first, prevGeom);
                continue;
            }

            ULONG handle = node->GetHandle();

            // Skip expensive ExtractMesh for previously-tracked nodes with unchanged geometry
            bool skipExtract = false;
            if (prevGeom.count(handle) && geoHashMap_.count(handle)) {
                if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                    Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                    uint64_t validKey = static_cast<uint64_t>(gv.Start()) ^ (static_cast<uint64_t>(gv.End()) << 32);
                    auto bboxIt = lastBBoxHash_.find(handle);
                    if (bboxIt != lastBBoxHash_.end() && bboxIt->second == validKey) {
                        skipExtract = true;
                    }
                    lastBBoxHash_[handle] = validKey;
                }
            }

            if (skipExtract) {
                // Geometry unchanged — send node with transform + material, no geometry data.
                // JS side keeps existing BufferGeometry when v/i fields are absent.
                float xform[16]; GetTransform16(node, t, xform);

                if (!first) ss << L',';
                ss << L"{\"h\":" << handle;
                ss << L",\"n\":\"" << EscapeJson(node->GetName()) << L'"';
                ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
                ss << L",\"props\":{"; WriteNodePropsJson(ss, node, t); ss << L'}';
                ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                RememberSentTransform(handle, xform);

                auto cachedGroups = groupCache_.find(handle);
                Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                if (multiMtl && multiMtl->NumSubMtls() > 0 && cachedGroups != groupCache_.end() && cachedGroups->second.size() > 1) {
                    ss << L",\"groups\":[";
                    for (size_t g = 0; g < cachedGroups->second.size(); g++) {
                        if (g) ss << L',';
                        ss << L'[' << cachedGroups->second[g].start << L',' << cachedGroups->second[g].count << L',' << g << L']';
                    }
                    ss << L"],\"mats\":[";
                    for (size_t g = 0; g < cachedGroups->second.size(); g++) {
                        if (g) ss << L',';
                        Mtl* subMtl = GetSubMtlFromMatID(multiMtl, cachedGroups->second[g].matID);
                        MaxJSPBR subPBR;
                        ExtractPBRFromMtl(subMtl, node, t, subPBR);
                        WriteMaterialFull(ss, subPBR);
                    }
                    ss << L"]";
                } else {
                    MaxJSPBR pbr;
                    ExtractPBR(node, t, pbr);
                    ss << L",\"mat\":";
                    WriteMaterialFull(ss, pbr);
                }

                ss << L'}';
                first = false;
                geomHandles_.insert(handle);
            } else {
                std::vector<float> verts, uvs, norms;
                std::vector<int> indices;
                std::vector<MatGroup> groups;
                bool extracted = ExtractMesh(node, t, verts, uvs, indices, groups, &norms);

                // Spline fallback — extract as line geometry
                bool isSpline = false;
                if (!extracted && os.obj && os.obj->SuperClassID() == SHAPE_CLASS_ID) {
                    extracted = ExtractSpline(node, t, verts, indices);
                    isSpline = extracted;
                }

                if (extracted) {
                    float xform[16]; GetTransform16(node, t, xform);

                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        lastBBoxHash_[handle] = static_cast<uint64_t>(gv.Start()) ^ (static_cast<uint64_t>(gv.End()) << 32);
                    }
                    groupCache_[handle] = groups;

                    if (!first) ss << L',';
                    ss << L"{\"h\":" << handle;
                    ss << L",\"n\":\"" << EscapeJson(node->GetName()) << L'"';
                    ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
                    ss << L",\"props\":{"; WriteNodePropsJson(ss, node, t); ss << L'}';
                    ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                    if (isSpline) ss << L",\"spline\":true";
                    RememberSentTransform(handle, xform);
                    ss << L",\"v\":"; WriteFloats(ss, verts.data(), verts.size());
                    ss << L",\"i\":"; WriteInts(ss, indices.data(), indices.size());
                    if (!uvs.empty()) {
                        ss << L",\"uv\":"; WriteFloats(ss, uvs.data(), uvs.size());
                    }
                    if (!norms.empty()) {
                        ss << L",\"norm\":"; WriteFloats(ss, norms.data(), norms.size());
                    }

                    if (!isSpline) {
                        // Multi/Sub material support (meshes only)
                        Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                        if (multiMtl && multiMtl->NumSubMtls() > 0 && groups.size() > 1) {
                            ss << L",\"groups\":[";
                            for (size_t g = 0; g < groups.size(); g++) {
                                if (g) ss << L',';
                                ss << L'[' << groups[g].start << L',' << groups[g].count << L',' << g << L']';
                            }
                            ss << L"],\"mats\":[";
                            for (size_t g = 0; g < groups.size(); g++) {
                                if (g) ss << L',';
                                Mtl* subMtl = GetSubMtlFromMatID(multiMtl, groups[g].matID);
                                MaxJSPBR subPBR;
                                ExtractPBRFromMtl(subMtl, node, t, subPBR);
                                WriteMaterialFull(ss, subPBR);
                            }
                            ss << L"]";
                        } else {
                            MaxJSPBR pbr;
                            ExtractPBR(node, t, pbr);
                            ss << L",\"mat\":";
                            WriteMaterialFull(ss, pbr);
                        }
                    }

                    ss << L'}';
                    first = false;
                    geomHandles_.insert(handle);
                }
            }

            WriteSceneNodes(node, t, ss, first, prevGeom);
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

        // Save previous tracking so we can skip extraction for unchanged nodes
        std::unordered_set<ULONG> prevGeom = std::move(geomHandles_);
        geomHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        pluginInstHandles_.clear();
        pluginInstHash_.clear();
        lastSentTransforms_.clear();

        // Collect all geometry nodes
        struct NodeGeo {
            ULONG handle;
            INode* node;
            std::vector<float> verts, uvs, norms;
            std::vector<int> indices;
            std::vector<MatGroup> groups;
            bool changed;
            bool visible = true;
            bool spline = false;
            size_t vOff, iOff, uvOff, nOff;
            uint64_t objId = 0;      // evaluated Object* — instances share this
            ULONG instOfHandle = 0;  // 0 = owns geometry, else = shares from this handle
        };
        std::vector<NodeGeo> geos;
        size_t totalBytes = 0;

        // Build instance groups via IInstanceMgr — maps each node handle to a canonical "source" handle.
        // All instances of the same object get the same source; only the source extracts geometry.
        std::unordered_map<ULONG, ULONG> instanceSourceMap; // handle → source handle (0 = self)
        {
            IInstanceMgr* imgr = IInstanceMgr::GetInstanceMgr();
            std::unordered_set<ULONG> visited;
            std::function<void(INode*)> buildInstMap = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    ULONG h = node->GetHandle();
                    if (!visited.insert(h).second) { buildInstMap(node); continue; }
                    if (instanceSourceMap.count(h)) { buildInstMap(node); continue; }

                    INodeTab instTab;
                    if (imgr) imgr->GetInstances(*node, instTab);
                    if (instTab.Count() > 1) {
                        // First handle in the group is the source
                        ULONG srcH = instTab[0] ? instTab[0]->GetHandle() : h;
                        for (int i = 0; i < instTab.Count(); i++) {
                            if (!instTab[i]) continue;
                            ULONG ih = instTab[i]->GetHandle();
                            instanceSourceMap[ih] = srcH;
                            visited.insert(ih);
                        }
                    }
                    buildInstMap(node);
                }
            };
            buildInstMap(root);
        }

        // Track which source handle has already been extracted
        std::unordered_set<ULONG> extractedSources;

        std::function<void(INode*)> collect = [&](INode* parent) {
            for (int i = 0; i < parent->NumberOfChildren(); i++) {
                INode* node = parent->GetChildNode(i);
                if (!node) continue;
                ObjectState os = node->EvalWorldState(t);
                if (os.obj && IsThreeJSSplatClassID(os.obj->ClassID())) {
                    collect(node);
                    continue;
                }
                // Skip Forest Pack / ForestIvy / RailClone / tyFlow — handled via GPU instancing
                if (IsForestPackNode(node) || IsRailCloneNode(node) ||
                    (IsTyFlowAvailable() && IsTyFlowNode(node))) {
                    collect(node);
                    continue;
                }
                NodeGeo ng;
                ng.node = node;
                ng.handle = node->GetHandle();
                ng.changed = false;
                ng.visible = !node->IsNodeHidden(TRUE);

                // Instance detection via IInstanceMgr
                auto instIt = instanceSourceMap.find(ng.handle);
                ULONG srcHandle = (instIt != instanceSourceMap.end()) ? instIt->second : 0;
                ng.objId = srcHandle; // used as instance group ID in JSON

                // Skip expensive ExtractMesh for previously-tracked nodes with unchanged geometry.
                bool skipExtract = false;
                if (prevGeom.count(ng.handle) && geoHashMap_.count(ng.handle)) {
                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        uint64_t validKey = static_cast<uint64_t>(gv.Start()) ^ (static_cast<uint64_t>(gv.End()) << 32);
                        auto bboxIt = lastBBoxHash_.find(ng.handle);
                        if (bboxIt != lastBBoxHash_.end() && bboxIt->second == validKey) {
                            skipExtract = true;
                        }
                        lastBBoxHash_[ng.handle] = validKey;
                    }
                }

                // Instance dedup: if another node in this group already extracted, skip
                if (!skipExtract && srcHandle != 0 && srcHandle != ng.handle) {
                    if (extractedSources.count(srcHandle)) {
                        ng.instOfHandle = srcHandle;
                        skipExtract = true;
                    }
                }

                if (skipExtract) {
                    auto gIt = groupCache_.find(ng.handle);
                    if (gIt != groupCache_.end()) ng.groups = gIt->second;
                    if (ng.instOfHandle != 0 && geoHashMap_.count(ng.instOfHandle)) {
                        geoHashMap_[ng.handle] = geoHashMap_[ng.instOfHandle];
                        if (groupCache_.count(ng.instOfHandle))
                            ng.groups = groupCache_[ng.instOfHandle];
                    }
                    geos.push_back(std::move(ng));
                    geomHandles_.insert(node->GetHandle());
                } else {
                    bool extracted = ExtractMesh(node, t, ng.verts, ng.uvs, ng.indices, ng.groups, &ng.norms);
                    if (!extracted && os.obj && os.obj->SuperClassID() == SHAPE_CLASS_ID) {
                        extracted = ExtractSpline(node, t, ng.verts, ng.indices);
                        ng.spline = extracted;
                        if (extracted) {
                            ng.uvs.clear();
                            ng.norms.clear();
                            ng.groups.clear();
                        }
                    }
                    if (!extracted) {
                        collect(node);
                        continue;
                    }

                    uint64_t hash = HashMeshData(ng.verts, ng.indices, ng.uvs);
                    auto it = geoHashMap_.find(ng.handle);
                    ng.changed = (it == geoHashMap_.end() || it->second != hash);
                    geoHashMap_[ng.handle] = hash;
                    groupCache_[ng.handle] = ng.groups;

                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        lastBBoxHash_[ng.handle] = static_cast<uint64_t>(gv.Start()) ^ (static_cast<uint64_t>(gv.End()) << 32);
                    }

                    if (srcHandle != 0) extractedSources.insert(srcHandle);

                    if (ng.changed) {
                        ng.vOff = totalBytes;
                        totalBytes += ng.verts.size() * sizeof(float);
                        ng.iOff = totalBytes;
                        totalBytes += ng.indices.size() * sizeof(int);
                        ng.uvOff = totalBytes;
                        if (!ng.uvs.empty())
                            totalBytes += ng.uvs.size() * sizeof(float);
                        ng.nOff = totalBytes;
                        if (!ng.norms.empty())
                            totalBytes += ng.norms.size() * sizeof(float);
                    }
                    geos.push_back(std::move(ng));
                    geomHandles_.insert(node->GetHandle());
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
        for (auto it = mtlScalarHashMap_.begin(); it != mtlScalarHashMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = mtlScalarHashMap_.erase(it);
            else ++it;
        }
        for (auto it = lightHashMap_.begin(); it != lightHashMap_.end(); ) {
            if (lightHandles_.find(it->first) == lightHandles_.end()) it = lightHashMap_.erase(it);
            else ++it;
        }
        for (auto it = splatHashMap_.begin(); it != splatHashMap_.end(); ) {
            if (splatHandles_.find(it->first) == splatHandles_.end()) it = splatHashMap_.erase(it);
            else ++it;
        }
        for (auto it = groupCache_.begin(); it != groupCache_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = groupCache_.erase(it);
            else ++it;
        }
        for (auto it = lastBBoxHash_.begin(); it != lastBBoxHash_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = lastBBoxHash_.erase(it);
            else ++it;
        }
        for (auto it = lastLiveGeomHash_.begin(); it != lastLiveGeomHash_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = lastLiveGeomHash_.erase(it);
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
            ss << L",\"props\":{"; WriteNodePropsJson(ss, ng.node, t); ss << L'}';
            ss << L",\"vis\":" << (ng.visible ? L'1' : L'0');
            if (ng.objId != 0) ss << L",\"objId\":" << ng.objId;
            if (ng.instOfHandle != 0) ss << L",\"instOf\":" << ng.instOfHandle;
            ss << L",\"t\":"; WriteFloats(ss, xform, 16);
            if (ng.spline) ss << L",\"spline\":true";

            // Geometry: byte offsets into shared buffer (or -1 if unchanged)
            if (ng.changed) {
                memcpy(bufPtr + ng.vOff, ng.verts.data(), ng.verts.size() * sizeof(float));
                memcpy(bufPtr + ng.iOff, ng.indices.data(), ng.indices.size() * sizeof(int));
                if (!ng.uvs.empty())
                    memcpy(bufPtr + ng.uvOff, ng.uvs.data(), ng.uvs.size() * sizeof(float));
                if (!ng.norms.empty())
                    memcpy(bufPtr + ng.nOff, ng.norms.data(), ng.norms.size() * sizeof(float));

                ss << L",\"geo\":{\"vOff\":" << ng.vOff;
                ss << L",\"vN\":" << ng.verts.size();
                ss << L",\"iOff\":" << ng.iOff;
                ss << L",\"iN\":" << ng.indices.size();
                if (!ng.uvs.empty()) {
                    ss << L",\"uvOff\":" << ng.uvOff;
                    ss << L",\"uvN\":" << ng.uvs.size();
                }
                if (!ng.norms.empty()) {
                    ss << L",\"nOff\":" << ng.nOff;
                    ss << L",\"nN\":" << ng.norms.size();
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
        std::wstring hdriUrl;
        if (!envData.isSky && !envData.hdriPath.empty())
            hdriUrl = MapTexturePath(envData.hdriPath);

        ss << L",";
        WriteEnvJson(ss, envData, hdriUrl);
        FogData fogBin;
        GetFogData(fogBin);
        ss << L",";
        WriteFogJson(ss, fogBin);
        ss << L",";
        WriteLightsJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteSplatsJson(ss, ip, t, true, false, true);

        // ForestPack + RailClone instance groups (GPU instancing)
        {
            std::vector<ForestInstanceGroup> allInstGroups;
            std::function<void(INode*)> collectInstances = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE)) {
                        collectInstances(node);
                        continue;
                    }
                    if (IsForestPackAvailable() && IsForestPackNode(node))
                        ExtractForestPackInstances(node, t, allInstGroups);
                    else if (IsRailCloneAvailable() && IsRailCloneNode(node))
                        ExtractRailCloneInstances(node, t, allInstGroups);
                    else if (IsTyFlowAvailable() && IsTyFlowNode(node))
                        ExtractTyFlowInstances(node, t, allInstGroups);
                    collectInstances(node);
                }
            };
            collectInstances(root);

            if (!allInstGroups.empty()) {
                ss << L",\"forestInstances\":[";
                bool firstGrp = true;
                for (auto& grp : allInstGroups) {
                    if (grp.verts.empty() || grp.transforms.empty()) continue;
                    if (!firstGrp) ss << L',';
                    firstGrp = false;

                    ss << L"{\"src\":" << grp.groupKey;
                    ss << L",\"count\":" << grp.instanceCount;
                    ss << L",\"v\":"; WriteFloats(ss, grp.verts.data(), grp.verts.size());
                    ss << L",\"i\":"; WriteInts(ss, grp.indices.data(), grp.indices.size());
                    if (!grp.uvs.empty()) {
                        ss << L",\"uv\":"; WriteFloats(ss, grp.uvs.data(), grp.uvs.size());
                    }
                    if (!grp.norms.empty()) {
                        ss << L",\"norm\":"; WriteFloats(ss, grp.norms.data(), grp.norms.size());
                    }
                    ss << L",\"xforms\":";
                    WriteFloats(ss, grp.transforms.data(), grp.transforms.size());
                    WriteInstanceGroupMaterial(ss, grp, t);
                    ss << L'}';
                }
                ss << L']';
            }
        }

        // TODO: tyFlow volume rendering (smoke/fire) — disabled pending shader fixes
        if (false && IsTyFlowAvailable()) {
            std::vector<VolumeData> volumes;
            std::function<void(INode*)> collectVolumes = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (IsTyFlowNode(node))
                        ExtractTyFlowVolumes(node, t, volumes);
                    collectVolumes(node);
                }
            };
            collectVolumes(root);
            if (!volumes.empty()) {
                ss << L",\"volumes\":[";
                for (size_t vi = 0; vi < volumes.size(); vi++) {
                    if (vi) ss << L',';
                    auto& vd = volumes[vi];
                    ss << L"{\"h\":" << vd.handle;
                    ss << L",\"dim\":[" << vd.dimX << L',' << vd.dimY << L',' << vd.dimZ << L']';
                    ss << L",\"voxSize\":";
                    WriteFloats(ss, vd.voxelSize, 3);
                    ss << L",\"origin\":";
                    WriteFloats(ss, vd.origin, 3);
                    ss << L",\"tm\":";
                    WriteFloats(ss, vd.transform, 16);
                    ss << L",\"step\":" << vd.stepSize;
                    ss << L",\"density\":";
                    WriteFloats(ss, vd.density.data(), vd.density.size());
                    ss << L'}';
                }
                ss << L']';
            }
        }

        ss << L'}';

        wv17->PostSharedBufferToScript(sharedBuf.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            ss.str().c_str());
        ResetFastPathState(true);
    }

    // ── Transform-only sync ──────────────────────────────────

    void SendTransformSync(const std::vector<ULONG>* handles = nullptr) {
        if (!handles && !HasTrackedNodes()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        const std::uint32_t frameId = AllocateFrameId();

        std::vector<ULONG> scratchHandles;
        const std::vector<ULONG>* sourceHandles = handles;
        if (!sourceHandles) {
            scratchHandles.reserve(geomHandles_.size());
            for (ULONG handle : geomHandles_) scratchHandles.push_back(handle);
            sourceHandles = &scratchHandles;
        }

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"xform\",\"frame\":" << frameId << L",\"nodes\":[";
        bool first = true;
        for (ULONG handle : *sourceHandles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                mtlScalarHashMap_.erase(handle);
                lightHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                lastSentTransforms_.erase(handle);
                continue;
            }

            if (geomHandles_.find(handle) == geomHandles_.end()) {
                continue;
            }
            float xform[16]; GetTransform16(node, t, xform);
            RememberSentTransform(handle, xform);

            // Lightweight material scalars (no texture walks)
            float col[3] = {0.8f,0.8f,0.8f};
            float rough = 0.5f, metal = 0.0f, opac = 1.0f;
            Mtl* foundMtl = FindSupportedMaterial(node->GetMtl());
            ExtractMaterialScalarPreview(foundMtl, node, t, col, rough, metal, opac);

            bool visible = !node->IsNodeHidden(TRUE);

            if (!first) ss << L',';
            ss << L"{\"h\":" << handle;
            ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
            ss << L",\"vis\":" << (visible ? L'1' : L'0');
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
        }
        ss << L"],";
        WriteCameraJson(ss);
        ss << L",";
        WriteLightsJson(ss, ip, t, true, true, true);
        ss << L",";
        WriteSplatsJson(ss, ip, t, true, true, true);
        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    // ── ActiveShade capture ─────────────────────────────────

    Bitmap* asTarget_ = nullptr;
    bool asCapturing_ = false;
    HWND originalParent_ = nullptr;
    HWND embeddedViewportHwnd_ = nullptr;
    LONG originalStyle_ = 0;
    RECT originalRect_ = {};
    RECT lastFloatingRect_ = {};
    bool haveLastFloatingRect_ = false;

    bool IsViewportHosted() const {
        return originalParent_ != nullptr && embeddedViewportHwnd_ != nullptr;
    }

    void RequestPanelKill() {
        RequestGlobalPanelKill();
    }

    void RememberFloatingBounds() {
        if (!hwnd_ || IsViewportHosted() || IsIconic(hwnd_)) return;

        RECT rect = {};
        if (!GetWindowRect(hwnd_, &rect)) return;
        if (rect.right <= rect.left || rect.bottom <= rect.top) return;

        lastFloatingRect_ = rect;
        haveLastFloatingRect_ = true;
    }

    void NormalizeFloatingWindow(bool forceRecenter = false) {
        if (!hwnd_ || IsViewportHosted() || !IsWindowVisible(hwnd_) || IsIconic(hwnd_)) return;

        RECT rect = {};
        if (!GetWindowRect(hwnd_, &rect)) return;

        int width = rect.right - rect.left;
        int height = rect.bottom - rect.top;
        if (width < 320 || height < 240) forceRecenter = true;

        HMONITOR monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL);
        if (!monitor) {
            HWND anchor = GetCOREInterface() ? GetCOREInterface()->GetMAXHWnd() : hwnd_;
            monitor = MonitorFromWindow(anchor ? anchor : hwnd_, MONITOR_DEFAULTTOPRIMARY);
            forceRecenter = true;
        }

        MONITORINFO mi = {};
        mi.cbSize = sizeof(mi);
        if (!GetMonitorInfoW(monitor, &mi)) return;

        const RECT work = mi.rcWork;
        const int workWidth = std::max(320, static_cast<int>(work.right - work.left));
        const int workHeight = std::max(240, static_cast<int>(work.bottom - work.top));
        width = std::clamp(width, 320, workWidth);
        height = std::clamp(height, 240, workHeight);

        RECT visible = {};
        if (!IntersectRect(&visible, &rect, &work)) {
            forceRecenter = true;
        }

        int x = rect.left;
        int y = rect.top;
        if (forceRecenter) {
            x = static_cast<int>(work.left) + std::max(0, (workWidth - width) / 2);
            y = static_cast<int>(work.top) + std::max(0, (workHeight - height) / 2);
        } else {
            x = std::clamp(x, static_cast<int>(work.left), static_cast<int>(work.right) - width);
            y = std::clamp(y, static_cast<int>(work.top), static_cast<int>(work.bottom) - height);
        }

        if (x != rect.left || y != rect.top || width != (rect.right - rect.left) || height != (rect.bottom - rect.top)) {
            SetWindowPos(hwnd_, nullptr, x, y, width, height,
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }

        RememberFloatingBounds();
    }

    bool MaintainViewportHost() {
        if (!IsViewportHosted()) return true;
        if (!hwnd_ || !IsWindow(hwnd_) || !IsWindow(embeddedViewportHwnd_)) {
            RequestPanelKill();
            return false;
        }
        if (GetParent(hwnd_) != embeddedViewportHwnd_ || !IsWindowVisible(embeddedViewportHwnd_)) {
            RequestPanelKill();
            return false;
        }

        RECT vpRect = {};
        if (!GetClientRect(embeddedViewportHwnd_, &vpRect)) {
            RequestPanelKill();
            return false;
        }

        const int width = vpRect.right - vpRect.left;
        const int height = vpRect.bottom - vpRect.top;
        if (width < 64 || height < 64) {
            RequestPanelKill();
            return false;
        }

        SetWindowPos(hwnd_, HWND_TOP, 0, 0, width, height,
            SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_SHOWWINDOW);
        Resize();
        return true;
    }

    bool MaintainWindowState() {
        Interface* ip = GetCOREInterface();
        if (IsViewportHosted() && ip && ip->IsViewportMaxed()) {
            RequestPanelKill();
            return false;
        }

        if (IsViewportHosted()) {
            return MaintainViewportHost();
        }

        NormalizeFloatingWindow(false);
        return true;
    }

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
        if (!hwnd_ || !viewportHwnd || !IsWindow(viewportHwnd)) return;

        if (!IsViewportHosted()) {
            RememberFloatingBounds();
            originalParent_ = GetParent(hwnd_);
            originalStyle_ = GetWindowLong(hwnd_, GWL_STYLE);
            GetWindowRect(hwnd_, &originalRect_);
        }
        embeddedViewportHwnd_ = viewportHwnd;

        // Strip window chrome, make it a child of the viewport
        SetWindowLong(hwnd_, GWL_STYLE, WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS);
        SetParent(hwnd_, viewportHwnd);

        // Fill the viewport
        RECT vpRect;
        GetClientRect(viewportHwnd, &vpRect);
        SetWindowPos(hwnd_, HWND_TOP, 0, 0,
            vpRect.right, vpRect.bottom, SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        Resize();
    }

    // Restore to original floating window
    void RestoreFromViewport() {
        if (!hwnd_ || !IsViewportHosted()) return;

        HWND restoreParent = originalParent_;
        if (!restoreParent || !IsWindow(restoreParent)) {
            Interface* ip = GetCOREInterface();
            restoreParent = ip ? ip->GetMAXHWnd() : nullptr;
        }
        if (!restoreParent) return;

        SetParent(hwnd_, restoreParent);
        SetWindowLong(hwnd_, GWL_STYLE, originalStyle_);
        const RECT& restoreRect = haveLastFloatingRect_ ? lastFloatingRect_ : originalRect_;
        SetWindowPos(hwnd_, nullptr,
            restoreRect.left, restoreRect.top,
            restoreRect.right - restoreRect.left,
            restoreRect.bottom - restoreRect.top,
            SWP_NOZORDER | SWP_SHOWWINDOW | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        embeddedViewportHwnd_ = nullptr;
        originalParent_ = nullptr;
        Resize();
        NormalizeFloatingWindow(true);
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
        embeddedViewportHwnd_ = nullptr;
        haveLastFloatingRect_ = false;
        fastDirtyHandles_.clear();
        lastSentTransforms_.clear();
        geomHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        mtlHashMap_.clear();
        lightHashMap_.clear();
        splatHashMap_.clear();
        propHashMap_.clear();
        geoHashMap_.clear();
        groupCache_.clear();
        lastBBoxHash_.clear();
        lastLiveGeomHash_.clear();
        mtlScalarHashMap_.clear();
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
        case WM_SIZE:
            if (p) {
                p->Resize();
                p->RememberFloatingBounds();
            }
            return 0;
        case WM_MOVE:
            if (p) p->RememberFloatingBounds();
            return 0;
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
        case WM_CLOSE:
            RequestGlobalPanelKill();
            return 0;
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
    // Modifier stack changes (add/remove modifier) can change object type
    // (e.g. spline → extruded mesh). Treat as topology change for full rebuild.
    if (owner_) owner_->MarkGeometryTopologyDirty(nodes);
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

void MaxJSFastNodeEventCallback::GeometryChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkGeometryPositionsDirty(nodes);
}

void MaxJSFastNodeEventCallback::TopologyChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkGeometryTopologyDirty(nodes);
}

void MaxJSFastRedrawCallback::proc(Interface*) {
    if (!owner_) return;
    owner_->MarkSelectedTransformsDirty();
    owner_->CheckTrackedMaterialScalarsLive();
    owner_->MarkTrackedLightTransformsDirty();
    owner_->CheckTrackedLightsLive();
    owner_->MarkTrackedSplatTransformsDirty();
    owner_->PollViewportModes();
    owner_->MarkCameraDirtyIfChanged();
    owner_->CheckSelectedGeometryLive();
}

void MaxJSFastTimeChangeCallback::TimeChanged(TimeValue) {
    if (!owner_) return;
    owner_->MarkAllTrackedNodesDirty();
    owner_->MarkCameraDirty();
}

static void OnSceneChanged(void* param, NotifyInfo*) {
    auto* p = static_cast<MaxJSPanel*>(param);
    if (p) p->SetDirty();
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

static void RequestGlobalPanelKill() {
    if (g_helperHwnd && IsWindow(g_helperHwnd)) {
        PostMessage(g_helperHwnd, WM_KILL_PANEL, 0, 0);
        return;
    }
    KillPanel();
}

void TogglePanel() {
    Interface* ip = GetCOREInterface();
    if (g_panel && g_panel->IsViewportHosted() && ip && ip->IsViewportMaxed()) {
        KillPanel();
        return;
    }

    if (!g_panel) {
        g_panel = new MaxJSPanel();
        g_panel->Create(ip ? ip->GetMAXHWnd() : nullptr);
    } else if (g_panel->hwnd_ && IsWindowVisible(g_panel->hwnd_)) {
        ShowWindow(g_panel->hwnd_, SW_HIDE);
    } else if (g_panel->hwnd_) {
        ShowWindow(g_panel->hwnd_, SW_SHOW);
        g_panel->NormalizeFloatingWindow(true);
        g_panel->ReloadWebContent();
    } else {
        g_panel->Create(ip ? ip->GetMAXHWnd() : nullptr);
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
    wchar_t script[4096];
    swprintf_s(script, 4096,
        L"global MaxJS_HWND = %lld\r\n"
        L"fn MaxJS_KillPanel = ( windows.sendMessage MaxJS_HWND %d 0 0 )\r\n"
        L"macroScript MaxJS_Toggle category:\"MaxJS\" tooltip:\"Toggle MaxJS Viewport\" buttonText:\"MaxJS\" (\r\n"
        L"    windows.sendMessage MaxJS_HWND %d 0 0\r\n"
        L")\r\n"
        L"macroScript MaxJS_Kill category:\"MaxJS\" tooltip:\"Kill MaxJS Viewport\" buttonText:\"Kill MaxJS\" (\r\n"
        L"    windows.sendMessage MaxJS_HWND %d 0 0\r\n"
        L")\r\n"
        L"if menuMan != undefined and menuMan.findMenu \"MaxJS\" == undefined do (\r\n"
        L"    local subMenu = menuMan.createMenu \"MaxJS\"\r\n"
        L"    local toggleItem = menuMan.createActionItem \"MaxJS_Toggle\" \"MaxJS\"\r\n"
        L"    local killItem = menuMan.createActionItem \"MaxJS_Kill\" \"MaxJS\"\r\n"
        L"    subMenu.addItem toggleItem -1\r\n"
        L"    subMenu.addItem killItem -1\r\n"
        L"    local mainMenu = menuMan.getMainMenuBar()\r\n"
        L"    local subMenuItem = menuMan.createSubMenuItem \"MaxJS\" subMenu\r\n"
        L"    mainMenu.addItem subMenuItem 0\r\n"
        L"    menuMan.updateMenuBar()\r\n"
        L")\r\n",
        (long long)(intptr_t)g_helperHwnd,
        (int)WM_KILL_PANEL,
        (int)WM_TOGGLE_PANEL,
        (int)WM_KILL_PANEL);
    ExecuteMAXScriptScript(script, MAXScript::ScriptSource::NonEmbedded);
}

static LRESULT CALLBACK HelperWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_TOGGLE_PANEL: TogglePanel(); return 0;
    case WM_KILL_PANEL: KillPanel(); return 0;
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
__declspec(dllexport) int LibNumberClasses()           { return 17; }
__declspec(dllexport) ClassDesc* LibClassDesc(int i) {
    switch (i) {
        case 0: return &maxJSDesc;
        case 1: return GetThreeJSAdvMtlDesc();
        case 2: return GetThreeJSUtilityMtlDesc();
        case 3: return GetThreeJSTSLMtlDesc();
        case 4: return GetThreeJSVideoTexDesc();
        case 5: return GetThreeJSRendererDesc();
        case 6: return GetThreeJSLightLegacyDesc();
        case 7: return GetThreeJSDirectionalLightDesc();
        case 8: return GetThreeJSPointLightDesc();
        case 9: return GetThreeJSSpotLightDesc();
        case 10: return GetThreeJSRectAreaLightDesc();
        case 11: return GetThreeJSHemisphereLightDesc();
        case 12: return GetThreeJSAmbientLightDesc();
        case 13: return GetThreeJSToonDesc();
        case 14: return GetThreeJSSplatDesc();
        case 15: return GetThreeJSFogDesc();
        case 16: return GetThreeJSSkyDesc();
        default: return nullptr;
    }
}
__declspec(dllexport) ULONG LibVersion()               { return VERSION_3DSMAX; }
__declspec(dllexport) int LibInitialize()              { return TRUE; }
__declspec(dllexport) int LibShutdown()                { return TRUE; }
