    // Realtime sync pump, change detection, and fast-path flush logic.
    // Included inside MaxJSPanel so the member access surface is unchanged.
    static VOID CALLBACK SyncTimerQueueProc(PVOID param, BOOLEAN) {
        auto* self = static_cast<MaxJSPanel*>(param);
        if (!self || !self->hwnd_) return;
        if (InterlockedCompareExchange(&self->syncTickPosted_, 1, 0) != 0) return;
        if (!PostMessage(self->hwnd_, WM_SYNC_TICK, 0, 0)) {
            InterlockedExchange(&self->syncTickPosted_, 0);
        }
    }

    static VOID CALLBACK ActiveShadeTimerQueueProc(PVOID param, BOOLEAN) {
        auto* self = static_cast<MaxJSPanel*>(param);
        if (!self || !self->hwnd_) return;
        if (InterlockedCompareExchange(&self->activeShadeTickPosted_, 1, 0) != 0) return;
        if (!PostMessage(self->hwnd_, WM_AS_TICK, 0, 0)) {
            InterlockedExchange(&self->activeShadeTickPosted_, 0);
        }
    }

    void StartSyncPump() {
        if (!hwnd_ || syncTimerQueueTimer_ || syncTimerUsesWndTimer_) return;
        InterlockedExchange(&syncTickPosted_, 0);
        if (!CreateTimerQueueTimer(&syncTimerQueueTimer_, nullptr, SyncTimerQueueProc, this,
                                   SYNC_INTERVAL_MS, SYNC_INTERVAL_MS, WT_EXECUTEDEFAULT)) {
            syncTimerQueueTimer_ = nullptr;
            SetTimer(hwnd_, SYNC_TIMER_ID, SYNC_INTERVAL_MS, nullptr);
            syncTimerUsesWndTimer_ = true;
        }
    }

    void StopSyncPump() {
        if (syncTimerQueueTimer_) {
            HANDLE timer = syncTimerQueueTimer_;
            syncTimerQueueTimer_ = nullptr;
            DeleteTimerQueueTimer(nullptr, timer, INVALID_HANDLE_VALUE);
        }
        if (syncTimerUsesWndTimer_ && hwnd_) {
            KillTimer(hwnd_, SYNC_TIMER_ID);
            syncTimerUsesWndTimer_ = false;
        }
        InterlockedExchange(&syncTickPosted_, 0);
    }

    void StartActiveShadePump() {
        if (!hwnd_ || activeShadeTimerQueueTimer_ || activeShadeTimerUsesWndTimer_) return;
        InterlockedExchange(&activeShadeTickPosted_, 0);
        if (!CreateTimerQueueTimer(&activeShadeTimerQueueTimer_, nullptr, ActiveShadeTimerQueueProc, this,
                                   AS_INTERVAL_MS, AS_INTERVAL_MS, WT_EXECUTEDEFAULT)) {
            activeShadeTimerQueueTimer_ = nullptr;
            SetTimer(hwnd_, AS_TIMER_ID, AS_INTERVAL_MS, nullptr);
            activeShadeTimerUsesWndTimer_ = true;
        }
    }

    void StopActiveShadePump() {
        if (activeShadeTimerQueueTimer_) {
            HANDLE timer = activeShadeTimerQueueTimer_;
            activeShadeTimerQueueTimer_ = nullptr;
            DeleteTimerQueueTimer(nullptr, timer, INVALID_HANDLE_VALUE);
        }
        if (activeShadeTimerUsesWndTimer_ && hwnd_) {
            KillTimer(hwnd_, AS_TIMER_ID);
            activeShadeTimerUsesWndTimer_ = false;
        }
        InterlockedExchange(&activeShadeTickPosted_, 0);
    }

    void GetActiveCameraAtTime(CameraData& cam, TimeValue t) {
        if (renderCameraOverrideActive_) {
            cam = renderCameraOverride_;
            return;
        }
        if (lockedCameraHandle_ != 0) {
            Interface* ip = GetCOREInterface();
            INode* camNode = ip ? ip->GetINodeByHandle(lockedCameraHandle_) : nullptr;
            if (camNode && GetSceneCameraData(camNode, t, cam)) {
                return;
            }
            // Camera deleted or invalid — fall back to viewport
            lockedCameraHandle_ = 0;
        }
        GetViewportCamera(cam);
    }

    void GetActiveCamera(CameraData& cam) {
        Interface* ip = GetCOREInterface();
        GetActiveCameraAtTime(cam, ip ? ip->GetTime() : 0);
    }

    void CaptureCurrentCameraState() {
        GetActiveCamera(lastSentCamera_);
        haveLastSentCamera_ = true;
    }

    // ── Fast-deform cache lifecycle. The replay caches, their topology
    //    epoch/normal-plan guard, and the persistent shared buffers must be
    //    invalidated together; these helpers are the only mutation points. ──
    void EraseFastDeformReplayState(ULONG handle) {
        skinnedControlIdxCache_.erase(handle);
        skinnedFastSourceCache_.erase(handle);
        fastDeformGuardMap_.erase(handle);
    }

    // Deform replay has a stable payload size per topology epoch — reuse a
    // persistent double-buffered SharedBuffer instead of paying a new file
    // mapping every frame. Two slots alternate so the renderer can still be
    // reading the previous post while this one is filled.
    //
    // Shared by the fused position gather (which maps the slot BEFORE
    // extraction so the gather writes straight into it) and the ordinary copy
    // path, so both agree on slot rotation and capacity growth.
    bool AcquireFastDeformSharedBuffer(ULONG handle,
                                       size_t totalBytes,
                                       ICoreWebView2Environment12* env12,
                                       ComPtr<ICoreWebView2SharedBuffer>& outBuf,
                                       BYTE*& outPtr) {
        outBuf.Reset();
        outPtr = nullptr;
        if (!env12 || totalBytes == 0) return false;

        FastDeformSharedBufferPool& pool = fastDeformSharedBuffers_[handle];
        FastDeformSharedBufferSlot& slot = pool.slots[pool.next & 1];
        pool.next ^= 1;
        if (!slot.buf || slot.capacity < totalBytes) {
            if (slot.buf) slot.buf->Close();
            slot.buf.Reset();
            slot.capacity = 0;
            if (FAILED(env12->CreateSharedBuffer(totalBytes, &slot.buf)) || !slot.buf) return false;
            slot.capacity = totalBytes;
        }
        BYTE* ptr = nullptr;
        if (FAILED(slot.buf->get_Buffer(&ptr)) || !ptr) return false;
        outBuf = slot.buf;
        outPtr = ptr;
        return true;
    }

    void CloseFastDeformSharedBuffers(ULONG handle) {
        auto it = fastDeformSharedBuffers_.find(handle);
        if (it == fastDeformSharedBuffers_.end()) return;
        for (auto& slot : it->second.slots) {
            if (slot.buf) slot.buf->Close();
        }
        fastDeformSharedBuffers_.erase(it);
    }

    void ClosePlaybackSharedBuffers() {
        for (auto& slot : playbackStateSharedBuffers_) {
            if (slot.buf) slot.buf->Close();
            slot.buf.Reset();
            slot.capacity = 0;
        }
        for (auto& slot : playbackSnapshotSharedBuffers_) {
            if (slot.buf) slot.buf->Close();
            slot.buf.Reset();
            slot.capacity = 0;
        }
        playbackStateSharedBufferNext_ = 0;
        playbackSnapshotSharedBufferNext_ = 0;
        playbackSnapshotCopySlot_ = -1;
        playbackSnapshotCopyOffset_ = 0;
    }

    void ClearPendingDeformNormalRefresh() {
        deformNormalRefreshPendingHandles_.clear();
        deformNormalRefreshDueTick_ = 0;
        deformNormalRefreshQueuedHandle_ = 0;
    }

    void ClearGeometryFastFlushQueue() {
        geoFastDirtyHandles_.clear();
        geoFullFastDirtyHandles_.clear();
        geometryFastFlushNotBeforeTick_ = 0;
    }

    // Monotonic high-resolution clock. GetTickCount64's granularity is the
    // system timer tick — 15.6ms unless something in the process has called
    // timeBeginPeriod — so it cannot resolve the few-millisecond budgets the
    // timeline lanes are written against. Measuring those with it means a
    // "4ms" slice actually runs until the tick rolls over, which is the
    // opposite of the bounded turn the code intends.
    static double QpcNowMs() {
        static const double kTickMs = [] {
            LARGE_INTEGER f;
            if (!QueryPerformanceFrequency(&f) || f.QuadPart == 0) return 0.0;
            return 1000.0 / static_cast<double>(f.QuadPart);
        }();
        if (kTickMs == 0.0) return 0.0;
        LARGE_INTEGER now;
        if (!QueryPerformanceCounter(&now)) return 0.0;
        return static_cast<double>(now.QuadPart) * kTickMs;
    }

    // Shared expiry check for the bounded UI-thread sweeps. The transport copy
    // lane below already measured its budget this way; the sampling lanes were
    // still on GetTickCount64 and so were not actually bounded at 4ms.
    static bool TimelineBudgetExpired(double passStartMs) {
        return (QpcNowMs() - passStartMs) >=
               static_cast<double>(kTimelineSampleBudgetMs);
    }

    void SendFlowStatsIfDue() {
        if (!flowMode_ || !webview_) return;
        const ULONGLONG now = GetTickCount64();
        if (lastFlowStatsTick_ != 0 && (now - lastFlowStatsTick_) < kFlowStatsIntervalMs) return;
        lastFlowStatsTick_ = now;

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"flow_stats\""
           << L",\"queued\":" << geoFastDirtyHandles_.size()
           << L",\"swept\":" << playbackSnapshotHandles_.size()
           << L",\"deform\":" << timelineDeformHandles_.size()
           << L",\"parked\":" << flowStaticAuditHandles_.size()
           << L",\"promoted\":" << flowForceAnimatedHandles_.size() << L"}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void EraseFastDeformState(ULONG handle) {
        EraseFastDeformReplayState(handle);
        CloseFastDeformSharedBuffers(handle);
        deformNormalRefreshPendingHandles_.erase(handle);
        if (deformNormalRefreshQueuedHandle_ == handle) deformNormalRefreshQueuedHandle_ = 0;
        if (deformNormalRefreshPendingHandles_.empty()) deformNormalRefreshDueTick_ = 0;
    }

    void ClearFastDeformState() {
        skinnedControlIdxCache_.clear();
        skinnedFastSourceCache_.clear();
        fastDeformGuardMap_.clear();
        for (auto& entry : fastDeformSharedBuffers_) {
            for (auto& slot : entry.second.slots) {
                if (slot.buf) slot.buf->Close();
            }
        }
        fastDeformSharedBuffers_.clear();
        // These buffers share the WebView/environment lifetime even though
        // their payload is transform data rather than deform geometry.
        ClosePlaybackSharedBuffers();
        ClearPendingDeformNormalRefresh();
    }

    void PruneFastDeformState() {
        auto stale = [this](ULONG handle) {
            return skinnedHandles_.find(handle) == skinnedHandles_.end() &&
                   deformHandles_.find(handle) == deformHandles_.end();
        };
        for (auto it = skinnedControlIdxCache_.begin(); it != skinnedControlIdxCache_.end(); ) {
            if (stale(it->first)) it = skinnedControlIdxCache_.erase(it);
            else ++it;
        }
        for (auto it = skinnedFastSourceCache_.begin(); it != skinnedFastSourceCache_.end(); ) {
            if (stale(it->first)) it = skinnedFastSourceCache_.erase(it);
            else ++it;
        }
        for (auto it = fastDeformGuardMap_.begin(); it != fastDeformGuardMap_.end(); ) {
            if (stale(it->first)) it = fastDeformGuardMap_.erase(it);
            else ++it;
        }
        for (auto it = fastDeformSharedBuffers_.begin(); it != fastDeformSharedBuffers_.end(); ) {
            if (stale(it->first)) {
                for (auto& slot : it->second.slots) {
                    if (slot.buf) slot.buf->Close();
                }
                it = fastDeformSharedBuffers_.erase(it);
            } else {
                ++it;
            }
        }
        for (auto it = deformNormalRefreshPendingHandles_.begin();
             it != deformNormalRefreshPendingHandles_.end(); ) {
            if (stale(*it)) it = deformNormalRefreshPendingHandles_.erase(it);
            else ++it;
        }
        if (deformNormalRefreshQueuedHandle_ != 0 &&
            deformNormalRefreshPendingHandles_.find(deformNormalRefreshQueuedHandle_) ==
                deformNormalRefreshPendingHandles_.end()) {
            deformNormalRefreshQueuedHandle_ = 0;
        }
        if (deformNormalRefreshPendingHandles_.empty()) deformNormalRefreshDueTick_ = 0;
    }

    void RecordDeformNormalPost(ULONG handle,
                                bool requiresCpuNormalRefresh,
                                bool liveNormalsPosted,
                                HRESULT postResult) {
        if (!requiresCpuNormalRefresh) return;
        if (liveNormalsPosted && SUCCEEDED(postResult)) {
            // Keep the settle request until the WebView has accepted an exact
            // live-normal payload. Extraction alone is not delivery.
            deformNormalRefreshPendingHandles_.erase(handle);
            if (deformNormalRefreshQueuedHandle_ == handle) deformNormalRefreshQueuedHandle_ = 0;
            if (deformNormalRefreshPendingHandles_.empty()) deformNormalRefreshDueTick_ = 0;
        } else {
            // Arm before transport too: buffer creation or Post* can fail after
            // the sampled-position hash was advanced, so this settle lane is
            // also the guaranteed retry for the geometry payload itself.
            deformNormalRefreshPendingHandles_.insert(handle);
            const ULONGLONG now = GetTickCount64();
            // Base the quiet/retry period on the actual transport attempt, not
            // just the Max time event that scheduled it. This also prevents a
            // failed exact post from rebuilding normals every timer tick.
            deformNormalRefreshDueTick_ = std::max(
                deformNormalRefreshDueTick_,
                now + kInteractiveCooldownMs);
        }
    }

    bool ShouldOmitGeometryFastChannels(INode* node, TimeValue t) {
        if (!node) return false;
        const ULONG handle = node->GetHandle();
        auto it = geoFastTriangleCountMap_.find(handle);
        if (it == geoFastTriangleCountMap_.end()) {
            const int triCount = EstimateRenderableTriangleCountCapped(
                node, t, kMaxBinaryDeltaTriangles);
            if (triCount <= 0) return false;
            it = geoFastTriangleCountMap_.emplace(handle, triCount).first;
        }
        return it->second > kMaxBinaryDeltaTriangles;
    }

    // Live geometry signature for redraw-driven edit detection
    std::unordered_map<ULONG, uint64_t> lastBBoxHash_;
    std::unordered_map<ULONG, uint64_t> lastLiveGeomHash_;

    // Handles that need geometry re-sent via fast path (not full sync)
    std::unordered_set<ULONG> geoFastDirtyHandles_;
    std::unordered_set<ULONG> geoFullFastDirtyHandles_;
    std::unordered_set<ULONG> materialFastDirtyHandles_;

    void PollSelectedTransformGizmoLive() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        const int selCount = ip->GetSelNodeCount();
        if (selCount <= 0) return;

        const TimeValue t = ip->GetTime();
        const ULONGLONG now = GetTickCount64();
        bool changed = false;
        for (int i = 0; i < selCount; ++i) {
            INode* node = ip->GetSelNode(i);
            if (!node) continue;
            const ULONG handle = node->GetHandle();
            if (!IsTrackedHandle(handle)) continue;
            if (helperHandles_.find(handle) == helperHandles_.end() && IsSceneCameraNode(node)) {
                MarkCameraDirtyIfChanged(false);
                continue;
            }
            if (!HasPendingTransformChange(handle, node, t)) continue;

            fastDirtyHandles_.insert(handle);
            lastTransformInteractionTick_ = now;
            changed = true;
        }

        if (changed) {
            MarkInteractiveActivity();
            QueueFastFlush();
        }
    }

    void CheckSelectedGeometryLive() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        const int selCount = ip->GetSelNodeCount();
        if (selCount <= 0) return;
        if (ShouldSuppressSelectedGeometryDuringTimeline()) return;
        TimeValue t = ip->GetTime();

        bool changed = false;
        for (int i = 0; i < selCount; ++i) {
            INode* node = ip->GetSelNode(i);
            if (!node) continue;
            if (!ShouldRunInteractiveGeometryChecks(node)) continue;
            ULONG handle = node->GetHandle();
            if (!IsTrackedHandle(handle)) continue;
            if (geomHandles_.find(handle) == geomHandles_.end()) continue;
            if (skinnedHandles_.count(handle)) continue;
            if (HasPendingTransformChange(handle, node, t)) {
                lastTransformInteractionTick_ = GetTickCount64();
                fastDirtyHandles_.insert(handle);
                changed = true;
                continue;
            }
            if (ShouldSuppressSelectedGeometryForTransform()) continue;
            // A selected point-instance stack must not be hash-polled either —
            // every sample regenerates its instanced mesh. Events cover edits.
            if (pointInstanceHandles_.count(handle)) continue;
            const bool omitFastChannels = ShouldOmitGeometryFastChannels(node, t);

            // Match DetectGeometryChanges / geo_fast payload. For oversized
            // meshes this deliberately ignores UVs so live edits do not walk
            // and ship heavy channel data.
            uint64_t geomHash = 0;
            if (!TryHashRenderableGeometryFastState(node, t, omitFastChannels, geomHash))
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
        if (changed) {
            MarkInteractiveActivity();
            QueueFastFlush();
        }
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
    bool HasDeformingChannelChange(ULONG handle, INode* node, TimeValue t, bool forceOnFirstSample) {
        uint64_t channelHash = 0;
        if (!TryHashRenderableGeometryChannels(node, t, channelHash)) return false;

        auto it = deformChannelHashMap_.find(handle);
        if (it == deformChannelHashMap_.end()) {
            deformChannelHashMap_[handle] = channelHash;
            return forceOnFirstSample;
        }
        if (it->second == channelHash) return false;

        it->second = channelHash;
        return true;
    }

    void CheckSkinnedGeometryLive(bool forceForCurrentTime = false) {
        if (timelineDeformHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        const TimeValue t = ip->GetTime();
        const bool playing = ip->IsAnimPlaying() != 0;
        const ULONGLONG now = MaxJSLivePollNowMs();
        if (!forceForCurrentTime &&
            lastSkinnedLivePollTick_ != 0 &&
            (now - lastSkinnedLivePollTick_) < kSkinnedLivePollIntervalMs) {
            return;
        }
        lastSkinnedLivePollTick_ = now;

        if (forceForCurrentTime) {
            if (!timelineDeformScanActive_ &&
                haveLastDeformLivePollTime_ &&
                lastDeformLivePollTime_ == t &&
                timelineDeformScanPlaying_ == playing) {
                return;
            }

            if (!timelineDeformScanActive_) {
                timelineDeformScanActive_ = true;
                timelineDeformScanCursor_ = 0;
                timelineDeformScanTime_ = t;
                timelineDeformScanPlaying_ = playing;
            } else if (timelineDeformScanTime_ != t ||
                       timelineDeformScanPlaying_ != playing) {
                // Continuous playback must remain fair: keep walking the
                // current round-robin cycle as time advances.  A stopped
                // target is authoritative, so restart at handle zero and
                // cover every deformer at that exact final time.
                if (!playing || !timelineDeformScanPlaying_) {
                    timelineDeformScanCursor_ = 0;
                }
                timelineDeformScanTime_ = t;
                timelineDeformScanPlaying_ = playing;
            }
        }

        // Any of these means "something is actively changing this frame" and
        // the hash check is wasted work — extraction will happen anyway:
        //   - Animation playback (time advancing every frame)
        //   - Interactive cooldown window (user dragged something recently)
        // Falling into the hash path is only correct for true idle where nothing
        // is moving — it avoids redundant sends when the mesh genuinely isn't
        // changing. But during any kind of activity, hashing doubles the work.
        const bool timelineFastLane = ShouldUseTimelineGeometryFastLane();
        bool skipHash = timelineFastLane
                     || ShouldFavorInteractivePerformance();

        bool changed = false;

        auto pollHandle = [&](ULONG handle) {
            if (geoFastDirtyHandles_.count(handle)) return;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) return;
            if (forceForCurrentTime && playing && !IsMaxJsSyncDrawVisible(node)) {
                return;
            }
            const bool omitFastChannels = ShouldOmitGeometryFastChannels(node, t);

            if (skipHash) {
                if (!omitFastChannels &&
                    !timelineFastLane &&
                    !playing &&
                    node->Selected() &&
                    HasDeformingChannelChange(handle, node, t, true)) {
                    geoHashMap_.erase(handle);
                    geoFastDirtyHandles_.insert(handle);
                    geoFullFastDirtyHandles_.insert(handle);
                    changed = true;
                    return;
                }

                // Sampled-position gate: deformHandles_ holds EVERY node with
                // a modifier stack, not just animated ones, and this lane used
                // to mark all of them dirty unconditionally — so a heavy scene
                // re-extracted and re-sent every static UVW-Map/Edit-Poly mesh
                // on every playback tick. The ~256-probe hash costs microseconds
                // (EvalWorldState is cached at an unchanged time) and lets the
                // genuinely static majority skip extraction and send entirely.
                uint64_t geomHash = 0;
                if (TryHashAdaptiveDeformPositions(node, t, geomHash)) {
                    auto it = lastLiveGeomHash_.find(handle);
                    if (it != lastLiveGeomHash_.end() && it->second == geomHash) return;
                    lastLiveGeomHash_[handle] = geomHash;
                }

                geoHashMap_.erase(handle);
                geoFastDirtyHandles_.insert(handle);
                changed = true;
                return;
            }

            if (!omitFastChannels && HasDeformingChannelChange(handle, node, t, false)) {
                geoHashMap_.erase(handle);
                geoFastDirtyHandles_.insert(handle);
                geoFullFastDirtyHandles_.insert(handle);
                changed = true;
                return;
            }

            // Idle path: hash raw vertex positions to avoid redundant sends
            // when nothing changed. This path does EvalWorldState, but only
            // fires when the scene is truly idle — the cost is acceptable.
            uint64_t geomHash = 0;
            if (!TryHashAdaptiveDeformPositions(node, t, geomHash)) return;
            auto it = lastLiveGeomHash_.find(handle);
            if (it != lastLiveGeomHash_.end() && it->second == geomHash) return;
            lastLiveGeomHash_[handle] = geomHash;

            geoHashMap_.erase(handle);
            geoFastDirtyHandles_.insert(handle);
            changed = true;
        };

        const double passStart = QpcNowMs();
        if (forceForCurrentTime) {
            size_t visited = 0;
            while (timelineDeformScanCursor_ < timelineDeformHandles_.size() &&
                   visited < kMaxDeformingGeometryHandlesPerTick) {
                pollHandle(timelineDeformHandles_[timelineDeformScanCursor_++]);
                ++visited;
                if (visited > 0 && TimelineBudgetExpired(passStart)) {
                    break;
                }
            }

            if (timelineDeformScanCursor_ < timelineDeformHandles_.size()) {
                // DrainTimelineScanRequests clears the flag before calling us;
                // explicitly retain ownership until the complete fair sweep is
                // sampled.  The caller posts the next bounded turn.
                pendingTimelineDeformScan_ = true;
            } else {
                timelineDeformScanActive_ = false;
                timelineDeformScanCursor_ = 0;
                haveLastDeformLivePollTime_ = true;
                lastDeformLivePollTime_ = t;
            }
        } else {
            const size_t count = timelineDeformHandles_.size();
            const size_t maxVisit = std::min(kMaxDeformingGeometryHandlesPerTick, count);
            size_t visited = 0;
            while (visited < maxVisit) {
                const size_t index = deformLiveScanCursor_ % count;
                deformLiveScanCursor_ = (index + 1) % count;
                pollHandle(timelineDeformHandles_[index]);
                ++visited;
                if (TimelineBudgetExpired(passStart)) break;
            }
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
        bool changed = false;
        std::unordered_map<Mtl*, MaterialSyncState> materialStateCache;

        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlScalarHashMap_.erase(handle);
                mtlFastScalarHashMap_.erase(handle);
                materialFastDirtyHandles_.erase(handle);
                continue;
            }

            Mtl* rawMtl = node->GetMtl();
            Mtl* multiMtl = FindMultiSubMtl(rawMtl);
            if (multiMtl && multiMtl->NumSubMtls() > 1) continue;

            Mtl* supportedMtl = FindSupportedMaterial(rawMtl);
            if (supportedMtl) {
                const MaterialSyncState state = ComputeMaterialSyncStateCached(node, t, materialStateCache);
                auto structureIt = mtlHashMap_.find(handle);
                auto scalarIt = mtlScalarHashMap_.find(handle);
                auto fastScalarIt = mtlFastScalarHashMap_.find(handle);
                if (structureIt == mtlHashMap_.end() ||
                    scalarIt == mtlScalarHashMap_.end() ||
                    fastScalarIt == mtlFastScalarHashMap_.end()) {
                    mtlHashMap_[handle] = state.structureHash;
                    mtlScalarHashMap_[handle] = state.scalarHash;
                    mtlFastScalarHashMap_[handle] = state.fastScalarHash;
                    continue;
                }

                const bool structureChanged = structureIt->second != state.structureHash;
                const bool scalarChanged = scalarIt->second != state.scalarHash;
                const bool fastScalarChanged = fastScalarIt->second != state.fastScalarHash;
                if (!structureChanged && !scalarChanged && !fastScalarChanged) continue;

                structureIt->second = state.structureHash;
                scalarIt->second = state.scalarHash;
                fastScalarIt->second = state.fastScalarHash;

                if (structureChanged || scalarChanged || !state.canFastSync) {
                    materialFastDirtyHandles_.clear();
                    SetDirtyImmediate();
                    return;
                }

                materialFastDirtyHandles_.insert(handle);
                fastDirtyHandles_.insert(handle);
                changed = true;
                continue;
            }

            float col[3] = {0.8f, 0.8f, 0.8f};
            float rough = 0.5f;
            float metal = 0.0f;
            float opac = 1.0f;
            ExtractMaterialScalarPreview(nullptr, node, t, col, rough, metal, opac);
            const uint64_t scalarHash = HashMaterialScalarPreviewValues(col, rough, metal, opac);
            auto it = mtlFastScalarHashMap_.find(handle);
            if (it == mtlFastScalarHashMap_.end()) {
                mtlFastScalarHashMap_[handle] = scalarHash;
                continue;
            }

            if (it->second != scalarHash) {
                it->second = scalarHash;
                materialFastDirtyHandles_.insert(handle);
                fastDirtyHandles_.insert(handle);
                changed = true;
            }
        }

        if (changed) QueueFastFlush();
    }

    void RememberSentTransform(ULONG handle, const float* xform) {
        std::array<float, 16> cached = {};
        std::copy(xform, xform + 16, cached.begin());
        lastSentTransforms_[handle] = cached;
    }

    bool HasPendingTransformChange(ULONG handle, INode* node, TimeValue t) const {
        if (!node) return false;
        auto it = lastSentTransforms_.find(handle);
        if (it == lastSentTransforms_.end()) return false;

        float xform[16];
        GetTransform16(node, t, xform);
        for (int i = 0; i < 16; ++i) {
            if (!NearlyEqualFloat(xform[i], it->second[i], 1.0e-4f)) return true;
        }
        return false;
    }

    INode* GetDirectTrackedParentNode(INode* node) const {
        if (!node) return nullptr;
        INode* parent = node->GetParentNode();
        if (!parent || parent->IsRootNode()) return nullptr;
        return IsTrackedHandle(parent->GetHandle()) ? parent : nullptr;
    }

    bool TryGetParentRelativeTransform16(INode* node,
                                         TimeValue t,
                                         const float* world,
                                         float out[16]) const {
        INode* parent = GetDirectTrackedParentNode(node);
        if (!parent) return false;

        float parentWorld[16];
        GetTransform16(parent, t, parentWorld);

        float invParent[16];
        if (!InvertMat4CM(parentWorld, invParent)) return false;
        MulMat4CM(invParent, world, out);
        return true;
    }

    bool TryGetPreviousParentRelativeTransform16(ULONG handle, INode* node, float out[16]) const {
        INode* parent = GetDirectTrackedParentNode(node);
        if (!parent) return false;

        auto nodeIt = lastSentTransforms_.find(handle);
        if (nodeIt == lastSentTransforms_.end()) return false;

        auto parentIt = lastSentTransforms_.find(parent->GetHandle());
        if (parentIt == lastSentTransforms_.end()) return false;

        float invParent[16];
        if (!InvertMat4CM(parentIt->second.data(), invParent)) return false;
        MulMat4CM(invParent, nodeIt->second.data(), out);
        return true;
    }

    bool SupportsParentedDeltaHandle(ULONG handle) const {
        return helperHandles_.find(handle) != helperHandles_.end() ||
               geomHandles_.find(handle) != geomHandles_.end() ||
               lightHandles_.find(handle) != lightHandles_.end();
    }

    bool HasTransformChangedForSync(ULONG handle,
                                    INode* node,
                                    TimeValue t,
                                    float currentWorldOut[16] = nullptr) const {
        if (!node) return false;

        float world[16];
        GetTransform16(node, t, world);
        if (currentWorldOut) std::copy(world, world + 16, currentWorldOut);

        auto worldIt = lastSentTransforms_.find(handle);
        if (worldIt == lastSentTransforms_.end()) return true;

        float local[16];
        float previousLocal[16];
        if (SupportsParentedDeltaHandle(handle) &&
            TryGetParentRelativeTransform16(node, t, world, local) &&
            TryGetPreviousParentRelativeTransform16(handle, node, previousLocal)) {
            return !TransformEquals16(local, previousLocal);
        }

        return !TransformEquals16(world, worldIt->second.data());
    }

    void RememberSkippedParentedTransform(ULONG handle, INode* node, const float* world) {
        if (!SupportsParentedDeltaHandle(handle) || !GetDirectTrackedParentNode(node)) return;
        RememberSentTransform(handle, world);
    }

    int GetTrackedHierarchyDepth(INode* node) const {
        int depth = 0;
        for (INode* parent = node ? node->GetParentNode() : nullptr;
             parent && !parent->IsRootNode();
             parent = parent->GetParentNode()) {
            if (IsTrackedHandle(parent->GetHandle())) ++depth;
        }
        return depth;
    }

    void SortHandlesByHierarchyDepth(std::vector<ULONG>& handles, Interface* ip) const {
        if (!ip || handles.size() < 2) return;
        std::stable_sort(handles.begin(), handles.end(), [this, ip](ULONG a, ULONG b) {
            INode* an = ip->GetINodeByHandle(a);
            INode* bn = ip->GetINodeByHandle(b);
            const int ad = GetTrackedHierarchyDepth(an);
            const int bd = GetTrackedHierarchyDepth(bn);
            if (ad != bd) return ad < bd;
            return a < b;
        });
    }

    bool EnsurePlaybackSharedBuffers(size_t snapshotCapacity) {
        if (!webview_ || !env_ || !useBinary_) return false;

        ComPtr<ICoreWebView2Environment12> env12;
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!env12) return false;

        auto ensureSlot = [&](PlaybackSharedBufferSlot& slot, size_t requested) {
            const UINT64 required = static_cast<UINT64>(std::max<size_t>(4, requested));
            if (slot.buf && slot.capacity >= required) return true;

            if (slot.buf) slot.buf->Close();
            slot.buf.Reset();
            slot.capacity = 0;

            ComPtr<ICoreWebView2SharedBuffer> replacement;
            const HRESULT hr = env12->CreateSharedBuffer(required, &replacement);
            if (FAILED(hr) || !replacement) return false;
            slot.buf = std::move(replacement);
            slot.capacity = required;
            return true;
        };

        bool ready = true;
        for (auto& slot : playbackStateSharedBuffers_) {
            ready = ensureSlot(slot, 64) && ready;
        }
        for (auto& slot : playbackSnapshotSharedBuffers_) {
            ready = ensureSlot(slot, snapshotCapacity) && ready;
        }
        return ready;
    }

    // ── FLOW: animation gating ───────────────────────────────────────
    // The playback sweeps walk every tracked node and every modifier-stack
    // node on each tick, evaluating them purely to discover that almost none
    // moved. On a heavy scene that discovery IS the cost, and it scales with
    // scene size rather than with how much is animated.
    //
    // Classification is by validity interval, not by keyframe inspection:
    // FOREVER means the value cannot vary with time, and it accounts for
    // expression controllers, wiring and constraints that IsAnimated() misses.
    //
    // Every uncertain case resolves to "animated". A false animated costs the
    // pre-FLOW sweep for that handle; a false static freezes an object.
    bool NodeTransformIsStatic(INode* node, TimeValue t) const {
        if (!node) return false;
        if (flowForceAnimatedHandles_.find(node->GetHandle()) !=
            flowForceAnimatedHandles_.end()) return false;
        // An animated visibility track varies over time without touching the
        // TM at all, and the playback sampler is what delivers it.
        if (node->GetVisController()) return false;
        Interval valid = FOREVER;
        node->GetNodeTM(t, &valid);
        if (valid != FOREVER) return false;
        // GetNodeTM is a world TM and should already fold in the parent
        // chain; walking it explicitly costs nothing at epoch rate and does
        // not depend on every controller propagating validity correctly.
        for (INode* parent = node->GetParentNode();
             parent && !parent->IsRootNode();
             parent = parent->GetParentNode()) {
            Interval parentValid = FOREVER;
            parent->GetNodeTM(t, &parentValid);
            if (parentValid != FOREVER) return false;
        }
        return true;
    }

    bool NodeGeometryIsStatic(INode* node, TimeValue t, ULONG handle) const {
        if (!node) return false;
        if (flowForceAnimatedHandles_.find(handle) !=
            flowForceAnimatedHandles_.end()) return false;
        // Skinned meshes are never gated out. Their deformation comes from
        // bone node TMs rather than from animated parameters on the stack, so
        // the object's own validity interval is not something to bet a frozen
        // character on. The skinned set is small — characters, not scenery —
        // so keeping it always-live costs almost nothing and removes the
        // failure mode entirely.
        if (skinnedHandles_.find(handle) != skinnedHandles_.end()) return false;
        ObjectState os = node->EvalWorldState(t);
        if (!os.obj) return false;
        return os.obj->ObjectValidity(t) == FOREVER;
    }

    // Cheap "did this actually move" probe for a parked handle: world TM
    // folded together with the sampled-position hash the deform lane already
    // uses. Same evidence the pre-FLOW sweep collected, just at audit rate
    // instead of every tick.
    std::uint64_t ComputeFlowAuditSignature(INode* node, TimeValue t, ULONG handle) {
        std::uint64_t sig = 1469598103934665603ull;
        auto mix = [&sig](std::uint64_t v) {
            sig ^= v;
            sig *= 1099511628211ull;
        };
        float xform[16];
        GetTransform16(node, t, xform);
        for (int i = 0; i < 16; ++i) {
            std::uint32_t bits = 0;
            std::memcpy(&bits, &xform[i], sizeof(bits));
            mix(bits);
        }
        mix(IsMaxJsSyncDrawVisible(node) ? 0x9E3779B97F4A7C15ull : 0x517CC1B727220A95ull);
        // Lights are not parked any more, but the audit must still be able to
        // see non-transform state change or it silently certifies as static
        // anything whose animation does not move the node.
        if (lightHandles_.find(handle) != lightHandles_.end()) {
            mix(ComputeLightStateHash(node, t));
        }
        if (deformHandles_.find(handle) != deformHandles_.end()) {
            std::uint64_t geomHash = 0;
            if (TryHashAdaptiveDeformPositions(node, t, geomHash)) mix(geomHash);
        }
        return sig;
    }

    void RunFlowStaticAudit() {
        if (!flowMode_ || flowStaticAuditHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        const TimeValue t = ip->GetTime();

        const double auditStartMs = QpcNowMs();
        std::vector<ULONG> promoted;
        size_t visited = 0;
        while (visited < flowStaticAuditHandles_.size()) {
            const size_t index = flowStaticAuditCursor_ % flowStaticAuditHandles_.size();
            flowStaticAuditCursor_ = index + 1;
            const ULONG handle = flowStaticAuditHandles_[index];
            ++visited;

            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                promoted.push_back(handle);  // dropped below with the rest
            } else {
                const std::uint64_t sig = ComputeFlowAuditSignature(node, t, handle);
                auto it = flowStaticAuditSignature_.find(handle);
                if (it == flowStaticAuditSignature_.end()) {
                    flowStaticAuditSignature_.emplace(handle, sig);
                } else if (it->second != sig) {
                    // Claimed static, moved anyway. Trust the observation over
                    // the interval, permanently for this session.
                    flowForceAnimatedHandles_.insert(handle);
                    promoted.push_back(handle);
                }
            }

            if ((QpcNowMs() - auditStartMs) >= kFlowAuditBudgetMs) break;
        }

        if (promoted.empty()) return;
        for (ULONG handle : promoted) {
            flowStaticAuditSignature_.erase(handle);
            auto it = std::find(flowStaticAuditHandles_.begin(),
                                flowStaticAuditHandles_.end(), handle);
            if (it != flowStaticAuditHandles_.end()) flowStaticAuditHandles_.erase(it);
            if (!ip->GetINodeByHandle(handle)) continue;
            if (std::find(playbackSnapshotHandles_.begin(), playbackSnapshotHandles_.end(),
                          handle) == playbackSnapshotHandles_.end()) {
                playbackSnapshotHandles_.push_back(handle);
            }
            if (deformHandles_.find(handle) != deformHandles_.end() &&
                !std::binary_search(timelineDeformHandles_.begin(),
                                    timelineDeformHandles_.end(), handle)) {
                timelineDeformHandles_.push_back(handle);
                std::sort(timelineDeformHandles_.begin(), timelineDeformHandles_.end());
            }
            // Deliver the state it missed while parked.
            fastDirtyHandles_.insert(handle);
            geoFastDirtyHandles_.insert(handle);
        }
        flowStaticAuditCursor_ = 0;
        QueueFastFlush();
    }

    void RebuildTimelineHandleCaches() {
        playbackSnapshotHandles_.clear();
        timelineDeformHandles_.clear();
        flowStaticAuditHandles_.clear();
        flowStaticAuditCursor_ = 0;

        std::unordered_set<ULONG> seen;
        seen.reserve(
            geomHandles_.size() + lightHandles_.size() +
            audioHandles_.size() + gltfHandles_.size() + webappHandles_.size() +
            hairHandles_.size() + helperHandles_.size());
        Interface* gateIp = flowMode_ ? GetCOREInterface() : nullptr;
        const TimeValue gateTime = gateIp ? gateIp->GetTime() : 0;
        auto appendUnique = [&](const std::unordered_set<ULONG>& source) {
            for (ULONG handle : source) {
                if (!seen.insert(handle).second) continue;
                // Lights are never parked. The playback sampler carries light
                // STATE — intensity, colour, cone, shadow params — and none of
                // that touches the transform, so a stationary light with an
                // animated multiplier looks static to a TM validity test while
                // its contribution changes every frame. Same reasoning as
                // skinned meshes: the set is small and always-live costs
                // nothing next to freezing scene lighting.
                const bool neverPark = lightHandles_.find(handle) != lightHandles_.end();
                if (gateIp && !neverPark) {
                    INode* node = gateIp->GetINodeByHandle(handle);
                    if (node && NodeTransformIsStatic(node, gateTime)) {
                        // Parked, not dropped: the audit below re-checks it,
                        // and every event callback can still mark it dirty
                        // through the normal fast path.
                        flowStaticAuditHandles_.push_back(handle);
                        continue;
                    }
                }
                playbackSnapshotHandles_.push_back(handle);
            }
        };
        appendUnique(helperHandles_);
        appendUnique(geomHandles_);
        appendUnique(lightHandles_);
        appendUnique(audioHandles_);
        appendUnique(gltfHandles_);
        appendUnique(webappHandles_);
        appendUnique(hairHandles_);

        Interface* ip = GetCOREInterface();
        SortHandlesByHierarchyDepth(playbackSnapshotHandles_, ip);
        playbackSnapshotTransforms_.reserve(playbackSnapshotHandles_.size());
        playbackSnapshotAux_.reserve(playbackSnapshotHandles_.size());
        playbackStateFrame_.ReserveBytes(64);
        const size_t playbackSnapshotCapacity =
            96 + playbackSnapshotHandles_.size() * 176;
        playbackSnapshotFrame_.ReserveBytes(playbackSnapshotCapacity);
        // Shared-buffer allocation is deliberately paid at the full-sync
        // boundary, never on Play, Stop, or a timeline-scrub WndProc turn.
        EnsurePlaybackSharedBuffers(playbackSnapshotCapacity);

        timelineDeformHandles_.reserve(skinnedHandles_.size() + deformHandles_.size());
        // Skinned handles go in unconditionally — see NodeGeometryIsStatic.
        timelineDeformHandles_.insert(
            timelineDeformHandles_.end(), skinnedHandles_.begin(), skinnedHandles_.end());
        for (ULONG handle : deformHandles_) {
            if (skinnedHandles_.find(handle) != skinnedHandles_.end()) continue;
            if (gateIp) {
                INode* node = gateIp->GetINodeByHandle(handle);
                // deformHandles_ is "has a modifier stack", not "deforms over
                // time" — a static UVW-Map or Edit Poly mesh lands here and
                // then pays EvalWorldState plus a position hash every tick.
                if (node && NodeGeometryIsStatic(node, gateTime, handle)) {
                    flowStaticAuditHandles_.push_back(handle);
                    continue;
                }
            }
            timelineDeformHandles_.push_back(handle);
        }
        std::sort(timelineDeformHandles_.begin(), timelineDeformHandles_.end());
        // Deduplicate: a node can be parked by both sweeps above.
        std::sort(flowStaticAuditHandles_.begin(), flowStaticAuditHandles_.end());
        flowStaticAuditHandles_.erase(
            std::unique(flowStaticAuditHandles_.begin(), flowStaticAuditHandles_.end()),
            flowStaticAuditHandles_.end());
        // Audit deform candidates first. ObjectValidity is FOREVER for a
        // modifier driven by another node's transform — Path Deform, an
        // animated FFD lattice, a Bend gizmo, Skin Wrap — because nothing on
        // the stack itself is keyed. Those are precisely the handles the gate
        // mis-parks, and a frozen deforming mesh reads as broken where a
        // frozen prop reads as scenery. Verifying them before the static bulk
        // shrinks the visible window from "whole parked set" to "deform subset".
        std::stable_partition(
            flowStaticAuditHandles_.begin(), flowStaticAuditHandles_.end(),
            [this](ULONG handle) {
                return deformHandles_.find(handle) != deformHandles_.end();
            });

        timelineTransformScanActive_ = false;
        timelineTransformScanCursor_ = 0;
        timelineDeformScanActive_ = false;
        timelineDeformScanCursor_ = 0;
        deformLiveScanCursor_ = 0;
    }

    void CapturePlaybackDeliveredStateAtTime(TimeValue t) {
        lastSentPlaybackAux_.clear();
        lastSentPlaybackAux_.reserve(playbackSnapshotHandles_.size());

        Interface* ip = GetCOREInterface();
        if (!ip) return;
        for (ULONG handle : playbackSnapshotHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;
            PlaybackAuxDeliveryState& state = lastSentPlaybackAux_[handle];
            state.visible = IsMaxJsSyncDrawVisible(node);
            if (helperHandles_.find(handle) != helperHandles_.end()) {
                state.selected = node->Selected() != 0;
                state.hasSelection = true;
            }
            if (lightHandles_.find(handle) != lightHandles_.end()) {
                state.lightStateHash = ComputeLightStateHash(node, t);
                state.hasLightStateHash = true;
            }
        }
    }

    static constexpr ULONGLONG kInteractiveCooldownMs = 250;
    static constexpr ULONGLONG kFullSyncInteractiveDeferMs = 650;
    static constexpr ULONGLONG kMaterialInteractiveCooldownMs = 400;
    static constexpr ULONGLONG kMaterialLivePollIntervalMs = 50;
    static constexpr ULONGLONG kIdlePollFullSyncMinIntervalMs = 1500;
    static constexpr ULONGLONG kIdlePollAuditWindowMs = 4000;
    static constexpr size_t kMaxFastFlushHandlesPerPass = 128;
    static constexpr size_t kMaxGeometryFastFlushHandlesPerPass = 8;
    static constexpr size_t kMaxTimelineSnapshotHandlesPerPass = 8;
    static constexpr size_t kMaxDeformingGeometryHandlesPerTick = 8;
    static constexpr ULONGLONG kTimelineSampleBudgetMs = 4;
    static constexpr size_t kTimelineTransportCopyBytesPerPass = 256 * 1024;
    static constexpr size_t kTimelineTransportCopyQuantumBytes = 16 * 1024;
    static constexpr ULONGLONG kTransportRetryBackoffMs = 100;
    static constexpr ULONGLONG kFullSyncTransportRetryBackoffMs = 500;
    // ── FLOW mode tuning ──
    static constexpr ULONGLONG kFlowStatsIntervalMs = 500;
    // Fixed per-tick cost for re-checking parked handles, independent of scene
    // size. Large scenes take longer to sweep, they do not cost more per tick.
    static constexpr double kFlowAuditBudgetMs = 1.0;

    static constexpr size_t kMaxIdleMaterialHandlesPerTick = 16;
    static constexpr size_t kMaxIdleLightHandlesPerTick = 64;
    static constexpr size_t kMaxIdleJsModHandlesPerTick = 64;
    static constexpr size_t kMaxIdlePropertyHandlesPerTick = 64;

    template <typename Fn>
    void VisitBudgetedHandles(const std::vector<ULONG>& handles,
                              size_t& cursor,
                              size_t maxPerTick,
                              Fn&& fn) {
        if (handles.empty()) {
            cursor = 0;
            return;
        }
        if (handles.size() <= maxPerTick) {
            cursor = 0;
            for (ULONG handle : handles) fn(handle);
            return;
        }

        const size_t start = cursor % handles.size();
        const size_t count = std::min(maxPerTick, handles.size());
        for (size_t i = 0; i < count; ++i) {
            fn(handles[(start + i) % handles.size()]);
        }
        cursor = (start + count) % handles.size();
    }

    void MarkInteractiveActivity() {
        lastInteractionTick_ = GetTickCount64();
    }

    void ArmIdlePollAuditWindow() {
        const ULONGLONG now = GetTickCount64();
        const ULONGLONG until = now + kIdlePollAuditWindowMs;
        if (until > idlePollAuditUntilTick_) idlePollAuditUntilTick_ = until;
    }

    void ClearIdlePollFullSyncCandidates() {
        idleMaterialFullSyncCandidateHash_.clear();
        idleJsModFullSyncCandidateHash_.clear();
        idlePropertyFullSyncCandidateHash_.clear();
    }

    void ClearMaterialEditHandleCache() {
        materialEditHandleCache_.clear();
    }

    bool ShouldRunIdlePollAudit(ULONGLONG now) {
        if (idlePollAuditUntilTick_ == 0) return false;
        if (now <= idlePollAuditUntilTick_) return true;
        idlePollAuditUntilTick_ = 0;
        idlePollFullSyncPending_ = false;
        ClearIdlePollFullSyncCandidates();
        return false;
    }

    bool ConfirmIdleFullSyncCandidate(std::unordered_map<ULONG, uint64_t>& candidates,
                                      ULONG handle,
                                      uint64_t candidateHash) {
        auto it = candidates.find(handle);
        if (it != candidates.end() && it->second == candidateHash) {
            candidates.erase(it);
            return true;
        }
        candidates[handle] = candidateHash;
        return false;
    }

    void MarkMaterialInteractiveActivity() {
        lastMaterialInteractionTick_ = GetTickCount64();
        MarkInteractiveActivity();
    }

    void RequestIdlePollFullSync() {
        const ULONGLONG now = GetTickCount64();
        if (nextIdlePollFullSyncTick_ == 0 || now >= nextIdlePollFullSyncTick_) {
            idlePollFullSyncPending_ = false;
            nextIdlePollFullSyncTick_ = now + kIdlePollFullSyncMinIntervalMs;
            SetDirty(false);
        } else {
            idlePollFullSyncPending_ = true;
        }
    }

    void PumpDeferredIdlePollFullSync(ULONGLONG now) {
        if (!idlePollFullSyncPending_) return;
        if (nextIdlePollFullSyncTick_ != 0 && now < nextIdlePollFullSyncTick_) return;
        idlePollFullSyncPending_ = false;
        nextIdlePollFullSyncTick_ = now + kIdlePollFullSyncMinIntervalMs;
        SetDirty(false);
    }

    // ── Material edit watcher ────────────────────────────────
    // Standard 3ds Max materials (Physical/Standard/VRay...) have no plugin
    // edit hook — only maxjs's own material classes call
    // MaxJSNotifyMaterialEdited from their PBAccessors. Everything else used
    // to depend on the budgeted idle crawler, whose two-visit confirm can
    // never complete inside one 4s audit window on large scenes (871 nodes ≈
    // 11s per rotation at 16 handles/tick), so edits were silently dropped
    // until a viewer restart. The watcher holds weak references to every root
    // scene material and forwards REFMSG_CHANGE — which propagates up from
    // any nested texmap, texture output, or curve — into the same targeted
    // path the PBAccessors use. Material edits become event-driven regardless
    // of scene size or material class; the crawler stays as a safety net.
    class MaterialEditWatcher : public ReferenceMaker {
    public:
        MaxJSPanel* panel = nullptr;
        std::vector<RefTargetHandle> targets;

        int NumRefs() override { return static_cast<int>(targets.size()); }
        RefTargetHandle GetReference(int i) override {
            return (i >= 0 && i < static_cast<int>(targets.size())) ? targets[i] : nullptr;
        }
        // Weak observer: never counts as a real dependent (not saved, no
        // dependency-loop participation), but still receives change messages.
        BOOL IsRealDependency(ReferenceTarget*) override { return FALSE; }
        RefResult NotifyRefChanged(const Interval&, RefTargetHandle hTarget,
                                   PartID&, RefMessage message, BOOL) override {
            if (!panel) return REF_SUCCEED;
            if (message == REFMSG_CHANGE) {
                panel->QueueMaterialEditTarget(hTarget);
            } else if (message == REFMSG_TARGET_DELETED) {
                panel->ForgetMaterialEditTarget(hTarget);
                for (auto& t : targets) { if (t == hTarget) t = nullptr; }
            }
            return REF_SUCCEED;
        }

    protected:
        void SetReference(int i, RefTargetHandle rtarg) override {
            if (i >= 0 && i < static_cast<int>(targets.size())) targets[i] = rtarg;
        }
    };

    // RAII: our own extraction/serialization can tickle texmaps (Update,
    // bitmap loads) and echo REFMSG_CHANGE back at the watcher. Suppress
    // capture while WE are the ones touching materials.
    struct SuppressMaterialEditCaptureScope {
        MaxJSPanel& p;
        bool prev;
        explicit SuppressMaterialEditCaptureScope(MaxJSPanel& panel)
            : p(panel), prev(panel.suppressMaterialEditCapture_) {
            p.suppressMaterialEditCapture_ = true;
        }
        ~SuppressMaterialEditCaptureScope() { p.suppressMaterialEditCapture_ = prev; }
    };

    MaterialEditWatcher* materialEditWatcher_ = nullptr;
    std::unordered_set<ReferenceTarget*> pendingMaterialEditTargets_;
    std::unordered_set<ReferenceTarget*> watchedMaterialSet_;
    bool suppressMaterialEditCapture_ = false;
    bool pendingMaterialEditOverflow_ = false;
    static constexpr size_t kMaxPendingMaterialEditTargets = 256;

    void QueueMaterialEditTarget(ReferenceTarget* target) {
        if (!target || suppressMaterialEditCapture_) return;
        if (pendingMaterialEditTargets_.size() >= kMaxPendingMaterialEditTargets) {
            // Mass edit (script sweep) — fall back to one full sync instead
            // of dropping targets.
            pendingMaterialEditOverflow_ = true;
            return;
        }
        pendingMaterialEditTargets_.insert(target);
    }

    void ForgetMaterialEditTarget(ReferenceTarget* target) {
        pendingMaterialEditTargets_.erase(target);
        watchedMaterialSet_.erase(target);
    }

    void DrainPendingMaterialEdits() {
        if (pendingMaterialEditOverflow_) {
            pendingMaterialEditOverflow_ = false;
            pendingMaterialEditTargets_.clear();
            ClearMaterialEditHandleCache();
            SetDirtyImmediate();
            return;
        }
        if (pendingMaterialEditTargets_.empty()) return;
        std::vector<ReferenceTarget*> targets(
            pendingMaterialEditTargets_.begin(), pendingMaterialEditTargets_.end());
        pendingMaterialEditTargets_.clear();
        SuppressMaterialEditCaptureScope guard(*this);
        for (ReferenceTarget* target : targets) NotifyMaterialEditedTarget(target);
    }

    void RebuildMaterialEditWatcher() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        std::unordered_set<ReferenceTarget*> current;
        current.reserve(64);
        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;
            if (Mtl* mtl = node->GetMtl()) current.insert(mtl);
        }
        if (current == watchedMaterialSet_) return;
        if (!materialEditWatcher_) {
            materialEditWatcher_ = new MaterialEditWatcher();
            materialEditWatcher_->panel = this;
        }
        HoldSuspend hs; // keep watcher ref churn out of the undo stack
        materialEditWatcher_->DeleteAllRefsFromMe();
        materialEditWatcher_->targets.clear();
        materialEditWatcher_->targets.resize(current.size(), nullptr);
        int slot = 0;
        for (ReferenceTarget* mtl : current) {
            materialEditWatcher_->ReplaceReference(slot++, mtl);
        }
        watchedMaterialSet_ = std::move(current);
    }

    void DestroyMaterialEditWatcher() {
        pendingMaterialEditTargets_.clear();
        watchedMaterialSet_.clear();
        pendingMaterialEditOverflow_ = false;
        if (materialEditWatcher_) {
            materialEditWatcher_->panel = nullptr;
            HoldSuspend hs;
            materialEditWatcher_->DeleteAllRefsFromMe();
            materialEditWatcher_->targets.clear();
            delete materialEditWatcher_;
            materialEditWatcher_ = nullptr;
        }
    }

    std::vector<ULONG> FindMaterialEditHandles(ReferenceTarget* target) {
        if (!target) return {};
        auto cached = materialEditHandleCache_.find(target);
        if (cached != materialEditHandleCache_.end()) return cached->second;

        Interface* ip = GetCOREInterface();
        if (!ip) return {};

        std::vector<ULONG> handles;
        Mtl* targetMtl = dynamic_cast<Mtl*>(target);
        if (targetMtl) {
            handles.reserve(geomHandles_.size());
            for (ULONG handle : geomHandles_) {
                INode* node = ip->GetINodeByHandle(handle);
                if (!node) continue;
                // Match the raw root too: the watcher references node
                // materials as assigned, so multi-sub/shell roots arrive here
                // directly and FindSupportedMaterial would only return a leaf.
                Mtl* rawMtl = node->GetMtl();
                if (rawMtl == targetMtl || FindSupportedMaterial(rawMtl) == targetMtl) {
                    handles.push_back(handle);
                }
            }
            if (!handles.empty()) {
                materialEditHandleCache_[target] = handles;
                return handles;
            }
            handles.clear();
        }

        handles.reserve(geomHandles_.size());
        for (ULONG handle : geomHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;
            // Search from the raw assigned material: it is a superset of the
            // supported subtree, so nested texmaps under multi-sub slots that
            // are not the "first supported" leaf still resolve to this node.
            Mtl* rawMtl = node->GetMtl();
            if (rawMtl && ReferenceTreeContains(rawMtl, target)) {
                handles.push_back(handle);
            }
        }

        materialEditHandleCache_[target] = handles;
        return handles;
    }

    void NotifyMaterialEditedTarget(ReferenceTarget* target) {
        if (!target) {
            MarkMaterialInteractiveActivity();
            return;
        }

        if (geomHandles_.empty()) return;
        // Extraction below may echo REFMSG_CHANGE into the watcher.
        SuppressMaterialEditCaptureScope suppressEcho(*this);

        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        bool changed = false;
        bool cacheStale = false;
        std::unordered_map<Mtl*, MaterialSyncState> materialStateCache;
        const std::vector<ULONG> handles = FindMaterialEditHandles(target);
        Mtl* targetMtl = dynamic_cast<Mtl*>(target);
        if (handles.empty()) {
            MarkInteractiveActivity();
            return;
        }

        for (ULONG handle : handles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                cacheStale = true;
                continue;
            }

            Mtl* rawMtl = node->GetMtl();
            Mtl* supportedMtl = FindSupportedMaterial(rawMtl);
            const bool stillMatches = supportedMtl &&
                ((targetMtl && (supportedMtl == targetMtl || rawMtl == targetMtl)) ||
                 ReferenceTreeContains(rawMtl, target));
            if (!stillMatches) {
                cacheStale = true;
                continue;
            }

            const MaterialSyncState state = ComputeMaterialSyncStateCached(node, t, materialStateCache);
            auto structureIt = mtlHashMap_.find(handle);
            auto scalarIt = mtlScalarHashMap_.find(handle);
            auto fastScalarIt = mtlFastScalarHashMap_.find(handle);
            if (structureIt == mtlHashMap_.end() ||
                scalarIt == mtlScalarHashMap_.end() ||
                fastScalarIt == mtlFastScalarHashMap_.end()) {
                mtlHashMap_[handle] = state.structureHash;
                mtlScalarHashMap_[handle] = state.scalarHash;
                mtlFastScalarHashMap_[handle] = state.fastScalarHash;
                if (!state.canFastSync) {
                    materialFastDirtyHandles_.clear();
                    ClearMaterialEditHandleCache();
                    SetDirtyImmediate();
                    return;
                }
                materialFastDirtyHandles_.insert(handle);
                fastDirtyHandles_.insert(handle);
                changed = true;
                continue;
            }

            const bool structureChanged = structureIt->second != state.structureHash;
            const bool scalarChanged = scalarIt->second != state.scalarHash;
            const bool fastScalarChanged = fastScalarIt->second != state.fastScalarHash;
            mtlHashMap_[handle] = state.structureHash;
            mtlScalarHashMap_[handle] = state.scalarHash;
            mtlFastScalarHashMap_[handle] = state.fastScalarHash;
            if (structureChanged || scalarChanged || !state.canFastSync) {
                materialFastDirtyHandles_.clear();
                ClearMaterialEditHandleCache();
                SetDirtyImmediate();
                return;
            }
            if (fastScalarChanged) {
                materialFastDirtyHandles_.insert(handle);
                fastDirtyHandles_.insert(handle);
                changed = true;
            }
        }

        if (changed) {
            QueueFastFlush();
            return;
        }

        if (cacheStale) ClearMaterialEditHandleCache();
        MarkInteractiveActivity();
    }

    bool IsAnimationPlaying() const {
        Interface* ip = GetCOREInterface();
        return ip && ip->IsAnimPlaying() != 0;
    }

    void QueuePostedTimelineSync() {
        playbackFlushPending_ = true;
        if (playbackFlushPosted_) return;
        const ULONGLONG now = GetTickCount64();
        if (playbackFlushRetryNotBeforeTick_ != 0 &&
            now < playbackFlushRetryNotBeforeTick_) {
            return;
        }
        if (!hwnd_ || !IsWindow(hwnd_) || !IsWindowVisible(hwnd_)) {
            playbackFlushRetryNotBeforeTick_ = now + kTransportRetryBackoffMs;
            return;
        }
        if (PostMessage(hwnd_, WM_PLAYBACK_FLUSH, 0, 0)) {
            playbackFlushPosted_ = true;
        } else {
            playbackFlushRetryNotBeforeTick_ = now + kTransportRetryBackoffMs;
        }
    }

    void PumpTimelineSyncFromTimer() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const TimeValue t = ip->GetTime();
        if (!haveLastTimerTime_) {
            haveLastTimerTime_ = true;
            lastTimerTime_ = t;
            return;
        }
        if (t == lastTimerTime_) return;

        OnTimelineTimeChanged(t);
    }

    void PumpPlaybackSyncFromTimer() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        // A stopped final-pose transport retry may have no further TimeChanged
        // event. Keep its mailbox timer-driven until the backoff expires.
        if (playbackFlushPending_) {
            QueuePostedTimelineSync();
            return;
        }
        if (!IsAnimationPlaying()) {
            haveLastPlaybackPollTime_ = false;
            return;
        }

        const TimeValue t = ip->GetTime();
        if (!playbackRequestedStateKnown_ ||
            playbackRequestedTime_ != t ||
            !playbackRequestedPlaying_) {
            OnTimelineTimeChanged(t);
        }
    }

    void FlushPostedPlaybackSync() {
        playbackFlushPosted_ = false;
        if (!playbackFlushPending_) return;

        const ULONGLONG now = GetTickCount64();
        if (playbackFlushRetryNotBeforeTick_ != 0 &&
            now < playbackFlushRetryNotBeforeTick_) {
            return;
        }

        // TimeChanged only schedules this work. Sample Max again here so a
        // queued playback tick can never publish stale time or revive the
        // playing flag after the user has already pressed Stop.
        Interface* ip = GetCOREInterface();
        if (!ip) {
            playbackFlushRetryNotBeforeTick_ = now + kTransportRetryBackoffMs;
            return;
        }
        const TimeValue t = ip->GetTime();
        const bool playing = ip->IsAnimPlaying() != 0;

        haveLastTimerTime_ = true;
        lastTimerTime_ = t;
        if (!playbackRequestedStateKnown_) {
            playbackRequestedTime_ = t;
            playbackRequestedPlaying_ = playing;
            playbackRequestedStateKnown_ = true;
        } else if (playbackRequestedTime_ != t ||
                   playbackRequestedPlaying_ != playing) {
            // Timer observation is a second latest-state mailbox.  It covers
            // play/stop transitions for which Max does not emit TimeChanged.
            playbackRequestedTime_ = t;
            playbackRequestedPlaying_ = playing;
            ++playbackRequestSerial_;
        }
        if (playbackRequestSerial_ == 0) ++playbackRequestSerial_;
        haveLastPlaybackPollTime_ = playing;
        if (playing) lastPlaybackPollTime_ = t;

        const PlaybackSyncResult result = SendPlaybackDeltaAtTime(t, playing);
        if (result == PlaybackSyncResult::NeedsSlice) {
            playbackFlushRetryNotBeforeTick_ = 0;
            // Only bounded work continuation reposts immediately. Transport
            // failures and hidden/unavailable hosts wait for the timer below.
            QueuePostedTimelineSync();
            return;
        }
        if (result == PlaybackSyncResult::RetryLater) {
            playbackFlushRetryNotBeforeTick_ = now + kTransportRetryBackoffMs;
            return;
        }

        playbackFlushRetryNotBeforeTick_ = 0;
        playbackFlushPending_ = false;
    }

    void OnTimelineTimeChanged(TimeValue t) {
        haveLastTimerTime_ = true;
        lastTimerTime_ = t;

        // This callback sits directly on Max's play/stop/scrub path. Keep it a
        // latest-state mailbox only: no scene evaluation, geometry extraction,
        // packing, or WebView calls are allowed before the callback returns.
        const ULONGLONG now = GetTickCount64();
        lastTimelineInteractionTick_ = now;
        lastInteractionTick_ = now;

        playbackRequestedTime_ = t;
        playbackRequestedStateKnown_ = false; // posted turn samples authoritative play/stop state
        ++playbackRequestSerial_;

        QueuePostedTimelineSync();
    }

    bool PostPreparedSharedDeltaBuffer(ICoreWebView2SharedBuffer* sharedBuf,
                                       std::uint32_t frameId,
                                       std::uint32_t commandCount,
                                       size_t producerBytes) {
        if (!webview_ || !useBinary_ || !sharedBuf) return false;
        ComPtr<ICoreWebView2_17> wv17;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        if (!wv17) return false;

        if (commandCount == 0) return true;

        std::wostringstream meta;
        meta.imbue(std::locale::classic());
        meta << L"{\"type\":\"delta_bin\",\"frame\":" << frameId;
        meta << L",\"stats\":{\"producerBytes\":" << producerBytes;
        meta << L",\"commandCount\":" << commandCount << L"}}";

        const HRESULT postResult = wv17->PostSharedBufferToScript(
            sharedBuf,
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            meta.str().c_str());
        return SUCCEEDED(postResult);
    }

    bool PostSharedDeltaBytes(const std::vector<std::uint8_t>& frameBytes,
                              std::uint32_t frameId,
                              std::uint32_t commandCount,
                              size_t producerBytesFallback = 0) {
        if (!webview_ || !env_ || !useBinary_) return false;

        ComPtr<ICoreWebView2Environment12> env12;
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!env12) return false;

        if (commandCount == 0) return true;
        const size_t totalBytes = frameBytes.empty() ? 4 : frameBytes.size();

        ComPtr<ICoreWebView2SharedBuffer> sharedBuf;
        const HRESULT hr = env12->CreateSharedBuffer(totalBytes, &sharedBuf);
        if (FAILED(hr) || !sharedBuf) return false;

        BYTE* bufPtr = nullptr;
        const HRESULT bufferResult = sharedBuf->get_Buffer(&bufPtr);
        if (FAILED(bufferResult) || !bufPtr) return false;
        if (!frameBytes.empty()) {
            memcpy(bufPtr, frameBytes.data(), frameBytes.size());
        }

        return PostPreparedSharedDeltaBuffer(
            sharedBuf.Get(),
            frameId,
            commandCount,
            frameBytes.empty() ? producerBytesFallback : frameBytes.size());
    }

    bool SendSharedDeltaFrame(maxjs::sync::DeltaFrameBuilder& frame,
                              std::uint32_t frameId,
                              size_t producerBytesFallback = 0) {
        frame.EndFrame();
        return PostSharedDeltaBytes(
            frame.bytes(), frameId, frame.command_count(), producerBytesFallback);
    }

    bool PostSharedFloatPacket(const wchar_t* type, const std::vector<float>& floats, const std::wstring& extraMeta = L"") {
        if (!webview_ || !env_ || !useBinary_ || !type || floats.empty()) return false;

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!wv17 || !env12) return false;

        const size_t totalBytes = std::max<size_t>(4, floats.size() * sizeof(float));
        ComPtr<ICoreWebView2SharedBuffer> sharedBuf;
        HRESULT hr = env12->CreateSharedBuffer(totalBytes, &sharedBuf);
        if (FAILED(hr) || !sharedBuf) return false;

        BYTE* bufPtr = nullptr;
        sharedBuf->get_Buffer(&bufPtr);
        if (bufPtr) memcpy(bufPtr, floats.data(), floats.size() * sizeof(float));

        std::wostringstream meta;
        meta.imbue(std::locale::classic());
        meta << L"{\"type\":\"" << type << L"\",\"floatCount\":" << floats.size();
        if (!extraMeta.empty()) meta << L',' << extraMeta;
        meta << L'}';

        wv17->PostSharedBufferToScript(
            sharedBuf.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            meta.str().c_str());
        return true;
    }

    static Point3 TransformPoint16(const float* m, const Point3& p) {
        return Point3(
            p.x * m[0] + p.y * m[4] + p.z * m[8] + m[12],
            p.x * m[1] + p.y * m[5] + p.z * m[9] + m[13],
            p.x * m[2] + p.y * m[6] + p.z * m[10] + m[14]);
    }

    bool SendNativeGiSurfacePacket(TimeValue t) {
        if (!nativeGiSurfaceDirty_ || geomHandles_.empty()) return false;
        Interface* ip = GetCOREInterface();
        if (!ip) return false;

        static constexpr size_t kGiSampleStride = 12;
        static constexpr size_t kGiSurfaceBudget = 1024;

        struct GiMesh {
            INode* node = nullptr;
            std::vector<float> verts;
            std::vector<float> norms;
            std::vector<int> indices;
            float xform[16] = {};
            float albedo[3] = { 1.0f, 1.0f, 1.0f };
            size_t triCount = 0;
        };

        std::vector<GiMesh> meshes;
        meshes.reserve(geomHandles_.size());
        size_t totalTriangles = 0;

        std::vector<ULONG> handles(geomHandles_.begin(), geomHandles_.end());
        std::sort(handles.begin(), handles.end());
        for (ULONG handle : handles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node || !IsMaxJsSyncDrawVisible(node)) continue;

            GiMesh gm;
            gm.node = node;
            std::vector<float> uvs, norms;
            std::vector<MatGroup> groups;
            std::vector<VertexColorAttributeRecord> vertexColors;
            if (!ExtractMesh(node, t, gm.verts, uvs, gm.indices, groups, &norms, nullptr, &vertexColors, nullptr, nullptr, false, nullptr)) {
                continue;
            }
            gm.norms = std::move(norms);
            if (gm.verts.empty()) continue;
            gm.triCount = gm.indices.empty() ? gm.verts.size() / 9 : gm.indices.size() / 3;
            if (gm.triCount == 0) continue;

            GetTransform16(node, t, gm.xform);
            MaxJSPBR pbr;
            ExtractPBR(node, t, pbr);
            gm.albedo[0] = std::clamp(pbr.color[0], 0.0f, 1.0f);
            gm.albedo[1] = std::clamp(pbr.color[1], 0.0f, 1.0f);
            gm.albedo[2] = std::clamp(pbr.color[2], 0.0f, 1.0f);

            totalTriangles += gm.triCount;
            meshes.push_back(std::move(gm));
        }

        const size_t sampleCount = std::min(kGiSurfaceBudget, totalTriangles);
        if (sampleCount == 0) return false;

        std::vector<float> out;
        out.reserve(sampleCount * kGiSampleStride);

        Point3 boundsMin(FLT_MAX, FLT_MAX, FLT_MAX);
        Point3 boundsMax(-FLT_MAX, -FLT_MAX, -FLT_MAX);
        auto expandBounds = [&](const Point3& p) {
            boundsMin.x = std::min(boundsMin.x, p.x);
            boundsMin.y = std::min(boundsMin.y, p.y);
            boundsMin.z = std::min(boundsMin.z, p.z);
            boundsMax.x = std::max(boundsMax.x, p.x);
            boundsMax.y = std::max(boundsMax.y, p.y);
            boundsMax.z = std::max(boundsMax.z, p.z);
        };

        size_t emitted = 0;
        size_t globalTri = 0;
        size_t nextTarget = totalTriangles > sampleCount
            ? static_cast<size_t>((0.5 * static_cast<double>(totalTriangles)) / static_cast<double>(sampleCount))
            : 0;

        auto readVertex = [](const std::vector<float>& verts, int idx) -> Point3 {
            const size_t o = static_cast<size_t>(std::max(0, idx)) * 3u;
            if (o + 2 >= verts.size()) return Point3(0, 0, 0);
            return Point3(verts[o + 0], verts[o + 1], verts[o + 2]);
        };
        auto transformVector = [](const float* m, const Point3& v) -> Point3 {
            return Point3(
                v.x * m[0] + v.y * m[4] + v.z * m[8],
                v.x * m[1] + v.y * m[5] + v.z * m[9],
                v.x * m[2] + v.y * m[6] + v.z * m[10]);
        };

        for (const GiMesh& gm : meshes) {
            for (size_t tri = 0; tri < gm.triCount && emitted < sampleCount; ++tri, ++globalTri) {
                const bool take = totalTriangles <= sampleCount || globalTri >= nextTarget;
                if (!take) continue;

                int ia = 0, ib = 0, ic = 0;
                if (!gm.indices.empty()) {
                    const size_t io = tri * 3u;
                    ia = gm.indices[io + 0];
                    ib = gm.indices[io + 1];
                    ic = gm.indices[io + 2];
                } else {
                    ia = static_cast<int>(tri * 3u + 0u);
                    ib = static_cast<int>(tri * 3u + 1u);
                    ic = static_cast<int>(tri * 3u + 2u);
                }

                const Point3 a = TransformPoint16(gm.xform, readVertex(gm.verts, ia));
                const Point3 b = TransformPoint16(gm.xform, readVertex(gm.verts, ib));
                const Point3 c = TransformPoint16(gm.xform, readVertex(gm.verts, ic));
                Point3 n(0, 0, 0);
                if (gm.norms.size() == gm.verts.size()) {
                    n = transformVector(gm.xform, readVertex(gm.norms, ia))
                        + transformVector(gm.xform, readVertex(gm.norms, ib))
                        + transformVector(gm.xform, readVertex(gm.norms, ic));
                } else {
                    n = CrossProd(b - a, c - a);
                }
                const float len = n.Length();
                if (len <= 1.0e-7f || !std::isfinite(len)) continue;
                n /= len;
                Point3 p = (a + b + c) / 3.0f;
                expandBounds(p);

                out.push_back(p.x); out.push_back(p.y); out.push_back(p.z);
                out.push_back(n.x); out.push_back(n.y); out.push_back(n.z);
                out.push_back(gm.albedo[0]); out.push_back(gm.albedo[1]); out.push_back(gm.albedo[2]);
                out.push_back(0.0f); out.push_back(0.0f); out.push_back(0.0f);
                ++emitted;
                if (totalTriangles > sampleCount) {
                    nextTarget = static_cast<size_t>(((static_cast<double>(emitted) + 0.5) * static_cast<double>(totalTriangles)) / static_cast<double>(sampleCount));
                }
            }
            globalTri += (gm.triCount > 0 ? 0 : 0);
        }

        if (emitted == 0) return false;
        out.resize(emitted * kGiSampleStride);

        const Point3 size = boundsMax - boundsMin;
        const float pad = std::max(10.0f, std::max(size.x, std::max(size.y, size.z)) * 0.08f);
        boundsMin -= Point3(pad, pad, pad);
        boundsMax += Point3(pad, pad, pad);
        const Point3 paddedSize = boundsMax - boundsMin;

        std::wostringstream extra;
        extra.imbue(std::locale::classic());
        extra << L"\"sampleCount\":" << emitted << L",\"stride\":" << kGiSampleStride;
        extra << L",\"boundsMin\":[" << boundsMin.x << L',' << boundsMin.y << L',' << boundsMin.z << L']';
        extra << L",\"boundsSize\":[" << paddedSize.x << L',' << paddedSize.y << L',' << paddedSize.z << L']';

        if (PostSharedFloatPacket(L"gi_surface_bin", out, extra.str())) {
            nativeGiSurfaceDirty_ = false;
            return true;
        }
        return false;
    }

    bool SendNativeGiLightPacket(TimeValue t) {
        if (lightHandles_.empty()) return false;
        Interface* ip = GetCOREInterface();
        if (!ip) return false;

        static constexpr size_t kLightStride = 16;
        static constexpr size_t kMaxLights = 64;
        std::vector<float> out;
        out.reserve(kMaxLights * kLightStride);

        std::vector<ULONG> handles(lightHandles_.begin(), lightHandles_.end());
        std::sort(handles.begin(), handles.end());
        for (ULONG handle : handles) {
            if (out.size() >= kMaxLights * kLightStride) break;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            float xform[16];
            GetTransform16(node, t, xform);
            maxjs::sync::DeltaFrameBuilder::LightData ld = {};
            ld.matrix16 = xform;
            ld.visible = IsMaxJsSyncDrawVisible(node);
            if (!ExtractLightBinaryData(node, t, ld) || !ld.visible) continue;
            if (ld.type > 2u) continue; // GI currently consumes directional, point, and spot lights.

            const float dirX = -xform[4];
            const float dirY = -xform[5];
            const float dirZ = -xform[6];
            const float dirLen = std::sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
            const float invDirLen = dirLen > 1.0e-7f ? 1.0f / dirLen : 1.0f;
            const float angle = ld.type == 2u && ld.angle > 1.0e-5f ? ld.angle : 1.04719755f;
            const float penumbra = ld.type == 2u ? std::clamp(ld.penumbra, 0.0f, 1.0f) : 0.0f;

            out.push_back(static_cast<float>(ld.type));
            out.push_back(xform[12]); out.push_back(xform[13]); out.push_back(xform[14]);
            out.push_back(dirX * invDirLen); out.push_back(dirY * invDirLen); out.push_back(dirZ * invDirLen);
            out.push_back(ld.color[0] * ld.intensity);
            out.push_back(ld.color[1] * ld.intensity);
            out.push_back(ld.color[2] * ld.intensity);
            out.push_back(ld.distance);
            out.push_back(ld.decay > 0.0f ? ld.decay : 2.0f);
            out.push_back(std::cos(angle));
            out.push_back(std::cos(angle * (1.0f - penumbra)));
            out.push_back(std::max(0.0f, ld.volContrib));
            out.push_back(0.0f);
        }

        if (out.empty()) return false;

        std::wostringstream extra;
        extra.imbue(std::locale::classic());
        extra << L"\"lightCount\":" << (out.size() / kLightStride) << L",\"stride\":" << kLightStride;
        return PostSharedFloatPacket(L"gi_light_bin", out, extra.str());
    }

    void ResetInProgressPlaybackSnapshot() {
        playbackSnapshotActive_ = false;
        playbackSnapshotFinalized_ = false;
        playbackSnapshotPosted_ = false;
        playbackSnapshotTransformStageReady_ = false;
        playbackSnapshotCursor_ = 0;
        playbackSnapshotHasCamera_ = false;
        playbackSnapshotCopySlot_ = -1;
        playbackSnapshotCopyOffset_ = 0;
    }

    bool SendTimelineStateOnly(TimeValue t, bool playing) {
        if (!useBinary_ || !env_) {
            fastTimeDirty_ = true;
            QueueFastFlush();
            return fastFlushPosted_ || fastFlushInProgress_;
        }

        const std::uint32_t frameId = AllocateFrameId();
        playbackStateFrame_.Reset(frameId);
        playbackStateFrame_.BeginFrame();
        playbackStateFrame_.UpdateTime(
            static_cast<std::int32_t>(t), GetTicksPerFrame(), playing ? 0x01 : 0x00);
        // maxTimeline dispatches this state on requestAnimationFrame; no scene
        // listener runs synchronously against the old pose while the bounded
        // native snapshot is still being sampled.
        playbackStateFrame_.EndFrame();

        const auto& frameBytes = playbackStateFrame_.bytes();
        int stateSlotIndex = playbackStateSharedBufferNext_ & 1;
        auto stateSlotReady = [&](int index) {
            const PlaybackSharedBufferSlot& candidate = playbackStateSharedBuffers_[index];
            return candidate.buf && candidate.capacity >= frameBytes.size();
        };
        if (!stateSlotReady(stateSlotIndex) && stateSlotReady(stateSlotIndex ^ 1)) {
            stateSlotIndex ^= 1;
        }
        PlaybackSharedBufferSlot& slot = playbackStateSharedBuffers_[stateSlotIndex];
        if (!stateSlotReady(stateSlotIndex)) {
            // Capacity is provisioned only at a full-sync boundary. Re-arm one
            // rather than allocating on the user's timeline interaction path.
            SetDirtyImmediate(false);
            return false;
        }

        BYTE* bufPtr = nullptr;
        const HRESULT bufferResult = slot.buf->get_Buffer(&bufPtr);
        if (FAILED(bufferResult) || !bufPtr) return false;
        memcpy(bufPtr, frameBytes.data(), frameBytes.size());
        if (!PostPreparedSharedDeltaBuffer(
                slot.buf.Get(), frameId, playbackStateFrame_.command_count(), frameBytes.size())) {
            return false;
        }
        playbackStateSharedBufferNext_ = (stateSlotIndex + 1) & 1;
        return true;
    }

    void StartPlaybackSnapshot(TimeValue t, bool playing, std::uint64_t requestSerial) {
        playbackSnapshotActive_ = true;
        playbackSnapshotFinalized_ = false;
        playbackSnapshotPosted_ = false;
        playbackSnapshotTransformStageReady_ = false;
        playbackSnapshotTime_ = t;
        playbackSnapshotPlaying_ = playing;
        playbackSnapshotSerial_ = requestSerial;
        playbackSnapshotCursor_ = 0;
        playbackSnapshotHasCamera_ = false;

        const std::uint32_t frameId = AllocateFrameId();
        playbackSnapshotFrame_.Reset(frameId);
        playbackSnapshotFrame_.BeginFrame();
    }

    PlaybackSyncResult CopyAndPostFinalizedPlaybackSnapshot() {
        const auto& frameBytes = playbackSnapshotFrame_.bytes();
        if (playbackSnapshotPosted_) return PlaybackSyncResult::Complete;
        if (playbackSnapshotFrame_.command_count() == 0) {
            return PlaybackSyncResult::Complete;
        }

        if (playbackSnapshotCopySlot_ < 0) {
            int candidate = playbackSnapshotSharedBufferNext_ & 1;
            auto snapshotSlotReady = [&](int index) {
                const PlaybackSharedBufferSlot& slot =
                    playbackSnapshotSharedBuffers_[index];
                return slot.buf && slot.capacity >= frameBytes.size();
            };
            if (!snapshotSlotReady(candidate) && snapshotSlotReady(candidate ^ 1)) {
                candidate ^= 1;
            }
            if (!snapshotSlotReady(candidate)) {
                // The scene grew beyond its full-sync epoch or preallocation
                // failed. Never allocate here; a fresh full sync reprovisions.
                SetDirtyImmediate(false);
                return PlaybackSyncResult::RetryLater;
            }
            playbackSnapshotCopySlot_ = candidate;
            playbackSnapshotCopyOffset_ = 0;
            playbackSnapshotSharedBufferNext_ = (candidate + 1) & 1;
        }

        PlaybackSharedBufferSlot& slot =
            playbackSnapshotSharedBuffers_[playbackSnapshotCopySlot_];
        BYTE* bufPtr = nullptr;
        const HRESULT bufferResult = slot.buf->get_Buffer(&bufPtr);
        if (FAILED(bufferResult) || !bufPtr) {
            return PlaybackSyncResult::RetryLater;
        }

        // Copy the already-finalized frame in small quanta. This combines a
        // fixed byte ceiling with the same <=4ms UI-thread wall-clock budget
        // used by scene sampling. A failed WebView post retains this completed
        // slot and offset, so retry does not copy or evaluate the scene again.
        const ULONGLONG passStart = GetTickCount64();
        LARGE_INTEGER performanceFrequency = {};
        LARGE_INTEGER performanceStart = {};
        const bool havePerformanceClock =
            QueryPerformanceFrequency(&performanceFrequency) != FALSE &&
            QueryPerformanceCounter(&performanceStart) != FALSE &&
            performanceFrequency.QuadPart > 0;
        auto copyTimeBudgetExpired = [&]() {
            if (havePerformanceClock) {
                LARGE_INTEGER performanceNow = {};
                QueryPerformanceCounter(&performanceNow);
                return (performanceNow.QuadPart - performanceStart.QuadPart) * 1000 >=
                       performanceFrequency.QuadPart *
                           static_cast<LONGLONG>(kTimelineSampleBudgetMs);
            }
            return (GetTickCount64() - passStart) >= kTimelineSampleBudgetMs;
        };
        size_t copiedThisPass = 0;
        while (playbackSnapshotCopyOffset_ < frameBytes.size() &&
               copiedThisPass < kTimelineTransportCopyBytesPerPass) {
            const size_t remaining = frameBytes.size() - playbackSnapshotCopyOffset_;
            const size_t passRemaining =
                kTimelineTransportCopyBytesPerPass - copiedThisPass;
            const size_t copyBytes = std::min(
                remaining,
                std::min(passRemaining, kTimelineTransportCopyQuantumBytes));
            memcpy(
                bufPtr + playbackSnapshotCopyOffset_,
                frameBytes.data() + playbackSnapshotCopyOffset_,
                copyBytes);
            playbackSnapshotCopyOffset_ += copyBytes;
            copiedThisPass += copyBytes;
            if (copyTimeBudgetExpired()) break;
        }

        if (playbackSnapshotCopyOffset_ < frameBytes.size()) {
            return PlaybackSyncResult::NeedsSlice;
        }
        if (!PostPreparedSharedDeltaBuffer(
                slot.buf.Get(),
                playbackSnapshotFrame_.frame_id(),
                playbackSnapshotFrame_.command_count(),
                frameBytes.size())) {
            return PlaybackSyncResult::RetryLater;
        }
        // Delivery is the atomic cache commit point. Both inactive maps contain
        // the complete sampled state, so transforms and auxiliary visibility /
        // selection / light hashes advance together in O(1). A newer stopped
        // target can now safely supersede this snapshot without comparing
        // against state older than what the viewer actually received.
        lastSentTransforms_.swap(playbackSnapshotTransforms_);
        lastSentPlaybackAux_.swap(playbackSnapshotAux_);
        if (playbackSnapshotHasCamera_) {
            lastSentCamera_ = playbackSnapshotCamera_;
            haveLastSentCamera_ = true;
            fastCameraDirty_ = false;
        }
        playbackSnapshotPosted_ = true;
        return PlaybackSyncResult::Complete;
    }

    PlaybackSyncResult SendPlaybackDeltaAtTime(TimeValue t, bool playing) {
        if (!jsReady_ || !webview_ || !hwnd_ || !IsWindow(hwnd_) ||
            !IsWindowVisible(hwnd_)) {
            return PlaybackSyncResult::RetryLater;
        }
        if (!useBinary_ || !env_) {
            // Debug JSON mode retains its bounded dirty-scan fallback.  The
            // normal LIVE path below is the atomic binary snapshot lane.
            pendingTimelineTransformScan_ = true;
            pendingTimelineCameraCheck_ = true;
            fastTimeDirty_ = true;
            QueueFastFlush();
            return (fastFlushPosted_ || fastFlushInProgress_)
                ? PlaybackSyncResult::Complete
                : PlaybackSyncResult::RetryLater;
        }

        Interface* ip = GetCOREInterface();
        if (!ip) return PlaybackSyncResult::RetryLater;

        if (playbackStateSentSerial_ != playbackRequestSerial_) {
            if (!SendTimelineStateOnly(t, playing)) {
                return PlaybackSyncResult::RetryLater;
            }
            playbackStateSentSerial_ = playbackRequestSerial_;
        }

        const bool targetSupersedesActive =
            playbackSnapshotActive_ &&
            (playbackSnapshotSerial_ != playbackRequestSerial_ ||
             playbackSnapshotTime_ != t ||
             playbackSnapshotPlaying_ != playing);
        if (targetSupersedesActive &&
            (!playbackSnapshotPlaying_ || !playing)) {
            // Scrub/seek and especially Stop are final-pose requests: discard
            // an older in-progress sample immediately.  During continuous
            // playing we instead finish one atomic sample so a large scene can
            // never starve under a stream of newer ticks; the latest tick stays
            // coalesced in playbackRequested* and starts next.
            ResetInProgressPlaybackSnapshot();
        }

        if (!playbackSnapshotActive_) {
            StartPlaybackSnapshot(t, playing, playbackRequestSerial_);
        }

        if (!playbackSnapshotFinalized_) {
            const double passStart = QpcNowMs();
            size_t visited = 0;
            if (!playbackSnapshotTransformStageReady_) {
                // A prior successful swap leaves the old acknowledged cache in
                // this inactive map.  Drain it under the same UI-thread budget
                // instead of calling unordered_map::clear() in one stop/play
                // turn; once empty, its buckets are retained for this sample.
                while ((!playbackSnapshotTransforms_.empty() ||
                        !playbackSnapshotAux_.empty()) &&
                       visited < kMaxTimelineSnapshotHandlesPerPass) {
                    if (!playbackSnapshotTransforms_.empty()) {
                        playbackSnapshotTransforms_.erase(
                            playbackSnapshotTransforms_.begin());
                    } else {
                        playbackSnapshotAux_.erase(playbackSnapshotAux_.begin());
                    }
                    ++visited;
                    if (TimelineBudgetExpired(passStart)) break;
                }
                if (!playbackSnapshotTransforms_.empty() ||
                    !playbackSnapshotAux_.empty()) {
                    return PlaybackSyncResult::NeedsSlice;
                }
                playbackSnapshotTransformStageReady_ = true;
                if (TimelineBudgetExpired(passStart)) {
                    return PlaybackSyncResult::NeedsSlice;
                }
                visited = 0;
            }

            while (playbackSnapshotCursor_ < playbackSnapshotHandles_.size() &&
                   visited < kMaxTimelineSnapshotHandlesPerPass) {
                const ULONG handle = playbackSnapshotHandles_[playbackSnapshotCursor_++];
                ++visited;

                INode* node = ip->GetINodeByHandle(handle);
                if (!node) {
                    playbackSnapshotTransforms_.erase(handle);
                    SetDirty();
                } else {
                    float xform[16];
                    const bool transformChanged = HasTransformChangedForSync(
                        handle, node, playbackSnapshotTime_, xform);
                    std::array<float, 16>& staged = playbackSnapshotTransforms_[handle];
                    std::copy(xform, xform + 16, staged.begin());
                    const bool visible = IsMaxJsSyncDrawVisible(node);
                    const auto previousAuxIt = lastSentPlaybackAux_.find(handle);
                    const bool hasPreviousAux =
                        previousAuxIt != lastSentPlaybackAux_.end();
                    PlaybackAuxDeliveryState currentAux = hasPreviousAux
                        ? previousAuxIt->second
                        : PlaybackAuxDeliveryState{};
                    const bool visibilityChanged =
                        !hasPreviousAux || currentAux.visible != visible;
                    currentAux.visible = visible;

                    if (lightHandles_.find(handle) != lightHandles_.end()) {
                        const std::uint64_t lightStateHash =
                            ComputeLightStateHash(node, playbackSnapshotTime_);
                        const bool lightStateChanged =
                            !hasPreviousAux || !currentAux.hasLightStateHash ||
                            currentAux.lightStateHash != lightStateHash;
                        if (transformChanged || lightStateChanged) {
                            maxjs::sync::DeltaFrameBuilder::LightData ld = {};
                            ld.matrix16 = xform;
                            ld.visible = visible;
                            if (ExtractLightBinaryData(node, playbackSnapshotTime_, ld)) {
                                playbackSnapshotFrame_.UpdateLight(
                                    static_cast<std::uint32_t>(handle), ld);
                                currentAux.lightStateHash = lightStateHash;
                                currentAux.hasLightStateHash = true;
                            } else {
                                if (transformChanged) {
                                    playbackSnapshotFrame_.UpdateTransform(
                                        static_cast<std::uint32_t>(handle), xform);
                                }
                                if (visibilityChanged) {
                                    playbackSnapshotFrame_.UpdateVisibility(
                                        static_cast<std::uint32_t>(handle), visible);
                                }
                                SetDirty();
                            }
                        }
                    } else if (audioHandles_.find(handle) != audioHandles_.end()) {
                        if (transformChanged || visibilityChanged) {
                            playbackSnapshotFrame_.UpdateAudio(
                                static_cast<std::uint32_t>(handle), xform, visible);
                        }
                    } else if (gltfHandles_.find(handle) != gltfHandles_.end()) {
                        if (transformChanged || visibilityChanged) {
                            playbackSnapshotFrame_.UpdateGLTF(
                                static_cast<std::uint32_t>(handle), xform, visible);
                        }
                    } else if (webappHandles_.find(handle) != webappHandles_.end()) {
                        if (transformChanged || visibilityChanged) {
                            playbackSnapshotFrame_.UpdateWebApp(
                                static_cast<std::uint32_t>(handle), xform, visible);
                        }
                    } else {
                        if (transformChanged) {
                            playbackSnapshotFrame_.UpdateTransform(
                                static_cast<std::uint32_t>(handle), xform);
                        }
                        if (helperHandles_.find(handle) != helperHandles_.end()) {
                            const bool selected = node->Selected() != 0;
                            if (!currentAux.hasSelection ||
                                currentAux.selected != selected) {
                                playbackSnapshotFrame_.UpdateSelection(
                                    static_cast<std::uint32_t>(handle), selected);
                            }
                            currentAux.selected = selected;
                            currentAux.hasSelection = true;
                        }
                        if (visibilityChanged) {
                            playbackSnapshotFrame_.UpdateVisibility(
                                static_cast<std::uint32_t>(handle), visible);
                        }
                    }
                    playbackSnapshotAux_[handle] = currentAux;
                }

                if (TimelineBudgetExpired(passStart)) break;
            }

            if (playbackSnapshotCursor_ < playbackSnapshotHandles_.size()) {
                return PlaybackSyncResult::NeedsSlice;
            }

            GetActiveCameraAtTime(playbackSnapshotCamera_, playbackSnapshotTime_);
            playbackSnapshotHasCamera_ =
                !haveLastSentCamera_ ||
                !CameraEquals(lastSentCamera_, playbackSnapshotCamera_);
            if (playbackSnapshotHasCamera_) {
                playbackSnapshotFrame_.UpdateCamera(
                    playbackSnapshotCamera_.pos,
                    playbackSnapshotCamera_.target,
                    playbackSnapshotCamera_.up,
                    playbackSnapshotCamera_.fov,
                    playbackSnapshotCamera_.perspective,
                    playbackSnapshotCamera_.viewWidth,
                    playbackSnapshotCamera_.dofEnabled,
                    playbackSnapshotCamera_.dofFocusDistance,
                    playbackSnapshotCamera_.dofFocalLength,
                    playbackSnapshotCamera_.dofBokehScale);
            }
            playbackSnapshotFrame_.EndFrame();
            playbackSnapshotFinalized_ = true;
            // Do not stack transport copying on the same WndProc turn that
            // just finished scene evaluation and camera sampling.
            return PlaybackSyncResult::NeedsSlice;
        }

        const PlaybackSyncResult transportResult =
            CopyAndPostFinalizedPlaybackSnapshot();
        if (transportResult != PlaybackSyncResult::Complete) {
            return transportResult;
        }

        const std::uint64_t deliveredSerial = playbackSnapshotSerial_;
        const TimeValue deliveredTime = playbackSnapshotTime_;
        const bool deliveredPlaying = playbackSnapshotPlaying_;
        ResetInProgressPlaybackSnapshot();

        if (!timelineDeformHandles_.empty()) {
            pendingTimelineDeformScan_ = true;
            QueueFastFlush();
        }

        return deliveredSerial == playbackRequestSerial_ &&
                       deliveredTime == t &&
                       deliveredPlaying == playing
            ? PlaybackSyncResult::Complete
            : PlaybackSyncResult::NeedsSlice;
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

    bool ShouldSuppressSelectedGeometryDuringTimeline() const {
        if (IsAnimationPlaying()) return true;
        const ULONGLONG now = GetTickCount64();
        return lastTimelineInteractionTick_ != 0 &&
               (now - lastTimelineInteractionTick_) <= kInteractiveCooldownMs;
    }

    bool ShouldSuppressSelectedGeometryForTransform() const {
        const ULONGLONG now = GetTickCount64();
        return lastTransformInteractionTick_ != 0 &&
               (now - lastTransformInteractionTick_) <= kInteractiveCooldownMs;
    }

    bool ShouldUseTimelineGeometryFastLane() const {
        return IsAnimationPlaying() || ShouldSuppressSelectedGeometryDuringTimeline();
    }

    bool QueuePendingDeformNormalRefresh() {
        if (deformNormalRefreshPendingHandles_.empty()) return false;
        if (ShouldUseTimelineGeometryFastLane() || ShouldFavorInteractivePerformance()) return false;
        if (deformNormalRefreshDueTick_ != 0 &&
            GetTickCount64() < deformNormalRefreshDueTick_) return false;

        Interface* ip = GetCOREInterface();
        if (!ip) return false;

        auto isLiveDeformer = [this, ip](ULONG handle) {
            const bool stillDeforming =
                skinnedHandles_.find(handle) != skinnedHandles_.end() ||
                deformHandles_.find(handle) != deformHandles_.end();
            return stillDeforming && ip->GetINodeByHandle(handle) != nullptr;
        };

        if (deformNormalRefreshQueuedHandle_ != 0) {
            const ULONG queuedHandle = deformNormalRefreshQueuedHandle_;
            if (deformNormalRefreshPendingHandles_.find(queuedHandle) !=
                    deformNormalRefreshPendingHandles_.end() &&
                isLiveDeformer(queuedHandle)) {
                geoFastDirtyHandles_.insert(queuedHandle);
                QueueFastFlush();
                return true;
            }
            deformNormalRefreshPendingHandles_.erase(queuedHandle);
            deformNormalRefreshQueuedHandle_ = 0;
        }

        ULONG refreshHandle = 0;
        bool haveRefreshHandle = false;
        size_t inspected = 0;
        for (auto it = deformNormalRefreshPendingHandles_.begin();
             it != deformNormalRefreshPendingHandles_.end() &&
                 inspected < kMaxGeometryFastFlushHandlesPerPass; ) {
            const ULONG handle = *it;
            ++inspected;
            if (!isLiveDeformer(handle)) {
                it = deformNormalRefreshPendingHandles_.erase(it);
                continue;
            }
            refreshHandle = handle;
            haveRefreshHandle = true;
            break;
        }

        if (!haveRefreshHandle) {
            if (deformNormalRefreshPendingHandles_.empty()) {
                deformNormalRefreshDueTick_ = 0;
                return false;
            }
            // Stale-debt cleanup is bounded too. Leave the remaining set for
            // the next 33 ms timer turn instead of scanning it all on Stop.
            return true;
        }

        // Deliberately bypass lastLiveGeomHash_: a position-only update already
        // recorded the final position hash, but its CPU normals still need one
        // exact delivery after the interaction cools down. Queue one handle per
        // pass so several rigs cannot aggregate into a new stop-time stall.
        deformNormalRefreshQueuedHandle_ = refreshHandle;
        geoFastDirtyHandles_.insert(refreshHandle);
        QueueFastFlush();
        return true;
    }

    bool ShouldPollSelectedGeometryLive() const {
        return IsSubObjectEditingActive() || ShouldFavorInteractivePerformance();
    }

    bool ShouldDeferFullSyncForInteraction(ULONGLONG now) const {
        return lastInteractionTick_ != 0 &&
               (now - lastInteractionTick_) <= kFullSyncInteractiveDeferMs;
    }

    bool CanFlushFastPathDuringPendingFullSync() const {
        if (!dirty_) return true;
        // After a failed full-scene post there is no trustworthy viewer
        // baseline. Geo-fast delivery could repopulate producer hashes against
        // meshes the viewer never received, causing the full retry to omit
        // geometry. Keep every delta owner queued until one scene is accepted.
        if (fullSyncRetryNotBeforeTick_ != 0) return false;
        return ShouldDeferFullSyncForInteraction(GetTickCount64());
    }

    bool ShouldRunInteractiveMaterialChecks() const {
        const ULONGLONG now = GetTickCount64();
        return lastMaterialInteractionTick_ != 0 &&
               (now - lastMaterialInteractionTick_) <= kMaterialInteractiveCooldownMs;
    }

    bool ConsumeRedrawLivePollSlot() {
        const ULONGLONG now = MaxJSLivePollNowMs();
        if (lastRedrawLivePollTick_ != 0 &&
            (now - lastRedrawLivePollTick_) < kSkinnedLivePollIntervalMs) {
            return false;
        }
        lastRedrawLivePollTick_ = now;
        return true;
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

    void PollInteractiveFastPathWhileFullSyncDeferred() {
        CheckSkinnedGeometryLive();
        MarkSelectedTransformsDirty();
        CheckSelectedGeometryLive();
        MarkCameraDirtyIfChanged(false);
        PollViewportModes();
        if (ShouldRunInteractiveMaterialChecks()) CheckTrackedMaterialScalarsLive();
    }

    void ConsumePendingTimelineFastSyncWork() {
        if (!pendingTimelineTransformScan_ &&
            !pendingTimelineDeformScan_ &&
            !pendingTimelineCameraCheck_) {
            return;
        }

        const bool scanTransforms = pendingTimelineTransformScan_;
        const bool scanDeform = pendingTimelineDeformScan_;
        const bool checkCamera = pendingTimelineCameraCheck_;
        pendingTimelineTransformScan_ = false;
        pendingTimelineDeformScan_ = false;
        pendingTimelineCameraCheck_ = false;

        const bool wasSuppressingPost = suppressFastFlushPost_;
        suppressFastFlushPost_ = true;
        if (scanTransforms) MarkAnimatedTransformsDirty();
        if (scanDeform) CheckSkinnedGeometryLive(true);
        if (checkCamera) MarkCameraDirtyIfChanged(false);
        suppressFastFlushPost_ = wasSuppressingPost;

        // Bounded transform/deform scans re-arm their own flag until the
        // cached handle cycle is complete.  Post the next slice only after the
        // current WndProc turn returns.
        if (pendingTimelineTransformScan_ || pendingTimelineDeformScan_ ||
            pendingTimelineCameraCheck_) {
            QueueFastFlush();
        }
    }

    void ResetFastPathState(bool refreshCameraState = false) {
        fastDirtyHandles_.clear();
        selectionDirtyHandles_.clear();
        selectionRescanDirty_ = false;
        visibilityDirtyHandles_.clear();
        geoFullFastDirtyHandles_.clear();
        materialFastDirtyHandles_.clear();
        fastCameraDirty_ = false;
        fastTimeDirty_ = false;
        fastFlushPosted_ = false;
        pendingTimelineTransformScan_ = false;
        pendingTimelineDeformScan_ = false;
        pendingTimelineCameraCheck_ = false;
        playbackFlushPending_ = false;
        playbackFlushPosted_ = false;
        playbackFlushRetryNotBeforeTick_ = 0;
        fastFlushRetryNotBeforeTick_ = 0;
        playbackRequestedStateKnown_ = false;
        playbackRequestedTime_ = 0;
        playbackRequestedPlaying_ = false;
        playbackRequestSerial_ = 0;
        playbackStateSentSerial_ = 0;
        ResetInProgressPlaybackSnapshot();
        playbackSnapshotTransforms_.clear();
        haveLastPlaybackPollTime_ = false;
        haveLastDeformLivePollTime_ = false;
        lastTimelineInteractionTick_ = 0;
        lastTransformInteractionTick_ = 0;
        lastCameraLivePollTick_ = 0;
        lastRedrawLivePollTick_ = 0;
        deformLiveScanCursor_ = 0;
        RebuildTimelineHandleCaches();
        if (refreshCameraState) CaptureCurrentCameraState();
        else haveLastSentCamera_ = false;
    }

    void HandleFullSyncDeliveryFailure() {
        // A failed scene post did not advance viewer state. Invalidate every
        // producer-side cache whose value could otherwise make the retry omit
        // data as "already sent", most importantly geometry and transforms.
        lastSentTransforms_.clear();
        lastSentPlaybackAux_.clear();
        haveLastSentCamera_ = false;
        fastCameraDirty_ = true;
        geoHashMap_.clear();
        geoFastTriangleCountMap_.clear();
        deformChannelHashMap_.clear();
        groupCache_.clear();
        lastBBoxHash_.clear();
        lastLiveGeomHash_.clear();
        mtlHashMap_.clear();
        mtlScalarHashMap_.clear();
        mtlFastScalarHashMap_.clear();
        lightHashMap_.clear();
        audioHashMap_.clear();
        gltfHashMap_.clear();
        webappHashMap_.clear();
        propHashMap_.clear();
        jsmodStateMap_.clear();
        ClearMaterialEditHandleCache();

        playbackStateSentSerial_ = 0;
        ResetInProgressPlaybackSnapshot();
        playbackSnapshotTransforms_.clear();
        RebuildTimelineHandleCaches();

        pathTracingHasSceneSync_ = false;
        SetDirtyImmediate(false);
        // SetDirtyImmediate is intentionally disabled in slow-json mode; a
        // failed explicit full-scene delivery must still retain ownership.
        dirty_ = true;
        dirtyStamp_ = 0;
        idlePollFullSyncPending_ = false;
        fullSyncRetryNotBeforeTick_ =
            GetTickCount64() + kFullSyncTransportRetryBackoffMs;
    }

    bool ShouldBootstrapVisibleNode(INode* node, TimeValue t) const {
        if (!node) return false;
        if (IsMaxJSHierarchyNode(node, t)) return true;
        if (IsForestPackNode(node) || IsRailCloneNode(node) ||
            (IsTyFlowAvailable() && IsTyFlowNode(node))) {
            return true;
        }

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj) return false;
        if (IsThreeJSAudioClassID(os.obj->ClassID())) return true;
        if (IsThreeJSGLTFClassID(os.obj->ClassID())) return true;
        if (IsThreeJSWebAppClassID(os.obj->ClassID())) return true;

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
        if (!node) return;
        const ULONG rootHandle = node->GetHandle();
        if (IsTrackedHandle(rootHandle)) {
            if (fastDirtyHandles_.insert(rootHandle).second) QueueFastFlush();
            return;
        }
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

    bool MarkControllerNodesDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        bool changed = false;
        Interface* ip = GetCOREInterface();
        const TimeValue t = ip ? ip->GetTime() : 0;
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;
            const ULONG handle = node->GetHandle();

            if (helperHandles_.find(handle) != helperHandles_.end()) {
                float currentWorld[16];
                if (HasTransformChangedForSync(handle, node, t, currentWorld)) {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                } else {
                    RememberSkippedParentedTransform(handle, node, currentWorld);
                }
                continue;
            }

            const size_t before = fastDirtyHandles_.size();
            MarkTrackedNodeDirty(node);
            if (fastDirtyHandles_.size() != before) changed = true;
        }
        if (changed) QueueFastFlush();
        return changed;
    }

    void MarkSelectionNodesDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        (void)nodes;
        selectionRescanDirty_ = true;
        QueueFastFlush();
    }

    void MarkMaterialNodesDirty(const NodeEventNamespace::NodeKeyTab& nodes, bool structured) {
        if (nodes.Count() <= 0) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const TimeValue t = ip->GetTime();
        bool changed = false;
        bool needsFullSync = false;
        std::unordered_map<Mtl*, MaterialSyncState> materialStateCache;

        if (structured) ClearMaterialEditHandleCache();

        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;
            VisitNodeSubtree(node, [this, t, structured, &changed, &needsFullSync, &materialStateCache](INode* current) {
                const ULONG handle = current->GetHandle();
                if (!IsTrackedHandle(handle)) return;
                if (geomHandles_.find(handle) == geomHandles_.end()) return;

                if (structured) {
                    mtlHashMap_.erase(handle);
                    mtlScalarHashMap_.erase(handle);
                    mtlFastScalarHashMap_.erase(handle);
                    needsFullSync = true;
                    return;
                }

                const MaterialSyncState state = ComputeMaterialSyncStateCached(current, t, materialStateCache);
                auto structureIt = mtlHashMap_.find(handle);
                auto scalarIt = mtlScalarHashMap_.find(handle);
                auto fastScalarIt = mtlFastScalarHashMap_.find(handle);
                if (structureIt == mtlHashMap_.end() ||
                    scalarIt == mtlScalarHashMap_.end() ||
                    fastScalarIt == mtlFastScalarHashMap_.end()) {
                    mtlHashMap_[handle] = state.structureHash;
                    mtlScalarHashMap_[handle] = state.scalarHash;
                    mtlFastScalarHashMap_[handle] = state.fastScalarHash;
                    if (!state.canFastSync) {
                        needsFullSync = true;
                        return;
                    }
                    materialFastDirtyHandles_.insert(handle);
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                    return;
                }

                const bool structureChanged = structureIt->second != state.structureHash;
                const bool scalarChanged = scalarIt->second != state.scalarHash;
                const bool fastScalarChanged = fastScalarIt->second != state.fastScalarHash;
                if (!structureChanged && !scalarChanged && !fastScalarChanged) return;

                structureIt->second = state.structureHash;
                scalarIt->second = state.scalarHash;
                fastScalarIt->second = state.fastScalarHash;

                if (structureChanged || scalarChanged || !state.canFastSync) {
                    if (structureChanged) {
                        groupCache_.erase(handle);
                        geoHashMap_.erase(handle);
                        lastBBoxHash_.erase(handle);
                    }
                    needsFullSync = true;
                    return;
                }

                materialFastDirtyHandles_.insert(handle);
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            });
            if (needsFullSync) break;
        }

        if (needsFullSync) {
            materialFastDirtyHandles_.clear();
            ClearMaterialEditHandleCache();
            SetDirtyImmediate();
        } else if (changed) {
            QueueFastFlush();
        }
    }

    // Geometry position change (deform/vertex edit) — fast path, no full sync
    void MarkGeometryPositionsDirty(const NodeEventNamespace::NodeKeyTab& nodes) {
        Interface* ip = GetCOREInterface();
        const TimeValue t = ip ? ip->GetTime() : 0;
        bool changed = false;
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;
            VisitNodeSubtree(node, [this, t, &changed](INode* current) {
                const ULONG handle = current->GetHandle();
                if (!IsTrackedHandle(handle)) return;
                // Hair handles get full re-extraction via SendHairFastUpdate —
                // they don't go through geoFastDirtyHandles_ (no mesh to send).
                if (hairHandles_.count(handle)) {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                    return;
                }
                geoHashMap_.erase(handle);
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
        Interface* ip = GetCOREInterface();
        const TimeValue t = ip ? ip->GetTime() : 0;
        bool changed = false;
        bool needsFullSync = false;
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;
            VisitNodeSubtree(node, [this, t, &changed, &needsFullSync](INode* current) {
                const ULONG handle = current->GetHandle();
                if (!IsTrackedHandle(handle)) return;
                if (hairHandles_.count(handle)) {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                    return;
                }
                const bool omitFastChannels = ShouldOmitGeometryFastChannels(current, t);

                // Hash-dedupe before doing anything. Max fires spurious
                // ControllerStructured / TopologyChanged events on viewport
                // redraw for many cases: Editable Poly live cache flips,
                // modifier validity-interval churn, procedural generators
                // (RailClone / Forest Pack / TyFlow) re-evaluating per
                // redraw, etc. If the current geometry state hashes
                // identical to the last sent state, this is one of those
                // spurious events — skip both the fast-path mark AND the
                // full-sync escalation. Camera movement with nothing
                // selected used to flip scene/delta at 30Hz because every
                // spurious structural event escalated to a full binary
                // sync (see MarkGeometryTopologyDirty / SetDirty path).
                uint64_t liveHash = 0;
                auto hashIt = geoHashMap_.find(handle);
                if (hashIt != geoHashMap_.end() &&
                    TryHashRenderableGeometryFastState(current, t, omitFastChannels, liveHash) &&
                    liveHash == hashIt->second) {
                    return;
                }
                geoHashMap_.erase(handle);

                // Real change detected (or first-seen handle): route through
                // fast path when possible, fall back to full sync only for
                // unselected static meshes where topology/UV edits could be
                // missed by the positions-only fast-positions path.
                //
                // Procedurals (RC/FP/Ty) always take the fast path — the
                // hash dedupe above handles their spurious events, and when
                // they do change, geo_fast correctly streams the new mesh.
                const bool isProcedural =
                    IsForestPackNode(current) ||
                    IsRailCloneNode(current) ||
                    (IsTyFlowAvailable() && IsTyFlowNode(current));
                const bool isDeformingHandle =
                    skinnedHandles_.count(handle) ||
                    deformHandles_.count(handle);
                if (omitFastChannels ||
                    isDeformingHandle ||
                    current->Selected() ||
                    isProcedural) {
                    geoFastDirtyHandles_.insert(handle);
                    if (isDeformingHandle) geoFullFastDirtyHandles_.insert(handle);
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
        auto markHandleIfChanged = [this, t, &changed](INode* current) {
            if (!current) return;
            const ULONG handle = current->GetHandle();
            if (!IsTrackedHandle(handle)) return;

            float currentWorld[16];
            if (HasTransformChangedForSync(handle, current, t, currentWorld)) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            } else {
                RememberSkippedParentedTransform(handle, current, currentWorld);
            }
        };

        for (int i = 0; i < selCount; ++i) {
            INode* node = ip->GetSelNode(i);
            if (!node) continue;
            if (IsTrackedHandle(node->GetHandle())) {
                markHandleIfChanged(node);
                continue;
            }

            VisitNodeSubtree(node, markHandleIfChanged);
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
        fastDirtyHandles_.insert(audioHandles_.begin(), audioHandles_.end());
        fastDirtyHandles_.insert(gltfHandles_.begin(), gltfHandles_.end());
        fastDirtyHandles_.insert(webappHandles_.begin(), webappHandles_.end());
        fastDirtyHandles_.insert(hairHandles_.begin(), hairHandles_.end());
        fastDirtyHandles_.insert(helperHandles_.begin(), helperHandles_.end());
        QueueFastFlush();
    }

    void MarkAnimatedTransformsDirty() {
        if (playbackSnapshotHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const TimeValue t = ip->GetTime();
        const bool playing = ip->IsAnimPlaying() != 0;
        if (!timelineTransformScanActive_) {
            timelineTransformScanActive_ = true;
            timelineTransformScanCursor_ = 0;
            timelineTransformScanTime_ = t;
            timelineTransformScanPlaying_ = playing;
        } else if (timelineTransformScanTime_ != t ||
                   timelineTransformScanPlaying_ != playing) {
            if (!playing || !timelineTransformScanPlaying_) {
                timelineTransformScanCursor_ = 0;
            }
            timelineTransformScanTime_ = t;
            timelineTransformScanPlaying_ = playing;
        }

        bool changed = false;
        auto markIfTransformChanged = [this, t, &changed](ULONG handle) {
            INode* node = GetCOREInterface() ? GetCOREInterface()->GetINodeByHandle(handle) : nullptr;
            if (!node) return;

            float currentWorld[16];
            if (HasTransformChangedForSync(handle, node, t, currentWorld)) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        };

        // JSON/debug fallback only.  Keep even this compatibility lane bounded
        // so a timer/posted turn can never evaluate the complete scene.
        const double passStart = QpcNowMs();
        size_t visited = 0;
        while (timelineTransformScanCursor_ < playbackSnapshotHandles_.size() &&
               visited < kMaxTimelineSnapshotHandlesPerPass) {
            markIfTransformChanged(playbackSnapshotHandles_[timelineTransformScanCursor_++]);
            ++visited;
            if (TimelineBudgetExpired(passStart)) break;
        }

        if (timelineTransformScanCursor_ < playbackSnapshotHandles_.size()) {
            pendingTimelineTransformScan_ = true;
        } else {
            timelineTransformScanActive_ = false;
            timelineTransformScanCursor_ = 0;
        }

        if (changed) {
            QueueFastFlush();
            MarkInteractiveActivity();
        }
    }

    void MarkCameraDirty() {
        fastCameraDirty_ = true;
        QueueFastFlush();
    }

    void MarkCameraDirtyIfChanged(bool respectThrottle = true) {
        if (fastCameraDirty_ && fastFlushPosted_) return;
        const ULONGLONG now = MaxJSLivePollNowMs();
        if (respectThrottle &&
            lastCameraLivePollTick_ != 0 &&
            (now - lastCameraLivePollTick_) < kCameraLivePollIntervalMs) {
            return;
        }
        lastCameraLivePollTick_ = now;

        CameraData current = {};
        GetActiveCamera(current);
        if (!haveLastSentCamera_ || !CameraEquals(lastSentCamera_, current)) {
            fastCameraDirty_ = true;
            // Live scene cameras are transform-only hierarchy carriers. Mark
            // the one already driving this camera frame so children (notably a
            // parented light) inherit the same ordinary node transform. The
            // light itself stays off the 152-byte UpdateLight lane.
            if (!renderCameraOverrideActive_ && lockedCameraHandle_ != 0 &&
                helperHandles_.find(lockedCameraHandle_) != helperHandles_.end()) {
                fastDirtyHandles_.insert(lockedCameraHandle_);
            }
            QueueFastFlush();
        }
    }

    void RegisterCallbacks() {
        if (slowJsonSyncMode_) return;
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

        StartSyncPump();
        callbacksRegistered_ = true;
    }

    void UnregisterCallbacks() {
        if (!callbacksRegistered_) return;
        StopSyncPump();

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
        if (slowJsonSyncMode_) return false;
        if (!hwnd_ || !IsWindow(hwnd_)) return false;
        if (renderLocked_ || asCapturing_ || IsViewportHosted()) return true;
        return IsWindowVisible(hwnd_) && !IsIconic(hwnd_);
    }

    void RefreshCallbackRegistration(bool forceFullSyncOnResume = false) {
        if (slowJsonSyncMode_) {
            UnregisterCallbacks();
            StartSyncPump();
            return;
        }
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

    void SendLiveSyncSettings() {
        if (!webview_) return;
        const wchar_t* modeName =
            syncMode_ == SyncMode::SlowJson ? L"slow-json" :
            syncMode_ == SyncMode::Flow     ? L"flow" :
                                              L"live-fast";
        std::wostringstream ss;
        // `disabled` stays on the wire verbatim: it is the pre-FLOW contract
        // and a viewer that predates FLOW still reads it correctly.
        ss << L"{\"type\":\"live_sync_settings\",\"disabled\":"
           << (slowJsonSyncMode_ ? L"true" : L"false")
           << L",\"mode\":\"" << modeName << L"\"}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void SetSyncMode(SyncMode mode) {
        if (syncMode_ == mode) {
            SendLiveSyncSettings();
            return;
        }
        syncMode_ = mode;
        flowMode_ = (mode == SyncMode::Flow);
        lastFlowStatsTick_ = 0;
        // Leaving FLOW must restore the ungated sweeps immediately, and
        // entering it must classify against the current scene rather than a
        // stale epoch — both need the handle caches rebuilt.
        flowStaticAuditHandles_.clear();
        flowStaticAuditSignature_.clear();
        flowStaticAuditCursor_ = 0;
        RebuildTimelineHandleCaches();

        // LIVE ⇄ FLOW differ only in geometry batch selection — same
        // callbacks, same transport, same extraction. Tearing down callbacks
        // and forcing a full resync across that switch would be pure churn.
        const bool nowSlow = (mode == SyncMode::SlowJson);
        if (slowJsonSyncMode_ == nowSlow) {
            SendLiveSyncSettings();
            return;
        }

        SetSlowJsonSyncModeInternal(nowSlow);
    }

    void SetSlowJsonSyncMode(bool enabled) {
        SetSyncMode(enabled ? SyncMode::SlowJson : SyncMode::LiveFast);
    }

    void SetSlowJsonSyncModeInternal(bool enabled) {
        slowJsonSyncMode_ = enabled;
        lastSlowJsonSyncTick_ = 0;
        ResetFastPathState(true);
        idlePollFullSyncPending_ = false;
        idlePollAuditUntilTick_ = 0;
        ClearIdlePollFullSyncCandidates();
        ClearMaterialEditHandleCache();

        if (slowJsonSyncMode_) {
            dirty_ = false;
            dirtyStamp_ = 0;
            UnregisterCallbacks();
            StartSyncPump();
        } else {
            RefreshCallbackRegistration(true);
        }

        SendLiveSyncSettings();
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
        if (type == L"gpu_normals") {
            // Viewer announces whether it rebuilds deform normals in a WebGPU
            // compute pass. When live, the fast deform/sparse lane skips CPU
            // normal extraction entirely and streams positions only.
            bool enabled = false;
            ExtractJsonBool(msg, L"enabled", enabled);
            gpuNormalsLive_ = enabled;
            return;
        }
        if (type == L"client_log") {
            // Web-side forensics (WebGPU device loss, etc.) share the
            // process-failure log so one file tells the whole restart story.
            std::wstring kind, reason, message, backend, when;
            ExtractJsonString(msg, L"kind", kind);
            ExtractJsonString(msg, L"reason", reason);
            ExtractJsonString(msg, L"message", message);
            ExtractJsonString(msg, L"backend", backend);
            ExtractJsonString(msg, L"when", when);
            AppendWebViewFailureLog(L"client_log kind=" + kind + L" backend=" + backend
                + L" reason=" + reason + L" when=" + when + L" message=" + message);
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
        // Viewer-side Web Panels UI writes settings back onto the WebApp
        // Animator node. The param block stays the single source of truth:
        // no direct viewer-side mutation — DetectWebAppChanges hash-detects
        // the edit and round-trips a webapp_update on the next tick.
        if (type == L"webapp_set") {
            std::wstring handleStr;
            ExtractJsonString(msg, L"handle", handleStr);
            ULONG h = 0;
            if (!handleStr.empty()) {
                try { h = static_cast<ULONG>(std::stoul(handleStr)); } catch (...) { h = 0; }
            }
            Interface* ip = GetCOREInterface();
            INode* node = (ip && h != 0) ? ip->GetINodeByHandle(h) : nullptr;
            if (!node) return;
            ObjectState os = node->EvalWorldState(ip->GetTime());
            if (!os.obj || !IsThreeJSWebAppClassID(os.obj->ClassID())) return;
            IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_webapp_params);
            if (!pb) return;

            int presentation = -1;
            const bool hasPresentation =
                ExtractJsonInt(msg, L"presentation", presentation) &&
                presentation >= 0 && presentation <= 1;
            bool depthOcclude = false;
            const bool hasDepthOcclude = ExtractJsonBool(msg, L"depthOcclude", depthOcclude);
            if (!hasPresentation && !hasDepthOcclude) return;

            theHold.Begin();
            if (hasPresentation) pb->SetValue(pw_presentation, 0, presentation);
            if (hasDepthOcclude) pb->SetValue(pw_depth_occlude, 0, depthOcclude ? TRUE : FALSE);
            theHold.Accept(_T("Web Panel Setting"));
            return;
        }
        if (type == L"pathtracing_settings") {
            int samplesPerFrame = pathTracingSamplesPerFrame_;
            float giClamp = pathTracingGIClamp_;
            bool freezeSync = pathTracingFreezeSync_;
            bool viewerActive = false;
            ExtractJsonInt(msg, L"samplesPerFrame", samplesPerFrame);
            ExtractJsonFloat(msg, L"giClamp", giClamp);
            ExtractJsonBool(msg, L"freezeSync", freezeSync);
            ExtractJsonBool(msg, L"active", viewerActive);
            SetPathTracingRuntimeSettings(samplesPerFrame, giClamp, freezeSync, viewerActive);
            return;
        }
        if (type == L"live_sync_settings") {
            // Prefer the explicit mode; fall back to the boolean so a viewer
            // that only knows LIVE/SLOW still drives this correctly.
            std::wstring modeStr;
            if (ExtractJsonString(msg, L"mode", modeStr) && !modeStr.empty()) {
                SetSyncMode(modeStr == L"slow-json" ? SyncMode::SlowJson
                          : modeStr == L"flow"      ? SyncMode::Flow
                                                    : SyncMode::LiveFast);
                return;
            }
            bool disabled = false;
            ExtractJsonBool(msg, L"disabled", disabled);
            SetSlowJsonSyncMode(disabled);
            return;
        }
        if (type == L"gi_probe_refresh") {
            bool surface = true;
            bool lights = true;
            ExtractJsonBool(msg, L"surface", surface);
            ExtractJsonBool(msg, L"lights", lights);
            Interface* ip = GetCOREInterface();
            TimeValue t = ip ? ip->GetTime() : 0;
            if (surface) {
                nativeGiSurfaceDirty_ = true;
                SendNativeGiSurfacePacket(t);
            }
            if (lights) {
                SendNativeGiLightPacket(t);
            }
            return;
        }
        // Layer mount/remove or host-side sync repair — full resend without reloading WebView2
        if (type == L"scene_dirty" || type == L"relay_resync" ||
            msg.find(L"\"scene_dirty\"") != std::wstring::npos) {
            RequestFullSceneRepair();
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
        if (type == L"project_settings_write") {
            std::wstring requestId;
            std::wstring contentBase64;
            ExtractJsonString(msg, L"requestId", requestId);
            if (!ExtractJsonString(msg, L"contentBase64", contentBase64)) {
                SendHostActionResult(type, requestId, false, L"Missing contentBase64");
                return;
            }

            std::wstring error;
            const bool ok = WriteProjectSettingsContent(contentBase64, error);
            SendHostActionResult(type, requestId, ok, error);
            return;
        }
        if (type == L"bake_proxy_image_write") {
            std::wstring requestId;
            std::wstring folder;
            std::wstring filename;
            std::wstring rgbBase64;
            int width = 0;
            int height = 0;
            ExtractJsonString(msg, L"requestId", requestId);
            ExtractJsonString(msg, L"folder", folder);
            ExtractJsonString(msg, L"filename", filename);
            ExtractJsonString(msg, L"rgbBase64", rgbBase64);
            ExtractJsonInt(msg, L"width", width);
            ExtractJsonInt(msg, L"height", height);
            if (folder.empty() || filename.empty() || rgbBase64.empty()) {
                SendHostActionResult(type, requestId, false, L"Missing bake proxy image payload");
                return;
            }

            std::wstring error;
            const bool ok = WriteBakeProxyImage(folder, filename, width, height, rgbBase64, error);
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
            std::wstring localHdriBase64;
            std::wstring localHdriFileName;
            SnapshotExportOptions options;
            ExtractJsonString(msg, L"requestId", requestId);
            ExtractJsonString(msg, L"localHdriBase64", localHdriBase64);
            ExtractJsonString(msg, L"localHdriFileName", localHdriFileName);
            ExtractJsonBool(msg, L"includeSceneNodes", options.includeSceneNodes);
            ExtractJsonBool(msg, L"includeEnvironment", options.includeEnvironment);
            ExtractJsonBool(msg, L"includeLights", options.includeLights);
            ExtractJsonBool(msg, L"includeAudios", options.includeAudios);
            ExtractJsonBool(msg, L"includeGLTFs", options.includeGLTFs);
            ExtractJsonBool(msg, L"includeInstances", options.includeInstances);
            ExtractJsonBool(msg, L"includeUnusedChannels", options.includeUnusedChannels);
            ExtractJsonBool(msg, L"includeAllMorphTargets", options.includeAllMorphTargets);
            ExtractJsonBool(msg, L"includeDebugPayload", options.includeDebugPayload);
            ExtractJsonBool(msg, L"includeSnapshotUi", options.includeSnapshotUi);
            ExtractJsonBool(msg, L"includeRuntimeScene", options.includeRuntimeScene);
            ExtractJsonBool(msg, L"includeDisabledLayers", options.includeDisabledLayers);
            ExtractJsonBool(msg, L"copyAssets", options.copyAssets);
            ExtractJsonBool(msg, L"includeRapierVendor", options.includeRapierVendor);
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
            const bool ok = ExportSnapshotSite(
                snapshotUiJson,
                runtimeSceneJson,
                options,
                localHdriFileName,
                localHdriBase64,
                exportPath,
                error);
            if (ok) {
                lastSnapshotExportPath_ = exportPath;
            }
            SendHostActionResult(type, requestId, ok, error, exportPath);
            return;
        }
        if (type == L"snapshot_serve") {
            std::wstring requestId;
            std::wstring path;
            ExtractJsonString(msg, L"requestId", requestId);
            ExtractJsonString(msg, L"path", path);
            if (path.empty()) path = lastSnapshotExportPath_;

            std::wstring url;
            std::wstring error;
            const bool ok = ServeSnapshotSite(path, url, error);
            SendHostActionResult(type, requestId, ok, error, url);
            return;
        }
        if (type == L"snapshot_analyze") {
            std::wstring requestId;
            std::wstring path;
            ExtractJsonString(msg, L"requestId", requestId);
            ExtractJsonString(msg, L"path", path);
            if (path.empty()) path = lastSnapshotExportPath_;

            std::wstring snapshotJson;
            unsigned long long snapshotJsonBytes = 0;
            unsigned long long sceneBinBytes = 0;
            unsigned long long sceneAnimBytes = 0;
            std::wstring error;
            const bool ok = ReadSnapshotAnalysisPayload(
                path,
                snapshotJson,
                snapshotJsonBytes,
                sceneBinBytes,
                sceneAnimBytes,
                error);

            if (!webview_) return;
            std::wostringstream ss;
            ss << L"{\"type\":\"host_action_result\",\"action\":\"snapshot_analyze\"";
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
            if (ok) {
                ss << L",\"snapshotJsonBytes\":" << snapshotJsonBytes
                   << L",\"sceneBinBytes\":" << sceneBinBytes
                   << L",\"sceneAnimBytes\":" << sceneAnimBytes
                   << L",\"snapshotJson\":\"" << EscapeJson(snapshotJson.c_str()) << L"\"";
            }
            ss << L'}';
            webview_->PostWebMessageAsJson(ss.str().c_str());
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
        if (type == L"render_sequence_frame_file") {
            std::wstring jsError;
            std::wstring imageBase64;
            if (ExtractJsonString(msg, L"error", jsError) && !jsError.empty()) {
                renderSequenceLastError_ = jsError;
                FinishRenderSequence(false);
            } else if (renderSequenceComposited_) {
                // CSS3D web panels in the scene: the frame only exists in the
                // WebView composite. CapturePreview CANNOT run from inside
                // this WebMessageReceived handler (its completion dispatches
                // through the event queue this handler is blocking — pumping
                // here deadlocks). Defer to a clean WndProc stack.
                PostMessage(hwnd_, WM_RENDER_SEQUENCE_CAPTURE, 0, 0);
            } else if (!ExtractJsonString(msg, L"imageBase64", imageBase64) || imageBase64.empty()) {
                renderSequenceLastError_ = L"Missing browser render payload";
                FinishRenderSequence(false);
            } else {
                std::wstring error;
                if (!WriteRenderSequenceFrame(imageBase64, error)) {
                    renderSequenceLastError_ = error;
                    FinishRenderSequence(false);
                } else {
                    renderSequenceFrameInFlight_ = false;
                    renderSequenceCurrentFrame_ += renderSequenceStep_;
                    QueueRenderSequenceStep();
                }
            }
            return;
        }
        if (type == L"render_to_image_ready") {
            renderToImageBase64_.clear();
            ExtractJsonString(msg, L"imageBase64", renderToImageBase64_);
            if (renderImageEvent_) SetEvent(renderImageEvent_);
            return;
        }
        if (type == L"render_css3d_mask_ready") {
            renderCss3dMaskBase64_.clear();
            std::wstring jsError;
            if (ExtractJsonString(msg, L"error", jsError) && !jsError.empty()) {
                renderSequenceLastError_ = jsError;
            }
            ExtractJsonString(msg, L"imageBase64", renderCss3dMaskBase64_);
            if (renderCss3dMaskEvent_) SetEvent(renderCss3dMaskEvent_);
            return;
        }
        if (type == L"sync_lightmap_uvs" || type == L"sync_uv2") {
            RequestFullGeometryResync();
            return;
        }
        if (type == L"ready" || msg.find(L"\"ready\"") != std::wstring::npos) {
            jsReady_ = true; SetDirtyImmediate();
            pathTracingHasSceneSync_ = false;
            SetPathTracingSettings(g_pathTracingSamplesPerFrame, g_pathTracingGIClamp, g_pathTracingFreezeSync);
            PollViewportModes(true);
            mtlHashMap_.clear();
            mtlScalarHashMap_.clear();
            mtlFastScalarHashMap_.clear();
            ClearMaterialEditHandleCache();
            lightHashMap_.clear();
            propHashMap_.clear();
            geoHashMap_.clear();  // force all geometry to be sent
            geoFastTriangleCountMap_.clear();
            deformChannelHashMap_.clear();
            jsmodStateMap_.clear();
            inlineLayersStateSignature_.clear();  // re-scan inline layers on reconnect
            lastSentTransforms_.clear();
            lastSentPlaybackAux_.clear();
            lightHandles_.clear();
            audioHandles_.clear();
            gltfHandles_.clear();
            webappHandles_.clear();
            hairHandles_.clear();
            helperHandles_.clear();
            deformHandles_.clear();
            pointInstanceHandles_.clear();
            audioHashMap_.clear();
            gltfHashMap_.clear();
            webappHashMap_.clear();
            geoScanCursor_ = 0;
            ClearFastDeformState();
            lastSkinnedLivePollTick_ = 0;
            lastCameraLivePollTick_ = 0;
            lastRedrawLivePollTick_ = 0;
            haveLastTimerTime_ = false;
            lastTimerTime_ = 0;
            ResetFastPathState(false);
            SendProjectConfig();
            ScanInlineLayers();
            if (pendingSnapshotExportRequest_) RequestSnapshotExport();
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

        const ULONGLONG now = GetTickCount64();
        if (slowJsonSyncMode_) {
            if (dirty_) {
                const bool fullSyncRetryReady =
                    fullSyncRetryNotBeforeTick_ == 0 ||
                    now >= fullSyncRetryNotBeforeTick_;
                if (fullSyncRetryReady) {
                    dirty_ = false;
                    pathTracingHasSceneSync_ = SendFullSync();
                }
                return;
            }
            if (lastSlowJsonSyncTick_ == 0 ||
                (now - lastSlowJsonSyncTick_) >= SLOW_JSON_SYNC_INTERVAL_MS) {
                lastSlowJsonSyncTick_ = now;
                SendTransformSync(nullptr, false);
            }
            return;
        }

        const int envPhase = tickCount_ % ENV_POLL_TICKS;
        const int lightPhase = tickCount_ % LIGHT_DETECT_TICKS;
        const int slowPhase = tickCount_ % 15;

        const bool pathTracingFreezePolling =
            IsPathTracingNativeFreezeActive() && pathTracingHasSceneSync_;

        // Poll env at reduced cadence (~200ms)
        if (envPhase == 0) PollEnv();

        PumpDeferredIdlePollFullSync(now);

        const bool animPlaying = IsAnimationPlaying();
        if (!animPlaying && haveLastPlaybackPollTime_) {
            haveLastPlaybackPollTime_ = false;
            // Max can stop without changing the current tick, so the
            // TimeChange callback is not guaranteed to fire. Queue the same
            // latest-state mailbox before either dirty-state branch can clear
            // playback bookkeeping during a full sync.
            Interface* timelineIp = GetCOREInterface();
            if (timelineIp) {
                OnTimelineTimeChanged(timelineIp->GetTime());
                return;
            }
        }
        if (playbackFlushPending_) {
            QueuePostedTimelineSync();
            // A stopped full-scene sync is itself an authoritative final pose
            // and also provisions missing playback buffers. Let it supersede
            // this mailbox; otherwise an initial allocation failure could keep
            // both the mailbox and dirty full sync waiting on each other.
            if (!animPlaying && !dirty_) return;
        }

        if (fastFlushRetryNotBeforeTick_ != 0 &&
            now >= fastFlushRetryNotBeforeTick_) {
            QueueFastFlush();
        }

        if (!geoFastDirtyHandles_.empty() &&
            (geometryFastFlushNotBeforeTick_ == 0 ||
             now >= geometryFastFlushNotBeforeTick_)) {
            QueueFastFlush();
        }

        if (dirty_) {
            if (animPlaying) {
                PumpPlaybackSyncFromTimer();
                return;
            }

            const bool debounceReady =
                dirtyStamp_ == 0 || (now - dirtyStamp_) >= DIRTY_DEBOUNCE_MS;
            const bool fullSyncRetryReady =
                fullSyncRetryNotBeforeTick_ == 0 ||
                now >= fullSyncRetryNotBeforeTick_;
            const bool deferForInteraction = ShouldDeferFullSyncForInteraction(now);

            if (deferForInteraction) {
                PollInteractiveFastPathWhileFullSyncDeferred();
            }

            // Debounce: wait for notifications and interactive drags to settle before expensive full sync.
            if (debounceReady && fullSyncRetryReady && !deferForInteraction) {
                dirty_ = false;
                idlePollFullSyncPending_ = false;
                ClearIdlePollFullSyncCandidates();
                const bool fullSyncDelivered = useBinary_
                    ? SendFullSyncBinary()
                    : SendFullSync();
                pathTracingHasSceneSync_ = fullSyncDelivered;
            }
        } else {
            if (animPlaying) {
                PumpPlaybackSyncFromTimer();
            } else {
                MarkCameraDirtyIfChanged(false);
                PollSelectedTransformGizmoLive();
                if (ShouldPollSelectedGeometryLive()) CheckSelectedGeometryLive();
                PumpTimelineSyncFromTimer();
                // A due settle refresh is already an exact geometry eval. Do
                // not precede it with the idle sampled-position hash/eval.
                if (!QueuePendingDeformNormalRefresh()) {
                    CheckSkinnedGeometryLive();
                }
            }
            // Poll deforming meshes every tick regardless of interactive state.
            // Max's RedrawViewsCallback only fires on full scene redraws
            // (animation, param edits, etc.) — NOT during interactive bone
            // manipulation, which uses a gizmo-only fast path. Without this
            // timer-driven poll, manually dragging bones doesn't update the
            // viewer even though the Skin modifier IS re-evaluating in Max.
            // The 16ms throttle inside the function dedups when the redraw
            // callback also runs during animation.

            const bool favorInteractive = ShouldFavorInteractivePerformance();
            const bool allowIdlePolling = !favorInteractive && ShouldRunIdlePollAudit(now);
            const bool allowRealtimeAuxPolling = allowIdlePolling || animPlaying;
            const bool allowHeavyPolling = !pathTracingFreezePolling;
            const bool allowMaterialPolling = allowHeavyPolling && allowIdlePolling && !animPlaying;
            const bool allowHeavyGeometryPolling = allowHeavyPolling && !favorInteractive && !animPlaying;
            const bool allowTimelineAuxPolling = !animPlaying;

            // Source file polling must keep working even while favoring interactive redraw.
            // These are cheap timestamp checks, unlike the heavier scene/material scans below.
            if (slowPhase == 0) CheckWebContentChanges();
            if (slowPhase == 3) CheckProjectContentChanges();
            // Event-driven material edits: drained every tick, NOT gated on
            // the idle-poll audit window — watcher notifications are the
            // primary material path; the budgeted crawler below is a net.
            if (allowHeavyPolling) DrainPendingMaterialEdits();
            if (slowPhase == 7) RebuildMaterialEditWatcher();
            if (allowMaterialPolling && tickCount_ % MATERIAL_DETECT_TICKS == 2) DetectMaterialChanges();
            if (allowHeavyPolling && allowIdlePolling && lightPhase == 0) DetectPropertyChanges();
            if (allowTimelineAuxPolling && allowRealtimeAuxPolling && lightPhase == 1) {
                DetectLightChanges();
            }
            // Audio is cheap (few nodes, 7 params each) — poll every tick
            // and ignore the interactive gate so spinner drags propagate live.
            if (allowTimelineAuxPolling) {
                DetectAudioChanges();
                DetectGLTFChanges();
            }
            // WebApp animator params are driven by Max animation curves, so
            // unlike audio/glTF (UI-edit-only params) they must keep sampling
            // during playback. Cheap: few nodes, hash compare per tick.
            DetectWebAppChanges();
            if (allowHeavyGeometryPolling && slowPhase == 6) DetectGeometryChanges();
            if (allowIdlePolling && slowPhase == 9) DetectJsModChanges();
            if (allowRealtimeAuxPolling && lightPhase == 2) PollViewportModes();
            if (slowPhase == 1) ScanInlineLayers();
        }
    }

    void PollViewportModes(bool force = false) {
        if (!webview_) return;

        bool clay = IsClayModeActive();
        if (force || clay != lastClayMode_) {
            lastClayMode_ = clay;
            std::wstring msg = clay
                ? L"{\"type\":\"clay_mode\",\"enabled\":true}"
                : L"{\"type\":\"clay_mode\",\"enabled\":false}";
            webview_->PostWebMessageAsJson(msg.c_str());
        }

        SendRenderOutputSettings(force);
    }

    void SendRenderOutputSettings(bool force = false) {
        if (!webview_) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const int width = std::max(1, ip->GetRendWidth());
        const int height = std::max(1, ip->GetRendHeight());
        float aspect = ip->GetRendImageAspect();
        if (!std::isfinite(aspect) || aspect <= 0.0f) {
            aspect = static_cast<float>(width) / static_cast<float>(height);
        }
        if (!force &&
            width == lastRenderOutputWidth_ &&
            height == lastRenderOutputHeight_ &&
            std::fabs(aspect - lastRenderOutputAspect_) < 1.0e-4f) {
            return;
        }

        lastRenderOutputWidth_ = width;
        lastRenderOutputHeight_ = height;
        lastRenderOutputAspect_ = aspect;

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"render_output_settings\",\"width\":" << width
           << L",\"height\":" << height
           << L",\"aspect\":";
        WriteFloatValue(ss, aspect, static_cast<float>(width) / static_cast<float>(height));
        ss << L"}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    // Surgical geometry update — sends ONLY changed mesh data, no metadata for other nodes
    void SendGeometryFastUpdate(const std::unordered_set<ULONG>& handles,
                                const std::unordered_set<ULONG>* forceFullHandles = nullptr) {
        if (!webview_) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        const bool playbackActive = IsAnimationPlaying();

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        if (useBinary_ && env_) {
            webview_->QueryInterface(IID_PPV_ARGS(&wv17));
            env_->QueryInterface(IID_PPV_ARGS(&env12));
        }

        for (ULONG handle : handles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                EraseFastDeformState(handle);
                continue;
            }
            const bool omitFastChannels = ShouldOmitGeometryFastChannels(node, t);

            // Fast-deform path: positions are re-sent without
            // indices/UVs/material groups. Valid for meshes whose topology and
            // non-position channels are stable between full syncs.
            const bool isDeforming =
                skinnedHandles_.find(handle) != skinnedHandles_.end() ||
                deformHandles_.find(handle) != deformHandles_.end();
            if (playbackActive && isDeforming && !IsMaxJsSyncDrawVisible(node)) continue;
            const bool forceFullGeometry =
                forceFullHandles && forceFullHandles->find(handle) != forceFullHandles->end();
            const bool timelineFastLane = ShouldUseTimelineGeometryFastLane();
            const bool favorInteractivePerformance = ShouldFavorInteractivePerformance();
            const bool preferPositionOnlyDeformSync =
                isDeforming && !forceFullGeometry &&
                (timelineFastLane || favorInteractivePerformance);
            const ULONGLONG normalRefreshNow = GetTickCount64();
            const bool normalRefreshDue =
                deformNormalRefreshDueTick_ == 0 ||
                normalRefreshNow >= deformNormalRefreshDueTick_;
            const bool normalRefreshPending =
                deformNormalRefreshPendingHandles_.find(handle) !=
                deformNormalRefreshPendingHandles_.end();
            const bool forceLiveNormalRefresh =
                isDeforming && !gpuNormalsLive_ &&
                deformNormalRefreshQueuedHandle_ == handle &&
                normalRefreshDue &&
                !timelineFastLane && !favorInteractivePerformance;
            const bool deferPendingNormalRefresh =
                isDeforming && !forceFullGeometry &&
                normalRefreshPending && !forceLiveNormalRefresh;
            const bool hasVertexColors =
                !preferPositionOnlyDeformSync &&
                !deferPendingNormalRefresh &&
                isDeforming &&
                NodeHasExtractableVertexColors(node, t);

            // Sub-object sparse replay: while a vertex/edge/face drag is
            // active on a live Editable Poly, geometry changes are
            // position-only, the topology epoch holds, and the sparse state
            // can diff + patch just the moved region instead of re-extracting
            // the whole mesh every tick. (Unwrap / Edit Normals / paint edit
            // contexts never produce a fromLiveMN epoch on this path, so they
            // keep the full extract and their channel edits stream live.)
            auto guardIt = fastDeformGuardMap_.find(handle);
            const bool subobjectSparseEligible =
                !isDeforming && !forceFullGeometry &&
                node->Selected() &&
                IsSubObjectEditingActive() &&
                guardIt != fastDeformGuardMap_.end() &&
                guardIt->second.epoch.valid &&
                guardIt->second.epoch.fromLiveMN;
            const bool sparsePrimed =
                subobjectSparseEligible &&
                guardIt->second.plan.sparse &&
                guardIt->second.plan.sparse->valid;

            // Hash-dedupe before extracting. RailClone / Forest Pack / TyFlow
            // (and Max itself) fire spurious ControllerStructured events when
            // the viewport redraws, even if the generated mesh is byte-identical
            // to the last send. ExtractMesh + SharedBuffer allocation on every
            // tick is what makes camera movement chop; this short-circuits the
            // no-op case without losing real topology/UV edits. Above the
            // compact-channel threshold, UVs are intentionally ignored and
            // preserved on the JS side instead of being re-sent.
            //
            // Do NOT run this for active deform playback/manipulation: the
            // fast path above already decided the mesh is changing, and this
            // hash would EvalWorldState once before SendGeometryFastUpdate
            // evaluates again to extract positions. That duplicate eval was a
            // direct source of choppy Max playback.
            //
            // Skip it for a primed sparse edit session too — the position
            // diff inside the sparse path IS the change detector there, at a
            // fraction of the full-state hash cost.
            if (!preferPositionOnlyDeformSync &&
                !sparsePrimed &&
                !forceLiveNormalRefresh) {
                uint64_t preHash = 0;
                auto it = geoHashMap_.find(handle);
                if (it != geoHashMap_.end() &&
                    TryHashRenderableGeometryFastState(node, t, omitFastChannels, preHash) &&
                    preHash == it->second) {
                    continue;
                }
            }

            std::vector<float> verts, uvs, norms;
            std::vector<int> indices;
            std::vector<MatGroup> groups;
            bool isSpline = false;
            // Fast-deform path: positions are re-sent without indices/UVs or
            // material groups. During timeline/interactive work CPU normals
            // are deliberately omitted; one exact live-normal payload follows
            // after the interaction cooldown. Valid for meshes whose topology
            // and non-position channels are stable between full syncs — i.e.,
            // meshes where the current
            // frame's change is driven by a modifier's deformation, not by
            // a direct edit that could also change UVs or topology.
            //
            // Gated on "is deforming" (Skin or any modifier-stack mesh), not
            // just cache presence — static meshes with manual vertex edits
            // need the full ExtractMesh path so UV/topology changes are not
            // silently dropped.
            bool usedSkinnedFastPositions = false;
            // Set when the position gather wrote straight into the mapped
            // SharedBuffer slot. `verts` stays empty in that case, so the post
            // path below must take its count from fusedVertFloats.
            ComPtr<ICoreWebView2SharedBuffer> fusedBuf;
            BYTE* fusedPtr = nullptr;
            size_t fusedVertFloats = 0;
            const FastSparseState* sparsePayload = nullptr;
            // Never build/apply the CPU normal plan in the interactive
            // position-only lane. Oversized compact meshes may still stream
            // normals for the one forced settle refresh.
            const bool streamLiveNormals =
                !preferPositionOnlyDeformSync &&
                !deferPendingNormalRefresh &&
                !gpuNormalsLive_ &&
                (!omitFastChannels || forceLiveNormalRefresh);
            if (wv17 && env12 && !forceFullGeometry && guardIt != fastDeformGuardMap_.end()) {
                if (isDeforming &&
                    (!hasVertexColors ||
                     preferPositionOnlyDeformSync ||
                     deferPendingNormalRefresh ||
                     forceLiveNormalRefresh)) {
                    // FastNormalPlan remains lazy: interactive ticks gather only
                    // positions; the first exact normal gather happens after the
                    // settle cooldown instead of on Play/Scrub's critical path.
                    auto sourceIt = skinnedFastSourceCache_.find(handle);
                    if (sourceIt != skinnedFastSourceCache_.end()) {
                        // Fused lane: position-only replay is the playback hot
                        // path, its payload size is known before extraction
                        // (sources × 3 floats, no indices/UVs/normals), and it
                        // goes straight to the viewer untouched. Map the slot
                        // first and gather into it — that removes the vector
                        // fill plus the StreamCopyBytes over the same bytes,
                        // two full passes per mesh per frame on Max's thread.
                        //
                        // Any lane that still needs normals, or that inspects
                        // the positions afterwards, keeps the vector path.
                        if (!streamLiveNormals) {
                            const size_t fusedFloats = sourceIt->second.size() * 3;
                            ComPtr<ICoreWebView2SharedBuffer> candidateBuf;
                            BYTE* candidatePtr = nullptr;
                            if (fusedFloats > 0 &&
                                AcquireFastDeformSharedBuffer(
                                    handle, fusedFloats * 4, env12.Get(),
                                    candidateBuf, candidatePtr)) {
                                usedSkinnedFastPositions = ExtractSkinnedFastGeometry(
                                    node, t, sourceIt->second, guardIt->second,
                                    FastPositionSink::ToBuffer(
                                        reinterpret_cast<float*>(candidatePtr), fusedFloats),
                                    nullptr);
                                if (usedSkinnedFastPositions) {
                                    // A failed gather may have written part of
                                    // the slot; only a success publishes it.
                                    fusedBuf = candidateBuf;
                                    fusedPtr = candidatePtr;
                                    fusedVertFloats = fusedFloats;
                                }
                            }
                        }
                        if (!usedSkinnedFastPositions) {
                            usedSkinnedFastPositions = ExtractSkinnedFastGeometry(
                                node, t, sourceIt->second, guardIt->second,
                                verts, streamLiveNormals ? &norms : nullptr);
                        }
                        if (usedSkinnedFastPositions &&
                            forceLiveNormalRefresh &&
                            (norms.empty() || norms.size() != verts.size())) {
                            // A successful position gather is not a successful
                            // normal refresh. Fall through to exact extraction
                            // rather than silently rearming forever.
                            usedSkinnedFastPositions = false;
                            verts.clear();
                            norms.clear();
                            fusedBuf.Reset();
                            fusedPtr = nullptr;
                            fusedVertFloats = 0;
                        }
                    }
                    if (!usedSkinnedFastPositions && !forceLiveNormalRefresh) {
                        auto cacheIt = skinnedControlIdxCache_.find(handle);
                        if (cacheIt != skinnedControlIdxCache_.end()) {
                            usedSkinnedFastPositions = ExtractSkinnedFastPositions(
                                node, t, cacheIt->second, guardIt->second.epoch, verts);
                        }
                    }
                    if (!usedSkinnedFastPositions) {
                        // Topology epoch tripped (dynamic tessellation while
                        // dragging, modifier toggle, …). Drop the stale caches
                        // so this tick re-extracts full geometry with real
                        // indices and the viewer rebuilds, instead of stamping
                        // re-mapped positions onto old topology.
                        EraseFastDeformReplayState(handle);
                    }
                } else if (subobjectSparseEligible) {
                    auto sourceIt = skinnedFastSourceCache_.find(handle);
                    if (sourceIt != skinnedFastSourceCache_.end()) {
                        const int sparseResult = ExtractSubobjectSparseGeometry(
                            node, t, sourceIt->second, guardIt->second, streamLiveNormals);
                        if (sparseResult == 2) continue;  // positions identical — nothing to send
                        if (sparseResult == 1) {
                            usedSkinnedFastPositions = true;
                            sparsePayload = guardIt->second.plan.sparse.get();
                        } else {
                            // Epoch tripped mid-edit (Cut/Connect/tessellation
                            // changed topology) — same recovery as the deform
                            // path: full re-extract this tick.
                            EraseFastDeformReplayState(handle);
                        }
                    }
                }
            }

            std::vector<VertexColorAttributeRecord> vertexColors;
            std::vector<int> controlIdx;
            std::vector<FastVertexSource> fastSources;
            FastDeformTopoEpoch fastEpoch;
            FastNormalPlan extractedNormalPlan;
            std::vector<float>* extractNormals =
                (preferPositionOnlyDeformSync || deferPendingNormalRefresh ||
                 (omitFastChannels && !forceLiveNormalRefresh)) ? nullptr : &norms;
            if (!usedSkinnedFastPositions &&
                !ExtractMesh(
                    node, t, verts, uvs, indices, groups,
                    extractNormals, &controlIdx, &vertexColors, &fastSources,
                    nullptr, !omitFastChannels, &fastEpoch,
                    (isDeforming && extractNormals) ? &extractedNormalPlan : nullptr)) {
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
                if (!preferPositionOnlyDeformSync) {
                    uint64_t rawHash = 0;
                    if (!TryHashRenderableGeometryFastState(node, t, omitFastChannels, rawHash))
                        rawHash = HashMeshData(verts, indices, uvs, &vertexColors);
                    geoHashMap_[handle] = rawHash;
                    uint64_t channelHash = 0;
                    if (!omitFastChannels && TryHashRenderableGeometryChannels(node, t, channelHash))
                        deformChannelHashMap_[handle] = channelHash;
                    else
                        deformChannelHashMap_.erase(handle);
                }
                if (!isSpline && controlIdx.size() * 3 == verts.size() && fastEpoch.valid) {
                    skinnedControlIdxCache_[handle] = std::move(controlIdx);
                    const bool haveFastSources = fastSources.size() * 3 == verts.size();
                    if (haveFastSources)
                        skinnedFastSourceCache_[handle] = std::move(fastSources);
                    else
                        skinnedFastSourceCache_.erase(handle);
                    FastDeformGuard& guard = fastDeformGuardMap_[handle];
                    guard.epoch = fastEpoch;
                    // Exact full extraction prebuilds the matching plan while
                    // the evaluated mesh is already live. Interactive
                    // position-only extraction intentionally leaves it empty.
                    const bool haveBuiltFastNormalPlan =
                        haveFastSources && extractedNormalPlan.built;
                    guard.plan = haveBuiltFastNormalPlan
                        ? std::move(extractedNormalPlan)
                        : FastNormalPlan{};
                } else {
                    EraseFastDeformReplayState(handle);
                }
            }

            JsModData jmFast;
            GetJsModData(node, t, jmFast);

            const std::vector<float>& payloadVerts =
                sparsePayload ? sparsePayload->renderPos : verts;
            const std::vector<float>& payloadNormals =
                (sparsePayload && !sparsePayload->renderNorms.empty())
                    ? sparsePayload->renderNorms : norms;
            const bool requiresCpuNormalRefresh =
                isDeforming && !isSpline && !gpuNormalsLive_;
            // The fused gather leaves `verts` empty by design, so every size
            // question below has to go through this and never payloadVerts.
            const size_t payloadVertFloats =
                fusedVertFloats ? fusedVertFloats : payloadVerts.size();
            const bool liveNormalsExtracted =
                !payloadNormals.empty() &&
                payloadNormals.size() == payloadVertFloats;

            // Arm before shared-buffer allocation/post. A transport failure
            // must not strand geometry after lastLiveGeomHash_ has advanced.
            RecordDeformNormalPost(
                handle,
                requiresCpuNormalRefresh,
                liveNormalsExtracted,
                E_FAIL);

            if (wv17 && env12) {
                // Sparse sub-object replay streams from the persistent session
                // buffers; every other path streams the locally extracted data.
                const std::vector<float>& vertsBin = payloadVerts;
                const std::vector<float>& normsBin = payloadNormals;
                size_t totalBytes = payloadVertFloats * 4;
                if (usedSkinnedFastPositions) {
                    totalBytes += normsBin.size() * 4;
                } else {
                    totalBytes += indices.size() * 4 + uvs.size() * 4 + norms.size() * 4;
                    for (const VertexColorAttributeRecord& attr : vertexColors) {
                        totalBytes += attr.values.size() * sizeof(float);
                    }
                }
                if (totalBytes < 4) totalBytes = 4;

                ComPtr<ICoreWebView2SharedBuffer> buf;
                BYTE* ptr = nullptr;
                if (fusedVertFloats) {
                    // Already filled in place by the gather, and sized exactly
                    // for it — no allocation, no copy, nothing left to write.
                    buf = fusedBuf;
                    ptr = fusedPtr;
                } else if (usedSkinnedFastPositions) {
                    if (!AcquireFastDeformSharedBuffer(handle, totalBytes, env12.Get(), buf, ptr)) {
                        continue;
                    }
                } else if (FAILED(env12->CreateSharedBuffer(totalBytes, &buf)) || !buf) {
                    continue;
                }

                if (!ptr && buf) buf->get_Buffer(&ptr);
                if (!ptr) continue;
                size_t off = 0;
                size_t vOff = off;
                if (fusedVertFloats) {
                    off += fusedVertFloats * 4;
                } else {
                    StreamCopyBytes(ptr + off, vertsBin.data(), vertsBin.size() * 4);
                    off += vertsBin.size() * 4;
                }
                size_t iOff = 0;
                size_t uvOff = 0;
                size_t nOff = 0;
                if (usedSkinnedFastPositions) {
                    nOff = off;
                    if (!normsBin.empty()) { StreamCopyBytes(ptr + off, normsBin.data(), normsBin.size() * 4); off += normsBin.size() * 4; }
                } else {
                    StreamCopyBytes(ptr + off, indices.data(), indices.size() * 4); iOff = off; off += indices.size() * 4;
                    uvOff = off;
                    if (!uvs.empty()) { StreamCopyBytes(ptr + off, uvs.data(), uvs.size() * 4); off += uvs.size() * 4; }
                    nOff = off;
                    if (!norms.empty()) { StreamCopyBytes(ptr + off, norms.data(), norms.size() * 4); off += norms.size() * 4; }
                    for (VertexColorAttributeRecord& attr : vertexColors) {
                        attr.off = off;
                        if (!attr.values.empty()) {
                            StreamCopyBytes(ptr + off, attr.values.data(), attr.values.size() * sizeof(float));
                            off += attr.values.size() * sizeof(float);
                        }
                    }
                }

                std::wostringstream ss;
                ss.imbue(std::locale::classic());
                ss << L"{\"type\":\"geo_fast\",\"h\":" << handle;
                ss << L",\"jsmod\":" << (jmFast.found ? L"true" : L"false");
                if (omitFastChannels) ss << L",\"compactChannels\":true";
                if (isSpline) ss << L",\"spline\":true";
                ss << L",\"vOff\":" << vOff << L",\"vN\":" << payloadVertFloats;
                if (usedSkinnedFastPositions) {
                    if (!normsBin.empty()) ss << L",\"nOff\":" << nOff << L",\"nN\":" << normsBin.size();
                    ss << L",\"skipBounds\":true";
                } else {
                    ss << L",\"iOff\":" << iOff << L",\"iN\":" << indices.size();
                    if (!uvs.empty()) ss << L",\"uvOff\":" << uvOff << L",\"uvN\":" << uvs.size();
                    if (!norms.empty()) ss << L",\"nOff\":" << nOff << L",\"nN\":" << norms.size();
                    WriteVertexColorOffsetsJson(ss, vertexColors);
                    if (!isSpline) {
                        Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                        if (ShouldEmitMultiSubMaterialGroups(multiMtl, groups)) {
                            ss << L",\"groups\":[";
                            for (size_t g = 0; g < groups.size(); ++g) {
                                if (g) ss << L',';
                                ss << L'[' << groups[g].start << L',' << groups[g].count << L',' << g << L']';
                            }
                            ss << L"],\"mats\":[";
                            for (size_t g = 0; g < groups.size(); ++g) {
                                if (g) ss << L',';
                                Mtl* subMtl = GetSubMtlFromMatID(multiMtl, groups[g].matID);
                                MaxJSPBR subPBR;
                                ExtractPBRFromMtl(subMtl, node, t, subPBR);
                                WriteMaterialFull(ss, subPBR);
                            }
                            ss << L"]";
                        }
                    }
                }
                ss << L'}';

                const HRESULT postResult = wv17->PostSharedBufferToScript(buf.Get(),
                    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                    ss.str().c_str());
                RecordDeformNormalPost(
                    handle,
                    requiresCpuNormalRefresh,
                    liveNormalsExtracted,
                    postResult);
            } else {
                std::wostringstream ss;
                ss.imbue(std::locale::classic());
                ss << L"{\"type\":\"geo_fast\",\"h\":" << handle;
                ss << L",\"jsmod\":" << (jmFast.found ? L"true" : L"false");
                if (omitFastChannels) ss << L",\"compactChannels\":true";
                if (isSpline) ss << L",\"spline\":true";
                ss << L",\"v\":"; WriteFloats(ss, verts.data(), verts.size());
                ss << L",\"i\":"; WriteInts(ss, indices.data(), indices.size());
                if (!uvs.empty()) { ss << L",\"uv\":"; WriteFloats(ss, uvs.data(), uvs.size()); }
                if (!norms.empty()) { ss << L",\"norm\":"; WriteFloats(ss, norms.data(), norms.size()); }
                WriteVertexColorAttributesJson(ss, vertexColors);
                if (!usedSkinnedFastPositions && !isSpline) {
                    Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                    if (ShouldEmitMultiSubMaterialGroups(multiMtl, groups)) {
                        ss << L",\"groups\":[";
                        for (size_t g = 0; g < groups.size(); ++g) {
                            if (g) ss << L',';
                            ss << L'[' << groups[g].start << L',' << groups[g].count << L',' << g << L']';
                        }
                        ss << L"],\"mats\":[";
                        for (size_t g = 0; g < groups.size(); ++g) {
                            if (g) ss << L',';
                            Mtl* subMtl = GetSubMtlFromMatID(multiMtl, groups[g].matID);
                            MaxJSPBR subPBR;
                            ExtractPBRFromMtl(subMtl, node, t, subPBR);
                            WriteMaterialFull(ss, subPBR);
                        }
                        ss << L"]";
                    }
                }
                ss << L'}';
                const HRESULT postResult = webview_->PostWebMessageAsJson(ss.str().c_str());
                RecordDeformNormalPost(
                    handle,
                    requiresCpuNormalRefresh,
                    liveNormalsExtracted,
                    postResult);
            }
        }
    }

    bool SendHairFastUpdate(const std::vector<ULONG>& dirtyHandles) {
        if (!webview_) return false;
        Interface* ip = GetCOREInterface();
        if (!ip) return false;
        TimeValue t = ip->GetTime();

        std::vector<ULONG> hairDirty;
        for (ULONG h : dirtyHandles) {
            if (hairHandles_.find(h) != hairHandles_.end()) hairDirty.push_back(h);
        }
        if (hairDirty.empty()) return true;

        std::vector<HairInstanceGroup> groups;
        for (ULONG h : hairDirty) {
            INode* node = ip->GetINodeByHandle(h);
            if (!node) continue;
            ExtractHairInstances(node, t, groups);
        }
        if (groups.empty()) return true;

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
        const HRESULT postResult = webview_->PostWebMessageAsJson(ss.str().c_str());
        return SUCCEEDED(postResult);
    }

    void SendSelectionSync(const std::vector<ULONG>& handles) {
        if (!webview_ || handles.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const std::uint32_t frameId = AllocateFrameId();
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"xform\",\"frame\":" << frameId << L",\"nodes\":[";
        bool first = true;
        for (ULONG handle : handles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;
            if (!IsTrackedHandle(handle)) continue;
            if (!first) ss << L',';
            ss << L"{\"h\":" << handle
               << L",\"s\":" << (node->Selected() ? L'1' : L'0')
               << L"}";
            first = false;
        }
        ss << L"]}";
        if (!first) webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void TakeGeometryFastFlushBatch(std::unordered_set<ULONG>& batch,
                                    std::unordered_set<ULONG>& fullBatch) {
        batch.clear();
        fullBatch.clear();
        if (geoFastDirtyHandles_.empty()) {
            geoFullFastDirtyHandles_.clear();
            geometryFastFlushNotBeforeTick_ = 0;
            return;
        }

        const ULONGLONG now = GetTickCount64();
        if (geometryFastFlushNotBeforeTick_ != 0 &&
            now < geometryFastFlushNotBeforeTick_) {
            return;
        }

        auto takeHandle = [&](ULONG handle) {
            batch.insert(handle);
            geoFastDirtyHandles_.erase(handle);
            if (geoFullFastDirtyHandles_.erase(handle) != 0) {
                fullBatch.insert(handle);
            }
        };

        // The one exact settle-normal update wins the next bounded batch.
        // Then consume directly from the owning set: copying and sorting every
        // remaining dirty handle here recreated an O(scene) UI-thread hitch
        // before the eight-handle extraction cap could help.
        if (deformNormalRefreshQueuedHandle_ != 0 &&
            geoFastDirtyHandles_.find(deformNormalRefreshQueuedHandle_) !=
                geoFastDirtyHandles_.end()) {
            takeHandle(deformNormalRefreshQueuedHandle_);
        }
        while (batch.size() < kMaxGeometryFastFlushHandlesPerPass &&
               !geoFastDirtyHandles_.empty()) {
            takeHandle(*geoFastDirtyHandles_.begin());
        }

        if (geoFastDirtyHandles_.empty()) {
            // Any unmatched full marker is stale; geometry markers are the
            // owning queue and were all consumed above.
            geoFullFastDirtyHandles_.clear();
            geometryFastFlushNotBeforeTick_ = 0;
        } else {
            // Leave the remaining handles coalesced in the owning set. The
            // 33ms sync timer posts the next batch so chained window messages
            // cannot drain a large deform scene in one UI-thread burst.
            geometryFastFlushNotBeforeTick_ = now + SYNC_INTERVAL_MS;
        }
    }

    void FlushFastPath() {
        fastFlushPosted_ = false;

        const ULONGLONG flushNow = GetTickCount64();
        if (fastFlushRetryNotBeforeTick_ != 0 &&
            flushNow < fastFlushRetryNotBeforeTick_) {
            return;
        }
        fastFlushRetryNotBeforeTick_ = 0;

        if (!jsReady_ || !webview_) return;
        if (dirty_ && !CanFlushFastPathDuringPendingFullSync()) return;
        if (!hwnd_ || !IsWindowVisible(hwnd_)) return;

        ConsumePendingTimelineFastSyncWork();

        std::vector<ULONG> dirtyHandles;
        dirtyHandles.reserve(fastDirtyHandles_.size());
        for (ULONG handle : fastDirtyHandles_) dirtyHandles.push_back(handle);
        Interface* sortIp = GetCOREInterface();
        SortHandlesByHierarchyDepth(dirtyHandles, sortIp);
        std::vector<ULONG> deferredHandles;
        if (dirtyHandles.size() > kMaxFastFlushHandlesPerPass) {
            deferredHandles.assign(
                dirtyHandles.begin() + static_cast<std::ptrdiff_t>(kMaxFastFlushHandlesPerPass),
                dirtyHandles.end());
            dirtyHandles.resize(kMaxFastFlushHandlesPerPass);
            fastDirtyHandles_.clear();
            fastDirtyHandles_.insert(deferredHandles.begin(), deferredHandles.end());
        } else {
            fastDirtyHandles_.clear();
        }

        const bool hasDirtyCamera = fastCameraDirty_;
        const bool hasDirtyTime = fastTimeDirty_;

        // Collect geometry-dirty handles before clearing
        std::unordered_set<ULONG> geoDirty;
        std::unordered_set<ULONG> geoFullDirty;
        TakeGeometryFastFlushBatch(geoDirty, geoFullDirty);
        std::unordered_set<ULONG> materialDirty;
        materialDirty.swap(materialFastDirtyHandles_);
        for (ULONG handle : deferredHandles) {
            auto it = materialDirty.find(handle);
            if (it != materialDirty.end()) {
                materialFastDirtyHandles_.insert(handle);
                materialDirty.erase(it);
            }
        }
        std::unordered_set<ULONG> visibilityDirty;
        visibilityDirty.swap(visibilityDirtyHandles_);
        std::unordered_set<ULONG> selectionDirty;
        selectionDirty.swap(selectionDirtyHandles_);
        const bool selectionRescanDirty = selectionRescanDirty_;
        selectionRescanDirty_ = false;
        if (selectionRescanDirty) {
            selectionDirty.insert(geomHandles_.begin(), geomHandles_.end());
            selectionDirty.insert(helperHandles_.begin(), helperHandles_.end());
            selectionDirty.insert(lightHandles_.begin(), lightHandles_.end());
            selectionDirty.insert(audioHandles_.begin(), audioHandles_.end());
            selectionDirty.insert(gltfHandles_.begin(), gltfHandles_.end());
            selectionDirty.insert(hairHandles_.begin(), hairHandles_.end());
        }

        std::vector<ULONG> deduplicatedVisibilityOwners;
        deduplicatedVisibilityOwners.reserve(dirtyHandles.size());
        for (ULONG handle : dirtyHandles) {
            if (visibilityDirty.erase(handle) != 0) {
                deduplicatedVisibilityOwners.push_back(handle);
            }
        }
        fastCameraDirty_ = false;
        fastTimeDirty_ = false;

        auto restoreConsumedFastWork = [&]() {
            fastDirtyHandles_.insert(dirtyHandles.begin(), dirtyHandles.end());
            materialFastDirtyHandles_.insert(materialDirty.begin(), materialDirty.end());
            visibilityDirtyHandles_.insert(visibilityDirty.begin(), visibilityDirty.end());
            visibilityDirtyHandles_.insert(
                deduplicatedVisibilityOwners.begin(),
                deduplicatedVisibilityOwners.end());
            selectionDirtyHandles_.insert(selectionDirty.begin(), selectionDirty.end());
            selectionRescanDirty_ = selectionRescanDirty_ || selectionRescanDirty;
            fastCameraDirty_ = fastCameraDirty_ || hasDirtyCamera;
            fastTimeDirty_ = fastTimeDirty_ || hasDirtyTime;
            fastFlushRetryNotBeforeTick_ =
                GetTickCount64() + kTransportRetryBackoffMs;
        };

        auto queueRemainingFastWork = [&]() {
            if (!fastDirtyHandles_.empty() ||
                !materialFastDirtyHandles_.empty() ||
                !visibilityDirtyHandles_.empty() ||
                !selectionDirtyHandles_.empty() ||
                selectionRescanDirty_ || fastCameraDirty_ || fastTimeDirty_ ||
                pendingTimelineTransformScan_ || pendingTimelineDeformScan_ ||
                pendingTimelineCameraCheck_) {
                QueueFastFlush();
            }
        };

        std::vector<ULONG> combinedNodeHandles = dirtyHandles;
        combinedNodeHandles.reserve(dirtyHandles.size() + visibilityDirty.size());
        for (ULONG handle : visibilityDirty) combinedNodeHandles.push_back(handle);
        SortHandlesByHierarchyDepth(combinedNodeHandles, sortIp);

        // Geometry fast path: send changed mesh vertex data via binary geo_fast.
        // Then fall through to binary delta for transform/visibility/etc updates.
        if (!geoDirty.empty()) {
            SendGeometryFastUpdate(geoDirty, &geoFullDirty);
        }

        // Runs whether or not geometry was sent: a parked handle that starts
        // moving must be caught even in an otherwise idle scene.
        RunFlowStaticAudit();
        SendFlowStatsIfDue();

        const bool hasAnyNodeUpdates = !combinedNodeHandles.empty();
        const bool hasSelectionUpdates = !selectionDirty.empty();
        if (!hasAnyNodeUpdates && !hasSelectionUpdates && !hasDirtyCamera && !hasDirtyTime) {
            queueRemainingFastWork();
            return;
        }

        // Hair fast path: re-extract world-space hair instances for any dirty
        // hair handles. Covers transforms, deformation, frizz, dynamics — any
        // change that alters GetHairDefinition output.
        const bool hairTransportFailed = !SendHairFastUpdate(dirtyHandles);
        if (hairTransportFailed) {
            for (ULONG handle : dirtyHandles) {
                if (hairHandles_.find(handle) != hairHandles_.end()) {
                    fastDirtyHandles_.insert(handle);
                }
            }
            fastFlushRetryNotBeforeTick_ =
                GetTickCount64() + kTransportRetryBackoffMs;
        }

        if (!useBinary_) {
            if (hasAnyNodeUpdates) SendTransformSync(&combinedNodeHandles);
            if (hasSelectionUpdates) {
                std::vector<ULONG> selectionHandles(selectionDirty.begin(), selectionDirty.end());
                SendSelectionSync(selectionHandles);
            }
            if (!hasAnyNodeUpdates && !hasSelectionUpdates) SendCameraSync();
            CaptureCurrentCameraState();
            queueRemainingFastWork();
            return;
        }

        Interface* ip = GetCOREInterface();
        if (!ip) {
            restoreConsumedFastWork();
            return;
        }

        TimeValue t = ip->GetTime();
        const std::uint32_t frameId = AllocateFrameId();
        maxjs::sync::DeltaFrameBuilder frame(frameId);
        frame.ReserveBytes(32 + dirtyHandles.size() * 160 + visibilityDirty.size() * 12 +
            selectionDirty.size() * 12 + (hasDirtyCamera ? 64 : 0) + 16);
        frame.BeginFrame();

        std::vector<std::pair<ULONG, std::array<float, 16>>> stagedTransforms;
        std::vector<std::pair<ULONG, bool>> stagedVisibility;
        std::vector<std::pair<ULONG, bool>> stagedSelection;
        std::vector<std::pair<ULONG, std::uint64_t>> stagedLightStateHashes;
        stagedTransforms.reserve(dirtyHandles.size());
        stagedVisibility.reserve(combinedNodeHandles.size());
        stagedSelection.reserve(selectionDirty.size() + dirtyHandles.size());
        stagedLightStateHashes.reserve(std::min(dirtyHandles.size(), lightHandles_.size()));
        CameraData stagedCamera = {};
        bool hasStagedCamera = false;
        auto stageTransform = [&](ULONG handle, const float* xform) {
            std::array<float, 16> staged = {};
            std::copy(xform, xform + 16, staged.begin());
            stagedTransforms.emplace_back(handle, staged);
        };

        for (ULONG handle : dirtyHandles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                mtlScalarHashMap_.erase(handle);
                mtlFastScalarHashMap_.erase(handle);
                lightHashMap_.erase(handle);
                audioHashMap_.erase(handle);
                gltfHashMap_.erase(handle);
                webappHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                deformChannelHashMap_.erase(handle);
                EraseFastDeformState(handle);
                geomHandles_.erase(handle);
                lightHandles_.erase(handle);
                audioHandles_.erase(handle);
                gltfHandles_.erase(handle);
                webappHandles_.erase(handle);
                hairHandles_.erase(handle);
                helperHandles_.erase(handle);
                deformHandles_.erase(handle);
                pointInstanceHandles_.erase(handle);
                lastSentTransforms_.erase(handle);
                lastSentPlaybackAux_.erase(handle);
                materialFastDirtyHandles_.erase(handle);
                selectionDirtyHandles_.erase(handle);
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
            const bool visible = IsMaxJsSyncDrawVisible(node);

            // Use specialized commands for lights/audios
            if (lightHandles_.find(handle) != lightHandles_.end()) {
                maxjs::sync::DeltaFrameBuilder::LightData ld = {};
                ld.matrix16 = xform;
                ld.visible = visible;
                if (ExtractLightBinaryData(node, t, ld)) {
                    frame.UpdateLight(static_cast<std::uint32_t>(handle), ld);
                    stageTransform(handle, xform);
                    stagedVisibility.emplace_back(handle, visible);
                    stagedLightStateHashes.emplace_back(
                        handle, ComputeLightStateHash(node, t));
                } else {
                    SetDirty();
                }
                continue;
            }
            if (audioHandles_.find(handle) != audioHandles_.end()) {
                frame.UpdateAudio(static_cast<std::uint32_t>(handle), xform, visible);
                stageTransform(handle, xform);
                stagedVisibility.emplace_back(handle, visible);
                continue;
            }
            if (gltfHandles_.find(handle) != gltfHandles_.end()) {
                frame.UpdateGLTF(static_cast<std::uint32_t>(handle), xform, visible);
                stageTransform(handle, xform);
                stagedVisibility.emplace_back(handle, visible);
                continue;
            }
            if (webappHandles_.find(handle) != webappHandles_.end()) {
                frame.UpdateWebApp(static_cast<std::uint32_t>(handle), xform, visible);
                stageTransform(handle, xform);
                stagedVisibility.emplace_back(handle, visible);
                continue;
            }

            // Regular geometry node
            frame.UpdateTransform(static_cast<std::uint32_t>(handle), xform);
            const bool selected = node->Selected() != 0;
            frame.UpdateSelection(static_cast<std::uint32_t>(handle), selected);
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), visible);
            stageTransform(handle, xform);
            stagedSelection.emplace_back(handle, selected);
            stagedVisibility.emplace_back(handle, visible);

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
            const bool visible = IsMaxJsSyncDrawVisible(node);
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), visible);
            stagedVisibility.emplace_back(handle, visible);
        }

        for (ULONG handle : selectionDirty) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node || !IsTrackedHandle(handle)) continue;
            const bool selected = node->Selected() != 0;
            frame.UpdateSelection(static_cast<std::uint32_t>(handle), selected);
            stagedSelection.emplace_back(handle, selected);
        }

        if (hasDirtyCamera) {
            GetActiveCamera(stagedCamera);
            frame.UpdateCamera(stagedCamera.pos, stagedCamera.target, stagedCamera.up,
                               stagedCamera.fov, stagedCamera.perspective, stagedCamera.viewWidth,
                               stagedCamera.dofEnabled, stagedCamera.dofFocusDistance,
                               stagedCamera.dofFocalLength, stagedCamera.dofBokehScale);
            hasStagedCamera = true;
        }

        // Time oracle — JS timeline / ctx.maxTime reads this.
        {
            const std::int32_t tpf = GetTicksPerFrame();
            const std::uint8_t stateFlags = IsAnimationPlaying() ? 0x01 : 0x00;
            frame.UpdateTime(static_cast<std::int32_t>(t), tpf, stateFlags);
        }
        frame.EndFrame();
        if (frame.command_count() == 0) {
            restoreConsumedFastWork();
            return;
        }

        if (!PostSharedDeltaBytes(
                frame.bytes(), frameId, frame.command_count())) {
            // The dirty sets remain the ownership record until WebView accepts
            // the binary frame. No JSON fallback is allowed to make one failed
            // transport look delivered, and the timer enforces retry backoff.
            restoreConsumedFastWork();
            return;
        }

        // Delivery is the only cache-commit point. Failed CreateSharedBuffer,
        // get_Buffer, and PostSharedBuffer calls leave all of these untouched.
        for (const auto& [handle, transform] : stagedTransforms) {
            lastSentTransforms_[handle] = transform;
        }
        for (const auto& [handle, visible] : stagedVisibility) {
            lastSentPlaybackAux_[handle].visible = visible;
        }
        for (const auto& [handle, selected] : stagedSelection) {
            PlaybackAuxDeliveryState& state = lastSentPlaybackAux_[handle];
            state.selected = selected;
            state.hasSelection = true;
        }
        for (const auto& [handle, stateHash] : stagedLightStateHashes) {
            PlaybackAuxDeliveryState& state = lastSentPlaybackAux_[handle];
            state.lightStateHash = stateHash;
            state.hasLightStateHash = true;
        }
        if (hasStagedCamera) {
            lastSentCamera_ = stagedCamera;
            haveLastSentCamera_ = true;
        }
        if (!hairTransportFailed) fastFlushRetryNotBeforeTick_ = 0;
        queueRemainingFastWork();
    }

    EnvData cachedEnv_;
    std::wstring cachedEnvJson_;   // pre-built JSON fragment
    std::wstring cachedHdriPath_;  // last HDRI path we mapped
    std::wstring cachedHdriUrl_;   // cached MapTexturePath result
    static constexpr int ENV_POLL_TICKS = 6;  // ~200ms at 33ms tick

    std::wstring lastEnvSig_;   // change-detection signature

    // Poll env at reduced cadence; send standalone message ONLY when changed
    void PollEnv() {
        if (!webview_) return;

        EnvData env;
        GetEnvironment(env);

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

        // Build env JSON
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"env_update\",";
        WriteEnvJson(ss, env, hdriUrl);
        ss << L'}';
        std::wstring json = ss.str();

        // Only send if something changed
        if (json == lastEnvSig_) return;
        lastEnvSig_ = json;
        cachedEnv_ = env;

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

    // HALO-GI Probe Grid out-of-band sync: a tiny JSON side-channel carrying each
    // probe grid's box size + manual divisions + enabled flag, keyed by node handle.
    // The grid's TRANSFORM rides the normal helper-node sync (both JSON and binary
    // paths); the viewer fits the GI volume from (synced transform x this size).
    // Called from EVERY scene-send path (full JSON, full binary, transform, delta) so
    // fast-sync never misses it. Change-gated by the serialized payload.
    std::wstring lastProbeGridSig_;
    void SendProbeGridSync() {
        if (!webview_) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        const TimeValue t = ip->GetTime();
        std::wostringstream grids;
        grids.imbue(std::locale::classic());
        int count = 0;
        std::vector<INode*> stack;
        INode* root = ip->GetRootNode();
        if (root) for (int i = 0; i < root->NumberOfChildren(); i++) stack.push_back(root->GetChildNode(i));
        while (!stack.empty()) {
            INode* node = stack.back(); stack.pop_back();
            if (!node) continue;
            for (int i = 0; i < node->NumberOfChildren(); i++) stack.push_back(node->GetChildNode(i));
            ObjectState os = node->EvalWorldState(t);
            if (!os.obj || !IsThreeJSProbeGridClassID(os.obj->ClassID())) continue;
            float dims[3] = { 100.0f, 100.0f, 100.0f }; int div[3] = { 12, 6, 12 }; bool en = true;
            GetThreeJSProbeGridInfo(os.obj, dims, div, en);
            if (count++) grids << L',';
            grids << L"{\"h\":" << node->GetHandle()
                  << L",\"enabled\":" << (en ? 1 : 0)
                  << L",\"size\":[" << dims[0] << L',' << dims[1] << L',' << dims[2] << L"]"
                  << L",\"div\":[" << div[0] << L',' << div[1] << L',' << div[2] << L"]}";
        }
        const std::wstring payload = grids.str();
        if (payload == lastProbeGridSig_) return; // unchanged -> don't resend
        lastProbeGridSig_ = payload;
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"probeGrids\",\"grids\":[" << payload << L"]}";
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
        frame.ReserveBytes(32 + (geomHandles_.size() + helperHandles_.size()) * (includeMaterialScalars ? 120 : 96) + 64);
        frame.BeginFrame();

        auto appendHandle = [&](ULONG handle, bool isHelper) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                mtlScalarHashMap_.erase(handle);
                mtlFastScalarHashMap_.erase(handle);
                lightHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                deformChannelHashMap_.erase(handle);
                EraseFastDeformState(handle);
                lastSentTransforms_.erase(handle);
                if (isHelper) helperHandles_.erase(handle);
                else geomHandles_.erase(handle);
                return;
            }

            float xform[16];
            GetTransform16(node, t, xform);
            frame.UpdateTransform(static_cast<std::uint32_t>(handle), xform);
            frame.UpdateSelection(static_cast<std::uint32_t>(handle), node->Selected() != 0);
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), IsMaxJsSyncDrawVisible(node));

            if (!isHelper && includeMaterialScalars) {
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
        };

        {
            std::vector<ULONG> handles(helperHandles_.begin(), helperHandles_.end());
            SortHandlesByHierarchyDepth(handles, ip);
            for (ULONG handle : handles) appendHandle(handle, true);
        }
        {
            std::vector<ULONG> handles(geomHandles_.begin(), geomHandles_.end());
            SortHandlesByHierarchyDepth(handles, ip);
            for (ULONG handle : handles) appendHandle(handle, false);
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
        SendProbeGridSync();
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
            ss << L"{\"multi\":true,\"count\":" << multiMtl->NumSubMtls();
            // ID-column mapping must be part of the hash: remapping face IDs to
            // different slots changes what GetSubMtlFromMatID emits on the next
            // full sync without any sub-material (slot order) change.
            ss << L",\"ids\":";
            WriteMultiSubMaterialIdListJson(multiMtl, ss);
            ss << L",\"mats\":[";
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
        uint64_t fastScalarHash = 0;
        bool canFastSync = false;
    };

    MaterialSyncState ComputeMaterialSyncStateFromPBR(const MaxJSPBR& pbr) {
        MaterialSyncState state;
        state.fastScalarHash = HashMaterialScalarPreviewValues(
            pbr.color, pbr.roughness, pbr.metalness, pbr.opacity);

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
                   has(p.specularIntensityMapTransform) || has(p.specularColorMapTransform) ||
                   has(p.sheenColorMapTransform) || has(p.sheenRoughnessMapTransform);
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
            clear(stable.sheenColorMapTransform); clear(stable.sheenRoughnessMapTransform);
            state.structureHash = HashMaterialPBRState(stable);
            state.canFastSync = false;
            return state;
        }

        // Any serialized texture slot makes scalar-only deltas unsafe: a color
        // tweak must resend the full material payload so sibling maps such as
        // OpenPBR opacity stay attached in the viewer.
        bool hasTextureSlot = false;
        for (const maxjs::MaterialSlot& slot : maxjs::kMaterialSlots) {
            if (!(pbr.*(slot.path)).empty()) {
                hasTextureSlot = true;
                break;
            }
        }
        if (hasTextureSlot) {
            state.structureHash = HashMaterialPBRState(pbr);
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
        MaxJSPBR slowScalarPbr = pbr;
        slowScalarPbr.color[0] = 0.8f;
        slowScalarPbr.color[1] = 0.8f;
        slowScalarPbr.color[2] = 0.8f;
        slowScalarPbr.roughness = 0.5f;
        slowScalarPbr.metalness = 0.0f;
        slowScalarPbr.opacity = 1.0f;
        // Non-fast scalar hash: physical scalars still require full sync because
        // delta_bin only carries color/roughness/metalness/opacity.
        state.scalarHash = HashMaterialPBRState(slowScalarPbr);
        state.canFastSync = true;
        return state;
    }

    // Cheap state for nodes without a material: the viewer renders them from
    // wire color, so that is the only live-editable input worth tracking.
    // Wire color rides the fast-scalar hash so drags keep using the delta
    // path (as they did via the full extraction); structure/scalar stay
    // constant so assigning a material later flips structureHash → full sync.
    MaterialSyncState ComputeNullMaterialSyncState(INode* node) {
        MaterialSyncState state;
        const uint64_t base = HashFNV1a("maxjs-null-mtl", 14);
        DWORD wire = node ? node->GetWireColor() : 0;
        state.structureHash = base;
        state.scalarHash = base;
        state.fastScalarHash = HashFNV1a(&wire, sizeof(wire), base);
        state.canFastSync = true;
        return state;
    }

    MaterialSyncState ComputeMaterialSyncState(INode* node, TimeValue t) {
        MaterialSyncState state;
        if (!node) return state;

        Mtl* rawMtl = node->GetMtl();
        if (!rawMtl) {
            return ComputeNullMaterialSyncState(node);
        }
        Mtl* multiMtl = FindMultiSubMtl(rawMtl);
        if (multiMtl && multiMtl->NumSubMtls() > 1) {
            state.structureHash = ComputeMaterialStateHash(node, t);
            state.canFastSync = false;
            return state;
        }

        MaxJSPBR pbr;
        ExtractPBR(node, t, pbr);
        return ComputeMaterialSyncStateFromPBR(pbr);
    }

    MaterialSyncState ComputeMaterialSyncStateCached(
        INode* node,
        TimeValue t,
        std::unordered_map<Mtl*, MaterialSyncState>& materialStateCache) {
        if (!node) return MaterialSyncState{};

        Mtl* rawMtl = node->GetMtl();
        // Material-less nodes (ungrouped archviz members, helpers-with-mesh)
        // used to pay a full ExtractPBR + serialize + hash per crawl visit
        // just to describe "wire color". Hash the wire color directly so they
        // cost ~nothing; null->assigned transitions still flip the hash.
        if (!rawMtl) {
            return ComputeNullMaterialSyncState(node);
        }
        Mtl* multiMtl = FindMultiSubMtl(rawMtl);
        if (multiMtl && multiMtl->NumSubMtls() > 1) {
            return ComputeMaterialSyncState(node, t);
        }

        Mtl* supportedMtl = FindSupportedMaterial(rawMtl);
        if (!supportedMtl) {
            return ComputeMaterialSyncState(node, t);
        }

        auto cached = materialStateCache.find(supportedMtl);
        if (cached != materialStateCache.end()) return cached->second;

        MaxJSPBR pbr;
        ExtractPBRFromMtl(supportedMtl, nullptr, t, pbr);
        MaterialSyncState state = ComputeMaterialSyncStateFromPBR(pbr);
        materialStateCache[supportedMtl] = state;
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

        ss << L",\"volContrib\":" << (HasParam(pb, pl_vol_contrib) ? pb->GetFloat(pl_vol_contrib, t) : 1.0f);
        ss << L'}';

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
        std::wstring mappedPath = rawPath ? MapAudioPath(rawPath) : std::wstring{};

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

    uint64_t ComputeWebAppStateHash(INode* node, TimeValue t) {
        if (!node) return 0;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSWebAppClassID(os.obj->ClassID())) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_webapp_params);
        if (!pb) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        const MCHAR* rawUrl = pb->GetStr(pw_url);

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        ss << L",\"url\":\"" << EscapeJson(rawUrl ? rawUrl : L"") << L"\"";
        ss << L",\"width\":" << pb->GetInt(pw_width);
        ss << L",\"height\":" << pb->GetInt(pw_height);
        ss << L",\"displaySize\":" << pb->GetFloat(pw_display_size, t);
        ss << L",\"opacity\":" << pb->GetFloat(pw_opacity, t);
        ss << L",\"interactive\":" << (pb->GetInt(pw_interactive) ? L'1' : L'0');
        ss << L",\"presentation\":" << pb->GetInt(pw_presentation);
        ss << L",\"depthOcclude\":" << (pb->GetInt(pw_depth_occlude) ? L'1' : L'0');
        ss << L",\"layerCount\":" << pb->GetInt(pw_layer_count);
        ss << L",\"layerGap\":" << pb->GetFloat(pw_layer_gap, t);
        static const ParamID valueIds[kWebAppParamChannels] = {
            pw_param1, pw_param2, pw_param3, pw_param4,
            pw_param5, pw_param6, pw_param7, pw_param8,
            pw_param9, pw_param10, pw_param11, pw_param12,
            pw_param13, pw_param14, pw_param15, pw_param16,
            pw_param17, pw_param18, pw_param19, pw_param20,
            pw_param21, pw_param22, pw_param23, pw_param24,
            pw_param25, pw_param26, pw_param27, pw_param28,
            pw_param29, pw_param30, pw_param31, pw_param32,
        };
        static const ParamID nameIds[kWebAppParamChannels] = {
            pw_param1_name, pw_param2_name, pw_param3_name, pw_param4_name,
            pw_param5_name, pw_param6_name, pw_param7_name, pw_param8_name,
            pw_param9_name, pw_param10_name, pw_param11_name, pw_param12_name,
            pw_param13_name, pw_param14_name, pw_param15_name, pw_param16_name,
            pw_param17_name, pw_param18_name, pw_param19_name, pw_param20_name,
            pw_param21_name, pw_param22_name, pw_param23_name, pw_param24_name,
            pw_param25_name, pw_param26_name, pw_param27_name, pw_param28_name,
            pw_param29_name, pw_param30_name, pw_param31_name, pw_param32_name,
        };
        for (int i = 0; i < kWebAppParamChannels; ++i) {
            const MCHAR* name = pb->GetStr(nameIds[i]);
            ss << L",\"" << EscapeJson(name ? name : L"") << L"\":" << pb->GetFloat(valueIds[i], t);
        }
        ss << L"}";
        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    // Material graph/physical edits use full sync. Preview-safe scalar edits
    // stay on delta_bin so interactive material work does not rebuild the scene.
    void DetectMaterialChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        SuppressMaterialEditCaptureScope suppressEcho(*this);
        TimeValue t = ip->GetTime();
        bool changed = false;
        bool requestedFullSync = false;
        std::unordered_map<Mtl*, MaterialSyncState> materialStateCache;
        std::vector<ULONG> handles;
        handles.reserve(geomHandles_.size());
        for (ULONG handle : geomHandles_) handles.push_back(handle);

        VisitBudgetedHandles(handles, materialScanCursor_, kMaxIdleMaterialHandlesPerTick, [&](ULONG handle) {
            if (requestedFullSync) return;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                mtlScalarHashMap_.erase(handle);
                mtlFastScalarHashMap_.erase(handle);
                materialFastDirtyHandles_.erase(handle);
                idleMaterialFullSyncCandidateHash_.erase(handle);
                return;
            }

            const MaterialSyncState state = ComputeMaterialSyncStateCached(node, t, materialStateCache);

            auto structureIt = mtlHashMap_.find(handle);
            auto scalarIt = mtlScalarHashMap_.find(handle);
            auto fastScalarIt = mtlFastScalarHashMap_.find(handle);
            if (structureIt == mtlHashMap_.end() ||
                scalarIt == mtlScalarHashMap_.end() ||
                fastScalarIt == mtlFastScalarHashMap_.end()) {
                mtlHashMap_[handle] = state.structureHash;
                mtlScalarHashMap_[handle] = state.scalarHash;
                mtlFastScalarHashMap_[handle] = state.fastScalarHash;
                return;
            }

            const bool structureChanged = structureIt->second != state.structureHash;
            const bool scalarChanged = scalarIt->second != state.scalarHash;
            const bool fastScalarChanged = fastScalarIt->second != state.fastScalarHash;
            if (!structureChanged && !scalarChanged && !fastScalarChanged) {
                idleMaterialFullSyncCandidateHash_.erase(handle);
                return;
            }

            if (structureChanged || scalarChanged || !state.canFastSync) {
                uint64_t candidateHash = HashFNV1a(&state.structureHash, sizeof(state.structureHash));
                candidateHash = HashFNV1a(&state.scalarHash, sizeof(state.scalarHash), candidateHash);
                candidateHash = HashFNV1a(&state.fastScalarHash, sizeof(state.fastScalarHash), candidateHash);
                const uint8_t canFastSync = state.canFastSync ? 1 : 0;
                candidateHash = HashFNV1a(&canFastSync, sizeof(canFastSync), candidateHash);
                if (!ConfirmIdleFullSyncCandidate(idleMaterialFullSyncCandidateHash_, handle, candidateHash)) {
                    return;
                }
                structureIt->second = state.structureHash;
                scalarIt->second = state.scalarHash;
                fastScalarIt->second = state.fastScalarHash;
                // Material structure changed — invalidate geometry hash + group cache
                // so next full sync re-extracts face matIDs for multi-sub materials
                if (structureChanged) {
                    geoHashMap_.erase(handle);
                    groupCache_.erase(handle);
                    lastBBoxHash_.erase(handle);
                }
                materialFastDirtyHandles_.clear();
                requestedFullSync = true;
                RequestIdlePollFullSync();
                return;
            }

            structureIt->second = state.structureHash;
            scalarIt->second = state.scalarHash;
            fastScalarIt->second = state.fastScalarHash;
            idleMaterialFullSyncCandidateHash_.erase(handle);
            materialFastDirtyHandles_.insert(handle);
            fastDirtyHandles_.insert(handle);
            changed = true;
        });

        // A pending candidate means a change was seen but not yet confirmed
        // by its second visit. Keep the audit window alive until it resolves:
        // expiry wipes the candidate map, which on large scenes (one cursor
        // rotation > window) silently dropped edits until viewer restart.
        if (!idleMaterialFullSyncCandidateHash_.empty()) ArmIdlePollAuditWindow();

        if (changed) QueueFastFlush();
    }

    void DetectLightChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip || lightHandles_.empty()) return;

        TimeValue t = ip->GetTime();
        bool changed = false;
        std::vector<ULONG> handles;
        handles.reserve(lightHandles_.size());
        for (ULONG handle : lightHandles_) handles.push_back(handle);

        VisitBudgetedHandles(handles, lightScanCursor_, kMaxIdleLightHandlesPerTick, [&](ULONG handle) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                lightHashMap_.erase(handle);
                return;
            }

            const uint64_t hash = ComputeLightStateHash(node, t);
            auto it = lightHashMap_.find(handle);
            if (it == lightHashMap_.end()) {
                lightHashMap_[handle] = hash;
            } else if (it->second != hash) {
                it->second = hash;
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        });

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

    void DetectWebAppChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip || webappHandles_.empty()) return;

        TimeValue t = ip->GetTime();
        std::vector<INode*> dirty;
        dirty.reserve(webappHandles_.size());

        for (ULONG handle : webappHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            const uint64_t hash = ComputeWebAppStateHash(node, t);
            auto it = webappHashMap_.find(handle);
            if (it == webappHashMap_.end()) {
                webappHashMap_[handle] = hash;
                dirty.push_back(node);  // first observation — push so JS has initial state
            } else if (it->second != hash) {
                it->second = hash;
                dirty.push_back(node);
            }
        }

        if (dirty.empty() || !webview_) return;

        // Param values ride a dedicated JSON message; the binary UpdateWebApp
        // delta command only carries transform/visibility. Curve-animated
        // params change every playback frame, but the payload is tiny.
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"webapp_update\",\"webapps\":[";
        bool first = true;
        for (INode* node : dirty) {
            std::wostringstream webappJson;
            webappJson.imbue(std::locale::classic());
            if (WriteWebAppJson(webappJson, node, t, /*includeHandle*/ true, /*includeVisibility*/ true, /*trackHandle*/ false)) {
                if (!first) ss << L',';
                ss << webappJson.str();
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
                    deformHandles_.count(handle) ||
                    // Point-instance stacks are event-driven only: hashing them
                    // here regenerates the instanced mesh every audit pass.
                    pointInstanceHandles_.count(handle);
                if (!handledByLivePoll) {
                    const bool omitFastChannels = ShouldOmitGeometryFastChannels(node, t);
                    uint64_t hash = 0;
                    if (TryHashRenderableGeometryFastState(node, t, omitFastChannels, hash)) {
                        auto it = geoHashMap_.find(handle);
                        if (it == geoHashMap_.end() || it->second != hash) {
                            if (omitFastChannels) {
                                geoHashMap_.erase(handle);
                                geoFastDirtyHandles_.insert(handle);
                                fastDirtyHandles_.insert(handle);
                                QueueFastFlush();
                                return;
                            } else {
                                geoFastDirtyHandles_.insert(handle);
                                geoFullFastDirtyHandles_.insert(handle);
                                fastDirtyHandles_.insert(handle);
                                QueueFastFlush();
                                return;
                            }
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
        bool requestedFullSync = false;
        std::vector<ULONG> handles;
        handles.reserve(geomHandles_.size());
        for (ULONG handle : geomHandles_) handles.push_back(handle);
        VisitBudgetedHandles(handles, jsmodScanCursor_, kMaxIdleJsModHandlesPerTick, [&](ULONG handle) {
            if (requestedFullSync) return;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                idleJsModFullSyncCandidateHash_.erase(handle);
                return;
            }
            JsModData jm;
            GetJsModData(node, t, jm);
            const bool found = jm.found;
            auto it = jsmodStateMap_.find(handle);
            if (it == jsmodStateMap_.end()) {
                jsmodStateMap_[handle] = found;
                idleJsModFullSyncCandidateHash_.erase(handle);
                return;
            }
            if (it->second != found) {
                const uint64_t candidateHash = found ? 1ULL : 0ULL;
                if (!ConfirmIdleFullSyncCandidate(idleJsModFullSyncCandidateHash_, handle, candidateHash)) {
                    return;
                }
                it->second = found;
                geoHashMap_.erase(handle);
                deformChannelHashMap_.erase(handle);
                lastLiveGeomHash_.erase(handle);
                requestedFullSync = true;
                RequestIdlePollFullSync();
                return;
            } else {
                idleJsModFullSyncCandidateHash_.erase(handle);
            }
        });
    }

    // Plugin-instance producers (Forest Pack / RailClone / tyFlow / native
    // RenderTimeInstancing, incl. 2027.2 Point Instance stacks) are NOT
    // change-detected. Deliberate: hashing them means evaluating them, and a
    // Point Instance stack regenerates its instanced mesh on every evaluation
    // ("generating mesh from point instances" prompt spam). All instance
    // kinds extract on full syncs only — the max.js menu's "Refresh Point
    // Instances" action (RequestFullSceneRepair) is the manual pull.

    // Detect object property changes — triggers full sync (same pattern as DetectMaterialChanges)
    void DetectPropertyChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        bool requestedFullSync = false;
        std::vector<ULONG> handles;
        handles.reserve(geomHandles_.size());
        for (ULONG handle : geomHandles_) handles.push_back(handle);

        VisitBudgetedHandles(handles, propertyScanCursor_, kMaxIdlePropertyHandlesPerTick, [&](ULONG handle) {
            if (requestedFullSync) return;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                idlePropertyFullSyncCandidateHash_.erase(handle);
                return;
            }

            uint64_t h = ComputeNodePropHash(node, t);
            auto it = propHashMap_.find(handle);
            if (it == propHashMap_.end()) {
                propHashMap_[handle] = h;
                idlePropertyFullSyncCandidateHash_.erase(handle);
            } else if (it->second != h) {
                if (!ConfirmIdleFullSyncCandidate(idlePropertyFullSyncCandidateHash_, handle, h)) {
                    return;
                }
                it->second = h;
                requestedFullSync = true;
                RequestIdlePollFullSync();
                return;
            } else {
                idlePropertyFullSyncCandidateHash_.erase(handle);
            }
        });

        // Same keep-alive as DetectMaterialChanges: don't let the audit
        // window expire (and wipe candidates) while a confirm is pending.
        if (!idlePropertyFullSyncCandidateHash_.empty()) ArmIdlePollAuditWindow();
    }

    // ── Camera JSON fragment ─────────────────────────────────

    void WriteMaterialTextures(std::wostringstream& ss, const MaxJSPBR& pbr) {
        auto hasTransformData = [](const MaxJSPBR::TexTransform& xf) {
            return xf.isUberBitmap ||
                   xf.hasChannelSelect ||
                   xf.uvChannel != 1 ||
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
                   std::fabs(xf.manualGamma - 1.0f) > 1.0e-6f ||
                   !xf.outLutR.empty() ||
                   xf.alphaFromRGB;
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
            if (xf.uvChannel != 1)
                ss << L",\"uvChannel\":" << xf.uvChannel;
            if (xf.invert)
                ss << L",\"invert\":true";
            if (!xf.colorSpace.empty())
                ss << L",\"colorSpace\":\"" << EscapeJson(xf.colorSpace.c_str()) << L"\"";
            if (std::fabs(xf.manualGamma - 1.0f) > 1.0e-6f) {
                ss << L",\"manualGamma\":";
                WriteFloatValue(ss, xf.manualGamma, 1.0f);
            }
            // BitmapTex Output rollout: baked transfer LUT(s) + alpha mode.
            // Bump Amount is folded into the bumpS scalar, not emitted here.
            auto writeLut = [&](const wchar_t* lutKey, const std::vector<float>& lut) {
                ss << L",\"" << lutKey << L"\":[";
                for (size_t i = 0; i < lut.size(); ++i) {
                    if (i) ss << L',';
                    // 8-bit output: 3 decimals keeps the payload compact
                    WriteFloatValue(ss, std::round(lut[i] * 1000.0f) / 1000.0f, 0.0f);
                }
                ss << L']';
            };
            if (!xf.outLutR.empty()) {
                if (xf.outLutG.empty()) {
                    writeLut(L"outLut", xf.outLutR);
                } else {
                    writeLut(L"outLutR", xf.outLutR);
                    writeLut(L"outLutG", xf.outLutG);
                    writeLut(L"outLutB", xf.outLutB);
                }
            }
            if (xf.alphaFromRGB)
                ss << L",\"alphaFromRGB\":true";
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
                if (xf.htmlOverrideMode)
                    ss << L",\"" << key << L"HTMLOverride\":true";
                if (xf.htmlAutoFit)
                    ss << L",\"" << key << L"HTMLAutoFit\":true";
                if (xfKey) writeXf(xfKey, xf);
                return;
            }
            std::wstring url = MapTexturePath(path);
            if (!url.empty()) {
                ss << L",\"" << key << L"\":\"" << EscapeJson(url.c_str()) << L'"';
                if (xfKey) writeXf(xfKey, xf);
            }
        };
        // Per-slot texture emission is driven by the single ordered slot table in
        // maxjs_material_slots.h (kMaterialSlots). Array order is byte-identical to
        // the previous hand-written writeMap() sequence and the writeMap lambda above
        // is unchanged, so keys / emission order / value shapes / omit-when-empty all
        // match exactly. xfKey == nullptr (gradMap) suppresses the transform sibling.
        for (const maxjs::MaterialSlot& slot : maxjs::kMaterialSlots) {
            writeMap(slot.jsonKey, slot.xfKey, pbr.*(slot.path), pbr.*(slot.transform));
        }
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
        if (pbr.alphaTest > 0.0f) {
            ss << L",\"alphaTest\":";
            WriteFloatValue(ss, pbr.alphaTest, 0.0f);
        }
        if (pbr.transparent) ss << L",\"transparent\":true";
        if (!pbr.depthWrite) ss << L",\"depthWrite\":false";
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
        if (pbr.normalFlipGreen) ss << L",\"normFlipG\":true";
        if (pbr.normalFlipRed) ss << L",\"normFlipR\":true";
        // Output rollout Bump Amount of the bump-slot bitmap scales the bump
        // strength in Max, so fold it into the emitted scalar.
        const float bumpScaleOut = pbr.bumpScale * pbr.bumpMapTransform.outBumpAmount;
        if (!pbr.bumpMap.empty() || std::fabs(bumpScaleOut - 1.0f) > 1.0e-6f) {
            ss << L",\"bumpS\":";
            WriteFloatValue(ss, bumpScaleOut, 1.0f);
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
        // MeshSSSNodeMaterial is MeshPhysicalNodeMaterial plus a subsurface lobe,
        // and the viewer feeds the physical block into it verbatim. Emit that
        // block for both models — the old else-if chain dropped sheen/clearcoat/
        // specular/transmission/iridescence from every SSS material on the wire.
        const bool writePhysicalBlock =
            pbr.materialModel == L"MeshPhysicalMaterial" ||
            pbr.materialModel == L"MeshSSSNodeMaterial";
        if (writePhysicalBlock) {
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
        }
        if (pbr.materialModel == L"MeshSSSNodeMaterial") {
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
            for (int m = 0; m < static_cast<int>(std::size(pbr.tslMaps)); ++m) {
                if (!pbr.tslMaps[m].empty()) {
                    const std::wstring url = MapTexturePath(pbr.tslMaps[m]);
                    if (!url.empty()) {
                        ss << L",\"tslMap" << (m + 1) << L"\":\"" << EscapeJson(url.c_str()) << L"\"";
                    }
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
                           << L",\"n\":\"" << EscapeJson(node->GetName()) << L"\"";
                        if (INode* target = node->GetTarget()) {
                            ss << L",\"targetH\":" << target->GetHandle()
                               << L",\"targetN\":\"" << EscapeJson(target->GetName()) << L"\"";
                        }
                        ss << L"}";
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
        if (cam.clipEnabled) {
            ss << L",\"near\":";
            WriteFloatValue(ss, cam.nearClip, 1.0f);
            ss << L",\"far\":";
            WriteFloatValue(ss, cam.farClip, 100000.0f);
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
        {
            const ULONG parentHandle = GetMaxJSParentHandle(node);
            if (parentHandle != 0) {
                appendComma();
                ss << L"\"p\":" << parentHandle;
            }
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

        const float volContrib = HasParam(pb, pl_vol_contrib) ? pb->GetFloat(pl_vol_contrib, t) : 1.0f;
        // Always emit so the web side never keeps a stale multiplier when the user returns to 1.0.
        ss << L",\"volContrib\":" << volContrib;
        WriteUserPropsJson(ss, node);

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
        ld.volContrib = (pb && HasParam(pb, pl_vol_contrib)) ? pb->GetFloat(pl_vol_contrib, t) : 1.0f;
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
        std::wstring url = rawPath ? MapAudioPath(rawPath) : std::wstring{};

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

    bool WriteWebAppJson(std::wostringstream& ss, INode* node, TimeValue t,
                         bool includeHandle = false, bool includeVisibility = false,
                         bool trackHandle = false) {
        if (!node) return false;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSWebAppClassID(os.obj->ClassID())) return false;

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_webapp_params);
        if (!pb) return false;

        const MCHAR* rawUrl = pb->GetStr(pw_url);
        std::wstring url = rawUrl ? MapWebAppUrl(rawUrl) : std::wstring{};

        const ULONG handle = node->GetHandle();
        float xform[16];
        GetTransform16(node, t, xform);
        if (trackHandle) {
            webappHandles_.insert(handle);
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
        ss << L"\"width\":" << pb->GetInt(pw_width);

        appendComma();
        ss << L"\"height\":" << pb->GetInt(pw_height);

        appendComma();
        ss << L"\"displaySize\":";
        WriteFloatValue(ss, pb->GetFloat(pw_display_size, t), 50.0f);

        appendComma();
        ss << L"\"opacity\":";
        WriteFloatValue(ss, pb->GetFloat(pw_opacity, t), 1.0f);

        appendComma();
        ss << L"\"interactive\":" << (pb->GetInt(pw_interactive) ? L"true" : L"false");

        appendComma();
        ss << L"\"presentation\":\"" << (pb->GetInt(pw_presentation) == 1 ? L"texture" : L"css3d") << L"\"";

        appendComma();
        ss << L"\"depthOcclude\":" << (pb->GetInt(pw_depth_occlude) ? L"true" : L"false");

        appendComma();
        ss << L"\"layerCount\":" << pb->GetInt(pw_layer_count);

        appendComma();
        ss << L"\"layerGap\":";
        WriteFloatValue(ss, pb->GetFloat(pw_layer_gap, t), 5.0f);

        // Named animatable channels — evaluated at t, so Max curves drive them.
        static const ParamID valueIds[kWebAppParamChannels] = {
            pw_param1, pw_param2, pw_param3, pw_param4,
            pw_param5, pw_param6, pw_param7, pw_param8,
            pw_param9, pw_param10, pw_param11, pw_param12,
            pw_param13, pw_param14, pw_param15, pw_param16,
            pw_param17, pw_param18, pw_param19, pw_param20,
            pw_param21, pw_param22, pw_param23, pw_param24,
            pw_param25, pw_param26, pw_param27, pw_param28,
            pw_param29, pw_param30, pw_param31, pw_param32,
        };
        static const ParamID nameIds[kWebAppParamChannels] = {
            pw_param1_name, pw_param2_name, pw_param3_name, pw_param4_name,
            pw_param5_name, pw_param6_name, pw_param7_name, pw_param8_name,
            pw_param9_name, pw_param10_name, pw_param11_name, pw_param12_name,
            pw_param13_name, pw_param14_name, pw_param15_name, pw_param16_name,
            pw_param17_name, pw_param18_name, pw_param19_name, pw_param20_name,
            pw_param21_name, pw_param22_name, pw_param23_name, pw_param24_name,
            pw_param25_name, pw_param26_name, pw_param27_name, pw_param28_name,
            pw_param29_name, pw_param30_name, pw_param31_name, pw_param32_name,
        };
        appendComma();
        ss << L"\"params\":{";
        bool firstParam = true;
        for (int i = 0; i < kWebAppParamChannels; ++i) {
            const MCHAR* name = pb->GetStr(nameIds[i]);
            if (!name || !name[0]) continue;
            if (!firstParam) ss << L',';
            ss << L"\"" << EscapeJson(name) << L"\":";
            WriteFloatValue(ss, pb->GetFloat(valueIds[i], t), 0.0f);
            firstParam = false;
        }
        ss << L'}';

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

    void WriteWebAppsJson(std::wostringstream& ss, Interface* ip, TimeValue t,
                          bool includeHandle = false, bool includeVisibility = false,
                          bool trackHandles = false) {
        ss << L"\"webapps\":[";
        bool firstWebApp = true;
        INode* root = ip ? ip->GetRootNode() : nullptr;
        if (root) {
            std::function<void(INode*)> collectWebApps = [&](INode* parent) {
                for (int i = 0; i < parent->NumberOfChildren(); i++) {
                    INode* node = parent->GetChildNode(i);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE) && !includeVisibility) {
                        collectWebApps(node);
                        continue;
                    }

                    std::wostringstream webappJson;
                    webappJson.imbue(std::locale::classic());
                    if (WriteWebAppJson(webappJson, node, t, includeHandle, includeVisibility, trackHandles)) {
                        if (!firstWebApp) ss << L',';
                        ss << webappJson.str();
                        firstWebApp = false;
                    }

                    collectWebApps(node);
                }
            };
            collectWebApps(root);
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
        const bool emitSubobjectGroups =
            ShouldEmitMultiSubMaterialGroups(multiMtl, grp.groups) ||
            (grp.requiresSubobjectMaterials && multiMtl && !grp.groups.empty());
        if (emitSubobjectGroups) {
            // RailClone segments rely on subobject material IDs; keep the
            // generic groups/mats payload explicit for every grouped segment.
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
