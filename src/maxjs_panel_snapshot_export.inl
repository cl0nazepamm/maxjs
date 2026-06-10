#include "maxjs_panel_snapshot_animation.inl"

    bool ReadSmallTextFile(const std::wstring& path, std::string& out, DWORD maxBytes = 1024u * 1024u) {
        out.clear();
        HANDLE hFile = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (hFile == INVALID_HANDLE_VALUE) return false;

        LARGE_INTEGER size{};
        if (!GetFileSizeEx(hFile, &size) || size.QuadPart < 0 || size.QuadPart > maxBytes) {
            CloseHandle(hFile);
            return false;
        }

        out.resize(static_cast<size_t>(size.QuadPart));
        DWORD bytesRead = 0;
        const BOOL ok = out.empty()
            ? TRUE
            : ReadFile(hFile, out.data(), static_cast<DWORD>(out.size()), &bytesRead, nullptr);
        CloseHandle(hFile);
        if (!ok || bytesRead != out.size()) {
            out.clear();
            return false;
        }
        return true;
    }

    bool GetFileByteSize(const std::wstring& path, unsigned long long& outSize) {
        outSize = 0;
        HANDLE hFile = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (hFile == INVALID_HANDLE_VALUE) return false;

        LARGE_INTEGER size{};
        const BOOL ok = GetFileSizeEx(hFile, &size);
        CloseHandle(hFile);
        if (!ok || size.QuadPart < 0) return false;
        outSize = static_cast<unsigned long long>(size.QuadPart);
        return true;
    }

    bool ReadSnapshotAnalysisPayload(const std::wstring& snapshotDir,
                                     std::wstring& outSnapshotJson,
                                     unsigned long long& outSnapshotJsonBytes,
                                     unsigned long long& outSceneBinBytes,
                                     unsigned long long& outSceneAnimBytes,
                                     std::wstring& error) {
        outSnapshotJson.clear();
        outSnapshotJsonBytes = 0;
        outSceneBinBytes = 0;
        outSceneAnimBytes = 0;
        error.clear();

        if (snapshotDir.empty()) {
            error = L"Export a snapshot first";
            return false;
        }
        if (!DirectoryExists(snapshotDir)) {
            error = L"Snapshot folder not found";
            return false;
        }

        const std::wstring snapshotJsonPath = snapshotDir + L"\\snapshot.json";
        const std::wstring sceneBinPath = snapshotDir + L"\\scene.bin";
        const std::wstring sceneAnimPath = snapshotDir + L"\\scene_anim.bin";

        std::string snapshotJsonUtf8;
        if (!ReadSmallTextFile(snapshotJsonPath, snapshotJsonUtf8, 64u * 1024u * 1024u)) {
            error = L"Snapshot folder is missing snapshot.json";
            return false;
        }
        outSnapshotJsonBytes = static_cast<unsigned long long>(snapshotJsonUtf8.size());
        outSnapshotJson = Utf8ToWide(snapshotJsonUtf8);

        if (!GetFileByteSize(sceneBinPath, outSceneBinBytes)) {
            error = L"Snapshot folder is missing scene.bin";
            return false;
        }
        if (FileExists(sceneAnimPath)) {
            GetFileByteSize(sceneAnimPath, outSceneAnimBytes);
        }
        return true;
    }

    bool IsGeneratedSnapshotShell(const std::wstring& path) {
        std::string html;
        if (!ReadSmallTextFile(path, html)) return false;
        return html.find("<title>max.js snapshot</title>") != std::string::npos &&
            html.find("import { boot } from './js/snapshot_boot.js';") != std::string::npos &&
            html.find("const root = params.get('root')") != std::string::npos;
    }

    bool CopySnapshotIndexSeed(const std::wstring& snapshotHtml,
                               const std::wstring& indexHtml,
                               std::wstring& error) {
        if (FileExists(indexHtml) && !IsGeneratedSnapshotShell(indexHtml)) {
            return true;
        }
        if (!CopyFileEnsuringDirectories(snapshotHtml, indexHtml)) {
            error = L"Failed to copy snapshot runtime index.html";
            return false;
        }
        return true;
    }

    bool CopySnapshotRuntimeSeed(const std::wstring& webDir,
                                 const std::wstring& outDir,
                                 bool copySparkDist,
                                 bool copyRapierVendor,
                                 bool copyGeospatialVendor,
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

        // Keep generated root wrappers current while preserving project-authored
        // standalone pages that intentionally live at index.html.
        if (!CopySnapshotIndexSeed(snapshotHtml, outDir + L"\\index.html", error)) {
            return false;
        }

        // WebGPU snapshot target — the only target that runs real TSL node
        // materials. Copied alongside snapshot.html so TSL scenes can be opened
        // via snapshot_webgpu.html (cheap; harmless when unused).
        const std::wstring snapshotWebgpuHtml = webDir + L"\\snapshot_webgpu.html";
        if (FileExists(snapshotWebgpuHtml)) {
            CopyFileEnsuringDirectories(snapshotWebgpuHtml, outDir + L"\\snapshot_webgpu.html");
        }

        if (!CopyDirectoryRecursive(webDir + L"\\js", outDir + L"\\js")) {
            error = L"Failed to copy snapshot runtime js directory";
            return false;
        }

        const std::wstring threeVendor = webDir + L"\\vendor\\three-r184";
        if (!DirectoryExists(threeVendor + L"\\build")) {
            error = L"Snapshot runtime dependency missing: web/vendor/three-r184/build";
            return false;
        }
        if (!CopyDirectoryRecursive(threeVendor + L"\\build", outDir + L"\\vendor\\three-r184\\build")) {
            error = L"Failed to copy snapshot runtime three.js build vendor";
            return false;
        }
        const std::vector<std::wstring> threeRootFiles = {
            L"LICENSE", L"package.json", L"README.md"
        };
        for (const std::wstring& fileName : threeRootFiles) {
            const std::wstring src = threeVendor + L"\\" + fileName;
            if (FileExists(src)) {
                CopyFileEnsuringDirectories(src, outDir + L"\\vendor\\three-r184\\" + fileName);
            }
        }

        const std::wstring threeExamples = threeVendor + L"\\examples";
        if (!DirectoryExists(threeExamples)) {
            error = L"Snapshot runtime dependency missing: web/vendor/three-r184/examples";
            return false;
        }
        if (!CopyDirectoryRecursive(threeExamples, outDir + L"\\vendor\\three-r184\\examples")) {
            error = L"Failed to copy snapshot runtime three.js examples vendor";
            return false;
        }

        // Geospatial / planetary atmosphere sky vendor (@takram + three/src node
        // sources). Heavy (~6 MB) and only consumed by geospatial_sky.js when a
        // scene runs the planetary sky model, so it is gated behind its own export
        // toggle to keep ordinary snapshots lean.
        if (copyGeospatialVendor) {
            const std::wstring takramRoot = webDir + L"\\node_modules\\@takram";
            const std::wstring takramOutRoot = outDir + L"\\node_modules\\@takram";
            const std::wstring atmosphereRoot = takramRoot + L"\\three-atmosphere";
            const std::wstring geospatialRoot = takramRoot + L"\\three-geospatial";
            if (!DirectoryExists(atmosphereRoot + L"\\build")) {
                error = L"Snapshot runtime dependency missing: @takram/three-atmosphere/build";
                return false;
            }
            if (!DirectoryExists(atmosphereRoot + L"\\assets")) {
                error = L"Snapshot runtime dependency missing: @takram/three-atmosphere/assets";
                return false;
            }
            if (!DirectoryExists(geospatialRoot + L"\\build")) {
                error = L"Snapshot runtime dependency missing: @takram/three-geospatial/build";
                return false;
            }
            if (!CopyDirectoryRecursive(
                    atmosphereRoot + L"\\build",
                    takramOutRoot + L"\\three-atmosphere\\build")) {
                error = L"Failed to copy snapshot runtime three-atmosphere build";
                return false;
            }
            if (!CopyDirectoryRecursive(
                    atmosphereRoot + L"\\assets",
                    takramOutRoot + L"\\three-atmosphere\\assets")) {
                error = L"Failed to copy snapshot runtime three-atmosphere assets";
                return false;
            }
            if (!CopyDirectoryRecursive(
                    geospatialRoot + L"\\build",
                    takramOutRoot + L"\\three-geospatial\\build")) {
                error = L"Failed to copy snapshot runtime three-geospatial build";
                return false;
            }

            // The takram WebGPU builds (three-atmosphere/build/webgpu.js,
            // three-geospatial/build/webgpu.js) deep-import three node sources such
            // as `three/src/nodes/core/NodeUtils.js`. The bundled vendor three.js is
            // a single-file build with no `src/` tree, so the importmap resolves
            // `three/src/` to node_modules/three/src — which must ship alongside the
            // takram builds, or the WebGPU sky fails with a 404 on NodeUtils.js.
            const std::wstring threeSrc = webDir + L"\\node_modules\\three\\src";
            if (!DirectoryExists(threeSrc)) {
                error = L"Snapshot runtime dependency missing: node_modules/three/src";
                return false;
            }
            if (!CopyDirectoryRecursive(threeSrc, outDir + L"\\node_modules\\three\\src")) {
                error = L"Failed to copy snapshot runtime three.js node sources (three/src)";
                return false;
            }

            const std::wstring postprocessingBuild = webDir + L"\\node_modules\\postprocessing\\build";
            if (!DirectoryExists(postprocessingBuild)) {
                error = L"Snapshot runtime dependency missing: postprocessing/build";
                return false;
            }
            if (!CopyDirectoryRecursive(
                    postprocessingBuild,
                    outDir + L"\\node_modules\\postprocessing\\build")) {
                error = L"Failed to copy snapshot runtime postprocessing build";
                return false;
            }
        }

        const std::wstring outRapierVendor = outDir + L"\\vendor\\rapier";
        if (copyRapierVendor) {
            const std::wstring rapierVendor = webDir + L"\\vendor\\rapier";
            if (!DirectoryExists(rapierVendor)) {
                error = L"Snapshot runtime dependency missing: web/vendor/rapier";
                return false;
            }
            if (!CopyDirectoryRecursive(rapierVendor, outRapierVendor)) {
                error = L"Failed to copy snapshot runtime Rapier vendor";
                return false;
            }
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
        bool geospatialSky = false;
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

    // True when the JSON object value for `key` has a TOP-LEVEL
    // "enabled": true member. Brace-aware and string-safe: the old
    // fixed-window scan false-negated when `enabled` sat past 768 chars
    // (shaderLab serializes its composition config before the flag) and
    // false-positived on nested objects with their own enabled flags
    // (shaderLab config layers) or on neighbouring effects inside the
    // window. Skips occurrences of `key` that are string values rather
    // than object keys (e.g. "preset":"powershot").
    static bool JsonObjectHasEnabledTrue(const std::wstring& json, const wchar_t* key) {
        if (json.empty() || !key || !*key) return false;
        const std::wstring needle = L"\"" + std::wstring(key) + L"\"";
        const auto isJsonSpace = [](wchar_t c) {
            return c == L' ' || c == L'\t' || c == L'\n' || c == L'\r';
        };

        size_t searchPos = 0;
        size_t pos = std::wstring::npos;
        while ((pos = json.find(needle, searchPos)) != std::wstring::npos) {
            searchPos = pos + 1;

            // Must parse as `"key" : {` — otherwise it was a string value.
            size_t i = pos + needle.size();
            while (i < json.size() && isJsonSpace(json[i])) ++i;
            if (i >= json.size() || json[i] != L':') continue;
            ++i;
            while (i < json.size() && isJsonSpace(json[i])) ++i;
            if (i >= json.size() || json[i] != L'{') continue;

            // Walk the object: track depth, skip string literals, look for
            // a depth-1 "enabled" key.
            static const std::wstring enabledKey = L"\"enabled\"";
            int depth = 0;
            bool inString = false;
            bool escaped = false;
            for (; i < json.size(); ++i) {
                const wchar_t c = json[i];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (c == L'\\') escaped = true;
                    else if (c == L'"') inString = false;
                    continue;
                }
                if (c == L'"') {
                    if (depth == 1 && json.compare(i, enabledKey.size(), enabledKey) == 0) {
                        size_t after = i + enabledKey.size();
                        while (after < json.size() && isJsonSpace(json[after])) ++after;
                        if (after < json.size() && json[after] == L':') {
                            ++after;
                            while (after < json.size() && isJsonSpace(json[after])) ++after;
                            return json.compare(after, 4, L"true") == 0;
                        }
                    }
                    inString = true;
                    continue;
                }
                if (c == L'{') {
                    ++depth;
                } else if (c == L'}') {
                    if (--depth == 0) break;  // object closed, no enabled flag
                }
            }
            return false;  // parsed the key's object; flag absent or false
        }
        return false;
    }

    static std::wstring DetectRendererPrefFromSnapshotUi(const std::wstring& snapshotUiJson) {
        const std::wstring lower = LowerAsciiCopy(snapshotUiJson);
        if (lower.find(L"\"rendererbackend\":\"webgpu") != std::wstring::npos ||
            lower.find(L"\"rendererbackend\": \"webgpu") != std::wstring::npos ||
            lower.find(L"\"snapshotrendererbackend\":\"webgpu") != std::wstring::npos ||
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
            if (ShouldEmitMultiSubMaterialGroups(multiMtl, snapshotNode.groups)) {
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
            if (ShouldEmitMultiSubMaterialGroups(multiMtl, group.groups)) {
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

    static void AccumulateTextureUvMask(int& mask,
                                        const std::wstring& path,
                                        const MaxJSPBR::TexTransform& xf) {
        const bool hasSource = !path.empty() || !xf.htmlFile.empty() || !xf.tslCode.empty();
        if (!hasSource) return;
        if (xf.uvChannel <= 1) mask |= 1;
        else if (xf.uvChannel == 2) mask |= 2;
        else mask |= 1;
    }

    static int OriginalMaterialUvMask(const MaxJSPBR& pbr) {
        int mask = 0;
        AccumulateTextureUvMask(mask, pbr.colorMap, pbr.colorMapTransform);
        AccumulateTextureUvMask(mask, pbr.gradientMap, pbr.gradientMapTransform);
        AccumulateTextureUvMask(mask, pbr.roughnessMap, pbr.roughnessMapTransform);
        AccumulateTextureUvMask(mask, pbr.metalnessMap, pbr.metalnessMapTransform);
        AccumulateTextureUvMask(mask, pbr.normalMap, pbr.normalMapTransform);
        AccumulateTextureUvMask(mask, pbr.bumpMap, pbr.bumpMapTransform);
        AccumulateTextureUvMask(mask, pbr.displacementMap, pbr.displacementMapTransform);
        AccumulateTextureUvMask(mask, pbr.parallaxMap, pbr.parallaxMapTransform);
        AccumulateTextureUvMask(mask, pbr.sssColorMap, pbr.sssColorMapTransform);
        AccumulateTextureUvMask(mask, pbr.aoMap, pbr.aoMapTransform);
        AccumulateTextureUvMask(mask, pbr.emissionMap, pbr.emissionMapTransform);
        AccumulateTextureUvMask(mask, pbr.lightmapFile, pbr.lightmapTransform);
        AccumulateTextureUvMask(mask, pbr.opacityMap, pbr.opacityMapTransform);
        AccumulateTextureUvMask(mask, pbr.matcapMap, pbr.matcapMapTransform);
        AccumulateTextureUvMask(mask, pbr.specularMap, pbr.specularMapTransform);
        AccumulateTextureUvMask(mask, pbr.transmissionMap, pbr.transmissionMapTransform);
        AccumulateTextureUvMask(mask, pbr.clearcoatMap, pbr.clearcoatMapTransform);
        AccumulateTextureUvMask(mask, pbr.clearcoatRoughnessMap, pbr.clearcoatRoughnessMapTransform);
        AccumulateTextureUvMask(mask, pbr.clearcoatNormalMap, pbr.clearcoatNormalMapTransform);
        AccumulateTextureUvMask(mask, pbr.specularIntensityMap, pbr.specularIntensityMapTransform);
        AccumulateTextureUvMask(mask, pbr.specularColorMap, pbr.specularColorMapTransform);
        for (const std::wstring& tslMap : pbr.tslMaps) {
            if (!tslMap.empty()) mask |= 1;
        }
        if (!pbr.materialXFile.empty() || !pbr.materialXInline.empty()) {
            mask |= 1;
        }
        return mask;
    }

    static int OriginalMaterialUvMask(INode* node,
                                      const SnapshotNodeRecord& snapshotNode,
                                      TimeValue t) {
        if (!node) return 0;
        int mask = 0;
        Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
        if (ShouldEmitMultiSubMaterialGroups(multiMtl, snapshotNode.groups)) {
            for (const MatGroup& group : snapshotNode.groups) {
                Mtl* subMtl = GetSubMtlFromMatID(multiMtl, group.matID);
                MaxJSPBR subPBR;
                ExtractPBRFromMtl(subMtl, node, t, subPBR);
                mask |= OriginalMaterialUvMask(subPBR);
            }
        } else {
            MaxJSPBR pbr;
            ExtractPBR(node, t, pbr);
            mask |= OriginalMaterialUvMask(pbr);
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

    static int OriginalMaterialUvMask(const ForestInstanceGroup& group, TimeValue t) {
        int mask = 0;
        Mtl* multiMtl = FindMultiSubMtl(group.mtl);
        if (ShouldEmitMultiSubMaterialGroups(multiMtl, group.groups)) {
            for (const MatGroup& matGroup : group.groups) {
                Mtl* subMtl = GetSubMtlFromMatID(multiMtl, matGroup.matID);
                MaxJSPBR subPBR;
                ExtractPBRFromMtl(subMtl, group.mtlNode, t, subPBR);
                mask |= OriginalMaterialUvMask(subPBR);
            }
        } else if (group.mtl) {
            MaxJSPBR pbr;
            ExtractPBRFromMtl(group.mtl, group.mtlNode, t, pbr);
            mask |= OriginalMaterialUvMask(pbr);
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

    static void TrimBeautyBakeNormals(SnapshotNodeRecord& snapshotNode) {
        if (!snapshotNode.spline) snapshotNode.norms.clear();
    }

    static void TrimBeautyBakeNormals(ForestInstanceGroup& group) {
        group.norms.clear();
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
        if (pbr.materialModel == L"MaterialXMaterial") {
            features.rendererPref = L"webgpu";
            AddUniqueRuntimeFeature(features.threeAddons, L"MaterialXLoader");
        } else if (pbr.materialModel == L"MeshTSLNodeMaterial" ||
                   pbr.materialModel == L"MeshSSSNodeMaterial") {
            features.rendererPref = L"webgpu";
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

        // Feature names are exact JS effect ids (camelCase) — they key the
        // dynamic descriptor imports in web/js/fx/loader.js. The manifest
        // post_fx array intentionally diverges from the snake_case boolean
        // feature flags elsewhere in runtimeFeatures.
        addIfEnabled(L"ssgi", L"ssgi");
        addIfEnabled(L"ssr", L"ssr");
        addIfEnabled(L"gtao", L"gtao");
        addIfEnabled(L"motionBlur", L"motionBlur");
        addIfEnabled(L"traa", L"traa");
        addIfEnabled(L"bloom", L"bloom");
        addIfEnabled(L"toonOutline", L"toonOutline");
        addIfEnabled(L"contactShadow", L"contactShadow");
        addIfEnabled(L"retro", L"retro");
        addIfEnabled(L"fog", L"fog");
        addIfEnabled(L"pixel", L"pixel");
        addIfEnabled(L"volumetric", L"volumetric");
        addIfEnabled(L"dof", L"dof");
        addIfEnabled(L"clone", L"clone");  // CPU overlay — no fx module; loader skips it
        // Final-stylize stages (fx/final/*). powershot state lives inside
        // snapshotUi.fx; shaderLab is a top-level snapshotUi object whose
        // composition replays through shader_lab_fx.js in the viewer.
        addIfEnabled(L"powershot", L"powershot");
        addIfEnabled(L"shaderLab", L"shaderLab");
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
        ss << L",\"geospatial_sky\":" << (features.geospatialSky ? L"true" : L"false");
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
        // "Export unused channels": when off, drop non-canonical vertex-color
        // channels (map channel >= 3) for THIS export only; restored on return so
        // the live viewport keeps every channel.
        const bool prevIncludeUnusedVc = g_includeUnusedVertexColorChannels;
        g_includeUnusedVertexColorChannels = options.includeUnusedChannels;
        struct VcChannelGuard { bool prev; ~VcChannelGuard() { g_includeUnusedVertexColorChannels = prev; } } vcChannelGuard{ prevIncludeUnusedVc };

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
        const Interval snapshotAnimRange = ip->GetAnimRange();

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
                if (os.obj && IsThreeJSWebAppClassID(os.obj->ClassID())) {
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

                SnapshotNodeRecord snapshotNode;
                snapshotNode.handle = node->GetHandle();
                snapshotNode.parentHandle = GetMaxJSParentHandle(node);
                snapshotNode.node = node;
                snapshotNode.visible =
                    !node->IsNodeHidden(TRUE) && node->GetVisibility(t) > 0.0f && node->Renderable();

                if (IsMaxJSHierarchyNode(node, t)) {
                    snapshotNode.visible = IsMaxJsSyncDrawVisible(node);
                    snapshotNode.helper = true;
                    nodes.push_back(std::move(snapshotNode));
                    collect(node);
                    continue;
                }

                // Skip hidden render nodes from extraction but still recurse below.
                // Hidden helper/group parents above still export transform-only.
                if (node->IsNodeHidden(TRUE)) {
                    collect(node);
                    continue;
                }

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
                                snapshotNode.morphTargets)) {
                            snapshotNode.skinRig = true;
                            if (snapshotNode.uv2s.size() / 2 != snapshotNode.verts.size() / 3) {
                                snapshotNode.uv2s.clear();
                            }
                            skinRigMeshHandles.insert(snapshotNode.handle);
                        } else if (TryExtractMorphTargets(
                                snapshotNode.node,
                                t,
                                snapshotNode.verts,
                                snapshotNode.uvs,
                                snapshotNode.norms,
                                snapshotNode.indices,
                                snapshotNode.groups,
                                snapshotNode.morphTargets)) {
                            // Standalone Morpher (no Skin): geometry is now the rest
                            // mesh; uv2 and vertex colors from the initially evaluated
                            // mesh must not be paired with the replaced base geometry.
                            snapshotNode.vertexColors.clear();
                            if (snapshotNode.uv2s.size() / 2 != snapshotNode.verts.size() / 3) {
                                snapshotNode.uv2s.clear();
                            }
                        }
                        if (!options.includeAllMorphTargets && !snapshotNode.morphTargets.empty()) {
                            PruneZeroUnkeyedMorphTargets(
                                snapshotNode.node,
                                snapshotAnimRange,
                                snapshotNode.morphTargets);
                        }
                        TrimDefaultVertexColorAttributes(snapshotNode.vertexColors);
                    }

                    if (beautyBakeExportState.active) {
                        const int bakeUvMask =
                            RequiredBeautyBakeUvMask(node, snapshotNode, beautyBakeExportState);
                        int requiredUvMask = bakeUvMask;
                        if (requiredUvMask == 0) {
                            requiredUvMask = OriginalMaterialUvMask(node, snapshotNode, t);
                        } else {
                            TrimBeautyBakeNormals(snapshotNode);
                        }
                        TrimBeautyBakeUnusedUvs(
                            snapshotNode,
                            requiredUvMask);
                    }

                    // Calculate ALL binary offsets after skin/morph extraction
                    // (bind pose replaces verts/uvs/norms/indices — use final sizes)
                    AlignBinarySize(totalBytes, alignof(float));
                    snapshotNode.vOff = totalBytes;
                    totalBytes += snapshotNode.verts.size() * sizeof(float);
                    ReserveBinaryIndexRange(
                        totalBytes,
                        snapshotNode.indices,
                        snapshotNode.iOff,
                        snapshotNode.iN,
                        snapshotNode.iType);
                    {
                        size_t uvCount = 0;
                        ReserveBinaryUvRange(
                            totalBytes,
                            snapshotNode.uvs,
                            snapshotNode.uvOff,
                            uvCount,
                            snapshotNode.uvType);
                    }
                    {
                        size_t uv2Count = 0;
                        ReserveBinaryUvRange(
                            totalBytes,
                            snapshotNode.uv2s,
                            snapshotNode.uv2Off,
                            uv2Count,
                            snapshotNode.uv2Type);
                    }
                    {
                        size_t normalCount = 0;
                        ReserveBinaryNormalRange(
                            totalBytes,
                            snapshotNode.norms,
                            snapshotNode.nOff,
                            normalCount,
                            snapshotNode.nType);
                    }
                    for (VertexColorAttributeRecord& attr : snapshotNode.vertexColors) {
                        AlignBinarySize(totalBytes, alignof(float));
                        attr.off = totalBytes;
                        totalBytes += attr.values.size() * sizeof(float);
                    }
                    if (snapshotNode.skinRig) {
                        ReserveBinarySkinWeightRange(
                            totalBytes,
                            snapshotNode.skinWData,
                            snapshotNode.skinWOff,
                            snapshotNode.skinWType);
                        ReserveBinarySkinIndexRange(
                            totalBytes,
                            snapshotNode.skinIdxData,
                            snapshotNode.skinIndOff,
                            snapshotNode.skinIdxType);
                        AlignBinarySize(totalBytes, alignof(float));
                        snapshotNode.skinBoneBindOff = totalBytes;
                        totalBytes += snapshotNode.skinBoneBindLocal.size() * sizeof(float);
                    }
                    // Morph delta streams: any mesh carrying morph targets, skinned
                    // or not. Float-aligned so the viewer can map them as Float32Array.
                    for (auto& ch : snapshotNode.morphTargets.channels) {
                        AlignBinarySize(totalBytes, alignof(float));
                        ch.binaryOffset = totalBytes;
                        ch.floatCount = static_cast<int>(ch.deltas.size());
                        totalBytes += ch.deltas.size() * sizeof(float);
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
                const int bakeUvMask = RequiredBeautyBakeUvMask(group, beautyBakeExportState);
                int requiredUvMask = bakeUvMask;
                if (requiredUvMask == 0) {
                    requiredUvMask = OriginalMaterialUvMask(group, t);
                } else {
                    TrimBeautyBakeNormals(group);
                }
                TrimBeautyBakeUnusedUvs(
                    group,
                    requiredUvMask);
            }

            ReserveBinaryFloatRange(totalBytes, group.verts, group.vOff, group.vN);
            ReserveBinaryIndexRange(totalBytes, group.indices, group.iOff, group.iN, group.iType);
            ReserveBinaryUvRange(totalBytes, group.uvs, group.uvOff, group.uvN, group.uvType);
            ReserveBinaryNormalRange(totalBytes, group.norms, group.nOff, group.nN, group.nType);
            ReserveBinaryInstanceTransformRange(
                totalBytes,
                group.transforms,
                group.xformOff,
                group.xformN,
                group.xformType);
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
            GetTransform16(node.node, t, xform);

            if (!first) ss << L',';
            first = false;

            if (node.helper) {
                ss << L"{\"h\":" << node.handle;
                ss << L",\"n\":\"" << EscapeJson(node.node->GetName()) << L'"';
                ss << L",\"helper\":true";
                ss << L",\"s\":" << (node.node->Selected() ? L'1' : L'0');
                if (node.parentHandle != 0) ss << L",\"p\":" << node.parentHandle;
                ss << L",\"vis\":" << (node.visible ? L'1' : L'0');
                ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                ss << L'}';
                continue;
            }

            if (!node.verts.empty()) {
                memcpy(buffer + node.vOff, node.verts.data(), node.verts.size() * sizeof(float));
            }
            if (!node.indices.empty()) {
                CopyBinaryIndices(buffer, node.iOff, node.indices, node.iType);
            }
            if (!node.uvs.empty()) {
                CopyBinaryUvs(buffer, node.uvOff, node.uvs, node.uvType);
            }
            if (!node.uv2s.empty()) {
                CopyBinaryUvs(buffer, node.uv2Off, node.uv2s, node.uv2Type);
            }
            if (!node.norms.empty()) {
                CopyBinaryNormals(buffer, node.nOff, node.norms, node.nType);
            }
            for (const VertexColorAttributeRecord& attr : node.vertexColors) {
                if (!attr.values.empty()) {
                    memcpy(buffer + attr.off, attr.values.data(), attr.values.size() * sizeof(float));
                }
            }
            if (node.skinRig) {
                if (!node.skinWData.empty()) {
                    CopyBinarySkinWeights(buffer, node.skinWOff, node.skinWData, node.skinWType);
                }
                if (!node.skinIdxData.empty()) {
                    CopyBinarySkinIndices(buffer, node.skinIndOff, node.skinIdxData, node.skinIdxType);
                }
                if (!node.skinBoneBindLocal.empty()) {
                    memcpy(buffer + node.skinBoneBindOff, node.skinBoneBindLocal.data(),
                           node.skinBoneBindLocal.size() * sizeof(float));
                }
            }
            // Morph delta streams: any mesh carrying morph targets, skinned or not.
            for (const auto& ch : node.morphTargets.channels) {
                if (!ch.deltas.empty()) {
                    memcpy(buffer + ch.binaryOffset, ch.deltas.data(),
                           ch.deltas.size() * sizeof(float));
                }
            }

            MaxJSPBR pbr;
            ExtractPBR(node.node, t, pbr);
            AccumulateMaterialRuntimeFeatures(runtimeFeatures, pbr);

            ss << L"{\"h\":" << node.handle;
            ss << L",\"n\":\"" << EscapeJson(node.node->GetName()) << L'"';
            ss << L",\"s\":" << (node.node->Selected() ? L'1' : L'0');
            if (node.parentHandle != 0) ss << L",\"p\":" << node.parentHandle;
            ss << L",\"props\":{"; WriteNodePropsJson(ss, node.node, t); ss << L'}';
            { JsModData jm; GetJsModData(node.node, t, jm); if (jm.found) { ss << L","; WriteJsModJson(ss, jm); } }
            ss << L",\"vis\":" << (node.visible ? L'1' : L'0');
            ss << L",\"t\":"; WriteFloats(ss, xform, 16);
            if (node.spline) ss << L",\"spline\":true";

            ss << L",\"geo\":{\"vOff\":" << node.vOff;
            ss << L",\"vN\":" << node.verts.size();
            ss << L",\"iOff\":" << node.iOff;
            ss << L",\"iN\":" << node.iN;
            if (!node.iType.empty()) {
                ss << L",\"iType\":\"" << node.iType << L"\"";
            }
            if (!node.uvs.empty()) {
                ss << L",\"uvOff\":" << node.uvOff;
                ss << L",\"uvN\":" << node.uvs.size();
                if (!node.uvType.empty()) {
                    ss << L",\"uvType\":\"" << node.uvType << L"\"";
                }
            }
            if (!node.uv2s.empty()) {
                ss << L",\"uv2Off\":" << node.uv2Off;
                ss << L",\"uv2N\":" << node.uv2s.size();
                if (!node.uv2Type.empty()) {
                    ss << L",\"uv2Type\":\"" << node.uv2Type << L"\"";
                }
            }
            if (!node.norms.empty()) {
                ss << L",\"nOff\":" << node.nOff;
                ss << L",\"nN\":" << node.norms.size();
                if (!node.nType.empty()) {
                    ss << L",\"nType\":\"" << node.nType << L"\"";
                }
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
                if (!node.skinWType.empty()) {
                    ss << L",\"wType\":\"" << node.skinWType << L"\"";
                }
                if (!node.skinIdxType.empty()) {
                    ss << L",\"iType\":\"" << node.skinIdxType << L"\"";
                }
                ss << L"}";
            }
            // Morph manifest: any mesh carrying morph targets, skinned or not.
            if (!node.morphTargets.empty()) {
                const auto& channels = node.morphTargets.channels;
                std::vector<float> infl;
                infl.reserve(channels.size());
                for (const auto& ch : channels) infl.push_back(ch.influence);
                ss << L",\"morph\":{";
                ss << L"\"names\":[";
                for (size_t mi = 0; mi < channels.size(); ++mi) {
                    if (mi) ss << L',';
                    ss << L'"' << EscapeJson(channels[mi].name.c_str()) << L'"';
                }
                ss << L"],\"infl\":";
                WriteFloats(ss, infl.data(), infl.size());
                ss << L",\"dOff\":[";
                for (size_t mi = 0; mi < channels.size(); ++mi) {
                    if (mi) ss << L',';
                    ss << channels[mi].binaryOffset;
                }
                ss << L"],\"dN\":[";
                for (size_t mi = 0; mi < channels.size(); ++mi) {
                    if (mi) ss << L',';
                    ss << channels[mi].floatCount;
                }
                ss << L"]}";
            }

            Mtl* multiMtl = FindMultiSubMtl(node.node->GetMtl());
            if (!node.spline && ShouldEmitMultiSubMaterialGroups(multiMtl, node.groups)) {
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
            runtimeFeatures.geospatialSky =
                options.includeGeospatialSky &&
                envData.skyModel == threejs_sky_model_planetary;
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
        ss << L",";
        WriteWebAppsJson(ss, ip, t, true, false, false);
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
                        CopyBinaryIndices(buffer, group.iOff, group.indices, group.iType);
                    }
                    if (!group.uvs.empty()) {
                        CopyBinaryUvs(buffer, group.uvOff, group.uvs, group.uvType);
                    }
                    if (!group.norms.empty()) {
                        CopyBinaryNormals(buffer, group.nOff, group.norms, group.nType);
                    }
                    if (!group.transforms.empty()) {
                        CopyBinaryInstanceTransforms(
                            buffer,
                            group.xformOff,
                            group.transforms,
                            group.xformType);
                    }

                    ss << L"{\"src\":" << group.groupKey;
                    ss << L",\"kind\":\"" << InstanceGroupKindName(group.kind) << L"\"";
                    ss << L",\"key\":\"" << InstanceGroupKindName(group.kind) << L":" << group.ownerKey << L":" << group.groupKey << L"\"";
                    ss << L",\"count\":" << group.instanceCount;
                    ss << L",\"geo\":{\"vOff\":" << group.vOff
                       << L",\"vN\":" << group.vN
                       << L",\"iOff\":" << group.iOff
                       << L",\"iN\":" << group.iN;
                    if (!group.iType.empty()) {
                        ss << L",\"iType\":\"" << group.iType << L"\"";
                    }
                    if (group.uvN > 0) {
                        ss << L",\"uvOff\":" << group.uvOff
                           << L",\"uvN\":" << group.uvN;
                        if (!group.uvType.empty()) {
                            ss << L",\"uvType\":\"" << group.uvType << L"\"";
                        }
                    }
                    if (group.nN > 0) {
                        ss << L",\"nOff\":" << group.nOff
                           << L",\"nN\":" << group.nN;
                        if (!group.nType.empty()) {
                            ss << L",\"nType\":\"" << group.nType << L"\"";
                        }
                    }
                    ss << L"}";
                    ss << L",\"xformOff\":" << group.xformOff;
                    ss << L",\"xformN\":" << group.xformN;
                    ss << L",\"xformType\":\"" << (group.xformType.empty() ? L"f32m16" : group.xformType) << L"\"";
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
            runtimeFeatures.morphTargets += static_cast<int>(node.morphTargets.size());
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
                            const std::wstring& localHdriFileName,
                            const std::wstring& localHdriBase64,
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

        if (!CopySnapshotRuntimeSeed(
                webDir,
                outDir,
                options.includeSplats,
                options.includeRapierVendor,
                options.includeGeospatialSky,
                error)) {
            cleanupOnFail();
            return false;
        }

        std::wstring snapshotUiJsonForExport = snapshotUiJson;
        if (options.includeSnapshotUi && !localHdriBase64.empty()) {
            std::string localHdriBytes;
            if (!DecodeBase64Wide(localHdriBase64, localHdriBytes)) {
                error = L"Invalid local HDRI snapshot payload";
                cleanupOnFail();
                return false;
            }

            std::wstring localHdriRelativePath;
            if (!WriteSnapshotInlineAsset(
                    localHdriBytes,
                    localHdriFileName.empty() ? L"local_hdri.hdr" : localHdriFileName,
                    outDir,
                    L"hdri",
                    localHdriRelativePath,
                    error)) {
                cleanupOnFail();
                return false;
            }
            InjectSnapshotUiHdriUrl(snapshotUiJsonForExport, localHdriRelativePath);
        }

        std::wstring metaJson;
        std::string binary;
        std::string animBinary;
        if (!BuildSnapshotBinary(metaJson, binary, animBinary, snapshotUiJsonForExport, runtimeSceneJson, options, error)) {
            cleanupOnFail();
            return false;
        }

        if (options.copyAssets) {
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

        // Gate the tsl-textures preset library into the snapshot only when the scene
        // actually references it (preset snippets use the injected TEXTURES namespace).
        // Do not delete an existing vendor folder when unused; re-export must preserve
        // standalone site edits.
        {
            const std::wstring outTslVendor = outDir + L"\\vendor\\tsl-textures";
            if (metaJson.find(L"TEXTURES") != std::wstring::npos) {
                const std::wstring tslVendor = webDir + L"\\vendor\\tsl-textures";
                if (DirectoryExists(tslVendor)) {
                    CopyDirectoryRecursive(tslVendor, outTslVendor);
                }
            }
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
            const std::wstring snapshotManifestPath = outDir + L"\\project.maxjs.json";
            if (!ShouldPreserveSnapshotSidecarDestination(
                    std::filesystem::path(projectManifestPath),
                    std::filesystem::path(snapshotManifestPath))) {
                const std::wstring manifestText = FilterProjectManifestForSnapshot(
                    ReadUtf8File(projectManifestPath),
                    GetInlineLayerDir());
                if (!WriteUtf8File(snapshotManifestPath, manifestText)) {
                    error = L"Failed to copy project.maxjs.json into snapshot";
                    cleanupOnFail();
                    return false;
                }
            }
        }

        const std::wstring inlineDir = GetInlineLayerDir();
        if (!inlineDir.empty() && DirectoryExists(inlineDir)) {
            if (!CopyInlineDirectoryForSnapshot(
                    inlineDir,
                    outDir + L"\\inlines",
                    options.includeDisabledLayers)) {
                error = L"Failed to copy inlines into snapshot";
                cleanupOnFail();
                return false;
            }
        }

        // Copy postfx state when snapshotUi is included
        if (options.includeSnapshotUi) {
            const std::wstring postFxPath = GetProjectPostFxPath();
            if (!postFxPath.empty() && FileExists(postFxPath)) {
                if (!CopySnapshotSidecarFilePreservingStandaloneEdits(postFxPath, outDir + L"\\postfx.maxjs.json")) {
                    error = L"Failed to copy postfx.maxjs.json into snapshot";
                    cleanupOnFail();
                    return false;
                }
            }
        }

        const std::wstring settingsPath = GetProjectSettingsPath();
        if (!settingsPath.empty() && FileExists(settingsPath)) {
            if (!CopySnapshotSidecarFilePreservingStandaloneEdits(settingsPath, outDir + L"\\settings.maxjs.json")) {
                error = L"Failed to copy settings.maxjs.json into snapshot";
                cleanupOnFail();
                return false;
            }
        }

        // Optional project website shell. This is deliberately copied as a
        // sidecar instead of replacing snapshot.html: MaxJS owns the neutral
        // snapshot player, projects can layer their own deployable UI on top.
        const std::wstring siteShellPath = GetProjectSiteShellPath();
        if (!siteShellPath.empty() && FileExists(siteShellPath)) {
            if (!CopySnapshotSidecarFilePreservingStandaloneEdits(siteShellPath, outDir + L"\\site.html")) {
                error = L"Failed to copy site.html into snapshot";
                cleanupOnFail();
                return false;
            }
        }

        return true;
    }

    bool ServeSnapshotSite(const std::wstring& snapshotDir,
                           std::wstring& url,
                           std::wstring& error) {
        url.clear();
        error.clear();
        if (snapshotDir.empty()) {
            error = L"Export a snapshot first";
            return false;
        }
        if (!DirectoryExists(snapshotDir)) {
            error = L"Snapshot folder not found";
            return false;
        }
        if (!FileExists(snapshotDir + L"\\snapshot.json")) {
            error = L"Snapshot folder is missing snapshot.json";
            return false;
        }
        if (!FileExists(snapshotDir + L"\\index.html") && !FileExists(snapshotDir + L"\\snapshot.html")) {
            error = L"Snapshot folder is missing index.html";
            return false;
        }

        if (snapshotServePath_ == snapshotDir && !snapshotServeUrl_.empty()) {
            url = snapshotServeUrl_;
            ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
            return true;
        }

        const int port = PickSnapshotServePort();
        if (port <= 0) {
            error = L"No free localhost port found for snapshot server";
            return false;
        }
        std::wstring command =
            L"cmd.exe /d /s /c npx --yes http-server \".\" -p " +
            std::to_wstring(port) +
            L" -a 127.0.0.1 -c-1";

        STARTUPINFOW si = {};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi = {};
        if (!CreateProcessW(
                nullptr,
                command.data(),
                nullptr,
                nullptr,
                FALSE,
                CREATE_NO_WINDOW,
                nullptr,
                snapshotDir.c_str(),
                &si,
                &pi)) {
            error = L"Failed to start snapshot server. Install Node/npm or run the snapshot from disk.";
            return false;
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        snapshotServePath_ = snapshotDir;
        snapshotServeUrl_ = L"http://127.0.0.1:" + std::to_wstring(port) + L"/snapshot.html?root=.";
        url = snapshotServeUrl_;
        Sleep(600);
        ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        return true;
    }

    static bool IsLocalTcpPortAvailable(int port) {
        if (port <= 0 || port > 65535) return false;

        WSADATA wsaData = {};
        if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) return false;

        SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s == INVALID_SOCKET) {
            WSACleanup();
            return false;
        }

        sockaddr_in addr = {};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons(static_cast<u_short>(port));

        const bool available = bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
        closesocket(s);
        WSACleanup();
        return available;
    }

    int PickSnapshotServePort() {
        const int first = 9876 + (snapshotServeSerial_ % 200);
        for (int i = 0; i < 200; ++i) {
            const int port = 9876 + ((first - 9876 + i) % 200);
            if (IsLocalTcpPortAvailable(port)) {
                snapshotServeSerial_ = (port - 9876 + 1) % 200;
                return port;
            }
        }
        for (int port = 12000; port < 13000; ++port) {
            if (IsLocalTcpPortAvailable(port)) return port;
        }
        return 0;
    }
