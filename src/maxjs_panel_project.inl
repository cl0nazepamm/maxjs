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

    void SendPathTracingSettings() {
        if (!webview_ || !jsReady_) return;
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"pathtracing_settings\""
           << L",\"samplesPerFrame\":" << pathTracingSamplesPerFrame_
           << L",\"giClamp\":";
        WriteFloatValue(ss, pathTracingGIClamp_, 20.0f);
        ss
           << L",\"freezeSync\":" << (pathTracingFreezeSync_ ? L"true" : L"false")
           << L"}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    bool IsPathTracingNativeFreezeActive() const {
        return pathTracingViewerActive_ && pathTracingFreezeSync_;
    }

    void SetPathTracingSettings(int samplesPerFrame, float giClamp, bool freezeSync) {
        const bool wasFrozen = IsPathTracingNativeFreezeActive();
        pathTracingSamplesPerFrame_ = std::clamp(samplesPerFrame, 1, 64);
        if (!std::isfinite(giClamp)) giClamp = 20.0f;
        pathTracingGIClamp_ = std::clamp(giClamp, 1.0f, 1000.0f);
        pathTracingFreezeSync_ = freezeSync;
        SendPathTracingSettings();
        if (wasFrozen && !IsPathTracingNativeFreezeActive()) {
            ResetFastPathState(true);
            SetDirtyImmediate();
        }
    }

    void SetPathTracingRuntimeSettings(int samplesPerFrame, float giClamp, bool freezeSync, bool viewerActive) {
        const bool wasFrozen = IsPathTracingNativeFreezeActive();
        pathTracingViewerActive_ = viewerActive;
        SetPathTracingSettings(samplesPerFrame, giClamp, freezeSync);
        if (wasFrozen && !IsPathTracingNativeFreezeActive()) {
            ResetFastPathState(true);
            SetDirtyImmediate();
        }
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
        mtlFastScalarHashMap_.clear();
        ClearMaterialEditHandleCache();
        lightHashMap_.clear();
        splatHashMap_.clear();
        audioHashMap_.clear();
        gltfHashMap_.clear();
        propHashMap_.clear();
        geoHashMap_.clear();
        geoFastTriangleCountMap_.clear();
        deformChannelHashMap_.clear();
        jsmodStateMap_.clear();
        groupCache_.clear();
        lastBBoxHash_.clear();
        lastLiveGeomHash_.clear();
        skinnedControlIdxCache_.clear();
        skinnedFastSourceCache_.clear();
        lastSkinnedLivePollTick_ = 0;
        haveLastTimerTime_ = false;
        lastTimerTime_ = 0;
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
            suppressProjectReloadCount_ = std::max(suppressProjectReloadCount_, 6);
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

    bool WriteProjectSettingsContent(const std::wstring& contentBase64, std::wstring& error) {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) {
            error = L"Save the scene first";
            return false;
        }

        SHCreateDirectoryExW(nullptr, projectDir.c_str(), nullptr);

        std::string decoded;
        if (!DecodeBase64Wide(contentBase64, decoded)) {
            error = L"Invalid base64 settings payload";
            return false;
        }

        const std::wstring settingsPath = GetProjectSettingsPath();
        if (!WriteBinaryFile(settingsPath, decoded)) {
            error = L"Failed to write project settings";
            return false;
        }

        return true;
    }

    bool WriteBakeProxyImage(const std::wstring& folder,
                             const std::wstring& filename,
                             int width,
                             int height,
                             const std::wstring& rgbBase64,
                             std::wstring& error) {
        std::wstring outDir = folder;
        while (!outDir.empty() && iswspace(outDir.front())) outDir.erase(outDir.begin());
        while (!outDir.empty() && iswspace(outDir.back())) outDir.pop_back();
        if (outDir.size() >= 2 &&
            ((outDir.front() == L'"' && outDir.back() == L'"') ||
             (outDir.front() == L'\'' && outDir.back() == L'\''))) {
            outDir = outDir.substr(1, outDir.size() - 2);
        }
        std::replace(outDir.begin(), outDir.end(), L'/', L'\\');

        const bool absoluteDrivePath = outDir.size() >= 3 &&
            iswalpha(outDir[0]) && outDir[1] == L':' &&
            (outDir[2] == L'\\' || outDir[2] == L'/');
        const bool uncPath = outDir.rfind(L"\\\\", 0) == 0;
        if (!absoluteDrivePath && !uncPath) {
            error = L"Bake proxy output folder must be an absolute local path";
            return false;
        }
        if (filename.empty() ||
            filename.find(L"..") != std::wstring::npos ||
            filename.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos ||
            _wcsicmp(PathFindExtensionW(filename.c_str()), L".png") != 0) {
            error = L"Invalid bake proxy filename";
            return false;
        }
        if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
            error = L"Invalid bake proxy dimensions";
            return false;
        }

        std::string rgb;
        if (!DecodeBase64Wide(rgbBase64, rgb)) {
            error = L"Invalid bake proxy RGB payload";
            return false;
        }

        if (!outDir.empty() && outDir.back() != L'\\') outDir.push_back(L'\\');
        return WriteRgb24PngFile(outDir + filename,
                                 static_cast<UINT>(width),
                                 static_cast<UINT>(height),
                                 rgb,
                                 error);
    }
