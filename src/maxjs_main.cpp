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
#include "threejs_material.h"
#include "threejs_lights.h"
#include "threejs_splat.h"
#include "maxjs_geometry_sync.h"
#include "maxjs_material_sync.h"
#include "maxjs_scene_extractors.h"
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
#define SETUP_TIMER_ID            2
#define AS_TIMER_ID               3
#define AS_INTERVAL_MS            66   // ~15fps ActiveShade

extern HINSTANCE hInstance;
HINSTANCE hInstance = nullptr;

class MaxJSPanel;
static MaxJSPanel* g_panel = nullptr;
void MaxJSNotifyMaterialEdited(ReferenceTarget* target = nullptr);
static HWND g_helperHwnd = nullptr;
static int g_pathTracingSamplesPerFrame = 1;
static float g_pathTracingGIClamp = 20.0f;
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
                           std::wstring& error,
                           const std::wstring& directoryExtensionFilter = {}) {
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

    void DeleteSnapshotGeneratedAssets(const std::wstring& exportDir) {
        const std::filesystem::path assetsDir = std::filesystem::path(exportDir) / L"assets";
        std::error_code ec;
        if (!std::filesystem::exists(assetsDir, ec) || ec) return;

        for (const auto& entry : std::filesystem::directory_iterator(assetsDir, ec)) {
            if (ec) return;
            const std::wstring name = entry.path().filename().wstring();
            if (name.rfind(L"file_", 0) != 0 && name.rfind(L"dir_", 0) != 0) continue;
            std::filesystem::remove_all(entry.path(), ec);
            ec.clear();
        }
    }

    struct SnapshotNodeRecord {
        ULONG handle = 0;
        INode* node = nullptr;
        bool visible = true;
        bool spline = false;
        std::vector<float> verts, uvs, uv2s, norms;
        std::vector<VertexColorAttributeRecord> vertexColors;
        std::vector<int> indices;
        std::vector<MatGroup> groups;
        size_t vOff = 0, iOff = 0, uvOff = 0, uv2Off = 0, nOff = 0;
        // Skeletal skin + optional Morpher. Morpher is exported only when it
        // evaluates before Skin, as static deltas + animated channel weights.
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

    struct SnapshotAnimationBinaryStats {
        size_t trackCount = 0;
        size_t timeTrackCount = 0;
        size_t valueTrackCount = 0;
        size_t boolTrackCount = 0;
        size_t reusedTimeTrackCount = 0;
    };

    static std::string MakeFloatVectorBinaryKey(const std::vector<float>& values) {
        if (values.empty()) return {};
        return std::string(
            reinterpret_cast<const char*>(values.data()),
            values.size() * sizeof(float));
    }

    static SnapshotAnimationTrackDef::BinaryRef AppendTrackFloatBuffer(
        std::string& binary,
        const std::vector<float>& values) {
        SnapshotAnimationTrackDef::BinaryRef ref;
        if (values.empty()) return ref;
        AppendBinaryFloats(binary, values, ref.off, ref.n);
        ref.type = L"f32";
        ref.valid = true;
        return ref;
    }

    static SnapshotAnimationTrackDef::BinaryRef AppendTrackByteBuffer(
        std::string& binary,
        const std::vector<unsigned char>& values) {
        SnapshotAnimationTrackDef::BinaryRef ref;
        if (values.empty()) return ref;
        AppendBinaryBytes(binary, values, ref.off, ref.n);
        ref.type = L"u8";
        ref.valid = true;
        return ref;
    }

    static SnapshotAnimationBinaryStats PrepareSnapshotAnimationBinaryTracks(
        std::vector<SnapshotAnimationTargetDef>& targets,
        std::string& binary) {
        SnapshotAnimationBinaryStats stats;
        std::unordered_map<std::string, SnapshotAnimationTrackDef::BinaryRef> timeRefCache;

        for (SnapshotAnimationTargetDef& target : targets) {
            for (SnapshotAnimationTrackDef& track : target.tracks) {
                stats.trackCount += 1;

                if (!track.times.empty()) {
                    const std::string key = MakeFloatVectorBinaryKey(track.times);
                    auto cached = timeRefCache.find(key);
                    if (cached != timeRefCache.end()) {
                        track.timesRef = cached->second;
                        stats.reusedTimeTrackCount += 1;
                    } else {
                        track.timesRef = AppendTrackFloatBuffer(binary, track.times);
                        if (track.timesRef.valid) {
                            timeRefCache.emplace(key, track.timesRef);
                            stats.timeTrackCount += 1;
                        }
                    }
                }

                if (track.isGeometryFrames) {
                    continue;
                }

                if (track.isBoolean) {
                    track.valuesRef = AppendTrackByteBuffer(binary, track.boolValues);
                    if (track.valuesRef.valid) {
                        stats.valueTrackCount += 1;
                        stats.boolTrackCount += 1;
                    }
                } else {
                    track.valuesRef = AppendTrackFloatBuffer(binary, track.values);
                    if (track.valuesRef.valid) {
                        stats.valueTrackCount += 1;
                    }
                }
            }
        }

        return stats;
    }

    static void WriteSnapshotAnimationBinaryRefJson(
        std::wostringstream& ss,
        const SnapshotAnimationTrackDef::BinaryRef& ref) {
        ss << L"{\"off\":" << ref.off
           << L",\"n\":" << ref.n
           << L",\"type\":\"" << EscapeJson(ref.type.c_str()) << L"\"}";
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
        if (track.timesRef.valid) {
            ss << L",\"timesRef\":";
            WriteSnapshotAnimationBinaryRefJson(ss, track.timesRef);
        } else {
            ss << L",\"times\":";
            WriteFloats(ss, track.times.data(), track.times.size());
        }
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
            if (track.valuesRef.valid) {
                ss << L",\"valuesRef\":";
                WriteSnapshotAnimationBinaryRefJson(ss, track.valuesRef);
            } else if (track.isBoolean) {
                ss << L",\"values\":";
                ss << L'[';
                for (size_t i = 0; i < track.boolValues.size(); ++i) {
                    if (i) ss << L',';
                    ss << (track.boolValues[i] ? L"true" : L"false");
                }
                ss << L']';
            } else {
                ss << L",\"values\":";
                WriteFloats(ss, track.values.data(), track.values.size());
            }
        }
        ss << L'}';
    }

    static bool AppendMorpherChannelTimeSamples(IMorpherChannel* channel,
                                                const Interval& range,
                                                std::vector<TimeValue>& outTimes) {
        if (!channel) return false;
        bool hasAuthoredKeys = false;
        Tab<long> keyTimes;
        Tab<float> keyValues;
        if (channel->GetAnimationKeysData(keyTimes, keyValues)) {
            for (int i = 0; i < keyTimes.Count(); ++i) {
                const TimeValue tv = static_cast<TimeValue>(keyTimes[i]);
                if (tv >= range.Start() && tv <= range.End()) {
                    AppendUniqueTimeValue(outTimes, tv);
                    hasAuthoredKeys = true;
                }
            }
        }

        if (Control* control = channel->GetControl()) {
            std::vector<TimeValue> controllerTimes;
            std::unordered_set<const Animatable*> visited;
            CollectAnimatableKeyTimesRecursive(control, range, controllerTimes, visited);
            for (TimeValue tv : controllerTimes) {
                AppendUniqueTimeValue(outTimes, tv);
                hasAuthoredKeys = true;
            }
        }
        if (!hasAuthoredKeys) return false;

        AppendUniqueTimeValue(outTimes, range.Start());
        AppendUniqueTimeValue(outTimes, range.End());
        SortUniqueTimeValues(outTimes);
        return outTimes.size() >= 2;
    }

    static bool BuildMorpherInfluenceAnimationTracks(Interface* ip,
                                                     INode* meshNode,
                                                     const Interval& range,
                                                     TimeValue currentTime,
                                                     const SnapshotExportOptions& options,
                                                     const std::vector<int>& morphChannelIds,
                                                     SnapshotAnimationTargetDef& outTarget) {
        (void)options;
        (void)currentTime;
        if (!ip || !meshNode || morphChannelIds.empty()) return false;

        ModifierStackMatch skinMatch;
        ModifierStackMatch morphMatch;
        if (!FindModifierStackMatchOnNode(meshNode, SKIN_CLASSID, skinMatch) ||
            !FindModifierStackMatchOnNode(meshNode, MR3_CLASS_ID, morphMatch) ||
            !morphMatch.mod ||
            !morphMatch.mod->IsEnabled() ||
            !ModifierEvaluatesBefore(morphMatch, skinMatch)) {
            return false;
        }

        Modifier* morphMod = morphMatch.mod;
        IMorpher* morpher = static_cast<IMorpher*>(morphMod->GetInterface(I_MORPHER_INTERFACE_ID));
        if (!morpher) return false;

        bool anyTrack = false;

        for (size_t mi = 0; mi < morphChannelIds.size(); ++mi) {
            const int cid = morphChannelIds[mi];
            IMorpherChannel* ch = morpher->GetChannel(cid, false);
            if (!ch || !ch->IsActive()) continue;

            std::vector<TimeValue> sampleTimes;
            if (!AppendMorpherChannelTimeSamples(ch, range, sampleTimes)) continue;

            SnapshotAnimationTrackDef tr;
            tr.path = L".morphTargetInfluences[" + std::to_wstring(mi) + L"]";
            tr.type = L"number";
            tr.interpolation = L"linear";

            std::vector<float> vals;
            vals.reserve(sampleTimes.size());
            for (TimeValue tv : sampleTimes) {
                vals.push_back(ReadMorpherChannelInfluence(ch, tv));
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

        return anyTrack;
    }

    static bool WriteSnapshotAnimationsJson(std::wostringstream& ss,
                                            const std::vector<SnapshotNodeRecord>& nodes,
                                            Interface* ip,
                                            TimeValue currentTime,
                                            const SnapshotExportOptions& options,
                                            std::string& outAnimBinary,
                                            const std::unordered_set<ULONG>& skinRigMeshHandles,
                                            ULONG lockedCameraHandle) {
        if (!ip) return false;

        const Interval range = ip->GetAnimRange();
        if (range.End() <= range.Start()) {
            return false;
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
            return false;
        }

        const SnapshotAnimationBinaryStats binaryStats =
            PrepareSnapshotAnimationBinaryTracks(targets, outAnimBinary);

        const float duration = TimeValueToAnimationSeconds(range.End(), range.Start());
        const TimeValue clampedTime = std::clamp(currentTime, range.Start(), range.End());
        const float currentSeconds = TimeValueToAnimationSeconds(clampedTime, range.Start());

        ss << L",\"animations\":{";
        ss << L"\"version\":2,";
        if (!outAnimBinary.empty()) {
            ss << L"\"bin\":\"scene_anim.bin\",";
            ss << L"\"binary\":{";
            ss << L"\"version\":1";
            ss << L",\"layout\":\"maxjs_track_refs\"";
            ss << L",\"endianness\":\"little\"";
            ss << L",\"bytes\":" << outAnimBinary.size();
            ss << L",\"tracks\":" << binaryStats.trackCount;
            ss << L",\"timeBuffers\":" << binaryStats.timeTrackCount;
            ss << L",\"valueBuffers\":" << binaryStats.valueTrackCount;
            ss << L",\"u8Buffers\":" << binaryStats.boolTrackCount;
            ss << L",\"reusedTimeRefs\":" << binaryStats.reusedTimeTrackCount;
            ss << L"},";
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
        return true;
    }

    bool CopySnapshotRuntimeSeed(const std::wstring& webDir,
                                 const std::wstring& outDir,
                                 bool copySparkDist,
                                 std::wstring& error) {
        const std::wstring snapshotHtml = webDir + L"\\snapshot.html";
        if (!FileExists(snapshotHtml)) {
            error = L"Snapshot runtime dependency missing: web/snapshot.html";
            return false;
        }

        if (!CopyFileEnsuringDirectories(snapshotHtml, outDir + L"\\snapshot.html")) {
            error = L"Failed to copy snapshot runtime snapshot.html";
            return false;
        }

        // Seed index.html only once. After that the snapshot exporter owns
        // scene data, not the standalone site's shell/UI.
        if (!CopyFileIfMissingEnsuringDirectories(snapshotHtml, outDir + L"\\index.html")) {
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

    struct MaterialLibraryEntry {
        int id = 0;
        uint64_t hash = 0;
        std::wstring json;
    };

    struct MaterialLibraryBuilder {
        int nextId = 1;
        std::unordered_map<std::wstring, int> keyToId;
        std::vector<MaterialLibraryEntry> entries;
    };

    struct SnapshotRuntimeFeatures {
        bool audio = false;
        bool splats = false;
        bool htmlTextures = false;
        bool volumes = false;
        bool physics = false;
        bool gltfs = false;
        bool animations = false;
        bool runtimeScene = false;
        bool projectManifest = false;
        bool inlineLayers = false;
        bool snapshotUi = false;
        bool environment = false;
        bool hdri = false;
        bool sky = false;
        bool binaryInstances = false;
        std::wstring rendererPref = L"webgl";
        std::vector<std::wstring> postFx;
        std::vector<std::wstring> threeAddons;
        int meshNodes = 0;
        int materialCount = 0;
        int skinnedMeshes = 0;
        int morphTargets = 0;
        int vertexColorAttrs = 0;
        int lights = 0;
        int instanceGroups = 0;
    };

    std::wstring SerializeMaterialJson(const MaxJSPBR& pbr) {
        std::wostringstream mat;
        mat.imbue(std::locale::classic());
        WriteMaterialFull(mat, pbr);
        return mat.str();
    }

    int InternMaterial(MaterialLibraryBuilder& library, const MaxJSPBR& pbr) {
        MaxJSPBR keyPbr = pbr;
        keyPbr.mtlName.clear();
        const std::wstring key = SerializeMaterialJson(keyPbr);
        auto found = library.keyToId.find(key);
        if (found != library.keyToId.end()) return found->second;

        MaterialLibraryEntry entry;
        entry.id = library.nextId++;
        entry.json = SerializeMaterialJson(pbr);
        entry.hash = HashFNV1a(key.data(), key.size() * sizeof(wchar_t));
        library.keyToId.emplace(key, entry.id);
        library.entries.push_back(std::move(entry));
        return library.entries.back().id;
    }

    void WriteMaterialLibraryJson(std::wostringstream& ss, const MaterialLibraryBuilder& library) {
        ss << L"\"materials\":[";
        for (size_t i = 0; i < library.entries.size(); ++i) {
            const MaterialLibraryEntry& entry = library.entries[i];
            if (i) ss << L',';
            ss << L"{\"id\":" << entry.id;
            ss << L",\"hash\":" << entry.hash;
            ss << L",\"mat\":" << entry.json;
            ss << L'}';
        }
        ss << L']';
    }

    static void AddUniqueRuntimeFeature(std::vector<std::wstring>& values, const wchar_t* value) {
        if (!value || !*value) return;
        const std::wstring v(value);
        if (std::find(values.begin(), values.end(), v) == values.end()) {
            values.push_back(v);
        }
    }

    static std::wstring LowerAsciiCopy(std::wstring value) {
        std::transform(value.begin(), value.end(), value.begin(), [](wchar_t ch) {
            return static_cast<wchar_t>(std::towlower(ch));
        });
        return value;
    }

    static bool JsonObjectHasEnabledTrue(const std::wstring& json, const wchar_t* key) {
        if (json.empty() || !key || !*key) return false;
        const std::wstring needle = L"\"" + std::wstring(key) + L"\"";
        const size_t pos = json.find(needle);
        if (pos == std::wstring::npos) return false;
        const size_t len = std::min<size_t>(json.size() - pos, 768);
        const std::wstring slice = json.substr(pos, len);
        return slice.find(L"\"enabled\":true") != std::wstring::npos ||
               slice.find(L"\"enabled\": true") != std::wstring::npos;
    }

    static std::wstring DetectRendererPrefFromSnapshotUi(const std::wstring& snapshotUiJson) {
        const std::wstring lower = LowerAsciiCopy(snapshotUiJson);
        if (lower.find(L"\"snapshotrendererbackend\":\"webgpu") != std::wstring::npos ||
            lower.find(L"\"snapshotrendererbackend\": \"webgpu") != std::wstring::npos ||
            lower.find(L"\"snapshot_backend\":\"webgpu") != std::wstring::npos ||
            lower.find(L"\"snapshot_backend\": \"webgpu") != std::wstring::npos) {
            return L"webgpu";
        }
        return L"webgl";
    }

    struct BeautyBakeExportState {
        bool active = false;
        std::wstring match = L"scene";
        std::wstring folderPath;
        std::wstring sceneName = L"scene";
        std::wstring suffix = L"_beauty";
        std::wstring extension = L"png";
    };

    static bool JsonRangeHasLiteral(const std::wstring& json,
                                    size_t start,
                                    size_t end,
                                    const std::wstring& literal) {
        if (start == std::wstring::npos || end == std::wstring::npos || start >= end) return false;
        const std::wstring lower = LowerAsciiCopy(json.substr(start, end - start));
        return lower.find(LowerAsciiCopy(literal)) != std::wstring::npos;
    }

    static std::wstring TrimBakeFolderPath(std::wstring path) {
        std::replace(path.begin(), path.end(), L'/', L'\\');
        while (!path.empty() && (path.back() == L'\\' || path.back() == L'/')) {
            path.pop_back();
        }
        return path;
    }

    static std::wstring SanitizeBakeFileStemCpp(const std::wstring& value) {
        std::wstring result;
        result.reserve(value.size());
        bool pendingUnderscore = false;
        auto flushUnderscore = [&]() {
            if (!result.empty() && result.back() != L'_') result.push_back(L'_');
        };
        for (wchar_t ch : value) {
            const bool invalid =
                ch == L'\\' || ch == L'/' || ch == L':' || ch == L'*' ||
                ch == L'?' || ch == L'"' || ch == L'<' || ch == L'>' || ch == L'|';
            if (invalid || std::iswspace(ch)) {
                pendingUnderscore = true;
                continue;
            }
            if (pendingUnderscore) {
                flushUnderscore();
                pendingUnderscore = false;
            }
            result.push_back(ch);
        }
        while (!result.empty() && result.front() == L'_') result.erase(result.begin());
        while (!result.empty() && result.back() == L'_') result.pop_back();
        return result.empty() ? L"scene" : result;
    }

    static bool IsBakeUvTokenBoundary(wchar_t ch) {
        return ch == L'_' || ch == L'.' || ch == L'-' || std::iswspace(ch) != 0;
    }

    static int BakeUvChannelFromMapName(const std::wstring& filename) {
        std::wstring base = filename;
        const size_t slash = base.find_last_of(L"/\\");
        if (slash != std::wstring::npos) base = base.substr(slash + 1);
        const size_t dot = base.find_last_of(L'.');
        if (dot != std::wstring::npos) base = base.substr(0, dot);
        base = LowerAsciiCopy(base);

        for (size_t pos = 0; pos + 2 < base.size(); ++pos) {
            if (base[pos] != L'u' || base[pos + 1] != L'v') continue;
            const wchar_t channel = base[pos + 2];
            if (channel != L'1' && channel != L'2') continue;
            const bool beforeOk = pos == 0 || IsBakeUvTokenBoundary(base[pos - 1]);
            const bool afterOk = pos + 3 >= base.size() || IsBakeUvTokenBoundary(base[pos + 3]);
            if (beforeOk && afterOk) return channel == L'1' ? 1 : 2;
        }
        return 0;
    }

    static std::vector<std::wstring> BuildBakeFilenameCandidatesCpp(const std::wstring& stem,
                                                                    const std::wstring& suffix,
                                                                    const std::wstring& extension) {
        std::vector<std::wstring> names;
        auto add = [&](const std::wstring& name) {
            if (std::find(names.begin(), names.end(), name) == names.end()) names.push_back(name);
        };
        const std::wstring ext = extension.empty() || extension.front() != L'.'
            ? L"." + extension
            : extension;
        const std::wstring exact = stem + suffix + ext;
        if (BakeUvChannelFromMapName(exact) != 0) {
            add(exact);
        } else {
            add(stem + L"_UV2" + ext);
            add(stem + L"_UV1" + ext);
            add(exact);
            if (!suffix.empty()) add(stem + ext);
        }
        return names;
    }

    BeautyBakeExportState DetectBeautyBakeExportState(const std::wstring& snapshotUiJson) {
        BeautyBakeExportState state;
        const size_t bakeKey = snapshotUiJson.find(L"\"bake\":{");
        if (bakeKey == std::wstring::npos) return state;
        const size_t bakeObj = snapshotUiJson.find(L'{', bakeKey);
        const size_t bakeEnd = FindJsonObjectEnd(snapshotUiJson, bakeObj);
        if (bakeEnd == std::wstring::npos) return state;

        const bool enabled =
            JsonRangeHasLiteral(snapshotUiJson, bakeObj, bakeEnd, L"\"enabled\":true") ||
            JsonRangeHasLiteral(snapshotUiJson, bakeObj, bakeEnd, L"\"enabled\": true");
        const bool beauty =
            JsonRangeHasLiteral(snapshotUiJson, bakeObj, bakeEnd, L"\"mode\":\"beauty\"") ||
            JsonRangeHasLiteral(snapshotUiJson, bakeObj, bakeEnd, L"\"mode\": \"beauty\"");
        if (!enabled || !beauty) return state;

        state.active = true;
        ExtractJsonStringInRange(snapshotUiJson, bakeObj, bakeEnd, L"match", state.match);
        ExtractJsonStringInRange(snapshotUiJson, bakeObj, bakeEnd, L"sceneName", state.sceneName);
        ExtractJsonStringInRange(snapshotUiJson, bakeObj, bakeEnd, L"beautySuffix", state.suffix);
        ExtractJsonStringInRange(snapshotUiJson, bakeObj, bakeEnd, L"extension", state.extension);
        state.match = LowerAsciiCopy(state.match);
        if (state.match != L"object" && state.match != L"material") state.match = L"scene";
        if (state.sceneName.empty()) state.sceneName = L"scene";
        if (state.extension.empty()) state.extension = L"png";
        if (!state.extension.empty() && state.extension.front() == L'.') state.extension.erase(state.extension.begin());

        std::wstring folderUrl;
        if (ExtractJsonStringInRange(snapshotUiJson, bakeObj, bakeEnd, L"folder", folderUrl) && !folderUrl.empty()) {
            std::wstring localPath;
            if (ResolveVirtualHostUrl(folderUrl, localPath)) {
                state.folderPath = TrimBakeFolderPath(localPath);
            } else if (folderUrl.size() >= 3 && folderUrl[1] == L':' &&
                       (folderUrl[2] == L'\\' || folderUrl[2] == L'/')) {
                state.folderPath = TrimBakeFolderPath(folderUrl);
            }
        }
        return state;
    }

    static void AddBeautyBakeTargetStem(std::vector<std::wstring>& stems,
                                        const std::wstring& value) {
        const std::wstring stem = SanitizeBakeFileStemCpp(value);
        if (std::find(stems.begin(), stems.end(), stem) == stems.end()) stems.push_back(stem);
    }

    static std::vector<std::wstring> GetBeautyBakeTargetStems(INode* node,
                                                             const SnapshotNodeRecord& snapshotNode,
                                                             const BeautyBakeExportState& state) {
        std::vector<std::wstring> stems;
        if (state.match == L"object") {
            AddBeautyBakeTargetStem(stems, node ? std::wstring(node->GetName()) : L"node");
        } else if (state.match == L"material") {
            Mtl* mtl = node ? node->GetMtl() : nullptr;
            Mtl* multiMtl = FindMultiSubMtl(mtl);
            if (multiMtl && multiMtl->NumSubMtls() > 0 && snapshotNode.groups.size() > 1) {
                for (const MatGroup& group : snapshotNode.groups) {
                    Mtl* subMtl = GetSubMtlFromMatID(multiMtl, group.matID);
                    if (!subMtl) continue;
                    MSTR name = subMtl->GetName();
                    AddBeautyBakeTargetStem(stems, name.data());
                }
            }
            if (stems.empty() && mtl) {
                MSTR name = mtl->GetName();
                AddBeautyBakeTargetStem(stems, name.data());
            }
            if (stems.empty()) AddBeautyBakeTargetStem(stems, L"material");
        } else {
            AddBeautyBakeTargetStem(stems, state.sceneName);
        }
        return stems;
    }

    static std::vector<std::wstring> GetBeautyBakeTargetStems(const ForestInstanceGroup& group,
                                                             const BeautyBakeExportState& state) {
        std::vector<std::wstring> stems;
        if (state.match == L"object") {
            AddBeautyBakeTargetStem(
                stems,
                group.mtlNode ? std::wstring(group.mtlNode->GetName()) : L"instance");
        } else if (state.match == L"material") {
            Mtl* multiMtl = FindMultiSubMtl(group.mtl);
            if (multiMtl && multiMtl->NumSubMtls() > 0 && group.groups.size() > 1) {
                for (const MatGroup& matGroup : group.groups) {
                    Mtl* subMtl = GetSubMtlFromMatID(multiMtl, matGroup.matID);
                    if (!subMtl) continue;
                    MSTR name = subMtl->GetName();
                    AddBeautyBakeTargetStem(stems, name.data());
                }
            }
            if (stems.empty() && group.mtl) {
                MSTR name = group.mtl->GetName();
                AddBeautyBakeTargetStem(stems, name.data());
            }
            if (stems.empty()) AddBeautyBakeTargetStem(stems, L"material");
        } else {
            AddBeautyBakeTargetStem(stems, state.sceneName);
        }
        return stems;
    }

    static int ResolveBeautyBakeStemUvChannel(const BeautyBakeExportState& state,
                                              const std::wstring& stem) {
        const std::vector<std::wstring> candidates =
            BuildBakeFilenameCandidatesCpp(stem, state.suffix, state.extension);
        if (!state.folderPath.empty() && !DirectoryExists(state.folderPath)) return 0;
        const bool hasResolvableFolder = !state.folderPath.empty();
        for (const std::wstring& filename : candidates) {
            const int channel = BakeUvChannelFromMapName(filename);
            if (hasResolvableFolder) {
                const std::filesystem::path path =
                    std::filesystem::path(state.folderPath) / std::filesystem::path(filename);
                if (FileExists(path.wstring())) return channel != 0 ? channel : 2;
                continue;
            }
            if (channel != 0) return channel;
        }
        if (hasResolvableFolder) return 0;
        return 2;
    }

    static int RequiredBeautyBakeUvMask(INode* node,
                                        const SnapshotNodeRecord& snapshotNode,
                                        const BeautyBakeExportState& state) {
        if (!state.active) return 0;
        int mask = 0;
        for (const std::wstring& stem : GetBeautyBakeTargetStems(node, snapshotNode, state)) {
            const int channel = ResolveBeautyBakeStemUvChannel(state, stem);
            if (channel == 1) mask |= 1;
            else if (channel == 2) mask |= 2;
        }
        return mask;
    }

    static int RequiredBeautyBakeUvMask(const ForestInstanceGroup& group,
                                        const BeautyBakeExportState& state) {
        if (!state.active) return 0;
        int mask = 0;
        for (const std::wstring& stem : GetBeautyBakeTargetStems(group, state)) {
            const int channel = ResolveBeautyBakeStemUvChannel(state, stem);
            if (channel == 1) mask |= 1;
            else if (channel == 2) mask |= 2;
        }
        return mask;
    }

    static void TrimBeautyBakeUnusedUvs(SnapshotNodeRecord& snapshotNode,
                                        int requiredUvMask) {
        if (snapshotNode.spline) return;
        const size_t vertCount = snapshotNode.verts.size() / 3;
        if (snapshotNode.uvs.size() / 2 != vertCount) snapshotNode.uvs.clear();
        if (snapshotNode.uv2s.size() / 2 != vertCount) snapshotNode.uv2s.clear();
        if ((requiredUvMask & 1) == 0) snapshotNode.uvs.clear();
        if ((requiredUvMask & 2) == 0) snapshotNode.uv2s.clear();
    }

    static void TrimBeautyBakeUnusedUvs(ForestInstanceGroup& group,
                                        int requiredUvMask) {
        if ((requiredUvMask & 1) == 0) group.uvs.clear();
    }

    static bool HasHtmlTextureSlot(const MaxJSPBR& pbr) {
        auto has = [](const MaxJSPBR::TexTransform& xf) { return !xf.htmlFile.empty(); };
        return has(pbr.colorMapTransform) || has(pbr.gradientMapTransform) ||
               has(pbr.roughnessMapTransform) || has(pbr.metalnessMapTransform) ||
               has(pbr.normalMapTransform) || has(pbr.bumpMapTransform) ||
               has(pbr.displacementMapTransform) || has(pbr.parallaxMapTransform) ||
               has(pbr.sssColorMapTransform) || has(pbr.aoMapTransform) ||
               has(pbr.emissionMapTransform) || has(pbr.lightmapTransform) ||
               has(pbr.opacityMapTransform) || has(pbr.matcapMapTransform) ||
               has(pbr.specularMapTransform) || has(pbr.transmissionMapTransform) ||
               has(pbr.clearcoatMapTransform) || has(pbr.clearcoatRoughnessMapTransform) ||
               has(pbr.clearcoatNormalMapTransform) ||
               has(pbr.specularIntensityMapTransform) || has(pbr.specularColorMapTransform);
    }

    static void AccumulateMaterialRuntimeFeatures(SnapshotRuntimeFeatures& features,
                                                  const MaxJSPBR& pbr) {
        if (HasHtmlTextureSlot(pbr)) {
            features.htmlTextures = true;
        }
    }

    static void DetectSnapshotPostFxFeatures(SnapshotRuntimeFeatures& features,
                                             const std::wstring& snapshotUiJson) {
        if (snapshotUiJson.empty()) return;

        auto addIfEnabled = [&](const wchar_t* jsonKey, const wchar_t* featureName) {
            if (JsonObjectHasEnabledTrue(snapshotUiJson, jsonKey)) {
                AddUniqueRuntimeFeature(features.postFx, featureName);
            }
        };

        addIfEnabled(L"ssgi", L"ssgi");
        addIfEnabled(L"ssr", L"ssr");
        addIfEnabled(L"gtao", L"gtao");
        addIfEnabled(L"motionBlur", L"motion_blur");
        addIfEnabled(L"traa", L"traa");
        addIfEnabled(L"bloom", L"bloom");
        addIfEnabled(L"toonOutline", L"toon_outline");
        addIfEnabled(L"contactShadow", L"contact_shadow");
        addIfEnabled(L"retro", L"retro");
        addIfEnabled(L"fog", L"post_fog");
        addIfEnabled(L"pixel", L"pixel");
        addIfEnabled(L"volumetric", L"volumetric");
        addIfEnabled(L"dof", L"dof");
        addIfEnabled(L"opaqueBackdrop", L"opaque_backdrop");
        addIfEnabled(L"clone", L"clone_overlay");
        addIfEnabled(L"ascii", L"ascii");
    }

    static void AccumulateRuntimeFeatureTextHints(SnapshotRuntimeFeatures& features,
                                                  const std::wstring& text) {
        if (text.empty()) return;
        const std::wstring lower = LowerAsciiCopy(text);
        if (lower.find(L"rapier") != std::wstring::npos ||
            lower.find(L"physics") != std::wstring::npos) {
            features.physics = true;
        }
        if (lower.find(L"gltf") != std::wstring::npos) {
            features.gltfs = true;
            AddUniqueRuntimeFeature(features.threeAddons, L"GLTFLoader");
        }
        if (lower.find(L"audio") != std::wstring::npos) {
            features.audio = true;
        }
        if (lower.find(L"splat") != std::wstring::npos) {
            features.splats = true;
        }
        if (lower.find(L"htmltexture") != std::wstring::npos ||
            lower.find(L"html_texture") != std::wstring::npos ||
            lower.find(L"maxjshtml") != std::wstring::npos) {
            features.htmlTextures = true;
        }
    }

    static void AccumulateSidecarRuntimeFeatures(SnapshotRuntimeFeatures& features,
                                                 const std::wstring& manifestPath,
                                                 const std::wstring& inlineDir) {
        if (!manifestPath.empty() && FileExists(manifestPath)) {
            AccumulateRuntimeFeatureTextHints(features, ReadUtf8File(manifestPath));
        }
        if (inlineDir.empty() || !DirectoryExists(inlineDir)) return;

        std::error_code ec;
        for (const auto& entry : std::filesystem::recursive_directory_iterator(
                 std::filesystem::path(inlineDir), ec)) {
            if (ec) break;
            if (!entry.is_regular_file(ec) || ec) continue;
            const std::filesystem::path path = entry.path();
            const std::wstring ext = LowerAsciiCopy(path.extension().wstring());
            if (ext != L".js" && ext != L".mjs" && ext != L".json") continue;
            AccumulateRuntimeFeatureTextHints(features, ReadUtf8File(path.wstring()));
        }
    }

    static void WriteStringVectorJson(std::wostringstream& ss,
                                      const std::vector<std::wstring>& values) {
        ss << L'[';
        for (size_t i = 0; i < values.size(); ++i) {
            if (i) ss << L',';
            ss << L'"' << EscapeJson(values[i].c_str()) << L'"';
        }
        ss << L']';
    }

    static void WriteRuntimeFeaturesJson(std::wostringstream& ss,
                                         const SnapshotRuntimeFeatures& features) {
        ss << L"\"runtimeFeatures\":{\"version\":1";
        ss << L",\"renderer_pref\":\"" << EscapeJson(features.rendererPref.c_str()) << L"\"";
        ss << L",\"audio\":" << (features.audio ? L"true" : L"false");
        ss << L",\"splats\":" << (features.splats ? L"true" : L"false");
        ss << L",\"html_textures\":" << (features.htmlTextures ? L"true" : L"false");
        ss << L",\"volumes\":" << (features.volumes ? L"true" : L"false");
        ss << L",\"physics\":" << (features.physics ? L"true" : L"false");
        ss << L",\"gltf\":" << (features.gltfs ? L"true" : L"false");
        ss << L",\"animations\":" << (features.animations ? L"true" : L"false");
        ss << L",\"environment\":" << (features.environment ? L"true" : L"false");
        ss << L",\"hdri\":" << (features.hdri ? L"true" : L"false");
        ss << L",\"sky\":" << (features.sky ? L"true" : L"false");
        ss << L",\"binary_instances\":" << (features.binaryInstances ? L"true" : L"false");
        ss << L",\"post_fx\":";
        WriteStringVectorJson(ss, features.postFx);
        ss << L",\"three_addons\":";
        WriteStringVectorJson(ss, features.threeAddons);
        ss << L",\"exports\":{";
        ss << L"\"snapshotUi\":" << (features.snapshotUi ? L"true" : L"false");
        ss << L",\"runtimeScene\":" << (features.runtimeScene ? L"true" : L"false");
        ss << L",\"project\":" << (features.projectManifest ? L"true" : L"false");
        ss << L",\"inlines\":" << (features.inlineLayers ? L"true" : L"false");
        ss << L"}";
        ss << L",\"counts\":{";
        ss << L"\"meshes\":" << features.meshNodes;
        ss << L",\"materials\":" << features.materialCount;
        ss << L",\"skinnedMeshes\":" << features.skinnedMeshes;
        ss << L",\"morphTargets\":" << features.morphTargets;
        ss << L",\"vertexColorAttrs\":" << features.vertexColorAttrs;
        ss << L",\"lights\":" << features.lights;
        ss << L",\"instanceGroups\":" << features.instanceGroups;
        ss << L"}}";
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
        MaterialLibraryBuilder materialLibrary;
        SnapshotRuntimeFeatures runtimeFeatures;
        runtimeFeatures.snapshotUi = options.includeSnapshotUi && !snapshotUiJson.empty();
        runtimeFeatures.runtimeScene = options.includeRuntimeScene && !runtimeSceneJson.empty();
        runtimeFeatures.rendererPref = DetectRendererPrefFromSnapshotUi(snapshotUiJson);
        const std::wstring projectManifestPath = GetProjectManifestPath();
        const std::wstring inlineLayerDir = GetInlineLayerDir();
        runtimeFeatures.projectManifest =
            !projectManifestPath.empty() && FileExists(projectManifestPath);
        runtimeFeatures.inlineLayers =
            !inlineLayerDir.empty() && DirectoryExists(inlineLayerDir);
        AddUniqueRuntimeFeature(runtimeFeatures.threeAddons, L"OrbitControls");
        DetectSnapshotPostFxFeatures(runtimeFeatures, snapshotUiJson);
        AccumulateSidecarRuntimeFeatures(runtimeFeatures, projectManifestPath, inlineLayerDir);
        const BeautyBakeExportState beautyBakeExportState = DetectBeautyBakeExportState(snapshotUiJson);

        std::function<void(INode*)> collect = [&](INode* parent) {
            for (int i = 0; i < parent->NumberOfChildren(); ++i) {
                INode* node = parent->GetChildNode(i);
                if (!node) continue;

                // Always recurse into children — a hidden group node
                // (e.g. PointHelper on a hidden layer) may have visible children.
                ObjectState os = node->EvalWorldState(t);
                if (os.obj && IsThreeJSSplatClassID(os.obj->ClassID())) {
                    if (options.includeSplats && !node->IsNodeHidden(TRUE)) {
                        runtimeFeatures.splats = true;
                    }
                    collect(node);
                    continue;
                }
                if (os.obj && IsThreeJSAudioClassID(os.obj->ClassID())) {
                    if (options.includeAudios && !node->IsNodeHidden(TRUE)) {
                        runtimeFeatures.audio = true;
                    }
                    collect(node);
                    continue;
                }
                if (os.obj && IsThreeJSGLTFClassID(os.obj->ClassID())) {
                    if (options.includeGLTFs && !node->IsNodeHidden(TRUE)) {
                        runtimeFeatures.gltfs = true;
                    }
                    collect(node);
                    continue;
                }
                if (os.obj && IsThreeJSLightClassID(os.obj->ClassID()) &&
                    options.includeLights && !node->IsNodeHidden(TRUE)) {
                    runtimeFeatures.lights += 1;
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
                    snapshotNode.indices, snapshotNode.groups, &snapshotNode.norms, nullptr,
                    &snapshotNode.vertexColors, nullptr, &snapshotNode.uv2s);

                if (!extracted && ShouldExtractRenderableShape(node, t, &os)) {
                    extracted = ExtractSpline(node, t, snapshotNode.verts, snapshotNode.indices);
                    snapshotNode.spline = extracted;
                    if (extracted) {
                        snapshotNode.uvs.clear();
                        snapshotNode.uv2s.clear();
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
                            if (snapshotNode.uv2s.size() / 2 != snapshotNode.verts.size() / 3) {
                                snapshotNode.uv2s.clear();
                            }
                            snapshotNode.morphNames = std::move(morphNamesTmp);
                            snapshotNode.morphChannelIds = std::move(morphChIdsTmp);
                            snapshotNode.morphInfluences = std::move(morphInflTmp);
                            snapshotNode.morphChannelsData = std::move(morphChTmp);
                            skinRigMeshHandles.insert(snapshotNode.handle);
                        }
                    }

                    if (beautyBakeExportState.active) {
                        TrimBeautyBakeUnusedUvs(
                            snapshotNode,
                            RequiredBeautyBakeUvMask(node, snapshotNode, beautyBakeExportState));
                    }

                    // Calculate ALL binary offsets after skin/morph extraction
                    // (bind pose replaces verts/uvs/norms/indices — use final sizes)
                    snapshotNode.vOff = totalBytes;
                    totalBytes += snapshotNode.verts.size() * sizeof(float);
                    snapshotNode.iOff = totalBytes;
                    totalBytes += snapshotNode.indices.size() * sizeof(int);
                    snapshotNode.uvOff = totalBytes;
                    totalBytes += snapshotNode.uvs.size() * sizeof(float);
                    snapshotNode.uv2Off = totalBytes;
                    totalBytes += snapshotNode.uv2s.size() * sizeof(float);
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

        std::vector<ForestInstanceGroup> snapshotInstanceGroups;
        if (options.includeInstances) {
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
                            ExtractForestPackInstances(node, t, snapshotInstanceGroups);
                        else if (IsRailCloneAvailable() && IsRailCloneNode(node))
                            ExtractRailCloneInstances(node, t, snapshotInstanceGroups);
                        else if (IsTyFlowAvailable() && IsTyFlowNode(node))
                            ExtractTyFlowInstances(node, t, snapshotInstanceGroups);
                    }
                    collectInstances(node);
                }
            };
            collectInstances(root);
        }

        const size_t instanceBytesStart = totalBytes;
        for (ForestInstanceGroup& group : snapshotInstanceGroups) {
            const int transformCount = static_cast<int>(group.transforms.size() / 16);
            if (group.instanceCount <= 0 || group.instanceCount > transformCount) {
                group.instanceCount = transformCount;
            }
            if (group.verts.empty() || group.indices.empty() ||
                group.transforms.size() < static_cast<size_t>(group.instanceCount) * 16) {
                continue;
            }
            if (beautyBakeExportState.active) {
                TrimBeautyBakeUnusedUvs(
                    group,
                    RequiredBeautyBakeUvMask(group, beautyBakeExportState));
            }

            ReserveBinaryFloatRange(totalBytes, group.verts, group.vOff, group.vN);
            ReserveBinaryIntRange(totalBytes, group.indices, group.iOff, group.iN);
            ReserveBinaryFloatRange(totalBytes, group.uvs, group.uvOff, group.uvN);
            ReserveBinaryFloatRange(totalBytes, group.norms, group.nOff, group.nN);
            ReserveBinaryFloatRange(totalBytes, group.transforms, group.xformOff, group.xformN);
        }
        const size_t instanceBinaryBytes = totalBytes - instanceBytesStart;

        outBinary.assign(std::max<size_t>(totalBytes, 4), '\0');
        BYTE* buffer = reinterpret_cast<BYTE*>(outBinary.data());

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"scene_bin\",\"frame\":1";
        ss << L",\"bin\":\"scene.bin\"";
        ss << L",\"stats\":{\"producerBytes\":" << totalBytes;
        if (instanceBinaryBytes > 0) {
            ss << L",\"instanceBytes\":" << instanceBinaryBytes;
        }
        ss << L"}";
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
            if (!node.uv2s.empty()) {
                memcpy(buffer + node.uv2Off, node.uv2s.data(), node.uv2s.size() * sizeof(float));
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
            AccumulateMaterialRuntimeFeatures(runtimeFeatures, pbr);

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
            if (!node.uv2s.empty()) {
                ss << L",\"uv2Off\":" << node.uv2Off;
                ss << L",\"uv2N\":" << node.uv2s.size();
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
                ss << L"],\"matRefs\":[";
                for (size_t g = 0; g < node.groups.size(); ++g) {
                    if (g) ss << L',';
                    Mtl* subMtl = GetSubMtlFromMatID(multiMtl, node.groups[g].matID);
                    MaxJSPBR subPBR;
                    ExtractPBRFromMtl(subMtl, node.node, t, subPBR);
                    AccumulateMaterialRuntimeFeatures(runtimeFeatures, subPBR);
                    ss << InternMaterial(materialLibrary, subPBR);
                }
                ss << L"]";
            } else {
                ss << L",\"matRef\":" << InternMaterial(materialLibrary, pbr);
            }

            ss << L'}';
        }

        ss << L"],";
        WriteMaterialLibraryJson(ss, materialLibrary);
        ss << L",";
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
        if (options.includeEnvironment && envData.isSky) {
            runtimeFeatures.environment = true;
            runtimeFeatures.sky = true;
            AddUniqueRuntimeFeature(runtimeFeatures.threeAddons, L"Sky");
            AddUniqueRuntimeFeature(runtimeFeatures.threeAddons, L"SkyMesh");
        }
        if (options.includeEnvironment && !envData.isSky && !envData.hdriPath.empty()) {
            runtimeFeatures.environment = !hdriUrl.empty();
            runtimeFeatures.hdri = !hdriUrl.empty();
            const std::wstring lowerHdri = LowerAsciiCopy(envData.hdriPath);
            if (lowerHdri.size() >= 4 &&
                lowerHdri.compare(lowerHdri.size() - 4, 4, L".hdr") == 0) {
                AddUniqueRuntimeFeature(runtimeFeatures.threeAddons, L"HDRLoader");
            } else if (lowerHdri.size() >= 4 &&
                       lowerHdri.compare(lowerHdri.size() - 4, 4, L".exr") == 0) {
                AddUniqueRuntimeFeature(runtimeFeatures.threeAddons, L"EXRLoader");
            }
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
            runtimeFeatures.animations = WriteSnapshotAnimationsJson(
                ss, nodes, ip, t, options, outAnimBinary, skinRigMeshHandles, lockedCameraHandle_);
        }

        if (options.includeInstances) {
            if (!snapshotInstanceGroups.empty()) {
                ss << L",\"forestInstances\":[";
                bool firstGroup = true;
                for (auto& group : snapshotInstanceGroups) {
                    if (group.verts.empty() || group.indices.empty() ||
                        group.transforms.size() < static_cast<size_t>(group.instanceCount) * 16 ||
                        group.vN == 0 || group.iN == 0 || group.xformN == 0) {
                        continue;
                    }
                    if (!firstGroup) ss << L',';
                    firstGroup = false;
                    runtimeFeatures.instanceGroups += 1;
                    runtimeFeatures.binaryInstances = true;
                    if (!group.verts.empty()) {
                        memcpy(buffer + group.vOff, group.verts.data(), group.verts.size() * sizeof(float));
                    }
                    if (!group.indices.empty()) {
                        memcpy(buffer + group.iOff, group.indices.data(), group.indices.size() * sizeof(int));
                    }
                    if (!group.uvs.empty()) {
                        memcpy(buffer + group.uvOff, group.uvs.data(), group.uvs.size() * sizeof(float));
                    }
                    if (!group.norms.empty()) {
                        memcpy(buffer + group.nOff, group.norms.data(), group.norms.size() * sizeof(float));
                    }
                    if (!group.transforms.empty()) {
                        memcpy(buffer + group.xformOff, group.transforms.data(), group.transforms.size() * sizeof(float));
                    }

                    ss << L"{\"src\":" << group.groupKey;
                    ss << L",\"key\":\"" << group.groupKey << L"\"";
                    ss << L",\"count\":" << group.instanceCount;
                    ss << L",\"geo\":{\"vOff\":" << group.vOff
                       << L",\"vN\":" << group.vN
                       << L",\"iOff\":" << group.iOff
                       << L",\"iN\":" << group.iN;
                    if (group.uvN > 0) {
                        ss << L",\"uvOff\":" << group.uvOff
                           << L",\"uvN\":" << group.uvN;
                    }
                    if (group.nN > 0) {
                        ss << L",\"nOff\":" << group.nOff
                           << L",\"nN\":" << group.nN;
                    }
                    ss << L"}";
                    ss << L",\"xformOff\":" << group.xformOff;
                    ss << L",\"xformN\":" << group.xformN;
                    ss << L",\"xformType\":\"f32m16\"";
                    WriteInstanceGroupMaterial(ss, group, t);
                    ss << L'}';
                }
                ss << L']';
            }
            WriteHairInstanceGroupsJson(ss, root, t);
        }

        runtimeFeatures.meshNodes = static_cast<int>(nodes.size());
        runtimeFeatures.materialCount = static_cast<int>(materialLibrary.entries.size());
        for (const auto& node : nodes) {
            if (node.skinRig) runtimeFeatures.skinnedMeshes += 1;
            runtimeFeatures.morphTargets += static_cast<int>(node.morphNames.size());
            runtimeFeatures.vertexColorAttrs += static_cast<int>(node.vertexColors.size());
        }

        ss << L",";
        WriteRuntimeFeaturesJson(ss, runtimeFeatures);

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
        if (!EnsureDirectoryExists(outDir)) {
            error = L"Failed to prepare snapshot directory";
            return false;
        }

        // Helper: clean up generated data on failure. Never remove the whole
        // folder: users may turn dist/ into a custom website shell.
        auto cleanupOnFail = [&]() {
            std::error_code ec;
            std::filesystem::remove(std::filesystem::path(outDir) / L"snapshot.json", ec);
            ec.clear();
            std::filesystem::remove(std::filesystem::path(outDir) / L"scene.bin", ec);
            ec.clear();
            std::filesystem::remove(std::filesystem::path(outDir) / L"scene_anim.bin", ec);
        };

        if (!CopySnapshotRuntimeSeed(webDir, outDir, options.includeSplats, error)) {
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

        if (options.copyAssets) {
            DeleteSnapshotGeneratedAssets(outDir);
            if (!RewriteSnapshotAssetUrls(metaJson, outDir, error, false)) {
                cleanupOnFail();
                return false;
            }
            InjectSnapshotBakeFileManifest(metaJson, outDir);
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
        if (animBinary.empty()) {
            std::error_code ec;
            std::filesystem::remove(std::filesystem::path(outDir) / L"scene_anim.bin", ec);
        }

        // Copy project layers when present. They are sidecars, not part of the
        // baked runtimeScene JSON, so snapshots can replay inlines even when
        // runtimeScene export is omitted or empty.
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

        // Optional project website shell. This is deliberately copied as a
        // sidecar instead of replacing snapshot.html: MaxJS owns the neutral
        // snapshot player, projects can layer their own deployable UI on top.
        const std::wstring siteShellPath = GetProjectSiteShellPath();
        if (!siteShellPath.empty() && FileExists(siteShellPath)) {
            if (!CopyFileEnsuringDirectories(siteShellPath, outDir + L"\\site.html")) {
                error = L"Failed to copy site.html into snapshot";
                cleanupOnFail();
                return false;
            }
        }

        return true;
    }

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
