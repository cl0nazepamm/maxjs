#include <winsock2.h>
#include <ws2tcpip.h>
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
#include <IFileResolutionManager.h>
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
#include "maxjs_core_utils.h"
#include "maxjs_morpher_compat.h"
#include "threejs_material.h"
#include "threejs_lights.h"
#include "threejs_splat.h"
#include "maxjs_geometry_sync.h"
#include "maxjs_material_sync.h"
#include "maxjs_material_slots.h"
#include "maxjs_scene_extractors.h"
#include "threejs_audio.h"
#include "threejs_toon.h"
#include "threejs_renderer.h"
#include "threejs_fog.h"
#include "threejs_sky.h"
#include "threejs_deform.h"
#include "threejs_gltf.h"
#include <iskin.h>

#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <ShlObj.h>
#include <Shlwapi.h>
#include <shellapi.h>
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
#include <cstdint>
#include <locale>
#include <immintrin.h>
#include <ppl.h>

using namespace Microsoft::WRL;

#define MAXJS_CLASS_ID  Class_ID(0x7F3A9B01, 0x4E2D8C05)
#define MAXJS_NAME      _T("max.js")
#define MAXJS_CATEGORY  _T("max.js")

#define SYNC_TIMER_ID             1
#define SYNC_INTERVAL_MS          33   // background structural/material timer
#define MATERIAL_DETECT_TICKS     6    // ~200ms material refresh cadence
#define LIGHT_DETECT_TICKS        3    // ~100ms light parameter refresh cadence
#define WM_TOGGLE_PANEL           (WM_USER + 1)
#define WM_FAST_FLUSH             (WM_USER + 2)
#define WM_KILL_PANEL             (WM_USER + 3)
#define WM_SYNC_TICK              (WM_USER + 4)
#define WM_AS_TICK                (WM_USER + 5)
#define WM_PLAYBACK_FLUSH         (WM_USER + 6)
#define WM_EXPORT_SNAPSHOT        (WM_USER + 7)
#define WM_RENDER_SEQUENCE_STEP   (WM_USER + 8)
#define SETUP_TIMER_ID            2
#define AS_TIMER_ID               3
#define RENDER_SEQUENCE_TIMER_ID  4
#define AS_INTERVAL_MS            66   // ~15fps ActiveShade

extern HINSTANCE hInstance;
HINSTANCE hInstance = nullptr;

class MaxJSPanel;
static MaxJSPanel* g_panel = nullptr;
void MaxJSNotifyMaterialEdited(ReferenceTarget* target = nullptr);
static HWND g_helperHwnd = nullptr;
static int g_pathTracingSamplesPerFrame = 64;
static float g_pathTracingGIClamp = 8.0f;
static bool g_pathTracingFreezeSync = false;

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
//  WebView2 Panel
// ══════════════════════════════════════════════════════════════

static const wchar_t* kWindowClass = L"MaxJSPanel";

class MaxJSPanel {
public:
    #include "maxjs_panel_host.inl"

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

