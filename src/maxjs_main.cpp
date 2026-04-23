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
#include <gencam.h>
#include <Scene/IPhysicalCamera.h>
#include <Scene/IHairModifier.h>
#include <mnmesh.h>
#include <splshape.h>
#include <notify.h>
#include <stdmat.h>
#include <AssetManagement/AssetUser.h>
#include <ISceneEventManager.h>
#include <iInstanceMgr.h>
#include <modstack.h>
#include <Graphics/IViewportViewSetting.h>
#include <Graphics/GraphicsEnums.h>
#include <Materials/TexHandle.h>
#include <RenderingAPI/Translator/BaseTranslators/BaseTranslator_Texmap.h>
#include <maxscript/maxscript.h>
#include "itreesinterface.h"
#include "ircinterface.h"
#include "tyParticleObjectExt.h"
#include "tyVolumeObjectExt.h"
#include "sync_protocol.h"
#include "threejs_material.h"
#include "threejs_lights.h"
#include "threejs_splat.h"
#include "threejs_audio.h"
#include "threejs_toon.h"
#include "threejs_renderer.h"
#include "threejs_fog.h"
#include "threejs_sky.h"
#include "threejs_deform.h"
#include "threejs_gltf.h"
#include <iskin.h>
#include <imorpher.h>

#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <ShlObj.h>
#include <Shlwapi.h>
#include <wincodec.h>
#include <commctrl.h>
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
#include <mutex>
#include <filesystem>
#include <cmath>
#include <cwctype>
#include <locale>
#include <immintrin.h>
#include <ppl.h>

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
void MaxJSNotifyMaterialEdited(ReferenceTarget* target = nullptr);
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

// Best-effort check: does `s` look like a JSON object/array that we can
// splice raw into our stream without breaking the enclosing scene JSON?
// Trims whitespace, requires matching `{}` or `[]` wrappers, counts brace
// depth outside of string literals, and returns false if the content isn't
// balanced. Used to guard user-supplied params blobs (HTML/TSL texmap) so a
// typo in the material editor can't corrupt the entire scene delta.
static bool IsProbablyJsonStructured(const std::wstring& s) {
    size_t i = 0, j = s.size();
    while (i < j && iswspace(s[i])) ++i;
    while (j > i && iswspace(s[j - 1])) --j;
    if (j - i < 2) return false;
    const wchar_t open  = s[i];
    const wchar_t close = s[j - 1];
    if (!((open == L'{' && close == L'}') || (open == L'[' && close == L']'))) return false;
    int depth = 0;
    bool inStr = false;
    bool esc   = false;
    for (size_t k = i; k < j; ++k) {
        const wchar_t c = s[k];
        if (inStr) {
            if (esc) { esc = false; continue; }
            if (c == L'\\') { esc = true; continue; }
            if (c == L'"')  { inStr = false; }
            continue;
        }
        if (c == L'"') { inStr = true; continue; }
        if (c == L'{' || c == L'[') ++depth;
        else if (c == L'}' || c == L']') {
            if (--depth < 0) return false;
        }
    }
    return depth == 0 && !inStr;
}

static std::wstring EscapeJson(const wchar_t* s) {
    if (!s) return {};
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

static std::string WideToUtf8(const std::wstring& s) {
    if (s.empty()) return {};
    int needed = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return {};
    std::string out(static_cast<size_t>(needed), '\0');
    WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), needed, nullptr, nullptr);
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

static bool TryGetCurrentScenePath(std::wstring& outPath) {
    outPath.clear();
    Interface* ip = GetCOREInterface();
    if (!ip) return false;

    const MSTR scenePath = ip->GetCurFilePath();
    if (!scenePath.data() || scenePath.Length() == 0) return false;

    outPath.assign(scenePath.data(), scenePath.Length());
    return !outPath.empty();
}

static std::wstring GetCurrentSceneDir() {
    std::wstring scenePath;
    if (!TryGetCurrentScenePath(scenePath)) return {};

    const size_t split = scenePath.find_last_of(L"\\/");
    if (split == std::wstring::npos) return {};
    return scenePath.substr(0, split);
}

static std::wstring GetCurrentSceneStem() {
    std::wstring scenePath;
    if (!TryGetCurrentScenePath(scenePath)) return L"Scene";

    size_t split = scenePath.find_last_of(L"\\/");
    std::wstring name = (split == std::wstring::npos) ? scenePath : scenePath.substr(split + 1);
    const size_t dot = name.find_last_of(L'.');
    if (dot != std::wstring::npos) name = name.substr(0, dot);
    if (name.empty()) return L"Scene";
    return name;
}

static std::uint64_t FileTimeToUint64(const FILETIME& ft) {
    ULARGE_INTEGER value = {};
    value.LowPart = ft.dwLowDateTime;
    value.HighPart = ft.dwHighDateTime;
    return value.QuadPart;
}

static std::uint64_t GetDirectoryWriteStamp(const std::wstring& dirPath, int depth = 0) {
    // Guard against pathological / symlink-looped project trees.
    if (depth > 32) return 0;
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
            latest = std::max(latest, GetDirectoryWriteStamp(dirPath + L"\\" + findData.cFileName, depth + 1));
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
    if (EndsWithInsensitive(fileName, L"postfx.maxjs.json")) return false;
    const size_t dot = fileName.find_last_of(L'.');
    if (dot == std::wstring::npos) return false;

    std::wstring ext = fileName.substr(dot);
    std::transform(ext.begin(), ext.end(), ext.begin(),
        [](wchar_t ch) { return static_cast<wchar_t>(towlower(ch)); });

    return ext == L".js" || ext == L".mjs" || ext == L".cjs" || ext == L".json"
        || ext == L".html" || ext == L".htm";
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

static std::wstring BuildInlineLayerKey(const std::wstring& id, const std::wstring& folder) {
    if (folder.empty()) return id;
    return folder + L"/" + id;
}

static bool NormalizeInlineLayerFolder(const std::wstring& folder, std::wstring& normalizedOut) {
    normalizedOut.clear();
    std::wstring value = folder;
    std::replace(value.begin(), value.end(), L'/', L'\\');
    while (!value.empty() && (value.front() == L'\\' || value.front() == L'/')) value.erase(0, 1);
    while (!value.empty() && (value.back() == L'\\' || value.back() == L'/')) value.pop_back();
    if (value.empty()) return true;
    if (value.find(L':') != std::wstring::npos) return false;
    if (value.rfind(L"\\\\", 0) == 0) return false;

    std::wstring current;
    bool first = true;
    for (size_t i = 0; i <= value.size(); ++i) {
        const wchar_t ch = (i < value.size()) ? value[i] : L'\\';
        if (ch == L'\\') {
            if (current.empty() || current == L"." || current == L"..") return false;
            if (!first) normalizedOut += L"\\";
            normalizedOut += current;
            current.clear();
            first = false;
            continue;
        }
        current.push_back(ch);
    }
    return !normalizedOut.empty();
}

// Parse leading `NN_` priority prefix from an inline layer id.
// "10_gun" → priority=10, displayNameOut="gun"
// "gun"    → priority=100, displayNameOut="gun"
// Keeps the raw id (with prefix) as the stable identity so renaming the prefix
// is treated as a remount, not a mutation. Display name is what artists read in the UI.
static int ParseInlinePriorityPrefix(const std::wstring& id, std::wstring& displayNameOut) {
    size_t pos = 0;
    while (pos < id.size() && iswdigit(id[pos])) ++pos;
    if (pos > 0 && pos < id.size() && id[pos] == L'_') {
        int priority = 0;
        bool ok = true;
        for (size_t i = 0; i < pos; ++i) {
            priority = priority * 10 + (id[i] - L'0');
            if (priority > 1000000) { ok = false; break; }
        }
        if (ok) {
            displayNameOut = id.substr(pos + 1);
            if (!displayNameOut.empty()) return priority;
        }
    }
    displayNameOut = id;
    return 100;
}

static std::wstring NormalizeWindowsPathForCompare(std::wstring path) {
    std::replace(path.begin(), path.end(), L'/', L'\\');
    while (path.size() > 3 && !path.empty() && path.back() == L'\\') {
        path.pop_back();
    }
    std::transform(path.begin(), path.end(), path.begin(),
        [](wchar_t ch) { return static_cast<wchar_t>(towlower(ch)); });
    return path;
}

static std::uint64_t GetProjectRuntimeWriteStampInternal(const std::wstring& dirPath,
                                                         const std::wstring& excludedDir) {
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
            const std::wstring childPath = dirPath + L"\\" + findData.cFileName;
            if (!excludedDir.empty() &&
                NormalizeWindowsPathForCompare(childPath) == excludedDir) {
                continue;
            }
            latest = std::max(latest, GetProjectRuntimeWriteStampInternal(childPath, excludedDir));
            continue;
        }

        if (IsProjectRuntimeFile(findData.cFileName)) {
            latest = std::max(latest, FileTimeToUint64(findData.ftLastWriteTime));
        }
    } while (FindNextFileW(findHandle, &findData));

    FindClose(findHandle);
    return latest;
}

static std::uint64_t GetProjectRuntimeWriteStamp(const std::wstring& dirPath) {
    return GetProjectRuntimeWriteStampInternal(
        dirPath, NormalizeWindowsPathForCompare(dirPath + L"\\dist"));
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

static bool WriteUtf8File(const std::wstring& path, const std::wstring& text) {
    return WriteBinaryFile(path, WideToUtf8(text));
}

static std::wstring HexU64(uint64_t value) {
    wchar_t buffer[17] = {};
    swprintf_s(buffer, L"%016llx", static_cast<unsigned long long>(value));
    return buffer;
}

static bool RecreateDirectory(const std::wstring& path) {
    if (path.empty()) return false;
    std::error_code ec;
    std::filesystem::remove_all(std::filesystem::path(path), ec);
    ec.clear();
    return std::filesystem::create_directories(std::filesystem::path(path), ec) || DirectoryExists(path);
}

static bool CopyDirectoryRecursive(const std::wstring& src, const std::wstring& dst) {
    if (src.empty() || dst.empty() || !DirectoryExists(src)) return false;
    std::error_code ec;
    const auto srcPath = std::filesystem::path(src);
    const auto dstPath = std::filesystem::path(dst);
    std::filesystem::create_directories(dstPath, ec);
    if (ec) return false;

    for (const auto& entry : std::filesystem::recursive_directory_iterator(srcPath, ec)) {
        if (ec) return false;
        const auto relative = std::filesystem::relative(entry.path(), srcPath, ec);
        if (ec) return false;
        const auto target = dstPath / relative;
        if (entry.is_directory()) {
            std::filesystem::create_directories(target, ec);
            if (ec) return false;
            continue;
        }
        std::filesystem::create_directories(target.parent_path(), ec);
        if (ec) return false;
        std::filesystem::copy_file(entry.path(), target,
            std::filesystem::copy_options::overwrite_existing, ec);
        if (ec) return false;
    }
    return true;
}

static bool CopyFileEnsuringDirectories(const std::wstring& src, const std::wstring& dst) {
    if (!FileExists(src)) return false;
    std::error_code ec;
    const auto dstPath = std::filesystem::path(dst);
    std::filesystem::create_directories(dstPath.parent_path(), ec);
    if (ec) return false;
    return CopyFileW(src.c_str(), dst.c_str(), FALSE) != FALSE;
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

static bool ExtractJsonInt(const std::wstring& json, const wchar_t* key, int& out) {
    const std::wstring needle = std::wstring(L"\"") + key + L"\":";
    size_t pos = json.find(needle);
    if (pos == std::wstring::npos) return false;
    pos += needle.size();
    while (pos < json.size() && iswspace(json[pos])) ++pos;

    size_t start = pos;
    if (pos < json.size() && (json[pos] == L'-' || json[pos] == L'+')) ++pos;
    while (pos < json.size() && iswdigit(json[pos])) ++pos;
    if (pos == start || (pos == start + 1 && (json[start] == L'-' || json[start] == L'+'))) return false;

    try {
        out = std::stoi(json.substr(start, pos - start));
        return true;
    } catch (...) {
        return false;
    }
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
    if (_wcsicmp(ext, L".mp3") == 0) return L"audio/mpeg";
    if (_wcsicmp(ext, L".wav") == 0) return L"audio/wav";
    if (_wcsicmp(ext, L".ogg") == 0) return L"audio/ogg";
    if (_wcsicmp(ext, L".m4a") == 0 || _wcsicmp(ext, L".aac") == 0) return L"audio/aac";
    if (_wcsicmp(ext, L".flac") == 0) return L"audio/flac";
    if (_wcsicmp(ext, L".json") == 0) return L"application/json";
    if (_wcsicmp(ext, L".bin") == 0) return L"application/octet-stream";
    // ES module dynamic import() requires a JavaScript MIME type (not octet-stream).
    if (_wcsicmp(ext, L".js") == 0 || _wcsicmp(ext, L".mjs") == 0 || _wcsicmp(ext, L".cjs") == 0) {
        return L"text/javascript";
    }
    if (_wcsicmp(ext, L".css") == 0) return L"text/css";
    if (_wcsicmp(ext, L".svg") == 0) return L"image/svg+xml";
    if (_wcsicmp(ext, L".wasm") == 0) return L"application/wasm";
    if (_wcsicmp(ext, L".html") == 0 || _wcsicmp(ext, L".htm") == 0) return L"text/html";
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

struct VertexColorAttributeRecord {
    int channel = 0;
    std::string attrName;
    std::vector<float> values;
    size_t off = 0;
};

static std::wstring WidenAscii(const std::string& s) {
    return std::wstring(s.begin(), s.end());
}

static std::string GetVertexColorAttributeName(int channel) {
    if (channel == 0) return "color";
    if (channel == MAP_SHADING) return "maxjs_vc_shading";
    if (channel == MAP_ALPHA) return "maxjs_vc_alpha";
    return "maxjs_vc_" + std::to_string(channel);
}

static bool ShouldAllowVertexColorMapChannel1(INode* node) {
    return node &&
           node->GetVertexColorType() == nvct_map_channel &&
           node->GetVertexColorMapChannel() == 1;
}

static void AppendVertexColorValue(std::vector<float>& dst, const UVVert& value, int channel) {
    if (channel == MAP_ALPHA) {
        dst.push_back(value.x);
        dst.push_back(value.x);
        dst.push_back(value.x);
        dst.push_back(value.x);
        return;
    }

    dst.push_back(value.x);
    dst.push_back(value.y);
    dst.push_back(value.z);
    dst.push_back(1.0f);
}

static UVVert DefaultVertexColorValue(int channel) {
    if (channel == MAP_ALPHA) return UVVert(1.0f, 1.0f, 1.0f);
    return UVVert(0.0f, 0.0f, 0.0f);
}

static void WriteVertexColorAttributesJson(std::wostringstream& ss,
                                           const std::vector<VertexColorAttributeRecord>& attrs) {
    if (attrs.empty()) return;
    ss << L",\"vc\":[";
    for (size_t i = 0; i < attrs.size(); ++i) {
        if (i) ss << L',';
        const VertexColorAttributeRecord& attr = attrs[i];
        ss << L"{\"ch\":" << attr.channel;
        ss << L",\"name\":\"" << EscapeJson(WidenAscii(attr.attrName).c_str()) << L'"';
        ss << L",\"itemSize\":4";
        ss << L",\"v\":";
        WriteFloats(ss, attr.values.data(), attr.values.size());
        ss << L'}';
    }
    ss << L']';
}

static void WriteVertexColorOffsetsJson(std::wostringstream& ss,
                                        const std::vector<VertexColorAttributeRecord>& attrs) {
    if (attrs.empty()) return;
    ss << L",\"vc\":[";
    for (size_t i = 0; i < attrs.size(); ++i) {
        if (i) ss << L',';
        const VertexColorAttributeRecord& attr = attrs[i];
        ss << L"{\"ch\":" << attr.channel;
        ss << L",\"name\":\"" << EscapeJson(WidenAscii(attr.attrName).c_str()) << L'"';
        ss << L",\"itemSize\":4";
        ss << L",\"off\":" << attr.off;
        ss << L",\"n\":" << attr.values.size();
        ss << L'}';
    }
    ss << L']';
}

static uint64_t HashFNV1a(const void* data, size_t bytes, uint64_t seed = 1469598103934665603ULL) {
    const unsigned char* p = static_cast<const unsigned char*>(data);
    uint64_t h = seed;
    // SSE: process 16 bytes at a time for large buffers
    // Fold 128-bit chunks into the hash via XOR + multiply cascade
    size_t i = 0;
    if (bytes >= 32) {
        for (; i + 15 < bytes; i += 16) {
            uint64_t lo, hi;
            memcpy(&lo, p + i, 8);
            memcpy(&hi, p + i + 8, 8);
            h ^= lo;
            h *= 1099511628211ULL;
            h ^= hi;
            h *= 1099511628211ULL;
        }
    }
    for (; i < bytes; i++) {
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
                             const std::vector<float>& uvs,
                             const std::vector<VertexColorAttributeRecord>* vertexColors = nullptr) {
    uint64_t h = 1469598103934665603ULL;
    if (!verts.empty())
        h = HashFNV1a(verts.data(), verts.size() * sizeof(float), h);
    if (!indices.empty())
        h = HashFNV1a(indices.data(), indices.size() * sizeof(int), h);
    if (!uvs.empty())
        h = HashFNV1a(uvs.data(), uvs.size() * sizeof(float), h);
    if (vertexColors) {
        const int count = static_cast<int>(vertexColors->size());
        h = HashFNV1a(&count, sizeof(count), h);
        for (const VertexColorAttributeRecord& attr : *vertexColors) {
            h = HashFNV1a(&attr.channel, sizeof(attr.channel), h);
            if (!attr.values.empty()) {
                h = HashFNV1a(attr.values.data(), attr.values.size() * sizeof(float), h);
            }
        }
    }
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

static bool ShouldExportMeshVertexColorChannel(Mesh& mesh, int channel, bool allowMapChannel1 = false) {
    if (channel == 1 && !allowMapChannel1) return false;
    if (!mesh.mapSupport(channel)) return false;

    const MeshMap& map = mesh.Map(channel);
    if (!map.IsUsed() || map.vnum <= 0 || map.fnum <= 0 || !map.tv || !map.tf) return false;
    if (channel == 0 || channel == MAP_SHADING || channel == MAP_ALPHA) return true;
    return (map.flags & MESHMAP_VERTCOLOR) != 0;
}

static std::vector<int> CollectMeshVertexColorChannels(Mesh& mesh, bool allowMapChannel1 = false) {
    std::vector<int> channels;
    if (ShouldExportMeshVertexColorChannel(mesh, 0, allowMapChannel1)) channels.push_back(0);
    if (ShouldExportMeshVertexColorChannel(mesh, MAP_SHADING, allowMapChannel1)) channels.push_back(MAP_SHADING);
    if (ShouldExportMeshVertexColorChannel(mesh, MAP_ALPHA, allowMapChannel1)) channels.push_back(MAP_ALPHA);
    for (int channel = 1; channel < MAX_MESHMAPS; ++channel) {
        if (channel == 0) continue;
        if (ShouldExportMeshVertexColorChannel(mesh, channel, allowMapChannel1)) channels.push_back(channel);
    }
    return channels;
}

static MNMap* TryGetMNMap(MNMesh& mn, int channel) {
    if (channel >= 0 && channel >= mn.MNum()) return nullptr;
    return mn.M(channel);
}

static bool ShouldExportMNVertexColorChannel(MNMesh& mn, int channel, bool allowMapChannel1 = false) {
    if (channel == 1 && !allowMapChannel1) return false;
    MNMap* map = TryGetMNMap(mn, channel);
    if (!map || map->GetFlag(MN_DEAD) != 0 || map->numv <= 0 || map->numf <= 0 || !map->v) return false;
    if (channel == 0 || channel == MAP_SHADING || channel == MAP_ALPHA) return true;
    return channel > 1 || (channel == 1 && allowMapChannel1);
}

static std::vector<int> CollectMNMeshVertexColorChannels(MNMesh& mn, bool allowMapChannel1 = false) {
    std::vector<int> channels;
    if (ShouldExportMNVertexColorChannel(mn, 0, allowMapChannel1)) channels.push_back(0);
    if (ShouldExportMNVertexColorChannel(mn, MAP_SHADING, allowMapChannel1)) channels.push_back(MAP_SHADING);
    if (ShouldExportMNVertexColorChannel(mn, MAP_ALPHA, allowMapChannel1)) channels.push_back(MAP_ALPHA);
    for (int channel = 1; channel < mn.MNum(); ++channel) {
        if (ShouldExportMNVertexColorChannel(mn, channel, allowMapChannel1)) channels.push_back(channel);
    }
    return channels;
}

static uint64_t HashMeshVertexColorChannels(Mesh& mesh,
                                            const std::vector<int>& channels,
                                            uint64_t seed) {
    uint64_t h = seed;
    const int count = static_cast<int>(channels.size());
    h = HashFNV1a(&count, sizeof(count), h);
    for (int channel : channels) {
        h = HashFNV1a(&channel, sizeof(channel), h);
        const MeshMap& map = mesh.Map(channel);
        const int numVerts = map.vnum;
        const int numFaces = map.fnum;
        h = HashFNV1a(&numVerts, sizeof(numVerts), h);
        h = HashFNV1a(&numFaces, sizeof(numFaces), h);
        if (numVerts > 0 && map.tv) {
            h = HashFNV1a(map.tv, static_cast<size_t>(numVerts) * sizeof(UVVert), h);
        }
        if (numFaces > 0 && map.tf) {
            for (int i = 0; i < numFaces; ++i) {
                h = HashFNV1a(map.tf[i].t, sizeof(map.tf[i].t), h);
            }
        }
    }
    return h;
}

static uint64_t HashMNMeshVertexColorChannels(MNMesh& mn,
                                              const std::vector<int>& channels,
                                              uint64_t seed) {
    uint64_t h = seed;
    const int count = static_cast<int>(channels.size());
    h = HashFNV1a(&count, sizeof(count), h);
    for (int channel : channels) {
        h = HashFNV1a(&channel, sizeof(channel), h);
        MNMap* map = TryGetMNMap(mn, channel);
        const int numVerts = map ? map->numv : 0;
        const int numFaces = map ? map->numf : 0;
        h = HashFNV1a(&numVerts, sizeof(numVerts), h);
        h = HashFNV1a(&numFaces, sizeof(numFaces), h);
        if (!map) continue;
        for (int i = 0; i < numVerts; ++i) {
            const UVVert value = map->v[i];
            h = HashFNV1a(&value, sizeof(value), h);
        }
        for (int i = 0; i < numFaces; ++i) {
            MNMapFace* mapFace = map->F(i);
            if (!mapFace) {
                const int deg = -1;
                h = HashFNV1a(&deg, sizeof(deg), h);
                continue;
            }
            const int deg = mapFace->deg;
            h = HashFNV1a(&deg, sizeof(deg), h);
            if (deg > 0 && mapFace->tv) {
                h = HashFNV1a(mapFace->tv, sizeof(int) * static_cast<size_t>(deg), h);
            }
        }
    }
    return h;
}

static uint64_t HashMeshStateWithUVs(Mesh& mesh, bool allowMapChannel1 = false) {
    uint64_t h = HashMeshState(mesh);
    const int numTVerts = mesh.getNumTVerts();
    h = HashFNV1a(&numTVerts, sizeof(numTVerts), h);
    if (numTVerts > 0 && mesh.tVerts) {
        h = HashFNV1a(mesh.tVerts, static_cast<size_t>(numTVerts) * sizeof(UVVert), h);
    }

    if (numTVerts > 0 && mesh.tvFace) {
        const int numFaces = mesh.getNumFaces();
        for (int i = 0; i < numFaces; ++i) {
            h = HashFNV1a(mesh.tvFace[i].t, sizeof(mesh.tvFace[i].t), h);
        }
    }
    const std::vector<int> vertexColorChannels = CollectMeshVertexColorChannels(mesh, allowMapChannel1);
    h = HashMeshVertexColorChannels(mesh, vertexColorChannels, h);
    return h;
}

static uint64_t HashMNMeshStateWithUVs(MNMesh& mn, bool allowMapChannel1 = false) {
    uint64_t h = HashMNMeshState(mn);

    MNMap* uvMap = mn.M(1);
    const bool hasUVs = uvMap && uvMap->GetFlag(MN_DEAD) == 0;
    const int numUVVerts = hasUVs ? uvMap->numv : 0;
    const int numUVFaces = hasUVs ? uvMap->numf : 0;
    h = HashFNV1a(&numUVVerts, sizeof(numUVVerts), h);
    h = HashFNV1a(&numUVFaces, sizeof(numUVFaces), h);
    if (!hasUVs) return h;

    for (int i = 0; i < numUVVerts; ++i) {
        UVVert uv = uvMap->v[i];
        h = HashFNV1a(&uv, sizeof(uv), h);
    }

    for (int i = 0; i < numUVFaces; ++i) {
        MNMapFace* uvFace = uvMap->F(i);
        if (!uvFace) {
            const int deg = -1;
            h = HashFNV1a(&deg, sizeof(deg), h);
            continue;
        }

        const int deg = uvFace->deg;
        h = HashFNV1a(&deg, sizeof(deg), h);
        if (deg > 0 && uvFace->tv) {
            h = HashFNV1a(uvFace->tv, sizeof(int) * static_cast<size_t>(deg), h);
        }
    }

    const std::vector<int> vertexColorChannels = CollectMNMeshVertexColorChannels(mn, allowMapChannel1);
    h = HashMNMeshVertexColorChannels(mn, vertexColorChannels, h);
    return h;
}

static uint64_t MakeGeomValidityKey(const Interval& iv) {
    return static_cast<uint64_t>(iv.Start()) ^ (static_cast<uint64_t>(iv.End()) << 32);
}

static constexpr int kSkinnedHashFullVertexThreshold = 16384;
static constexpr int kSkinnedHashSampleCount = 256;
static constexpr ULONGLONG kSkinnedLivePollIntervalMs = 16;

static uint64_t HashSampledPoint3Array(const Point3* points,
                                       int count,
                                       uint64_t seed = 1469598103934665603ULL) {
    uint64_t h = HashFNV1a(&count, sizeof(count), seed);
    if (!points || count <= 0) return h;

    const int sampleCount = (count < kSkinnedHashSampleCount) ? count : kSkinnedHashSampleCount;
    const int stride = (count <= sampleCount) ? 1 : std::max(1, count / sampleCount);
    for (int sampleIdx = 0; sampleIdx < sampleCount; ++sampleIdx) {
        int idx = sampleIdx * stride;
        if (idx >= count) idx = count - 1;
        h = HashFNV1a(&idx, sizeof(idx), h);
        h = HashFNV1a(&points[idx], sizeof(Point3), h);
    }

    const int lastIdx = count - 1;
    h = HashFNV1a(&lastIdx, sizeof(lastIdx), h);
    h = HashFNV1a(&points[lastIdx], sizeof(Point3), h);
    return h;
}

static uint64_t HashAdaptiveSkinnedPositions(Mesh& mesh) {
    const int nv = mesh.getNumVerts();
    uint64_t h = HashFNV1a(&nv, sizeof(nv));
    if (nv <= 0) return h;
    if (nv <= kSkinnedHashFullVertexThreshold) {
        return HashFNV1a(mesh.verts, static_cast<size_t>(nv) * sizeof(Point3), h);
    }
    return HashSampledPoint3Array(mesh.verts, nv, h);
}

static uint64_t HashAdaptiveSkinnedPositions(MNMesh& mn) {
    const int nv = mn.VNum();
    uint64_t h = HashFNV1a(&nv, sizeof(nv));
    if (nv <= 0) return h;
    if (nv <= kSkinnedHashFullVertexThreshold) {
        for (int i = 0; i < nv; ++i) {
            Point3 p = mn.P(i);
            h = HashFNV1a(&p, sizeof(p), h);
        }
        return h;
    }

    const int sampleCount = (nv < kSkinnedHashSampleCount) ? nv : kSkinnedHashSampleCount;
    const int stride = (nv <= sampleCount) ? 1 : std::max(1, nv / sampleCount);
    for (int sampleIdx = 0; sampleIdx < sampleCount; ++sampleIdx) {
        int idx = sampleIdx * stride;
        if (idx >= nv) idx = nv - 1;
        Point3 p = mn.P(idx);
        h = HashFNV1a(&idx, sizeof(idx), h);
        h = HashFNV1a(&p, sizeof(p), h);
    }

    const int lastIdx = nv - 1;
    Point3 lastPoint = mn.P(lastIdx);
    h = HashFNV1a(&lastIdx, sizeof(lastIdx), h);
    h = HashFNV1a(&lastPoint, sizeof(lastPoint), h);
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

static bool IsShapeConsumedByOtherRuntimeNode(INode* node, TimeValue t);

static bool ShouldExtractRenderableShape(INode* node, TimeValue t, const ObjectState* os = nullptr) {
    if (!node) return false;
    const ObjectState localOs = os ? *os : node->EvalWorldState(t);
    return localOs.obj
        && localOs.obj->SuperClassID() == SHAPE_CLASS_ID
        && node->Renderable()
        && !IsShapeConsumedByOtherRuntimeNode(node, t);
}

// Fast-path visibility (delta / xform / splat-audio hashes) must match layer hidden + renderable.
// Sending only IsNodeHidden caused non-renderable meshes to receive vis=1 every frame and fight
// props.rend on the JS side (flicker).
static bool IsMaxJsSyncDrawVisible(INode* node) {
    return node && !node->IsNodeHidden(TRUE) && node->Renderable();
}

static uint64_t HashNodeGeometryState(INode* node, TimeValue t) {
    if (!node) return 0;

    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return HashMNMeshState(*liveMN);
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj) return 0;
    if (ShouldExtractRenderableShape(node, t, &os)) {
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

// Standard BitmapTex keeps the path on the class + asset system, not always as TYPE_FILENAME in a param block.
static std::wstring GetStandardBitmapTexFilename(Texmap* map) {
    if (!map || map->ClassID() != Class_ID(BMTEX_CLASS_ID, 0)) return {};

    auto* bt = static_cast<BitmapTex*>(map);

    const MCHAR* mapName = bt->GetMapName();
    if (mapName && mapName[0]) {
        std::wstring w(mapName);
        if (IsImageFile(w.c_str())) return w;
    }

    const MaxSDK::AssetManagement::AssetUser& au = bt->GetMap();
    MSTR fullPath;
    if (au.GetFullFilePath(fullPath) && fullPath.Length() > 0) {
        std::wstring w(fullPath.data());
        if (IsImageFile(w.c_str())) return w;
    }
    const MSTR& fn = au.GetFileName();
    if (fn.Length() > 0) {
        std::wstring w(fn.data());
        if (IsImageFile(w.c_str())) return w;
    }
    return {};
}

static std::wstring FindBitmapFileImpl(Texmap* map, std::unordered_set<Texmap*>& visited) {
    if (!map) return {};
    if (!visited.insert(map).second) return {};

    {
        std::wstring fromBm = GetStandardBitmapTexFilename(map);
        if (!fromBm.empty()) return fromBm;
    }

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
        std::wstring tslCode;       // TSL procedural texture code (if non-empty, this is a TSL Texture)
        std::wstring tslParamsJson; // TSL texture dynamic params JSON
        std::wstring htmlFile;      // absolute disk path to the .html source file
        std::wstring htmlParamsJson;
        int   htmlWidth  = 1024;
        int   htmlHeight = 1024;
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
    float reflectivity = 0.5f;
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
    std::wstring specularIntensityMap, specularColorMap;
    TexTransform colorMapTransform, gradientMapTransform, roughnessMapTransform, metalnessMapTransform, normalMapTransform;
    TexTransform bumpMapTransform, displacementMapTransform, parallaxMapTransform, sssColorMapTransform;
    TexTransform aoMapTransform, emissionMapTransform, lightmapTransform, opacityMapTransform, matcapMapTransform, specularMapTransform;
    TexTransform transmissionMapTransform;
    TexTransform clearcoatMapTransform, clearcoatRoughnessMapTransform, clearcoatNormalMapTransform;
    TexTransform specularIntensityMapTransform, specularColorMapTransform;
    std::wstring mtlName;
    std::wstring tslCode;
    std::wstring tslMaps[4];
    std::wstring tslParamsJson;
    std::wstring materialModel = L"MeshStandardMaterial";
    std::wstring materialXFile;
    std::wstring materialXInline;  // MaterialX XML string (from MtlxIOUtil.ExportMtlxString)
    std::wstring materialXBase;
    std::wstring materialXMaterialName;
    int materialXMaterialIndex = 1;
    bool materialXBridgeConnected = false;
    std::wstring materialXBridgeSourceName;
    std::wstring materialXBridgeError;
    float parallaxScale = 0.0f;
};

static float FindPBFloat(Texmap* map, const MCHAR* name, float def);
static int FindPBInt(Texmap* map, const MCHAR* name, int def);
static std::wstring FindPBString(Texmap* map, const MCHAR* name);
static std::wstring FindPBString(Mtl* mtl, const MCHAR* name);
static int FindPBInt(Mtl* mtl, const MCHAR* name, int def);
static void ExtractMaterialXMtl(Mtl* mtl, TimeValue t, MaxJSPBR& d);

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

static bool ReferenceTreeContainsImpl(ReferenceTarget* root, ReferenceTarget* needle, std::unordered_set<ReferenceTarget*>& visited) {
    if (!root || !needle) return false;
    if (root == needle) return true;
    if (!visited.insert(root).second) return false;

    ReferenceMaker* maker = dynamic_cast<ReferenceMaker*>(root);
    if (!maker) return false;

    const int numRefs = maker->NumRefs();
    for (int i = 0; i < numRefs; ++i) {
        RefTargetHandle ref = maker->GetReference(i);
        ReferenceTarget* child = dynamic_cast<ReferenceTarget*>(ref);
        if (child && ReferenceTreeContainsImpl(child, needle, visited)) {
            return true;
        }
    }
    return false;
}

static bool ReferenceTreeContains(ReferenceTarget* root, ReferenceTarget* needle) {
    std::unordered_set<ReferenceTarget*> visited;
    return ReferenceTreeContainsImpl(root, needle, visited);
}

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

// ── Procedural Map Baking ──────────────────────────────────
// TODO(maxjs): Revisit generic 3ds Max procedural texmap baking after release.
// The current experimental fallback is intentionally disabled at the call site in
// ExtractMaterialTexture(). Direct file textures, TSL textures, and known bridge
// paths remain supported; arbitrary procedural maps should not silently bake until
// the viewport-DIB/BakeTexmap path is validated against real scenes.
// Cache: Texmap pointer + time → baked PNG path.  Re-bakes only when the combo is new.
static std::unordered_map<unsigned long long, std::wstring> bakedMapCache_;
static constexpr int BAKE_SIZE = 512;

class OfflineTexHandleMaker final : public TexHandleMaker {
public:
    explicit OfflineTexHandleMaker(int size) : size_(size) {}

    TexHandle* CreateHandle(Bitmap* bm, int symflags = 0, int extraFlags = 0) override {
        UNUSED_PARAM(bm);
        UNUSED_PARAM(symflags);
        UNUSED_PARAM(extraFlags);
        return nullptr;
    }

    TexHandle* CreateHandle(BITMAPINFO* bminf, int symflags = 0, int extraFlags = 0) override {
        UNUSED_PARAM(bminf);
        UNUSED_PARAM(symflags);
        UNUSED_PARAM(extraFlags);
        return nullptr;
    }

    BITMAPINFO* BitmapToDIB(Bitmap* bm, int symflags, int extraFlags, BOOL forceW = 0, BOOL forceH = 0) override {
        UNUSED_PARAM(bm);
        UNUSED_PARAM(symflags);
        UNUSED_PARAM(extraFlags);
        UNUSED_PARAM(forceW);
        UNUSED_PARAM(forceH);
        return nullptr;
    }

    TexHandle* MakeHandle(BITMAPINFO* bminf) override {
        if (bminf) {
            LocalFree(bminf);
        }
        return nullptr;
    }

    BOOL UseClosestPowerOf2() override { return TRUE; }
    int Size() override { return size_; }

private:
    int size_;
};

static bool SaveBitmapToPng(Bitmap* bm, const std::wstring& filename, int width, int height) {
    if (!bm) return false;

    BitmapInfo outBi;
    outBi.SetName(filename.c_str());
    outBi.SetWidth(width);
    outBi.SetHeight(height);
    outBi.SetType(BMM_TRUE_32);
    outBi.SetFlags(MAP_HAS_ALPHA);

    BMMRES writeResult = bm->OpenOutput(&outBi);
    if (writeResult != BMMRES_SUCCESS) {
        return false;
    }

    bm->Write(&outBi);
    bm->Close(&outBi);
    return true;
}

static bool SaveViewportDibAsPng(BITMAPINFO* dib, const std::wstring& filename) {
    if (!dib) return false;
    if (dib->bmiHeader.biBitCount != 32 || dib->bmiHeader.biWidth <= 0 || dib->bmiHeader.biHeight == 0) {
        return false;
    }

    const int width = dib->bmiHeader.biWidth;
    const int height = std::abs(dib->bmiHeader.biHeight);
    const bool bottomUp = dib->bmiHeader.biHeight > 0;
    const int stride = ((width * dib->bmiHeader.biBitCount + 31) / 32) * 4;
    const BYTE* pixelData = reinterpret_cast<const BYTE*>(dib) + dib->bmiHeader.biSize;

    BitmapInfo bi;
    bi.SetWidth(width);
    bi.SetHeight(height);
    bi.SetType(BMM_TRUE_32);
    bi.SetFlags(MAP_HAS_ALPHA);

    Bitmap* bm = TheManager->Create(&bi);
    if (!bm) return false;

    std::vector<BMM_Color_fl> row(static_cast<size_t>(width));
    for (int y = 0; y < height; ++y) {
        const int srcY = bottomUp ? (height - 1 - y) : y;
        const BYTE* src = pixelData + static_cast<size_t>(srcY) * static_cast<size_t>(stride);
        for (int x = 0; x < width; ++x) {
            const BYTE* px = src + static_cast<size_t>(x) * 4;
            row[static_cast<size_t>(x)].r = static_cast<float>(px[2]) / 255.0f;
            row[static_cast<size_t>(x)].g = static_cast<float>(px[1]) / 255.0f;
            row[static_cast<size_t>(x)].b = static_cast<float>(px[0]) / 255.0f;
            row[static_cast<size_t>(x)].a = static_cast<float>(px[3]) / 255.0f;
        }
        bm->PutPixels(0, y, width, row.data());
    }

    const bool ok = SaveBitmapToPng(bm, filename, width, height);
    bm->DeleteThis();
    return ok;
}

static bool SaveBakedPixelsAsPng(const std::vector<BMM_Color_fl>& bakedPixels, int width, int height, const std::wstring& filename) {
    BitmapInfo bi;
    bi.SetWidth(width);
    bi.SetHeight(height);
    bi.SetType(BMM_TRUE_32);
    bi.SetFlags(MAP_HAS_ALPHA);

    Bitmap* bm = TheManager->Create(&bi);
    if (!bm) return false;

    for (int y = 0; y < height; ++y) {
        BMM_Color_fl* row = const_cast<BMM_Color_fl*>(bakedPixels.data()) + static_cast<size_t>(y) * static_cast<size_t>(width);
        bm->PutPixels(0, y, width, row);
    }

    const bool ok = SaveBitmapToPng(bm, filename, width, height);
    bm->DeleteThis();
    return ok;
}

static std::wstring BakeProceduralMap(Texmap* map, TimeValue t) {
    if (!map) return {};

    // Cache key: texmap address + time. Animated procedural maps need different bakes per frame.
    const unsigned long long key =
        (static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(map)) << 16) ^
        static_cast<unsigned int>(t);
    auto it = bakedMapCache_.find(key);
    if (it != bakedMapCache_.end()) {
        return it->second;
    }

    wchar_t tempDir[MAX_PATH];
    GetTempPathW(MAX_PATH, tempDir);
    std::wstring dir = std::wstring(tempDir) + L"maxjs_baked\\";
    CreateDirectoryW(dir.c_str(), nullptr);
    std::wstring filename = dir + L"proc_" + std::to_wstring(key) + L".png";

    // Prefer the viewport-display DIB path for unknown procedural maps.
    // This is the same path many Autodesk procedural maps implement for Nitrous/viewport preview.
    OfflineTexHandleMaker thmaker(BAKE_SIZE);
    Interval vpValid = FOREVER;
    BITMAPINFO* dib = map->GetVPDisplayDIB(t, thmaker, vpValid, FALSE, BAKE_SIZE, BAKE_SIZE);
    if (dib) {
        const bool ok = SaveViewportDibAsPng(dib, filename);
        LocalFree(dib);
        if (ok) {
            bakedMapCache_[key] = filename;
            return filename;
        }
    }

    Interval validity = FOREVER;
    IPoint2 bakedRes(0, 0);
    std::vector<BMM_Color_fl> bakedPixels;
    if (!MaxSDK::RenderingAPI::BaseTranslator_Texmap::BakeTexmap(
            *map,
            t,
            validity,
            IPoint2(BAKE_SIZE, BAKE_SIZE),
            bakedRes,
            bakedPixels)) {
        return {};
    }

    if (bakedRes.x <= 0 || bakedRes.y <= 0) return {};
    const size_t pixelCount = static_cast<size_t>(bakedRes.x) * static_cast<size_t>(bakedRes.y);
    if (bakedPixels.size() < pixelCount) return {};

    if (SaveBakedPixelsAsPng(bakedPixels, bakedRes.x, bakedRes.y, filename)) {
        bakedMapCache_[key] = filename;
        return filename;
    }

    return {};
}

static void ClearBakedMapCache() {
    bakedMapCache_.clear();
}

static bool ExtractMaterialTexture(Texmap* map, std::wstring& filePath, MaxJSPBR::TexTransform& xf) {
    if (!map) return false;

    Texmap* resolved = map;
    const int outputChannelIndex = std::max(1, FindPBInt(map, _T("outputChannelIndex"), 1));
    if (Texmap* sourceMap = FindPBMap(map, _T("sourceMap")))
        resolved = sourceMap;

    // TSL Texture — procedural texmap with TSL code
    if (resolved->ClassID() == THREEJS_TSL_TEX_CLASS_ID) {
        for (int b = 0; b < resolved->NumParamBlocks(); b++) {
            IParamBlock2* pb = resolved->GetParamBlock(b);
            if (!pb) continue;
            if (HasParam(pb, ptsl_tex_code)) {
                const MCHAR* code = pb->GetStr(ptsl_tex_code);
                if (code && code[0]) {
                    filePath = L"tsl://procedural";
                    xf = {};
                    xf.tslCode = code;
                    if (HasParam(pb, ptsl_tex_params_json)) {
                        const MCHAR* pj = pb->GetStr(ptsl_tex_params_json);
                        if (pj && pj[0]) xf.tslParamsJson = pj;
                    }
                    return true;
                }
            }
        }
        return false;
    }

    // HTML Texture — live HTML file rasterized on the web side
    if (resolved->ClassID() == THREEJS_HTML_TEX_CLASS_ID) {
        IParamBlock2* pb = resolved->GetParamBlockByID(threejs_html_tex_params);
        if (!pb) return false;
        const MCHAR* fn = pb->GetStr(phtml_tex_file);
        if (!fn || !fn[0]) return false;
        filePath = L"html://managed";
        xf = {};
        xf.htmlFile = fn;
        xf.htmlWidth  = pb->GetInt(phtml_tex_width,  0);
        xf.htmlHeight = pb->GetInt(phtml_tex_height, 0);
        if (xf.htmlWidth  <= 0) xf.htmlWidth  = 1024;
        if (xf.htmlHeight <= 0) xf.htmlHeight = 1024;
        if (xf.htmlWidth  > 4096) xf.htmlWidth  = 4096;
        if (xf.htmlHeight > 4096) xf.htmlHeight = 4096;
        const MCHAR* pj = pb->GetStr(phtml_tex_params_json);
        if (pj && pj[0]) xf.htmlParamsJson = pj;
        return true;
    }

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

    // TODO(maxjs): Re-enable procedural texmap baking after the generic fallback
    // is proven reliable. For release, do not silently convert arbitrary 3ds Max
    // maps into baked PNGs here.
    // {
    //     std::wstring bakedPath = BakeProceduralMap(resolved, GetCOREInterface()->GetTime());
    //     if (!bakedPath.empty()) {
    //         filePath = bakedPath;
    //         xf = {};
    //         ExtractStdUVTransform(resolved, xf);
    //         xf.hasChannelSelect = outputChannelIndex != 1;
    //         xf.outputChannelIndex = outputChannelIndex;
    //         return true;
    //     }
    // }

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

static std::wstring GetMtlxExportBaseDir() {
    Interface* ip = GetCOREInterface();
    std::wstring layerPath;
    if (ip) {
        MSTR scenePath = ip->GetCurFilePath();
        if (scenePath.Length() > 0) {
            layerPath = scenePath.data();
            const size_t slash = layerPath.find_last_of(L"\\/");
            if (slash != std::wstring::npos) layerPath = layerPath.substr(0, slash);
        }
    }
    if (layerPath.empty()) {
        wchar_t tmp[MAX_PATH];
        GetTempPathW(MAX_PATH, tmp);
        layerPath = tmp;
    }
    return layerPath;
}

// Export a material's MaterialX node graph as an XML string via MtlxIOUtil.
static std::wstring ExportMtlxString(Mtl* mtl, std::wstring* outBaseDir = nullptr) {
    if (!mtl) return {};

    const auto animHandle = Animatable::GetHandleByAnim(mtl);
    if (animHandle == 0) return {};

    const std::wstring layerPath = GetMtlxExportBaseDir();
    if (outBaseDir) *outBaseDir = layerPath;

    std::wostringstream ss;
    ss << LR"(
        fn _maxjs_exportMtlx materialAnimHandle layerPath = (
            local m = getAnimByHandle materialAnimHandle
            if m == undefined do return ""
            local mArr = #(m)
            local mtlxStr = MtlxIOUtil.ExportMtlxString layerPath mArr
            if mtlxStr == undefined then "" else mtlxStr
        )
        _maxjs_exportMtlx )" << animHandle << L" @\"" << layerPath << L"\"";

    FPValue rvalue;
    rvalue.Init();
    try {
        if (!ExecuteMAXScriptScript(ss.str().c_str(), MAXScript::ScriptSource::Dynamic, false, &rvalue)) {
            return {};
        }
        if (rvalue.type == TYPE_STRING && rvalue.s && wcslen(rvalue.s) > 0) {
            return std::wstring(rvalue.s);
        }
    } catch (...) {}
    return {};
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
        // Extract TSL texture map slots
        {
            static const ParamID tslMapIDs[] = { pb_tsl_map1, pb_tsl_map2, pb_tsl_map3, pb_tsl_map4 };
            for (int m = 0; m < 4; ++m) {
                if (HasParam(pb, tslMapIDs[m])) {
                    Texmap* tm = pb->GetTexmap(tslMapIDs[m], t);
                    if (tm) {
                        MaxJSPBR::TexTransform xf;
                        ExtractMaterialTexture(tm, d.tslMaps[m], xf);
                    }
                }
            }
        }
        // Extract dynamic params JSON
        if (HasParam(pb, pb_tsl_params_json)) {
            const MCHAR* pj = pb->GetStr(pb_tsl_params_json);
            if (pj && pj[0]) d.tslParamsJson = pj;
        }
        // Auto-compile MaterialX from source material if connected
        if (HasParam(pb, pb_tsl_source_mtl)) {
            Mtl* srcMtl = pb->GetMtl(pb_tsl_source_mtl);
            if (srcMtl) {
                d.materialXBridgeConnected = true;
                MSTR srcName = srcMtl->GetName();
                if (srcName.Length() > 0) {
                    d.materialXBridgeSourceName = srcName.data();
                }

                if (IsMaterialXMaterialClass(srcMtl->ClassID())) {
                    MaxJSPBR srcBridge;
                    ExtractMaterialXMtl(srcMtl, t, srcBridge);
                    d.materialXFile = srcBridge.materialXFile;
                    d.materialXInline = srcBridge.materialXInline;
                    d.materialXBase = srcBridge.materialXBase;
                    d.materialXMaterialName = srcBridge.materialXMaterialName;
                    d.materialXMaterialIndex = std::max(1, srcBridge.materialXMaterialIndex);
                    if (d.materialXInline.empty() && d.materialXFile.empty()) {
                        d.materialXBridgeError = L"Connected MaterialX source produced no XML or file payload";
                    }
                } else {
                    std::wstring materialXBase;
                    std::wstring xml = ExportMtlxString(srcMtl, &materialXBase);
                    if (!xml.empty()) {
                        d.materialXInline = xml;
                        d.materialXBase = materialXBase;
                        if (srcName.Length() > 0)
                            d.materialXMaterialName = srcName.data();
                        d.materialXMaterialIndex = 1;
                    } else {
                        d.materialXBridgeError = L"MtlxIOUtil.ExportMtlxString returned empty XML";
                    }
                }
            }
        }
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
    if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshPhysicalMaterial") {
        readMap(pb_phys_specular_intensity_map, d.specularIntensityMap, d.specularIntensityMapTransform);
        readMap(pb_phys_specular_color_map, d.specularColorMap, d.specularColorMapTransform);
        readMap(pb_phys_clearcoat_map, d.clearcoatMap, d.clearcoatMapTransform);
        readMap(pb_phys_clearcoat_roughness_map, d.clearcoatRoughnessMap, d.clearcoatRoughnessMapTransform);
        readMap(pb_phys_clearcoat_normal_map, d.clearcoatNormalMap, d.clearcoatNormalMapTransform);
        readMap(pb_phys_transmission_map, d.transmissionMap, d.transmissionMapTransform);
    } else if (cid == THREEJS_ADV_MTL_CLASS_ID && d.materialModel == L"MeshSSSNodeMaterial") {
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

    // If no file path, try live export from node graph
    if (d.materialXFile.empty()) {
        d.materialXInline = ExportMtlxString(mtl, &d.materialXBase);
    }
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
    auto reflectivityFromIor = [](float ior) -> float {
        const float clampedIor = std::max(1.0f, ior);
        const float numerator = clampedIor - 1.0f;
        const float denominator = clampedIor + 1.0f;
        if (denominator <= 1.0e-6f) return 0.0f;
        const float f0 = (numerator * numerator) / (denominator * denominator);
        return std::clamp(std::sqrt(std::max(0.0f, f0) / 0.16f), 0.0f, 1.0f);
    };

    // Core PBR
    readColor(_T("base_color"), d.color);
    d.roughness       = readFloat(_T("specular_roughness"), 0.3f);
    d.metalness       = readFloat(_T("base_metalness"), 0.0f);
    d.ior             = readFloat(_T("specular_ior"), 1.5f);
    d.reflectivity    = reflectivityFromIor(d.ior);
    d.normalScale     = readFloat(_T("bump_map_amt"), 1.0f);
    d.displacementScale = readFloat(_T("displacement_map_amt"), 1.0f);
    d.anisotropy      = readFloat(_T("specular_roughness_anisotropy"), 0.0f);

    // Specular
    readColor(_T("specular_color"), d.physicalSpecularColor);
    d.physicalSpecularIntensity = readFloat(_T("specular_weight"), 1.0f);

    // Transmission
    const bool thinWalled = readBool(_T("geometry_thin_walled"), false);
    const float transmissionDepth = readFloat(_T("transmission_depth"), 0.0f);
    d.transmission = readFloat(_T("transmission_weight"), 0.0f);
    if (d.transmission > 0.0f) {
        readColor(_T("transmission_color"), d.attenuationColor);
        d.attenuationDistance = transmissionDepth;
        // OpenPBR relies on actual mesh thickness when thin_walled is off.
        // Three.js needs an explicit thickness scalar for volumetric
        // transmission/refraction, so approximate it from transmission_depth.
        if (!thinWalled) {
            d.thickness = transmissionDepth > 0.0f ? transmissionDepth : 1.0f;
        }
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
    readMap(_T("specular_weight_map"),    _T("specular_weight_map_on"),    d.specularIntensityMap, d.specularIntensityMapTransform);
    readMap(_T("specular_color_map"),     _T("specular_color_map_on"),     d.specularColorMap,     d.specularColorMapTransform);
    readMap(_T("specular_roughness_map"), _T("specular_roughness_map_on"), d.roughnessMap,    d.roughnessMapTransform);
    readMap(_T("base_metalness_map"),     _T("base_metalness_map_on"),     d.metalnessMap,    d.metalnessMapTransform);
    readMap(_T("emission_color_map"),     _T("emission_color_map_on"),     d.emissionMap,     d.emissionMapTransform);
    readMap(_T("geometry_opacity_map"),   _T("geometry_opacity_map_on"),   d.opacityMap,      d.opacityMapTransform);
    readMap(_T("transmission_weight_map"), _T("transmission_weight_map_on"), d.transmissionMap, d.transmissionMapTransform);
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

    // Keep OpenPBR on the physical path. Specular IOR/reflectivity is part of
    // the core shading model and must not depend on coat or transmission.
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

    // Keep VRay on the physical path. Reflection/specular controls are valid
    // even when coat/transmission/etc. are off, and downgrading here drops them.
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
//  SSE SIMD helpers for vertex/normal processing
// ══════════════════════════════════════════════════════════════

// Cross product of two Point3 vectors using SSE
// (b-a) x (c-a), returned as Point3
static __forceinline Point3 CrossProductSSE(const Point3& a, const Point3& b, const Point3& c) {
    // edge1 = b - a, edge2 = c - a
    __m128 va = _mm_set_ps(0, a.z, a.y, a.x);
    __m128 vb = _mm_set_ps(0, b.z, b.y, b.x);
    __m128 vc = _mm_set_ps(0, c.z, c.y, c.x);
    __m128 e1 = _mm_sub_ps(vb, va);
    __m128 e2 = _mm_sub_ps(vc, va);
    // cross = (e1.y*e2.z - e1.z*e2.y, e1.z*e2.x - e1.x*e2.z, e1.x*e2.y - e1.y*e2.x)
    __m128 e1_yzx = _mm_shuffle_ps(e1, e1, _MM_SHUFFLE(3, 0, 2, 1));
    __m128 e2_yzx = _mm_shuffle_ps(e2, e2, _MM_SHUFFLE(3, 0, 2, 1));
    __m128 cross = _mm_sub_ps(_mm_mul_ps(e1, e2_yzx), _mm_mul_ps(e1_yzx, e2));
    cross = _mm_shuffle_ps(cross, cross, _MM_SHUFFLE(3, 0, 2, 1));
    float out[4];
    _mm_storeu_ps(out, cross);
    return Point3(out[0], out[1], out[2]);
}

// Normalize a Point3 using SSE rsqrt + Newton-Raphson refinement
static __forceinline Point3 NormalizeSSE(const Point3& v) {
    __m128 vec = _mm_set_ps(0, v.z, v.y, v.x);
    __m128 dot = _mm_mul_ps(vec, vec);
    // horizontal sum: x*x + y*y + z*z
    __m128 shuf = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 1));
    dot = _mm_add_ss(dot, shuf);
    shuf = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 2));
    dot = _mm_add_ss(dot, shuf);
    dot = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 0));
    // rsqrt + one Newton-Raphson iteration for accuracy
    __m128 rsq = _mm_rsqrt_ps(dot);
    __m128 half = _mm_set1_ps(0.5f);
    __m128 three = _mm_set1_ps(3.0f);
    rsq = _mm_mul_ps(_mm_mul_ps(half, rsq),
                     _mm_sub_ps(three, _mm_mul_ps(dot, _mm_mul_ps(rsq, rsq))));
    // guard against zero-length
    __m128 mask = _mm_cmpgt_ps(dot, _mm_set1_ps(1e-30f));
    rsq = _mm_and_ps(rsq, mask);
    __m128 result = _mm_mul_ps(vec, rsq);
    float out[4];
    _mm_storeu_ps(out, result);
    return Point3(out[0], out[1], out[2]);
}

// Batch normalize an array of Point3 (as float triplets) in-place
static void BatchNormalizeSSE(float* data, size_t count) {
    for (size_t i = 0; i < count; i++) {
        __m128 vec = _mm_set_ps(0, data[i * 3 + 2], data[i * 3 + 1], data[i * 3]);
        __m128 dot = _mm_mul_ps(vec, vec);
        __m128 shuf = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 1));
        dot = _mm_add_ss(dot, shuf);
        shuf = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 2));
        dot = _mm_add_ss(dot, shuf);
        dot = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 0));
        __m128 rsq = _mm_rsqrt_ps(dot);
        __m128 half = _mm_set1_ps(0.5f);
        __m128 three = _mm_set1_ps(3.0f);
        rsq = _mm_mul_ps(_mm_mul_ps(half, rsq),
                         _mm_sub_ps(three, _mm_mul_ps(dot, _mm_mul_ps(rsq, rsq))));
        __m128 mask = _mm_cmpgt_ps(dot, _mm_set1_ps(1e-30f));
        rsq = _mm_and_ps(rsq, mask);
        __m128 result = _mm_mul_ps(vec, rsq);
        _mm_store_ss(&data[i * 3], result);
        result = _mm_shuffle_ps(result, result, _MM_SHUFFLE(0, 0, 0, 1));
        _mm_store_ss(&data[i * 3 + 1], result);
        result = _mm_shuffle_ps(result, result, _MM_SHUFFLE(0, 0, 0, 1));
        _mm_store_ss(&data[i * 3 + 2], result);
    }
}

// ══════════════════════════════════════════════════════════════
//  Mesh Extraction with UV coordinates + Multi/Sub material groups
// ══════════════════════════════════════════════════════════════

struct MatGroup { int matID; int start; int count; };

struct MeshCornerKey {
    DWORD posIdx = 0;
    DWORD uvIdx = 0;
    DWORD smGroup = 0;
    uint64_t colorSig = 0;

    bool operator==(const MeshCornerKey& other) const {
        return posIdx == other.posIdx &&
               uvIdx == other.uvIdx &&
               smGroup == other.smGroup &&
               colorSig == other.colorSig;
    }
};

struct MeshCornerKeyHash {
    size_t operator()(const MeshCornerKey& key) const noexcept {
        size_t h = static_cast<size_t>(key.posIdx);
        h = h * 16777619u ^ static_cast<size_t>(key.uvIdx);
        h = h * 16777619u ^ static_cast<size_t>(key.smGroup);
        h = h * 16777619u ^ static_cast<size_t>(key.colorSig);
        h = h * 16777619u ^ static_cast<size_t>(key.colorSig >> 32);
        return h;
    }
};

// ── MNMesh (PolyObject) extraction — handles ngons correctly ──
static bool ExtractMeshFromMNMesh(MNMesh& mn,
                                  std::vector<float>& verts,
                                  std::vector<float>& uvs,
                                  std::vector<int>& indices,
                                  std::vector<MatGroup>& groups,
                                  std::vector<float>* outNormals = nullptr,
                                  std::vector<int>* outControlIdx = nullptr,
                                  std::vector<VertexColorAttributeRecord>* outVertexColors = nullptr,
                                  bool allowMapChannel1 = false) {
    const int numFaces = mn.FNum();
    const int numVerts = mn.VNum();
    if (numFaces == 0 || numVerts == 0) return false;

    // UV map channel 1
    MNMap* uvMap = mn.M(1);
    const bool hasUVs = uvMap && uvMap->GetFlag(MN_DEAD) == 0 && uvMap->numv > 0;
    const std::vector<int> vertexColorChannels = CollectMNMeshVertexColorChannels(mn, allowMapChannel1);
    std::vector<MNMap*> vertexColorMaps;
    vertexColorMaps.reserve(vertexColorChannels.size());
    for (int channel : vertexColorChannels) {
        vertexColorMaps.push_back(TryGetMNMap(mn, channel));
    }

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

    // Per-corner smoothed normals, indexed by faceCornerStart[faceIdx] + localIdx.
    // Avoids the hash-map-per-corner cost that dominated on 700k+ poly meshes and
    // lets the face-normal and smooth-normal passes run on a PPL worker pool.
    std::vector<int> faceCornerStart;
    std::vector<Point3> cornerNormals;
    if (outNormals) {
        faceCornerStart.assign(numFaces, 0);
        std::vector<Point3> faceNormalsFlat(numFaces, Point3(0, 0, 0));

        // Phase A: face normals — independent writes per faceIdx slot.
        concurrency::parallel_for(size_t(0), liveFaces.size(), [&](size_t i) {
            const FaceRef& fr = liveFaces[i];
            MNFace* face = mn.F(fr.idx);
            if (face->deg < 3) return;
            Point3 cross = CrossProductSSE(mn.P(face->vtx[0]), mn.P(face->vtx[1]), mn.P(face->vtx[2]));
            faceNormalsFlat[fr.idx] = NormalizeSSE(cross);
        });

        // Phase B: build CSR vertex→corners index (serial; cheap O(totalCorners)).
        std::vector<int> vertCornerOff(static_cast<size_t>(numVerts) + 1, 0);
        int totalCorners = 0;
        for (const FaceRef& fr : liveFaces) {
            MNFace* face = mn.F(fr.idx);
            faceCornerStart[fr.idx] = totalCorners;
            totalCorners += face->deg;
            for (int v = 0; v < face->deg; v++) {
                vertCornerOff[face->vtx[v] + 1]++;
            }
        }
        for (int i = 1; i <= numVerts; i++) vertCornerOff[i] += vertCornerOff[i - 1];

        struct VertCorner { int faceIdx; int localIdx; DWORD smGrp; };
        std::vector<VertCorner> vertCornersFlat(static_cast<size_t>(totalCorners));
        {
            std::vector<int> cursor(numVerts, 0);
            for (const FaceRef& fr : liveFaces) {
                MNFace* face = mn.F(fr.idx);
                const DWORD smGrp = face->smGroup;
                for (int v = 0; v < face->deg; v++) {
                    int pIdx = face->vtx[v];
                    vertCornersFlat[vertCornerOff[pIdx] + cursor[pIdx]++] = { fr.idx, v, smGrp };
                }
            }
        }

        // Phase C: smooth-normal accumulation — each vertex index owns a disjoint
        // slice of vertCornersFlat and writes to disjoint cornerNormals slots, so
        // parallel_for is data-race-free.
        cornerNormals.assign(static_cast<size_t>(totalCorners), Point3(0, 0, 0));
        concurrency::parallel_for(0, numVerts, [&](int posIdx) {
            const int beg = vertCornerOff[posIdx];
            const int end = vertCornerOff[posIdx + 1];
            for (int i = beg; i < end; i++) {
                const VertCorner& c = vertCornersFlat[i];
                Point3 accum = faceNormalsFlat[c.faceIdx];
                if (c.smGrp != 0) {
                    for (int j = beg; j < end; j++) {
                        if (j == i) continue;
                        const VertCorner& other = vertCornersFlat[j];
                        if (other.faceIdx == c.faceIdx) continue;
                        if ((c.smGrp & other.smGrp) != 0)
                            accum += faceNormalsFlat[other.faceIdx];
                    }
                }
                cornerNormals[faceCornerStart[c.faceIdx] + c.localIdx] = NormalizeSSE(accum);
            }
        });
    }

    // Estimate output sizes
    int estTris = 0;
    for (auto& fr : liveFaces) estTris += mn.F(fr.idx)->deg - 2;
    verts.reserve(numVerts * 3);
    if (hasUVs) uvs.reserve(numVerts * 2);
    indices.reserve(estTris * 3);
    std::vector<float> normals;
    if (outNormals) normals.reserve(numVerts * 3);
    if (outControlIdx) outControlIdx->clear();
    if (outVertexColors) {
        outVertexColors->clear();
        outVertexColors->reserve(vertexColorChannels.size());
        const size_t estVertexCount = static_cast<size_t>(std::max(numVerts, estTris * 3));
        for (int channel : vertexColorChannels) {
            VertexColorAttributeRecord attr;
            attr.channel = channel;
            attr.attrName = GetVertexColorAttributeName(channel);
            attr.values.reserve(estVertexCount * 4);
            outVertexColors->push_back(std::move(attr));
        }
    }

    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    vertMap.reserve(static_cast<size_t>(estTris) * 3);
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
                uint64_t colorSig = 1469598103934665603ULL;
                for (size_t ci = 0; ci < vertexColorChannels.size(); ++ci) {
                    const int channel = vertexColorChannels[ci];
                    MNMap* colorMap = vertexColorMaps[ci];
                    int colorIdx = -1;
                    if (colorMap && fr.idx < colorMap->numf) {
                        MNMapFace* colorFace = colorMap->F(fr.idx);
                        if (colorFace && localIdx < colorFace->deg && colorFace->tv) {
                            colorIdx = colorFace->tv[localIdx];
                        }
                    }
                    colorSig = HashFNV1a(&channel, sizeof(channel), colorSig);
                    colorSig = HashFNV1a(&colorIdx, sizeof(colorIdx), colorSig);
                }

                // smGrp 0 = no smoothing: force unique vertices per face for flat normals
                DWORD keySmGrp = smGrp == 0 ? (DWORD)(0x80000000u | fr.idx) : smGrp;
                MeshCornerKey key = { posIdx, uvIdx, keySmGrp, colorSig };
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
                        const Point3& n = cornerNormals[faceCornerStart[fr.idx] + localIdx];
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

                    if (outVertexColors) {
                        for (size_t ci = 0; ci < vertexColorChannels.size(); ++ci) {
                            const int channel = vertexColorChannels[ci];
                            MNMap* colorMap = vertexColorMaps[ci];
                            UVVert value = DefaultVertexColorValue(channel);
                            int colorIdx = -1;
                            if (colorMap && fr.idx < colorMap->numf) {
                                MNMapFace* colorFace = colorMap->F(fr.idx);
                                if (colorFace && localIdx < colorFace->deg && colorFace->tv) {
                                    colorIdx = colorFace->tv[localIdx];
                                }
                            }
                            if (colorMap && colorIdx >= 0 && colorIdx < colorMap->numv) {
                                value = colorMap->v[colorIdx];
                            }
                            AppendVertexColorValue((*outVertexColors)[ci].values, value, channel);
                        }
                    }

                    if (outControlIdx) outControlIdx->push_back(static_cast<int>(posIdx));
                    indices.push_back(newIdx);
                }
            }
            groups.back().count += 3;
        }
    }
    if (outNormals) *outNormals = std::move(normals);
    if (outVertexColors && outVertexColors->empty()) outVertexColors->clear();
    return !indices.empty();
}

// ── TriObject (Mesh) extraction — standard triangle meshes ──
static bool ExtractMeshFromTriObject(TriObject* tri, Object* srcObj,
                                     std::vector<float>& verts,
                                     std::vector<float>& uvs,
                                     std::vector<int>& indices,
                                     std::vector<MatGroup>& groups,
                                     std::vector<int>* outControlIdx = nullptr,
                                     std::vector<VertexColorAttributeRecord>* outVertexColors = nullptr,
                                     bool allowMapChannel1 = false) {
    Mesh& mesh = tri->GetMesh();
    int nv = mesh.getNumVerts();
    int nf = mesh.getNumFaces();

    if (nv == 0 || nf == 0) {
        if (tri != srcObj) tri->DeleteThis();
        return false;
    }

    bool hasUVs = mesh.getNumTVerts() > 0;
    const std::vector<int> vertexColorChannels = CollectMeshVertexColorChannels(mesh, allowMapChannel1);

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
    if (outControlIdx) outControlIdx->clear();
    if (outVertexColors) {
        outVertexColors->clear();
        outVertexColors->reserve(vertexColorChannels.size());
        for (int channel : vertexColorChannels) {
            VertexColorAttributeRecord attr;
            attr.channel = channel;
            attr.attrName = GetVertexColorAttributeName(channel);
            attr.values.reserve(static_cast<size_t>(nf) * 3 * 4);
            outVertexColors->push_back(std::move(attr));
        }
    }

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
            uint64_t colorSig = 1469598103934665603ULL;
            for (int channel : vertexColorChannels) {
                int colorIdx = -1;
                const MeshMap& colorMap = mesh.Map(channel);
                if (colorMap.tf && f < colorMap.fnum) {
                    colorIdx = colorMap.tf[f].t[v];
                }
                colorSig = HashFNV1a(&channel, sizeof(channel), colorSig);
                colorSig = HashFNV1a(&colorIdx, sizeof(colorIdx), colorSig);
            }
            MeshCornerKey key = { posIdx, uvIdx, mesh.faces[f].getSmGroup(), colorSig };

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

                if (outVertexColors) {
                    for (size_t ci = 0; ci < vertexColorChannels.size(); ++ci) {
                        const int channel = vertexColorChannels[ci];
                        const MeshMap& colorMap = mesh.Map(channel);
                        UVVert value = DefaultVertexColorValue(channel);
                        int colorIdx = -1;
                        if (colorMap.tf && f < colorMap.fnum) {
                            colorIdx = colorMap.tf[f].t[v];
                        }
                        if (colorIdx >= 0 && colorIdx < colorMap.vnum && colorMap.tv) {
                            value = colorMap.tv[colorIdx];
                        }
                        AppendVertexColorValue((*outVertexColors)[ci].values, value, channel);
                    }
                }

                if (outControlIdx) outControlIdx->push_back(static_cast<int>(posIdx));
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
                                   std::vector<float>* outNormals = nullptr,
                                   std::vector<VertexColorAttributeRecord>* outVertexColors = nullptr,
                                   bool allowMapChannel1 = false) {
    int nv = mesh.getNumVerts();
    int nf = mesh.getNumFaces();
    if (nv == 0 || nf == 0) return false;

    bool hasUVs = mesh.getNumTVerts() > 0;
    const std::vector<int> vertexColorChannels = CollectMeshVertexColorChannels(mesh, allowMapChannel1);

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

    // Per-corner smoothed normals: cornerNormals[f*3 + v]. Avoids the map
    // hash cost that dominated on dense tri meshes and parallelizes the
    // face-normal and smooth-normal passes.
    std::vector<Point3> cornerNormals;
    if (outNormals) {
        std::vector<Point3> faceNormals(nf);

        concurrency::parallel_for(0, nf, [&](int f) {
            const Point3 a = mesh.getVert(mesh.faces[f].v[0]);
            const Point3 b = mesh.getVert(mesh.faces[f].v[1]);
            const Point3 c = mesh.getVert(mesh.faces[f].v[2]);
            faceNormals[f] = Normalize((b - a) ^ (c - a));
        });

        std::vector<int> vertCornerOff(static_cast<size_t>(nv) + 1, 0);
        for (int f = 0; f < nf; f++) {
            for (int v = 0; v < 3; v++) vertCornerOff[mesh.faces[f].v[v] + 1]++;
        }
        for (int i = 1; i <= nv; i++) vertCornerOff[i] += vertCornerOff[i - 1];

        struct TriCorner { int faceIdx; int localV; DWORD smGrp; };
        std::vector<TriCorner> vertCornersFlat(static_cast<size_t>(nf) * 3);
        {
            std::vector<int> cursor(nv, 0);
            for (int f = 0; f < nf; f++) {
                DWORD smGrp = mesh.faces[f].getSmGroup();
                for (int v = 0; v < 3; v++) {
                    int pIdx = mesh.faces[f].v[v];
                    vertCornersFlat[vertCornerOff[pIdx] + cursor[pIdx]++] = { f, v, smGrp };
                }
            }
        }

        cornerNormals.assign(static_cast<size_t>(nf) * 3, Point3(0, 0, 0));
        concurrency::parallel_for(0, nv, [&](int posIdx) {
            const int beg = vertCornerOff[posIdx];
            const int end = vertCornerOff[posIdx + 1];
            for (int i = beg; i < end; i++) {
                const TriCorner& c = vertCornersFlat[i];
                Point3 accum = faceNormals[c.faceIdx];
                for (int j = beg; j < end; j++) {
                    if (j == i) continue;
                    const TriCorner& other = vertCornersFlat[j];
                    if (other.faceIdx == c.faceIdx) continue;
                    if (other.smGrp == c.smGrp) accum += faceNormals[other.faceIdx];
                }
                cornerNormals[c.faceIdx * 3 + c.localV] = Normalize(accum);
            }
        });
    }

    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    vertMap.reserve(static_cast<size_t>(nf) * 3);
    verts.reserve(nv * 3);
    if (hasUVs) uvs.reserve(nv * 2);
    indices.reserve(nf * 3);
    std::vector<float> normals;
    if (outNormals) normals.reserve(nv * 3);
    if (outVertexColors) {
        outVertexColors->clear();
        outVertexColors->reserve(vertexColorChannels.size());
        for (int channel : vertexColorChannels) {
            VertexColorAttributeRecord attr;
            attr.channel = channel;
            attr.attrName = GetVertexColorAttributeName(channel);
            attr.values.reserve(static_cast<size_t>(nf) * 3 * 4);
            outVertexColors->push_back(std::move(attr));
        }
    }

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
            uint64_t colorSig = 1469598103934665603ULL;
            for (int channel : vertexColorChannels) {
                int colorIdx = -1;
                const MeshMap& colorMap = mesh.Map(channel);
                if (colorMap.tf && f < colorMap.fnum) {
                    colorIdx = colorMap.tf[f].t[v];
                }
                colorSig = HashFNV1a(&channel, sizeof(channel), colorSig);
                colorSig = HashFNV1a(&colorIdx, sizeof(colorIdx), colorSig);
            }
            MeshCornerKey key = { posIdx, uvIdx, smGrp, colorSig };

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
                    const Point3& n = cornerNormals[f * 3 + v];
                    normals.push_back(n.x);
                    normals.push_back(n.y);
                    normals.push_back(n.z);
                }

                if (hasUVs) {
                    UVVert uv = mesh.tVerts[uvIdx];
                    uvs.push_back(uv.x);
                    uvs.push_back(uv.y);
                }

                if (outVertexColors) {
                    for (size_t ci = 0; ci < vertexColorChannels.size(); ++ci) {
                        const int channel = vertexColorChannels[ci];
                        const MeshMap& colorMap = mesh.Map(channel);
                        UVVert value = DefaultVertexColorValue(channel);
                        int colorIdx = -1;
                        if (colorMap.tf && f < colorMap.fnum) {
                            colorIdx = colorMap.tf[f].t[v];
                        }
                        if (colorIdx >= 0 && colorIdx < colorMap.vnum && colorMap.tv) {
                            value = colorMap.tv[colorIdx];
                        }
                        AppendVertexColorValue((*outVertexColors)[ci].values, value, channel);
                    }
                }

                indices.push_back(newIdx);
            }
        }
        groups.back().count += 3;
    }
    if (outNormals) *outNormals = std::move(normals);
    return !indices.empty();
}

static bool ProbeHairModifierOnNode(INode* node, MaxSDK::IHairModifier*& outHair, MSTR* outSourceClassName = nullptr);

class MaxJSNullView : public View {
public:
    Point2 ViewToScreen(Point3 p) override { return Point2(p.x, p.y); }
    MaxJSNullView() {
        worldToView.IdentityMatrix();
        affineTM.IdentityMatrix();
        screenW = 640.0f;
        screenH = 480.0f;
        projType = 0;
        fov = 0.0f;
        pixelSize = 1.0f;
        flags = 0;
    }
};

static bool ShouldUseHairRenderMeshFallback(INode* node) {
    // Disabled — IsHairEnabled() is unreliable on built-in HairMod.
    // Hair-bearing nodes are now handled exclusively by the strand extraction path.
    (void)node;
    return false;
}

static void ApplyMatrixToVertexBuffer(std::vector<float>& verts, const Matrix3& tm) {
    for (size_t i = 0; i + 2 < verts.size(); i += 3) {
        Point3 p(verts[i + 0], verts[i + 1], verts[i + 2]);
        p = p * tm;
        verts[i + 0] = p.x;
        verts[i + 1] = p.y;
        verts[i + 2] = p.z;
    }
}

static void AppendExtractedGeometry(std::vector<float>& dstVerts,
                                    std::vector<int>& dstIndices,
                                    std::vector<MatGroup>& dstGroups,
                                    const std::vector<float>& srcVerts,
                                    const std::vector<int>& srcIndices,
                                    const std::vector<MatGroup>& srcGroups) {
    const int vertexBase = static_cast<int>(dstVerts.size() / 3);
    const int indexBase = static_cast<int>(dstIndices.size());

    dstVerts.insert(dstVerts.end(), srcVerts.begin(), srcVerts.end());
    for (int idx : srcIndices) {
        dstIndices.push_back(vertexBase + idx);
    }
    for (const MatGroup& group : srcGroups) {
        dstGroups.push_back({ group.matID, indexBase + group.start, group.count });
    }
}

static bool ExtractRenderMeshGeometry(INode* node, TimeValue t,
                                      std::vector<float>& verts,
                                      std::vector<float>& uvs,
                                      std::vector<int>& indices,
                                      std::vector<MatGroup>& groups) {
    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;

    GeomObject* geom = static_cast<GeomObject*>(os.obj);
    MaxJSNullView view;
    bool any = false;

    auto appendMesh = [&](Mesh* mesh, const Matrix3* meshTM) {
        if (!mesh) return;
        std::vector<float> meshVerts, meshUvs;
        std::vector<int> meshIndices;
        std::vector<MatGroup> meshGroups;
        if (!ExtractMeshFromRawMesh(*mesh, meshVerts, meshUvs, meshIndices, meshGroups, nullptr)) return;
        if (meshTM) {
            ApplyMatrixToVertexBuffer(meshVerts, *meshTM);
        }
        AppendExtractedGeometry(verts, indices, groups, meshVerts, meshIndices, meshGroups);
        any = true;
    };

    const int renderMeshCount = geom->NumberOfRenderMeshes();
    if (renderMeshCount > 0) {
        for (int meshIndex = 0; meshIndex < renderMeshCount; ++meshIndex) {
            BOOL needDelete = FALSE;
            Mesh* mesh = geom->GetMultipleRenderMesh(t, node, view, needDelete, meshIndex);
            Matrix3 meshTM;
            Interval meshTMValid = FOREVER;
            geom->GetMultipleRenderMeshTM(t, node, view, meshIndex, meshTM, meshTMValid);
            appendMesh(mesh, &meshTM);
            if (needDelete && mesh) delete mesh;
        }
    } else {
        BOOL needDelete = FALSE;
        Mesh* mesh = geom->GetRenderMesh(t, node, view, needDelete);
        appendMesh(mesh, nullptr);
        if (needDelete && mesh) delete mesh;
    }

    uvs.clear(); // Mixed render meshes may not provide stable UVs; prefer position-only fallback.
    return any && !verts.empty() && !indices.empty();
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
                        std::vector<float>* normals = nullptr,
                        std::vector<int>* controlIdx = nullptr,
                        std::vector<VertexColorAttributeRecord>* outVertexColors = nullptr) {
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return ExtractMeshFromMNMesh(*liveMN, verts, uvs, indices, groups, normals, controlIdx, outVertexColors, allowMapChannel1);
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (ShouldUseHairRenderMeshFallback(node)) {
        return ExtractRenderMeshGeometry(node, t, verts, uvs, indices, groups);
    }

    // Prefer MNMesh path — handles ngons natively without ConvertToType
    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        MNMesh& mn = poly->GetMesh();
        return ExtractMeshFromMNMesh(mn, verts, uvs, indices, groups, normals, controlIdx, outVertexColors, allowMapChannel1);
    }

    // Fallback: convert to TriObject for non-poly geometry (primitives, patches, etc.)
    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;
    return ExtractMeshFromTriObject(tri, os.obj, verts, uvs, indices, groups, controlIdx, outVertexColors, allowMapChannel1);
}

static bool TryHashExtractedRenderableGeometry(INode* node, TimeValue t, uint64_t& outHash) {
    std::vector<float> verts, uvs;
    std::vector<int> indices;
    std::vector<MatGroup> groups;
    std::vector<VertexColorAttributeRecord> vertexColors;
    if (ExtractMesh(node, t, verts, uvs, indices, groups, nullptr, nullptr, &vertexColors)) {
        outHash = HashMeshData(verts, indices, uvs, &vertexColors);
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!ShouldExtractRenderableShape(node, t, &os)) return false;
    if (!ExtractSpline(node, t, verts, indices)) return false;

    outHash = HashMeshData(verts, indices, uvs);
    return true;
}

static bool TryHashRenderableGeometryState(INode* node, TimeValue t, uint64_t& outHash) {
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        outHash = HashMNMeshStateWithUVs(*liveMN, allowMapChannel1);
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj) return false;

    if (os.obj->SuperClassID() == SHAPE_CLASS_ID) {
        return TryHashExtractedRenderableGeometry(node, t, outHash);
    }

    if (os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (ShouldUseHairRenderMeshFallback(node)) {
        return TryHashExtractedRenderableGeometry(node, t, outHash);
    }

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        outHash = HashMNMeshStateWithUVs(poly->GetMesh(), allowMapChannel1);
        return true;
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    outHash = HashMeshStateWithUVs(tri->GetMesh(), allowMapChannel1);
    if (tri != os.obj) tri->DeleteThis();
    return true;
}

static bool NodeHasExtractableVertexColors(INode* node, TimeValue t) {
    if (!node) return false;
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return !CollectMNMeshVertexColorChannels(*liveMN, allowMapChannel1).empty();
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        return !CollectMNMeshVertexColorChannels(poly->GetMesh(), allowMapChannel1).empty();
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;
    const bool hasVertexColors = !CollectMeshVertexColorChannels(tri->GetMesh(), allowMapChannel1).empty();
    if (tri != os.obj) tri->DeleteThis();
    return hasVertexColors;
}

static bool ExtractSkinnedFastPositions(INode* node,
                                        TimeValue t,
                                        const std::vector<int>& controlIdx,
                                        std::vector<float>& outVerts) {
    outVerts.clear();
    if (!node || controlIdx.empty()) return false;

    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        outVerts.resize(controlIdx.size() * 3);
        for (size_t i = 0; i < controlIdx.size(); ++i) {
            const int ci = controlIdx[i];
            if (ci < 0 || ci >= liveMN->VNum()) {
                outVerts.clear();
                return false;
            }
            const Point3 p = liveMN->P(ci);
            outVerts[i * 3 + 0] = p.x;
            outVerts[i * 3 + 1] = p.y;
            outVerts[i * 3 + 2] = p.z;
        }
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        MNMesh& mn = static_cast<PolyObject*>(os.obj)->GetMesh();
        outVerts.resize(controlIdx.size() * 3);
        for (size_t i = 0; i < controlIdx.size(); ++i) {
            const int ci = controlIdx[i];
            if (ci < 0 || ci >= mn.VNum()) {
                outVerts.clear();
                return false;
            }
            const Point3 p = mn.P(ci);
            outVerts[i * 3 + 0] = p.x;
            outVerts[i * 3 + 1] = p.y;
            outVerts[i * 3 + 2] = p.z;
        }
        return true;
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    Mesh& mesh = tri->GetMesh();
    outVerts.resize(controlIdx.size() * 3);
    bool ok = true;
    for (size_t i = 0; i < controlIdx.size(); ++i) {
        const int ci = controlIdx[i];
        if (ci < 0 || ci >= mesh.getNumVerts()) {
            ok = false;
            break;
        }
        const Point3 p = mesh.getVert(ci);
        outVerts[i * 3 + 0] = p.x;
        outVerts[i * 3 + 1] = p.y;
        outVerts[i * 3 + 2] = p.z;
    }

    if (!ok) outVerts.clear();
    if (tri != os.obj) tri->DeleteThis();
    return ok;
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
    // SSE: compare 4 floats at a time (4 iterations for 16 floats)
    __m128 eps = _mm_set1_ps(epsilon);
    for (int i = 0; i < 16; i += 4) {
        __m128 va = _mm_loadu_ps(a + i);
        __m128 vb = _mm_loadu_ps(b + i);
        __m128 diff = _mm_sub_ps(va, vb);
        // abs(diff): clear sign bit
        __m128 absDiff = _mm_andnot_ps(_mm_set1_ps(-0.0f), diff);
        // if any component > epsilon, not equal
        if (_mm_movemask_ps(_mm_cmpgt_ps(absDiff, eps)) != 0)
            return false;
    }
    return true;
}

// Column-major 4x4 multiply (matches THREE.Matrix4.elements layout).
static void MulMat4CM(const float* a, const float* b, float* o) {
    for (int col = 0; col < 4; col++) {
        for (int row = 0; row < 4; row++) {
            float s = 0.0f;
            for (int k = 0; k < 4; k++)
                s += a[k * 4 + row] * b[col * 4 + k];
            o[col * 4 + row] = s;
        }
    }
}

static bool InvertMat4CM(const float m[16], float invOut[16]) {
    double inv[16], det;
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] +
             m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] -
             m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] +
             m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] -
              m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] -
             m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] +
             m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] -
             m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] +
              m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] +
             m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] -
             m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] +
              m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] -
              m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] -
             m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] +
             m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] -
              m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] +
              m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

    det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (std::fabs(det) < 1.0e-20)
        return false;
    det = 1.0 / det;
    for (int i = 0; i < 16; i++)
        invOut[i] = static_cast<float>(inv[i] * det);
    return true;
}

static void DeltaPoint3ToYUp(const Point3& d, float out[3]) {
    // Same linear map as MaxJSPanel::MaxPointToWorld for vectors (no translation).
    out[0] = d.x;
    out[1] = d.z;
    out[2] = -d.y;
}

class FindModifierOnStackEnum : public GeomPipelineEnumProc {
public:
    Class_ID cid;
    Modifier* mod = nullptr;
    explicit FindModifierOnStackEnum(Class_ID id) : cid(id) {}
    PipeEnumResult proc(ReferenceTarget* object, IDerivedObject* derObj, int index) override {
        (void)derObj;
        (void)index;
        if (object && object->ClassID() == cid) {
            mod = dynamic_cast<Modifier*>(object);
            if (mod)
                return PIPE_ENUM_STOP;
        }
        return PIPE_ENUM_CONTINUE;
    }
};

static Modifier* FindModifierOnNode(INode* node, Class_ID cid) {
    if (!node) return nullptr;
    FindModifierOnStackEnum proc(cid);
    EnumGeomPipeline(&proc, node);
    return proc.mod;
}

// Returns stack index of first modifier matching cid on the node's pipeline, or -1.
static int FindModifierStackIndexOnNode(INode* node, Class_ID cid) {
    if (!node) return -1;
    Object* cur = node->GetObjectRef();
    while (cur && (cur->ClassID() == derivObjClassID || cur->ClassID() == WSMDerivObjClassID)) {
        IDerivedObject* d = static_cast<IDerivedObject*>(cur);
        for (int i = 0; i < d->NumModifiers(); ++i) {
            Modifier* m = d->GetModifier(i);
            if (m && m->ClassID() == cid)
                return i;
        }
        cur = d->GetObjRef();
    }
    return -1;
}

static void Mat4IdentityCM(float o[16]) {
    for (int i = 0; i < 16; i++) o[i] = 0.0f;
    o[0] = o[5] = o[10] = o[15] = 1.0f;
}

struct SkinWeightSortPair {
    int boneIdx = 0;
    float w = 0.0f;
};
static bool SkinWeightPairGreater(const SkinWeightSortPair& a, const SkinWeightSortPair& b) {
    return a.w > b.w;
}

// Fills skin + optional morph data for snapshot export. Replaces verts/uvs/norms with bind-pose
// mesh (Skin disabled). Morpher must be applied before Skin (lower stack index than Skin).
static bool TryExtractSkinRigData(
    INode* meshNode,
    TimeValue t,
    std::vector<float>& verts,
    std::vector<float>& uvs,
    std::vector<float>& norms,
    std::vector<int>& indices,
    std::vector<MatGroup>& groups,
    std::vector<ULONG>& outBoneHandles,
    std::vector<int>& outBoneParents,
    std::vector<float>& outBoneBindLocal,
    std::vector<float>& outSkinW,
    std::vector<float>& outSkinIdx,
    std::vector<std::wstring>& outMorphNames,
    std::vector<int>& outMorphChannelIds,
    std::vector<float>& outMorphInfl,
    std::vector<std::vector<float>>& outMorphDeltas) {
    outBoneHandles.clear();
    outBoneParents.clear();
    outBoneBindLocal.clear();
    outSkinW.clear();
    outSkinIdx.clear();
    outMorphNames.clear();
    outMorphChannelIds.clear();
    outMorphInfl.clear();
    outMorphDeltas.clear();

    Modifier* skinMod = FindModifierOnNode(meshNode, SKIN_CLASSID);
    if (!skinMod) return false;

    ISkin* skin = static_cast<ISkin*>(skinMod->GetInterface(I_SKIN));
    if (!skin) return false;

    // Disable Skin to get undeformed bind pose mesh.
    // controlIdx maps split render vertices back to control vertices for skin weight lookup.
    skinMod->DisableMod();
    std::vector<float> bindVerts, bindUvs, bindNorms;
    std::vector<int> bindIdx, controlIdx;
    std::vector<MatGroup> bindGroups;
    const bool bindOk = ExtractMesh(meshNode, t, bindVerts, bindUvs, bindIdx, bindGroups, &bindNorms, &controlIdx);
    skinMod->EnableMod();
    if (!bindOk) return false;

    const int vCount = static_cast<int>(bindVerts.size() / 3);
    if (vCount <= 0) return false;

    verts = std::move(bindVerts);
    uvs = std::move(bindUvs);
    norms = std::move(bindNorms);
    indices = std::move(bindIdx);
    groups = std::move(bindGroups);

    ISkinContextData* skinData = skin->GetContextInterface(meshNode);
    if (!skinData) return false;
    if (static_cast<int>(controlIdx.size()) != vCount) return false;

    const int numBones = skin->GetNumBones();
    if (numBones <= 0) return false;

    std::vector<INode*> boneNodes;
    {
        boneNodes.resize(static_cast<size_t>(numBones), nullptr);
        outBoneHandles.resize(static_cast<size_t>(numBones));
        std::unordered_map<ULONG, int> handleToSkinIndex;
        for (int bi = 0; bi < numBones; bi++) {
            INode* bn = skin->GetBone(bi);
            boneNodes[static_cast<size_t>(bi)] = bn;
            outBoneHandles[static_cast<size_t>(bi)] = bn ? bn->GetHandle() : 0;
            if (bn) handleToSkinIndex[bn->GetHandle()] = bi;
        }

        outBoneParents.resize(static_cast<size_t>(numBones), -1);
        for (int bi = 0; bi < numBones; bi++) {
            INode* bn = boneNodes[static_cast<size_t>(bi)];
            if (!bn) {
                outBoneParents[static_cast<size_t>(bi)] = -1;
                continue;
            }
            INode* par = bn->GetParentNode();
            if (!par) {
                outBoneParents[static_cast<size_t>(bi)] = -1;
                continue;
            }
            auto it = handleToSkinIndex.find(par->GetHandle());
            outBoneParents[static_cast<size_t>(bi)] =
                (it != handleToSkinIndex.end()) ? it->second : -1;
        }

        // Use ISkin::GetBoneInitTM for true bind pose — the bone transforms from
        // when the Skin modifier was set up, independent of current animation frame.
        auto MatrixToFloat16 = [](const Matrix3& tm, float out[16]) {
            Point3 r0 = tm.GetRow(0), r1 = tm.GetRow(1), r2 = tm.GetRow(2), tr = tm.GetTrans();
            out[0]=r0.x; out[1]=r0.y; out[2]=r0.z; out[3]=0;
            out[4]=r1.x; out[5]=r1.y; out[6]=r1.z; out[7]=0;
            out[8]=r2.x; out[9]=r2.y; out[10]=r2.z; out[11]=0;
            out[12]=tr.x; out[13]=tr.y; out[14]=tr.z; out[15]=1;
        };

        std::vector<float> boneWorld(static_cast<size_t>(numBones) * 16u);
        for (int bi = 0; bi < numBones; bi++) {
            INode* bn = boneNodes[static_cast<size_t>(bi)];
            if (bn) {
                Matrix3 initTM;
                if (skin->GetBoneInitTM(bn, initTM) == SKIN_OK) {
                    MatrixToFloat16(initTM, &boneWorld[static_cast<size_t>(bi) * 16u]);
                } else {
                    GetTransform16(bn, t, &boneWorld[static_cast<size_t>(bi) * 16u]);
                }
            } else {
                Mat4IdentityCM(&boneWorld[static_cast<size_t>(bi) * 16u]);
            }
        }

        // Get mesh's initial transform from Skin for root bone parent
        float meshInitWorld[16];
        {
            Matrix3 skinInitTM;
            if (skin->GetSkinInitTM(meshNode, skinInitTM) == SKIN_OK) {
                MatrixToFloat16(skinInitTM, meshInitWorld);
            } else {
                GetTransform16(meshNode, t, meshInitWorld);
            }
        }

        outBoneBindLocal.resize(static_cast<size_t>(numBones) * 16u);
        for (int bi = 0; bi < numBones; bi++) {
            INode* bn = boneNodes[static_cast<size_t>(bi)];
            if (!bn) {
                Mat4IdentityCM(&outBoneBindLocal[static_cast<size_t>(bi) * 16u]);
                continue;
            }
            float parentWorld[16];
            const int pi = outBoneParents[static_cast<size_t>(bi)];
            if (pi >= 0 && pi < numBones && boneNodes[static_cast<size_t>(pi)]) {
                memcpy(parentWorld, &boneWorld[static_cast<size_t>(pi) * 16u], sizeof(float) * 16);
            } else {
                // Root bone: parent in Three.js is the SkinnedMesh → use mesh init transform
                memcpy(parentWorld, meshInitWorld, sizeof(float) * 16);
            }
            float invParent[16];
            if (!InvertMat4CM(parentWorld, invParent))
                Mat4IdentityCM(invParent);
            MulMat4CM(invParent, &boneWorld[static_cast<size_t>(bi) * 16u], &outBoneBindLocal[static_cast<size_t>(bi) * 16u]);
        }

        outSkinW.resize(static_cast<size_t>(vCount) * 4u, 0.0f);
        outSkinIdx.resize(static_cast<size_t>(vCount) * 4u, 0.0f);
        std::vector<SkinWeightSortPair> pairs;
        const int nPts = skinData->GetNumPoints();
        for (int vi = 0; vi < vCount; vi++) {
            // Map split render vertex → control vertex for skin weight lookup
            const int ci = (vi < static_cast<int>(controlIdx.size())) ? controlIdx[vi] : vi;
            if (ci < 0 || ci >= nPts) continue;  // out of range safety
            pairs.clear();
            const int nb = skinData->GetNumAssignedBones(ci);
            for (int j = 0; j < nb; j++) {
                const int bSkin = skinData->GetAssignedBone(ci, j);
                const float w = skinData->GetBoneWeight(ci, j);
                if (bSkin < 0 || bSkin >= numBones || w <= 0.0f) continue;
                SkinWeightSortPair p;
                p.boneIdx = bSkin;
                p.w = w;
                pairs.push_back(p);
            }
            std::sort(pairs.begin(), pairs.end(), SkinWeightPairGreater);
            float sum = 0.0f;
            const int take = std::min(4, static_cast<int>(pairs.size()));
            for (int k = 0; k < take; k++) sum += pairs[static_cast<size_t>(k)].w;
            if (sum < 1.0e-8f) sum = 1.0f;
            for (int k = 0; k < 4; k++) {
                if (k < take) {
                    outSkinIdx[static_cast<size_t>(vi) * 4u + static_cast<size_t>(k)] =
                        static_cast<float>(pairs[static_cast<size_t>(k)].boneIdx);
                    outSkinW[static_cast<size_t>(vi) * 4u + static_cast<size_t>(k)] =
                        pairs[static_cast<size_t>(k)].w / sum;
                } else {
                    outSkinIdx[static_cast<size_t>(vi) * 4u + static_cast<size_t>(k)] = 0.0f;
                    outSkinW[static_cast<size_t>(vi) * 4u + static_cast<size_t>(k)] = 0.0f;
                }
            }
        }
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
    float fov;         // degrees (horizontal) for perspective
    float viewWidth;   // world-unit width for orthographic
    bool perspective;
    // DOF from Physical Camera
    bool dofEnabled;
    float dofFocusDistance;  // world units
    float dofFocalLength;   // Three.js DOF transition zone, world units
    float dofBokehScale;    // artistic bokeh size multiplier
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
    cam.viewWidth = cam.perspective ? 0.0f : vp.GetVPWorldWidth(tgt);

    // Raw Z-up coordinates — JS handles conversion
    cam.pos[0] = pos.x;    cam.pos[1] = pos.y;    cam.pos[2] = pos.z;
    cam.target[0] = tgt.x; cam.target[1] = tgt.y;  cam.target[2] = tgt.z;
    cam.up[0] = up.x;      cam.up[1] = up.y;       cam.up[2] = up.z;

    // DOF from Physical Camera
    cam.dofEnabled = false;
    cam.dofFocusDistance = 0.0f;
    cam.dofFocalLength = 0.0f;
    cam.dofBokehScale = 0.0f;

    INode* camNode = vp.GetViewCamera();
    if (camNode && cam.perspective) {
        TimeValue t = ip->GetTime();
        ObjectState os = camNode->EvalWorldState(t);
        // Use IPhysicalCamera API — Class_ID differs across Max versions; ParamBlock indices are not stable.
        MaxSDK::IPhysicalCamera* phys = dynamic_cast<MaxSDK::IPhysicalCamera*>(os.obj);
        if (phys) {
            Interval iv = FOREVER;
            cam.dofEnabled = phys->GetDOFEnabled(t, iv);

            if (cam.dofEnabled) {
                iv = FOREVER;
                float focusDist = phys->GetFocusDistance(t, iv);
                if (focusDist < 1e-4f) focusDist = 5.0f;

                iv = FOREVER;
                float fNumber = phys->GetLensApertureFNumber(t, iv);
                if (fNumber < 1e-4f) fNumber = 8.0f;

                iv = FOREVER;
                float focalLenSU = phys->GetEffectiveLensFocalLength(t, iv);
                if (focalLenSU < 1e-6f) focalLenSU = 0.04f;

                iv = FOREVER;
                float filmW = phys->GetFilmWidth(t, iv);
                double mmPerSU = GetSystemUnitScale(UNITS_MILLIMETERS);
                if (mmPerSU < 1e-9) mmPerSU = 1.0;
                if (filmW < 1e-6f) filmW = 36.0f / (float)mmPerSU;

                float cocSU = filmW / 1500.0f;

                float dofHalf = 0.0f;
                if (focalLenSU > 1e-6f) {
                    dofHalf = fNumber * cocSU * focusDist * focusDist / (focalLenSU * focalLenSU);
                }

                cam.dofFocusDistance = focusDist;
                cam.dofFocalLength = std::clamp(dofHalf, 0.01f, focusDist * 10.0f);
                float focalMM = focalLenSU * (float)mmPerSU;
                cam.dofBokehScale = std::clamp(focalMM / fNumber, 0.5f, 30.0f);
            }
        }
    }
}

static bool GetSceneCameraData(INode* camNode, TimeValue t, CameraData& cam) {
    if (!camNode) return false;
    ObjectState os = camNode->EvalWorldState(t);
    if (!os.obj) return false;

    // Must be a camera superclass
    SClass_ID sc = os.obj->SuperClassID();
    if (sc != CAMERA_CLASS_ID) return false;

    GenCamera* genCam = dynamic_cast<GenCamera*>(os.obj);

    Matrix3 camTM = camNode->GetNodeTM(t);
    Point3 pos = camTM.GetTrans();
    Point3 fwd = -Normalize(camTM.GetRow(2));
    Point3 up  = Normalize(camTM.GetRow(1));

    // Target distance: use target node if it exists, otherwise default
    float targetDist = 100.0f;
    if (camNode->GetTarget()) {
        Point3 tgtPos = camNode->GetTarget()->GetNodeTM(t).GetTrans();
        targetDist = Length(tgtPos - pos);
        if (targetDist < 1.0f) targetDist = 100.0f;
    }
    Point3 tgt = pos + fwd * targetDist;

    cam.pos[0] = pos.x;    cam.pos[1] = pos.y;    cam.pos[2] = pos.z;
    cam.target[0] = tgt.x; cam.target[1] = tgt.y;  cam.target[2] = tgt.z;
    cam.up[0] = up.x;      cam.up[1] = up.y;       cam.up[2] = up.z;

    // FOV
    cam.perspective = true;
    cam.viewWidth = 0.0f;
    if (genCam) {
        float fovRad = genCam->GetFOV(t);
        cam.fov = fovRad * (180.0f / 3.14159265f);
        if (genCam->IsOrtho()) {
            cam.perspective = false;
            cam.viewWidth = targetDist * 2.0f;
        }
    } else {
        cam.fov = 45.0f;
    }

    // DOF from Physical Camera
    cam.dofEnabled = false;
    cam.dofFocusDistance = 0.0f;
    cam.dofFocalLength = 0.0f;
    cam.dofBokehScale = 0.0f;

    MaxSDK::IPhysicalCamera* phys = dynamic_cast<MaxSDK::IPhysicalCamera*>(os.obj);
    if (phys && cam.perspective) {
        Interval iv = FOREVER;
        cam.dofEnabled = phys->GetDOFEnabled(t, iv);
        if (cam.dofEnabled) {
            iv = FOREVER;
            float focusDist = phys->GetFocusDistance(t, iv);
            if (focusDist < 1e-4f) focusDist = 5.0f;

            iv = FOREVER;
            float fNumber = phys->GetLensApertureFNumber(t, iv);
            if (fNumber < 1e-4f) fNumber = 8.0f;

            iv = FOREVER;
            float focalLenSU = phys->GetEffectiveLensFocalLength(t, iv);
            if (focalLenSU < 1e-6f) focalLenSU = 0.04f;

            iv = FOREVER;
            float filmW = phys->GetFilmWidth(t, iv);
            double mmPerSU = GetSystemUnitScale(UNITS_MILLIMETERS);
            if (mmPerSU < 1e-9) mmPerSU = 1.0;
            if (filmW < 1e-6f) filmW = 36.0f / (float)mmPerSU;

            float cocSU = filmW / 1500.0f;
            float dofHalf = 0.0f;
            if (focalLenSU > 1e-6f) {
                dofHalf = fNumber * cocSU * focusDist * focusDist / (focalLenSU * focalLenSU);
            }

            cam.dofFocusDistance = focusDist;
            cam.dofFocalLength = std::clamp(dofHalf, 0.01f, focusDist * 10.0f);
            float focalMM = focalLenSU * (float)mmPerSU;
            cam.dofBokehScale = std::clamp(focalMM / fNumber, 0.5f, 30.0f);
        }
    }
    return true;
}

static bool IsSceneCameraNode(INode* node) {
    if (!node) return false;
    ObjectState os = node->EvalWorldState(GetCOREInterface()->GetTime());
    return os.obj && os.obj->SuperClassID() == CAMERA_CLASS_ID;
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
    if (a.perspective != b.perspective) return false;
    if (a.dofEnabled != b.dofEnabled) return false;
    if (a.dofEnabled) {
        if (!NearlyEqualFloat(a.dofFocusDistance, b.dofFocusDistance, 0.01f)) return false;
        if (!NearlyEqualFloat(a.dofFocalLength, b.dofFocalLength, 0.01f)) return false;
        if (!NearlyEqualFloat(a.dofBokehScale, b.dofBokehScale, 0.01f)) return false;
    }
    return true;
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
        // Material validity can flap from editor-preview churn. Actual material changes
        // are tracked through the dedicated material sync paths instead.
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

static void CollectReferenceTargetsForNodeObjectGraph(INode* node,
                                                      std::unordered_set<ReferenceTarget*>& out) {
    if (!node) return;
    Object* obj = node->GetObjectRef();
    while (obj) {
        if (obj->IsRefTarget()) {
            out.insert(static_cast<ReferenceTarget*>(obj));
        }
        if (obj->SuperClassID() != GEN_DERIVOB_CLASS_ID) break;
        obj = static_cast<IDerivedObject*>(obj)->GetObjRef();
    }
}

static bool ReferenceGraphContainsAnyTarget(ReferenceMaker* maker,
                                            const std::unordered_set<ReferenceTarget*>& targets,
                                            std::unordered_set<const void*>& visited,
                                            int depth = 0) {
    if (!maker || targets.empty() || depth > 12) return false;
    if (!visited.insert(maker).second) return false;

    if (maker->IsRefTarget()) {
        ReferenceTarget* asTarget = static_cast<ReferenceTarget*>(maker);
        if (targets.find(asTarget) != targets.end()) {
            return true;
        }
    }

    const int numRefs = maker->NumRefs();
    for (int i = 0; i < numRefs; ++i) {
        RefTargetHandle ref = maker->GetReference(i);
        if (!ref) continue;
        if (targets.find(ref) != targets.end()) {
            return true;
        }
        if (ReferenceGraphContainsAnyTarget(ref, targets, visited, depth + 1)) {
            return true;
        }
    }
    return false;
}

static bool HasConsumptiveDependentRecursive(ReferenceMaker* maker,
                                             INode* targetNode,
                                             const std::unordered_set<ReferenceTarget*>& targetRefs,
                                             TimeValue t,
                                             std::unordered_set<const void*>& visited,
                                             int depth = 0) {
    if (!maker || depth > 10) return false;
    if (!visited.insert(maker).second) return false;

    if (maker->SuperClassID() == BASENODE_CLASS_ID) {
        INode* depNode = static_cast<INode*>(maker);
        if (depNode != targetNode) {
            ObjectState depOs = depNode->EvalWorldState(t);
            const bool geometryConsumer =
                depOs.obj && depOs.obj->SuperClassID() == GEOMOBJECT_CLASS_ID;
            if (geometryConsumer) {
                std::unordered_set<const void*> refVisited;
                if (ReferenceGraphContainsAnyTarget(static_cast<ReferenceMaker*>(depNode->GetObjectRef()), targetRefs, refVisited, 0)) {
                    return true;
                }
            }
        }
    }

    if (!maker->IsRefTarget()) return false;
    DependentIterator iter(static_cast<ReferenceTarget*>(maker));
    for (ReferenceMaker* dep = iter.Next(); dep; dep = iter.Next()) {
        if (HasConsumptiveDependentRecursive(dep, targetNode, targetRefs, t, visited, depth + 1)) {
            return true;
        }
    }
    return false;
}

static bool IsShapeConsumedByOtherRuntimeNode(INode* node, TimeValue t) {
    if (!node) return false;
    std::unordered_set<ReferenceTarget*> targetRefs;
    CollectReferenceTargetsForNodeObjectGraph(node, targetRefs);
    if (targetRefs.empty()) return false;

    std::unordered_set<const void*> visited;
    Object* objRef = node->GetObjectRef();
    if (!objRef || !objRef->IsRefTarget()) return false;
    DependentIterator iter(static_cast<ReferenceTarget*>(objRef));
    for (ReferenceMaker* dep = iter.Next(); dep; dep = iter.Next()) {
        if (HasConsumptiveDependentRecursive(dep, node, targetRefs, t, visited, 0)) {
            return true;
        }
    }
    return false;
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

// ══════════════════════════════════════════════════════════════
//  Hair And Fur Modifier Extraction
// ══════════════════════════════════════════════════════════════

static void HairDebugLog(const std::wstring& line) {
#ifndef _DEBUG
    (void)line;
    return;
#else
    static std::mutex sMutex;
    std::lock_guard<std::mutex> lock(sMutex);
    wchar_t tempPath[MAX_PATH] = {};
    DWORD tempLen = GetTempPathW(static_cast<DWORD>(std::size(tempPath)), tempPath);
    if (!tempLen || tempLen >= std::size(tempPath)) return;
    std::wstring logPath(tempPath);
    if (!logPath.empty() && logPath.back() != L'\\' && logPath.back() != L'/') logPath += L'\\';
    logPath += L"maxjs_hair_debug.log";
    HANDLE h = CreateFileW(logPath.c_str(),
        FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, nullptr, FILE_END);
    const std::string utf8 = WideToUtf8(line + L"\r\n");
    DWORD written = 0;
    WriteFile(h, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
    CloseHandle(h);
#endif
}

class FindHairModifierOnStackEnum : public GeomPipelineEnumProc {
public:
    MaxSDK::IHairModifier* hair = nullptr;
    MSTR sourceClassName;
    bool dumpAll = false;
    int stepCount = 0;
    PipeEnumResult proc(ReferenceTarget* object, IDerivedObject* derObj, int index) override {
        (void)derObj;
        stepCount++;
        if (!object) {
            if (dumpAll) {
                std::wostringstream ss;
                ss << L"  step[" << stepCount << L"] object=<null> derObj=" << (derObj ? L"yes" : L"no") << L" idx=" << index;
                HairDebugLog(ss.str());
            }
            return PIPE_ENUM_CONTINUE;
        }
        const Class_ID cid = object->ClassID();
        const SClass_ID sid = object->SuperClassID();
        MaxSDK::IHairModifier* maybeHair = dynamic_cast<MaxSDK::IHairModifier*>(object);
        if (dumpAll) {
            std::wostringstream ss;
            ss << L"  step[" << stepCount << L"] class=" << object->ClassName().data()
               << L" sid=0x" << std::hex << sid << std::dec
               << L" cid=(" << cid.PartA() << L"," << cid.PartB() << L")"
               << L" idx=" << index
               << L" hairCast=" << (maybeHair ? L"YES" : L"no");
            HairDebugLog(ss.str());
        }
        if (maybeHair && !hair) {
            hair = maybeHair;
            sourceClassName = object->ClassName();
        }
        return PIPE_ENUM_CONTINUE; // walk full stack so we see everything
    }
};

static MaxSDK::IHairModifier* FindHairModifierOnNode(INode* node) {
    if (!node) return nullptr;
    FindHairModifierOnStackEnum proc;
    EnumGeomPipeline(&proc, node);
    return proc.hair;
}

static bool ProbeHairModifierOnNode(INode* node, MaxSDK::IHairModifier*& outHair, MSTR* outSourceClassName) {
    outHair = nullptr;
    if (!node) return false;
    FindHairModifierOnStackEnum proc;
    EnumGeomPipeline(&proc, node);
    outHair = proc.hair;
    if (outSourceClassName) {
        *outSourceClassName = proc.sourceClassName;
    }
    return outHair != nullptr;
}

static bool HasEnabledHairModifier(INode* node) {
    MaxSDK::IHairModifier* hair = FindHairModifierOnNode(node);
    return hair && hair->IsHairEnabled();
}

static bool SafeNormalizePoint3(Point3& value, float eps = 1.0e-6f) {
    const float lenSq = DotProd(value, value);
    if (lenSq <= eps * eps) return false;
    value *= 1.0f / std::sqrt(lenSq);
    return true;
}

static Point3 FallbackHairNormal(const Point3& tangent) {
    Point3 normal = CrossProd(tangent, Point3(0.0f, 0.0f, 1.0f));
    if (!SafeNormalizePoint3(normal)) {
        normal = CrossProd(tangent, Point3(0.0f, 1.0f, 0.0f));
        if (!SafeNormalizePoint3(normal)) {
            normal = Point3(1.0f, 0.0f, 0.0f);
        }
    }
    return normal;
}

static void WriteBasisTransform16(const Point3& basisX,
                                  const Point3& basisY,
                                  const Point3& basisZ,
                                  const Point3& translation,
                                  float out[16]) {
    out[0] = basisX.x; out[1] = basisX.y; out[2] = basisX.z; out[3] = 0.0f;
    out[4] = basisY.x; out[5] = basisY.y; out[6] = basisY.z; out[7] = 0.0f;
    out[8] = basisZ.x; out[9] = basisZ.y; out[10] = basisZ.z; out[11] = 0.0f;
    out[12] = translation.x; out[13] = translation.y; out[14] = translation.z; out[15] = 1.0f;
}

static void FillHairPBR(INode* node,
                        TimeValue t,
                        const MaxSDK::IHairModifier::ShadingParameters& shading,
                        MaxJSPBR& outPbr) {
    outPbr = MaxJSPBR();
    outPbr.materialModel = L"MeshPhysicalMaterial";
    outPbr.doubleSided = true;
    outPbr.color[0] = 1.0f;
    outPbr.color[1] = 1.0f;
    outPbr.color[2] = 1.0f;
    outPbr.roughness = std::clamp(1.0f - shading.gloss, 0.02f, 1.0f);
    outPbr.physicalSpecularIntensity = std::clamp(shading.specular, 0.0f, 1.0f);
    outPbr.physicalSpecularColor[0] = std::max(0.0f, shading.specular_tint.r);
    outPbr.physicalSpecularColor[1] = std::max(0.0f, shading.specular_tint.g);
    outPbr.physicalSpecularColor[2] = std::max(0.0f, shading.specular_tint.b);
    outPbr.opacity = 1.0f;

    if (shading.shader) {
        ExtractPBRFromMtl(shading.shader, node, t, outPbr);
        outPbr.doubleSided = true;
    }
}

struct HairInstanceGroup {
    ULONG handle = 0;
    bool visible = true;
    int instanceCount = 0;
    float nodeTransform[16] = {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    std::vector<float> transforms;
    std::vector<float> colors;
    MaxJSPBR pbr;
};

static bool ExtractHairInstances(INode* node,
                                 TimeValue t,
                                 std::vector<HairInstanceGroup>& outGroups) {
    MaxSDK::IHairModifier* hair = FindHairModifierOnNode(node);
    if (!hair) return false;
    // NOTE: ignore IsHairEnabled() — the built-in HairMod returns false even when
    // hair primitives ARE available via GetHairDefinition. Empirically, calling
    // GetHairDefinition unconditionally is the only way to actually retrieve the strands.

    MaxSDK::Array<unsigned int> perHairVertexCount;
    MaxSDK::Array<Point3> vertices;
    MaxSDK::Array<float> perVertexRadius;
    MaxSDK::Array<Color> perVertexColor;
    MaxSDK::Array<Point3> perVertexNormal;
    MaxSDK::Array<Point3> perVertexVelocity;
    MaxSDK::Array<float> perVertexOpacity;
    MaxSDK::Array<Point2> perVertexUv;

    const bool getDefOk = hair->GetHairDefinition(t, *node,
                                 perHairVertexCount, vertices, perVertexRadius,
                                 perVertexColor, perVertexNormal, perVertexVelocity,
                                 perVertexOpacity, perVertexUv);
    {
        std::wostringstream ss;
        ss << L"  GetHairDefinition: ok=" << (getDefOk ? L"1" : L"0")
           << L" strands=" << perHairVertexCount.length()
           << L" verts=" << vertices.length()
           << L" radii=" << perVertexRadius.length()
           << L" normals=" << perVertexNormal.length()
           << L" colors=" << perVertexColor.length();
        if (vertices.length() > 0) {
            const Point3& v0 = vertices[0];
            ss << L" v0=(" << v0.x << L"," << v0.y << L"," << v0.z << L")";
        }
        HairDebugLog(ss.str());
    }
    if (!getDefOk) return false;

    if (perHairVertexCount.length() <= 0 || vertices.length() <= 0) return false;

    HairInstanceGroup group;
    group.handle = node->GetHandle();
    group.visible = IsMaxJsSyncDrawVisible(node);
    GetTransform16(node, t, group.nodeTransform);

    Interval hairValidity = FOREVER;
    FillHairPBR(node, t, hair->GetShadingParameters(t, hairValidity), group.pbr);

    double opacitySum = 0.0;
    size_t opacityCount = 0;
    size_t vertexBase = 0;

    for (size_t hairIndex = 0; hairIndex < perHairVertexCount.length(); ++hairIndex) {
        const unsigned int vertexCount = perHairVertexCount[hairIndex];
        if (vertexCount < 2 || (vertexBase + vertexCount) > vertices.length()) {
            vertexBase += vertexCount;
            continue;
        }

        const Point3 root = vertices[vertexBase];
        Point3 tangentSum(0.0f, 0.0f, 0.0f);
        float totalLength = 0.0f;

        for (unsigned int vi = 1; vi < vertexCount; ++vi) {
            Point3 segment = vertices[vertexBase + vi] - vertices[vertexBase + vi - 1];
            const float segLen = Length(segment);
            if (segLen <= 1.0e-5f) continue;
            tangentSum += segment;
            totalLength += segLen;
        }

        if (totalLength <= 1.0e-5f || !SafeNormalizePoint3(tangentSum)) {
            vertexBase += vertexCount;
            continue;
        }

        Point3 normalSum(0.0f, 0.0f, 0.0f);
        if (perVertexNormal.length() == vertices.length()) {
            for (unsigned int vi = 0; vi < vertexCount; ++vi) {
                normalSum += perVertexNormal[vertexBase + vi];
            }
        }
        normalSum -= tangentSum * DotProd(normalSum, tangentSum);
        if (!SafeNormalizePoint3(normalSum)) {
            normalSum = FallbackHairNormal(tangentSum);
        }

        Point3 side = CrossProd(normalSum, tangentSum);
        if (!SafeNormalizePoint3(side)) {
            normalSum = FallbackHairNormal(tangentSum);
            side = CrossProd(normalSum, tangentSum);
            if (!SafeNormalizePoint3(side)) {
                vertexBase += vertexCount;
                continue;
            }
        }

        float radiusSum = 0.0f;
        int radiusCount = 0;
        if (perVertexRadius.length() == vertices.length()) {
            for (unsigned int vi = 0; vi < vertexCount; ++vi) {
                radiusSum += std::max(0.0f, perVertexRadius[vertexBase + vi]);
                radiusCount++;
            }
        }
        const float avgRadius = radiusCount > 0 ? (radiusSum / static_cast<float>(radiusCount)) : 0.0f;
        const float widthFromRadius = avgRadius * 2.0f;
        const float widthFromLength = totalLength * 0.035f;
        const float bladeWidth = std::max(std::max(widthFromRadius, widthFromLength), 0.25f);

        float matrix[16];
        WriteBasisTransform16(side * bladeWidth, tangentSum * totalLength, normalSum, root, matrix);
        group.transforms.insert(group.transforms.end(), matrix, matrix + 16);

        float color[3] = { group.pbr.color[0], group.pbr.color[1], group.pbr.color[2] };
        if (perVertexColor.length() == vertices.length()) {
            Point3 strandColor(0.0f, 0.0f, 0.0f);
            for (unsigned int vi = 0; vi < vertexCount; ++vi) {
                const Color c = perVertexColor[vertexBase + vi];
                strandColor += Point3(c.r, c.g, c.b);
            }
            strandColor *= (1.0f / static_cast<float>(vertexCount));
            color[0] = std::max(0.0f, strandColor.x);
            color[1] = std::max(0.0f, strandColor.y);
            color[2] = std::max(0.0f, strandColor.z);
        }
        group.colors.insert(group.colors.end(), color, color + 3);

        if (perVertexOpacity.length() == vertices.length()) {
            float strandOpacity = 0.0f;
            for (unsigned int vi = 0; vi < vertexCount; ++vi) {
                strandOpacity += std::clamp(perVertexOpacity[vertexBase + vi], 0.0f, 1.0f);
            }
            opacitySum += strandOpacity / static_cast<float>(vertexCount);
            opacityCount++;
        }

        group.instanceCount++;
        vertexBase += vertexCount;
    }

    if (group.instanceCount <= 0) return false;

    if (opacityCount > 0) {
        group.pbr.opacity = static_cast<float>(std::clamp(opacitySum / static_cast<double>(opacityCount), 0.0, 1.0));
    }

    outGroups.push_back(std::move(group));
    return true;
}

// ── JS Modifier detection (three.js Deform in modifier stack) ──
struct JsModData {
    bool found = false;
};

static void GetJsModData(INode* node, TimeValue t, JsModData& out) {
    out = {};
    Object* obj = node->GetObjectRef();
    while (obj && obj->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
        IDerivedObject* dobj = static_cast<IDerivedObject*>(obj);
        for (int i = 0; i < dobj->NumModifiers(); i++) {
            Modifier* mod = dobj->GetModifier(i);
            if (mod && mod->IsEnabled() && IsThreeJSDeformClassID(mod->ClassID())) {
                out.found = true;
                return;
            }
        }
        obj = dobj->GetObjRef();
    }
}

static void WriteJsModJson(std::wostringstream& ss, const JsModData&) {
    ss << L"\"jsmod\":true";
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
    std::unordered_set<ULONG> audioHandles_;
    std::unordered_set<ULONG> gltfHandles_;
    std::unordered_set<ULONG> hairHandles_;
    // Meshes with a modifier stack whose output can change between frames
    // independent of transform events (Path Deform, Skin, Bend, FFD, etc.).
    // Polled every redraw so animation playback catches deformation without
    // waiting for DetectGeometryChanges (~500ms) to run.
    std::unordered_set<ULONG> deformHandles_;
    std::unordered_set<ULONG> fastDirtyHandles_;
    std::unordered_set<ULONG> visibilityDirtyHandles_;
    std::unordered_map<ULONG, std::array<float, 16>> lastSentTransforms_;
    std::unordered_map<ULONG, uint64_t> mtlHashMap_;   // node handle → material structure hash
    std::unordered_map<ULONG, uint64_t> mtlScalarHashMap_; // node handle → fast-sync scalar hash
    std::unordered_map<ULONG, uint64_t> lightHashMap_; // node handle → light state hash
    std::unordered_map<ULONG, uint64_t> splatHashMap_; // node handle → splat source state hash
    std::unordered_map<ULONG, uint64_t> audioHashMap_; // node handle → audio source state hash
    std::unordered_map<ULONG, uint64_t> gltfHashMap_;  // node handle → gltf source state hash
    std::unordered_map<ULONG, uint64_t> geoHashMap_;   // node handle → geometry topology hash
    std::unordered_map<ULONG, std::vector<MatGroup>> groupCache_; // cached material groups per node
    std::unordered_map<ULONG, uint64_t> propHashMap_;  // node handle → object properties hash
    std::unordered_map<ULONG, bool> jsmodStateMap_;    // node handle → last-seen three.js Deform flag
    std::unordered_set<ULONG> skinnedHandles_;             // geom handles with Skin modifier
    std::unordered_map<ULONG, std::vector<int>> skinnedControlIdxCache_; // render vertex -> control vertex
    ULONGLONG lastSkinnedLivePollTick_ = 0;
    ULONGLONG lastInteractionTick_ = 0;
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
    int suppressProjectReloadCount_ = 0;
    bool fastCameraDirty_ = false;
    bool fastFlushPosted_ = false;
    bool haveLastSentCamera_ = false;
    ULONGLONG dirtyStamp_ = 0;   // when dirty_ was last set (for debounce)
    ULONGLONG lastMaterialInteractionTick_ = 0;
    ULONGLONG lastMaterialLivePollTick_ = 0;
    CameraData lastSentCamera_ = {};
    ULONG lockedCameraHandle_ = 0;  // 0 = viewport (default), nonzero = scene camera handle
    SceneEventNamespace::CallbackKey fastNodeEventCallbackKey_ = 0;
    bool callbacksRegistered_ = false;
    MaxJSFastNodeEventCallback fastNodeEvents_;
    MaxJSFastRedrawCallback fastRedrawCallback_;
    MaxJSFastTimeChangeCallback fastTimeChangeCallback_;

    // ── Inline layer scan state ────────────────────────
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

    static std::wstring GetLegacyInlineLayerDir() {
        wchar_t temp[MAX_PATH];
        GetTempPathW(MAX_PATH, temp);
        return std::wstring(temp) + L"maxjs_layers\\";
    }

    std::wstring GetInlineLayerDir() {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) return {};
        return projectDir + L"\\inlines\\";
    }

    std::wstring GetInlineHotLayerDir() {
        // Source of truth for inline-layer scan/rename/inject is the
        // scene-local `inlines/` folder. The legacy %TEMP% location is
        // only kept around for the one-shot migration in
        // MigrateLegacyInlineLayers().
        return GetInlineLayerDir();
    }

    struct InlineLayerScanEntry {
        std::wstring id;           // raw filename (sans extension) — stable identity, incl. NN_ prefix
        std::wstring displayName;  // NN_ prefix stripped
        std::wstring folder;       // forward-slash path relative to inlines/, empty for top-level
        int priority;              // 100 default, from NN_ prefix
        bool enabled;
    };

    static void ScanInlineLayersRecursive(const std::wstring& rootDir,
                                          const std::wstring& subPath,
                                          std::vector<InlineLayerScanEntry>& out) {
        const std::wstring dir = rootDir + subPath;
        if (!DirectoryExists(dir)) return;
        const std::wstring pattern = dir + L"*";
        WIN32_FIND_DATAW fd = {};
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind == INVALID_HANDLE_VALUE) return;
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                const std::wstring nextSub = subPath + fd.cFileName + L"\\";
                ScanInlineLayersRecursive(rootDir, nextSub, out);
                continue;
            }

            std::wstring id;
            bool enabled = false;
            if (!TryParseInlineLayerFileName(fd.cFileName, id, enabled)) continue;

            InlineLayerScanEntry entry;
            entry.id = id;
            entry.priority = ParseInlinePriorityPrefix(id, entry.displayName);
            entry.enabled = enabled;

            std::wstring folder = subPath;
            std::replace(folder.begin(), folder.end(), L'\\', L'/');
            while (!folder.empty() && folder.back() == L'/') folder.pop_back();
            while (!folder.empty() && folder.front() == L'/') folder.erase(0, 1);
            entry.folder = folder;

            out.push_back(std::move(entry));
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
    }

    void SendInlineLayersState(bool force = false) {
        if (!webview_ || !jsReady_) return;

        const std::wstring dir = GetInlineHotLayerDir();
        std::vector<InlineLayerScanEntry> layers;
        if (!dir.empty()) {
            ScanInlineLayersRecursive(dir, L"", layers);
        }

        // Stable sort: enabled state key so a .js / .js.disabled pair collapses
        // to the enabled variant (matches pre-recursion behavior). Then folder,
        // priority, id for deterministic output; JS re-sorts by priority on mount.
        std::sort(layers.begin(), layers.end(), [](const InlineLayerScanEntry& a, const InlineLayerScanEntry& b) {
            if (a.folder != b.folder) return a.folder < b.folder;
            if (a.id != b.id) return a.id < b.id;
            return a.enabled > b.enabled;
        });

        std::wostringstream ss;
        ss << L"{\"type\":\"inline_layers_state\",\"layers\":[";
        bool first = true;
        std::wstring lastKey;
        for (const auto& layer : layers) {
            const std::wstring key = layer.folder + L"/" + layer.id;
            if (!lastKey.empty() && key == lastKey) continue;
            lastKey = key;

            if (!first) ss << L',';
            first = false;
            ss << L"{\"key\":\"" << EscapeJson(BuildInlineLayerKey(layer.id, layer.folder).c_str())
               << L"\",\"id\":\"" << EscapeJson(layer.id.c_str())
               << L"\",\"name\":\"" << EscapeJson(layer.displayName.c_str())
               << L"\",\"folder\":\"" << EscapeJson(layer.folder.c_str())
               << L"\",\"priority\":" << layer.priority
               << L",\"enabled\":" << (layer.enabled ? L"true" : L"false") << L'}';
        }
        ss << L"]}";

        const std::wstring payload = ss.str();
        if (!force && payload == inlineLayersStateSignature_) return;
        inlineLayersStateSignature_ = payload;
        webview_->PostWebMessageAsJson(payload.c_str());
    }

    // Inline-folder scan — just notifies the JS project runtime of the
    // current file list. The runtime imports each .js as an ES module
    // via the asset URL host. There is no legacy sandbox-inject path.
    void ScanInlineLayers() {
        if (!webview_ || !jsReady_) return;
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

        // Enable WebXR + HTML-in-canvas (WICG draw-element) in WebView2.
        // CanvasDrawElement unlocks drawElementImage / texElementImage2D /
        // copyElementImageToTexture — lets us render live HTML straight into
        // Three.js WebGPU textures for in-scene UI and billboards.
        auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
        options->put_AdditionalBrowserArguments(
            L"--enable-features=WebXR,WebXRARModule,OpenXR,CanvasDrawElement "
            L"--enable-blink-features=CanvasDrawElement");

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

        // Tell WebView2 that put_Bounds coordinates are raw physical pixels,
        // not DIPs. Without this, any display scale above 100% causes the
        // WebView content to render at the wrong size and get clipped.
        ComPtr<ICoreWebView2Controller3> ctrl3;
        if (SUCCEEDED(controller_->QueryInterface(IID_PPV_ARGS(&ctrl3))) && ctrl3) {
            ctrl3->put_BoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS);
            ctrl3->put_ShouldDetectMonitorScaleChanges(FALSE);
        }

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

        RefreshCallbackRegistration();
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
        // 1. Dev hot-reload: set MAXJS_WEB_DIR before launching Max to point
        //    at any web folder (e.g. your cloned repo's web/).
        std::wstring envWebDir = GetEnvironmentString(L"MAXJS_WEB_DIR");
        if (!envWebDir.empty() && DirectoryExists(envWebDir)) {
            return envWebDir;
        }

        // 2. Shipped runtime: maxjs_web/ sibling of maxjs.gup.
        wchar_t p[MAX_PATH];
        GetModuleFileNameW(hInstance, p, MAX_PATH);
        std::wstring d(p); d = d.substr(0, d.find_last_of(L"\\/"));
        std::wstring w = d + L"\\maxjs_web";
        return DirectoryExists(w) ? w : std::wstring{};
    }

    std::wstring GetFallbackProjectDir() {
        std::wstring envProjectDir = GetEnvironmentString(L"MAXJS_PROJECT_DIR");
        if (!envProjectDir.empty()) {
            return envProjectDir;
        }

        wchar_t p[MAX_PATH];
        GetModuleFileNameW(hInstance, p, MAX_PATH);
        std::wstring d(p); d = d.substr(0, d.find_last_of(L"\\/"));
        return d + L"\\maxjs_projects\\active";
    }

    std::wstring GetProjectDir() {
        std::wstring envProjectDir = GetEnvironmentString(L"MAXJS_PROJECT_DIR");
        if (!envProjectDir.empty()) {
            return envProjectDir;
        }

        return GetCurrentSceneDir();
    }

    std::wstring GetProjectManifestPath() {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) return {};
        return projectDir + L"\\project.maxjs.json";
    }

    std::wstring GetProjectPostFxPath() {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) return {};
        return projectDir + L"\\postfx.maxjs.json";
    }

    std::wstring GetSnapshotDir() {
        const std::wstring projectDir = GetProjectDir();
        if (!projectDir.empty()) return projectDir + L"\\dist";
        return GetFallbackProjectDir() + L"\\dist";
    }

    bool SceneProjectManifestExists() {
        const std::wstring manifestPath = GetProjectManifestPath();
        return !manifestPath.empty() && FileExists(manifestPath);
    }

    std::wstring BuildDefaultProjectManifestText() {
        const std::wstring sceneName = EscapeJson(GetCurrentSceneStem().c_str());
        std::wostringstream ss;
        ss << L"{\n"
           << L"  \"name\": \"" << sceneName << L"\",\n"
           << L"  \"pollMs\": 0,\n"
           << L"  \"layers\": []\n"
           << L"}\n";
        return ss.str();
    }

    bool MigrateLegacyInlineLayers(const std::wstring& dstDir, std::wstring& error) {
        const std::wstring legacyDir = GetLegacyInlineLayerDir();
        if (!DirectoryExists(legacyDir)) return true;
        if (!DirectoryExists(dstDir) && SHCreateDirectoryExW(nullptr, dstDir.c_str(), nullptr) != ERROR_SUCCESS && !DirectoryExists(dstDir)) {
            error = L"Failed to create scene-local inline folder";
            return false;
        }

        WIN32_FIND_DATAW fd = {};
        const std::wstring pattern = legacyDir + L"*";
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind == INVALID_HANDLE_VALUE) return true;

        do {
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;

            std::wstring id;
            bool enabled = false;
            if (!TryParseInlineLayerFileName(fd.cFileName, id, enabled)) continue;

            const std::wstring srcPath = legacyDir + fd.cFileName;
            const std::wstring dstPath = dstDir + fd.cFileName;
            if (FileExists(dstPath)) continue;

            if (!CopyFileEnsuringDirectories(srcPath, dstPath)) {
                error = L"Failed to migrate one or more inline layer files";
                FindClose(hFind);
                return false;
            }
        } while (FindNextFileW(hFind, &fd));

        FindClose(hFind);
        return true;
    }

    bool ReleaseProjectManifest(std::wstring& projectDirOut, std::wstring& error) {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) {
            error = L"Save the scene first";
            return false;
        }

        const std::wstring inlineDir = GetInlineLayerDir();
        const std::wstring manifestPath = GetProjectManifestPath();
        if (inlineDir.empty() || manifestPath.empty()) {
            error = L"Failed to resolve scene-local project paths";
            return false;
        }

        if (!DirectoryExists(projectDir) && SHCreateDirectoryExW(nullptr, projectDir.c_str(), nullptr) != ERROR_SUCCESS && !DirectoryExists(projectDir)) {
            error = L"Failed to prepare scene project folder";
            return false;
        }
        if (!DirectoryExists(inlineDir) && SHCreateDirectoryExW(nullptr, inlineDir.c_str(), nullptr) != ERROR_SUCCESS && !DirectoryExists(inlineDir)) {
            error = L"Failed to create inlines folder";
            return false;
        }
        if (!MigrateLegacyInlineLayers(inlineDir, error)) {
            return false;
        }
        if (!FileExists(manifestPath) && !WriteUtf8File(manifestPath, BuildDefaultProjectManifestText())) {
            error = L"Failed to create project manifest";
            return false;
        }

        projectDirOut = projectDir;
        return true;
    }

    // Returns the projects root folder (parent of "active", "bee", etc.)
    std::wstring GetProjectsRoot() {
        // Parent of GetProjectDir(). If no scene is saved, falls back to the
        // plugin's sibling projects folder.
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) return GetFallbackProjectDir();
        const size_t split2 = projectDir.find_last_of(L"\\/");
        if (split2 != std::wstring::npos) return projectDir.substr(0, split2);
        return projectDir;
    }

    // Derive a safe folder name from the Max scene filename (strips extension, replaces bad chars)
    std::wstring DeriveSceneExportName() {
        Interface* ip = GetCOREInterface();
        if (!ip) return L"";
        MSTR scenePath = ip->GetCurFilePath();
        if (!scenePath.data() || scenePath.Length() == 0) return L"";
        std::wstring full(scenePath.data());
        // Extract filename without extension
        size_t lastSlash = full.find_last_of(L"\\/");
        std::wstring name = (lastSlash != std::wstring::npos) ? full.substr(lastSlash + 1) : full;
        size_t dot = name.find_last_of(L'.');
        if (dot != std::wstring::npos) name = name.substr(0, dot);
        // Replace unsafe chars with underscore
        for (auto& c : name) {
            if (c == L' ' || c == L'<' || c == L'>' || c == L':' || c == L'"' ||
                c == L'|' || c == L'?' || c == L'*') c = L'_';
        }
        // Trim and lowercase
        while (!name.empty() && (name.back() == L'_' || name.back() == L'.')) name.pop_back();
        if (name.empty()) return L"";
        return name;
    }

    // Get the export dist folder for a named project (or derive from scene name).
    // Lands next to the .max file: `<sceneDir>\<name>\dist`. If the scene folder
    // is already named after the scene (e.g. `projects\flowerandbee\flowerandbee.max`)
    // we skip the extra wrapper and use `<sceneDir>\dist` so a matching folder
    // doesn't get nested twice.
    std::wstring GetNamedSnapshotDir(const std::wstring& exportName) {
        std::wstring name = exportName;
        if (name.empty()) name = DeriveSceneExportName();
        if (name.empty()) return GetSnapshotDir();  // fallback to active/dist

        const std::wstring sceneDir = GetProjectDir();
        if (sceneDir.empty()) return GetProjectsRoot() + L"\\" + name + L"\\dist";

        const size_t split = sceneDir.find_last_of(L"\\/");
        const std::wstring sceneFolderName = (split != std::wstring::npos) ? sceneDir.substr(split + 1) : sceneDir;
        if (!sceneFolderName.empty() && _wcsicmp(sceneFolderName.c_str(), name.c_str()) == 0) {
            return sceneDir + L"\\dist";
        }
        return sceneDir + L"\\" + name + L"\\dist";
    }

    bool CopySnapshotAsset(const std::wstring& rawPath,
                           bool isDirectory,
                           const std::wstring& exportDir,
                           std::unordered_map<std::wstring, std::wstring>& copiedPaths,
                           std::wstring& relativePath,
                           std::wstring& error) {
        std::wstring sourcePath = rawPath;
        std::replace(sourcePath.begin(), sourcePath.end(), L'/', L'\\');
        while (isDirectory && !sourcePath.empty() &&
               (sourcePath.back() == L'\\' || sourcePath.back() == L'/')) {
            sourcePath.pop_back();
        }

        if (sourcePath.empty()) {
            error = L"Snapshot asset path is empty";
            return false;
        }

        const std::wstring cacheKey = sourcePath + (isDirectory ? L"\\" : L"");
        auto cached = copiedPaths.find(cacheKey);
        if (cached != copiedPaths.end()) {
            relativePath = cached->second;
            return true;
        }

        const DWORD attrs = GetFileAttributesW(sourcePath.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES) {
            error = L"Snapshot asset missing: " + sourcePath;
            return false;
        }

        const bool sourceIsDirectory = (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (sourceIsDirectory != isDirectory) {
            error = L"Snapshot asset type mismatch: " + sourcePath;
            return false;
        }

        const std::wstring assetsDir = exportDir + L"\\assets";
        SHCreateDirectoryExW(nullptr, assetsDir.c_str(), nullptr);

        const uint64_t hash = HashFNV1a(sourcePath.data(), sourcePath.size() * sizeof(wchar_t));
        std::wstring targetName;
        if (isDirectory) {
            targetName = L"dir_" + HexU64(hash);
        } else {
            const wchar_t* ext = PathFindExtensionW(sourcePath.c_str());
            targetName = L"file_" + HexU64(hash);
            if (ext && *ext) targetName += ext;
        }

        const std::wstring targetPath = assetsDir + L"\\" + targetName;
        bool ok = false;
        if (isDirectory) {
            ok = CopyDirectoryRecursive(sourcePath, targetPath);
            relativePath = L"./assets/" + targetName + L"/";
        } else {
            SHCreateDirectoryExW(nullptr, assetsDir.c_str(), nullptr);
            ok = CopyFileW(sourcePath.c_str(), targetPath.c_str(), FALSE) != FALSE;
            relativePath = L"./assets/" + targetName;
        }

        if (!ok) {
            error = L"Failed to copy snapshot asset: " + sourcePath;
            return false;
        }

        copiedPaths.emplace(cacheKey, relativePath);
        return true;
    }

    // Resolve a virtual-host URL to a local filesystem path.
    // Handles both https://maxjs-assets.local/... and https://maxjsdrv<X>.local/...
    bool ResolveVirtualHostUrl(const std::wstring& url, std::wstring& localPath) {
        static const std::wstring assetsPrefix = L"https://maxjs-assets.local/";
        static const std::wstring drvPrefix = L"https://maxjsdrv";
        static const std::wstring drvSuffix = L".local/";

        if (url.compare(0, assetsPrefix.size(), assetsPrefix) == 0) {
            localPath = UrlDecodePath(url.substr(assetsPrefix.size()));
            return true;
        }
        if (url.compare(0, drvPrefix.size(), drvPrefix) == 0) {
            // Pattern: https://maxjsdrv<key>.local/<path>
            const size_t suffixPos = url.find(drvSuffix, drvPrefix.size());
            if (suffixPos != std::wstring::npos) {
                const std::wstring key = url.substr(drvPrefix.size(), suffixPos - drvPrefix.size());
                const std::wstring rest = url.substr(suffixPos + drvSuffix.size());
                // Drive key is lowercase letter(s) — map back to drive root
                if (!key.empty()) {
                    const wchar_t driveLetter = static_cast<wchar_t>(towupper(key[0]));
                    localPath = std::wstring(1, driveLetter) + L":\\" + UrlDecodePath(rest);
                    return true;
                }
            }
        }
        return false;
    }

    bool RewriteSnapshotAssetUrls(std::wstring& json,
                                  const std::wstring& exportDir,
                                  std::wstring& error) {
        static const std::wstring httpsPrefix = L"https://maxjs";
        std::unordered_map<std::wstring, std::wstring> copiedPaths;
        size_t pos = 0;
        while ((pos = json.find(httpsPrefix, pos)) != std::wstring::npos) {
            const size_t end = json.find(L'"', pos);
            if (end == std::wstring::npos) break;

            const std::wstring url = json.substr(pos, end - pos);
            std::wstring localPath;
            if (!ResolveVirtualHostUrl(url, localPath)) {
                pos += url.size();
                continue;
            }

            const bool isDirectory = !localPath.empty() && localPath.back() == L'/';

            std::wstring relativePath;
            if (!CopySnapshotAsset(localPath, isDirectory, exportDir, copiedPaths, relativePath, error)) {
                return false;
            }

            json.replace(pos, url.size(), relativePath);
            pos += relativePath.size();
        }
        return true;
    }

    struct SnapshotNodeRecord {
        ULONG handle = 0;
        INode* node = nullptr;
        bool visible = true;
        bool spline = false;
        std::vector<float> verts, uvs, norms;
        std::vector<VertexColorAttributeRecord> vertexColors;
        std::vector<int> indices;
        std::vector<MatGroup> groups;
        size_t vOff = 0, iOff = 0, uvOff = 0, nOff = 0;
        // Skeletal skin + optional Morpher (Morpher must be below Skin in the stack).
        bool skinRig = false;
        std::vector<ULONG> skinBoneHandles;
        std::vector<int> skinBoneParents;
        std::vector<float> skinBoneBindLocal;
        std::vector<float> skinWData;
        std::vector<float> skinIdxData;
        size_t skinWOff = 0, skinIndOff = 0, skinBoneBindOff = 0;
        std::vector<std::wstring> morphNames;
        std::vector<int> morphChannelIds;
        std::vector<float> morphInfluences;
        std::vector<size_t> morphDOff;
        std::vector<int> morphDN;
        std::vector<std::vector<float>> morphChannelsData;
    };

    struct SnapshotAnimationTrackDef {
        std::wstring path;
        std::wstring type;
        std::wstring interpolation;
        std::vector<float> times;
        std::vector<float> values;
        std::vector<unsigned char> boolValues;
        struct GeometryFrameRef {
            size_t vOff = 0, iOff = 0, uvOff = 0, nOff = 0;
            size_t vN = 0, iN = 0, uvN = 0, nN = 0;
            bool spline = false;
            std::vector<MatGroup> groups;
        };
        std::vector<GeometryFrameRef> geometryFrames;
        bool isBoolean = false;
        bool isGeometryFrames = false;
    };

    struct SnapshotAnimationTargetDef {
        std::wstring target;
        std::vector<SnapshotAnimationTrackDef> tracks;
    };

    struct SnapshotGeometrySample {
        bool spline = false;
        std::vector<float> verts, uvs, norms;
        std::vector<int> indices;
        std::vector<MatGroup> groups;
    };

    struct SnapshotMaterialSample {
        Point3 color = Point3(0.8f, 0.8f, 0.8f);
        Point3 emissive = Point3(0.0f, 0.0f, 0.0f);
        Point3 specularColor = Point3(1.0f, 1.0f, 1.0f);
        Point3 sheenColor = Point3(0.0f, 0.0f, 0.0f);
        Point3 attenuationColor = Point3(1.0f, 1.0f, 1.0f);
        float roughness = 0.5f;
        float metalness = 0.0f;
        float opacity = 1.0f;
        float emissiveIntensity = 0.0f;
        float aoIntensity = 1.0f;
        float envIntensity = 1.0f;
        float transmission = 0.0f;
        float clearcoat = 0.0f;
        float clearcoatRoughness = 0.0f;
        float iridescence = 0.0f;
        float iridescenceIOR = 1.3f;
        float thickness = 0.0f;
        float ior = 1.5f;
        float reflectivity = 0.5f;
        float dispersion = 0.0f;
        float attenuationDistance = 0.0f;
        float anisotropy = 0.0f;
        float specularIntensity = 1.0f;
        float sheen = 0.0f;
        float sheenRoughness = 1.0f;
        bool physical = false;
    };

    struct SnapshotCameraCutSegment {
        TimeValue start = 0;
        TimeValue end = 0;
        ULONG handle = 0;
        INode* node = nullptr;
        std::wstring name;
    };

    struct SnapshotExportOptions {
        bool includeSceneNodes = true;
        bool includeEnvironment = true;
        bool includeFog = true;
        bool includeLights = true;
        bool includeSplats = true;
        bool includeAudios = true;
        bool includeGLTFs = true;
        bool includeInstances = true;
        bool includeDebugPayload = false;
        bool includeSnapshotUi = true;
        bool includeRuntimeScene = true;
        bool copyAssets = true;
        bool includeAnimations = true;
        bool includeTransformAnimation = true;
        bool includeGeometryAnimation = true;
        bool includeMaterialAnimation = true;
        bool includeCameraAnimation = true;
        int animationSampleStepFrames = 1;
        std::wstring exportName;  // optional: exports to projects/{exportName}/dist/
    };

    static void NormalizeSnapshotExportOptions(SnapshotExportOptions& options) {
        options.animationSampleStepFrames = std::clamp(options.animationSampleStepFrames, 1, 120);
        // NOTE: snapshotUi (post-fx, camera) and runtimeScene (layers) are essential for
        // working snapshots and should NOT be gated by includeDebugPayload. Debug payload
        // only controls whether extra dev files (full project manifest, inline sources) are copied.
        if (!options.includeAnimations) {
            options.includeTransformAnimation = false;
            options.includeGeometryAnimation = false;
            options.includeMaterialAnimation = false;
            options.includeCameraAnimation = false;
        }
    }

    static Point3 MaxPointToWorld(const Point3& point) {
        return Point3(point.x, point.z, -point.y);
    }

    static bool NearlyEqualPoint3(const Point3& a, const Point3& b, float epsilon = 1.0e-4f) {
        return std::fabs(a.x - b.x) <= epsilon &&
               std::fabs(a.y - b.y) <= epsilon &&
               std::fabs(a.z - b.z) <= epsilon;
    }

    static bool NearlyEqualFloat(float a, float b, float epsilon = 1.0e-4f) {
        return std::fabs(a - b) <= epsilon;
    }

    static double GetAnimationTicksPerSecond() {
        const int ticksPerFrame = GetTicksPerFrame();
        const int frameRate = GetFrameRate();
        const double ticksPerSecond = static_cast<double>(ticksPerFrame) * static_cast<double>(frameRate);
        return ticksPerSecond > 0.0 ? ticksPerSecond : 4800.0;
    }

    static float TimeValueToAnimationSeconds(TimeValue value, TimeValue rangeStart) {
        return static_cast<float>(
            static_cast<double>(value - rangeStart) / GetAnimationTicksPerSecond());
    }

    static void AppendUniqueTimeValue(std::vector<TimeValue>& times, TimeValue value) {
        if (std::find(times.begin(), times.end(), value) == times.end()) {
            times.push_back(value);
        }
    }

    static void AppendNumberTrackSample(SnapshotAnimationTrackDef& track, float seconds, float value) {
        track.times.push_back(seconds);
        track.values.push_back(value);
    }

    static void AppendVectorTrackSample(SnapshotAnimationTrackDef& track, float seconds, const Point3& value) {
        track.times.push_back(seconds);
        track.values.push_back(value.x);
        track.values.push_back(value.y);
        track.values.push_back(value.z);
    }

    static void AppendBinaryFloats(std::string& outBinary,
                                   const std::vector<float>& values,
                                   size_t& outOffset,
                                   size_t& outCount) {
        outOffset = outBinary.size();
        outCount = values.size();
        if (values.empty()) return;
        outBinary.append(
            reinterpret_cast<const char*>(values.data()),
            values.size() * sizeof(float));
    }

    static void AppendBinaryInts(std::string& outBinary,
                                 const std::vector<int>& values,
                                 size_t& outOffset,
                                 size_t& outCount) {
        outOffset = outBinary.size();
        outCount = values.size();
        if (values.empty()) return;
        outBinary.append(
            reinterpret_cast<const char*>(values.data()),
            values.size() * sizeof(int));
    }

    static bool ExtractSnapshotGeometrySample(INode* node,
                                             TimeValue sampleTime,
                                             SnapshotGeometrySample& outSample) {
        if (!node) return false;
        outSample = SnapshotGeometrySample();

        ObjectState os = node->EvalWorldState(sampleTime);
        bool extracted = ExtractMesh(
            node,
            sampleTime,
            outSample.verts,
            outSample.uvs,
            outSample.indices,
            outSample.groups,
            &outSample.norms);

        if (!extracted && ShouldExtractRenderableShape(node, sampleTime, &os)) {
            extracted = ExtractSpline(node, sampleTime, outSample.verts, outSample.indices);
            outSample.spline = extracted;
            if (extracted) {
                outSample.uvs.clear();
                outSample.norms.clear();
                outSample.groups.clear();
            }
        }

        return extracted;
    }

    static bool SnapshotGeometrySamplesEqual(const SnapshotGeometrySample& a,
                                             const SnapshotGeometrySample& b) {
        if (a.groups.size() != b.groups.size()) return false;
        for (size_t i = 0; i < a.groups.size(); ++i) {
            if (a.groups[i].matID != b.groups[i].matID ||
                a.groups[i].start != b.groups[i].start ||
                a.groups[i].count != b.groups[i].count) {
                return false;
            }
        }
        return a.spline == b.spline &&
               a.verts == b.verts &&
               a.indices == b.indices &&
               a.uvs == b.uvs &&
               a.norms == b.norms;
    }

    // Skinned / mocap / stack-driven deformation often does not mark the mesh ObjectRef as
    // IsAnimated() — only bones have keys. Probe evaluated mesh so we still bake vertex frames.
    // If start/end poses match (e.g. loop), compare a midpoint to start as well.
    static bool SnapshotGeometryAppearsTimeVaryingInRange(INode* node, const Interval& range) {
        SnapshotGeometrySample a, b;
        if (!ExtractSnapshotGeometrySample(node, range.Start(), a)) return false;
        if (!ExtractSnapshotGeometrySample(node, range.End(), b)) return false;
        if (!SnapshotGeometrySamplesEqual(a, b)) return true;
        if (range.Start() >= range.End()) return false;
        const TimeValue mid = (range.Start() + range.End()) / 2;
        if (mid <= range.Start() || mid >= range.End()) return false;
        SnapshotGeometrySample m;
        if (!ExtractSnapshotGeometrySample(node, mid, m)) return false;
        return !SnapshotGeometrySamplesEqual(a, m);
    }

    static void FillSnapshotMaterialSample(const MaxJSPBR& pbr, SnapshotMaterialSample& out) {
        out.color = Point3(pbr.color[0], pbr.color[1], pbr.color[2]);
        out.emissive = Point3(pbr.emission[0], pbr.emission[1], pbr.emission[2]);
        out.specularColor = Point3(
            pbr.physicalSpecularColor[0],
            pbr.physicalSpecularColor[1],
            pbr.physicalSpecularColor[2]);
        out.sheenColor = Point3(pbr.sheenColor[0], pbr.sheenColor[1], pbr.sheenColor[2]);
        out.attenuationColor = Point3(
            pbr.attenuationColor[0],
            pbr.attenuationColor[1],
            pbr.attenuationColor[2]);
        out.roughness = pbr.roughness;
        out.metalness = pbr.metalness;
        out.opacity = pbr.opacity;
        out.emissiveIntensity = pbr.emIntensity;
        out.aoIntensity = pbr.aoIntensity;
        out.envIntensity = pbr.envIntensity;
        out.transmission = pbr.transmission;
        out.clearcoat = pbr.clearcoat;
        out.clearcoatRoughness = pbr.clearcoatRoughness;
        out.iridescence = pbr.iridescence;
        out.iridescenceIOR = pbr.iridescenceIOR;
        out.thickness = pbr.thickness;
        out.ior = pbr.ior;
        out.reflectivity = pbr.reflectivity;
        out.dispersion = pbr.dispersion;
        out.attenuationDistance = pbr.attenuationDistance;
        out.anisotropy = pbr.anisotropy;
        out.specularIntensity = pbr.physicalSpecularIntensity;
        out.sheen = pbr.sheen;
        out.sheenRoughness = pbr.sheenRoughness;
        out.physical = pbr.materialModel == L"MeshPhysicalMaterial";
    }

    static void SortUniqueTimeValues(std::vector<TimeValue>& times) {
        std::sort(times.begin(), times.end());
        times.erase(std::unique(times.begin(), times.end()), times.end());
    }

    static void CollectAnimatableKeyTimesRecursive(Animatable* anim,
                                                   const Interval& range,
                                                   std::vector<TimeValue>& times,
                                                   std::unordered_set<const Animatable*>& visited) {
        if (!anim || visited.find(anim) != visited.end()) return;
        visited.insert(anim);

        Tab<TimeValue> keyTimes;
        if (anim->GetKeyTimes(keyTimes, range, 0) > 0) {
            for (int i = 0; i < keyTimes.Count(); ++i) {
                const TimeValue time = keyTimes[i];
                if (time >= range.Start() && time <= range.End()) {
                    AppendUniqueTimeValue(times, time);
                }
            }
        }

        const int subCount = anim->NumSubs();
        for (int i = 0; i < subCount; ++i) {
            Animatable* sub = anim->SubAnim(i);
            if (!sub || sub == anim) continue;
            CollectAnimatableKeyTimesRecursive(sub, range, times, visited);
        }
    }

    static void AppendFrameSampleTimes(std::vector<TimeValue>& times,
                                       const Interval& range,
                                       int stepFrames = 1) {
        int step = GetTicksPerFrame();
        if (step <= 0) step = 160;
        step *= std::max(stepFrames, 1);
        for (TimeValue t = range.Start(); t <= range.End(); t += step) {
            AppendUniqueTimeValue(times, t);
        }
        AppendUniqueTimeValue(times, range.End());
    }

    static bool BuildAnimatableTimeSamples(Animatable* anim,
                                           const Interval& range,
                                           TimeValue currentTime,
                                           std::vector<TimeValue>& outTimes) {
        if (!anim) return false;

        std::vector<TimeValue> localTimes;
        std::unordered_set<const Animatable*> visited;
        CollectAnimatableKeyTimesRecursive(anim, range, localTimes, visited);

        const bool animated = anim->IsAnimated() != FALSE;
        if (animated && localTimes.empty()) {
            AppendFrameSampleTimes(localTimes, range);
        }
        if (localTimes.empty()) {
            return animated;
        }

        AppendUniqueTimeValue(localTimes, range.Start());
        AppendUniqueTimeValue(localTimes, range.End());
        if (currentTime >= range.Start() && currentTime <= range.End()) {
            AppendUniqueTimeValue(localTimes, currentTime);
        }
        SortUniqueTimeValues(localTimes);
        outTimes.insert(outTimes.end(), localTimes.begin(), localTimes.end());
        return true;
    }

    static bool BuildNodeAnimationTarget(INode* node,
                                         const Interval& range,
                                         TimeValue currentTime,
                                         const SnapshotExportOptions& options,
                                         SnapshotAnimationTargetDef& outTarget) {
        if (!node) return false;

        std::vector<TimeValue> discoveryTimes;
        const bool hasTransformAnimation =
            BuildAnimatableTimeSamples(node->GetTMController(), range, currentTime, discoveryTimes);
        const bool hasVisibilityAnimation =
            BuildAnimatableTimeSamples(node->GetVisController(), range, currentTime, discoveryTimes);
        // Parent-driven motion still changes this node's world transform in the snapshot.
        for (INode* parent = node->GetParentNode(); parent; parent = parent->GetParentNode()) {
            if (parent->IsRootNode()) break;
            BuildAnimatableTimeSamples(parent->GetTMController(), range, currentTime, discoveryTimes);
        }
        if (!hasTransformAnimation && !hasVisibilityAnimation) {
            if (discoveryTimes.empty()) {
                return false;
            }
        }

        std::vector<TimeValue> sampleTimes;
        AppendFrameSampleTimes(sampleTimes, range, options.animationSampleStepFrames);
        SortUniqueTimeValues(sampleTimes);
        if (sampleTimes.size() < 2) {
            return false;
        }

        SnapshotAnimationTrackDef matrixTrack;
        matrixTrack.path = L"matrix";
        matrixTrack.type = L"matrix16";
        matrixTrack.interpolation = L"linear";

        SnapshotAnimationTrackDef visibilityTrack;
        visibilityTrack.path = L"visible";
        visibilityTrack.type = L"boolean";
        visibilityTrack.interpolation = L"step";
        visibilityTrack.isBoolean = true;

        bool matrixChanged = false;
        bool visChanged = false;
        bool havePrevious = false;
        float previousMatrix[16] = {};
        bool previousVisible = true;

        for (TimeValue sampleTime : sampleTimes) {
            const float seconds = TimeValueToAnimationSeconds(sampleTime, range.Start());
            float matrixValues[16];
            GetTransform16(node, sampleTime, matrixValues);

            const bool visible =
                !node->IsNodeHidden(TRUE) && node->GetVisibility(sampleTime) > 0.0f;

            matrixTrack.times.push_back(seconds);
            matrixTrack.values.insert(
                matrixTrack.values.end(),
                matrixValues,
                matrixValues + 16);

            visibilityTrack.times.push_back(seconds);
            visibilityTrack.boolValues.push_back(visible ? 1 : 0);

            if (havePrevious) {
                if (!TransformEquals16(matrixValues, previousMatrix)) matrixChanged = true;
                if (visible != previousVisible) visChanged = true;
            }

            std::copy(std::begin(matrixValues), std::end(matrixValues), previousMatrix);
            previousVisible = visible;
            havePrevious = true;
        }

        outTarget.target = L"handle:" + std::to_wstring(node->GetHandle());
        if (matrixChanged) outTarget.tracks.push_back(std::move(matrixTrack));
        if (visChanged) outTarget.tracks.push_back(std::move(visibilityTrack));
        return !outTarget.tracks.empty();
    }

    // Like BuildNodeAnimationTarget but stores LOCAL transforms (parentInverse * world)
    // instead of world transforms. Required for bones in a SkinnedMesh hierarchy.
    static bool BuildBoneAnimationTarget(INode* bone,
                                         INode* parentNode,
                                         const Interval& range,
                                         TimeValue currentTime,
                                         const SnapshotExportOptions& options,
                                         SnapshotAnimationTargetDef& outTarget) {
        if (!bone) return false;

        std::vector<TimeValue> discoveryTimes;
        const bool hasTransformAnimation =
            BuildAnimatableTimeSamples(bone->GetTMController(), range, currentTime, discoveryTimes);
        // Also check if parent is animated (parent movement changes this bone's local transform)
        if (parentNode) {
            BuildAnimatableTimeSamples(parentNode->GetTMController(), range, currentTime, discoveryTimes);
        }
        if (discoveryTimes.empty() && !hasTransformAnimation) {
            return false;
        }

        std::vector<TimeValue> sampleTimes;
        AppendFrameSampleTimes(sampleTimes, range, options.animationSampleStepFrames);
        SortUniqueTimeValues(sampleTimes);
        if (sampleTimes.size() < 2) {
            return false;
        }

        SnapshotAnimationTrackDef matrixTrack;
        matrixTrack.path = L"matrix";
        matrixTrack.type = L"matrix16";
        matrixTrack.interpolation = L"linear";

        bool matrixChanged = false;
        bool havePrevious = false;
        float previousMatrix[16] = {};

        for (TimeValue sampleTime : sampleTimes) {
            const float seconds = TimeValueToAnimationSeconds(sampleTime, range.Start());

            float boneWorld[16];
            GetTransform16(bone, sampleTime, boneWorld);

            float parentWorld[16];
            if (parentNode)
                GetTransform16(parentNode, sampleTime, parentWorld);
            else
                Mat4IdentityCM(parentWorld);

            float invParent[16];
            if (!InvertMat4CM(parentWorld, invParent))
                Mat4IdentityCM(invParent);

            float localMatrix[16];
            MulMat4CM(invParent, boneWorld, localMatrix);

            matrixTrack.times.push_back(seconds);
            matrixTrack.values.insert(
                matrixTrack.values.end(),
                localMatrix,
                localMatrix + 16);

            if (havePrevious) {
                if (!TransformEquals16(localMatrix, previousMatrix)) matrixChanged = true;
            }

            std::copy(std::begin(localMatrix), std::end(localMatrix), previousMatrix);
            havePrevious = true;
        }

        outTarget.target = L"handle:" + std::to_wstring(bone->GetHandle());
        if (matrixChanged) outTarget.tracks.push_back(std::move(matrixTrack));
        return !outTarget.tracks.empty();
    }

    static void MergeSnapshotAnimationTarget(SnapshotAnimationTargetDef& dst,
                                             SnapshotAnimationTargetDef&& src) {
        if (src.tracks.empty()) return;
        if (dst.target.empty()) dst.target = std::move(src.target);
        dst.tracks.insert(
            dst.tracks.end(),
            std::make_move_iterator(src.tracks.begin()),
            std::make_move_iterator(src.tracks.end()));
    }

    static void AppendGeometryFrame(std::string& binary,
                                    const SnapshotGeometrySample& sample,
                                    SnapshotAnimationTrackDef::GeometryFrameRef& frame) {
        AppendBinaryFloats(binary, sample.verts, frame.vOff, frame.vN);
        AppendBinaryInts(binary, sample.indices, frame.iOff, frame.iN);
        AppendBinaryFloats(binary, sample.uvs, frame.uvOff, frame.uvN);
        AppendBinaryFloats(binary, sample.norms, frame.nOff, frame.nN);
        frame.spline = sample.spline;
        frame.groups = sample.groups;
    }

    static void OffsetGeometryFrameRefs(std::vector<SnapshotAnimationTrackDef::GeometryFrameRef>& frames,
                                        size_t baseOffset) {
        for (auto& frame : frames) {
            frame.vOff += baseOffset;
            frame.iOff += baseOffset;
            frame.uvOff += baseOffset;
            frame.nOff += baseOffset;
        }
    }

    static bool BuildNodeGeometryAnimationTarget(INode* node,
                                                 const Interval& range,
                                                 TimeValue currentTime,
                                                 const SnapshotExportOptions& options,
                                                 SnapshotAnimationTargetDef& outTarget,
                                                 std::string& outBinary) {
        if (!node) return false;

        std::vector<TimeValue> discoveryTimes;
        bool hasGeometryAnimation =
            BuildAnimatableTimeSamples(node->GetObjectRef(), range, currentTime, discoveryTimes);
        if (!hasGeometryAnimation) {
            hasGeometryAnimation = SnapshotGeometryAppearsTimeVaryingInRange(node, range);
        }
        if (!hasGeometryAnimation) {
            return false;
        }

        std::vector<TimeValue> sampleTimes;
        AppendFrameSampleTimes(sampleTimes, range, options.animationSampleStepFrames);
        SortUniqueTimeValues(sampleTimes);
        if (sampleTimes.size() < 2) {
            return false;
        }

        SnapshotAnimationTrackDef geometryTrack;
        geometryTrack.path = L"geometry";
        geometryTrack.type = L"geometryFrames";
        geometryTrack.interpolation = L"step";
        geometryTrack.isGeometryFrames = true;

        std::string localBinary;
        bool geometryChanged = false;
        bool havePrevious = false;
        SnapshotGeometrySample previousSample;

        for (TimeValue sampleTime : sampleTimes) {
            SnapshotGeometrySample sample;
            if (!ExtractSnapshotGeometrySample(node, sampleTime, sample)) {
                continue;
            }

            geometryTrack.times.push_back(TimeValueToAnimationSeconds(sampleTime, range.Start()));
            SnapshotAnimationTrackDef::GeometryFrameRef frame;
            AppendGeometryFrame(localBinary, sample, frame);
            geometryTrack.geometryFrames.push_back(std::move(frame));

            if (havePrevious && !SnapshotGeometrySamplesEqual(sample, previousSample)) {
                geometryChanged = true;
            }
            previousSample = std::move(sample);
            havePrevious = true;
        }

        if (!geometryChanged ||
            geometryTrack.times.size() < 2 ||
            geometryTrack.geometryFrames.size() != geometryTrack.times.size()) {
            return false;
        }

        const size_t baseOffset = outBinary.size();
        OffsetGeometryFrameRefs(geometryTrack.geometryFrames, baseOffset);
        outBinary.append(localBinary);

        outTarget.target = L"handle:" + std::to_wstring(node->GetHandle());
        outTarget.tracks.push_back(std::move(geometryTrack));
        return true;
    }

    static void BuildMaterialTracksForPrefix(const std::wstring& prefix,
                                             const std::vector<float>& seconds,
                                             const std::vector<SnapshotMaterialSample>& samples,
                                             std::vector<SnapshotAnimationTrackDef>& outTracks) {
        if (seconds.size() < 2 || samples.size() != seconds.size()) return;

        auto makeVectorTrack = [&](const wchar_t* suffix) {
            SnapshotAnimationTrackDef track;
            track.path = prefix + L"." + suffix;
            track.type = L"vector3";
            track.interpolation = L"linear";
            return track;
        };
        auto makeNumberTrack = [&](const wchar_t* suffix) {
            SnapshotAnimationTrackDef track;
            track.path = prefix + L"." + suffix;
            track.type = L"number";
            track.interpolation = L"linear";
            return track;
        };

        SnapshotAnimationTrackDef colorTrack = makeVectorTrack(L"color");
        SnapshotAnimationTrackDef emissiveTrack = makeVectorTrack(L"emissive");
        SnapshotAnimationTrackDef specularColorTrack = makeVectorTrack(L"specularColor");
        SnapshotAnimationTrackDef sheenColorTrack = makeVectorTrack(L"sheenColor");
        SnapshotAnimationTrackDef attenuationColorTrack = makeVectorTrack(L"attenuationColor");

        SnapshotAnimationTrackDef roughnessTrack = makeNumberTrack(L"roughness");
        SnapshotAnimationTrackDef metalnessTrack = makeNumberTrack(L"metalness");
        SnapshotAnimationTrackDef opacityTrack = makeNumberTrack(L"opacity");
        SnapshotAnimationTrackDef emissiveIntensityTrack = makeNumberTrack(L"emissiveIntensity");
        SnapshotAnimationTrackDef aoIntensityTrack = makeNumberTrack(L"aoMapIntensity");
        SnapshotAnimationTrackDef envIntensityTrack = makeNumberTrack(L"envMapIntensity");
        SnapshotAnimationTrackDef transmissionTrack = makeNumberTrack(L"transmission");
        SnapshotAnimationTrackDef clearcoatTrack = makeNumberTrack(L"clearcoat");
        SnapshotAnimationTrackDef clearcoatRoughnessTrack = makeNumberTrack(L"clearcoatRoughness");
        SnapshotAnimationTrackDef iridescenceTrack = makeNumberTrack(L"iridescence");
        SnapshotAnimationTrackDef iridescenceIORTrack = makeNumberTrack(L"iridescenceIOR");
        SnapshotAnimationTrackDef thicknessTrack = makeNumberTrack(L"thickness");
        SnapshotAnimationTrackDef iorTrack = makeNumberTrack(L"ior");
        SnapshotAnimationTrackDef reflectivityTrack = makeNumberTrack(L"reflectivity");
        SnapshotAnimationTrackDef dispersionTrack = makeNumberTrack(L"dispersion");
        SnapshotAnimationTrackDef attenuationDistanceTrack = makeNumberTrack(L"attenuationDistance");
        SnapshotAnimationTrackDef anisotropyTrack = makeNumberTrack(L"anisotropy");
        SnapshotAnimationTrackDef specularIntensityTrack = makeNumberTrack(L"specularIntensity");
        SnapshotAnimationTrackDef sheenTrack = makeNumberTrack(L"sheen");
        SnapshotAnimationTrackDef sheenRoughnessTrack = makeNumberTrack(L"sheenRoughness");

        bool colorChanged = false;
        bool emissiveChanged = false;
        bool specularColorChanged = false;
        bool sheenColorChanged = false;
        bool attenuationColorChanged = false;
        bool roughnessChanged = false;
        bool metalnessChanged = false;
        bool opacityChanged = false;
        bool emissiveIntensityChanged = false;
        bool aoIntensityChanged = false;
        bool envIntensityChanged = false;
        bool transmissionChanged = false;
        bool clearcoatChanged = false;
        bool clearcoatRoughnessChanged = false;
        bool iridescenceChanged = false;
        bool iridescenceIORChanged = false;
        bool thicknessChanged = false;
        bool iorChanged = false;
        bool reflectivityChanged = false;
        bool dispersionChanged = false;
        bool attenuationDistanceChanged = false;
        bool anisotropyChanged = false;
        bool specularIntensityChanged = false;
        bool sheenChanged = false;
        bool sheenRoughnessChanged = false;

        for (size_t i = 0; i < samples.size(); ++i) {
            const auto& sample = samples[i];
            const float second = seconds[i];

            AppendVectorTrackSample(colorTrack, second, sample.color);
            AppendVectorTrackSample(emissiveTrack, second, sample.emissive);
            AppendVectorTrackSample(specularColorTrack, second, sample.specularColor);
            AppendVectorTrackSample(sheenColorTrack, second, sample.sheenColor);
            AppendVectorTrackSample(attenuationColorTrack, second, sample.attenuationColor);

            AppendNumberTrackSample(roughnessTrack, second, sample.roughness);
            AppendNumberTrackSample(metalnessTrack, second, sample.metalness);
            AppendNumberTrackSample(opacityTrack, second, sample.opacity);
            AppendNumberTrackSample(emissiveIntensityTrack, second, sample.emissiveIntensity);
            AppendNumberTrackSample(aoIntensityTrack, second, sample.aoIntensity);
            AppendNumberTrackSample(envIntensityTrack, second, sample.envIntensity);
            AppendNumberTrackSample(transmissionTrack, second, sample.transmission);
            AppendNumberTrackSample(clearcoatTrack, second, sample.clearcoat);
            AppendNumberTrackSample(clearcoatRoughnessTrack, second, sample.clearcoatRoughness);
            AppendNumberTrackSample(iridescenceTrack, second, sample.iridescence);
            AppendNumberTrackSample(iridescenceIORTrack, second, sample.iridescenceIOR);
            AppendNumberTrackSample(thicknessTrack, second, sample.thickness);
            AppendNumberTrackSample(iorTrack, second, sample.ior);
            AppendNumberTrackSample(reflectivityTrack, second, sample.reflectivity);
            AppendNumberTrackSample(dispersionTrack, second, sample.dispersion);
            AppendNumberTrackSample(attenuationDistanceTrack, second, sample.attenuationDistance);
            AppendNumberTrackSample(anisotropyTrack, second, sample.anisotropy);
            AppendNumberTrackSample(specularIntensityTrack, second, sample.specularIntensity);
            AppendNumberTrackSample(sheenTrack, second, sample.sheen);
            AppendNumberTrackSample(sheenRoughnessTrack, second, sample.sheenRoughness);

            if (i == 0) continue;
            const auto& prev = samples[i - 1];
            colorChanged = colorChanged || !NearlyEqualPoint3(sample.color, prev.color);
            emissiveChanged = emissiveChanged || !NearlyEqualPoint3(sample.emissive, prev.emissive);
            specularColorChanged = specularColorChanged || !NearlyEqualPoint3(sample.specularColor, prev.specularColor);
            sheenColorChanged = sheenColorChanged || !NearlyEqualPoint3(sample.sheenColor, prev.sheenColor);
            attenuationColorChanged = attenuationColorChanged || !NearlyEqualPoint3(sample.attenuationColor, prev.attenuationColor);
            roughnessChanged = roughnessChanged || !NearlyEqualFloat(sample.roughness, prev.roughness);
            metalnessChanged = metalnessChanged || !NearlyEqualFloat(sample.metalness, prev.metalness);
            opacityChanged = opacityChanged || !NearlyEqualFloat(sample.opacity, prev.opacity);
            emissiveIntensityChanged = emissiveIntensityChanged || !NearlyEqualFloat(sample.emissiveIntensity, prev.emissiveIntensity);
            aoIntensityChanged = aoIntensityChanged || !NearlyEqualFloat(sample.aoIntensity, prev.aoIntensity);
            envIntensityChanged = envIntensityChanged || !NearlyEqualFloat(sample.envIntensity, prev.envIntensity);
            transmissionChanged = transmissionChanged || !NearlyEqualFloat(sample.transmission, prev.transmission);
            clearcoatChanged = clearcoatChanged || !NearlyEqualFloat(sample.clearcoat, prev.clearcoat);
            clearcoatRoughnessChanged = clearcoatRoughnessChanged || !NearlyEqualFloat(sample.clearcoatRoughness, prev.clearcoatRoughness);
            iridescenceChanged = iridescenceChanged || !NearlyEqualFloat(sample.iridescence, prev.iridescence);
            iridescenceIORChanged = iridescenceIORChanged || !NearlyEqualFloat(sample.iridescenceIOR, prev.iridescenceIOR);
            thicknessChanged = thicknessChanged || !NearlyEqualFloat(sample.thickness, prev.thickness);
            iorChanged = iorChanged || !NearlyEqualFloat(sample.ior, prev.ior);
            reflectivityChanged = reflectivityChanged || !NearlyEqualFloat(sample.reflectivity, prev.reflectivity);
            dispersionChanged = dispersionChanged || !NearlyEqualFloat(sample.dispersion, prev.dispersion);
            attenuationDistanceChanged = attenuationDistanceChanged || !NearlyEqualFloat(sample.attenuationDistance, prev.attenuationDistance);
            anisotropyChanged = anisotropyChanged || !NearlyEqualFloat(sample.anisotropy, prev.anisotropy);
            specularIntensityChanged = specularIntensityChanged || !NearlyEqualFloat(sample.specularIntensity, prev.specularIntensity);
            sheenChanged = sheenChanged || !NearlyEqualFloat(sample.sheen, prev.sheen);
            sheenRoughnessChanged = sheenRoughnessChanged || !NearlyEqualFloat(sample.sheenRoughness, prev.sheenRoughness);
        }

        if (colorChanged) outTracks.push_back(std::move(colorTrack));
        if (emissiveChanged) outTracks.push_back(std::move(emissiveTrack));
        if (specularColorChanged) outTracks.push_back(std::move(specularColorTrack));
        if (sheenColorChanged) outTracks.push_back(std::move(sheenColorTrack));
        if (attenuationColorChanged) outTracks.push_back(std::move(attenuationColorTrack));
        if (roughnessChanged) outTracks.push_back(std::move(roughnessTrack));
        if (metalnessChanged) outTracks.push_back(std::move(metalnessTrack));
        if (opacityChanged) outTracks.push_back(std::move(opacityTrack));
        if (emissiveIntensityChanged) outTracks.push_back(std::move(emissiveIntensityTrack));
        if (aoIntensityChanged) outTracks.push_back(std::move(aoIntensityTrack));
        if (envIntensityChanged) outTracks.push_back(std::move(envIntensityTrack));
        if (transmissionChanged) outTracks.push_back(std::move(transmissionTrack));
        if (clearcoatChanged) outTracks.push_back(std::move(clearcoatTrack));
        if (clearcoatRoughnessChanged) outTracks.push_back(std::move(clearcoatRoughnessTrack));
        if (iridescenceChanged) outTracks.push_back(std::move(iridescenceTrack));
        if (iridescenceIORChanged) outTracks.push_back(std::move(iridescenceIORTrack));
        if (thicknessChanged) outTracks.push_back(std::move(thicknessTrack));
        if (iorChanged) outTracks.push_back(std::move(iorTrack));
        if (reflectivityChanged) outTracks.push_back(std::move(reflectivityTrack));
        if (dispersionChanged) outTracks.push_back(std::move(dispersionTrack));
        if (attenuationDistanceChanged) outTracks.push_back(std::move(attenuationDistanceTrack));
        if (anisotropyChanged) outTracks.push_back(std::move(anisotropyTrack));
        if (specularIntensityChanged) outTracks.push_back(std::move(specularIntensityTrack));
        if (sheenChanged) outTracks.push_back(std::move(sheenTrack));
        if (sheenRoughnessChanged) outTracks.push_back(std::move(sheenRoughnessTrack));
    }

    static bool BuildNodeMaterialAnimationTarget(const SnapshotNodeRecord& nodeRecord,
                                                 const Interval& range,
                                                 TimeValue currentTime,
                                                 const SnapshotExportOptions& options,
                                                 SnapshotAnimationTargetDef& outTarget) {
        INode* node = nodeRecord.node;
        if (!node) return false;

        Mtl* mtl = node->GetMtl();
        if (!mtl) return false;

        std::vector<TimeValue> sampleTimes;
        AppendFrameSampleTimes(sampleTimes, range, options.animationSampleStepFrames);
        if (currentTime >= range.Start() && currentTime <= range.End()) {
            AppendUniqueTimeValue(sampleTimes, currentTime);
        }
        SortUniqueTimeValues(sampleTimes);
        if (sampleTimes.size() < 2) {
            return false;
        }

        std::vector<float> seconds;
        seconds.reserve(sampleTimes.size());
        for (TimeValue sampleTime : sampleTimes) {
            seconds.push_back(TimeValueToAnimationSeconds(sampleTime, range.Start()));
        }

        outTarget.target = L"handle:" + std::to_wstring(node->GetHandle());

        Mtl* multiMtl = FindMultiSubMtl(mtl);
        if (multiMtl && multiMtl->NumSubMtls() > 0 && nodeRecord.groups.size() > 1) {
            for (size_t groupIndex = 0; groupIndex < nodeRecord.groups.size(); ++groupIndex) {
                std::vector<SnapshotMaterialSample> samples;
                samples.reserve(sampleTimes.size());
                for (TimeValue sampleTime : sampleTimes) {
                    Mtl* subMtl = GetSubMtlFromMatID(multiMtl, nodeRecord.groups[groupIndex].matID);
                    if (!subMtl) subMtl = multiMtl;

                    MaxJSPBR pbr;
                    ExtractPBRFromMtl(subMtl, node, sampleTime, pbr);
                    SnapshotMaterialSample sample;
                    FillSnapshotMaterialSample(pbr, sample);
                    samples.push_back(sample);
                }
                const std::wstring prefix = L"materials[" + std::to_wstring(groupIndex) + L"]";
                BuildMaterialTracksForPrefix(prefix, seconds, samples, outTarget.tracks);
            }
        } else {
            std::vector<SnapshotMaterialSample> samples;
            samples.reserve(sampleTimes.size());
            for (TimeValue sampleTime : sampleTimes) {
                MaxJSPBR pbr;
                ExtractPBR(node, sampleTime, pbr);
                SnapshotMaterialSample sample;
                FillSnapshotMaterialSample(pbr, sample);
                samples.push_back(sample);
            }
            BuildMaterialTracksForPrefix(L"material", seconds, samples, outTarget.tracks);
        }

        return !outTarget.tracks.empty();
    }

    static INode* ResolveStateSetCameraNode(Interface* ip, ULONG handle) {
        return (ip && handle != 0) ? ip->GetINodeByHandle(handle) : nullptr;
    }

    static bool TryBuildStateSetCameraSegments(Interface* ip,
                                               const Interval& range,
                                               std::vector<SnapshotCameraCutSegment>& outSegments) {
        if (!ip) return false;

        static const wchar_t* script = LR"(
            fn _maxjs_snapshot_state_cameras = (
                local rows = #()
                try (
                    local plugin = dotNetObject "Autodesk.Max.StateSets.Plugin"
                    local entityManager = plugin.EntityManager
                    if entityManager != undefined do (
                        local root = entityManager.RootEntity.MasterStateSet
                        if root != undefined do (
                            for i = 0 to root.ChildrenCount - 1 do (
                                local state = root.GetChild i
                                local cam = undefined
                                local startTick = undefined
                                local endTick = undefined
                                try (cam = state.ActiveViewportCamera) catch()
                                try (
                                    local rr = state.RenderRange
                                    if rr != undefined do (
                                        startTick = rr.Start.ticks
                                        endTick = rr.End.ticks
                                    )
                                ) catch()
                                try (
                                    if startTick == undefined or endTick == undefined do (
                                        local ar = state.AnimationRange
                                        if ar != undefined do (
                                            startTick = ar.Start.ticks
                                            endTick = ar.End.ticks
                                        )
                                    )
                                ) catch()
                                if cam != undefined and startTick != undefined and endTick != undefined do (
                                    append rows ((getHandleByAnim cam) as string + "|" +
                                        (startTick as integer) as string + "|" +
                                        (endTick as integer) as string + "|" +
                                        state.Name)
                                )
                            )
                        )
                    )
                ) catch()
                join rows "\n"
            )
            _maxjs_snapshot_state_cameras()
        )";

        FPValue result;
        result.Init();
        try {
            if (!ExecuteMAXScriptScript(script, MAXScript::ScriptSource::Dynamic, false, &result)) {
                return false;
            }
        } catch (...) {
            return false;
        }

        if (result.type != TYPE_STRING || !result.s || !*result.s) {
            return false;
        }

        std::wstringstream lines(result.s);
        std::wstring line;
        while (std::getline(lines, line)) {
            if (line.empty()) continue;

            std::vector<std::wstring> parts;
            size_t start = 0;
            while (start <= line.size()) {
                const size_t pos = line.find(L'|', start);
                if (pos == std::wstring::npos) {
                    parts.push_back(line.substr(start));
                    break;
                }
                parts.push_back(line.substr(start, pos - start));
                start = pos + 1;
            }
            if (parts.size() < 4) continue;

            try {
                SnapshotCameraCutSegment segment;
                segment.handle = static_cast<ULONG>(std::stoul(parts[0]));
                segment.start = static_cast<TimeValue>(std::stoi(parts[1]));
                segment.end = static_cast<TimeValue>(std::stoi(parts[2]));
                segment.name = parts[3];
                segment.node = ResolveStateSetCameraNode(ip, segment.handle);
                if (!segment.node || segment.end < range.Start() || segment.start > range.End()) {
                    continue;
                }
                segment.start = std::max(segment.start, range.Start());
                segment.end = std::min(segment.end, range.End());
                outSegments.push_back(segment);
            } catch (...) {
            }
        }

        std::sort(outSegments.begin(), outSegments.end(),
                  [](const SnapshotCameraCutSegment& a, const SnapshotCameraCutSegment& b) {
                      if (a.start != b.start) return a.start < b.start;
                      return a.end < b.end;
                  });
        return !outSegments.empty();
    }

    static INode* FindCameraNodeForTime(const std::vector<SnapshotCameraCutSegment>& segments,
                                        TimeValue sampleTime,
                                        INode* fallbackNode) {
        for (const auto& segment : segments) {
            if (segment.node && sampleTime >= segment.start && sampleTime <= segment.end) {
                return segment.node;
            }
        }
        return fallbackNode;
    }

    static bool BuildActiveCameraAnimationTarget(Interface* ip,
                                                 const Interval& range,
                                                 TimeValue currentTime,
                                                 const SnapshotExportOptions& options,
                                                 ULONG lockedCameraHandle,
                                                 SnapshotAnimationTargetDef& outTarget) {
        if (!ip) return false;

        INode* cameraNode = nullptr;
        if (lockedCameraHandle != 0) {
            cameraNode = ip->GetINodeByHandle(lockedCameraHandle);
            if (cameraNode) {
                ObjectState lockedOs = cameraNode->EvalWorldState(currentTime);
                if (!lockedOs.obj || lockedOs.obj->SuperClassID() != CAMERA_CLASS_ID) {
                    cameraNode = nullptr;
                }
            }
        }
        if (!cameraNode) {
            ViewExp& vp = ip->GetActiveViewExp();
            cameraNode = vp.GetViewCamera();
        }
        if (!cameraNode) {
            return false;
        }

        ObjectState cameraState = cameraNode->EvalWorldState(currentTime);
        CameraObject* cameraObject =
            (cameraState.obj && cameraState.obj->SuperClassID() == CAMERA_CLASS_ID)
                ? static_cast<CameraObject*>(cameraState.obj)
                : nullptr;
        if (!cameraObject) {
            return false;
        }

        std::vector<SnapshotCameraCutSegment> cameraSegments;
        TryBuildStateSetCameraSegments(ip, range, cameraSegments);
        if (cameraSegments.empty()) {
            SnapshotCameraCutSegment fallbackSegment;
            fallbackSegment.start = range.Start();
            fallbackSegment.end = range.End();
            fallbackSegment.handle = cameraNode->GetHandle();
            fallbackSegment.node = cameraNode;
            fallbackSegment.name = cameraNode->GetName();
            cameraSegments.push_back(std::move(fallbackSegment));
        }

        std::vector<TimeValue> discoveryTimes;
        const bool hasCameraCuts = cameraSegments.size() > 1;
        bool hasTransformAnimation =
            BuildAnimatableTimeSamples(cameraNode->GetTMController(), range, currentTime, discoveryTimes);
        bool hasLensAnimation = BuildAnimatableTimeSamples(cameraObject, range, currentTime, discoveryTimes);
        if (GenCamera* genCamera = dynamic_cast<GenCamera*>(cameraObject)) {
            hasLensAnimation =
                BuildAnimatableTimeSamples(genCamera->GetFOVControl(), range, currentTime, discoveryTimes) ||
                hasLensAnimation;
        }
        hasTransformAnimation = hasTransformAnimation || hasCameraCuts;
        if (!hasTransformAnimation && !hasLensAnimation) {
            return false;
        }

        std::vector<TimeValue> sampleTimes;
        AppendFrameSampleTimes(sampleTimes, range, options.animationSampleStepFrames);
        for (size_t i = 1; i < cameraSegments.size(); ++i) {
            if (cameraSegments[i].start > range.Start()) {
                AppendUniqueTimeValue(sampleTimes, cameraSegments[i].start - 1);
            }
            AppendUniqueTimeValue(sampleTimes, cameraSegments[i].start);
        }
        SortUniqueTimeValues(sampleTimes);
        if (sampleTimes.size() < 2) {
            return false;
        }

        SnapshotAnimationTrackDef positionTrack;
        positionTrack.path = L"position";
        positionTrack.type = L"vector3";
        positionTrack.interpolation = L"linear";

        SnapshotAnimationTrackDef targetTrack;
        targetTrack.path = L"cameraTarget";
        targetTrack.type = L"vector3";
        targetTrack.interpolation = L"linear";

        SnapshotAnimationTrackDef upTrack;
        upTrack.path = L"cameraUp";
        upTrack.type = L"vector3";
        upTrack.interpolation = L"linear";

        SnapshotAnimationTrackDef fovTrack;
        fovTrack.path = L"fovHorizontal";
        fovTrack.type = L"number";
        fovTrack.interpolation = L"linear";

        SnapshotAnimationTrackDef viewWidthTrack;
        viewWidthTrack.path = L"viewWidth";
        viewWidthTrack.type = L"number";
        viewWidthTrack.interpolation = L"linear";

        bool posChanged = false;
        bool targetChanged = false;
        bool upChanged = false;
        bool fovChanged = false;
        bool viewWidthChanged = false;
        bool havePrevious = false;
        Point3 previousPos(0.0f, 0.0f, 0.0f);
        Point3 previousTarget(0.0f, 0.0f, 0.0f);
        Point3 previousUp(0.0f, 1.0f, 0.0f);
        float previousFov = 0.0f;
        float previousViewWidth = 0.0f;
        bool exportingOrtho = false;

        for (TimeValue sampleTime : sampleTimes) {
            INode* sampleCameraNode = FindCameraNodeForTime(cameraSegments, sampleTime, cameraNode);
            if (!sampleCameraNode) continue;

            cameraState = sampleCameraNode->EvalWorldState(sampleTime);
            cameraObject =
                (cameraState.obj && cameraState.obj->SuperClassID() == CAMERA_CLASS_ID)
                    ? static_cast<CameraObject*>(cameraState.obj)
                    : nullptr;
            if (!cameraObject) continue;

            Interval valid = FOREVER;
            CameraState cs;
            if (cameraObject->EvalCameraState(sampleTime, valid, &cs) != REF_SUCCEED) {
                continue;
            }

            const Matrix3 cameraTM = sampleCameraNode->GetNodeTM(sampleTime);
            const Point3 maxPos = cameraTM.GetTrans();
            Point3 maxForward = -Normalize(cameraTM.GetRow(2));
            Point3 maxUp = Normalize(cameraTM.GetRow(1));
            Point3 pos = MaxPointToWorld(maxPos);
            Point3 target = pos + Normalize(MaxPointToWorld(maxForward)) * 100.0f;
            Point3 up = Normalize(MaxPointToWorld(maxUp));

            const float seconds = TimeValueToAnimationSeconds(sampleTime, range.Start());
            positionTrack.times.push_back(seconds);
            positionTrack.values.push_back(pos.x);
            positionTrack.values.push_back(pos.y);
            positionTrack.values.push_back(pos.z);

            targetTrack.times.push_back(seconds);
            targetTrack.values.push_back(target.x);
            targetTrack.values.push_back(target.y);
            targetTrack.values.push_back(target.z);

            upTrack.times.push_back(seconds);
            upTrack.values.push_back(up.x);
            upTrack.values.push_back(up.y);
            upTrack.values.push_back(up.z);

            const bool isOrtho = cs.isOrtho != FALSE;
            if (!havePrevious) exportingOrtho = isOrtho;
            if (exportingOrtho) {
                viewWidthTrack.times.push_back(seconds);
                viewWidthTrack.values.push_back(cs.fov);
            } else {
                fovTrack.times.push_back(seconds);
                fovTrack.values.push_back(cs.fov * (180.0f / 3.14159265f));
            }

            if (havePrevious) {
                if (!NearlyEqualPoint3(pos, previousPos)) posChanged = true;
                if (!NearlyEqualPoint3(target, previousTarget)) targetChanged = true;
                if (!NearlyEqualPoint3(up, previousUp)) upChanged = true;
                if (exportingOrtho) {
                    if (std::fabs(cs.fov - previousViewWidth) > 1.0e-4f) viewWidthChanged = true;
                } else if (std::fabs(cs.fov - previousFov) > 1.0e-4f) {
                    fovChanged = true;
                }
            }

            previousPos = pos;
            previousTarget = target;
            previousUp = up;
            previousFov = cs.fov;
            previousViewWidth = cs.fov;
            havePrevious = true;
        }

        outTarget.target = L"camera:active";
        if (posChanged) outTarget.tracks.push_back(std::move(positionTrack));
        if (targetChanged) outTarget.tracks.push_back(std::move(targetTrack));
        if (upChanged) outTarget.tracks.push_back(std::move(upTrack));
        if (viewWidthChanged) outTarget.tracks.push_back(std::move(viewWidthTrack));
        if (fovChanged) outTarget.tracks.push_back(std::move(fovTrack));
        return !outTarget.tracks.empty();
    }

    static void WriteSnapshotAnimationTrackJson(std::wostringstream& ss,
                                                const SnapshotAnimationTrackDef& track) {
        ss << L"{\"path\":\"" << EscapeJson(track.path.c_str()) << L"\"";
        if (!track.type.empty()) {
            ss << L",\"type\":\"" << EscapeJson(track.type.c_str()) << L"\"";
        }
        if (!track.interpolation.empty()) {
            ss << L",\"interpolation\":\"" << EscapeJson(track.interpolation.c_str()) << L"\"";
        }
        ss << L",\"times\":";
        WriteFloats(ss, track.times.data(), track.times.size());
        if (track.isGeometryFrames) {
            ss << L",\"frames\":[";
            for (size_t i = 0; i < track.geometryFrames.size(); ++i) {
                if (i) ss << L',';
                const auto& frame = track.geometryFrames[i];
                ss << L"{\"vOff\":" << frame.vOff
                   << L",\"vN\":" << frame.vN
                   << L",\"iOff\":" << frame.iOff
                   << L",\"iN\":" << frame.iN;
                if (frame.uvN > 0) {
                    ss << L",\"uvOff\":" << frame.uvOff
                       << L",\"uvN\":" << frame.uvN;
                }
                if (frame.nN > 0) {
                    ss << L",\"nOff\":" << frame.nOff
                       << L",\"nN\":" << frame.nN;
                }
                if (frame.spline) ss << L",\"spline\":true";
                if (!frame.groups.empty()) {
                    ss << L",\"groups\":[";
                    for (size_t g = 0; g < frame.groups.size(); ++g) {
                        if (g) ss << L',';
                        ss << L'[' << frame.groups[g].start
                           << L',' << frame.groups[g].count
                           << L',' << g << L']';
                    }
                    ss << L']';
                }
                ss << L'}';
            }
            ss << L']';
        } else {
            ss << L",\"values\":";
            if (track.isBoolean) {
                ss << L'[';
                for (size_t i = 0; i < track.boolValues.size(); ++i) {
                    if (i) ss << L',';
                    ss << (track.boolValues[i] ? L"true" : L"false");
                }
                ss << L']';
            } else {
                WriteFloats(ss, track.values.data(), track.values.size());
            }
        }
        ss << L'}';
    }

    static bool BuildMorpherInfluenceAnimationTracks(Interface* ip,
                                                     INode* meshNode,
                                                     const Interval& range,
                                                     TimeValue currentTime,
                                                     const SnapshotExportOptions& options,
                                                     const std::vector<int>& morphChannelIds,
                                                     SnapshotAnimationTargetDef& outTarget) {
        (void)currentTime;
        if (!ip || !meshNode || morphChannelIds.empty()) return false;
        Modifier* morphMod = FindModifierOnNode(meshNode, MR3_CLASS_ID);
        if (!morphMod) return false;
        IMorpher* morpher = static_cast<IMorpher*>(morphMod->GetInterface(I_MORPHER_INTERFACE_ID));
        if (!morpher) return false;

        std::vector<TimeValue> sampleTimes;
        AppendFrameSampleTimes(sampleTimes, range, options.animationSampleStepFrames);
        SortUniqueTimeValues(sampleTimes);
        if (sampleTimes.size() < 2) return false;

        const TimeValue savedTime = ip->GetTime();
        bool anyTrack = false;

        for (size_t mi = 0; mi < morphChannelIds.size(); ++mi) {
            const int cid = morphChannelIds[mi];
            SnapshotAnimationTrackDef tr;
            tr.path = L".morphTargetInfluences[" + std::to_wstring(mi) + L"]";
            tr.type = L"number";
            tr.interpolation = L"linear";

            std::vector<float> vals;
            vals.reserve(sampleTimes.size());
            for (TimeValue tv : sampleTimes) {
                ip->SetTime(tv);
                IMorpherChannel* ch = morpher->GetChannel(cid, false);
                double pct = 0.0;
                if (ch) pct = ch->GetTargetPercent(0);
                vals.push_back(static_cast<float>(pct / 100.0));
            }
            bool changed = false;
            for (size_t i = 1; i < vals.size(); ++i) {
                if (std::fabs(vals[i] - vals[0]) > 1.0e-5f) {
                    changed = true;
                    break;
                }
            }
            if (!changed) continue;

            for (size_t i = 0; i < sampleTimes.size(); ++i) {
                tr.times.push_back(TimeValueToAnimationSeconds(sampleTimes[i], range.Start()));
                tr.values.push_back(vals[i]);
            }
            outTarget.tracks.push_back(std::move(tr));
            anyTrack = true;
        }

        ip->SetTime(savedTime);
        return anyTrack;
    }

    static void WriteSnapshotAnimationsJson(std::wostringstream& ss,
                                            const std::vector<SnapshotNodeRecord>& nodes,
                                            Interface* ip,
                                            TimeValue currentTime,
                                            const SnapshotExportOptions& options,
                                            std::string& outAnimBinary,
                                            const std::unordered_set<ULONG>& skinRigMeshHandles,
                                            ULONG lockedCameraHandle) {
        if (!ip) return;

        const Interval range = ip->GetAnimRange();
        if (range.End() <= range.Start()) {
            return;
        }

        std::vector<SnapshotAnimationTargetDef> targets;
        targets.reserve(nodes.size() + 1);
        std::unordered_set<std::wstring> skinBonesAnimated;

        for (const auto& node : nodes) {
            SnapshotAnimationTargetDef target;
            SnapshotAnimationTargetDef part;
            if (options.includeTransformAnimation &&
                BuildNodeAnimationTarget(node.node, range, currentTime, options, part)) {
                MergeSnapshotAnimationTarget(target, std::move(part));
            }
            part = SnapshotAnimationTargetDef();
            if (options.includeGeometryAnimation &&
                skinRigMeshHandles.find(node.handle) == skinRigMeshHandles.end() &&
                BuildNodeGeometryAnimationTarget(node.node, range, currentTime, options, part, outAnimBinary)) {
                MergeSnapshotAnimationTarget(target, std::move(part));
            }
            part = SnapshotAnimationTargetDef();
            if (options.includeMaterialAnimation &&
                BuildNodeMaterialAnimationTarget(node, range, currentTime, options, part)) {
                MergeSnapshotAnimationTarget(target, std::move(part));
            }
            part = SnapshotAnimationTargetDef();
            if (node.skinRig && options.includeGeometryAnimation && !node.morphChannelIds.empty() &&
                BuildMorpherInfluenceAnimationTracks(
                    ip, node.node, range, currentTime, options, node.morphChannelIds, part)) {
                MergeSnapshotAnimationTarget(target, std::move(part));
            }
            if (!target.tracks.empty()) {
                targets.push_back(std::move(target));
            }

            if (node.skinRig && options.includeTransformAnimation) {
                const ULONG meshHandle = node.handle;
                for (size_t bi = 0; bi < node.skinBoneHandles.size(); bi++) {
                    ULONG bh = node.skinBoneHandles[bi];
                    if (bh == 0) continue;
                    INode* bn = ip->GetINodeByHandle(bh);
                    if (!bn) continue;

                    // Scoped key: meshHandle:boneHandle — allows same bone in multiple characters
                    const std::wstring scopedKey = std::to_wstring(meshHandle) + L":" + std::to_wstring(bh);
                    if (skinBonesAnimated.count(scopedKey)) continue;

                    INode* parentNode = nullptr;
                    const int parentIdx = (bi < node.skinBoneParents.size()) ? node.skinBoneParents[bi] : -1;
                    if (parentIdx >= 0 && parentIdx < static_cast<int>(node.skinBoneHandles.size())) {
                        parentNode = ip->GetINodeByHandle(node.skinBoneHandles[parentIdx]);
                    }
                    if (!parentNode) {
                        parentNode = node.node;
                    }

                    SnapshotAnimationTargetDef boneTarget;
                    if (BuildBoneAnimationTarget(bn, parentNode, range, currentTime, options, boneTarget)) {
                        boneTarget.target = L"handle:" + scopedKey;
                        targets.push_back(std::move(boneTarget));
                        skinBonesAnimated.insert(scopedKey);
                    }
                }
            }
        }

        // Light animations — only creates tracks if light or its parents are animated
        if (options.includeTransformAnimation) {
            INode* sceneRoot = ip->GetRootNode();
            std::function<void(INode*)> collectLightAnims = [&](INode* parent) {
                for (int i = 0; i < parent->NumberOfChildren(); ++i) {
                    INode* node = parent->GetChildNode(i);
                    if (!node) continue;

                    ObjectState os = node->EvalWorldState(currentTime);
                    if (os.obj && IsThreeJSLightClassID(os.obj->ClassID())) {
                        SnapshotAnimationTargetDef lightTarget;
                        if (BuildNodeAnimationTarget(node, range, currentTime, options, lightTarget)) {
                            targets.push_back(std::move(lightTarget));
                        }
                    }

                    collectLightAnims(node);
                }
            };
            if (sceneRoot) collectLightAnims(sceneRoot);
        }

        SnapshotAnimationTargetDef cameraTarget;
        if (options.includeCameraAnimation &&
            BuildActiveCameraAnimationTarget(
                ip, range, currentTime, options, lockedCameraHandle, cameraTarget)) {
            targets.push_back(std::move(cameraTarget));
        }

        if (targets.empty()) {
            return;
        }

        const float duration = TimeValueToAnimationSeconds(range.End(), range.Start());
        const TimeValue clampedTime = std::clamp(currentTime, range.Start(), range.End());
        const float currentSeconds = TimeValueToAnimationSeconds(clampedTime, range.Start());

        ss << L",\"animations\":{";
        ss << L"\"version\":1,";
        if (!outAnimBinary.empty()) {
            ss << L"\"bin\":\"scene_anim.bin\",";
        }
        ss << L"\"clips\":[{";
        ss << L"\"id\":\"scene\",";
        ss << L"\"name\":\"Scene\",";
        ss << L"\"autoPlay\":true,";
        ss << L"\"loop\":\"repeat\",";
        ss << L"\"start\":0,";
        ss << L"\"end\":";
        WriteFloatValue(ss, duration, 0.0f);
        ss << L",\"duration\":";
        WriteFloatValue(ss, duration, 0.0f);
        ss << L",\"time\":";
        WriteFloatValue(ss, currentSeconds, 0.0f);
        ss << L",\"targets\":[";
        for (size_t i = 0; i < targets.size(); ++i) {
            if (i) ss << L',';
            ss << L"{\"target\":\"" << EscapeJson(targets[i].target.c_str()) << L"\",\"tracks\":[";
            for (size_t j = 0; j < targets[i].tracks.size(); ++j) {
                if (j) ss << L',';
                WriteSnapshotAnimationTrackJson(ss, targets[i].tracks[j]);
            }
            ss << L"]}";
        }
        ss << L"]}]}";
    }

    bool CopySnapshotRuntime(const std::wstring& webDir,
                             const std::wstring& outDir,
                             bool copySparkDist,
                             std::wstring& error) {
        if (!CopyFileEnsuringDirectories(webDir + L"\\index.html", outDir + L"\\index.html")) {
            error = L"Failed to copy snapshot runtime index.html";
            return false;
        }

        if (!CopyDirectoryRecursive(webDir + L"\\js", outDir + L"\\js")) {
            error = L"Failed to copy snapshot runtime js directory";
            return false;
        }

        if (!DirectoryExists(webDir + L"\\vendor")) {
            error = L"Snapshot runtime dependency missing: web/vendor (three.js, etc.)";
            return false;
        }
        if (!CopyDirectoryRecursive(webDir + L"\\vendor", outDir + L"\\vendor")) {
            error = L"Failed to copy snapshot runtime vendor directory";
            return false;
        }

        if (copySparkDist) {
            const std::wstring sparkDist = webDir + L"\\node_modules\\@sparkjsdev\\spark\\dist";
            if (!DirectoryExists(sparkDist)) {
                error = L"Snapshot runtime dependency missing: @sparkjsdev/spark/dist";
                return false;
            }

            if (!CopyDirectoryRecursive(
                    sparkDist,
                    outDir + L"\\node_modules\\@sparkjsdev\\spark\\dist")) {
                error = L"Failed to copy snapshot runtime spark dist";
                return false;
            }
        }

        return true;
    }

    bool BuildSnapshotBinary(std::wstring& outMetaJson,
                             std::string& outBinary,
                             std::string& outAnimBinary,
                             const std::wstring& snapshotUiJson,
                             const std::wstring& runtimeSceneJson,
                             const SnapshotExportOptions& options,
                             std::wstring& error) {
        Interface* ip = GetCOREInterface();
        if (!ip) {
            error = L"3ds Max interface unavailable";
            return false;
        }

        INode* root = ip->GetRootNode();
        if (!root) {
            error = L"3ds Max scene root unavailable";
            return false;
        }

        TimeValue t = ip->GetTime();

        std::vector<SnapshotNodeRecord> nodes;
        size_t totalBytes = 0;
        std::unordered_set<ULONG> skinRigMeshHandles;

        std::function<void(INode*)> collect = [&](INode* parent) {
            for (int i = 0; i < parent->NumberOfChildren(); ++i) {
                INode* node = parent->GetChildNode(i);
                if (!node) continue;

                // Always recurse into children — a hidden group node
                // (e.g. PointHelper on a hidden layer) may have visible children.
                ObjectState os = node->EvalWorldState(t);
                if (os.obj && IsThreeJSSplatClassID(os.obj->ClassID())) {
                    collect(node);
                    continue;
                }
                if (IsForestPackNode(node) || IsRailCloneNode(node) ||
                    (IsTyFlowAvailable() && IsTyFlowNode(node))) {
                    collect(node);
                    continue;
                }

                // Skip hidden nodes from extraction but still recurse below
                if (node->IsNodeHidden(TRUE)) {
                    collect(node);
                    continue;
                }

                SnapshotNodeRecord snapshotNode;
                snapshotNode.handle = node->GetHandle();
                snapshotNode.node = node;
                snapshotNode.visible =
                    !node->IsNodeHidden(TRUE) && node->GetVisibility(t) > 0.0f && node->Renderable();

                bool extracted = ExtractMesh(node, t, snapshotNode.verts, snapshotNode.uvs,
                    snapshotNode.indices, snapshotNode.groups, &snapshotNode.norms, nullptr, &snapshotNode.vertexColors);

                if (!extracted && ShouldExtractRenderableShape(node, t, &os)) {
                    extracted = ExtractSpline(node, t, snapshotNode.verts, snapshotNode.indices);
                    snapshotNode.spline = extracted;
                    if (extracted) {
                        snapshotNode.uvs.clear();
                        snapshotNode.norms.clear();
                        snapshotNode.vertexColors.clear();
                        snapshotNode.groups.clear();
                    }
                }

                if (extracted) {
                    if (!snapshotNode.spline) {
                        std::vector<std::wstring> morphNamesTmp;
                        std::vector<int> morphChIdsTmp;
                        std::vector<float> morphInflTmp;
                        std::vector<std::vector<float>> morphChTmp;
                        if (TryExtractSkinRigData(
                                snapshotNode.node,
                                t,
                                snapshotNode.verts,
                                snapshotNode.uvs,
                                snapshotNode.norms,
                                snapshotNode.indices,
                                snapshotNode.groups,
                                snapshotNode.skinBoneHandles,
                                snapshotNode.skinBoneParents,
                                snapshotNode.skinBoneBindLocal,
                                snapshotNode.skinWData,
                                snapshotNode.skinIdxData,
                                morphNamesTmp,
                                morphChIdsTmp,
                                morphInflTmp,
                                morphChTmp)) {
                            snapshotNode.skinRig = true;
                            snapshotNode.morphNames = std::move(morphNamesTmp);
                            snapshotNode.morphChannelIds = std::move(morphChIdsTmp);
                            snapshotNode.morphInfluences = std::move(morphInflTmp);
                            snapshotNode.morphChannelsData = std::move(morphChTmp);
                            skinRigMeshHandles.insert(snapshotNode.handle);
                        }
                    }

                    // Calculate ALL binary offsets after skin/morph extraction
                    // (bind pose replaces verts/uvs/norms/indices — use final sizes)
                    snapshotNode.vOff = totalBytes;
                    totalBytes += snapshotNode.verts.size() * sizeof(float);
                    snapshotNode.iOff = totalBytes;
                    totalBytes += snapshotNode.indices.size() * sizeof(int);
                    snapshotNode.uvOff = totalBytes;
                    totalBytes += snapshotNode.uvs.size() * sizeof(float);
                    snapshotNode.nOff = totalBytes;
                    totalBytes += snapshotNode.norms.size() * sizeof(float);
                    for (VertexColorAttributeRecord& attr : snapshotNode.vertexColors) {
                        attr.off = totalBytes;
                        totalBytes += attr.values.size() * sizeof(float);
                    }
                    if (snapshotNode.skinRig) {
                        snapshotNode.skinWOff = totalBytes;
                        totalBytes += snapshotNode.skinWData.size() * sizeof(float);
                        snapshotNode.skinIndOff = totalBytes;
                        totalBytes += snapshotNode.skinIdxData.size() * sizeof(float);
                        snapshotNode.skinBoneBindOff = totalBytes;
                        totalBytes += snapshotNode.skinBoneBindLocal.size() * sizeof(float);
                        for (size_t mi = 0; mi < snapshotNode.morphChannelsData.size(); ++mi) {
                            snapshotNode.morphDOff.push_back(totalBytes);
                            snapshotNode.morphDN.push_back(
                                static_cast<int>(snapshotNode.morphChannelsData[mi].size()));
                            totalBytes += snapshotNode.morphChannelsData[mi].size() * sizeof(float);
                        }
                    }

                    nodes.push_back(std::move(snapshotNode));
                }

                collect(node);
            }
        };
        if (options.includeSceneNodes) {
            collect(root);
        }

        outBinary.assign(std::max<size_t>(totalBytes, 4), '\0');
        BYTE* buffer = reinterpret_cast<BYTE*>(outBinary.data());

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"scene_bin\",\"frame\":1";
        ss << L",\"bin\":\"scene.bin\"";
        ss << L",\"stats\":{\"producerBytes\":" << totalBytes << L"}";
        ss << L",\"nodes\":[";

        bool first = true;
        for (auto& node : nodes) {
            float xform[16];
            if (node.skinRig) {
                // Skinned mesh: use Skin's init transform to match bind pose
                Modifier* sm = FindModifierOnNode(node.node, SKIN_CLASSID);
                ISkin* sk = sm ? static_cast<ISkin*>(sm->GetInterface(I_SKIN)) : nullptr;
                Matrix3 initTM;
                if (sk && sk->GetSkinInitTM(node.node, initTM) == SKIN_OK) {
                    Point3 r0 = initTM.GetRow(0), r1 = initTM.GetRow(1), r2 = initTM.GetRow(2), tr = initTM.GetTrans();
                    xform[0]=r0.x; xform[1]=r0.y; xform[2]=r0.z; xform[3]=0;
                    xform[4]=r1.x; xform[5]=r1.y; xform[6]=r1.z; xform[7]=0;
                    xform[8]=r2.x; xform[9]=r2.y; xform[10]=r2.z; xform[11]=0;
                    xform[12]=tr.x; xform[13]=tr.y; xform[14]=tr.z; xform[15]=1;
                } else {
                    GetTransform16(node.node, t, xform);
                }
            } else {
                GetTransform16(node.node, t, xform);
            }

            if (!first) ss << L',';
            first = false;

            if (!node.verts.empty()) {
                memcpy(buffer + node.vOff, node.verts.data(), node.verts.size() * sizeof(float));
            }
            if (!node.indices.empty()) {
                memcpy(buffer + node.iOff, node.indices.data(), node.indices.size() * sizeof(int));
            }
            if (!node.uvs.empty()) {
                memcpy(buffer + node.uvOff, node.uvs.data(), node.uvs.size() * sizeof(float));
            }
            if (!node.norms.empty()) {
                memcpy(buffer + node.nOff, node.norms.data(), node.norms.size() * sizeof(float));
            }
            for (const VertexColorAttributeRecord& attr : node.vertexColors) {
                if (!attr.values.empty()) {
                    memcpy(buffer + attr.off, attr.values.data(), attr.values.size() * sizeof(float));
                }
            }
            if (node.skinRig) {
                if (!node.skinWData.empty()) {
                    memcpy(buffer + node.skinWOff, node.skinWData.data(), node.skinWData.size() * sizeof(float));
                }
                if (!node.skinIdxData.empty()) {
                    memcpy(buffer + node.skinIndOff, node.skinIdxData.data(), node.skinIdxData.size() * sizeof(float));
                }
                if (!node.skinBoneBindLocal.empty()) {
                    memcpy(buffer + node.skinBoneBindOff, node.skinBoneBindLocal.data(),
                           node.skinBoneBindLocal.size() * sizeof(float));
                }
                for (size_t mi = 0; mi < node.morphChannelsData.size(); ++mi) {
                    if (!node.morphChannelsData[mi].empty() && mi < node.morphDOff.size()) {
                        memcpy(buffer + node.morphDOff[mi], node.morphChannelsData[mi].data(),
                               node.morphChannelsData[mi].size() * sizeof(float));
                    }
                }
            }

            MaxJSPBR pbr;
            ExtractPBR(node.node, t, pbr);

            ss << L"{\"h\":" << node.handle;
            ss << L",\"n\":\"" << EscapeJson(node.node->GetName()) << L'"';
            ss << L",\"s\":" << (node.node->Selected() ? L'1' : L'0');
            ss << L",\"props\":{"; WriteNodePropsJson(ss, node.node, t); ss << L'}';
            { JsModData jm; GetJsModData(node.node, t, jm); if (jm.found) { ss << L","; WriteJsModJson(ss, jm); } }
            ss << L",\"vis\":" << (node.visible ? L'1' : L'0');
            ss << L",\"t\":"; WriteFloats(ss, xform, 16);
            if (node.spline) ss << L",\"spline\":true";

            ss << L",\"geo\":{\"vOff\":" << node.vOff;
            ss << L",\"vN\":" << node.verts.size();
            ss << L",\"iOff\":" << node.iOff;
            ss << L",\"iN\":" << node.indices.size();
            if (!node.uvs.empty()) {
                ss << L",\"uvOff\":" << node.uvOff;
                ss << L",\"uvN\":" << node.uvs.size();
            }
            if (!node.norms.empty()) {
                ss << L",\"nOff\":" << node.nOff;
                ss << L",\"nN\":" << node.norms.size();
            }
            WriteVertexColorOffsetsJson(ss, node.vertexColors);
            ss << L'}';
            if (node.skinRig) {
                ss << L",\"skin\":{";
                ss << L"\"bones\":[";
                for (size_t bi = 0; bi < node.skinBoneHandles.size(); ++bi) {
                    if (bi) ss << L',';
                    ss << node.skinBoneHandles[bi];
                }
                ss << L"],\"parent\":[";
                for (size_t bi = 0; bi < node.skinBoneParents.size(); ++bi) {
                    if (bi) ss << L',';
                    ss << node.skinBoneParents[bi];
                }
                ss << L"],\"wOff\":" << node.skinWOff
                   << L",\"wN\":" << node.skinWData.size()
                   << L",\"iOff\":" << node.skinIndOff
                   << L",\"iN\":" << node.skinIdxData.size()
                   << L",\"bindOff\":" << node.skinBoneBindOff
                   << L",\"bindN\":" << node.skinBoneBindLocal.size();
                ss << L"}";
                if (!node.morphNames.empty()) {
                    ss << L",\"morph\":{";
                    ss << L"\"names\":[";
                    for (size_t mi = 0; mi < node.morphNames.size(); ++mi) {
                        if (mi) ss << L',';
                        ss << L'"' << EscapeJson(node.morphNames[mi].c_str()) << L'"';
                    }
                    ss << L"],\"infl\":";
                    WriteFloats(ss, node.morphInfluences.data(), node.morphInfluences.size());
                    ss << L",\"dOff\":[";
                    for (size_t mi = 0; mi < node.morphDOff.size(); ++mi) {
                        if (mi) ss << L',';
                        ss << node.morphDOff[mi];
                    }
                    ss << L"],\"dN\":[";
                    for (size_t mi = 0; mi < node.morphDN.size(); ++mi) {
                        if (mi) ss << L',';
                        ss << node.morphDN[mi];
                    }
                    ss << L"]}";
                }
            }

            Mtl* multiMtl = FindMultiSubMtl(node.node->GetMtl());
            if (!node.spline && multiMtl && multiMtl->NumSubMtls() > 0 && node.groups.size() > 1) {
                ss << L",\"groups\":[";
                for (size_t g = 0; g < node.groups.size(); ++g) {
                    if (g) ss << L',';
                    ss << L'[' << node.groups[g].start << L',' << node.groups[g].count << L',' << g << L']';
                }
                ss << L"],\"mats\":[";
                for (size_t g = 0; g < node.groups.size(); ++g) {
                    if (g) ss << L',';
                    Mtl* subMtl = GetSubMtlFromMatID(multiMtl, node.groups[g].matID);
                    MaxJSPBR subPBR;
                    ExtractPBRFromMtl(subMtl, node.node, t, subPBR);
                    WriteMaterialFull(ss, subPBR);
                }
                ss << L"]";
            } else {
                ss << L",\"mat\":";
                WriteMaterialFull(ss, pbr);
            }

            ss << L'}';
        }

        ss << L"],";
        WriteCameraJson(ss);
        ss << L",";
        WriteSceneCamerasJson(ss);

        EnvData envData;
        GetEnvironment(envData);
        std::wstring hdriUrl;
        if (!envData.isSky && !envData.hdriPath.empty()) {
            hdriUrl = MapTexturePath(envData.hdriPath);
        }

        if (options.includeEnvironment) {
            ss << L",";
            WriteEnvJson(ss, envData, hdriUrl);
        }

        FogData fogData;
        GetFogData(fogData);
        if (options.includeFog) {
            ss << L",";
            WriteFogJson(ss, fogData);
        }
        if (options.includeLights) {
            ss << L",";
            WriteLightsJson(ss, ip, t, true, false, false);
        }
        if (options.includeSplats) {
            ss << L",";
            WriteSplatsJson(ss, ip, t, true, false, false);
        }
        if (options.includeAudios) {
            ss << L",";
            WriteAudiosJson(ss, ip, t, true, false, false);
        }
        if (options.includeGLTFs) {
            ss << L",";
            WriteGLTFsJson(ss, ip, t, true, false, false);
        }
        if (options.includeAnimations) {
            WriteSnapshotAnimationsJson(
                ss, nodes, ip, t, options, outAnimBinary, skinRigMeshHandles, lockedCameraHandle_);
        }

        if (options.includeInstances) {
            std::vector<ForestInstanceGroup> allInstGroups;
            std::function<void(INode*)> collectInstances = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); ++c) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE)) {
                        collectInstances(node);
                        continue;
                    }
                    if (IsMaxJsSyncDrawVisible(node)) {
                        if (IsForestPackAvailable() && IsForestPackNode(node))
                            ExtractForestPackInstances(node, t, allInstGroups);
                        else if (IsRailCloneAvailable() && IsRailCloneNode(node))
                            ExtractRailCloneInstances(node, t, allInstGroups);
                        else if (IsTyFlowAvailable() && IsTyFlowNode(node))
                            ExtractTyFlowInstances(node, t, allInstGroups);
                    }
                    collectInstances(node);
                }
            };
            collectInstances(root);

            if (!allInstGroups.empty()) {
                ss << L",\"forestInstances\":[";
                bool firstGroup = true;
                for (auto& group : allInstGroups) {
                    if (group.verts.empty() || group.transforms.empty()) continue;
                    if (!firstGroup) ss << L',';
                    firstGroup = false;
                    ss << L"{\"src\":" << group.groupKey;
                    ss << L",\"count\":" << group.instanceCount;
                    ss << L",\"v\":"; WriteFloats(ss, group.verts.data(), group.verts.size());
                    ss << L",\"i\":"; WriteInts(ss, group.indices.data(), group.indices.size());
                    if (!group.uvs.empty()) {
                        ss << L",\"uv\":"; WriteFloats(ss, group.uvs.data(), group.uvs.size());
                    }
                    if (!group.norms.empty()) {
                        ss << L",\"norm\":"; WriteFloats(ss, group.norms.data(), group.norms.size());
                    }
                    ss << L",\"xforms\":";
                    WriteFloats(ss, group.transforms.data(), group.transforms.size());
                    WriteInstanceGroupMaterial(ss, group, t);
                    ss << L'}';
                }
                ss << L']';
            }
            WriteHairInstanceGroupsJson(ss, root, t);
        }

        if (options.includeSnapshotUi && !snapshotUiJson.empty()) {
            ss << L",\"snapshotUi\":" << snapshotUiJson;
        }
        if (options.includeRuntimeScene && !runtimeSceneJson.empty()) {
            ss << L",\"runtimeScene\":" << runtimeSceneJson;
        }

        ss << L'}';
        outMetaJson = ss.str();
        return true;
    }

    bool ExportSnapshotSite(const std::wstring& snapshotUiJson,
                            const std::wstring& runtimeSceneJson,
                            const SnapshotExportOptions& options,
                            std::wstring& outDir,
                            std::wstring& error) {
        const std::wstring webDir = GetWebDir();
        if (webDir.empty()) {
            error = L"Web runtime folder not found";
            return false;
        }

        outDir = GetNamedSnapshotDir(options.exportName);
        if (!RecreateDirectory(outDir)) {
            error = L"Failed to recreate snapshot directory";
            return false;
        }

        // Helper: clean up dist/ on any failure after this point
        auto cleanupOnFail = [&]() {
            std::error_code ec;
            std::filesystem::remove_all(std::filesystem::path(outDir), ec);
        };

        if (!CopySnapshotRuntime(webDir, outDir, options.includeSplats, error)) {
            cleanupOnFail();
            return false;
        }

        std::wstring metaJson;
        std::string binary;
        std::string animBinary;
        if (!BuildSnapshotBinary(metaJson, binary, animBinary, snapshotUiJson, runtimeSceneJson, options, error)) {
            cleanupOnFail();
            return false;
        }

        if (options.copyAssets && !RewriteSnapshotAssetUrls(metaJson, outDir, error)) {
            cleanupOnFail();
            return false;
        }

        if (!WriteUtf8File(outDir + L"\\snapshot.json", metaJson)) {
            error = L"Failed to write snapshot.json";
            cleanupOnFail();
            return false;
        }
        if (!WriteBinaryFile(outDir + L"\\scene.bin", binary)) {
            error = L"Failed to write scene.bin";
            cleanupOnFail();
            return false;
        }
        if (!animBinary.empty() && !WriteBinaryFile(outDir + L"\\scene_anim.bin", animBinary)) {
            error = L"Failed to write scene_anim.bin";
            cleanupOnFail();
            return false;
        }

        // Copy project layers when runtimeScene is included (needed for layer replay in snapshot)
        if (options.includeRuntimeScene) {
            const std::wstring projectManifestPath = GetProjectManifestPath();
            if (!projectManifestPath.empty() && FileExists(projectManifestPath)) {
                if (!CopyFileEnsuringDirectories(projectManifestPath, outDir + L"\\project.maxjs.json")) {
                    error = L"Failed to copy project.maxjs.json into snapshot";
                    cleanupOnFail();
                    return false;
                }
            }

            const std::wstring inlineDir = GetInlineLayerDir();
            if (!inlineDir.empty() && DirectoryExists(inlineDir)) {
                if (!CopyDirectoryRecursive(inlineDir, outDir + L"\\inlines")) {
                    error = L"Failed to copy inlines into snapshot";
                    cleanupOnFail();
                    return false;
                }
            }
        }

        // Copy postfx state when snapshotUi is included
        if (options.includeSnapshotUi) {
            const std::wstring postFxPath = GetProjectPostFxPath();
            if (!postFxPath.empty() && FileExists(postFxPath)) {
                if (!CopyFileEnsuringDirectories(postFxPath, outDir + L"\\postfx.maxjs.json")) {
                    error = L"Failed to copy postfx.maxjs.json into snapshot";
                    cleanupOnFail();
                    return false;
                }
            }
        }

        return true;
    }

    void SendHostActionResult(const std::wstring& action, const std::wstring& requestId,
                              bool ok, const std::wstring& error = {},
                              const std::wstring& path = {}) {
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
        if (!path.empty()) {
            ss << L",\"path\":\"" << EscapeJson(path.c_str()) << L"\"";
        }
        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void SendProjectReload() {
        if (!webview_) return;
        webview_->PostWebMessageAsJson(L"{\"type\":\"project_reload\"}");
    }

    void SendDebugMessage(const std::wstring& message) {
        if (!webview_ || !jsReady_) return;
        std::wostringstream ss;
        ss << L"{\"type\":\"debug\",\"msg\":\"" << EscapeJson(message.c_str()) << L"\"}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void SendProjectConfig() {
        if (!webview_) return;

        const std::wstring projectDir = GetProjectDir();
        const std::wstring inlineDir = GetInlineLayerDir();
        const bool sceneSaved = !projectDir.empty();
        const bool manifestExists = SceneProjectManifestExists();
        activeProjectDir_ = projectDir;
        activeProjectStamp_ = projectDir.empty() ? 0 : GetProjectRuntimeWriteStamp(projectDir);
        std::wostringstream ss;
        ss << L"{\"type\":\"project_config\",\"dir\":\""
           << EscapeJson(projectDir.c_str())
           << L"\",\"inlineDir\":\"" << EscapeJson(inlineDir.c_str())
           << L"\",\"pollMs\":0"
           << L",\"sceneSaved\":" << (sceneSaved ? L"true" : L"false")
           << L",\"manifestExists\":" << (manifestExists ? L"true" : L"false")
           << L"}";
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
        skinnedHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        audioHandles_.clear();
        gltfHandles_.clear();
        hairHandles_.clear();
        deformHandles_.clear();
        fastDirtyHandles_.clear();
        lastSentTransforms_.clear();
        mtlHashMap_.clear();
        mtlScalarHashMap_.clear();
        lightHashMap_.clear();
        splatHashMap_.clear();
        audioHashMap_.clear();
        gltfHashMap_.clear();
        propHashMap_.clear();
        geoHashMap_.clear();
        jsmodStateMap_.clear();
        groupCache_.clear();
        lastBBoxHash_.clear();
        lastLiveGeomHash_.clear();
        skinnedControlIdxCache_.clear();
        lastSkinnedLivePollTick_ = 0;
        ClearBakedMapCache();
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
        if (activeProjectDir_ != projectDir) {
            activeProjectDir_ = projectDir;
            activeProjectStamp_ = projectDir.empty() ? 0 : GetProjectRuntimeWriteStamp(projectDir);
            SendProjectConfig();
            SendProjectReload();
            return;
        }
        if (projectDir.empty()) return;

        const std::uint64_t nextStamp = GetProjectRuntimeWriteStamp(projectDir);
        if (activeProjectStamp_ == 0) {
            activeProjectStamp_ = nextStamp;
            if (nextStamp != 0) SendProjectReload();
            return;
        }

        if (nextStamp != activeProjectStamp_) {
            activeProjectStamp_ = nextStamp;
            if (suppressProjectReloadCount_ > 0) {
                suppressProjectReloadCount_--;
                return;
            }
            SendProjectReload();
            // Kick a scene resync so materialCache rebuilds. HTML texmap
            // materials re-fetch their source file on the next sync via
            // Cache-Control: no-store, picking up any .html edit.
            SetDirtyImmediate();
        }
    }

    // Locate the directory (with trailing backslash) that contains the inline layer file
    // matching `id` (either `.js` or `.js.disabled`). Handles nested folders. Returns
    // empty string if not found.
    static std::wstring FindInlineLayerFileDir(const std::wstring& rootDir, const std::wstring& id) {
        if (!DirectoryExists(rootDir)) return {};
        const std::wstring enabledName = GetInlineLayerFileName(id, true);
        const std::wstring disabledName = GetInlineLayerFileName(id, false);
        if (FileExists(rootDir + enabledName) || FileExists(rootDir + disabledName)) return rootDir;

        const std::wstring pattern = rootDir + L"*";
        WIN32_FIND_DATAW fd = {};
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind == INVALID_HANDLE_VALUE) return {};
        std::wstring found;
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) continue;
            const std::wstring sub = rootDir + fd.cFileName + L"\\";
            std::wstring hit = FindInlineLayerFileDir(sub, id);
            if (!hit.empty()) { found = hit; break; }
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
        return found;
    }

    static bool ResolveInlineLayerFileDir(const std::wstring& rootDir,
                                          const std::wstring& id,
                                          const std::wstring& folder,
                                          std::wstring& dirOut,
                                          std::wstring& error) {
        dirOut.clear();
        if (rootDir.empty() || !DirectoryExists(rootDir)) {
            error = L"Scene-local inline folder is not available";
            return false;
        }

        if (!folder.empty()) {
            std::wstring normalizedFolder;
            if (!NormalizeInlineLayerFolder(folder, normalizedFolder)) {
                error = L"Invalid inline layer folder";
                return false;
            }
            std::wstring exactDir = rootDir;
            if (!normalizedFolder.empty()) exactDir += normalizedFolder + L"\\";
            if (!DirectoryExists(exactDir)) {
                error = L"Inline layer file not found";
                return false;
            }
            const std::wstring enabledPath = exactDir + GetInlineLayerFileName(id, true);
            const std::wstring disabledPath = exactDir + GetInlineLayerFileName(id, false);
            if (!FileExists(enabledPath) && !FileExists(disabledPath)) {
                error = L"Inline layer file not found";
                return false;
            }
            dirOut = exactDir;
            return true;
        }

        dirOut = FindInlineLayerFileDir(rootDir, id);
        if (dirOut.empty()) {
            error = L"Inline layer file not found";
            return false;
        }
        return true;
    }

    static bool ClearInlineLayerFilesRecursive(const std::wstring& dir,
                                               std::wstring& error,
                                               bool removeEmptyDir = false) {
        if (dir.empty() || !DirectoryExists(dir)) return true;

        const std::wstring pattern = dir + L"*";
        WIN32_FIND_DATAW fd = {};
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind == INVALID_HANDLE_VALUE) return true;

        std::vector<std::wstring> childDirs;
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                childDirs.push_back(dir + fd.cFileName + L"\\");
                continue;
            }

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

        for (const auto& childDir : childDirs) {
            if (!ClearInlineLayerFilesRecursive(childDir, error, true)) {
                return false;
            }
        }

        if (removeEmptyDir) {
            RemoveDirectoryW(dir.c_str()); // best-effort cleanup of empty folders
        }
        return true;
    }

    bool RemoveInlineLayerFile(const std::wstring& id, const std::wstring& folder, std::wstring& error) {
        const std::wstring rootDir = GetInlineHotLayerDir();
        std::wstring dir;
        if (!ResolveInlineLayerFileDir(rootDir, id, folder, dir, error)) {
            return false;
        }
        const std::wstring enabledPath = dir + GetInlineLayerFileName(id, true);
        const std::wstring disabledPath = dir + GetInlineLayerFileName(id, false);

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

        SendInlineLayersState(true);
        return true;
    }

    bool SetInlineLayerEnabled(const std::wstring& id,
                               const std::wstring& folder,
                               bool enabled,
                               std::wstring& error) {
        const std::wstring rootDir = GetInlineHotLayerDir();
        std::wstring dir;
        if (!ResolveInlineLayerFileDir(rootDir, id, folder, dir, error)) {
            return false;
        }
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

        if (jsReady_) {
            SendInlineLayersState(true);
        } else {
            inlineLayersStateSignature_.clear();
        }
        return true;
    }

    bool ClearInlineLayerFiles(std::wstring& error) {
        const std::wstring dir = GetInlineHotLayerDir();
        if (dir.empty() || !DirectoryExists(dir)) {
            SendInlineLayersState(true);
            return true;
        }
        if (!ClearInlineLayerFilesRecursive(dir, error)) return false;

        SendInlineLayersState(true);
        return true;
    }

    bool WriteProjectManifestContent(const std::wstring& contentBase64, std::wstring& error, bool triggerReload = true) {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) {
            error = L"Save the scene first";
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
        if (triggerReload) {
            SendProjectReload();
        } else {
            suppressProjectReloadCount_ = std::max(suppressProjectReloadCount_, 2);
        }
        return true;
    }

    bool WriteProjectPostFxContent(const std::wstring& contentBase64, std::wstring& error) {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) {
            error = L"Save the scene first";
            return false;
        }

        SHCreateDirectoryExW(nullptr, projectDir.c_str(), nullptr);

        std::string decoded;
        if (!DecodeBase64Wide(contentBase64, decoded)) {
            error = L"Invalid base64 post fx payload";
            return false;
        }

        const std::wstring postFxPath = GetProjectPostFxPath();
        if (!WriteBinaryFile(postFxPath, decoded)) {
            error = L"Failed to write post fx state";
            return false;
        }

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
            || splatHandles_.find(handle) != splatHandles_.end()
            || audioHandles_.find(handle) != audioHandles_.end()
            || gltfHandles_.find(handle) != gltfHandles_.end()
            || hairHandles_.find(handle) != hairHandles_.end();
    }

    bool HasTrackedNodes() const {
        return !geomHandles_.empty() || !lightHandles_.empty() || !splatHandles_.empty()
            || !audioHandles_.empty() || !gltfHandles_.empty() || !hairHandles_.empty();
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

    void GetActiveCamera(CameraData& cam) {
        if (lockedCameraHandle_ != 0) {
            Interface* ip = GetCOREInterface();
            INode* camNode = ip ? ip->GetINodeByHandle(lockedCameraHandle_) : nullptr;
            if (camNode && GetSceneCameraData(camNode, ip->GetTime(), cam)) {
                return;
            }
            // Camera deleted or invalid — fall back to viewport
            lockedCameraHandle_ = 0;
        }
        GetViewportCamera(cam);
    }

    void CaptureCurrentCameraState() {
        GetActiveCamera(lastSentCamera_);
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
            if (!ShouldRunInteractiveGeometryChecks(node)) continue;
            ULONG handle = node->GetHandle();
            if (!IsTrackedHandle(handle)) continue;
            if (skinnedHandles_.count(handle)) continue;

            // Match DetectGeometryChanges / geo_fast payload: include UVs (HashNodeGeometryState omits them).
            uint64_t geomHash = 0;
            if (!TryHashRenderableGeometryState(node, t, geomHash))
                continue;
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

    // Deforming-mesh live check — polled every viewport redraw to pick up
    // animated modifier output (Skin bones, Path Deform, Bend, FFD, etc.).
    //
    // Performance contract: the critical path for bone dragging and animation
    // playback. Modifier evaluation is expensive, so we must not evaluate more
    // than once per frame. The old design did EvalWorldState here to hash
    // positions, then EvalWorldState AGAIN in SendGeometryFastUpdate for the
    // data. During interactive manipulation or playback we know the mesh is
    // changing, so skip the hash entirely — one eval per frame down from two.
    void CheckSkinnedGeometryLive() {
        if (skinnedHandles_.empty() && deformHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        const ULONGLONG now = GetTickCount64();
        if (lastSkinnedLivePollTick_ != 0 &&
            (now - lastSkinnedLivePollTick_) < kSkinnedLivePollIntervalMs) {
            return;
        }
        lastSkinnedLivePollTick_ = now;
        TimeValue t = ip->GetTime();

        // Any of these means "something is actively changing this frame" and
        // the hash check is wasted work — extraction will happen anyway:
        //   - Animation playback (time advancing every frame)
        //   - Interactive cooldown window (user dragged something recently)
        //   - Other tracked handles are dirty this frame (bone, controller, anything)
        //   - Any non-renderable (bone/helper/controller) is currently selected
        //
        // Falling into the hash path is only correct for true idle where nothing
        // is moving — it avoids redundant sends when the mesh genuinely isn't
        // changing. But during any kind of activity, hashing doubles the work.
        bool skipHash = IsAnimationPlaying()
                     || ShouldFavorInteractivePerformance()
                     || !fastDirtyHandles_.empty();

        if (!skipHash) {
            const int selCount = ip->GetSelNodeCount();
            for (int i = 0; i < selCount; ++i) {
                INode* sel = ip->GetSelNode(i);
                if (!sel) continue;
                const ULONG selH = sel->GetHandle();
                if (geomHandles_.find(selH) == geomHandles_.end() &&
                    lightHandles_.find(selH) == lightHandles_.end() &&
                    splatHandles_.find(selH) == splatHandles_.end() &&
                    audioHandles_.find(selH) == audioHandles_.end() &&
                    gltfHandles_.find(selH) == gltfHandles_.end() &&
                    hairHandles_.find(selH) == hairHandles_.end()) {
                    // Something non-renderable is selected — assume it's a bone
                    // or controller driving the skin, and skip the hash.
                    skipHash = true;
                    break;
                }
            }
        }

        bool changed = false;
        // Union iteration: skinned handles + deforming non-skinned handles
        // (Path Deform, Bend, FFD, etc.). Skinned handles are usually a strict
        // subset of deform handles, but we track both sets explicitly so skin
        // weight wiring can check skinnedHandles_ specifically.
        auto pollHandle = [&](ULONG handle) {
            if (geoFastDirtyHandles_.count(handle)) return;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) return;

            if (skipHash) {
                // Fast path: just mark dirty. SendGeometryFastUpdate will do
                // the one EvalWorldState we actually need (for data extraction).
                geoHashMap_.erase(handle);
                geoFastDirtyHandles_.insert(handle);
                changed = true;
                return;
            }

            // Idle path: hash raw vertex positions to avoid redundant sends
            // when nothing changed. This path does EvalWorldState, but only
            // fires when the scene is truly idle — the cost is acceptable.
            uint64_t geomHash = 0;
            ObjectState os = node->EvalWorldState(t);
            if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return;
            if (os.obj->IsSubClassOf(polyObjectClassID)) {
                PolyObject* poly = static_cast<PolyObject*>(os.obj);
                MNMesh& mn = poly->GetMesh();
                geomHash = HashAdaptiveSkinnedPositions(mn);
            } else if (os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) {
                TriObject* tri = static_cast<TriObject*>(
                    os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
                if (!tri) return;
                Mesh& mesh = tri->GetMesh();
                geomHash = HashAdaptiveSkinnedPositions(mesh);
                if (tri != os.obj) tri->DeleteThis();
            } else return;
            auto it = lastLiveGeomHash_.find(handle);
            if (it != lastLiveGeomHash_.end() && it->second == geomHash) return;
            lastLiveGeomHash_[handle] = geomHash;

            geoHashMap_.erase(handle);
            geoFastDirtyHandles_.insert(handle);
            changed = true;
        };

        for (ULONG handle : skinnedHandles_) pollHandle(handle);
        for (ULONG handle : deformHandles_) {
            // Skip handles already polled via skinnedHandles_ — most skinned
            // meshes also have a derived-object wrapper, but we only need one
            // eval per handle per tick.
            if (skinnedHandles_.count(handle)) continue;
            pollHandle(handle);
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
        if (!ShouldRunInteractiveMaterialChecks()) return;

        const ULONGLONG now = GetTickCount64();
        if (lastMaterialLivePollTick_ != 0 &&
            (now - lastMaterialLivePollTick_) < kMaterialLivePollIntervalMs) {
            return;
        }
        lastMaterialLivePollTick_ = now;

        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

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

            Mtl* supportedMtl = FindSupportedMaterial(rawMtl);
            if (supportedMtl && IsThreeJSMaterialClass(supportedMtl->ClassID())) {
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

                // Any supported-material edit must use the full sync path. The fast
                // material scalar channel only carries color/roughness/metalness/opacity
                // and will silently drop physical fields like clearcoat/IOR/specular.
                materialFastDirtyHandles_.clear();
                SetDirtyImmediate();
                return;
            }

            float col[3] = {0.8f, 0.8f, 0.8f};
            float rough = 0.5f;
            float metal = 0.0f;
            float opac = 1.0f;
            ExtractMaterialScalarPreview(supportedMtl, node, t, col, rough, metal, opac);

            const uint64_t scalarHash = HashMaterialScalarPreviewValues(col, rough, metal, opac);
            auto it = mtlScalarHashMap_.find(handle);
            if (it == mtlScalarHashMap_.end()) {
                mtlScalarHashMap_[handle] = scalarHash;
                continue;
            }

            if (it->second != scalarHash) {
                it->second = scalarHash;
                materialFastDirtyHandles_.clear();
                SetDirtyImmediate();
                return;
            }
        }
    }

    void RememberSentTransform(ULONG handle, const float* xform) {
        std::array<float, 16> cached = {};
        std::copy(xform, xform + 16, cached.begin());
        lastSentTransforms_[handle] = cached;
    }

    static constexpr ULONGLONG kInteractiveCooldownMs = 250;
    static constexpr ULONGLONG kMaterialInteractiveCooldownMs = 400;
    static constexpr ULONGLONG kMaterialLivePollIntervalMs = 50;
    static constexpr size_t kMaxFastFlushHandlesPerPass = 128;

    void MarkInteractiveActivity() {
        lastInteractionTick_ = GetTickCount64();
    }

    void MarkMaterialInteractiveActivity() {
        lastMaterialInteractionTick_ = GetTickCount64();
        MarkInteractiveActivity();
    }

    void NotifyMaterialEditedTarget(ReferenceTarget* target) {
        if (!target) {
            MarkMaterialInteractiveActivity();
            return;
        }

        if (geomHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            Mtl* rawMtl = node->GetMtl();
            Mtl* supportedMtl = FindSupportedMaterial(rawMtl);
            if (!supportedMtl) continue;
            if (!ReferenceTreeContains(supportedMtl, target)) continue;

            const MaterialSyncState state = ComputeMaterialSyncState(node, t);
            mtlHashMap_[handle] = state.structureHash;
            mtlScalarHashMap_[handle] = state.scalarHash;
            materialFastDirtyHandles_.clear();
            SetDirtyImmediate();
            return;
        }

        MarkMaterialInteractiveActivity();
    }

    bool IsAnimationPlaying() const {
        Interface* ip = GetCOREInterface();
        return ip && ip->IsAnimPlaying() != 0;
    }

    bool IsModifyTaskActive() const {
        Interface* ip = GetCOREInterface();
        return ip && ip->GetCommandPanelTaskMode() == TASK_MODE_MODIFY;
    }

    bool IsSubObjectEditingActive() const {
        Interface* ip = GetCOREInterface();
        return ip && ip->GetSubObjectLevel() > 0;
    }

    bool ShouldFavorInteractivePerformance() const {
        if (IsAnimationPlaying()) return true;
        const ULONGLONG now = GetTickCount64();
        return lastInteractionTick_ != 0 && (now - lastInteractionTick_) <= kInteractiveCooldownMs;
    }

    bool ShouldRunInteractiveMaterialChecks() const {
        const ULONGLONG now = GetTickCount64();
        return lastMaterialInteractionTick_ != 0 &&
               (now - lastMaterialInteractionTick_) <= kMaterialInteractiveCooldownMs;
    }

    bool IsCreateTaskActive() const {
        Interface* ip = GetCOREInterface();
        return ip && ip->GetCommandPanelTaskMode() == TASK_MODE_CREATE;
    }

    bool ShouldRunInteractiveGeometryChecks(INode* node) const {
        if (IsSubObjectEditingActive()) return true;
        if (IsCreateTaskActive()) return true;
        if (!IsModifyTaskActive()) return false;
        if (!ShouldFavorInteractivePerformance()) return false;

        Interface* ip = GetCOREInterface();
        if (!ip || !node) return false;

        BaseObject* editObj = ip->GetCurEditObject();
        if (!editObj) return false;

        if (editObj->GetInterface(EPOLY_MOD_INTERFACE) != nullptr) return false;
        if (editObj->GetInterface(EPOLY_INTERFACE) != nullptr) return false;
        return true;
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
        if (IsThreeJSAudioClassID(os.obj->ClassID())) return true;
        if (IsThreeJSGLTFClassID(os.obj->ClassID())) return true;

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
                // Hair handles get full re-extraction via SendHairFastUpdate —
                // they don't go through geoFastDirtyHandles_ (no mesh to send).
                if (hairHandles_.count(handle)) {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                    return;
                }
                geoFastDirtyHandles_.insert(handle);
                // Skinned + Path-Deform + any other deforming mesh only needs
                // vertex data updates via geo_fast. The node transform doesn't
                // change when a modifier's vertices animate — adding to
                // fastDirtyHandles_ would fire a redundant UpdateTransform each
                // frame during playback. When the node's transform actually
                // changes, MarkSelectedTransformsDirty / MarkAnimatedTransformsDirty
                // catch it through a real transform diff.
                if (skinnedHandles_.count(handle) || deformHandles_.count(handle)) {
                    changed = true;
                } else {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                }
            });
        }
        if (changed) QueueFastFlush();
    }

    // Topology change (add/remove faces/verts) — needs full sync (debounced)
    void MarkGeometryTopologyDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        bool changed = false;
        bool needsFullSync = false;
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;
            VisitNodeSubtree(node, [this, &changed, &needsFullSync](INode* current) {
                const ULONG handle = current->GetHandle();
                if (!IsTrackedHandle(handle)) return;
                geoHashMap_.erase(handle);
                // Skinned + deforming + selected nodes: route through fast
                // geo path. Max fires spurious TopologyChanged events on
                // *parameter* edits to modifiers (sphere radius, Path Deform
                // percent, FFD points, etc.) — these don't actually change
                // topology, but firing a full scene sync on every animated
                // frame is the ~100ms+ hitch the user sees during Path Deform
                // playback. The fast-positions handler on the JS side rebuilds
                // BufferGeometry if topology does change; real structural
                // edits to unselected non-deforming meshes still escalate.
                if (skinnedHandles_.count(handle) ||
                    deformHandles_.count(handle) ||
                    current->Selected()) {
                    geoFastDirtyHandles_.insert(handle);
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                } else {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                    needsFullSync = true;
                }
            });
        }
        if (needsFullSync) SetDirty();
        else if (changed) QueueFastFlush();
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
        if (changed) MarkInteractiveActivity();
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
        if (changed) MarkInteractiveActivity();
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
        if (changed) MarkInteractiveActivity();
    }

    void MarkTrackedAudioTransformsDirty() {
        if (audioHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : audioHandles_) {
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
        if (changed) MarkInteractiveActivity();
    }

    void MarkTrackedGLTFTransformsDirty() {
        if (gltfHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : gltfHandles_) {
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
        if (changed) MarkInteractiveActivity();
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
        fastDirtyHandles_.insert(audioHandles_.begin(), audioHandles_.end());
        fastDirtyHandles_.insert(gltfHandles_.begin(), gltfHandles_.end());
        fastDirtyHandles_.insert(hairHandles_.begin(), hairHandles_.end());
        QueueFastFlush();
    }

    void MarkAnimatedTransformsDirty() {
        if (!HasTrackedNodes()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const TimeValue t = ip->GetTime();
        bool changed = false;
        auto markIfTransformChanged = [this, t, &changed](ULONG handle) {
            INode* node = GetCOREInterface() ? GetCOREInterface()->GetINodeByHandle(handle) : nullptr;
            if (!node) return;

            float xform[16];
            GetTransform16(node, t, xform);

            auto it = lastSentTransforms_.find(handle);
            if (it == lastSentTransforms_.end() || !TransformEquals16(xform, it->second.data())) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        };

        for (ULONG handle : geomHandles_) markIfTransformChanged(handle);
        for (ULONG handle : lightHandles_) markIfTransformChanged(handle);
        for (ULONG handle : splatHandles_) markIfTransformChanged(handle);
        for (ULONG handle : audioHandles_) markIfTransformChanged(handle);
        for (ULONG handle : gltfHandles_) markIfTransformChanged(handle);
        for (ULONG handle : hairHandles_) markIfTransformChanged(handle);

        if (changed) {
            QueueFastFlush();
            MarkInteractiveActivity();
        }
    }

    void MarkCameraDirty() {
        fastCameraDirty_ = true;
        QueueFastFlush();
    }

    void MarkCameraDirtyIfChanged() {
        CameraData current = {};
        GetActiveCamera(current);
        if (!haveLastSentCamera_ || !CameraEquals(lastSentCamera_, current)) {
            fastCameraDirty_ = true;
            QueueFastFlush();
        }
    }

    void RegisterCallbacks() {
        if (callbacksRegistered_) return;
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
        callbacksRegistered_ = true;
    }

    void UnregisterCallbacks() {
        if (!callbacksRegistered_) return;
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
        callbacksRegistered_ = false;
    }

    bool ShouldKeepCallbacksRegistered() const {
        if (!hwnd_ || !IsWindow(hwnd_)) return false;
        if (renderLocked_ || asCapturing_ || IsViewportHosted()) return true;
        return IsWindowVisible(hwnd_) && !IsIconic(hwnd_);
    }

    void RefreshCallbackRegistration(bool forceFullSyncOnResume = false) {
        if (ShouldKeepCallbacksRegistered()) {
            RegisterCallbacks();
            if (forceFullSyncOnResume) {
                SetDirtyImmediate();
                ResetFastPathState(true);
            }
        } else {
            UnregisterCallbacks();
        }
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
        if (type == L"lock_camera") {
            std::wstring handleStr;
            ExtractJsonString(msg, L"handle", handleStr);
            ULONG h = 0;
            if (!handleStr.empty()) {
                try { h = static_cast<ULONG>(std::stoul(handleStr)); } catch (...) { h = 0; }
            }
            lockedCameraHandle_ = h;
            haveLastSentCamera_ = false;  // force camera resend
            fastCameraDirty_ = true;
            QueueFastFlush();
            return;
        }
        // Layer mount/remove or host-side sync repair — full resend without reloading WebView2
        if (type == L"scene_dirty" || msg.find(L"\"scene_dirty\"") != std::wstring::npos) {
            jsmodStateMap_.clear();
            geoHashMap_.clear();
            lastLiveGeomHash_.clear();
            SetDirtyImmediate();
            return;
        }
        if (type == L"project_manifest_write") {
            std::wstring requestId;
            std::wstring contentBase64;
            bool reload = true;
            ExtractJsonString(msg, L"requestId", requestId);
            if (!ExtractJsonString(msg, L"contentBase64", contentBase64)) {
                SendHostActionResult(type, requestId, false, L"Missing contentBase64");
                return;
            }
            ExtractJsonBool(msg, L"reload", reload);

            std::wstring error;
            const bool ok = WriteProjectManifestContent(contentBase64, error, reload);
            SendHostActionResult(type, requestId, ok, error);
            return;
        }
        if (type == L"project_postfx_write") {
            std::wstring requestId;
            std::wstring contentBase64;
            ExtractJsonString(msg, L"requestId", requestId);
            if (!ExtractJsonString(msg, L"contentBase64", contentBase64)) {
                SendHostActionResult(type, requestId, false, L"Missing contentBase64");
                return;
            }

            std::wstring error;
            const bool ok = WriteProjectPostFxContent(contentBase64, error);
            SendHostActionResult(type, requestId, ok, error);
            return;
        }
        if (type == L"project_release_manifest") {
            std::wstring requestId;
            ExtractJsonString(msg, L"requestId", requestId);

            std::wstring projectDir;
            std::wstring error;
            const bool ok = ReleaseProjectManifest(projectDir, error);
            if (ok) {
                activeProjectDir_ = projectDir;
                activeProjectStamp_ = GetProjectRuntimeWriteStamp(projectDir);
                inlineLayersStateSignature_.clear();
                SendProjectConfig();
                SendProjectReload();
                SendInlineLayersState(true);
            }
            SendHostActionResult(type, requestId, ok, error, projectDir);
            return;
        }
        if (type == L"snapshot_export") {
            std::wstring requestId;
            std::wstring snapshotBase64;
            std::wstring runtimeBase64;
            SnapshotExportOptions options;
            ExtractJsonString(msg, L"requestId", requestId);
            ExtractJsonBool(msg, L"includeSceneNodes", options.includeSceneNodes);
            ExtractJsonBool(msg, L"includeEnvironment", options.includeEnvironment);
            ExtractJsonBool(msg, L"includeFog", options.includeFog);
            ExtractJsonBool(msg, L"includeLights", options.includeLights);
            ExtractJsonBool(msg, L"includeSplats", options.includeSplats);
            ExtractJsonBool(msg, L"includeAudios", options.includeAudios);
            ExtractJsonBool(msg, L"includeGLTFs", options.includeGLTFs);
            ExtractJsonBool(msg, L"includeInstances", options.includeInstances);
            ExtractJsonBool(msg, L"includeDebugPayload", options.includeDebugPayload);
            ExtractJsonBool(msg, L"includeSnapshotUi", options.includeSnapshotUi);
            ExtractJsonBool(msg, L"includeRuntimeScene", options.includeRuntimeScene);
            ExtractJsonBool(msg, L"copyAssets", options.copyAssets);
            ExtractJsonBool(msg, L"includeAnimations", options.includeAnimations);
            ExtractJsonBool(msg, L"includeTransformAnimation", options.includeTransformAnimation);
            ExtractJsonBool(msg, L"includeGeometryAnimation", options.includeGeometryAnimation);
            ExtractJsonBool(msg, L"includeMaterialAnimation", options.includeMaterialAnimation);
            ExtractJsonBool(msg, L"includeCameraAnimation", options.includeCameraAnimation);
            ExtractJsonInt(msg, L"animationSampleStepFrames", options.animationSampleStepFrames);
            ExtractJsonString(msg, L"exportName", options.exportName);
            NormalizeSnapshotExportOptions(options);

            std::wstring snapshotUiJson = options.includeSnapshotUi ? L"{}" : L"";
            std::wstring runtimeSceneJson;
            if (ExtractJsonString(msg, L"snapshotBase64", snapshotBase64) && !snapshotBase64.empty()) {
                std::string decoded;
                if (!DecodeBase64Wide(snapshotBase64, decoded)) {
                    SendHostActionResult(type, requestId, false, L"Invalid snapshot payload");
                    return;
                }
                snapshotUiJson = Utf8ToWide(decoded);
                if (snapshotUiJson.empty()) snapshotUiJson = L"{}";
            }
            if (ExtractJsonString(msg, L"runtimeBase64", runtimeBase64) && !runtimeBase64.empty()) {
                std::string decoded;
                if (!DecodeBase64Wide(runtimeBase64, decoded)) {
                    SendHostActionResult(type, requestId, false, L"Invalid runtime snapshot payload");
                    return;
                }
                runtimeSceneJson = Utf8ToWide(decoded);
            }

            std::wstring exportPath;
            std::wstring error;
            const bool ok = ExportSnapshotSite(snapshotUiJson, runtimeSceneJson, options, exportPath, error);
            SendHostActionResult(type, requestId, ok, error, exportPath);
            return;
        }
        if (type == L"inline_layer_remove") {
            std::wstring requestId;
            std::wstring id;
            std::wstring folder;
            ExtractJsonString(msg, L"requestId", requestId);
            ExtractJsonString(msg, L"folder", folder);
            if (!ExtractJsonString(msg, L"id", id) || id.empty()) {
                SendHostActionResult(type, requestId, false, L"Missing layer id");
                return;
            }

            std::wstring error;
            const bool ok = RemoveInlineLayerFile(id, folder, error);
            SendHostActionResult(type, requestId, ok, error);
            return;
        }
        if (type == L"inline_layer_set_enabled") {
            std::wstring requestId;
            std::wstring id;
            std::wstring folder;
            bool enabled = true;
            ExtractJsonString(msg, L"requestId", requestId);
            ExtractJsonString(msg, L"folder", folder);
            if (!ExtractJsonString(msg, L"id", id) || id.empty()) {
                SendHostActionResult(type, requestId, false, L"Missing layer id");
                return;
            }
            if (!ExtractJsonBool(msg, L"enabled", enabled)) {
                SendHostActionResult(type, requestId, false, L"Missing enabled flag");
                return;
            }

            std::wstring error;
            const bool ok = SetInlineLayerEnabled(id, folder, enabled, error);
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
        if (type == L"render_to_image_ready") {
            if (renderImageEvent_) SetEvent(renderImageEvent_);
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
            jsmodStateMap_.clear();
            inlineLayersStateSignature_.clear();  // re-scan inline layers on reconnect
            lastSentTransforms_.clear();
            lightHandles_.clear();
            splatHandles_.clear();
            audioHandles_.clear();
            gltfHandles_.clear();
        hairHandles_.clear();
        deformHandles_.clear();
            audioHashMap_.clear();
            gltfHashMap_.clear();
            geoScanCursor_ = 0;
            skinnedControlIdxCache_.clear();
            lastSkinnedLivePollTick_ = 0;
            ResetFastPathState(false);
            SendProjectConfig();
            ScanInlineLayers();
        }
    }

    void OnTimer() {
        if (!hwnd_) return;
        if (renderLocked_) return;  // suppress all polling during production render
        // ActiveShade host transitions (maximize/minimize/layout changes) can
        // temporarily hide the child panel while the viewport host is invalid
        // or reports a tiny client rect. We still need to run the host-state
        // maintenance path while hidden so the panel can reattach/re-show once
        // 3ds Max restores the viewport window. For the floating panel path,
        // hidden still means "user closed it", so keep the old early-out.
        if (!IsViewportHosted() && !IsWindowVisible(hwnd_)) return;
        if (!MaintainWindowState()) return;
        if (!jsReady_ || !webview_) return;
        tickCount_++;

        const int envPhase = tickCount_ % ENV_FOG_POLL_TICKS;
        const int lightPhase = tickCount_ % LIGHT_DETECT_TICKS;
        const int slowPhase = tickCount_ % 15;

        // Poll env+fog at reduced cadence (~200ms)
        if (envPhase == 0) PollEnvFog();

        if (dirty_) {
            // Debounce: wait for notifications to settle before expensive full sync
            if (GetTickCount64() - dirtyStamp_ >= DIRTY_DEBOUNCE_MS) {
                dirty_ = false;
                if (useBinary_) SendFullSyncBinary(); else SendFullSync();
            }
        } else {
            // Poll deforming meshes every tick regardless of interactive state.
            // Max's RedrawViewsCallback only fires on full scene redraws
            // (animation, param edits, etc.) — NOT during interactive bone
            // manipulation, which uses a gizmo-only fast path. Without this
            // timer-driven poll, manually dragging bones doesn't update the
            // viewer even though the Skin modifier IS re-evaluating in Max.
            // The 16ms throttle inside the function dedups when the redraw
            // callback also runs during animation.
            CheckSkinnedGeometryLive();

            const bool animPlaying = IsAnimationPlaying();
            const bool favorInteractive = ShouldFavorInteractivePerformance();
            const bool allowIdlePolling = !favorInteractive;
            const bool allowRealtimeAuxPolling = allowIdlePolling || animPlaying;
            const bool allowHeavyGeometryPolling = !favorInteractive && !animPlaying;

            // Source file polling must keep working even while favoring interactive redraw.
            // These are cheap timestamp checks, unlike the heavier scene/material scans below.
            if (slowPhase == 0) CheckWebContentChanges();
            if (slowPhase == 3) CheckProjectContentChanges();
            if (allowIdlePolling && tickCount_ % MATERIAL_DETECT_TICKS == 2) DetectMaterialChanges();
            if (allowIdlePolling && lightPhase == 0) DetectPropertyChanges();
            if (allowRealtimeAuxPolling && lightPhase == 1) {
                DetectLightChanges();
                DetectSplatChanges();
            }
            // Audio is cheap (few nodes, 7 params each) — poll every tick
            // and ignore the interactive gate so spinner drags propagate live.
            DetectAudioChanges();
            DetectGLTFChanges();
            if (allowHeavyGeometryPolling && slowPhase == 6) DetectGeometryChanges();
            if (allowIdlePolling && slowPhase == 9) DetectJsModChanges();
            if (allowIdlePolling && slowPhase == 12) DetectPluginInstanceChanges();
            if (allowRealtimeAuxPolling && lightPhase == 2) PollViewportModes();
            if (slowPhase == 1) ScanInlineLayers();
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
            // Fast-positions path: only positions are re-sent. Valid for
            // meshes whose non-position channels (UVs, indices, normals) are
            // stable between full syncs — i.e., meshes where the current
            // frame's change is driven by a modifier's deformation, not by
            // a direct edit that could also change UVs or topology.
            //
            // Gated on "is deforming" (Skin or any modifier-stack mesh),
            // not just cache presence — static meshes with manual vertex
            // edits need the full ExtractMesh path so UV/topology changes
            // are not silently dropped.
            const bool isDeforming =
                skinnedHandles_.find(handle) != skinnedHandles_.end() ||
                deformHandles_.find(handle) != deformHandles_.end();
            const bool hasVertexColors = NodeHasExtractableVertexColors(node, t);
            bool usedSkinnedFastPositions = false;
            if (wv17 && env12 && isDeforming && !hasVertexColors) {
                auto cacheIt = skinnedControlIdxCache_.find(handle);
                if (cacheIt != skinnedControlIdxCache_.end()) {
                    usedSkinnedFastPositions = ExtractSkinnedFastPositions(node, t, cacheIt->second, verts);
                }
            }

            std::vector<VertexColorAttributeRecord> vertexColors;
            if (!usedSkinnedFastPositions &&
                !ExtractMesh(node, t, verts, uvs, indices, groups, &norms, nullptr, &vertexColors)) {
                ObjectState os = node->EvalWorldState(t);
                if (!ShouldExtractRenderableShape(node, t, &os) ||
                    !ExtractSpline(node, t, verts, indices)) {
                    continue;
                }
                isSpline = true;
                uvs.clear();
                norms.clear();
            }

            if (!usedSkinnedFastPositions) {
                // Store raw hash consistent with DetectGeometryChanges / TryHashRenderableGeometryState
                uint64_t rawHash = 0;
                if (!TryHashRenderableGeometryState(node, t, rawHash))
                    rawHash = HashMeshData(verts, indices, uvs, &vertexColors);
                geoHashMap_[handle] = rawHash;
            }

            JsModData jmFast;
            GetJsModData(node, t, jmFast);

            if (wv17 && env12) {
                size_t totalBytes = verts.size() * 4;
                if (!usedSkinnedFastPositions) {
                    totalBytes += indices.size() * 4 + uvs.size() * 4 + norms.size() * 4;
                    for (const VertexColorAttributeRecord& attr : vertexColors) {
                        totalBytes += attr.values.size() * sizeof(float);
                    }
                }
                if (totalBytes < 4) totalBytes = 4;

                ComPtr<ICoreWebView2SharedBuffer> buf;
                if (FAILED(env12->CreateSharedBuffer(totalBytes, &buf)) || !buf) continue;

                BYTE* ptr = nullptr;
                buf->get_Buffer(&ptr);
                size_t off = 0;
                memcpy(ptr + off, verts.data(), verts.size() * 4); size_t vOff = off; off += verts.size() * 4;
                size_t iOff = 0;
                size_t uvOff = 0;
                size_t nOff = 0;
                if (!usedSkinnedFastPositions) {
                    memcpy(ptr + off, indices.data(), indices.size() * 4); iOff = off; off += indices.size() * 4;
                    uvOff = off;
                    if (!uvs.empty()) { memcpy(ptr + off, uvs.data(), uvs.size() * 4); off += uvs.size() * 4; }
                    nOff = off;
                    if (!norms.empty()) { memcpy(ptr + off, norms.data(), norms.size() * 4); off += norms.size() * 4; }
                    for (VertexColorAttributeRecord& attr : vertexColors) {
                        attr.off = off;
                        if (!attr.values.empty()) {
                            memcpy(ptr + off, attr.values.data(), attr.values.size() * sizeof(float));
                            off += attr.values.size() * sizeof(float);
                        }
                    }
                }

                std::wostringstream ss;
                ss.imbue(std::locale::classic());
                ss << L"{\"type\":\"geo_fast\",\"h\":" << handle;
                ss << L",\"jsmod\":" << (jmFast.found ? L"true" : L"false");
                if (isSpline) ss << L",\"spline\":true";
                ss << L",\"vOff\":" << vOff << L",\"vN\":" << verts.size();
                if (usedSkinnedFastPositions) {
                    ss << L",\"keepNormals\":true";
                } else {
                    ss << L",\"iOff\":" << iOff << L",\"iN\":" << indices.size();
                    if (!uvs.empty()) ss << L",\"uvOff\":" << uvOff << L",\"uvN\":" << uvs.size();
                    if (!norms.empty()) ss << L",\"nOff\":" << nOff << L",\"nN\":" << norms.size();
                    WriteVertexColorOffsetsJson(ss, vertexColors);
                }
                ss << L'}';

                wv17->PostSharedBufferToScript(buf.Get(),
                    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                    ss.str().c_str());
            } else {
                std::wostringstream ss;
                ss.imbue(std::locale::classic());
                ss << L"{\"type\":\"geo_fast\",\"h\":" << handle;
                ss << L",\"jsmod\":" << (jmFast.found ? L"true" : L"false");
                if (isSpline) ss << L",\"spline\":true";
                ss << L",\"v\":"; WriteFloats(ss, verts.data(), verts.size());
                ss << L",\"i\":"; WriteInts(ss, indices.data(), indices.size());
                if (!uvs.empty()) { ss << L",\"uv\":"; WriteFloats(ss, uvs.data(), uvs.size()); }
                if (!norms.empty()) { ss << L",\"norm\":"; WriteFloats(ss, norms.data(), norms.size()); }
                WriteVertexColorAttributesJson(ss, vertexColors);
                ss << L'}';
                webview_->PostWebMessageAsJson(ss.str().c_str());
            }
        }
    }

    void SendHairFastUpdate(const std::vector<ULONG>& dirtyHandles) {
        if (!webview_) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        std::vector<ULONG> hairDirty;
        for (ULONG h : dirtyHandles) {
            if (hairHandles_.find(h) != hairHandles_.end()) hairDirty.push_back(h);
        }
        if (hairDirty.empty()) return;

        std::vector<HairInstanceGroup> groups;
        for (ULONG h : hairDirty) {
            INode* node = ip->GetINodeByHandle(h);
            if (!node) continue;
            ExtractHairInstances(node, t, groups);
        }
        if (groups.empty()) return;

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"hair_fast\",\"groups\":[";
        bool first = true;
        for (const HairInstanceGroup& g : groups) {
            if (g.instanceCount <= 0 || g.transforms.empty()) continue;
            if (!first) ss << L',';
            first = false;
            ss << L"{\"h\":" << g.handle;
            ss << L",\"vis\":" << (g.visible ? L'1' : L'0');
            ss << L",\"count\":" << g.instanceCount;
            ss << L",\"xforms\":";
            WriteFloats(ss, g.transforms.data(), g.transforms.size());
            if (!g.colors.empty()) {
                ss << L",\"colors\":";
                WriteFloats(ss, g.colors.data(), g.colors.size());
            }
            ss << L'}';
        }
        ss << L"]}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void FlushFastPath() {
        fastFlushPosted_ = false;

        if (!jsReady_ || !webview_ || dirty_) return;
        if (!hwnd_ || !IsWindowVisible(hwnd_)) return;

        // Check for lights/splats/audios BEFORE batching to ensure consistent protocol
        // selection even when handles are deferred across frames.
        bool hasDirtyLights = false;
        bool hasDirtySplats = false;
        bool hasDirtyAudios = false;
        bool hasDirtyGLTFs = false;
        for (ULONG handle : fastDirtyHandles_) {
            if (!hasDirtyLights && lightHandles_.find(handle) != lightHandles_.end()) {
                hasDirtyLights = true;
            }
            if (!hasDirtySplats && splatHandles_.find(handle) != splatHandles_.end()) {
                hasDirtySplats = true;
            }
            if (!hasDirtyAudios && audioHandles_.find(handle) != audioHandles_.end()) {
                hasDirtyAudios = true;
            }
            if (!hasDirtyGLTFs && gltfHandles_.find(handle) != gltfHandles_.end()) {
                hasDirtyGLTFs = true;
            }
        }

        std::vector<ULONG> dirtyHandles;
        dirtyHandles.reserve(fastDirtyHandles_.size());
        for (ULONG handle : fastDirtyHandles_) dirtyHandles.push_back(handle);
        if (dirtyHandles.size() > kMaxFastFlushHandlesPerPass) {
            std::vector<ULONG> deferredHandles(
                dirtyHandles.begin() + static_cast<std::ptrdiff_t>(kMaxFastFlushHandlesPerPass),
                dirtyHandles.end());
            dirtyHandles.resize(kMaxFastFlushHandlesPerPass);
            fastDirtyHandles_.clear();
            fastDirtyHandles_.insert(deferredHandles.begin(), deferredHandles.end());
            fastFlushPosted_ = true;
            if (!PostMessage(hwnd_, WM_FAST_FLUSH, 0, 0)) {
                fastFlushPosted_ = false;
            }
        } else {
            fastDirtyHandles_.clear();
        }

        const bool hasDirtyCamera = fastCameraDirty_;

        // Collect geometry-dirty handles before clearing
        std::unordered_set<ULONG> geoDirty;
        geoDirty.swap(geoFastDirtyHandles_);
        std::unordered_set<ULONG> materialDirty;
        materialDirty.swap(materialFastDirtyHandles_);
        std::unordered_set<ULONG> visibilityDirty;
        visibilityDirty.swap(visibilityDirtyHandles_);

        for (ULONG handle : dirtyHandles) visibilityDirty.erase(handle);
        fastCameraDirty_ = false;

        std::vector<ULONG> combinedNodeHandles = dirtyHandles;
        combinedNodeHandles.reserve(dirtyHandles.size() + visibilityDirty.size());
        for (ULONG handle : visibilityDirty) combinedNodeHandles.push_back(handle);

        // Geometry fast path: send changed mesh vertex data via binary geo_fast.
        // Then fall through to binary delta for transform/visibility/etc updates.
        if (!geoDirty.empty()) {
            SendGeometryFastUpdate(geoDirty);
        }

        const bool hasAnyNodeUpdates = !combinedNodeHandles.empty();
        if (!hasAnyNodeUpdates && !hasDirtyCamera) return;

        // Also check visibility dirty handles for lights/splats/audios
        for (ULONG handle : visibilityDirty) {
            if (!hasDirtyLights && lightHandles_.find(handle) != lightHandles_.end()) {
                hasDirtyLights = true;
            }
            if (!hasDirtySplats && splatHandles_.find(handle) != splatHandles_.end()) {
                hasDirtySplats = true;
            }
            if (!hasDirtyAudios && audioHandles_.find(handle) != audioHandles_.end()) {
                hasDirtyAudios = true;
            }
            if (!hasDirtyGLTFs && gltfHandles_.find(handle) != gltfHandles_.end()) {
                hasDirtyGLTFs = true;
            }
        }

        // Hair fast path: re-extract world-space hair instances for any dirty
        // hair handles. Covers transforms, deformation, frizz, dynamics — any
        // change that alters GetHairDefinition output.
        SendHairFastUpdate(dirtyHandles);

        if (!useBinary_) {
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
        frame.ReserveBytes(32 + dirtyHandles.size() * 160 + visibilityDirty.size() * 12 + (hasDirtyCamera ? 64 : 0));
        frame.BeginFrame();

        for (ULONG handle : dirtyHandles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                mtlScalarHashMap_.erase(handle);
                lightHashMap_.erase(handle);
                splatHashMap_.erase(handle);
                audioHashMap_.erase(handle);
                gltfHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                geomHandles_.erase(handle);
                lightHandles_.erase(handle);
                splatHandles_.erase(handle);
                audioHandles_.erase(handle);
                gltfHandles_.erase(handle);
                hairHandles_.erase(handle);
                deformHandles_.erase(handle);
                lastSentTransforms_.erase(handle);
                materialFastDirtyHandles_.erase(handle);
                SetDirty();
                continue;
            }

            // Hair-only handles are fully handled by SendHairFastUpdate (strand
            // matrices are world-space). But a hair-bearing mesh node also lives
            // in geomHandles_ — its body still needs UpdateTransform, so only
            // skip when the handle is hair-only.
            if (hairHandles_.find(handle) != hairHandles_.end() &&
                geomHandles_.find(handle) == geomHandles_.end()) continue;

            float xform[16];
            GetTransform16(node, t, xform);
            RememberSentTransform(handle, xform);
            const bool visible = IsMaxJsSyncDrawVisible(node);

            // Use specialized commands for lights/splats/audios
            if (lightHandles_.find(handle) != lightHandles_.end()) {
                maxjs::sync::DeltaFrameBuilder::LightData ld = {};
                ld.matrix16 = xform;
                ld.visible = visible;
                if (ExtractLightBinaryData(node, t, ld)) {
                    frame.UpdateLight(static_cast<std::uint32_t>(handle), ld);
                }
                continue;
            }
            if (splatHandles_.find(handle) != splatHandles_.end()) {
                frame.UpdateSplat(static_cast<std::uint32_t>(handle), xform, visible);
                continue;
            }
            if (audioHandles_.find(handle) != audioHandles_.end()) {
                frame.UpdateAudio(static_cast<std::uint32_t>(handle), xform, visible);
                continue;
            }
            if (gltfHandles_.find(handle) != gltfHandles_.end()) {
                frame.UpdateGLTF(static_cast<std::uint32_t>(handle), xform, visible);
                continue;
            }

            // Regular geometry node
            frame.UpdateTransform(static_cast<std::uint32_t>(handle), xform);
            frame.UpdateSelection(static_cast<std::uint32_t>(handle), node->Selected() != 0);
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), visible);

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
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), IsMaxJsSyncDrawVisible(node));
        }

        if (hasDirtyCamera) {
            CameraData cam = {};
            GetActiveCamera(cam);
            frame.UpdateCamera(cam.pos, cam.target, cam.up, cam.fov, cam.perspective, cam.viewWidth,
                               cam.dofEnabled, cam.dofFocusDistance, cam.dofFocalLength, cam.dofBokehScale);
            lastSentCamera_ = cam;
            haveLastSentCamera_ = true;
        }

        // Time oracle — JS timeline / ctx.maxTime reads this.
        {
            const std::int32_t tpf = GetTicksPerFrame();
            const std::uint8_t stateFlags = IsAnimationPlaying() ? 0x01 : 0x00;
            frame.UpdateTime(static_cast<std::int32_t>(t), tpf, stateFlags);
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
        frame.ReserveBytes(32 + geomHandles_.size() * (includeMaterialScalars ? 120 : 96) + 64);
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
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), IsMaxJsSyncDrawVisible(node));

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
        GetActiveCamera(cam);
        frame.UpdateCamera(cam.pos, cam.target, cam.up, cam.fov, cam.perspective, cam.viewWidth,
                               cam.dofEnabled, cam.dofFocusDistance, cam.dofFocalLength, cam.dofBokehScale);
        // Time oracle — JS timeline / ctx.maxTime reads this.
        {
            const std::int32_t tpf = GetTicksPerFrame();
            const std::uint8_t stateFlags = IsAnimationPlaying() ? 0x01 : 0x00;
            frame.UpdateTime(static_cast<std::int32_t>(t), tpf, stateFlags);
        }
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

        // TSL materials: strip tslParamsJson from structure hash so param
        // tweaks don't trigger full scene rebuilds (JS updates uniforms in-place).
        if (pbr.materialModel == L"MeshTSLNodeMaterial" ||
            !pbr.tslParamsJson.empty()) {
            MaxJSPBR stable = pbr;
            stable.tslParamsJson.clear();
            state.structureHash = HashMaterialPBRState(stable);
            state.canFastSync = false;
            return state;
        }

        // HTML texmap slots: mirror the TSL strip — a material that has any
        // slot holding an HTML texmap is never fast-sync eligible, and
        // htmlParamsJson is removed from the structure hash so param edits
        // don't thrash the material cache key.
        auto hasHtmlSlot = [](const MaxJSPBR& p) {
            auto has = [](const MaxJSPBR::TexTransform& xf) { return !xf.htmlFile.empty(); };
            return has(p.colorMapTransform) || has(p.gradientMapTransform) ||
                   has(p.roughnessMapTransform) || has(p.metalnessMapTransform) ||
                   has(p.normalMapTransform) || has(p.bumpMapTransform) ||
                   has(p.displacementMapTransform) || has(p.parallaxMapTransform) ||
                   has(p.sssColorMapTransform) || has(p.aoMapTransform) ||
                   has(p.emissionMapTransform) || has(p.lightmapTransform) ||
                   has(p.opacityMapTransform) || has(p.matcapMapTransform) ||
                   has(p.specularMapTransform) || has(p.transmissionMapTransform) ||
                   has(p.clearcoatMapTransform) || has(p.clearcoatRoughnessMapTransform) ||
                   has(p.clearcoatNormalMapTransform) ||
                   has(p.specularIntensityMapTransform) || has(p.specularColorMapTransform);
        };
        if (hasHtmlSlot(pbr)) {
            MaxJSPBR stable = pbr;
            auto clear = [](MaxJSPBR::TexTransform& xf) { xf.htmlParamsJson.clear(); };
            clear(stable.colorMapTransform); clear(stable.gradientMapTransform);
            clear(stable.roughnessMapTransform); clear(stable.metalnessMapTransform);
            clear(stable.normalMapTransform); clear(stable.bumpMapTransform);
            clear(stable.displacementMapTransform); clear(stable.parallaxMapTransform);
            clear(stable.sssColorMapTransform); clear(stable.aoMapTransform);
            clear(stable.emissionMapTransform); clear(stable.lightmapTransform);
            clear(stable.opacityMapTransform); clear(stable.matcapMapTransform);
            clear(stable.specularMapTransform); clear(stable.transmissionMapTransform);
            clear(stable.clearcoatMapTransform); clear(stable.clearcoatRoughnessMapTransform);
            clear(stable.clearcoatNormalMapTransform);
            clear(stable.specularIntensityMapTransform); clear(stable.specularColorMapTransform);
            state.structureHash = HashMaterialPBRState(stable);
            state.canFastSync = false;
            return state;
        }

        MaxJSPBR structurePbr = pbr;
        // Zero out all animatable scalars — changes to these go through scalar hash, not structure
        structurePbr.color[0] = 0.8f;
        structurePbr.color[1] = 0.8f;
        structurePbr.color[2] = 0.8f;
        structurePbr.roughness = 0.5f;
        structurePbr.metalness = 0.0f;
        structurePbr.opacity = 1.0f;
        structurePbr.envIntensity = 1.0f;
        structurePbr.physicalSpecularColor[0] = 1.0f;
        structurePbr.physicalSpecularColor[1] = 1.0f;
        structurePbr.physicalSpecularColor[2] = 1.0f;
        structurePbr.physicalSpecularIntensity = 1.0f;
        structurePbr.ior = 1.5f;
        structurePbr.clearcoat = 0.0f;
        structurePbr.clearcoatRoughness = 0.0f;
        structurePbr.sheen = 0.0f;
        structurePbr.sheenRoughness = 0.0f;
        structurePbr.sheenColor[0] = 0.0f;
        structurePbr.sheenColor[1] = 0.0f;
        structurePbr.sheenColor[2] = 0.0f;
        structurePbr.transmission = 0.0f;
        structurePbr.thickness = 0.0f;
        structurePbr.iridescence = 0.0f;
        structurePbr.anisotropy = 0.0f;

        state.structureHash = HashMaterialPBRState(structurePbr);
        // Scalar hash: full material JSON so ANY param change is detected
        state.scalarHash = HashMaterialPBRState(pbr);
        state.canFastSync = true;
        return state;
    }

    uint64_t ComputeLightStateHash(INode* node, TimeValue t) {
        if (!node) return 0;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSLightClassID(os.obj->ClassID())) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_light_params);
        if (!pb) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        const Class_ID classId = os.obj->ClassID();
        ThreeJSLightType ltype = GetThreeJSLightTypeFromClassID(classId);
        if (ThreeJSLightClassUsesTypeParam(classId) && HasParam(pb, pl_type)) {
            int rawType = pb->GetInt(pl_type);
            if (rawType < 0) rawType = 0;
            if (rawType >= kLight_COUNT) rawType = kLight_Directional;
            ltype = static_cast<ThreeJSLightType>(rawType);
        }

        // Intentionally exclude world transform from the light-state hash.
        // Parent-driven light motion must stay on the transform fast path;
        // otherwise every animated parent makes the child light look like a
        // full parameter change every frame, which causes playback hitches.
        const bool supportsShadows =
            ltype == kLight_Directional || ltype == kLight_Point || ltype == kLight_Spot;
        const double metersPerUnit = GetSystemUnitScale(UNITS_METERS);
        const double pointSpotScale = metersPerUnit > 1.0e-9 ? 1.0 / (metersPerUnit * metersPerUnit) : 1.0;

        Color c(1.0f, 1.0f, 1.0f);
        if (HasParam(pb, pl_color)) c = pb->GetColor(pl_color, t);

        double intensity = HasParam(pb, pl_intensity) ? pb->GetFloat(pl_intensity, t) : 1.0;
        if (ltype == kLight_Point || ltype == kLight_Spot) intensity *= pointSpotScale;

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        ss << L",\"type\":" << static_cast<int>(ltype);
        ss << L",\"color\":[" << c.r << L',' << c.g << L',' << c.b << L']';
        ss << L",\"intensity\":" << intensity;

        if (ltype == kLight_Point || ltype == kLight_Spot) {
            ss << L",\"distance\":" << (HasParam(pb, pl_distance) ? pb->GetFloat(pl_distance, t) : 0.0f);
            ss << L",\"decay\":" << (HasParam(pb, pl_decay) ? pb->GetFloat(pl_decay, t) : 2.0f);
        }
        if (ltype == kLight_Spot) {
            const float angleDeg = HasParam(pb, pl_angle) ? pb->GetFloat(pl_angle, t) : 45.0f;
            ss << L",\"angle\":" << (angleDeg * 3.14159265f / 180.f);
            ss << L",\"penumbra\":" << (HasParam(pb, pl_penumbra) ? pb->GetFloat(pl_penumbra, t) : 0.0f);
        }
        if (ltype == kLight_RectArea) {
            ss << L",\"width\":" << (HasParam(pb, pl_width) ? pb->GetFloat(pl_width, t) : 0.0f);
            ss << L",\"height\":" << (HasParam(pb, pl_height) ? pb->GetFloat(pl_height, t) : 0.0f);
        }
        if (ltype == kLight_Hemisphere) {
            Color gc(0.0f, 0.0f, 0.0f);
            if (HasParam(pb, pl_ground_color)) gc = pb->GetColor(pl_ground_color, t);
            ss << L",\"groundColor\":[" << gc.r << L',' << gc.g << L',' << gc.b << L']';
        }

        const bool castShadow = supportsShadows && HasParam(pb, pl_cast_shadow) && pb->GetInt(pl_cast_shadow) != 0;
        ss << L",\"castShadow\":" << (castShadow ? L'1' : L'0');
        if (castShadow) {
            ss << L",\"shadowBias\":" << (HasParam(pb, pl_shadow_bias) ? pb->GetFloat(pl_shadow_bias, t) : -0.0001f);
            ss << L",\"shadowRadius\":" << (HasParam(pb, pl_shadow_radius) ? pb->GetFloat(pl_shadow_radius, t) : 1.0f);
            ss << L",\"shadowMapSize\":" << (HasParam(pb, pl_shadow_mapsize) ? pb->GetInt(pl_shadow_mapsize) : 1024);
        }

        ss << L",\"volContrib\":" << (HasParam(pb, pl_vol_contrib) ? pb->GetFloat(pl_vol_contrib, t) : 0.0f);
        ss << L'}';

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
        ss << L"{\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        ss << L",\"url\":\"" << EscapeJson(mappedPath.c_str()) << L"\"}";
        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    uint64_t ComputeAudioStateHash(INode* node, TimeValue t) {
        if (!node) return 0;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSAudioClassID(os.obj->ClassID())) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_audio_params);
        if (!pb) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        const MCHAR* rawPath = pb->GetStr(pa_audio_file);
        std::wstring mappedPath = rawPath ? MapAssetPath(rawPath, false) : std::wstring{};

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        ss << L",\"url\":\"" << EscapeJson(mappedPath.c_str()) << L"\"";
        ss << L",\"volume\":" << pb->GetFloat(pa_volume, t);
        ss << L",\"loop\":" << (pb->GetInt(pa_loop) ? L'1' : L'0');
        ss << L",\"crossfade\":" << pb->GetFloat(pa_crossfade_ms, t);
        ss << L",\"refDistance\":" << pb->GetFloat(pa_ref_distance, t);
        ss << L",\"maxDistance\":" << pb->GetFloat(pa_max_distance, t);
        ss << L",\"rolloff\":" << pb->GetFloat(pa_rolloff_factor, t);
        ss << L"}";
        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    uint64_t ComputeGLTFStateHash(INode* node, TimeValue t) {
        if (!node) return 0;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSGLTFClassID(os.obj->ClassID())) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_gltf_params);
        if (!pb) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        const MCHAR* rawPath = pb->GetStr(pg_gltf_file);
        std::wstring mappedPath = rawPath ? MapAssetPath(rawPath, false) : std::wstring{};

        const MCHAR* displayName = pb->GetStr(pg_display_name);

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        ss << L",\"url\":\"" << EscapeJson(mappedPath.c_str()) << L"\"";
        ss << L",\"scale\":" << pb->GetFloat(pg_root_scale, t);
        ss << L",\"autoplay\":" << (pb->GetInt(pg_autoplay) ? L'1' : L'0');
        ss << L",\"name\":\"" << EscapeJson(displayName ? displayName : L"") << L"\"";
        ss << L"}";
        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    // Supported material edits must use the full sync path. The lightweight scalar
    // fast path only carries color/roughness/metalness/opacity and cannot keep
    // physical properties in sync.
    void DetectMaterialChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

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
            if (structureChanged) {
                // Material structure changed — invalidate geometry hash + group cache
                // so next full sync re-extracts face matIDs for multi-sub materials
                geoHashMap_.erase(handle);
                groupCache_.erase(handle);
                lastBBoxHash_.erase(handle);
            }
            materialFastDirtyHandles_.clear();
            SetDirty();
            return;
        }
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

    void DetectAudioChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip || audioHandles_.empty()) return;

        TimeValue t = ip->GetTime();
        std::vector<INode*> dirty;
        dirty.reserve(audioHandles_.size());

        for (ULONG handle : audioHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            const uint64_t hash = ComputeAudioStateHash(node, t);
            auto it = audioHashMap_.find(handle);
            if (it == audioHashMap_.end()) {
                audioHashMap_[handle] = hash;
                dirty.push_back(node);  // first observation — push so JS has initial state
            } else if (it->second != hash) {
                it->second = hash;
                dirty.push_back(node);
            }
        }

        if (dirty.empty() || !webview_) return;

        // Send the full audio state as JSON. The binary UpdateAudio delta
        // command only carries transform/visibility, so param edits must
        // ride a dedicated JSON message (WriteAudioJson emits every field).
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"audio_update\",\"audios\":[";
        bool first = true;
        for (INode* node : dirty) {
            std::wostringstream audioJson;
            audioJson.imbue(std::locale::classic());
            if (WriteAudioJson(audioJson, node, t, /*includeHandle*/ true, /*includeVisibility*/ true, /*trackHandle*/ false)) {
                if (!first) ss << L',';
                ss << audioJson.str();
                first = false;
            }
        }
        ss << L"]}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void DetectGLTFChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip || gltfHandles_.empty()) return;

        TimeValue t = ip->GetTime();
        std::vector<INode*> dirty;
        dirty.reserve(gltfHandles_.size());

        for (ULONG handle : gltfHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            const uint64_t hash = ComputeGLTFStateHash(node, t);
            auto it = gltfHashMap_.find(handle);
            if (it == gltfHashMap_.end()) {
                gltfHashMap_[handle] = hash;
                dirty.push_back(node);
            } else if (it->second != hash) {
                it->second = hash;
                dirty.push_back(node);
            }
        }

        if (dirty.empty() || !webview_) return;

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"gltf_update\",\"gltfs\":[";
        bool first = true;
        for (INode* node : dirty) {
            std::wostringstream gltfJson;
            gltfJson.imbue(std::locale::classic());
            if (WriteGLTFJson(gltfJson, node, t, /*includeHandle*/ true, /*includeVisibility*/ true, /*trackHandle*/ false)) {
                if (!first) ss << L',';
                ss << gltfJson.str();
                first = false;
            }
        }
        ss << L"]}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
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
                // Skip any mesh already handled by the live deform poll. Those
                // routes send positions-only deltas via SendGeometryFastUpdate;
                // the idle geometry detector would only trigger a redundant
                // full scene sync (the original hitch source on rigs where
                // DetectGeometryChanges sees a Path Deform position change
                // and calls SetDirty() mid-interaction).
                const bool handledByLivePoll =
                    geoFastDirtyHandles_.count(handle) ||
                    skinnedHandles_.count(handle) ||
                    deformHandles_.count(handle);
                if (!handledByLivePoll) {
                    uint64_t hash = 0;
                    if (TryHashRenderableGeometryState(node, t, hash)) {
                        auto it = geoHashMap_.find(handle);
                        if (it == geoHashMap_.end() || it->second != hash) {
                            SetDirty();
                            return;
                        }
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
    void DetectJsModChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip || geomHandles_.empty()) return;
        const TimeValue t = ip->GetTime();
        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;
            JsModData jm;
            GetJsModData(node, t, jm);
            const bool found = jm.found;
            auto it = jsmodStateMap_.find(handle);
            if (it == jsmodStateMap_.end()) {
                jsmodStateMap_[handle] = found;
                continue;
            }
            if (it->second != found) {
                it->second = found;
                geoHashMap_.erase(handle);
                lastLiveGeomHash_.erase(handle);
                SetDirty();
                return;
            }
        }
    }

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
            // TSL procedural texture — emit code and params instead of URL
            if (!xf.tslCode.empty()) {
                ss << L",\"" << key << L"TSL\":\"" << EscapeJson(xf.tslCode.c_str()) << L'"';
                if (!xf.tslParamsJson.empty() && IsProbablyJsonStructured(xf.tslParamsJson))
                    ss << L",\"" << key << L"TSLParams\":" << xf.tslParamsJson;
                return;
            }
            // HTML texture — emit asset URLs + resolution + params
            if (!xf.htmlFile.empty()) {
                const std::wstring htmlFileUrl = MapAssetPath(xf.htmlFile, false);
                std::wstring htmlBaseUrl;
                std::wstring htmlFilename;
                const size_t slash = xf.htmlFile.find_last_of(L"\\/");
                if (slash != std::wstring::npos) {
                    htmlBaseUrl = MapAssetPath(xf.htmlFile.substr(0, slash), true);
                    htmlFilename = xf.htmlFile.substr(slash + 1);
                } else {
                    htmlFilename = xf.htmlFile;
                }
                if (!htmlFileUrl.empty())
                    ss << L",\"" << key << L"HTML\":\"" << EscapeJson(htmlFileUrl.c_str()) << L'"';
                if (!htmlBaseUrl.empty())
                    ss << L",\"" << key << L"HTMLBase\":\"" << EscapeJson(htmlBaseUrl.c_str()) << L'"';
                if (!htmlFilename.empty())
                    ss << L",\"" << key << L"HTMLName\":\"" << EscapeJson(htmlFilename.c_str()) << L'"';
                ss << L",\"" << key << L"HTMLW\":" << xf.htmlWidth;
                ss << L",\"" << key << L"HTMLH\":" << xf.htmlHeight;
                if (!xf.htmlParamsJson.empty() && IsProbablyJsonStructured(xf.htmlParamsJson))
                    ss << L",\"" << key << L"HTMLParams\":" << xf.htmlParamsJson;
                return;
            }
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
        writeMap(L"specIntMap", L"specIntMapXf", pbr.specularIntensityMap, pbr.specularIntensityMapTransform);
        writeMap(L"specColMap", L"specColMapXf", pbr.specularColorMap, pbr.specularColorMapTransform);
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
            ss << L",\"reflectivity\":";
            WriteFloatValue(ss, pbr.reflectivity, 0.5f);
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
            } else if (!pbr.materialXInline.empty()) {
                ss << L",\"materialXInline\":\"" << EscapeJson(pbr.materialXInline.c_str()) << L"\"";
                const std::wstring baseUrl = MapAssetPath(pbr.materialXBase, true);
                if (!baseUrl.empty()) {
                    ss << L",\"materialXBase\":\"" << EscapeJson(baseUrl.c_str()) << L"\"";
                }
            }
            if (!pbr.materialXMaterialName.empty()) {
                ss << L",\"materialXName\":\"" << EscapeJson(pbr.materialXMaterialName.c_str()) << L"\"";
            }
            ss << L",\"materialXIndex\":" << std::max(1, pbr.materialXMaterialIndex);
        } else if (pbr.materialModel == L"MeshTSLNodeMaterial") {
            if (!pbr.tslCode.empty())
                ss << L",\"tslCode\":\"" << EscapeJson(pbr.tslCode.c_str()) << L"\"";
            // TSL dynamic params — send raw JSON (already valid JSON object).
            // Guard against user-authored garbage in the params field corrupting the
            // enclosing scene delta by validating brace balance before splicing raw.
            if (!pbr.tslParamsJson.empty() && IsProbablyJsonStructured(pbr.tslParamsJson))
                ss << L",\"tslParams\":" << pbr.tslParamsJson;
            // TSL texture map slots
            static const wchar_t* tslMapKeys[] = { L"tslMap1", L"tslMap2", L"tslMap3", L"tslMap4" };
            for (int m = 0; m < 4; ++m) {
                if (!pbr.tslMaps[m].empty()) {
                    const std::wstring url = MapTexturePath(pbr.tslMaps[m]);
                    if (!url.empty())
                        ss << L",\"" << tslMapKeys[m] << L"\":\"" << EscapeJson(url.c_str()) << L"\"";
                }
            }
            if (!pbr.materialXInline.empty()) {
                ss << L",\"materialXInline\":\"" << EscapeJson(pbr.materialXInline.c_str()) << L"\"";
                const std::wstring baseUrl = MapAssetPath(pbr.materialXBase, true);
                if (!baseUrl.empty()) {
                    ss << L",\"materialXBase\":\"" << EscapeJson(baseUrl.c_str()) << L"\"";
                }
            }
            if (!pbr.materialXMaterialName.empty()) {
                ss << L",\"materialXName\":\"" << EscapeJson(pbr.materialXMaterialName.c_str()) << L"\"";
            }
            if (!pbr.materialXInline.empty()) {
                ss << L",\"materialXIndex\":" << std::max(1, pbr.materialXMaterialIndex);
            }
            if (pbr.materialXBridgeConnected) {
                ss << L",\"materialXBridgeConnected\":true";
                if (!pbr.materialXBridgeSourceName.empty()) {
                    ss << L",\"materialXBridgeSourceName\":\"" << EscapeJson(pbr.materialXBridgeSourceName.c_str()) << L"\"";
                }
                if (!pbr.materialXBridgeError.empty()) {
                    ss << L",\"materialXBridgeError\":\"" << EscapeJson(pbr.materialXBridgeError.c_str()) << L"\"";
                }
            }
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

    void WriteSceneCamerasJson(std::wostringstream& ss) {
        ss << L"\"sceneCameras\":[";
        Interface* ip = GetCOREInterface();
        INode* root = ip ? ip->GetRootNode() : nullptr;
        bool first = true;
        if (root) {
            std::function<void(INode*)> collect = [&](INode* parent) {
                for (int i = 0; i < parent->NumberOfChildren(); i++) {
                    INode* node = parent->GetChildNode(i);
                    if (!node) continue;
                    if (IsSceneCameraNode(node)) {
                        if (!first) ss << L',';
                        ss << L"{\"h\":" << node->GetHandle()
                           << L",\"n\":\"" << EscapeJson(node->GetName()) << L"\"}";
                        first = false;
                    }
                    collect(node);
                }
            };
            collect(root);
        }
        ss << L"],\"lockedCamera\":" << lockedCameraHandle_;
    }

    void WriteCameraJson(std::wostringstream& ss) {
        CameraData cam = {};
        GetActiveCamera(cam);
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
        if (!cam.perspective) {
            ss << L",\"viewWidth\":";
            WriteFloatValue(ss, cam.viewWidth, 500.0f);
        }
        ss << L",\"dofEnabled\":" << (cam.dofEnabled ? L"true" : L"false");
        if (cam.dofEnabled) {
            ss << L",\"dofFocusDistance\":";
            WriteFloatValue(ss, cam.dofFocusDistance);
            ss << L",\"dofFocalLength\":";
            WriteFloatValue(ss, cam.dofFocalLength);
            ss << L",\"dofBokehScale\":";
            WriteFloatValue(ss, cam.dofBokehScale);
        }
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
        float xform[16];
        GetTransform16(node, t, xform);
        if (trackHandle) {
            lightHandles_.insert(handle);
            RememberSentTransform(handle, xform);
        }

        // World-space orientation/position (matches GetTransform16 / binary light deltas).
        // GetObjectTM() is parent-relative; parented TJS lights under dummies/controllers
        // would not follow unless we use GetObjTMAfterWSM here.
        Matrix3 tm = node->GetObjTMAfterWSM(t);
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
            ss << L"\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        }

        // Node name
        appendComma();
        ss << L"\"name\":\"" << EscapeJson(node->GetName()) << L'"';

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
        // Always emit so the web side never keeps a stale multiplier when the user returns to 1.0.
        ss << L",\"volContrib\":" << volContrib;

        ss << L'}';
        return true;
    }

    bool ExtractLightBinaryData(INode* node, TimeValue t, maxjs::sync::DeltaFrameBuilder::LightData& ld) {
        if (!node) return false;
        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSLightClassID(os.obj->ClassID())) return false;
        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_light_params);

        const Class_ID classId = os.obj->ClassID();
        ThreeJSLightType ltype = GetThreeJSLightTypeFromClassID(classId);
        if (pb && ThreeJSLightClassUsesTypeParam(classId) && HasParam(pb, pl_type)) {
            int rawType = pb->GetInt(pl_type);
            if (rawType < 0) rawType = 0;
            if (rawType >= kLight_COUNT) rawType = kLight_Directional;
            ltype = static_cast<ThreeJSLightType>(rawType);
        }

        const bool supportsShadows =
            ltype == kLight_Directional || ltype == kLight_Point || ltype == kLight_Spot;
        const double metersPerUnit = GetSystemUnitScale(UNITS_METERS);
        const double pointSpotScale = metersPerUnit > 1.0e-9 ? 1.0 / (metersPerUnit * metersPerUnit) : 1.0;

        Color c(1.0f, 1.0f, 1.0f);
        if (pb && HasParam(pb, pl_color)) c = pb->GetColor(pl_color, t);

        double intensity = 1.0;
        if (pb && HasParam(pb, pl_intensity)) intensity = pb->GetFloat(pl_intensity, t);
        if (ltype == kLight_Point || ltype == kLight_Spot) intensity *= pointSpotScale;

        ld.type = static_cast<std::uint32_t>(ltype);
        ld.color[0] = c.r; ld.color[1] = c.g; ld.color[2] = c.b;
        ld.intensity = static_cast<float>(intensity);
        ld.distance = (ltype == kLight_Point || ltype == kLight_Spot) && pb && HasParam(pb, pl_distance)
            ? pb->GetFloat(pl_distance, t) : 0.0f;
        ld.decay = (ltype == kLight_Point || ltype == kLight_Spot) && pb && HasParam(pb, pl_decay)
            ? pb->GetFloat(pl_decay, t) : 2.0f;
        ld.angle = (ltype == kLight_Spot) && pb && HasParam(pb, pl_angle)
            ? (pb->GetFloat(pl_angle, t) * 3.14159265f / 180.f) : 0.0f;
        ld.penumbra = (ltype == kLight_Spot) && pb && HasParam(pb, pl_penumbra)
            ? pb->GetFloat(pl_penumbra, t) : 0.0f;
        ld.width = (ltype == kLight_RectArea) && pb && HasParam(pb, pl_width)
            ? pb->GetFloat(pl_width, t) : 0.0f;
        ld.height = (ltype == kLight_RectArea) && pb && HasParam(pb, pl_height)
            ? pb->GetFloat(pl_height, t) : 0.0f;
        if (ltype == kLight_Hemisphere) {
            Color gc(0.0f, 0.0f, 0.0f);
            if (pb && HasParam(pb, pl_ground_color)) gc = pb->GetColor(pl_ground_color, t);
            ld.groundColor[0] = gc.r; ld.groundColor[1] = gc.g; ld.groundColor[2] = gc.b;
        } else {
            ld.groundColor[0] = ld.groundColor[1] = ld.groundColor[2] = 0.0f;
        }
        ld.castShadow = supportsShadows && pb && HasParam(pb, pl_cast_shadow) && pb->GetInt(pl_cast_shadow) != 0;
        ld.shadowBias = (ld.castShadow && pb && HasParam(pb, pl_shadow_bias)) ? pb->GetFloat(pl_shadow_bias, t) : -0.0001f;
        ld.shadowRadius = (ld.castShadow && pb && HasParam(pb, pl_shadow_radius)) ? pb->GetFloat(pl_shadow_radius, t) : 1.0f;
        ld.shadowMapSize = (ld.castShadow && pb && HasParam(pb, pl_shadow_mapsize))
            ? static_cast<std::uint32_t>(pb->GetInt(pl_shadow_mapsize)) : 1024u;
        ld.volContrib = (pb && HasParam(pb, pl_vol_contrib)) ? pb->GetFloat(pl_vol_contrib, t) : 0.0f;
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
            ss << L"\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        }

        appendComma();
        ss << L"\"t\":";
        WriteFloats(ss, xform, 16);

        appendComma();
        ss << L"\"url\":\"" << EscapeJson(url.c_str()) << L"\"";
        ss << L'}';
        return true;
    }

    bool WriteAudioJson(std::wostringstream& ss, INode* node, TimeValue t,
                        bool includeHandle = false, bool includeVisibility = false,
                        bool trackHandle = false) {
        if (!node) return false;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSAudioClassID(os.obj->ClassID())) return false;

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_audio_params);
        if (!pb) return false;

        const MCHAR* rawPath = pb->GetStr(pa_audio_file);
        std::wstring url = rawPath ? MapAssetPath(rawPath, false) : std::wstring{};

        const ULONG handle = node->GetHandle();
        float xform[16];
        GetTransform16(node, t, xform);
        if (trackHandle) {
            audioHandles_.insert(handle);
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
            ss << L"\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        }

        appendComma();
        ss << L"\"t\":";
        WriteFloats(ss, xform, 16);

        appendComma();
        ss << L"\"url\":\"" << EscapeJson(url.c_str()) << L"\"";

        appendComma();
        ss << L"\"volume\":";
        WriteFloatValue(ss, pb->GetFloat(pa_volume, t), 1.0f);

        appendComma();
        ss << L"\"loop\":" << (pb->GetInt(pa_loop) ? L"true" : L"false");

        appendComma();
        ss << L"\"crossfade\":";
        WriteFloatValue(ss, pb->GetFloat(pa_crossfade_ms, t), 35.0f);

        appendComma();
        ss << L"\"refDistance\":";
        WriteFloatValue(ss, pb->GetFloat(pa_ref_distance, t), 120.0f);

        appendComma();
        ss << L"\"maxDistance\":";
        WriteFloatValue(ss, pb->GetFloat(pa_max_distance, t), 5000.0f);

        appendComma();
        ss << L"\"rolloff\":";
        WriteFloatValue(ss, pb->GetFloat(pa_rolloff_factor, t), 1.0f);

        ss << L'}';
        return true;
    }

    bool WriteGLTFJson(std::wostringstream& ss, INode* node, TimeValue t,
                       bool includeHandle = false, bool includeVisibility = false,
                       bool trackHandle = false) {
        if (!node) return false;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSGLTFClassID(os.obj->ClassID())) return false;

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_gltf_params);
        if (!pb) return false;

        const MCHAR* rawPath = pb->GetStr(pg_gltf_file);
        std::wstring url = rawPath ? MapAssetPath(rawPath, false) : std::wstring{};
        const MCHAR* displayName = pb->GetStr(pg_display_name);

        const ULONG handle = node->GetHandle();
        float xform[16];
        GetTransform16(node, t, xform);
        if (trackHandle) {
            gltfHandles_.insert(handle);
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
            ss << L"\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        }

        appendComma();
        ss << L"\"t\":";
        WriteFloats(ss, xform, 16);

        appendComma();
        ss << L"\"url\":\"" << EscapeJson(url.c_str()) << L"\"";

        appendComma();
        ss << L"\"displayName\":\"" << EscapeJson(displayName ? displayName : L"") << L"\"";

        appendComma();
        ss << L"\"rootScale\":";
        WriteFloatValue(ss, pb->GetFloat(pg_root_scale, t), 1.0f);

        appendComma();
        ss << L"\"autoplay\":" << (pb->GetInt(pg_autoplay) ? L"true" : L"false");

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

    void WriteAudiosJson(std::wostringstream& ss, Interface* ip, TimeValue t,
                         bool includeHandle = false, bool includeVisibility = false,
                         bool trackHandles = false) {
        ss << L"\"audios\":[";
        bool firstAudio = true;
        INode* root = ip ? ip->GetRootNode() : nullptr;
        if (root) {
            std::function<void(INode*)> collectAudios = [&](INode* parent) {
                for (int i = 0; i < parent->NumberOfChildren(); i++) {
                    INode* node = parent->GetChildNode(i);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE) && !includeVisibility) {
                        collectAudios(node);
                        continue;
                    }

                    std::wostringstream audioJson;
                    audioJson.imbue(std::locale::classic());
                    if (WriteAudioJson(audioJson, node, t, includeHandle, includeVisibility, trackHandles)) {
                        if (!firstAudio) ss << L',';
                        ss << audioJson.str();
                        firstAudio = false;
                    }

                    collectAudios(node);
                }
            };
            collectAudios(root);
        }
        ss << L']';
    }

    void WriteGLTFsJson(std::wostringstream& ss, Interface* ip, TimeValue t,
                        bool includeHandle = false, bool includeVisibility = false,
                        bool trackHandles = false) {
        ss << L"\"gltfs\":[";
        bool firstGLTF = true;
        INode* root = ip ? ip->GetRootNode() : nullptr;
        if (root) {
            std::function<void(INode*)> collectGLTFs = [&](INode* parent) {
                for (int i = 0; i < parent->NumberOfChildren(); i++) {
                    INode* node = parent->GetChildNode(i);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE) && !includeVisibility) {
                        collectGLTFs(node);
                        continue;
                    }

                    std::wostringstream gltfJson;
                    gltfJson.imbue(std::locale::classic());
                    if (WriteGLTFJson(gltfJson, node, t, includeHandle, includeVisibility, trackHandles)) {
                        if (!firstGLTF) ss << L',';
                        ss << gltfJson.str();
                        firstGLTF = false;
                    }

                    collectGLTFs(node);
                }
            };
            collectGLTFs(root);
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

    void WriteHairInstanceGroupsJson(std::wostringstream& ss, INode* root, TimeValue t) {
        if (!root) return;

        HairDebugLog(L"========== WriteHairInstanceGroupsJson called ==========");
        std::vector<HairInstanceGroup> hairGroups;
        std::function<void(INode*)> collectHair = [&](INode* parent) {
            for (int c = 0; c < parent->NumberOfChildren(); ++c) {
                INode* node = parent->GetChildNode(c);
                if (!node) continue;
                if (node->IsNodeHidden(TRUE)) {
                    collectHair(node);
                    continue;
                }
                if (!IsMaxJsSyncDrawVisible(node)) {
                    collectHair(node);
                    continue;
                }
                const size_t beforeCount = hairGroups.size();
                Object* obj = node->GetObjectRef();
                const MSTR className = obj ? obj->ClassName() : MSTR(_T("<null>"));
                {
                    std::wostringstream nl;
                    nl << L"visit node=" << node->GetName() << L" objRefClass=" << className.data();
                    if (Object* ws = node->EvalWorldState(t).obj) {
                        nl << L" wsClass=" << ws->ClassName().data() << L" wsSid=0x" << std::hex << ws->SuperClassID() << std::dec;
                    }
                    HairDebugLog(nl.str());
                }
                const bool isStackHair = _tcsicmp(className.data(), _T("StackHair")) == 0;
                MaxSDK::IHairModifier* hair = nullptr;
                MSTR hairSourceClass;
                const bool hasHairInterface = ProbeHairModifierOnNode(node, hair, &hairSourceClass);
                const bool hairEnabled = hair ? hair->IsHairEnabled() : false;
                const bool extracted = ExtractHairInstances(node, t, hairGroups);
                int renderFallbackVerts = 0;
                int renderFallbackFaces = 0;
                if (hasHairInterface && !hairEnabled) {
                    std::vector<float> rv, ruv;
                    std::vector<int> ri;
                    std::vector<MatGroup> rg;
                    if (ExtractRenderMeshGeometry(node, t, rv, ruv, ri, rg)) {
                        renderFallbackVerts = static_cast<int>(rv.size() / 3);
                        renderFallbackFaces = static_cast<int>(ri.size() / 3);
                    }
                }
                if (isStackHair || hasHairInterface) {
                    std::wostringstream dbg;
                    dbg << L"=== Hair probe: node=" << node->GetName()
                        << L" class=" << className.data()
                        << L" iface=" << (hasHairInterface ? L"1" : L"0")
                        << L" enabled=" << (hairEnabled ? L"1" : L"0")
                        << L" ifaceClass=" << (hairSourceClass.isNull() ? L"<null>" : hairSourceClass.data())
                        << L" extracted=" << (extracted ? L"1" : L"0")
                        << L" renderVerts=" << renderFallbackVerts
                        << L" renderFaces=" << renderFallbackFaces
                        << L" groupsAdded=" << static_cast<int>(hairGroups.size() - beforeCount);
                    HairDebugLog(dbg.str());
                    // Now do a verbose pipeline dump for this node
                    HairDebugLog(L"  pipeline dump:");
                    FindHairModifierOnStackEnum dumpProc;
                    dumpProc.dumpAll = true;
                    EnumGeomPipeline(&dumpProc, node);
                    HairDebugLog(L"  pipeline dump end");
                }
                collectHair(node);
            }
        };
        collectHair(root);

        if (hairGroups.empty()) return;

        for (const HairInstanceGroup& group : hairGroups) {
            if (group.instanceCount > 0) hairHandles_.insert(group.handle);
        }

        ss << L",\"hairInstances\":[";
        bool firstHair = true;
        for (const HairInstanceGroup& group : hairGroups) {
            if (group.instanceCount <= 0 || group.transforms.empty()) continue;
            if (!firstHair) ss << L',';
            firstHair = false;
            ss << L"{\"h\":" << group.handle;
            ss << L",\"vis\":" << (group.visible ? L'1' : L'0');
            ss << L",\"count\":" << group.instanceCount;
            ss << L",\"t\":";
            WriteFloats(ss, group.nodeTransform, 16);
            ss << L",\"xforms\":";
            WriteFloats(ss, group.transforms.data(), group.transforms.size());
            if (!group.colors.empty()) {
                ss << L",\"colors\":";
                WriteFloats(ss, group.colors.data(), group.colors.size());
            }
            ss << L",\"mat\":";
            WriteMaterialFull(ss, group.pbr);
            ss << L'}';
        }
        ss << L']';
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
        skinnedHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        audioHandles_.clear();
        gltfHandles_.clear();
        hairHandles_.clear();
        deformHandles_.clear();
        pluginInstHandles_.clear();
        pluginInstHash_.clear();
        lastSentTransforms_.clear();

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"scene\",\"frame\":" << frameId << L",\"nodes\":[";
        bool first = true;
        WriteSceneNodes(root, t, ss, first, prevGeom);
        for (auto it = skinnedControlIdxCache_.begin(); it != skinnedControlIdxCache_.end(); ) {
            if (skinnedHandles_.find(it->first) == skinnedHandles_.end()) it = skinnedControlIdxCache_.erase(it);
            else ++it;
        }
        ss << L"],";

        // Camera + scene camera list
        WriteCameraJson(ss);
        ss << L",";
        WriteSceneCamerasJson(ss);

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
        ss << L",";
        WriteAudiosJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteGLTFsJson(ss, ip, t, true, false, true);

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
                    if (IsMaxJsSyncDrawVisible(node)) {
                        if (IsForestPackAvailable() && IsForestPackNode(node))
                            ExtractForestPackInstances(node, t, allInstGroups);
                        else if (IsRailCloneAvailable() && IsRailCloneNode(node))
                            ExtractRailCloneInstances(node, t, allInstGroups);
                        else if (IsTyFlowAvailable() && IsTyFlowNode(node))
                            ExtractTyFlowInstances(node, t, allInstGroups);
                    }
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
        WriteHairInstanceGroupsJson(ss, root, t);

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
            if (!node) continue;
            ObjectState os = node->EvalWorldState(t);
            if (os.obj && (IsThreeJSSplatClassID(os.obj->ClassID()) || IsThreeJSAudioClassID(os.obj->ClassID()) || IsThreeJSGLTFClassID(os.obj->ClassID()))) {
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

            // Hidden node — skip extraction but recurse into children
            if (node->IsNodeHidden(TRUE)) {
                WriteSceneNodes(node, t, ss, first, prevGeom);
                continue;
            }

            ULONG handle = node->GetHandle();
            if (HasEnabledHairModifier(node)) {
                pluginInstHandles_.insert(handle);
            }

            // Skip expensive ExtractMesh for previously-tracked nodes with unchanged geometry
            bool skipExtract = false;
            if (prevGeom.count(handle) && geoHashMap_.count(handle)) {
                if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                    Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                    uint64_t validKey = MakeGeomValidityKey(gv);
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
                { JsModData jm; GetJsModData(node, t, jm); if (jm.found) { ss << L","; WriteJsModJson(ss, jm); } }
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
                if (FindModifierOnNode(node, SKIN_CLASSID)) skinnedHandles_.insert(handle);
            } else {
                std::vector<float> verts, uvs, norms;
                std::vector<VertexColorAttributeRecord> vertexColors;
                std::vector<int> indices;
                std::vector<MatGroup> groups;
                const bool isSkinned = FindModifierOnNode(node, SKIN_CLASSID) != nullptr;
                std::vector<int> controlIdx;
                // Always capture the control-vertex mapping — any topology-
                // stable deforming modifier (Skin, Path Deform, Bend, FFD, etc.)
                // can then route through the fast-positions path instead of
                // the full ExtractMesh (4x smaller payload, single EvalWorldState).
                bool extracted = ExtractMesh(node, t, verts, uvs, indices, groups, &norms, &controlIdx, &vertexColors);

                // Spline fallback — extract as line geometry
                bool isSpline = false;
                if (!extracted && ShouldExtractRenderableShape(node, t, &os)) {
                    extracted = ExtractSpline(node, t, verts, indices);
                    isSpline = extracted;
                    if (extracted) vertexColors.clear();
                }

                if (extracted) {
                    float xform[16]; GetTransform16(node, t, xform);

                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        lastBBoxHash_[handle] = MakeGeomValidityKey(gv);
                    }
                    groupCache_[handle] = groups;
                    if (isSkinned) skinnedHandles_.insert(handle);
                    if (!isSpline && controlIdx.size() * 3 == verts.size()) {
                        skinnedControlIdxCache_[handle] = std::move(controlIdx);
                        // If this mesh has a modifier stack it can deform without
                        // firing a node event (e.g. Path Deform driven by time).
                        // Mark it for per-frame polling so playback catches it
                        // without waiting for the idle geometry detector.
                        if (node->GetObjectRef() &&
                            node->GetObjectRef()->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
                            deformHandles_.insert(handle);
                        } else {
                            deformHandles_.erase(handle);
                        }
                    } else {
                        skinnedControlIdxCache_.erase(handle);
                        deformHandles_.erase(handle);
                    }

                    if (!first) ss << L',';
                    ss << L"{\"h\":" << handle;
                    ss << L",\"n\":\"" << EscapeJson(node->GetName()) << L'"';
                    ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
                    ss << L",\"props\":{"; WriteNodePropsJson(ss, node, t); ss << L'}';
                    { JsModData jm; GetJsModData(node, t, jm); if (jm.found) { ss << L","; WriteJsModJson(ss, jm); } }
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
                    WriteVertexColorAttributesJson(ss, vertexColors);

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
                    if (FindModifierOnNode(node, SKIN_CLASSID)) skinnedHandles_.insert(handle);
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
        skinnedHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        audioHandles_.clear();
        gltfHandles_.clear();
        hairHandles_.clear();
        deformHandles_.clear();
        pluginInstHandles_.clear();
        pluginInstHash_.clear();
        lastSentTransforms_.clear();

        // Collect all geometry nodes
        struct NodeGeo {
            ULONG handle;
            INode* node;
            std::vector<float> verts, uvs, norms;
            std::vector<VertexColorAttributeRecord> vertexColors;
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
                        // Use the first handle we *traverse* as the source. GetInstances
                        // returns group members in InstanceMgr order, which does NOT match
                        // the scene DFS order used below in collect(). If the chosen source
                        // is visited after its siblings, extractedSources is empty when
                        // they're checked and nobody ever gets instOfHandle set.
                        ULONG srcH = h;
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
                if (os.obj && (IsThreeJSSplatClassID(os.obj->ClassID()) || IsThreeJSAudioClassID(os.obj->ClassID()) || IsThreeJSGLTFClassID(os.obj->ClassID()))) {
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
                ng.visible = IsMaxJsSyncDrawVisible(node);
                if (HasEnabledHairModifier(node)) {
                    pluginInstHandles_.insert(ng.handle);
                }

                // Instance detection via IInstanceMgr
                auto instIt = instanceSourceMap.find(ng.handle);
                ULONG srcHandle = (instIt != instanceSourceMap.end()) ? instIt->second : 0;
                ng.objId = srcHandle; // used as instance group ID in JSON

                // Skip expensive ExtractMesh for previously-tracked nodes with unchanged geometry.
                bool skipExtract = false;
                if (prevGeom.count(ng.handle) && geoHashMap_.count(ng.handle)) {
                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        uint64_t validKey = MakeGeomValidityKey(gv);
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
                    if (FindModifierOnNode(node, SKIN_CLASSID)) skinnedHandles_.insert(node->GetHandle());
                } else {
                    const bool isSkinned = FindModifierOnNode(node, SKIN_CLASSID) != nullptr;
                    std::vector<int> controlIdx;
                    bool extracted = ExtractMesh(node, t, ng.verts, ng.uvs, ng.indices, ng.groups, &ng.norms, &controlIdx, &ng.vertexColors);
                    if (!extracted && ShouldExtractRenderableShape(node, t, &os)) {
                        extracted = ExtractSpline(node, t, ng.verts, ng.indices);
                        ng.spline = extracted;
                        if (extracted) {
                            ng.uvs.clear();
                            ng.norms.clear();
                            ng.vertexColors.clear();
                            ng.groups.clear();
                        }
                    }
                    if (!extracted) {
                        collect(node);
                        continue;
                    }

                    // Use raw hash consistent with DetectGeometryChanges
                    uint64_t hash = 0;
                    if (!TryHashRenderableGeometryState(node, t, hash))
                        hash = HashMeshData(ng.verts, ng.indices, ng.uvs, &ng.vertexColors);
                    auto it = geoHashMap_.find(ng.handle);
                    ng.changed = (it == geoHashMap_.end() || it->second != hash);
                    geoHashMap_[ng.handle] = hash;
                    groupCache_[ng.handle] = ng.groups;

                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        lastBBoxHash_[ng.handle] = MakeGeomValidityKey(gv);
                    }
                    if (isSkinned) skinnedHandles_.insert(node->GetHandle());
                    if (!ng.spline && controlIdx.size() * 3 == ng.verts.size()) {
                        skinnedControlIdxCache_[ng.handle] = std::move(controlIdx);
                        if (node->GetObjectRef() &&
                            node->GetObjectRef()->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
                            deformHandles_.insert(ng.handle);
                        } else {
                            deformHandles_.erase(ng.handle);
                        }
                    } else {
                        skinnedControlIdxCache_.erase(ng.handle);
                        deformHandles_.erase(ng.handle);
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
                        for (VertexColorAttributeRecord& attr : ng.vertexColors) {
                            attr.off = totalBytes;
                            if (!attr.values.empty())
                                totalBytes += attr.values.size() * sizeof(float);
                        }
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
        for (auto it = audioHashMap_.begin(); it != audioHashMap_.end(); ) {
            if (audioHandles_.find(it->first) == audioHandles_.end()) it = audioHashMap_.erase(it);
            else ++it;
        }
        for (auto it = gltfHashMap_.begin(); it != gltfHashMap_.end(); ) {
            if (gltfHandles_.find(it->first) == gltfHandles_.end()) it = gltfHashMap_.erase(it);
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
        for (auto it = skinnedControlIdxCache_.begin(); it != skinnedControlIdxCache_.end(); ) {
            if (skinnedHandles_.find(it->first) == skinnedHandles_.end()) it = skinnedControlIdxCache_.erase(it);
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
            { JsModData jm; GetJsModData(ng.node, t, jm); if (jm.found) { ss << L","; WriteJsModJson(ss, jm); } }
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
                for (const VertexColorAttributeRecord& attr : ng.vertexColors) {
                    if (!attr.values.empty()) {
                        memcpy(bufPtr + attr.off, attr.values.data(), attr.values.size() * sizeof(float));
                    }
                }

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
                WriteVertexColorOffsetsJson(ss, ng.vertexColors);
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
        ss << L",";
        WriteAudiosJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteGLTFsJson(ss, ip, t, true, false, true);

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
                    if (IsMaxJsSyncDrawVisible(node)) {
                        if (IsForestPackAvailable() && IsForestPackNode(node))
                            ExtractForestPackInstances(node, t, allInstGroups);
                        else if (IsRailCloneAvailable() && IsRailCloneNode(node))
                            ExtractRailCloneInstances(node, t, allInstGroups);
                        else if (IsTyFlowAvailable() && IsTyFlowNode(node))
                            ExtractTyFlowInstances(node, t, allInstGroups);
                    }
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
        WriteHairInstanceGroupsJson(ss, root, t);

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

        ss << L",";
        WriteSceneCamerasJson(ss);
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
                splatHashMap_.erase(handle);
                audioHashMap_.erase(handle);
                gltfHashMap_.erase(handle);
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

            const bool visible = IsMaxJsSyncDrawVisible(node);

            if (!first) ss << L',';
            ss << L"{\"h\":" << handle;
            ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
            ss << L",\"vis\":" << (visible ? L'1' : L'0');
            { JsModData jm; GetJsModData(node, t, jm); ss << L",\"jsmod\":" << (jm.found ? L"true" : L"false"); }
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
        ss << L",";
        WriteAudiosJson(ss, ip, t, true, true, true);
        ss << L",";
        WriteGLTFsJson(ss, ip, t, true, true, true);
        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    // ── Render-to-image (production render) ────────────────

    HANDLE renderImageEvent_ = nullptr;  // signaled when JS confirms frame rendered
    bool renderLocked_ = false;          // panel is locked to render resolution
    RECT preRenderRect_ = {};            // saved window rect before render
    LONG preRenderStyle_ = 0;            // saved window style before render

    void LockToRenderSize(int width, int height) {
        if (!hwnd_ || renderLocked_) return;
        GetWindowRect(hwnd_, &preRenderRect_);
        preRenderStyle_ = GetWindowLong(hwnd_, GWL_STYLE);

        // Remove resize/maximize handles
        LONG style = preRenderStyle_ & ~(WS_THICKFRAME | WS_MAXIMIZEBOX);
        SetWindowLong(hwnd_, GWL_STYLE, style);

        // Compute window size from desired client area
        RECT desired = { 0, 0, width, height };
        AdjustWindowRect(&desired, style, FALSE);
        int winW = desired.right - desired.left;
        int winH = desired.bottom - desired.top;

        SetWindowPos(hwnd_, nullptr,
            preRenderRect_.left, preRenderRect_.top, winW, winH,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        Resize();  // update controller bounds
        renderLocked_ = true;
    }

    void UnlockRenderSize() {
        if (!hwnd_ || !renderLocked_) return;
        SetWindowLong(hwnd_, GWL_STYLE, preRenderStyle_);
        SetWindowPos(hwnd_, nullptr,
            preRenderRect_.left, preRenderRect_.top,
            preRenderRect_.right - preRenderRect_.left,
            preRenderRect_.bottom - preRenderRect_.top,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        Resize();
        renderLocked_ = false;
    }

    void SetWebViewBackgroundTransparent(bool transparent) {
        ComPtr<ICoreWebView2Controller2> ctrl2;
        if (SUCCEEDED(controller_->QueryInterface(IID_PPV_ARGS(&ctrl2))) && ctrl2) {
            COREWEBVIEW2_COLOR bg;
            bg.R = 0; bg.G = 0; bg.B = 0;
            bg.A = transparent ? 0 : 255;
            ctrl2->put_DefaultBackgroundColor(bg);
        }
    }

    // Render a single frame at the given resolution and write to a Max Bitmap.
    // Called from ThreeJSRenderer::Render() on the main thread.
    bool RenderFrameToBitmap(Bitmap* target, int width, int height, TimeValue t, RendProgressCallback* prog) {
        if (!webview_ || !target) return false;

        auto restoreRenderState = [this]() {
            if (webview_) {
                webview_->PostWebMessageAsJson(L"{\"type\":\"render_to_image_done\"}");
            }
            UnlockRenderSize();
            SetWebViewBackgroundTransparent(false);
        };

        // Wait for JS to be ready (panel may have just been created)
        if (!jsReady_) {
            const DWORD readyTimeout = 15000;
            const DWORD readyStart = GetTickCount();
            while (!jsReady_) {
                if (GetTickCount() - readyStart > readyTimeout) {
                    restoreRenderState();
                    return false;
                }
                MSG winMsg;
                while (PeekMessage(&winMsg, nullptr, 0, 0, PM_REMOVE)) {
                    TranslateMessage(&winMsg);
                    DispatchMessage(&winMsg);
                }
                Sleep(1);
            }
        }

        // Lock panel to render resolution and set transparent background for alpha
        LockToRenderSize(width, height);
        SetWebViewBackgroundTransparent(true);
        if (prog) prog->SetTitle(_T("three.js — syncing frame..."));

        // Disable gamma/color transforms — Three.js output is already display-referred sRGB
        target->UseScaleColors(0);

        // Create event for synchronization
        if (!renderImageEvent_)
            renderImageEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        ResetEvent(renderImageEvent_);

        // Tell JS to render at the requested resolution
        int fps = GetFrameRate();
        int frame = t / GetTicksPerFrame();
        wchar_t msg[256];
        swprintf_s(msg, L"{\"type\":\"render_to_image\",\"width\":%d,\"height\":%d,\"frame\":%d,\"fps\":%d}",
                   width, height, frame, fps);

        // Force a fresh scene sync at the requested frame before asking JS to render.
        Interface* ip = GetCOREInterface();
        TimeValue previousTime = ip ? ip->GetTime() : t;
        if (ip && previousTime != t) ip->SetTime(t, FALSE);
        if (useBinary_) SendFullSyncBinary(); else SendFullSync();
        webview_->PostWebMessageAsJson(msg);

        // Pump messages until JS signals ready or timeout (10 seconds)
        const DWORD timeout = 10000;
        const DWORD start = GetTickCount();
        while (WaitForSingleObject(renderImageEvent_, 0) != WAIT_OBJECT_0) {
            if (GetTickCount() - start > timeout) {
                if (ip && previousTime != t) ip->SetTime(previousTime, FALSE);
                restoreRenderState();
                return false;
            }
            MSG winMsg;
            while (PeekMessage(&winMsg, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&winMsg);
                DispatchMessage(&winMsg);
            }
            Sleep(1);
        }

        // JS has rendered — capture the WebView2 content
        HANDLE captureEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        bool captureOk = false;
        if (prog) prog->SetTitle(_T("three.js — capturing frame..."));

        ComPtr<IStream> stream;
        CreateStreamOnHGlobal(NULL, TRUE, &stream);

        webview_->CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            stream.Get(),
            Callback<ICoreWebView2CapturePreviewCompletedHandler>(
                [&captureOk, &captureEvent, stream, target](HRESULT hr) -> HRESULT {
                    if (SUCCEEDED(hr)) {
                        LARGE_INTEGER zero = {};
                        stream->Seek(zero, STREAM_SEEK_SET, nullptr);

                        ComPtr<IWICImagingFactory> wic;
                        CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                            CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic));
                        if (wic) {
                            ComPtr<IWICBitmapDecoder> decoder;
                            wic->CreateDecoderFromStream(stream.Get(), nullptr,
                                WICDecodeMetadataCacheOnLoad, &decoder);
                            if (decoder) {
                                ComPtr<IWICBitmapFrameDecode> frame;
                                decoder->GetFrame(0, &frame);
                                if (frame) {
                                    int dstW = target->Width();
                                    int dstH = target->Height();

                                    UINT srcW, srcH;
                                    frame->GetSize(&srcW, &srcH);

                                    ComPtr<IWICBitmapScaler> scaler;
                                    wic->CreateBitmapScaler(&scaler);
                                    scaler->Initialize(frame.Get(), dstW, dstH,
                                        WICBitmapInterpolationModeHighQualityCubic);

                                    ComPtr<IWICFormatConverter> converter;
                                    wic->CreateFormatConverter(&converter);
                                    converter->Initialize(scaler.Get(),
                                        GUID_WICPixelFormat32bppBGRA,
                                        WICBitmapDitherTypeNone, nullptr, 0,
                                        WICBitmapPaletteTypeCustom);

                                    std::vector<BYTE> pixels(dstW * dstH * 4);
                                    converter->CopyPixels(nullptr, dstW * 4,
                                        (UINT)pixels.size(), pixels.data());

                                    // Write to Max Bitmap — preserve alpha from capture
                                    BMM_Color_64 px;
                                    for (int y = 0; y < dstH; y++) {
                                        for (int x = 0; x < dstW; x++) {
                                            int idx = (y * dstW + x) * 4;
                                            px.b = pixels[idx + 0] << 8;
                                            px.g = pixels[idx + 1] << 8;
                                            px.r = pixels[idx + 2] << 8;
                                            px.a = pixels[idx + 3] << 8;
                                            target->PutPixels(x, y, 1, &px);
                                        }
                                        target->ShowProgressLine(y);
                                    }
                                    target->RefreshWindow();
                                    captureOk = true;
                                }
                            }
                        }
                    }
                    SetEvent(captureEvent);
                    return S_OK;
                }).Get());

        // Wait for capture to finish
        const DWORD captureStart = GetTickCount();
        while (WaitForSingleObject(captureEvent, 0) != WAIT_OBJECT_0) {
            if (GetTickCount() - captureStart > timeout) break;
            MSG winMsg;
            while (PeekMessage(&winMsg, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&winMsg);
                DispatchMessage(&winMsg);
            }
            Sleep(1);
        }
        CloseHandle(captureEvent);

        // Tell JS to restore, unlock panel, restore opaque background
        if (ip && previousTime != t) ip->SetTime(previousTime, FALSE);
        restoreRenderState();

        return captureOk;
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
    RECT lastFloatingAnchorRect_ = {};
    bool haveLastFloatingAnchorRect_ = false;
    bool floatingInSizeMove_ = false;
    bool hostSubclassAttached_ = false;
    static constexpr UINT_PTR kHostSubclassId = 0xC0DE5A1Dull;

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

    void BeginFloatingSizeMove() {
        if (IsViewportHosted()) return;
        floatingInSizeMove_ = true;
    }

    void EndFloatingSizeMove() {
        if (IsViewportHosted()) return;
        floatingInSizeMove_ = false;
        RememberFloatingBounds();
        haveLastFloatingAnchorRect_ = false;
    }

    static bool RectHasArea(const RECT& rect) {
        return rect.right > rect.left && rect.bottom > rect.top;
    }

    static bool RectNear(const RECT& a, const RECT& b, int tolerance = 24) {
        return std::abs(a.left - b.left) <= tolerance &&
               std::abs(a.top - b.top) <= tolerance &&
               std::abs(a.right - b.right) <= tolerance &&
               std::abs(a.bottom - b.bottom) <= tolerance;
    }

    static bool RectSizeNear(const RECT& a, const RECT& b, int tolerance = 32) {
        const int aWidth = a.right - a.left;
        const int aHeight = a.bottom - a.top;
        const int bWidth = b.right - b.left;
        const int bHeight = b.bottom - b.top;
        return std::abs(aWidth - bWidth) <= tolerance &&
               std::abs(aHeight - bHeight) <= tolerance;
    }

    bool GetFloatingAnchorRect(RECT& anchorRect) const {
        anchorRect = {};

        HWND owner = GetWindow(hwnd_, GW_OWNER);
        if ((!owner || !IsWindow(owner)) && GetCOREInterface()) {
            owner = GetCOREInterface()->GetMAXHWnd();
        }
        if (!owner || !IsWindow(owner) || IsIconic(owner)) return false;
        RECT clientRect = {};
        if (GetClientRect(owner, &clientRect) && RectHasArea(clientRect)) {
            POINT topLeft = { clientRect.left, clientRect.top };
            POINT bottomRight = { clientRect.right, clientRect.bottom };
            if (ClientToScreen(owner, &topLeft) && ClientToScreen(owner, &bottomRight)) {
                anchorRect.left = topLeft.x;
                anchorRect.top = topLeft.y;
                anchorRect.right = bottomRight.x;
                anchorRect.bottom = bottomRight.y;
                if (RectHasArea(anchorRect)) return true;
            }
        }

        if (!GetWindowRect(owner, &anchorRect)) return false;
        return RectHasArea(anchorRect);
    }

    void NotifyWebViewParentWindowPositionChanged() {
        if (!controller_) return;
        controller_->NotifyParentWindowPositionChanged();
    }

    void NormalizeFloatingWindow(bool forceRecenter = false) {
        if (!hwnd_ || IsViewportHosted() || !IsWindowVisible(hwnd_) || IsIconic(hwnd_) || floatingInSizeMove_) return;

        RECT rect = {};
        if (!GetWindowRect(hwnd_, &rect)) return;

        RECT anchorRect = {};
        const bool hasAnchorRect = GetFloatingAnchorRect(anchorRect);
        const bool wasAnchoredToPreviousRect = haveLastFloatingAnchorRect_ &&
            RectNear(rect, lastFloatingAnchorRect_, 8) &&
            RectSizeNear(rect, lastFloatingAnchorRect_, 8);
        const bool shouldTrackAnchor = hasAnchorRect &&
            (IsZoomed(hwnd_) || wasAnchoredToPreviousRect);

        int width = rect.right - rect.left;
        int height = rect.bottom - rect.top;
        if (width < 320 || height < 240) forceRecenter = true;

        if (shouldTrackAnchor) {
            width = anchorRect.right - anchorRect.left;
            height = anchorRect.bottom - anchorRect.top;
        }

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
        if (shouldTrackAnchor) {
            x = anchorRect.left;
            y = anchorRect.top;
        } else if (forceRecenter) {
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
        if (hasAnchorRect) {
            lastFloatingAnchorRect_ = anchorRect;
            haveLastFloatingAnchorRect_ = true;
        } else {
            haveLastFloatingAnchorRect_ = false;
        }
    }

    bool MaintainViewportHost() {
        if (!IsViewportHosted()) return true;
        if (!hwnd_ || !IsWindow(hwnd_)) {
            return false;
        }
        if (!IsWindow(embeddedViewportHwnd_)) {
            // Host HWND transiently invalid (3ds Max min/max, layout
            // rebuilds, DPI changes). Don't tear down to floating —
            // just hide and wait. ReparentIntoViewport reattaches on
            // the next session; RestoreFromViewport is the only path
            // that actually unhosts (EndSession / Escape / Destroy).
            hostSubclassAttached_ = false;
            if (IsWindowVisible(hwnd_)) ShowWindow(hwnd_, SW_HIDE);
            return false;
        }

        // Alt+W maximizes the Nitrous viewport by expanding this very HWND to
        // fill the whole Max window; mirroring that into the child would turn
        // the WebView into a fullscreen takeover. Collapse the child to 0x0
        // so it's effectively invisible without touching ShowWindow state
        // (which races with Max's layout animation and causes flicker). On
        // unmax, the normal reposition path below restores full size.
        Interface* ip = GetCOREInterface();
        if (ip && ip->IsViewportMaxed()) {
            RECT cur = {};
            if (GetClientRect(hwnd_, &cur) &&
                (cur.right - cur.left != 0 || cur.bottom - cur.top != 0)) {
                SetWindowPos(hwnd_, nullptr, 0, 0, 0, 0,
                    SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS);
            }
            return false;
        }

        if (!hostSubclassAttached_) AttachHostSubclass();

        const LONG hostedStyle = WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
        bool reattached = false;
        if (GetWindowLong(hwnd_, GWL_STYLE) != hostedStyle) {
            SetWindowLong(hwnd_, GWL_STYLE, hostedStyle);
            reattached = true;
        }
        if (GetParent(hwnd_) != embeddedViewportHwnd_) {
            SetParent(hwnd_, embeddedViewportHwnd_);
            reattached = true;
        }

        HWND hostRoot = GetAncestor(embeddedViewportHwnd_, GA_ROOT);
        if ((hostRoot && IsIconic(hostRoot)) || !IsWindowVisible(embeddedViewportHwnd_)) {
            if (IsWindowVisible(hwnd_)) ShowWindow(hwnd_, SW_HIDE);
            return false;
        }

        RECT vpRect = {};
        if (!GetClientRect(embeddedViewportHwnd_, &vpRect)) {
            return false;
        }

        const int width = vpRect.right - vpRect.left;
        const int height = vpRect.bottom - vpRect.top;
        if (width < 64 || height < 64) {
            // Viewport layout transitions briefly report tiny/empty client
            // rects. Treat that as a suspended host, not a fatal condition.
            if (IsWindowVisible(hwnd_)) ShowWindow(hwnd_, SW_HIDE);
            return false;
        }

        RECT childRect = {};
        bool needReposition = reattached || !GetClientRect(hwnd_, &childRect) ||
            (childRect.right - childRect.left) != width ||
            (childRect.bottom - childRect.top) != height ||
            !IsWindowVisible(hwnd_);
        if (needReposition) {
            UINT posFlags = SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_SHOWWINDOW;
            if (reattached) posFlags |= SWP_FRAMECHANGED;
            SetWindowPos(hwnd_, HWND_TOP, 0, 0, width, height, posFlags);
        } else {
            ShowWindow(hwnd_, SW_SHOWNA);
        }
        Resize();
        return true;
    }

    bool MaintainWindowState() {
        if (IsViewportHosted()) {
            return MaintainViewportHost();
        }

        NormalizeFloatingWindow(false);
        return true;
    }

    static LRESULT CALLBACK HostSubclassProc(HWND h, UINT msg, WPARAM w, LPARAM l,
                                             UINT_PTR id, DWORD_PTR ref) {
        auto* self = reinterpret_cast<MaxJSPanel*>(ref);
        if (!self) return DefSubclassProc(h, msg, w, l);

        switch (msg) {
        case WM_SIZE:
        case WM_WINDOWPOSCHANGED:
            // ActiveShade host resized — mirror the new client rect to our
            // WebView2 child immediately rather than waiting for the next
            // 33ms timer tick. Keeps the child glued to the host during
            // live drag-resizes and Max main-window maximize.
            if (self->embeddedViewportHwnd_ == h && self->hwnd_ && IsWindow(self->hwnd_)) {
                // Skip mirroring when the user hits Alt+W: Nitrous expands this
                // HWND to cover the whole Max window, and MaintainViewportHost
                // will hide the child on the next tick. Following the grown
                // rect here would briefly fullscreen the WebView first.
                Interface* ip = GetCOREInterface();
                if (ip && ip->IsViewportMaxed()) break;
                RECT vp = {};
                if (GetClientRect(h, &vp)) {
                    const int vw = vp.right - vp.left;
                    const int vh = vp.bottom - vp.top;
                    if (vw >= 64 && vh >= 64) {
                        SetWindowPos(self->hwnd_, HWND_TOP, 0, 0, vw, vh,
                            SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_SHOWWINDOW);
                        self->Resize();
                    }
                }
            }
            break;
        case WM_NCDESTROY:
            RemoveWindowSubclass(h, &MaxJSPanel::HostSubclassProc, id);
            if (self->embeddedViewportHwnd_ == h) {
                self->hostSubclassAttached_ = false;
            }
            break;
        }
        return DefSubclassProc(h, msg, w, l);
    }

    void AttachHostSubclass() {
        if (hostSubclassAttached_) return;
        if (!embeddedViewportHwnd_ || !IsWindow(embeddedViewportHwnd_)) return;
        if (SetWindowSubclass(embeddedViewportHwnd_, &MaxJSPanel::HostSubclassProc,
                              kHostSubclassId, reinterpret_cast<DWORD_PTR>(this))) {
            hostSubclassAttached_ = true;
        }
    }

    void DetachHostSubclass() {
        if (!hostSubclassAttached_) return;
        if (embeddedViewportHwnd_ && IsWindow(embeddedViewportHwnd_)) {
            RemoveWindowSubclass(embeddedViewportHwnd_,
                                 &MaxJSPanel::HostSubclassProc, kHostSubclassId);
        }
        hostSubclassAttached_ = false;
    }

    void StartActiveShade(Bitmap* target) {
        asTarget_ = target;
        asCapturing_ = true;
        if (hwnd_) SetTimer(hwnd_, AS_TIMER_ID, AS_INTERVAL_MS, nullptr);
        RefreshCallbackRegistration(true);
    }

    void StopActiveShade() {
        asCapturing_ = false;
        asTarget_ = nullptr;
        if (hwnd_) KillTimer(hwnd_, AS_TIMER_ID);
        RefreshCallbackRegistration();
    }

    // Reparent WebView2 into a viewport HWND — true GPU overlay
    void ReparentIntoViewport(HWND viewportHwnd) {
        if (!hwnd_ || !viewportHwnd || !IsWindow(viewportHwnd)) return;

        if (!IsViewportHosted()) {
            RememberFloatingBounds();
            originalParent_ = GetParent(hwnd_);
            originalStyle_ = GetWindowLong(hwnd_, GWL_STYLE);
            GetWindowRect(hwnd_, &originalRect_);
        } else if (embeddedViewportHwnd_ != viewportHwnd) {
            DetachHostSubclass();
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

        AttachHostSubclass();
        RefreshCallbackRegistration(true);
    }

    // Restore to original floating window
    void RestoreFromViewport() {
        if (!hwnd_ || !IsViewportHosted()) return;

        DetachHostSubclass();

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
        RefreshCallbackRegistration(true);
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
        if (!controller_ || !hwnd_) return;
        RECT b;
        if (!GetClientRect(hwnd_, &b)) return;
        if ((b.right - b.left) <= 0 || (b.bottom - b.top) <= 0) return;
        controller_->put_Bounds(b);
        NotifyWebViewParentWindowPositionChanged();
    }

    void Destroy() {
        StopActiveShade();
        if (renderImageEvent_) { CloseHandle(renderImageEvent_); renderImageEvent_ = nullptr; }
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
        skinnedHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        audioHandles_.clear();
        gltfHandles_.clear();
        hairHandles_.clear();
        deformHandles_.clear();
        mtlHashMap_.clear();
        lightHashMap_.clear();
        splatHashMap_.clear();
        audioHashMap_.clear();
        gltfHashMap_.clear();
        propHashMap_.clear();
        geoHashMap_.clear();
        jsmodStateMap_.clear();
        groupCache_.clear();
        lastBBoxHash_.clear();
        lastLiveGeomHash_.clear();
        mtlScalarHashMap_.clear();
        skinnedControlIdxCache_.clear();
        lastSkinnedLivePollTick_ = 0;
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
        case WM_ENTERSIZEMOVE:
            if (p) p->BeginFloatingSizeMove();
            return 0;
        case WM_EXITSIZEMOVE:
            if (p) p->EndFloatingSizeMove();
            return 0;
        case WM_SHOWWINDOW:
            if (p) p->RefreshCallbackRegistration(wParam != 0);
            break;
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
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkGeometryTopologyDirty(nodes);
}

void MaxJSFastNodeEventCallback::ControllerOtherEvent(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkTrackedNodesDirty(nodes);
    // Controller change on ANY node (bones, helpers, dummies, etc.) can drive
    // skin deformation via the modifier stack. Max doesn't fire a geometry
    // event on the skinned mesh itself in this path — and the RedrawViewsCallback
    // doesn't fire during interactive gizmo drags — so we poll deform meshes
    // here directly. The 16ms throttle inside CheckSkinnedGeometryLive dedups
    // against the tick-timer and redraw paths.
    owner_->MarkInteractiveActivity();
    owner_->CheckSkinnedGeometryLive();
}

void MaxJSFastNodeEventCallback::LinkChanged(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkTrackedNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::SelectionChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkTrackedNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::HideChanged(NodeKeyTab& nodes) {
    if (owner_) owner_->MarkVisibilityNodesDirty(nodes);
}

void MaxJSFastNodeEventCallback::GeometryChanged(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkGeometryPositionsDirty(nodes);
}

void MaxJSFastNodeEventCallback::TopologyChanged(NodeKeyTab& nodes) {
    if (!owner_) return;
    owner_->MarkInteractiveActivity();
    owner_->MarkGeometryTopologyDirty(nodes);
}

void MaxJSFastRedrawCallback::proc(Interface*) {
    if (!owner_) return;
    const bool animPlaying = owner_->IsAnimationPlaying();
    owner_->MarkSelectedTransformsDirty();
    owner_->CheckTrackedMaterialScalarsLive();
    if (!animPlaying && !owner_->ShouldFavorInteractivePerformance()) {
        owner_->MarkTrackedLightTransformsDirty();
        owner_->CheckTrackedLightsLive();
        owner_->MarkTrackedSplatTransformsDirty();
        owner_->MarkTrackedAudioTransformsDirty();
        owner_->PollViewportModes();
    }
    owner_->MarkCameraDirtyIfChanged();
    owner_->CheckSelectedGeometryLive();
    owner_->CheckSkinnedGeometryLive();
}

void MaxJSFastTimeChangeCallback::TimeChanged(TimeValue) {
    if (!owner_) return;
    owner_->MarkAnimatedTransformsDirty();
    owner_->MarkCameraDirty();
    owner_->MarkInteractiveActivity();
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

void MaxJSNotifyMaterialEdited(ReferenceTarget* target) {
    if (g_panel) g_panel->NotifyMaterialEditedTarget(target);
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

// Ensure panel exists and is visible (non-toggling)
static void EnsurePanel() {
    Interface* ip = GetCOREInterface();
    if (!g_panel) {
        g_panel = new MaxJSPanel();
        g_panel->Create(ip ? ip->GetMAXHWnd() : nullptr);
    } else if (g_panel->hwnd_ && !IsWindowVisible(g_panel->hwnd_)) {
        ShowWindow(g_panel->hwnd_, SW_SHOW);
        g_panel->NormalizeFloatingWindow(true);
    } else if (!g_panel->hwnd_) {
        g_panel->Create(ip ? ip->GetMAXHWnd() : nullptr);
    }
}
void EnsureMaxJSPanel() { EnsurePanel(); }

void StartMaxJSActiveShade(Bitmap* target) {
    if (!g_panel) EnsurePanel();
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
bool RenderMaxJSFrameToBitmap(Bitmap* target, int width, int height, TimeValue t, RendProgressCallback* prog) {
    EnsurePanel();
    if (!g_panel) return false;
    return g_panel->RenderFrameToBitmap(target, width, height, t, prog);
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
__declspec(dllexport) int LibNumberClasses()           { return 22; }
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
        case 15: return GetThreeJSAudioDesc();
        case 16: return GetThreeJSFogDesc();
        case 17: return GetThreeJSSkyDesc();
        case 18: return GetThreeJSDeformDesc();
        case 19: return GetThreeJSTSLTexDesc();
        case 20: return GetThreeJSHTMLTexDesc();
        case 21: return GetThreeJSGLTFDesc();
        default: return nullptr;
    }
}
__declspec(dllexport) ULONG LibVersion()               { return VERSION_3DSMAX; }
__declspec(dllexport) int LibInitialize()              { return TRUE; }
__declspec(dllexport) int LibShutdown()                { return TRUE; }
