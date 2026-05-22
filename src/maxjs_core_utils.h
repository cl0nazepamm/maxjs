#pragma once

#include <max.h>
#include <maxapi.h>
#include <Shlwapi.h>
#include <wincodec.h>
#include <wrl.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <sstream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

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
    if (EndsWithInsensitive(fileName, L"settings.maxjs.json")) return false;
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

static bool WriteRgb24PngFile(const std::wstring& path,
                              UINT width,
                              UINT height,
                              const std::string& rgb,
                              std::wstring& error) {
    if (width == 0 || height == 0) {
        error = L"Invalid proxy image dimensions";
        return false;
    }
    const size_t expectedBytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 3u;
    if (rgb.size() != expectedBytes) {
        error = L"Proxy image byte count does not match dimensions";
        return false;
    }

    std::vector<BYTE> bgr(expectedBytes);
    for (size_t i = 0; i < expectedBytes; i += 3) {
        bgr[i + 0] = static_cast<BYTE>(rgb[i + 2]);
        bgr[i + 1] = static_cast<BYTE>(rgb[i + 1]);
        bgr[i + 2] = static_cast<BYTE>(rgb[i + 0]);
    }

    ComPtr<IWICImagingFactory> wic;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic))) || !wic) {
        error = L"Failed to create WIC imaging factory";
        return false;
    }

    const std::filesystem::path dstPath(path);
    std::error_code ec;
    std::filesystem::create_directories(dstPath.parent_path(), ec);
    if (ec) {
        error = L"Failed to create proxy image output directory";
        return false;
    }

    ComPtr<IWICStream> stream;
    if (FAILED(wic->CreateStream(&stream)) || !stream) {
        error = L"Failed to create WIC stream";
        return false;
    }
    if (FAILED(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE))) {
        error = L"Failed to open proxy image output file";
        return false;
    }

    ComPtr<IWICBitmapEncoder> encoder;
    if (FAILED(wic->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder)) || !encoder) {
        error = L"Failed to create PNG encoder";
        return false;
    }
    if (FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache))) {
        error = L"Failed to initialize PNG encoder";
        return false;
    }

    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> props;
    if (FAILED(encoder->CreateNewFrame(&frame, &props)) || !frame) {
        error = L"Failed to create PNG frame";
        return false;
    }
    if (FAILED(frame->Initialize(props.Get())) || FAILED(frame->SetSize(width, height))) {
        error = L"Failed to initialize PNG frame";
        return false;
    }

    WICPixelFormatGUID pixelFormat = GUID_WICPixelFormat24bppBGR;
    if (FAILED(frame->SetPixelFormat(&pixelFormat)) ||
        !IsEqualGUID(pixelFormat, GUID_WICPixelFormat24bppBGR)) {
        error = L"PNG encoder did not accept RGB output format";
        return false;
    }

    const UINT stride = width * 3u;
    if (FAILED(frame->WritePixels(height, stride, static_cast<UINT>(bgr.size()), bgr.data())) ||
        FAILED(frame->Commit()) ||
        FAILED(encoder->Commit())) {
        error = L"Failed to write proxy PNG";
        return false;
    }

    return true;
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

static bool EnsureDirectoryExists(const std::wstring& path) {
    if (path.empty()) return false;
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(path), ec);
    return !ec && DirectoryExists(path);
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

static bool CopyDirectoryRecursiveWithExtensionFilter(const std::wstring& src,
                                                      const std::wstring& dst,
                                                      const std::wstring& extensionNoDot) {
    if (src.empty() || dst.empty() || extensionNoDot.empty() || !DirectoryExists(src)) return false;
    std::wstring wantedExt = L"." + extensionNoDot;
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
        if (!entry.is_regular_file()) continue;
        const std::wstring ext = entry.path().extension().wstring();
        if (_wcsicmp(ext.c_str(), wantedExt.c_str()) != 0) continue;
        std::filesystem::create_directories(target.parent_path(), ec);
        if (ec) return false;
        std::filesystem::copy_file(entry.path(), target,
            std::filesystem::copy_options::overwrite_existing, ec);
        if (ec) return false;
    }
    return true;
}

