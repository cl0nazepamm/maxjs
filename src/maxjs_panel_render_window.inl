    // ── Render-to-image (production render) ────────────────

    HANDLE renderImageEvent_ = nullptr;  // signaled when JS confirms frame rendered
    bool renderLocked_ = false;          // panel is locked to render resolution
    bool renderImageWarmed_ = false;     // first production capture needs camera/sync settle time
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
    bool RenderFrameToBitmap(Bitmap* target, int width, int height, TimeValue t,
                             INode* renderViewNode, const ViewParams* renderViewParams,
                             RendProgressCallback* prog) {
        if (!webview_ || !target) return false;

        auto restoreRenderState = [this]() {
            if (webview_) {
                webview_->PostWebMessageAsJson(L"{\"type\":\"render_to_image_done\"}");
            }
            renderCameraOverrideActive_ = false;
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

        // Lock panel to render resolution and keep the WebView controller transparent.
        // The JS render path decides whether the scene/background is opaque or alpha.
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
        const int warmupMs = renderImageWarmed_ ? 250 : 2000;
        wchar_t msg[320];
        swprintf_s(msg, L"{\"type\":\"render_to_image\",\"width\":%d,\"height\":%d,\"frame\":%d,\"fps\":%d,\"warmupMs\":%d}",
                   width, height, frame, fps, warmupMs);

        // Force a fresh scene sync at the requested frame, using 3ds Max's render
        // camera/view state instead of the live viewport or max.js UI camera lock.
        Interface* ip = GetCOREInterface();
        TimeValue previousTime = ip ? ip->GetTime() : t;
        if (ip && previousTime != t) ip->SetTime(t, FALSE);
        CameraData renderCam = {};
        renderCameraOverrideActive_ = GetRenderViewCameraData(renderViewNode, renderViewParams, t, renderCam);
        if (renderCameraOverrideActive_) {
            renderCameraOverride_ = renderCam;
        }

        // Tell JS to resize into render mode before the full sync camera lands.
        // Otherwise horizontal FOV is converted with the docked panel aspect and
        // then appears to zoom when the canvas is resized to the final image size.
        webview_->PostWebMessageAsJson(msg);
        if (useBinary_) SendFullSyncBinary(); else SendFullSync();

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
        if (captureOk) renderImageWarmed_ = true;

        return captureOk;
    }

    // ── ActiveShade capture ─────────────────────────────────

    Bitmap* asTarget_ = nullptr;
    bool asCapturing_ = false;
    bool asCaptureInFlight_ = false;
    // Persistent scratch buffers reused across ActiveShade captures to avoid
    // churning 8MB/frame at 1080p (~120MB/s alloc/free at 15fps cadence).
    std::vector<BYTE> asPixelScratch_;
    std::vector<BMM_Color_64> asLineScratch_;
    ComPtr<IWICImagingFactory> asWicFactory_;
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
    RECT lastControllerBounds_ = {};
    bool haveLastControllerBounds_ = false;
    static constexpr UINT_PTR kHostSubclassId = 0xC0DE5A1Dull;

    // ActiveShade hosted mode: attach once and leave the WebView2 backbuffer
    // alone. Panel resizes must not call controller_->put_Bounds, restart the
    // renderer, or run an aspect-correction recovery path.
    ULONGLONG lastHostResizeMs_ = 0;
    static constexpr DWORD kCaptureSuppressMs = 750;
    int activeShadeHostedWidth_ = 0;
    int activeShadeHostedHeight_ = 0;
    int activeShadeHostClientWidth_ = 0;
    int activeShadeHostClientHeight_ = 0;

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

    void InvalidateControllerBoundsCache() {
        haveLastControllerBounds_ = false;
        lastControllerBounds_ = {};
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
        // fill the whole Max window. Do not resize/collapse the WebView here:
        // even one hosted resize can leak renderer-side resources in
        // ActiveShade. Hiding preserves the fixed backbuffer for unmax.
        Interface* ip = GetCOREInterface();
        if (ip && ip->IsViewportMaxed()) {
            if (IsWindowVisible(hwnd_)) ShowWindow(hwnd_, SW_HIDE);
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
            if (IsWindowVisible(hwnd_)) ShowWindow(hwnd_, SW_HIDE);
            return false;
        }

        activeShadeHostClientWidth_ = width;
        activeShadeHostClientHeight_ = height;

        RECT childWin = {};
        const bool haveChildWin = GetWindowRect(hwnd_, &childWin);
        POINT childOrigin = { childWin.left, childWin.top };
        if (haveChildWin) ScreenToClient(embeddedViewportHwnd_, &childOrigin);
        const bool shellNeedsPanelFit =
            reattached ||
            !IsWindowVisible(hwnd_) ||
            !haveChildWin ||
            childOrigin.x != 0 ||
            childOrigin.y != 0 ||
            (childWin.right - childWin.left) != width ||
            (childWin.bottom - childWin.top) != height;

        // Fit the native shell to the ActiveShade panel, but deliberately do
        // not call Resize(true). The WebView2 controller keeps the initial
        // backbuffer size for the whole session.
        if (shellNeedsPanelFit) {
            SetWindowPos(hwnd_, HWND_TOP, 0, 0,
                width, height,
                SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_SHOWWINDOW);
        }
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
            // Host (Max viewport) resized. Ignore it. ActiveShade keeps the
            // first WebView2 size for the whole session.
            if (self->embeddedViewportHwnd_ == h && self->hwnd_ && IsWindow(self->hwnd_)) {
                self->lastHostResizeMs_ = 0;
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
        StartActiveShadePump();
        RefreshCallbackRegistration(true);
    }

    void StopActiveShade() {
        asCapturing_ = false;
        asCaptureInFlight_ = false;
        asTarget_ = nullptr;
        StopActiveShadePump();
        // Release the 1080p-sized scratch buffers so they don't sit idle
        // between ActiveShade sessions. WIC factory is cheap to keep alive.
        std::vector<BYTE>().swap(asPixelScratch_);
        std::vector<BMM_Color_64>().swap(asLineScratch_);
        RefreshCallbackRegistration();
    }

    // Reparent WebView2 into a viewport HWND — true GPU overlay
    void ReparentIntoViewport(HWND viewportHwnd) {
        if (!hwnd_ || !viewportHwnd || !IsWindow(viewportHwnd)) return;

        if (IsViewportHosted() && embeddedViewportHwnd_ == viewportHwnd) {
            AttachHostSubclass();
            RefreshCallbackRegistration(true);
            return;
        }

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
        InvalidateControllerBoundsCache();

        // Initial attach is the only hosted path allowed to size WebView2.
        RECT vpRect = {};
        GetClientRect(viewportHwnd, &vpRect);
        activeShadeHostedWidth_ = std::max(64, static_cast<int>(vpRect.right - vpRect.left));
        activeShadeHostedHeight_ = std::max(64, static_cast<int>(vpRect.bottom - vpRect.top));
        activeShadeHostClientWidth_ = activeShadeHostedWidth_;
        activeShadeHostClientHeight_ = activeShadeHostedHeight_;
        lastHostResizeMs_ = 0;
        SetWindowPos(hwnd_, HWND_TOP, 0, 0,
            activeShadeHostedWidth_, activeShadeHostedHeight_,
            SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        Resize(true);

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
        InvalidateControllerBoundsCache();
        const RECT& restoreRect = haveLastFloatingRect_ ? lastFloatingRect_ : originalRect_;
        SetWindowPos(hwnd_, nullptr,
            restoreRect.left, restoreRect.top,
            restoreRect.right - restoreRect.left,
            restoreRect.bottom - restoreRect.top,
            SWP_NOZORDER | SWP_SHOWWINDOW | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        embeddedViewportHwnd_ = nullptr;
        originalParent_ = nullptr;
        activeShadeHostedWidth_ = 0;
        activeShadeHostedHeight_ = 0;
        activeShadeHostClientWidth_ = 0;
        activeShadeHostClientHeight_ = 0;
        lastHostResizeMs_ = 0;
        Resize();
        NormalizeFloatingWindow(true);
        RefreshCallbackRegistration(true);
    }

    void CaptureActiveShadeFrame() {
        if (!webview_ || !asTarget_ || !asCapturing_) return;
        if (asCaptureInFlight_) return;
        if (!MaintainWindowState()) return;

        // Suppress captures while the host is mid-resize. CapturePreview is the
        // single heaviest thing the plugin does — JPEG encode of the WebView,
        // WIC decode + scale + BGRA convert + Max Bitmap blit — and firing it
        // 15x/sec on top of a browser that's already fighting a resize storm
        // is exactly what drops to 5fps and inflates GPU memory. Once the
        // user stops dragging, normal capture cadence resumes on the next
        // timer tick.
        if (GetTickCount64() - lastHostResizeMs_ < kCaptureSuppressMs) return;

        ComPtr<IStream> stream;
        CreateStreamOnHGlobal(NULL, TRUE, &stream);
        asCaptureInFlight_ = true;

        HRESULT captureStart = webview_->CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
            stream.Get(),
            Callback<ICoreWebView2CapturePreviewCompletedHandler>(
                [this, stream](HRESULT hr) -> HRESULT {
                    auto finish = [this]() -> HRESULT {
                        asCaptureInFlight_ = false;
                        return S_OK;
                    };
                    if (FAILED(hr) || !asTarget_ || !asCapturing_) return finish();

                    // Reset stream
                    LARGE_INTEGER zero = {};
                    stream->Seek(zero, STREAM_SEEK_SET, nullptr);

                    // WIC factory is expensive to create; cache it for the
                    // lifetime of the panel and reuse across captures.
                    if (!asWicFactory_) {
                        CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                            CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&asWicFactory_));
                        if (!asWicFactory_) return finish();
                    }

                    ComPtr<IWICBitmapDecoder> decoder;
                    asWicFactory_->CreateDecoderFromStream(stream.Get(), nullptr,
                        WICDecodeMetadataCacheOnLoad, &decoder);
                    if (!decoder) return finish();

                    ComPtr<IWICBitmapFrameDecode> frame;
                    decoder->GetFrame(0, &frame);
                    if (!frame) return finish();

                    UINT srcW, srcH;
                    frame->GetSize(&srcW, &srcH);
                    if (srcW == 0 || srcH == 0) return finish();

                    // Scale to target bitmap size
                    int dstW = asTarget_->Width();
                    int dstH = asTarget_->Height();
                    if (dstW <= 0 || dstH <= 0) return finish();

                    ComPtr<IWICBitmapScaler> scaler;
                    if (FAILED(asWicFactory_->CreateBitmapScaler(&scaler)) || !scaler) return finish();
                    if (FAILED(scaler->Initialize(frame.Get(), dstW, dstH,
                        WICBitmapInterpolationModeLinear))) return finish();

                    // Convert to BGRA
                    ComPtr<IWICFormatConverter> converter;
                    if (FAILED(asWicFactory_->CreateFormatConverter(&converter)) || !converter) return finish();
                    if (FAILED(converter->Initialize(scaler.Get(),
                        GUID_WICPixelFormat32bppBGRA,
                        WICBitmapDitherTypeNone, nullptr, 0,
                        WICBitmapPaletteTypeCustom))) return finish();

                    // Reuse persistent scratch buffers — this used to allocate
                    // 8MB/frame at 1080p (~120MB/s churn) plus free on exit.
                    const size_t pixelBytes = static_cast<size_t>(dstW) * dstH * 4;
                    if (asPixelScratch_.size() < pixelBytes) asPixelScratch_.resize(pixelBytes);
                    if (asLineScratch_.size() < static_cast<size_t>(dstW)) asLineScratch_.resize(dstW);

                    if (FAILED(converter->CopyPixels(nullptr, dstW * 4,
                        static_cast<UINT>(pixelBytes), asPixelScratch_.data()))) return finish();

                    // Scanline-at-a-time write instead of per-pixel. The
                    // per-pixel call was 2M PutPixels/frame at 1080p (30M/sec
                    // at 15fps) — all SDK-boundary overhead. One call per
                    // scanline cuts that ~2000x.
                    BMM_Color_64* line = asLineScratch_.data();
                    const BYTE* src = asPixelScratch_.data();
                    for (int y = 0; y < dstH; y++) {
                        for (int x = 0; x < dstW; x++) {
                            const int idx = x * 4;
                            line[x].b = static_cast<WORD>(src[idx + 0]) << 8;
                            line[x].g = static_cast<WORD>(src[idx + 1]) << 8;
                            line[x].r = static_cast<WORD>(src[idx + 2]) << 8;
                            line[x].a = 0xFFFF;
                        }
                        asTarget_->PutPixels(0, y, dstW, line);
                        src += dstW * 4;
                    }
                    asTarget_->RefreshWindow();

                    return finish();
                }).Get());
        if (FAILED(captureStart)) asCaptureInFlight_ = false;
    }

    // ── Window management ────────────────────────────────────

    void Resize(bool allowHosted = false) {
        if (!allowHosted && IsViewportHosted()) return;
        if (!controller_ || !hwnd_) return;
        RECT b;
        if (!GetClientRect(hwnd_, &b)) return;
        if ((b.right - b.left) <= 0 || (b.bottom - b.top) <= 0) return;
        if (haveLastControllerBounds_ && EqualRect(&b, &lastControllerBounds_)) return;
        controller_->put_Bounds(b);
        lastControllerBounds_ = b;
        haveLastControllerBounds_ = true;
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
        selectionDirtyHandles_.clear();
        selectionRescanDirty_ = false;
        lastSentTransforms_.clear();
        geomHandles_.clear();
        skinnedHandles_.clear();
        lightHandles_.clear();
        splatHandles_.clear();
        audioHandles_.clear();
        gltfHandles_.clear();
        hairHandles_.clear();
        helperHandles_.clear();
        deformHandles_.clear();
        mtlHashMap_.clear();
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
        mtlScalarHashMap_.clear();
        mtlFastScalarHashMap_.clear();
        ClearMaterialEditHandleCache();
        skinnedControlIdxCache_.clear();
        skinnedFastSourceCache_.clear();
        lastSkinnedLivePollTick_ = 0;
        haveLastTimerTime_ = false;
        lastTimerTime_ = 0;
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
                if (!p->IsViewportHosted()) p->RememberFloatingBounds();
            }
            return 0;
        case WM_MOVE:
            if (p && !p->IsViewportHosted()) p->RememberFloatingBounds();
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
            if (p) p->FlushFastPathNow();
            return 0;
        case WM_PLAYBACK_FLUSH:
            if (p) p->FlushPostedPlaybackSync();
            return 0;
        case WM_SYNC_TICK:
            if (p) {
                InterlockedExchange(&p->syncTickPosted_, 0);
                p->OnTimer();
            }
            return 0;
        case WM_AS_TICK:
            if (p) {
                InterlockedExchange(&p->activeShadeTickPosted_, 0);
                p->CaptureActiveShadeFrame();
            }
            return 0;
        case WM_EXPORT_SNAPSHOT:
            if (p) p->RequestSnapshotExport();
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
