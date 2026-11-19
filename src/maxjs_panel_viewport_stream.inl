    // Viewport stream, host side: the shared frame buffer the viewer writes its rendered frames
    // into, and the frame hand-off to the Nitrous viewport fragment (maxjs_viewport_fragment.cpp).
    // Included inside MaxJSPanel. Layout and protocol: maxjs_viewport_stream.h.

    struct ViewportStreamStats {
        std::uint64_t framesAnnounced = 0;   // viewport_frame messages from the viewer
        std::uint64_t framesAcquired = 0;    // frames handed to the viewport fragment
        std::uint64_t lockBusy = 0;          // redraws that found the viewer writing
        std::uint64_t rejected = 0;          // frames whose header did not fit the buffer
        std::uint64_t lockstepAnswered = 0;
        std::uint64_t lockstepTimedOut = 0;
        double lockstepWaitMsTotal = 0.0;
        double lockstepWaitMsMax = 0.0;
    };

    ComPtr<ICoreWebView2SharedBuffer> vpStreamBuffer_;
    BYTE* vpStreamPtr_ = nullptr;
    std::uint64_t vpStreamCapacity_ = 0;         // pixel bytes after the header
    bool vpStreamEnabled_ = false;
    bool vpStreamRepaintPosted_ = false;
    int vpStreamWidth_ = 0;
    int vpStreamHeight_ = 0;
    int vpStreamMaxFps_ = 0;
    std::uint32_t vpStreamRequestSeq_ = 0;
    // The camera the frame in the buffer was rendered with, as far as the host can tell.
    CameraData vpStreamFrameCamera_ = {};
    bool vpStreamHaveFrameCamera_ = false;
    CameraData vpStreamRequestedCamera_ = {};
    std::uint32_t vpStreamRequestedSeq_ = 0;
    // A request that timed out holds further requests back, longer each time in a row.
    ULONGLONG vpStreamLockstepHoldUntil_ = 0;
    DWORD vpStreamLockstepBackoffMs_ = kViewportLockstepBackoffMinMs;
    ViewportStreamStats vpStreamStats_;

    static constexpr DWORD kViewportLockstepBackoffMinMs = 250;
    static constexpr DWORD kViewportLockstepBackoffMaxMs = 8000;

    // While the stream runs the frame is in the 3ds Max viewport, so the panel window is concealed.
    // It cannot simply be hidden: a hidden window stops the WebView's frame loop, and the stream
    // with it. Fully transparent and click-through instead, it keeps rendering, takes no input and
    // is not in the way.
    bool vpStreamPanelConcealed_ = false;
    bool vpStreamPanelWasVisible_ = true;  // what the stream found, and puts back when it stops

    bool IsViewportStreamOn() const { return vpStreamEnabled_; }
    bool IsPanelConcealed() const { return vpStreamPanelConcealed_; }

    void SetPanelConcealed(bool concealed) {
        if (!hwnd_ || concealed == vpStreamPanelConcealed_) return;
        vpStreamPanelConcealed_ = concealed;
        const LONG_PTR exStyle = GetWindowLongPtr(hwnd_, GWL_EXSTYLE);
        const LONG_PTR concealBits = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
        if (concealed) {
            SetWindowLongPtr(hwnd_, GWL_EXSTYLE, exStyle | concealBits);
            SetLayeredWindowAttributes(hwnd_, 0, 0, LWA_ALPHA);
            // The keyboard must not stay with a window nobody can see.
            Interface* ip = GetCOREInterface();
            HWND maxWnd = ip ? ip->GetMAXHWnd() : nullptr;
            if (maxWnd && GetForegroundWindow() == hwnd_) SetForegroundWindow(maxWnd);
            if (maxWnd) SetFocus(maxWnd);
        } else {
            SetLayeredWindowAttributes(hwnd_, 0, 255, LWA_ALPHA);
            SetWindowLongPtr(hwnd_, GWL_EXSTYLE, exStyle & ~concealBits);
            SetWindowPos(hwnd_, nullptr, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            RedrawWindow(hwnd_, nullptr, nullptr, RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN);
        }
    }

    // The panel toggle while the stream runs: brings the concealed panel up to reach its controls,
    // and puts it away again. Once the user has asked to see it, it stays open after the stream.
    void ToggleViewportStreamPanel() {
        const bool reveal = vpStreamPanelConcealed_;
        SetPanelConcealed(!reveal);
        if (reveal) {
            vpStreamPanelWasVisible_ = true;
            if (hwnd_) SetForegroundWindow(hwnd_);
        }
    }

    volatile LONG* ViewportStreamWords() const {
        return reinterpret_cast<volatile LONG*>(vpStreamPtr_);
    }

    static std::uint32_t ViewportStreamWord(volatile LONG* words, std::uint32_t index) {
        return static_cast<std::uint32_t>(words[index]);
    }

    void CloseViewportStreamBuffer() {
        if (vpStreamBuffer_) vpStreamBuffer_->Close();
        vpStreamBuffer_.Reset();
        vpStreamPtr_ = nullptr;
        vpStreamCapacity_ = 0;
    }

    // Rows of a WebGPU readback are padded to 256 bytes, so size for that.
    static std::uint64_t ViewportStreamFrameBytes(int width, int height) {
        const std::uint64_t stride = (static_cast<std::uint64_t>(width) * 4 + 255) & ~std::uint64_t(255);
        return stride * static_cast<std::uint64_t>(height);
    }

    bool PostViewportStreamBuffer() {
        if (!vpStreamBuffer_ || !webview_) return false;
        ComPtr<ICoreWebView2_17> wv17;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        if (!wv17) return false;
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"viewport_frame_buf\",\"capacity\":" << vpStreamCapacity_ << L'}';
        return SUCCEEDED(wv17->PostSharedBufferToScript(vpStreamBuffer_.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, ss.str().c_str()));
    }

    // Keeps one buffer that fits a frame of the given size, with room to grow into.
    bool EnsureViewportStreamBuffer(int width, int height) {
        using namespace MaxJSViewportStream;
        const std::uint64_t needed = ViewportStreamFrameBytes(width, height);
        if (vpStreamBuffer_ && vpStreamPtr_ && vpStreamCapacity_ >= needed) return true;
        if (!env_ || !webview_) return false;

        ComPtr<ICoreWebView2Environment12> env12;
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!env12) return false;

        const std::uint64_t minimum = 4ull * 1024 * 1024;
        const std::uint64_t capacity = std::max(minimum, needed + needed / 4);
        ComPtr<ICoreWebView2SharedBuffer> buffer;
        if (FAILED(env12->CreateSharedBuffer(capacity + kHeaderBytes, &buffer)) || !buffer) return false;
        BYTE* ptr = nullptr;
        if (FAILED(buffer->get_Buffer(&ptr)) || !ptr) return false;

        std::memset(ptr, 0, kHeaderBytes);
        auto* words = reinterpret_cast<std::uint32_t*>(ptr);
        words[kWordMagic] = kMagic;
        words[kWordVersion] = kVersion;
        words[kWordCapacity] = static_cast<std::uint32_t>(std::min<std::uint64_t>(capacity, UINT32_MAX));

        CloseViewportStreamBuffer();
        vpStreamBuffer_ = buffer;
        vpStreamPtr_ = ptr;
        vpStreamCapacity_ = capacity;
        return PostViewportStreamBuffer();
    }

    void SendViewportStreamState() {
        if (!webview_ || !jsReady_) return;
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"viewport_stream\",\"enabled\":" << (vpStreamEnabled_ ? L"true" : L"false")
           << L",\"width\":" << vpStreamWidth_
           << L",\"height\":" << vpStreamHeight_
           << L",\"maxFps\":" << vpStreamMaxFps_ << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    // `panelWasVisible`: whether the user had the panel open before the stream asked for it.
    bool StartViewportStream(int width, int height, bool panelWasVisible, std::wstring& error) {
        vpStreamPanelWasVisible_ = panelWasVisible;
        SetPanelConcealed(true);
        if (!useBinary_ && webview_) {
            RestorePanelAfterViewportStream();
            error = L"this WebView2 runtime has no shared buffers";
            return false;
        }
        vpStreamEnabled_ = true;
        vpStreamWidth_ = std::max(16, width);
        vpStreamHeight_ = std::max(16, height);
        vpStreamHaveFrameCamera_ = false;
        vpStreamLockstepHoldUntil_ = 0;
        vpStreamLockstepBackoffMs_ = kViewportLockstepBackoffMinMs;
        vpStreamStats_ = {};
        // A panel that is still loading picks the stream up from its ready message.
        if (webview_ && jsReady_) {
            if (!EnsureViewportStreamBuffer(vpStreamWidth_, vpStreamHeight_)) {
                vpStreamEnabled_ = false;
                RestorePanelAfterViewportStream();
                error = L"could not create the shared frame buffer";
                return false;
            }
            SendViewportStreamState();
        }
        return true;
    }

    // The panel as the stream found it: shown again, or closed again if the stream opened it.
    void RestorePanelAfterViewportStream() {
        SetPanelConcealed(false);
        if (!vpStreamPanelWasVisible_ && hwnd_ && IsWindowVisible(hwnd_)) ShowWindow(hwnd_, SW_HIDE);
        vpStreamPanelWasVisible_ = true;
    }

    void StopViewportStream() {
        if (!vpStreamEnabled_ && !vpStreamBuffer_) return;
        vpStreamEnabled_ = false;
        SendViewportStreamState();
        CloseViewportStreamBuffer();
        RestorePanelAfterViewportStream();
    }

    void SetViewportStreamRenderSize(int width, int height) {
        width = std::max(16, width);
        height = std::max(16, height);
        if (width == vpStreamWidth_ && height == vpStreamHeight_) return;
        vpStreamWidth_ = width;
        vpStreamHeight_ = height;
        if (!vpStreamEnabled_ || !webview_ || !jsReady_) return;
        EnsureViewportStreamBuffer(width, height);
        SendViewportStreamState();
    }

    void SetViewportStreamMaxFps(int fps) {
        fps = std::clamp(fps, 0, 240);
        if (fps == vpStreamMaxFps_) return;
        vpStreamMaxFps_ = fps;
        if (vpStreamEnabled_) SendViewportStreamState();
    }

    // The viewer (re)loaded: it has no buffer any more.
    void OnViewportStreamJsReady() {
        if (!vpStreamEnabled_) return;
        vpStreamHaveFrameCamera_ = false;
        // A viewer that went away mid-write left the lock taken.
        if (vpStreamPtr_) InterlockedExchange(&ViewportStreamWords()[MaxJSViewportStream::kWordLock], MaxJSViewportStream::kLockFree);
        if (vpStreamBuffer_) PostViewportStreamBuffer();
        else EnsureViewportStreamBuffer(vpStreamWidth_, vpStreamHeight_);
        SendViewportStreamState();
    }

    void OnViewportFrameMessage(const std::wstring& msg) {
        if (!vpStreamEnabled_) return;
        ++vpStreamStats_.framesAnnounced;
        int request = 0;
        ExtractJsonInt(msg, L"request", request);
        if (request != 0) {
            // The answer to a request that the host stopped waiting for.
            if (static_cast<std::uint32_t>(request) == vpStreamRequestedSeq_) {
                vpStreamFrameCamera_ = vpStreamRequestedCamera_;
                vpStreamHaveFrameCamera_ = true;
            }
        } else if (haveLastSentCamera_) {
            vpStreamFrameCamera_ = lastSentCamera_;
            vpStreamHaveFrameCamera_ = true;
        }
        if (vpStreamRepaintPosted_ || !hwnd_) return;
        vpStreamRepaintPosted_ = PostMessage(hwnd_, WM_VIEWPORT_FRAME, 0, 0) != 0;
    }

    void OnViewportFramePosted() {
        vpStreamRepaintPosted_ = false;
        if (vpStreamEnabled_) MaxJSViewportStream::OnFrameAvailable();
    }

    bool ViewportStreamHasNewFrame(std::uint32_t lastSeq) const {
        if (!vpStreamEnabled_ || !vpStreamPtr_) return false;
        const std::uint32_t seq = ViewportStreamWord(ViewportStreamWords(), MaxJSViewportStream::kWordFrameSeq);
        return seq != 0 && seq != lastSeq;
    }

    bool ViewportStreamCanLockstep() const {
        return webview_ && jsReady_ && !renderLocked_ && hwnd_ && IsWindowVisible(hwnd_) &&
               GetTickCount64() >= vpStreamLockstepHoldUntil_;
    }

    // Asks the viewer for a frame of `camera` and waits for it. The viewer answers through the
    // shared buffer alone, so nothing here depends on this thread's message queue.
    bool RequestViewportFrame(const CameraData& camera, int timeoutMs) {
        using namespace MaxJSViewportStream;
        std::uint32_t request = ++vpStreamRequestSeq_;
        if (request == 0) request = ++vpStreamRequestSeq_;

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"viewport_frame_request\",\"seq\":" << request << L",\"camera\":{";
        WriteCameraDataJsonMembers(ss, camera);
        ss << L"}}";
        if (FAILED(webview_->PostWebMessageAsJson(ss.str().c_str()))) return false;
        vpStreamRequestedCamera_ = camera;
        vpStreamRequestedSeq_ = request;

        LARGE_INTEGER frequency = {};
        LARGE_INTEGER start = {};
        QueryPerformanceFrequency(&frequency);
        QueryPerformanceCounter(&start);
        volatile LONG* words = ViewportStreamWords();
        for (;;) {
            const std::uint32_t echo = ViewportStreamWord(words, kWordRequestEcho);
            const bool answered = static_cast<std::int32_t>(echo - request) >= 0 &&
                                  ViewportStreamWord(words, kWordLock) != kLockViewerWriting;
            LARGE_INTEGER now = {};
            QueryPerformanceCounter(&now);
            const double waitedMs = static_cast<double>(now.QuadPart - start.QuadPart) * 1000.0 /
                                    static_cast<double>(frequency.QuadPart);
            if (answered) {
                ++vpStreamStats_.lockstepAnswered;
                vpStreamStats_.lockstepWaitMsTotal += waitedMs;
                vpStreamStats_.lockstepWaitMsMax = std::max(vpStreamStats_.lockstepWaitMsMax, waitedMs);
                vpStreamLockstepBackoffMs_ = kViewportLockstepBackoffMinMs;
                vpStreamFrameCamera_ = camera;
                vpStreamHaveFrameCamera_ = true;
                return true;
            }
            if (waitedMs >= static_cast<double>(timeoutMs)) {
                ++vpStreamStats_.lockstepTimedOut;
                vpStreamLockstepHoldUntil_ = GetTickCount64() + vpStreamLockstepBackoffMs_;
                vpStreamLockstepBackoffMs_ = std::min(vpStreamLockstepBackoffMs_ * 2, kViewportLockstepBackoffMaxMs);
                return false;
            }
            // The viewer needs a few milliseconds at least: yield the core, don't sleep a timer tick.
            if (waitedMs < 0.25) YieldProcessor();
            else SwitchToThread();
        }
    }

    bool AcquireViewportFrame(std::uint32_t lastSeq, int lockstepMs, MaxJSViewportStream::Frame& frame) {
        using namespace MaxJSViewportStream;
        if (!vpStreamEnabled_ || !vpStreamPtr_) return false;

        if (lockstepMs > 0 && ViewportStreamCanLockstep()) {
            CameraData camera = {};
            GetActiveCamera(camera);
            if (!vpStreamHaveFrameCamera_ || !CameraEquals(vpStreamFrameCamera_, camera)) {
                RequestViewportFrame(camera, lockstepMs);
            }
        }

        volatile LONG* words = ViewportStreamWords();
        if (InterlockedCompareExchange(&words[kWordLock], kLockHostReading, kLockFree) != kLockFree) {
            ++vpStreamStats_.lockBusy;
            return false;
        }
        const std::uint32_t seq = ViewportStreamWord(words, kWordFrameSeq);
        const std::uint32_t width = ViewportStreamWord(words, kWordWidth);
        const std::uint32_t height = ViewportStreamWord(words, kWordHeight);
        const std::uint32_t stride = ViewportStreamWord(words, kWordStride);
        const std::uint32_t format = ViewportStreamWord(words, kWordFormat);
        bool usable = seq != 0 && seq != lastSeq;
        if (usable) {
            const bool fits = width >= 1 && height >= 1 && width <= 16384 && height <= 16384 &&
                              stride >= static_cast<std::uint64_t>(width) * 4 &&
                              static_cast<std::uint64_t>(stride) * height <= vpStreamCapacity_ &&
                              (format == kFormatRGBA8 || format == kFormatBGRA8);
            if (!fits) {
                ++vpStreamStats_.rejected;
                // Acknowledge it anyway, or the viewer would wait for this frame forever.
                InterlockedExchange(&words[kWordAckSeq], static_cast<LONG>(seq));
                usable = false;
            }
        }
        if (!usable) {
            InterlockedExchange(&words[kWordLock], kLockFree);
            return false;
        }
        frame.pixels = vpStreamPtr_ + kHeaderBytes;
        frame.width = width;
        frame.height = height;
        frame.stride = stride;
        frame.format = format;
        frame.flags = ViewportStreamWord(words, kWordFlags);
        frame.seq = seq;
        ++vpStreamStats_.framesAcquired;
        return true;
    }

    void ReleaseViewportFrame(const MaxJSViewportStream::Frame& frame, bool consumed) {
        using namespace MaxJSViewportStream;
        if (!vpStreamPtr_) return;
        volatile LONG* words = ViewportStreamWords();
        if (consumed) InterlockedExchange(&words[kWordAckSeq], static_cast<LONG>(frame.seq));
        InterlockedCompareExchange(&words[kWordLock], kLockFree, kLockHostReading);
    }

    std::wstring ViewportStreamStatus() const {
        using namespace MaxJSViewportStream;
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"stream=" << (vpStreamEnabled_ ? L"on" : L"off")
           << L" viewer=" << (jsReady_ ? L"ready" : L"loading")
           << L" render=" << vpStreamWidth_ << L"x" << vpStreamHeight_
           << L" buffer=" << (vpStreamCapacity_ / 1024) << L"KB";
        if (vpStreamPtr_) {
            volatile LONG* words = ViewportStreamWords();
            ss << L" frame=" << ViewportStreamWord(words, kWordWidth) << L"x" << ViewportStreamWord(words, kWordHeight)
               << (ViewportStreamWord(words, kWordFormat) == kFormatBGRA8 ? L" bgra" : L" rgba")
               << L" seq=" << ViewportStreamWord(words, kWordFrameSeq)
               << L" ack=" << ViewportStreamWord(words, kWordAckSeq);
        }
        ss << L" announced=" << vpStreamStats_.framesAnnounced
           << L" acquired=" << vpStreamStats_.framesAcquired
           << L" lockBusy=" << vpStreamStats_.lockBusy
           << L" rejected=" << vpStreamStats_.rejected
           << L" lockstep(answered=" << vpStreamStats_.lockstepAnswered
           << L" timedOut=" << vpStreamStats_.lockstepTimedOut;
        if (vpStreamStats_.lockstepAnswered > 0) {
            ss << std::fixed << std::setprecision(2)
               << L" avgWaitMs=" << (vpStreamStats_.lockstepWaitMsTotal / static_cast<double>(vpStreamStats_.lockstepAnswered))
               << L" maxWaitMs=" << vpStreamStats_.lockstepWaitMsMax;
        }
        ss << L")";
        return ss.str();
    }