static bool CopyDirectoryRecursiveMissingOnly(const std::wstring& src, const std::wstring& dst) {
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
        if (std::filesystem::exists(target, ec)) {
            if (ec) return false;
            continue;
        }
        std::filesystem::create_directories(target.parent_path(), ec);
        if (ec) return false;
        std::filesystem::copy_file(entry.path(), target,
            std::filesystem::copy_options::none, ec);
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

static bool CopyFileIfMissingEnsuringDirectories(const std::wstring& src, const std::wstring& dst) {
    if (!FileExists(src)) return false;
    if (FileExists(dst)) return true;
    std::error_code ec;
    const auto dstPath = std::filesystem::path(dst);
    std::filesystem::create_directories(dstPath.parent_path(), ec);
    if (ec) return false;
    return CopyFileW(src.c_str(), dst.c_str(), TRUE) != FALSE;
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

static bool ExtractJsonFloat(const std::wstring& json, const wchar_t* key, float& out) {
    const std::wstring needle = std::wstring(L"\"") + key + L"\":";
    size_t pos = json.find(needle);
    if (pos == std::wstring::npos) return false;
    pos += needle.size();
    while (pos < json.size() && iswspace(json[pos])) ++pos;

    size_t start = pos;
    if (pos < json.size() && (json[pos] == L'-' || json[pos] == L'+')) ++pos;
    bool hasDigit = false;
    while (pos < json.size() && iswdigit(json[pos])) {
        hasDigit = true;
        ++pos;
    }
    if (pos < json.size() && json[pos] == L'.') {
        ++pos;
        while (pos < json.size() && iswdigit(json[pos])) {
            hasDigit = true;
            ++pos;
        }
    }
    if (!hasDigit) return false;
    if (pos < json.size() && (json[pos] == L'e' || json[pos] == L'E')) {
        const size_t exponentStart = pos++;
        if (pos < json.size() && (json[pos] == L'-' || json[pos] == L'+')) ++pos;
        size_t exponentDigits = pos;
        while (pos < json.size() && iswdigit(json[pos])) ++pos;
        if (pos == exponentDigits) pos = exponentStart;
    }

    try {
        out = std::stof(json.substr(start, pos - start));
        return std::isfinite(out);
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
    if (_wcsicmp(ext, L".mp4") == 0 || _wcsicmp(ext, L".m4v") == 0) return L"video/mp4";
    if (_wcsicmp(ext, L".webm") == 0) return L"video/webm";
    if (_wcsicmp(ext, L".mov") == 0) return L"video/quicktime";
    if (_wcsicmp(ext, L".ogv") == 0) return L"video/ogg";
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

// Parse a single HTTP byte-range header ("bytes=start-end", "bytes=start-",
// or suffix "bytes=-N"). Returns false when unparseable or unsatisfiable.
// On success outStart/outEnd are inclusive and clamped to [0, totalSize-1].
static bool ParseHttpByteRange(const std::wstring& header,
                               unsigned long long totalSize,
                               unsigned long long& outStart,
                               unsigned long long& outEnd) {
    if (totalSize == 0) return false;
    const wchar_t* p = header.c_str();
    while (*p == L' ' || *p == L'\t') ++p;
    if (_wcsnicmp(p, L"bytes=", 6) != 0) return false;
    p += 6;

    std::wstring spec(p);
    const size_t comma = spec.find(L',');  // honor only the first range
    if (comma != std::wstring::npos) spec.resize(comma);
    const size_t dash = spec.find(L'-');
    if (dash == std::wstring::npos) return false;

    std::wstring startStr = spec.substr(0, dash);
    std::wstring endStr = spec.substr(dash + 1);
    auto trim = [](std::wstring& s) {
        while (!s.empty() && iswspace(s.front())) s.erase(s.begin());
        while (!s.empty() && iswspace(s.back())) s.pop_back();
    };
    trim(startStr);
    trim(endStr);

    unsigned long long start = 0;
    unsigned long long end = totalSize - 1;
    if (startStr.empty()) {
        if (endStr.empty()) return false;             // "bytes=-" is invalid
        unsigned long long n = wcstoull(endStr.c_str(), nullptr, 10);
        if (n == 0) return false;
        if (n > totalSize) n = totalSize;
        start = totalSize - n;
        end = totalSize - 1;
    } else {
        start = wcstoull(startStr.c_str(), nullptr, 10);
        if (!endStr.empty()) end = wcstoull(endStr.c_str(), nullptr, 10);
    }
    if (start > end || start >= totalSize) return false;
    if (end >= totalSize) end = totalSize - 1;
    outStart = start;
    outEnd = end;
    return true;
}

static bool IsTiffPath(const std::wstring& path) {
    const wchar_t* ext = PathFindExtensionW(path.c_str());
    return ext && (_wcsicmp(ext, L".tif") == 0 || _wcsicmp(ext, L".tiff") == 0);
}

static bool CreatePngStreamFromWicImage(const std::wstring& path, IStream** outStream) {
    if (!outStream) return false;
    *outStream = nullptr;

    ComPtr<IWICImagingFactory> wic;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic))) || !wic) {
        return false;
    }

    ComPtr<IWICBitmapDecoder> decoder;
    if (FAILED(wic->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ,
        WICDecodeMetadataCacheOnLoad, &decoder)) || !decoder) {
        return false;
    }

    ComPtr<IWICBitmapFrameDecode> sourceFrame;
    if (FAILED(decoder->GetFrame(0, &sourceFrame)) || !sourceFrame) {
        return false;
    }

    UINT width = 0, height = 0;
    if (FAILED(sourceFrame->GetSize(&width, &height)) || width == 0 || height == 0) {
        return false;
    }

    ComPtr<IWICFormatConverter> converter;
    if (FAILED(wic->CreateFormatConverter(&converter)) || !converter) {
        return false;
    }
    if (FAILED(converter->Initialize(sourceFrame.Get(),
        GUID_WICPixelFormat32bppRGBA,
        WICBitmapDitherTypeNone,
        nullptr,
        0.0,
        WICBitmapPaletteTypeCustom))) {
        return false;
    }

    ComPtr<IStream> pngStream;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &pngStream)) || !pngStream) {
        return false;
    }

    ComPtr<IWICBitmapEncoder> encoder;
    if (FAILED(wic->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder)) || !encoder) {
        return false;
    }
    if (FAILED(encoder->Initialize(pngStream.Get(), WICBitmapEncoderNoCache))) {
        return false;
    }

    ComPtr<IWICBitmapFrameEncode> encodeFrame;
    ComPtr<IPropertyBag2> frameProps;
    if (FAILED(encoder->CreateNewFrame(&encodeFrame, &frameProps)) || !encodeFrame) {
        return false;
    }
    if (FAILED(encodeFrame->Initialize(frameProps.Get()))) {
        return false;
    }
    if (FAILED(encodeFrame->SetSize(width, height))) {
        return false;
    }

    WICPixelFormatGUID pixelFormat = GUID_WICPixelFormat32bppRGBA;
    if (FAILED(encodeFrame->SetPixelFormat(&pixelFormat))) {
        return false;
    }
    if (FAILED(encodeFrame->WriteSource(converter.Get(), nullptr))) {
        return false;
    }
    if (FAILED(encodeFrame->Commit()) || FAILED(encoder->Commit())) {
        return false;
    }

    LARGE_INTEGER zero = {};
    if (FAILED(pngStream->Seek(zero, STREAM_SEEK_SET, nullptr))) {
        return false;
    }

    *outStream = pngStream.Detach();
    return true;
}
