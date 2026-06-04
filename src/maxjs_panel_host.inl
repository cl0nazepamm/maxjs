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
    size_t materialScanCursor_ = 0;
    size_t lightScanCursor_ = 0;
    size_t splatScanCursor_ = 0;
    size_t jsmodScanCursor_ = 0;
    size_t pluginInstScanCursor_ = 0;
    size_t propertyScanCursor_ = 0;
    size_t deformLiveScanCursor_ = 0;
    std::unordered_set<ULONG> geomHandles_;
    std::unordered_set<ULONG> lightHandles_;
    std::unordered_set<ULONG> splatHandles_;
    std::unordered_set<ULONG> audioHandles_;
    std::unordered_set<ULONG> gltfHandles_;
    std::unordered_set<ULONG> hairHandles_;
    std::unordered_set<ULONG> helperHandles_;
    // Meshes with a modifier stack whose output can change between frames
    // independent of transform events (Path Deform, Skin, Bend, FFD, etc.).
    // Polled every redraw so animation playback catches deformation without
    // waiting for DetectGeometryChanges (~500ms) to run.
    std::unordered_set<ULONG> deformHandles_;
    std::unordered_set<ULONG> fastDirtyHandles_;
    std::unordered_set<ULONG> selectionDirtyHandles_;
    bool selectionRescanDirty_ = false;
    std::unordered_set<ULONG> visibilityDirtyHandles_;
    std::unordered_map<ULONG, std::array<float, 16>> lastSentTransforms_;
    std::unordered_map<ULONG, uint64_t> mtlHashMap_;   // node handle → material structure hash
    std::unordered_map<ULONG, uint64_t> mtlScalarHashMap_; // node handle -> non-fast material scalar hash
    std::unordered_map<ULONG, uint64_t> mtlFastScalarHashMap_; // node handle -> delta material scalar hash
    std::unordered_map<ReferenceTarget*, std::vector<ULONG>> materialEditHandleCache_; // edited material/map -> dependent node handles
    std::unordered_map<ULONG, uint64_t> lightHashMap_; // node handle → light state hash
    std::unordered_map<ULONG, uint64_t> splatHashMap_; // node handle → splat source state hash
    std::unordered_map<ULONG, uint64_t> audioHashMap_; // node handle → audio source state hash
    std::unordered_map<ULONG, uint64_t> gltfHashMap_;  // node handle → gltf source state hash
    std::unordered_map<ULONG, uint64_t> geoHashMap_;   // node handle → geometry topology hash
    std::unordered_map<ULONG, int> geoFastTriangleCountMap_; // node handle -> capped triangle count for geo_fast eligibility
    std::unordered_map<ULONG, uint64_t> deformChannelHashMap_; // node handle -> UV/topology hash for deform fast path
    std::unordered_map<ULONG, std::vector<MatGroup>> groupCache_; // cached material groups per node
    std::unordered_map<ULONG, uint64_t> propHashMap_;  // node handle → object properties hash
    std::unordered_map<ULONG, bool> jsmodStateMap_;    // node handle → last-seen three.js Deform flag
    std::unordered_set<ULONG> skinnedHandles_;             // geom handles with Skin modifier
    std::unordered_map<ULONG, std::vector<int>> skinnedControlIdxCache_; // render vertex -> control vertex
    std::unordered_map<ULONG, std::vector<FastVertexSource>> skinnedFastSourceCache_; // render vertex -> normal/position source
    ULONGLONG lastSkinnedLivePollTick_ = 0;
    ULONGLONG lastCameraLivePollTick_ = 0;
    ULONGLONG lastRedrawLivePollTick_ = 0;
    ULONGLONG lastInteractionTick_ = 0;
    ULONGLONG lastTimelineInteractionTick_ = 0;
    ULONGLONG lastTransformInteractionTick_ = 0;
    bool haveLastTimerTime_ = false;
    TimeValue lastTimerTime_ = 0;
    bool haveLastPlaybackPollTime_ = false;
    TimeValue lastPlaybackPollTime_ = 0;
    bool haveLastDeformLivePollTime_ = false;
    TimeValue lastDeformLivePollTime_ = 0;
    HANDLE syncTimerQueueTimer_ = nullptr;
    HANDLE activeShadeTimerQueueTimer_ = nullptr;
    bool syncTimerUsesWndTimer_ = false;
    bool activeShadeTimerUsesWndTimer_ = false;
    volatile LONG syncTickPosted_ = 0;
    volatile LONG activeShadeTickPosted_ = 0;
    std::unordered_set<ULONG> pluginInstHandles_;        // FP/RC/tyFlow node handles for change detection
    std::unordered_map<ULONG, uint64_t> pluginInstHash_; // plugin node → generated-instance dependency hash

    std::map<std::wstring, std::wstring> texDirMap_;    // dir → host
    int texDirCount_ = 0;
    bool lastClayMode_ = false;
    std::wstring activeWebDir_;
    std::uint64_t activeWebStamp_ = 0;
    bool productionRenderContentActive_ = false;
    std::wstring activeProjectDir_;
    std::uint64_t activeProjectStamp_ = 0;
    int suppressProjectReloadCount_ = 0;
    bool fastCameraDirty_ = false;
    bool fastTimeDirty_ = false;
    bool fastFlushPosted_ = false;
    bool fastFlushInProgress_ = false;
    bool suppressFastFlushPost_ = false;
    bool pendingTimelineTransformScan_ = false;
    bool pendingTimelineDeformScan_ = false;
    bool pendingTimelineCameraCheck_ = false;
    bool playbackFlushPending_ = false;
    TimeValue playbackFlushTime_ = 0;
    ULONGLONG idlePollAuditUntilTick_ = 0;
    bool idlePollFullSyncPending_ = false;
    ULONGLONG nextIdlePollFullSyncTick_ = 0;
    std::unordered_map<ULONG, uint64_t> idleMaterialFullSyncCandidateHash_;
    std::unordered_map<ULONG, uint64_t> idleJsModFullSyncCandidateHash_;
    std::unordered_map<ULONG, uint64_t> idlePluginInstFullSyncCandidateHash_;
    std::unordered_map<ULONG, uint64_t> idlePropertyFullSyncCandidateHash_;
    bool haveLastSentCamera_ = false;
    ULONGLONG dirtyStamp_ = 0;   // when dirty_ was last set (for debounce)
    ULONGLONG lastMaterialInteractionTick_ = 0;
    ULONGLONG lastMaterialLivePollTick_ = 0;
    CameraData lastSentCamera_ = {};
    CameraData renderCameraOverride_ = {};
    bool renderCameraOverrideActive_ = false;
    bool renderSequenceActive_ = false;
    bool renderSequenceQueued_ = false;
    bool renderSequenceFrameInFlight_ = false;
    std::wstring renderSequenceBasePath_;
    std::wstring renderSequenceMime_;
    int renderSequenceWidth_ = 0;
    int renderSequenceHeight_ = 0;
    int renderSequenceStartFrame_ = 0;
    int renderSequenceEndFrame_ = 0;
    int renderSequenceStep_ = 1;
    int renderSequenceCurrentFrame_ = 0;
    TimeValue renderSequencePreviousTime_ = 0;
    INode* renderSequenceViewNode_ = nullptr;
    ViewParams renderSequenceViewParams_ = {};
    bool renderSequenceHaveViewParams_ = false;
    bool renderSequenceRestoreTime_ = false;
    bool renderSequenceFirstFrame_ = true;
    std::wstring renderSequenceLastError_;
    ULONG lockedCameraHandle_ = 0;  // 0 = viewport (default), nonzero = scene camera handle
    int pathTracingSamplesPerFrame_ = 1;
    float pathTracingGIClamp_ = 20.0f;
    bool pathTracingFreezeSync_ = false;
    bool pathTracingViewerActive_ = false;
    bool pathTracingHasSceneSync_ = false;
    bool pendingSnapshotExportRequest_ = false;
    std::wstring lastSnapshotExportPath_;
    std::wstring snapshotServePath_;
    std::wstring snapshotServeUrl_;
    int snapshotServeSerial_ = 0;
    bool slowJsonSyncMode_ = false;
    ULONGLONG lastSlowJsonSyncTick_ = 0;
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
        std::wstring stamp;        // content identity from file write time + size
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

            ULARGE_INTEGER size = {};
            size.LowPart = fd.nFileSizeLow;
            size.HighPart = fd.nFileSizeHigh;
            entry.stamp =
                std::to_wstring(FileTimeToUint64(fd.ftLastWriteTime)) +
                L"-" +
                std::to_wstring(size.QuadPart);

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
        const std::uint64_t dirStamp = dir.empty() ? 0 : GetDirectoryWriteStamp(dir);
        ss << L"{\"type\":\"inline_layers_state\",\"stamp\":\"" << dirStamp << L"\",\"layers\":[";
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
               << L"\",\"stamp\":\"" << EscapeJson(layer.stamp.c_str())
               << L"\",\"priority\":" << layer.priority
               << L",\"enabled\":" << (layer.enabled ? L"true" : L"false") << L'}';
        }
        ss << L"]}";

        const std::wstring payload = ss.str();
        if (!force && payload == inlineLayersStateSignature_) return;
        inlineLayersStateSignature_ = payload;
        webview_->PostWebMessageAsJson(payload.c_str());
    }

    void RequestSnapshotExport() {
        pendingSnapshotExportRequest_ = true;
        if (!webview_ || !jsReady_) return;

        pendingSnapshotExportRequest_ = false;
        webview_->PostWebMessageAsJson(L"{\"type\":\"snapshot_export_request\",\"source\":\"maxscript\"}");
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
        std::wstring browserArgs =
            L"--enable-features=WebXR,WebXRARModule,OpenXR,CanvasDrawElement "
            L"--enable-blink-features=CanvasDrawElement";
        // Opt-in remote DevTools Protocol for profiling. Set MAXJS_DEBUG_PORT=9222
        // (or any free port) before launching 3ds Max, then connect chrome://inspect
        // or chrome-devtools MCP to http://127.0.0.1:9222 to get heap snapshots,
        // render counters, and the full DevTools surface.
        {
            wchar_t portBuf[32] = {};
            DWORD portLen = GetEnvironmentVariableW(L"MAXJS_DEBUG_PORT", portBuf,
                static_cast<DWORD>(std::size(portBuf)));
            if (portLen > 0 && portLen < std::size(portBuf)) {
                browserArgs += L" --remote-debugging-port=";
                browserArgs += portBuf;
            }
        }
        options->put_AdditionalBrowserArguments(browserArgs.c_str());

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
                    bool transcodedTiff = false;
                    if (IsTiffPath(decodedPath)) {
                        transcodedTiff = CreatePngStreamFromWicImage(decodedPath, &stream) && stream;
                    }

                    if (!stream && (FAILED(SHCreateStreamOnFileEx(decodedPath.c_str(), STGM_READ | STGM_SHARE_DENY_NONE,
                        FILE_ATTRIBUTE_NORMAL, FALSE, nullptr, &stream)) || !stream)) {
                        ComPtr<ICoreWebView2WebResourceResponse> response;
                        env_->CreateWebResourceResponse(nullptr, 500, L"Open Failed",
                            L"Content-Type: text/plain\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: https://maxjs.local\r\nCross-Origin-Resource-Policy: cross-origin\r\n", &response);
                        args->put_Response(response.Get());
                        return S_OK;
                    }

                    const std::wstring mimeType =
                        transcodedTiff ? std::wstring(L"image/png") : std::wstring(GetMimeTypeForPath(decodedPath));
                    const wchar_t* kBaseHeaders =
                        L"Cache-Control: no-store\r\nAccess-Control-Allow-Origin: https://maxjs.local\r\nCross-Origin-Resource-Policy: cross-origin\r\n";

                    // Honor HTTP Range requests so <video>/<audio> media elements
                    // can stream and seek. Chromium issues "Range: bytes=0-" for
                    // media and expects a 206; a plain 200 leaves video textures
                    // stuck/black. TIFF transcodes are small in-memory PNGs —
                    // serve those whole.
                    unsigned long long totalSize = 0;
                    if (!transcodedTiff) {
                        STATSTG st = {};
                        if (SUCCEEDED(stream->Stat(&st, STATFLAG_NONAME)))
                            totalSize = st.cbSize.QuadPart;
                    }

                    unsigned long long rangeStart = 0, rangeEnd = 0;
                    bool isRange = false;
                    if (!transcodedTiff && totalSize > 0) {
                        ComPtr<ICoreWebView2HttpRequestHeaders> reqHeaders;
                        if (SUCCEEDED(request->get_Headers(&reqHeaders)) && reqHeaders) {
                            BOOL hasRange = FALSE;
                            LPWSTR rangeVal = nullptr;
                            if (SUCCEEDED(reqHeaders->Contains(L"Range", &hasRange)) && hasRange &&
                                SUCCEEDED(reqHeaders->GetHeader(L"Range", &rangeVal)) && rangeVal) {
                                isRange = ParseHttpByteRange(rangeVal, totalSize, rangeStart, rangeEnd);
                                CoTaskMemFree(rangeVal);
                            }
                        }
                    }

                    if (isRange) {
                        // Cap the slice so an open-ended "bytes=0-" doesn't buffer a
                        // whole movie into memory; Chromium re-requests as it plays.
                        constexpr unsigned long long kMaxRangeChunk = 8ull * 1024 * 1024;
                        if (rangeEnd - rangeStart + 1 > kMaxRangeChunk)
                            rangeEnd = rangeStart + kMaxRangeChunk - 1;
                        const unsigned long long length = rangeEnd - rangeStart + 1;

                        std::vector<BYTE> buf(static_cast<size_t>(length));
                        LARGE_INTEGER seek;
                        seek.QuadPart = static_cast<LONGLONG>(rangeStart);
                        ULONG readBytes = 0;
                        if (SUCCEEDED(stream->Seek(seek, STREAM_SEEK_SET, nullptr)) &&
                            SUCCEEDED(stream->Read(buf.data(), static_cast<ULONG>(length), &readBytes)) &&
                            readBytes > 0) {
                            ComPtr<IStream> memStream;
                            memStream.Attach(SHCreateMemStream(buf.data(), readBytes));
                            if (memStream) {
                                std::wstring h = L"Content-Type: " + mimeType + L"\r\n";
                                h += kBaseHeaders;
                                h += L"Accept-Ranges: bytes\r\n";
                                h += L"Content-Range: bytes " + std::to_wstring(rangeStart) + L"-" +
                                     std::to_wstring(rangeStart + readBytes - 1) + L"/" +
                                     std::to_wstring(totalSize) + L"\r\n";
                                h += L"Content-Length: " + std::to_wstring(readBytes) + L"\r\n";
                                ComPtr<ICoreWebView2WebResourceResponse> response;
                                if (SUCCEEDED(env_->CreateWebResourceResponse(
                                        memStream.Get(), 206, L"Partial Content", h.c_str(), &response)) && response) {
                                    args->put_Response(response.Get());
                                    return S_OK;
                                }
                            }
                        }
                        // Any failure falls through to a full 200 response below.
                        LARGE_INTEGER rewind = {};
                        stream->Seek(rewind, STREAM_SEEK_SET, nullptr);
                    }

                    std::wstring headers = L"Content-Type: " + mimeType + L"\r\n";
                    headers += kBaseHeaders;
                    if (!transcodedTiff) headers += L"Accept-Ranges: bytes\r\n";
                    if (transcodedTiff) headers += L"X-MaxJS-Transcoded-From: image/tiff\r\n";

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

    void LoadContent(bool productionRender = false) {
        std::wstring webDir = GetWebDir();
        activeWebDir_ = webDir;
        activeWebStamp_ = GetDirectoryWriteStamp(webDir);
        productionRenderContentActive_ = productionRender;
        texDirMap_.clear();
        jsReady_ = false;

        if (!webDir.empty()) {
            ComPtr<ICoreWebView2_3> wv3;
            webview_->QueryInterface(IID_PPV_ARGS(&wv3));
            if (wv3) {
                wv3->SetVirtualHostNameToFolderMapping(
                    L"maxjs.local", webDir.c_str(),
                    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                // Cache-bust: append tick count to URL so WebView2 never serves stale HTML
                wchar_t navUrl[128];
                swprintf_s(navUrl, L"https://maxjs.local/index.html?v=%lld%s",
                    GetTickCount64(),
                    productionRender ? L"&productionRender=1&renderer=webgl-fallback" : L"");
                webview_->Navigate(navUrl);
                return;
            }
        }
        webview_->NavigateToString(L"<html><body style='background:#1a1a2e;color:#aaa;"
            L"font:14px monospace;display:flex;align-items:center;justify-content:center;"
            L"height:100vh'><div>max.js: web files not found</div></body></html>");
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

    std::wstring GetProjectSettingsPath() {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) return {};
        return projectDir + L"\\settings.maxjs.json";
    }

    std::wstring GetProjectSiteShellPath() {
        const std::wstring projectDir = GetProjectDir();
        if (projectDir.empty()) return {};
        return projectDir + L"\\site.html";
    }
