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
        std::wstring mapped = MapAssetPath(filePath, false);
        if (!mapped.empty()) return mapped;

        const std::wstring resolvedPath = ResolveTextureFilePath(filePath);
        return resolvedPath.empty() ? std::wstring{} : MapAssetPath(resolvedPath, false);
    }

    std::wstring MapAudioPath(const std::wstring& filePath) {
        std::wstring mapped = MapAssetPath(filePath, false);
        if (!mapped.empty()) return mapped;

        const std::wstring resolvedPath = ResolveAudioFilePath(filePath);
        return resolvedPath.empty() ? std::wstring{} : MapAssetPath(resolvedPath, false);
    }

    std::wstring MapWebAppUrl(const std::wstring& rawUrl) {
        if (rawUrl.empty()) return {};
        // Web URLs pass through untouched; absolute disk paths map onto the
        // same-origin asset host. Anything else (project-relative path) is
        // resolved by the viewer against the active project root.
        if (rawUrl.rfind(L"http://", 0) == 0 || rawUrl.rfind(L"https://", 0) == 0 ||
            rawUrl.rfind(L"data:", 0) == 0) {
            return rawUrl;
        }
        if (rawUrl.size() >= 3 && rawUrl[1] == L':') {
            std::wstring mapped = MapAssetPath(rawUrl, false);
            return mapped.empty() ? rawUrl : mapped;
        }
        return rawUrl;
    }

    // ── Callbacks & sync ─────────────────────────────────────

    bool IsTrackedHandle(ULONG handle) const {
        return geomHandles_.find(handle) != geomHandles_.end()
            || lightHandles_.find(handle) != lightHandles_.end()
            || splatHandles_.find(handle) != splatHandles_.end()
            || audioHandles_.find(handle) != audioHandles_.end()
            || gltfHandles_.find(handle) != gltfHandles_.end()
            || webappHandles_.find(handle) != webappHandles_.end()
            || hairHandles_.find(handle) != hairHandles_.end()
            || helperHandles_.find(handle) != helperHandles_.end();
    }

    bool HasTrackedNodes() const {
        return !geomHandles_.empty() || !lightHandles_.empty() || !splatHandles_.empty()
            || !audioHandles_.empty() || !gltfHandles_.empty() || !webappHandles_.empty()
            || !hairHandles_.empty()
            || !helperHandles_.empty();
    }

    // Debounced dirty: coalesces rapid-fire notifications (e.g. clone) into one full sync
    static constexpr ULONGLONG DIRTY_DEBOUNCE_MS = 150;
    static constexpr ULONGLONG SLOW_JSON_SYNC_INTERVAL_MS = 1000;

    void SetDirty(bool armIdlePollAudit = true) {
        if (slowJsonSyncMode_) return;
        if (armIdlePollAudit) ArmIdlePollAuditWindow();
        if (!dirty_) {
            dirty_ = true;
            dirtyStamp_ = GetTickCount64();
        }
    }

    void SetDirtyImmediate(bool armIdlePollAudit = true) {
        if (slowJsonSyncMode_) return;
        idlePollFullSyncPending_ = false;
        if (armIdlePollAudit) ArmIdlePollAuditWindow();
        dirty_ = true;
        dirtyStamp_ = 0;  // bypass debounce — sync on next tick
    }

    void RequestFullGeometryResync() {
        geoHashMap_.clear();
        geoFastTriangleCountMap_.clear();
        deformChannelHashMap_.clear();
        lastBBoxHash_.clear();
        lastLiveGeomHash_.clear();
        geoFastDirtyHandles_.clear();
        geoFullFastDirtyHandles_.clear();
        geoScanCursor_ = 0;
        SetDirtyImmediate();
    }

    void QueueFastFlush() {
        if (slowJsonSyncMode_) return;
        if (!hwnd_ || fastFlushPosted_) return;
        if (dirty_ && !CanFlushFastPathDuringPendingFullSync()) return;
        if (suppressFastFlushPost_) return;
        fastFlushPosted_ = true;
        if (!PostMessage(hwnd_, WM_FAST_FLUSH, 0, 0)) {
            fastFlushPosted_ = false;
        }
    }

    void FlushFastPathNow() {
        if (slowJsonSyncMode_) return;
        if (fastFlushInProgress_) {
            QueueFastFlush();
            return;
        }
        fastFlushInProgress_ = true;
        FlushFastPath();
        fastFlushInProgress_ = false;
    }