    // Returns the projects root folder (parent of "active" and named project folders).
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
    // is already named after the scene (e.g. `projects\my_scene\my_scene.max`)
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
                           std::wstring& error,
                           const std::wstring& directoryExtensionFilter = {}) {
        std::wstring sourcePath = rawPath;
        std::replace(sourcePath.begin(), sourcePath.end(), L'/', L'\\');
        while (!sourcePath.empty() && sourcePath.back() == L'\\') {
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
            ok = directoryExtensionFilter.empty()
                ? CopyDirectoryRecursive(sourcePath, targetPath)
                : CopyDirectoryRecursiveWithExtensionFilter(sourcePath, targetPath, directoryExtensionFilter);
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

    std::wstring SanitizeSnapshotAssetExtension(const std::wstring& fileName, const std::wstring& fallback = L".hdr") {
        const wchar_t* extPtr = PathFindExtensionW(fileName.c_str());
        std::wstring ext = (extPtr && *extPtr) ? extPtr : fallback;
        if (ext.empty() || ext.front() != L'.') ext = fallback;
        std::wstring out;
        out.reserve(ext.size());
        out.push_back(L'.');
        for (size_t i = 1; i < ext.size(); ++i) {
            const wchar_t ch = static_cast<wchar_t>(towlower(ext[i]));
            if ((ch >= L'a' && ch <= L'z') || (ch >= L'0' && ch <= L'9')) out.push_back(ch);
        }
        return out.size() > 1 ? out : fallback;
    }

    bool WriteSnapshotInlineAsset(const std::string& bytes,
                                  const std::wstring& fileName,
                                  const std::wstring& exportDir,
                                  const std::wstring& prefix,
                                  std::wstring& relativePath,
                                  std::wstring& error) {
        if (bytes.empty()) {
            error = L"Snapshot inline asset is empty";
            return false;
        }

        const std::wstring assetsDir = exportDir + L"\\assets";
        SHCreateDirectoryExW(nullptr, assetsDir.c_str(), nullptr);

        uint64_t hash = HashFNV1a(bytes.data(), bytes.size());
        if (!fileName.empty()) {
            hash = HashFNV1a(fileName.data(), fileName.size() * sizeof(wchar_t), hash);
        }

        const std::wstring targetName = prefix + L"_" + HexU64(hash) + SanitizeSnapshotAssetExtension(fileName);
        const std::wstring targetPath = assetsDir + L"\\" + targetName;
        if (!WriteBinaryFile(targetPath, bytes)) {
            error = L"Failed to write snapshot asset: " + targetPath;
            return false;
        }

        relativePath = L"./assets/" + targetName;
        return true;
    }

    bool InjectSnapshotUiHdriUrl(std::wstring& snapshotUiJson, const std::wstring& hdriUrl) {
        if (snapshotUiJson.empty() || hdriUrl.empty()) return false;
        const size_t key = snapshotUiJson.find(L"\"hdri\":");
        if (key == std::wstring::npos) return false;
        const size_t objectStart = snapshotUiJson.find(L'{', key);
        if (objectStart == std::wstring::npos) return false;
        const std::wstring escapedUrl = EscapeJson(hdriUrl.c_str());
        const std::wstring insert = L"\"url\":\"" + escapedUrl + L"\",\"source\":\"" + escapedUrl + L"\",";
        snapshotUiJson.insert(objectStart + 1, insert);
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
                                  std::wstring& error,
                                  bool skipMaterialAssets = false) {
        static const std::wstring httpsPrefix = L"https://maxjs";
        std::unordered_map<std::wstring, std::wstring> copiedPaths;
        std::wstring bakeFolderUrl;
        std::wstring bakeExtensionFilter;
        ExtractSnapshotBakeCopyFilter(json, bakeFolderUrl, bakeExtensionFilter);
        const size_t materialsStart = skipMaterialAssets ? json.find(L"\"materials\":[") : std::wstring::npos;
        const size_t materialsEnd = materialsStart != std::wstring::npos
            ? json.find(L",\"camera\"", materialsStart)
            : std::wstring::npos;
        size_t pos = 0;
        while ((pos = json.find(httpsPrefix, pos)) != std::wstring::npos) {
            const size_t end = json.find(L'"', pos);
            if (end == std::wstring::npos) break;

            const std::wstring url = json.substr(pos, end - pos);
            if (materialsStart != std::wstring::npos &&
                materialsEnd != std::wstring::npos &&
                pos > materialsStart && pos < materialsEnd) {
                pos += url.size();
                continue;
            }

            std::wstring localPath;
            if (!ResolveVirtualHostUrl(url, localPath)) {
                pos += url.size();
                continue;
            }

            const bool isDirectory = !localPath.empty() && localPath.back() == L'/';
            std::wstring directoryExtensionFilter;
            if (isDirectory && !bakeFolderUrl.empty() && url == bakeFolderUrl) {
                directoryExtensionFilter = bakeExtensionFilter;
            }

            std::wstring relativePath;
            if (!CopySnapshotAsset(localPath, isDirectory, exportDir, copiedPaths, relativePath, error, directoryExtensionFilter)) {
                return false;
            }

            json.replace(pos, url.size(), relativePath);
            pos += relativePath.size();
        }
        return true;
    }

    static size_t FindJsonObjectEnd(const std::wstring& json, size_t objectStart) {
        if (objectStart == std::wstring::npos || objectStart >= json.size() || json[objectStart] != L'{') {
            return std::wstring::npos;
        }
        bool inStr = false;
        bool esc = false;
        int depth = 0;
        for (size_t i = objectStart; i < json.size(); ++i) {
            const wchar_t c = json[i];
            if (inStr) {
                if (esc) { esc = false; continue; }
                if (c == L'\\') { esc = true; continue; }
                if (c == L'"') inStr = false;
                continue;
            }
            if (c == L'"') { inStr = true; continue; }
            if (c == L'{') {
                ++depth;
            } else if (c == L'}') {
                --depth;
                if (depth == 0) return i;
                if (depth < 0) return std::wstring::npos;
            }
        }
        return std::wstring::npos;
    }

    static size_t FindJsonArrayEnd(const std::wstring& json, size_t arrayStart) {
        if (arrayStart == std::wstring::npos || arrayStart >= json.size() || json[arrayStart] != L'[') {
            return std::wstring::npos;
        }
        bool inStr = false;
        bool esc = false;
        int depth = 0;
        for (size_t i = arrayStart; i < json.size(); ++i) {
            const wchar_t c = json[i];
            if (inStr) {
                if (esc) { esc = false; continue; }
                if (c == L'\\') { esc = true; continue; }
                if (c == L'"') inStr = false;
                continue;
            }
            if (c == L'"') { inStr = true; continue; }
            if (c == L'[') ++depth;
            else if (c == L']') {
                --depth;
                if (depth == 0) return i + 1;
                if (depth < 0) return std::wstring::npos;
            }
        }
        return std::wstring::npos;
    }

    static bool ExtractJsonStringInRange(const std::wstring& json,
                                         size_t start,
                                         size_t end,
                                         const wchar_t* key,
                                         std::wstring& out) {
        out.clear();
        if (!key || start == std::wstring::npos || end == std::wstring::npos || start >= end || end > json.size()) {
            return false;
        }
        const std::wstring needle = L"\"" + std::wstring(key) + L"\":\"";
        const size_t keyPos = json.find(needle, start);
        if (keyPos == std::wstring::npos || keyPos >= end) return false;
        size_t pos = keyPos + needle.size();
        std::wstring result;
        bool esc = false;
        for (; pos < end && pos < json.size(); ++pos) {
            const wchar_t c = json[pos];
            if (esc) {
                result.push_back(c);
                esc = false;
                continue;
            }
            if (c == L'\\') {
                esc = true;
                continue;
            }
            if (c == L'"') {
                out = result;
                return true;
            }
            result.push_back(c);
        }
        return false;
    }

    static bool ExtractSnapshotBakeCopyFilter(const std::wstring& json,
                                              std::wstring& folderUrl,
                                              std::wstring& extensionNoDot) {
        folderUrl.clear();
        extensionNoDot.clear();

        const size_t bakeKey = json.find(L"\"bake\":{");
        if (bakeKey == std::wstring::npos) return false;
        const size_t bakeObj = json.find(L'{', bakeKey);
        const size_t bakeEnd = FindJsonObjectEnd(json, bakeObj);
        if (bakeEnd == std::wstring::npos) return false;

        if (!ExtractJsonStringInRange(json, bakeObj, bakeEnd, L"folder", folderUrl) ||
            !ExtractJsonStringInRange(json, bakeObj, bakeEnd, L"extension", extensionNoDot)) {
            return false;
        }
        if (folderUrl.empty() || extensionNoDot.empty()) return false;
        if (folderUrl.back() != L'/' && folderUrl.back() != L'\\') folderUrl.push_back(L'/');
        if (!extensionNoDot.empty() && extensionNoDot.front() == L'.') extensionNoDot.erase(extensionNoDot.begin());
        return !extensionNoDot.empty();
    }

    void InjectSnapshotBakeFileManifest(std::wstring& json, const std::wstring& exportDir) {
        const size_t bakeKey = json.find(L"\"bake\":{");
        if (bakeKey == std::wstring::npos) return;
        const size_t bakeObj = json.find(L'{', bakeKey);
        const size_t bakeEnd = FindJsonObjectEnd(json, bakeObj);
        if (bakeEnd == std::wstring::npos) return;
        if (json.find(L"\"files\"", bakeObj) < bakeEnd) return;

        const size_t folderKey = json.find(L"\"folder\":\"", bakeObj);
        if (folderKey == std::wstring::npos || folderKey > bakeEnd) return;
        const size_t folderStart = folderKey + wcslen(L"\"folder\":\"");
        const size_t folderEnd = json.find(L'"', folderStart);
        if (folderEnd == std::wstring::npos || folderEnd > bakeEnd) return;

        std::wstring folder = json.substr(folderStart, folderEnd - folderStart);
        std::replace(folder.begin(), folder.end(), L'/', L'\\');
        std::wstring folderPath;
        if (folder.rfind(L".\\", 0) == 0) {
            folderPath = exportDir + L"\\" + folder.substr(2);
        } else if (folder.rfind(L"\\", 0) == 0) {
            folderPath = folder;
        } else {
            return;
        }
        while (!folderPath.empty() && (folderPath.back() == L'\\' || folderPath.back() == L'/')) {
            folderPath.pop_back();
        }
        if (!DirectoryExists(folderPath)) return;

        std::vector<std::wstring> files;
        std::error_code ec;
        for (const auto& entry : std::filesystem::directory_iterator(std::filesystem::path(folderPath), ec)) {
            if (ec) return;
            if (!entry.is_regular_file()) continue;
            files.push_back(entry.path().filename().wstring());
        }
        std::sort(files.begin(), files.end());

        std::wstringstream ss;
        ss << L",\"files\":[";
        for (size_t i = 0; i < files.size(); ++i) {
            if (i) ss << L',';
            ss << L'"' << EscapeJson(files[i].c_str()) << L'"';
        }
        ss << L']';
        json.insert(bakeEnd, ss.str());
    }

    struct SnapshotNodeRecord {
        ULONG handle = 0;
        ULONG parentHandle = 0;
        INode* node = nullptr;
        bool visible = true;
        bool spline = false;
        bool helper = false;
        std::vector<float> verts, uvs, uv2s, norms;
        std::vector<VertexColorAttributeRecord> vertexColors;
        std::vector<int> indices;
        std::vector<MatGroup> groups;
        size_t vOff = 0, iOff = 0, iN = 0, uvOff = 0, uv2Off = 0, nOff = 0;
        std::wstring iType;
        std::wstring uvType;
        std::wstring uv2Type;
        std::wstring nType;
        // Skeletal skin + optional Morpher. Morph targets are exported as static
        // relative deltas + animated morphTargetInfluences whenever a Morpher is
        // present (with or without Skin); never baked as per-frame vertices.
        bool skinRig = false;
        std::vector<ULONG> skinBoneHandles;
        std::vector<int> skinBoneParents;
        std::vector<float> skinBoneBindLocal;
        std::vector<float> skinWData;
        std::vector<float> skinIdxData;
        size_t skinWOff = 0, skinIndOff = 0, skinBoneBindOff = 0;
        std::wstring skinWType;
        std::wstring skinIdxType;
        MorphTargetSet morphTargets;
    };

    struct SnapshotAnimationTrackDef {
        struct BinaryRef {
            size_t off = 0;
            size_t n = 0;
            std::wstring type;
            bool valid = false;
        };

        std::wstring path;
        std::wstring type;
        std::wstring interpolation;
        std::vector<float> times;
        std::vector<float> values;
        std::vector<unsigned char> boolValues;
        BinaryRef timesRef;
        BinaryRef valuesRef;
        struct GeometryFrameRef {
            size_t vOff = 0, iOff = 0, uvOff = 0, nOff = 0;
            size_t vN = 0, iN = 0, uvN = 0, nN = 0;
            std::wstring iType;
            std::wstring uvType;
            std::wstring nType;
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
        std::vector<float> verts, uvs, uv2s, norms;
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
        bool includeUnusedChannels = true;  // export stray vertex-color map channels (>= 3); UI defaults this off for a lean export
        bool includeAllMorphTargets = false; // keep zero unkeyed Morpher channels; UI defaults this off for a lean export
        bool includeDebugPayload = false;
        bool includeSnapshotUi = true;
        bool includeRuntimeScene = true;
        bool includeDisabledLayers = false;
        bool copyAssets = true;
        bool includeRapierVendor = false;
        bool includeGeospatialSky = false;  // bundle @takram atmosphere + three/src for the planetary sky; off keeps exports lean
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

    static bool ShouldPreserveSnapshotSidecarDestination(const std::filesystem::path& src,
                                                        const std::filesystem::path& dst) {
        std::error_code ec;
        if (!std::filesystem::exists(dst, ec) || ec) return false;
        const auto dstTime = std::filesystem::last_write_time(dst, ec);
        if (ec) return false;
        const auto srcTime = std::filesystem::last_write_time(src, ec);
        if (ec) return false;
        return dstTime > srcTime;
    }

    static bool CopySnapshotSidecarFilePreservingStandaloneEdits(const std::wstring& src,
                                                                 const std::wstring& dst) {
        if (src.empty() || dst.empty() || !FileExists(src)) return false;
        const auto srcPath = std::filesystem::path(src);
        const auto dstPath = std::filesystem::path(dst);
        if (ShouldPreserveSnapshotSidecarDestination(srcPath, dstPath)) return true;

        std::error_code ec;
        std::filesystem::create_directories(dstPath.parent_path(), ec);
        if (ec) return false;
        std::filesystem::copy_file(
            srcPath,
            dstPath,
            std::filesystem::copy_options::overwrite_existing,
            ec);
        return !ec;
    }

    static bool CopyInlineDirectoryForSnapshot(const std::wstring& src,
                                               const std::wstring& dst,
                                               bool includeDisabledLayers) {
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
            if (entry.is_directory(ec)) {
                if (ec) return false;
                std::filesystem::create_directories(target, ec);
                if (ec) return false;
                continue;
            }
            if (!entry.is_regular_file(ec)) {
                if (ec) return false;
                continue;
            }
            if (EndsWithInsensitive(entry.path().filename().wstring(), L".js.disabled")) {
                if (!includeDisabledLayers) {
                    // Export folders are reused and may contain standalone edits.
                    // Do not delete stale files here; snapshot replay is gated by
                    // runtimeScene/manifest state instead.
                    continue;
                }
            }
            if (ShouldPreserveSnapshotSidecarDestination(entry.path(), target)) continue;
            std::filesystem::create_directories(target.parent_path(), ec);
            if (ec) return false;
            std::filesystem::copy_file(
                entry.path(),
                target,
                std::filesystem::copy_options::overwrite_existing,
                ec);
            if (ec) return false;
        }
        return true;
    }

    static bool IsDisabledInlineEntryForSnapshot(const std::wstring& entryPath,
                                                 const std::wstring& inlineDir) {
        if (entryPath.empty() || inlineDir.empty()) return false;
        std::wstring normalized = entryPath;
        std::replace(normalized.begin(), normalized.end(), L'\\', L'/');
        while (!normalized.empty() && normalized.front() == L'/') normalized.erase(0, 1);
        const std::wstring prefix = L"inlines/";
        if (normalized.rfind(prefix, 0) != 0) return false;
        const std::wstring rel = normalized.substr(prefix.size());
        if (rel.empty() || !EndsWithInsensitive(rel, L".js")) return false;

        std::wstring relWin = rel;
        std::replace(relWin.begin(), relWin.end(), L'/', L'\\');
        const std::wstring enabledPath = inlineDir + L"\\" + relWin;
        const std::wstring disabledPath = enabledPath + L".disabled";
        return FileExists(disabledPath) && !FileExists(enabledPath);
    }

    static std::wstring FilterProjectManifestForSnapshot(const std::wstring& manifestText,
                                                         const std::wstring& inlineDir) {
        if (manifestText.empty() || inlineDir.empty()) return manifestText;
        const size_t layersKey = manifestText.find(L"\"layers\"");
        if (layersKey == std::wstring::npos) return manifestText;
        const size_t arrayStart = manifestText.find(L'[', layersKey);
        if (arrayStart == std::wstring::npos) return manifestText;
        const size_t arrayEnd = FindJsonArrayEnd(manifestText, arrayStart);
        if (arrayEnd == std::wstring::npos || arrayEnd <= arrayStart + 1) return manifestText;

        std::vector<std::wstring> keptObjects;
        bool changed = false;
        size_t pos = arrayStart + 1;
        while (pos < arrayEnd - 1) {
            const size_t objectStart = manifestText.find(L'{', pos);
            if (objectStart == std::wstring::npos || objectStart >= arrayEnd) break;
            const size_t objectEnd = FindJsonObjectEnd(manifestText, objectStart);
            if (objectEnd == std::wstring::npos || objectEnd > arrayEnd) break;

            std::wstring entry;
            ExtractJsonStringInRange(manifestText, objectStart, objectEnd, L"entry", entry);
            if (IsDisabledInlineEntryForSnapshot(entry, inlineDir)) {
                changed = true;
            } else {
                keptObjects.push_back(manifestText.substr(objectStart, objectEnd - objectStart));
            }
            pos = objectEnd;
        }
        if (!changed) return manifestText;

        std::wostringstream layers;
        layers << L'[';
        for (size_t i = 0; i < keptObjects.size(); ++i) {
            if (i) layers << L',';
            layers << keptObjects[i];
        }
        layers << L']';

        std::wstring filtered = manifestText;
        filtered.replace(arrayStart, arrayEnd - arrayStart, layers.str());
        return filtered;
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

    static void AlignBinaryBuffer(std::string& binary, size_t alignment = 4) {
        if (alignment <= 1) return;
        const size_t pad = (alignment - (binary.size() % alignment)) % alignment;
        if (pad > 0) binary.append(pad, '\0');
    }

    static void AlignBinarySize(size_t& byteSize, size_t alignment = 4) {
        if (alignment <= 1) return;
        const size_t pad = (alignment - (byteSize % alignment)) % alignment;
        byteSize += pad;
    }

    static void ReserveBinaryFloatRange(size_t& byteSize,
                                        const std::vector<float>& values,
                                        size_t& outOffset,
                                        size_t& outCount) {
        AlignBinarySize(byteSize, alignof(float));
        outOffset = byteSize;
        outCount = values.size();
        byteSize += values.size() * sizeof(float);
    }

    static void ReserveBinaryIntRange(size_t& byteSize,
                                      const std::vector<int>& values,
                                      size_t& outOffset,
                                      size_t& outCount) {
        AlignBinarySize(byteSize, alignof(int));
        outOffset = byteSize;
        outCount = values.size();
        byteSize += values.size() * sizeof(int);
    }

    static bool CanPackIndicesU16(const std::vector<int>& values) {
        if (values.empty()) return false;
        for (int value : values) {
            if (value < 0 || value > 65535) return false;
        }
        return true;
    }

    static int RoundedFloatIndexValue(float value) {
        if (!std::isfinite(value)) return 0;
        return static_cast<int>(std::lround(value));
    }

    static std::wstring PackedSkinIndexType(const std::vector<float>& values) {
        if (values.empty()) return {};
        bool fitsU8 = true;
        for (float value : values) {
            const int idx = RoundedFloatIndexValue(value);
            if (idx < 0 || idx > 65535) return {};
            if (idx > 255) fitsU8 = false;
        }
        return fitsU8 ? L"u8" : L"u16";
    }

    static void ReserveBinarySkinWeightRange(size_t& byteSize,
                                             const std::vector<float>& values,
                                             size_t& outOffset,
                                             std::wstring& outType) {
        outType.clear();
        if (values.empty()) {
            AlignBinarySize(byteSize, alignof(float));
            outOffset = byteSize;
            return;
        }
        AlignBinarySize(byteSize, alignof(std::uint16_t));
        outOffset = byteSize;
        byteSize += values.size() * sizeof(std::uint16_t);
        outType = L"u16n";
    }

    static void ReserveBinarySkinIndexRange(size_t& byteSize,
                                            const std::vector<float>& values,
                                            size_t& outOffset,
                                            std::wstring& outType) {
        outType = PackedSkinIndexType(values);
        if (outType == L"u8") {
            outOffset = byteSize;
            byteSize += values.size() * sizeof(std::uint8_t);
            return;
        }
        if (outType == L"u16") {
            AlignBinarySize(byteSize, alignof(std::uint16_t));
            outOffset = byteSize;
            byteSize += values.size() * sizeof(std::uint16_t);
            return;
        }
        AlignBinarySize(byteSize, alignof(float));
        outOffset = byteSize;
        byteSize += values.size() * sizeof(float);
    }

    static bool CanPackAffine12Transforms(const std::vector<float>& values) {
        if (values.empty() || (values.size() % 16u) != 0) return false;
        constexpr float epsilon = 1.0e-6f;
        for (size_t off = 0; off < values.size(); off += 16u) {
            if (std::fabs(values[off + 3]) > epsilon ||
                std::fabs(values[off + 7]) > epsilon ||
                std::fabs(values[off + 11]) > epsilon ||
                std::fabs(values[off + 15] - 1.0f) > epsilon) {
                return false;
            }
        }
        return true;
    }

    static void ReserveBinaryInstanceTransformRange(size_t& byteSize,
                                                    const std::vector<float>& values,
                                                    size_t& outOffset,
                                                    size_t& outCount,
                                                    std::wstring& outType) {
        outType.clear();
        AlignBinarySize(byteSize, alignof(float));
        outOffset = byteSize;
        if (CanPackAffine12Transforms(values)) {
            outCount = (values.size() / 16u) * 12u;
            byteSize += outCount * sizeof(float);
            outType = L"affine12";
            return;
        }
        outCount = values.size();
        byteSize += values.size() * sizeof(float);
        outType = L"f32m16";
    }

    static bool CanPackNormalsI16N(const std::vector<float>& values) {
        if (values.empty() || (values.size() % 3u) != 0) return false;
        for (float value : values) {
            if (!std::isfinite(value) || value < -1.0001f || value > 1.0001f) {
                return false;
            }
        }
        return true;
    }

    static bool CanPackUvsU16N(const std::vector<float>& values) {
        if (values.empty() || (values.size() % 2u) != 0) return false;
        for (float value : values) {
            if (!std::isfinite(value) || value < -0.00001f || value > 1.00001f) {
                return false;
            }
        }
        return true;
    }

    static void ReserveBinaryUvRange(size_t& byteSize,
                                     const std::vector<float>& values,
                                     size_t& outOffset,
                                     size_t& outCount,
                                     std::wstring& outType) {
        outType.clear();
        if (CanPackUvsU16N(values)) {
            AlignBinarySize(byteSize, alignof(std::uint16_t));
            outOffset = byteSize;
            outCount = values.size();
            byteSize += values.size() * sizeof(std::uint16_t);
            outType = L"u16n";
            return;
        }
        ReserveBinaryFloatRange(byteSize, values, outOffset, outCount);
    }

    static void ReserveBinaryNormalRange(size_t& byteSize,
                                         const std::vector<float>& values,
                                         size_t& outOffset,
                                         size_t& outCount,
                                         std::wstring& outType) {
        outType.clear();
        if (CanPackNormalsI16N(values)) {
            AlignBinarySize(byteSize, alignof(std::int16_t));
            outOffset = byteSize;
            outCount = values.size();
            byteSize += values.size() * sizeof(std::int16_t);
            outType = L"i16n";
            return;
        }
        ReserveBinaryFloatRange(byteSize, values, outOffset, outCount);
    }

    static void ReserveBinaryIndexRange(size_t& byteSize,
                                        const std::vector<int>& values,
                                        size_t& outOffset,
                                        size_t& outCount,
                                        std::wstring& outType) {
        outType.clear();
        if (CanPackIndicesU16(values)) {
            AlignBinarySize(byteSize, alignof(std::uint16_t));
            outOffset = byteSize;
            outCount = values.size();
            byteSize += values.size() * sizeof(std::uint16_t);
            outType = L"u16";
            return;
        }
        ReserveBinaryIntRange(byteSize, values, outOffset, outCount);
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
        AlignBinaryBuffer(outBinary, alignof(float));
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
        AlignBinaryBuffer(outBinary, alignof(int));
        outOffset = outBinary.size();
        outCount = values.size();
        if (values.empty()) return;
        outBinary.append(
            reinterpret_cast<const char*>(values.data()),
            values.size() * sizeof(int));
    }

    static void AppendBinaryIndices(std::string& outBinary,
                                    const std::vector<int>& values,
                                    size_t& outOffset,
                                    size_t& outCount,
                                    std::wstring& outType) {
        outType.clear();
        if (CanPackIndicesU16(values)) {
            AlignBinaryBuffer(outBinary, alignof(std::uint16_t));
            outOffset = outBinary.size();
            outCount = values.size();
            outType = L"u16";
            if (values.empty()) return;
            std::vector<std::uint16_t> packed;
            packed.reserve(values.size());
            for (int value : values) packed.push_back(static_cast<std::uint16_t>(value));
            outBinary.append(
                reinterpret_cast<const char*>(packed.data()),
                packed.size() * sizeof(std::uint16_t));
            return;
        }
        AppendBinaryInts(outBinary, values, outOffset, outCount);
    }

    static void CopyBinaryIndices(BYTE* buffer,
                                  size_t offset,
                                  const std::vector<int>& values,
                                  const std::wstring& type) {
        if (!buffer || values.empty()) return;
        if (type == L"u16") {
            auto* dst = reinterpret_cast<std::uint16_t*>(buffer + offset);
            for (size_t i = 0; i < values.size(); ++i) {
                dst[i] = static_cast<std::uint16_t>(values[i]);
            }
            return;
        }
        memcpy(buffer + offset, values.data(), values.size() * sizeof(int));
    }

    static void CopyBinarySkinWeights(BYTE* buffer,
                                      size_t offset,
                                      const std::vector<float>& values,
                                      const std::wstring& type) {
        if (!buffer || values.empty()) return;
        if (type == L"u16n") {
            auto* dst = reinterpret_cast<std::uint16_t*>(buffer + offset);
            for (size_t base = 0; base < values.size(); base += 4) {
                int q[4] = {0, 0, 0, 0};
                float maxWeight = -1.0f;
                int maxIndex = 0;
                int sum = 0;
                const size_t laneCount = std::min<size_t>(4, values.size() - base);
                for (size_t lane = 0; lane < laneCount; ++lane) {
                    const float w = std::clamp(values[base + lane], 0.0f, 1.0f);
                    q[lane] = static_cast<int>(std::lround(w * 65535.0f));
                    sum += q[lane];
                    if (w > maxWeight) {
                        maxWeight = w;
                        maxIndex = static_cast<int>(lane);
                    }
                }
                if (sum > 0) {
                    q[maxIndex] = std::clamp(q[maxIndex] + (65535 - sum), 0, 65535);
                }
                for (size_t lane = 0; lane < laneCount; ++lane) {
                    dst[base + lane] = static_cast<std::uint16_t>(q[lane]);
                }
            }
            return;
        }
        memcpy(buffer + offset, values.data(), values.size() * sizeof(float));
    }

    static void CopyBinarySkinIndices(BYTE* buffer,
                                      size_t offset,
                                      const std::vector<float>& values,
                                      const std::wstring& type) {
        if (!buffer || values.empty()) return;
        if (type == L"u8") {
            auto* dst = reinterpret_cast<std::uint8_t*>(buffer + offset);
            for (size_t i = 0; i < values.size(); ++i) {
                dst[i] = static_cast<std::uint8_t>(
                    std::clamp(RoundedFloatIndexValue(values[i]), 0, 255));
            }
            return;
        }
        if (type == L"u16") {
            auto* dst = reinterpret_cast<std::uint16_t*>(buffer + offset);
            for (size_t i = 0; i < values.size(); ++i) {
                dst[i] = static_cast<std::uint16_t>(
                    std::clamp(RoundedFloatIndexValue(values[i]), 0, 65535));
            }
            return;
        }
        memcpy(buffer + offset, values.data(), values.size() * sizeof(float));
    }

    static void CopyBinaryInstanceTransforms(BYTE* buffer,
                                             size_t offset,
                                             const std::vector<float>& values,
                                             const std::wstring& type) {
        if (!buffer || values.empty()) return;
        if (type == L"affine12") {
            auto* dst = reinterpret_cast<float*>(buffer + offset);
            size_t di = 0;
            for (size_t si = 0; si + 15 < values.size(); si += 16u) {
                dst[di++] = values[si + 0];
                dst[di++] = values[si + 1];
                dst[di++] = values[si + 2];
                dst[di++] = values[si + 4];
                dst[di++] = values[si + 5];
                dst[di++] = values[si + 6];
                dst[di++] = values[si + 8];
                dst[di++] = values[si + 9];
                dst[di++] = values[si + 10];
                dst[di++] = values[si + 12];
                dst[di++] = values[si + 13];
                dst[di++] = values[si + 14];
            }
            return;
        }
        memcpy(buffer + offset, values.data(), values.size() * sizeof(float));
    }

    static void CopyBinaryNormals(BYTE* buffer,
                                  size_t offset,
                                  const std::vector<float>& values,
                                  const std::wstring& type) {
        if (!buffer || values.empty()) return;
        if (type == L"i16n") {
            auto* dst = reinterpret_cast<std::int16_t*>(buffer + offset);
            for (size_t i = 0; i < values.size(); ++i) {
                const float n = std::clamp(values[i], -1.0f, 1.0f);
                dst[i] = static_cast<std::int16_t>(
                    std::clamp(static_cast<int>(std::lround(n * 32767.0f)), -32767, 32767));
            }
            return;
        }
        memcpy(buffer + offset, values.data(), values.size() * sizeof(float));
    }

    static void CopyBinaryUvs(BYTE* buffer,
                              size_t offset,
                              const std::vector<float>& values,
                              const std::wstring& type) {
        if (!buffer || values.empty()) return;
        if (type == L"u16n") {
            auto* dst = reinterpret_cast<std::uint16_t*>(buffer + offset);
            for (size_t i = 0; i < values.size(); ++i) {
                const float uv = std::clamp(values[i], 0.0f, 1.0f);
                dst[i] = static_cast<std::uint16_t>(
                    std::clamp(static_cast<int>(std::lround(uv * 65535.0f)), 0, 65535));
            }
            return;
        }
        memcpy(buffer + offset, values.data(), values.size() * sizeof(float));
    }

    static void AppendBinaryUvs(std::string& outBinary,
                                const std::vector<float>& values,
                                size_t& outOffset,
                                size_t& outCount,
                                std::wstring& outType) {
        outType.clear();
        if (CanPackUvsU16N(values)) {
            AlignBinaryBuffer(outBinary, alignof(std::uint16_t));
            outOffset = outBinary.size();
            outCount = values.size();
            outType = L"u16n";
            if (values.empty()) return;
            std::vector<std::uint16_t> packed;
            packed.reserve(values.size());
            for (float value : values) {
                const float uv = std::clamp(value, 0.0f, 1.0f);
                packed.push_back(static_cast<std::uint16_t>(
                    std::clamp(static_cast<int>(std::lround(uv * 65535.0f)), 0, 65535)));
            }
            outBinary.append(
                reinterpret_cast<const char*>(packed.data()),
                packed.size() * sizeof(std::uint16_t));
            return;
        }
        AppendBinaryFloats(outBinary, values, outOffset, outCount);
    }

    static void AppendBinaryNormals(std::string& outBinary,
                                    const std::vector<float>& values,
                                    size_t& outOffset,
                                    size_t& outCount,
                                    std::wstring& outType) {
        outType.clear();
        if (CanPackNormalsI16N(values)) {
            AlignBinaryBuffer(outBinary, alignof(std::int16_t));
            outOffset = outBinary.size();
            outCount = values.size();
            outType = L"i16n";
            if (values.empty()) return;
            std::vector<std::int16_t> packed;
            packed.reserve(values.size());
            for (float value : values) {
                const float n = std::clamp(value, -1.0f, 1.0f);
                packed.push_back(static_cast<std::int16_t>(
                    std::clamp(static_cast<int>(std::lround(n * 32767.0f)), -32767, 32767)));
            }
            outBinary.append(
                reinterpret_cast<const char*>(packed.data()),
                packed.size() * sizeof(std::int16_t));
            return;
        }
        AppendBinaryFloats(outBinary, values, outOffset, outCount);
    }

    static void AppendBinaryBytes(std::string& outBinary,
                                  const std::vector<unsigned char>& values,
                                  size_t& outOffset,
                                  size_t& outCount) {
        outOffset = outBinary.size();
        outCount = values.size();
        if (values.empty()) return;
        outBinary.append(
            reinterpret_cast<const char*>(values.data()),
            values.size() * sizeof(unsigned char));
    }

    static std::string MakeRawBinaryKey(const void* data, size_t byteCount) {
        if (!data || byteCount == 0) return {};
        return std::string(reinterpret_cast<const char*>(data), byteCount);
    }

#include "maxjs_panel_snapshot_export.inl"


#include "maxjs_panel_project.inl"

#include "maxjs_panel_sync_entry.inl"

#include "maxjs_panel_sync.inl"

#include "maxjs_panel_fullsync.inl"

#include "maxjs_panel_render_window.inl"

};

#include "maxjs_panel_callbacks.inl"

#include "maxjs_panel_bridge.inl"

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
