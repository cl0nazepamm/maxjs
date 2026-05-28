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

    void GetActiveCamera(CameraData& cam) {
        if (renderCameraOverrideActive_) {
            cam = renderCameraOverride_;
            return;
        }
        if (lockedCameraHandle_ != 0) {
            Interface* ip = GetCOREInterface();
            INode* camNode = ip ? ip->GetINodeByHandle(lockedCameraHandle_) : nullptr;
            if (camNode && GetSceneCameraData(camNode, ip->GetTime(), cam)) {
                return;
            }
            // Camera deleted or invalid — fall back to viewport
            lockedCameraHandle_ = 0;
        }
        GetViewportCamera(cam);
    }

    void CaptureCurrentCameraState() {
        GetActiveCamera(lastSentCamera_);
        haveLastSentCamera_ = true;
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
            if (IsSceneCameraNode(node)) {
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
            if (skinnedHandles_.count(handle)) continue;
            if (HasPendingTransformChange(handle, node, t)) {
                lastTransformInteractionTick_ = GetTickCount64();
                fastDirtyHandles_.insert(handle);
                changed = true;
                continue;
            }
            if (ShouldSuppressSelectedGeometryForTransform()) continue;
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
        if (skinnedHandles_.empty() && deformHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        if (forceForCurrentTime &&
            haveLastDeformLivePollTime_ &&
            lastDeformLivePollTime_ == t) {
            return;
        }
        const ULONGLONG now = GetTickCount64();
        if (!forceForCurrentTime &&
            lastSkinnedLivePollTick_ != 0 &&
            (now - lastSkinnedLivePollTick_) < kSkinnedLivePollIntervalMs) {
            return;
        }
        lastSkinnedLivePollTick_ = now;
        haveLastDeformLivePollTime_ = true;
        lastDeformLivePollTime_ = t;

        // Any of these means "something is actively changing this frame" and
        // the hash check is wasted work — extraction will happen anyway:
        //   - Animation playback (time advancing every frame)
        //   - Interactive cooldown window (user dragged something recently)
        //   - Any non-renderable (bone/helper/controller) is currently selected
        //
        // Falling into the hash path is only correct for true idle where nothing
        // is moving — it avoids redundant sends when the mesh genuinely isn't
        // changing. But during any kind of activity, hashing doubles the work.
        const bool timelineFastLane = ShouldUseTimelineGeometryFastLane();
        bool skipHash = timelineFastLane
                     || ShouldFavorInteractivePerformance();

        if (!skipHash) {
            const int selCount = ip->GetSelNodeCount();
            for (int i = 0; i < selCount; ++i) {
                INode* sel = ip->GetSelNode(i);
                if (!sel) continue;
                const ULONG selH = sel->GetHandle();
                if (geomHandles_.find(selH) == geomHandles_.end() &&
                    lightHandles_.find(selH) == lightHandles_.end() &&
                    splatHandles_.find(selH) == splatHandles_.end() &&
                    audioHandles_.find(selH) == audioHandles_.end() &&
                    gltfHandles_.find(selH) == gltfHandles_.end() &&
                    hairHandles_.find(selH) == hairHandles_.end()) {
                    // Something non-renderable is selected — assume it's a bone
                    // or controller driving the skin, and skip the hash.
                    skipHash = true;
                    break;
                }
            }
        }

        bool changed = false;
        std::vector<ULONG> deformingHandles;
        deformingHandles.reserve(skinnedHandles_.size() + deformHandles_.size());
        deformingHandles.insert(deformingHandles.end(), skinnedHandles_.begin(), skinnedHandles_.end());
        for (ULONG handle : deformHandles_) {
            // Skip handles already represented via skinnedHandles_ — most
            // skinned meshes also have a derived-object wrapper, but one eval
            // per handle per tick is the contract here.
            if (skinnedHandles_.count(handle)) continue;
            deformingHandles.push_back(handle);
        }

        auto pollHandle = [&](ULONG handle) {
            if (geoFastDirtyHandles_.count(handle)) return;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) return;
            if (forceForCurrentTime && IsAnimationPlaying() && !IsMaxJsSyncDrawVisible(node)) {
                return;
            }
            const bool omitFastChannels = ShouldOmitGeometryFastChannels(node, t);

            if (skipHash) {
                if (!omitFastChannels &&
                    !timelineFastLane &&
                    !IsAnimationPlaying() &&
                    node->Selected() &&
                    HasDeformingChannelChange(handle, node, t, true)) {
                    geoHashMap_.erase(handle);
                    geoFastDirtyHandles_.insert(handle);
                    geoFullFastDirtyHandles_.insert(handle);
                    changed = true;
                    return;
                }

                // Fast path: just mark dirty. SendGeometryFastUpdate will do
                // the one EvalWorldState we actually need (for data extraction).
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
            ObjectState os = node->EvalWorldState(t);
            if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return;
            if (os.obj->IsSubClassOf(polyObjectClassID)) {
                PolyObject* poly = static_cast<PolyObject*>(os.obj);
                MNMesh& mn = poly->GetMesh();
                geomHash = HashAdaptiveSkinnedPositions(mn);
            } else if (os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) {
                TriObject* tri = static_cast<TriObject*>(
                    os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
                if (!tri) return;
                Mesh& mesh = tri->GetMesh();
                geomHash = HashAdaptiveSkinnedPositions(mesh);
                if (tri != os.obj) tri->DeleteThis();
            } else return;
            auto it = lastLiveGeomHash_.find(handle);
            if (it != lastLiveGeomHash_.end() && it->second == geomHash) return;
            lastLiveGeomHash_[handle] = geomHash;

            geoHashMap_.erase(handle);
            geoFastDirtyHandles_.insert(handle);
            changed = true;
        };

        // Same rule as transform sync: playback and active manipulation must
        // be complete per tick or the viewer appears to stutter/lag behind
        // Max. Idle polling can stay budgeted because it is only a safety net
        // for background validity churn.
        if (skipHash) {
            deformLiveScanCursor_ = 0;
            for (ULONG handle : deformingHandles) pollHandle(handle);
        } else {
            VisitBudgetedHandles(
                deformingHandles,
                deformLiveScanCursor_,
                kMaxDeformingGeometryHandlesPerTick,
                pollHandle);
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
        std::unordered_map<Mtl*, uint64_t> scalarPreviewHashCache;

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
            if (supportedMtl && IsThreeJSMaterialClass(supportedMtl->ClassID())) {
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
            uint64_t scalarHash = 0;
            if (supportedMtl) {
                auto cachedScalar = scalarPreviewHashCache.find(supportedMtl);
                if (cachedScalar != scalarPreviewHashCache.end()) {
                    scalarHash = cachedScalar->second;
                } else {
                    ExtractMaterialScalarPreview(supportedMtl, nullptr, t, col, rough, metal, opac);
                    scalarHash = HashMaterialScalarPreviewValues(col, rough, metal, opac);
                    scalarPreviewHashCache[supportedMtl] = scalarHash;
                }
            } else {
                ExtractMaterialScalarPreview(nullptr, node, t, col, rough, metal, opac);
                scalarHash = HashMaterialScalarPreviewValues(col, rough, metal, opac);
            }
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

        auto worldIt = lastSentTransforms_.find(handle);
        if (worldIt == lastSentTransforms_.end()) return true;

        float world[16];
        GetTransform16(node, t, world);
        if (currentWorldOut) std::copy(world, world + 16, currentWorldOut);

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

    static constexpr ULONGLONG kInteractiveCooldownMs = 250;
    static constexpr ULONGLONG kFullSyncInteractiveDeferMs = 650;
    static constexpr ULONGLONG kMaterialInteractiveCooldownMs = 400;
    static constexpr ULONGLONG kMaterialLivePollIntervalMs = 50;
    static constexpr ULONGLONG kIdlePollFullSyncMinIntervalMs = 1500;
    static constexpr ULONGLONG kIdlePollAuditWindowMs = 4000;
    static constexpr size_t kMaxFastFlushHandlesPerPass = 128;
    static constexpr size_t kMaxDeformingGeometryHandlesPerTick = 64;
    static constexpr size_t kMaxIdleMaterialHandlesPerTick = 16;
    static constexpr size_t kMaxIdleLightHandlesPerTick = 64;
    static constexpr size_t kMaxIdleSplatHandlesPerTick = 64;
    static constexpr size_t kMaxIdleJsModHandlesPerTick = 64;
    static constexpr size_t kMaxIdlePluginInstanceHandlesPerTick = 16;
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
        idlePluginInstFullSyncCandidateHash_.clear();
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
                if (FindSupportedMaterial(node->GetMtl()) == targetMtl) {
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
            Mtl* supportedMtl = FindSupportedMaterial(node->GetMtl());
            if (supportedMtl && ReferenceTreeContains(supportedMtl, target)) {
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
                ((targetMtl && supportedMtl == targetMtl) || ReferenceTreeContains(supportedMtl, target));
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
        if (!IsAnimationPlaying()) {
            haveLastPlaybackPollTime_ = false;
            return;
        }
        if (playbackFlushPending_) return;

        const TimeValue t = ip->GetTime();
        if (haveLastPlaybackPollTime_ && t == lastPlaybackPollTime_) return;
        haveLastPlaybackPollTime_ = true;
        lastPlaybackPollTime_ = t;

        // Brute-force playback lane: sample the current evaluated Max time
        // from our own pump and send the whole tracked transform/time state.
        // This keeps viewer playback deterministic without blocking the
        // timeline callback that advances Max itself.
        SendPlaybackDeltaAtTime(t);

        if (!skinnedHandles_.empty() || !deformHandles_.empty()) {
            pendingTimelineDeformScan_ = true;
            QueueFastFlush();
        }
    }

    void FlushPostedPlaybackSync() {
        if (!playbackFlushPending_) return;
        playbackFlushPending_ = false;

        const TimeValue t = playbackFlushTime_;
        haveLastPlaybackPollTime_ = true;
        lastPlaybackPollTime_ = t;

        SendPlaybackDeltaAtTime(t);

        if (!skinnedHandles_.empty() || !deformHandles_.empty()) {
            pendingTimelineDeformScan_ = true;
            QueueFastFlush();
        }
    }

    void OnTimelineTimeChanged(TimeValue t) {
        haveLastTimerTime_ = true;
        lastTimerTime_ = t;

        if (IsAnimationPlaying()) {
            // Playback: do not produce sync from Max's timeline callback.
            // This callback is on the path that advances Max's own time
            // slider; any packing/eval/send work here directly harms Max
            // playback cadence. Store the authored time and post a lightweight
            // message so the real data read/send happens after the callback.
            const bool alreadyPending = playbackFlushPending_;
            playbackFlushTime_ = t;
            playbackFlushPending_ = true;
            if (!alreadyPending && hwnd_) PostMessage(hwnd_, WM_PLAYBACK_FLUSH, 0, 0);
            return;
        }

        fastTimeDirty_ = true;
        lastTimelineInteractionTick_ = GetTickCount64();

        // Scrub: direct flush for lowest latency.
        const bool wasSuppressingPost = suppressFastFlushPost_;
        suppressFastFlushPost_ = true;
        MarkAnimatedTransformsDirty();
        CheckSkinnedGeometryLive(true);
        MarkCameraDirtyIfChanged(false);
        suppressFastFlushPost_ = wasSuppressingPost;

        FlushFastPathNow();
        MarkInteractiveActivity();
    }

    bool SendSharedDeltaFrame(maxjs::sync::DeltaFrameBuilder& frame,
                              std::uint32_t frameId,
                              size_t producerBytesFallback = 0) {
        if (!webview_ || !env_ || !useBinary_) return false;

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!wv17 || !env12) return false;

        frame.EndFrame();
        if (frame.command_count() == 0) return true;

        const auto& frameBytes = frame.bytes();
        const size_t totalBytes = frameBytes.empty() ? 4 : frameBytes.size();

        ComPtr<ICoreWebView2SharedBuffer> sharedBuf;
        HRESULT hr = env12->CreateSharedBuffer(totalBytes, &sharedBuf);
        if (FAILED(hr) || !sharedBuf) return false;

        BYTE* bufPtr = nullptr;
        sharedBuf->get_Buffer(&bufPtr);
        if (bufPtr && !frameBytes.empty()) {
            memcpy(bufPtr, frameBytes.data(), frameBytes.size());
        }

        std::wostringstream meta;
        meta.imbue(std::locale::classic());
        meta << L"{\"type\":\"delta_bin\",\"frame\":" << frameId;
        meta << L",\"stats\":{\"producerBytes\":"
             << (frameBytes.empty() ? producerBytesFallback : frameBytes.size());
        meta << L",\"commandCount\":" << frame.command_count() << L"}}";

        wv17->PostSharedBufferToScript(
            sharedBuf.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            meta.str().c_str());
        return true;
    }

    void SendPlaybackDeltaAtTime(TimeValue t) {
        if (!jsReady_ || !webview_ || !hwnd_ || !IsWindowVisible(hwnd_)) return;
        if (!useBinary_ || !env_) {
            pendingTimelineTransformScan_ = true;
            pendingTimelineCameraCheck_ = true;
            QueueFastFlush();
            return;
        }

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const std::uint32_t frameId = AllocateFrameId();
        maxjs::sync::DeltaFrameBuilder frame(frameId);
        const size_t handleCount =
            helperHandles_.size() +
            geomHandles_.size() +
            lightHandles_.size() +
            splatHandles_.size() +
            audioHandles_.size() +
            gltfHandles_.size();
        frame.ReserveBytes(32 + handleCount * 96 + 80);
        frame.BeginFrame();

        auto shouldSendPlaybackHandle = [&](ULONG handle) -> bool {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) return true;
            if (!SupportsParentedDeltaHandle(handle)) return true;
            if (!GetDirectTrackedParentNode(node)) return true;
            float currentWorld[16];
            if (HasTransformChangedForSync(handle, node, t, currentWorld)) return true;
            RememberSkippedParentedTransform(handle, node, currentWorld);
            return false;
        };

        std::vector<ULONG> playbackHandles;
        playbackHandles.reserve(handleCount);
        auto collectHandle = [&](ULONG handle) {
            if (shouldSendPlaybackHandle(handle)) playbackHandles.push_back(handle);
        };
        for (ULONG handle : helperHandles_) collectHandle(handle);
        for (ULONG handle : geomHandles_) collectHandle(handle);
        for (ULONG handle : lightHandles_) collectHandle(handle);
        for (ULONG handle : splatHandles_) collectHandle(handle);
        for (ULONG handle : audioHandles_) collectHandle(handle);
        for (ULONG handle : gltfHandles_) collectHandle(handle);
        SortHandlesByHierarchyDepth(playbackHandles, ip);

        auto appendHandle = [&](ULONG handle) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                SetDirty();
                return;
            }

            float xform[16];
            GetTransform16(node, t, xform);
            RememberSentTransform(handle, xform);
            const bool visible = IsMaxJsSyncDrawVisible(node);

            if (lightHandles_.find(handle) != lightHandles_.end()) {
                maxjs::sync::DeltaFrameBuilder::LightData ld = {};
                ld.matrix16 = xform;
                ld.visible = visible;
                if (ExtractLightBinaryData(node, t, ld)) {
                    frame.UpdateLight(static_cast<std::uint32_t>(handle), ld);
                }
                return;
            }
            if (splatHandles_.find(handle) != splatHandles_.end()) {
                frame.UpdateSplat(static_cast<std::uint32_t>(handle), xform, visible);
                return;
            }
            if (audioHandles_.find(handle) != audioHandles_.end()) {
                frame.UpdateAudio(static_cast<std::uint32_t>(handle), xform, visible);
                return;
            }
            if (gltfHandles_.find(handle) != gltfHandles_.end()) {
                frame.UpdateGLTF(static_cast<std::uint32_t>(handle), xform, visible);
                return;
            }

            frame.UpdateTransform(static_cast<std::uint32_t>(handle), xform);
            if (helperHandles_.find(handle) != helperHandles_.end()) {
                frame.UpdateSelection(static_cast<std::uint32_t>(handle), node->Selected() != 0);
            }
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), visible);
        };

        for (ULONG handle : playbackHandles) appendHandle(handle);

        CameraData cam = {};
        GetActiveCamera(cam);
        if (!haveLastSentCamera_ || !CameraEquals(lastSentCamera_, cam)) {
            frame.UpdateCamera(cam.pos, cam.target, cam.up, cam.fov, cam.perspective, cam.viewWidth,
                               cam.dofEnabled, cam.dofFocusDistance, cam.dofFocalLength, cam.dofBokehScale);
            lastSentCamera_ = cam;
            haveLastSentCamera_ = true;
            fastCameraDirty_ = false;
        }

        const std::int32_t tpf = GetTicksPerFrame();
        frame.UpdateTime(static_cast<std::int32_t>(t), tpf, 0x01);

        if (!SendSharedDeltaFrame(frame, frameId)) {
            pendingTimelineTransformScan_ = true;
            pendingTimelineCameraCheck_ = true;
            QueueFastFlush();
        }
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

    bool ShouldPollSelectedGeometryLive() const {
        return IsSubObjectEditingActive() || ShouldFavorInteractivePerformance();
    }

    bool ShouldDeferFullSyncForInteraction(ULONGLONG now) const {
        return lastInteractionTick_ != 0 &&
               (now - lastInteractionTick_) <= kFullSyncInteractiveDeferMs;
    }

    bool CanFlushFastPathDuringPendingFullSync() const {
        if (!dirty_) return true;
        return ShouldDeferFullSyncForInteraction(GetTickCount64());
    }

    bool ShouldRunInteractiveMaterialChecks() const {
        const ULONGLONG now = GetTickCount64();
        return lastMaterialInteractionTick_ != 0 &&
               (now - lastMaterialInteractionTick_) <= kMaterialInteractiveCooldownMs;
    }

    bool ConsumeRedrawLivePollSlot() {
        const ULONGLONG now = GetTickCount64();
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
    }

    void ResetFastPathState(bool refreshCameraState = false) {
        fastDirtyHandles_.clear();
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
        haveLastPlaybackPollTime_ = false;
        haveLastDeformLivePollTime_ = false;
        lastTimelineInteractionTick_ = 0;
        lastTransformInteractionTick_ = 0;
        lastCameraLivePollTick_ = 0;
        lastRedrawLivePollTick_ = 0;
        deformLiveScanCursor_ = 0;
        if (refreshCameraState) CaptureCurrentCameraState();
        else haveLastSentCamera_ = false;
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
        if (IsThreeJSSplatClassID(os.obj->ClassID())) return true;
        if (IsThreeJSAudioClassID(os.obj->ClassID())) return true;
        if (IsThreeJSGLTFClassID(os.obj->ClassID())) return true;

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

    bool MarkCameraDirtyIfTargetNodeChanged(const NodeEventNamespace::NodeKeyTab& nodes) {
        if (nodes.Count() <= 0 || lockedCameraHandle_ == 0) return false;
        Interface* ip = GetCOREInterface();
        INode* cameraNode = ip ? ip->GetINodeByHandle(lockedCameraHandle_) : nullptr;
        INode* targetNode = cameraNode ? cameraNode->GetTarget() : nullptr;
        if (!targetNode) return false;
        const ULONG targetHandle = targetNode->GetHandle();
        for (int i = 0; i < nodes.Count(); ++i) {
            INode* node = NodeEventNamespace::GetNodeByKey(nodes[i]);
            if (!node) continue;
            bool matched = false;
            VisitNodeSubtree(node, [targetHandle, &matched](INode* current) {
                if (!matched && current && current->GetHandle() == targetHandle) matched = true;
            });
            if (matched) {
                MarkCameraDirty();
                return true;
            }
        }
        return false;
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
        for (int i = 0; i < selCount; ++i) {
            INode* node = ip->GetSelNode(i);
            if (!node) continue;

            VisitNodeSubtree(node, [this, t, &changed](INode* current) {
                const ULONG handle = current->GetHandle();
                if (!IsTrackedHandle(handle)) return;

                float currentWorld[16];
                if (HasTransformChangedForSync(handle, current, t, currentWorld)) {
                    if (fastDirtyHandles_.insert(handle).second) changed = true;
                } else {
                    RememberSkippedParentedTransform(handle, current, currentWorld);
                }
            });
        }

        if (changed) QueueFastFlush();
        if (changed) MarkInteractiveActivity();
    }

    void MarkTrackedLightTransformsDirty() {
        if (lightHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : lightHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            float currentWorld[16];
            if (HasTransformChangedForSync(handle, node, t, currentWorld)) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            } else {
                RememberSkippedParentedTransform(handle, node, currentWorld);
            }
        }

        if (changed) QueueFastFlush();
        if (changed) MarkInteractiveActivity();
    }

    void MarkTrackedSplatTransformsDirty() {
        if (splatHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : splatHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            float xform[16];
            GetTransform16(node, t, xform);

            auto it = lastSentTransforms_.find(handle);
            if (it == lastSentTransforms_.end() || !TransformEquals16(xform, it->second.data())) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        }

        if (changed) QueueFastFlush();
        if (changed) MarkInteractiveActivity();
    }

    void MarkTrackedAudioTransformsDirty() {
        if (audioHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : audioHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            float xform[16];
            GetTransform16(node, t, xform);

            auto it = lastSentTransforms_.find(handle);
            if (it == lastSentTransforms_.end() || !TransformEquals16(xform, it->second.data())) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
        }

        if (changed) QueueFastFlush();
        if (changed) MarkInteractiveActivity();
    }

    void MarkTrackedGLTFTransformsDirty() {
        if (gltfHandles_.empty()) return;

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        bool changed = false;

        for (ULONG handle : gltfHandles_) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) continue;

            float xform[16];
            GetTransform16(node, t, xform);

            auto it = lastSentTransforms_.find(handle);
            if (it == lastSentTransforms_.end() || !TransformEquals16(xform, it->second.data())) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            }
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
        fastDirtyHandles_.insert(splatHandles_.begin(), splatHandles_.end());
        fastDirtyHandles_.insert(audioHandles_.begin(), audioHandles_.end());
        fastDirtyHandles_.insert(gltfHandles_.begin(), gltfHandles_.end());
        fastDirtyHandles_.insert(hairHandles_.begin(), hairHandles_.end());
        fastDirtyHandles_.insert(helperHandles_.begin(), helperHandles_.end());
        QueueFastFlush();
    }

    void MarkAnimatedTransformsDirty() {
        if (!HasTrackedNodes()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;

        const TimeValue t = ip->GetTime();
        bool changed = false;
        auto markIfTransformChanged = [this, t, &changed](ULONG handle) {
            INode* node = GetCOREInterface() ? GetCOREInterface()->GetINodeByHandle(handle) : nullptr;
            if (!node) return;

            float currentWorld[16];
            if (HasTransformChangedForSync(handle, node, t, currentWorld)) {
                if (fastDirtyHandles_.insert(handle).second) changed = true;
            } else {
                RememberSkippedParentedTransform(handle, node, currentWorld);
            }
        };

        // Timeline playback/scrubbing must be complete every Max time tick.
        // Budgeting this loop makes low-poly scenes look like the time slider
        // is skipping because only part of the scene reaches the web side on a
        // given tick. Keep quality here; reduce cost in heavier hashing paths.
        for (ULONG handle : geomHandles_) markIfTransformChanged(handle);
        for (ULONG handle : lightHandles_) markIfTransformChanged(handle);
        for (ULONG handle : splatHandles_) markIfTransformChanged(handle);
        for (ULONG handle : audioHandles_) markIfTransformChanged(handle);
        for (ULONG handle : gltfHandles_) markIfTransformChanged(handle);
        for (ULONG handle : hairHandles_) markIfTransformChanged(handle);
        for (ULONG handle : helperHandles_) markIfTransformChanged(handle);

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
        const ULONGLONG now = GetTickCount64();
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
        std::wostringstream ss;
        ss << L"{\"type\":\"live_sync_settings\",\"disabled\":"
           << (slowJsonSyncMode_ ? L"true" : L"false")
           << L",\"mode\":\"" << (slowJsonSyncMode_ ? L"slow-json" : L"live-fast") << L"\"}";
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void SetSlowJsonSyncMode(bool enabled) {
        if (slowJsonSyncMode_ == enabled) {
            SendLiveSyncSettings();
            return;
        }

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
            bool disabled = false;
            ExtractJsonBool(msg, L"disabled", disabled);
            SetSlowJsonSyncMode(disabled);
            return;
        }
        // Layer mount/remove or host-side sync repair — full resend without reloading WebView2
        if (type == L"scene_dirty" || msg.find(L"\"scene_dirty\"") != std::wstring::npos) {
            jsmodStateMap_.clear();
            geoHashMap_.clear();
            geoFastTriangleCountMap_.clear();
            deformChannelHashMap_.clear();
            lastLiveGeomHash_.clear();
            SetDirtyImmediate();
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
            ExtractJsonBool(msg, L"includeFog", options.includeFog);
            ExtractJsonBool(msg, L"includeLights", options.includeLights);
            ExtractJsonBool(msg, L"includeSplats", options.includeSplats);
            ExtractJsonBool(msg, L"includeAudios", options.includeAudios);
            ExtractJsonBool(msg, L"includeGLTFs", options.includeGLTFs);
            ExtractJsonBool(msg, L"includeInstances", options.includeInstances);
            ExtractJsonBool(msg, L"includeDebugPayload", options.includeDebugPayload);
            ExtractJsonBool(msg, L"includeSnapshotUi", options.includeSnapshotUi);
            ExtractJsonBool(msg, L"includeRuntimeScene", options.includeRuntimeScene);
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
            SendHostActionResult(type, requestId, ok, error, exportPath);
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
        if (type == L"render_to_image_ready") {
            if (renderImageEvent_) SetEvent(renderImageEvent_);
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
            splatHashMap_.clear();
            propHashMap_.clear();
            geoHashMap_.clear();  // force all geometry to be sent
            geoFastTriangleCountMap_.clear();
            deformChannelHashMap_.clear();
            jsmodStateMap_.clear();
            inlineLayersStateSignature_.clear();  // re-scan inline layers on reconnect
            lastSentTransforms_.clear();
            lightHandles_.clear();
            splatHandles_.clear();
            audioHandles_.clear();
            gltfHandles_.clear();
            hairHandles_.clear();
            helperHandles_.clear();
            deformHandles_.clear();
            audioHashMap_.clear();
            gltfHashMap_.clear();
            geoScanCursor_ = 0;
            skinnedControlIdxCache_.clear();
            skinnedFastSourceCache_.clear();
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
            if (lastSlowJsonSyncTick_ == 0 ||
                (now - lastSlowJsonSyncTick_) >= SLOW_JSON_SYNC_INTERVAL_MS) {
                lastSlowJsonSyncTick_ = now;
                SendTransformSync(nullptr, false);
            }
            return;
        }

        const int envPhase = tickCount_ % ENV_FOG_POLL_TICKS;
        const int lightPhase = tickCount_ % LIGHT_DETECT_TICKS;
        const int slowPhase = tickCount_ % 15;

        const bool pathTracingFreezePolling =
            IsPathTracingNativeFreezeActive() && pathTracingHasSceneSync_;

        // Poll env+fog at reduced cadence (~200ms)
        if (envPhase == 0) PollEnvFog();

        PumpDeferredIdlePollFullSync(now);

        if (dirty_) {
            if (IsAnimationPlaying()) {
                PumpPlaybackSyncFromTimer();
                return;
            }

            const bool debounceReady =
                dirtyStamp_ == 0 || (now - dirtyStamp_) >= DIRTY_DEBOUNCE_MS;
            const bool deferForInteraction = ShouldDeferFullSyncForInteraction(now);

            if (deferForInteraction) {
                PollInteractiveFastPathWhileFullSyncDeferred();
            }

            // Debounce: wait for notifications and interactive drags to settle before expensive full sync.
            if (debounceReady && !deferForInteraction) {
                dirty_ = false;
                idlePollFullSyncPending_ = false;
                ClearIdlePollFullSyncCandidates();
                if (useBinary_) SendFullSyncBinary(); else SendFullSync();
                pathTracingHasSceneSync_ = true;
            }
        } else {
            const bool animPlaying = IsAnimationPlaying();
            if (animPlaying) {
                PumpPlaybackSyncFromTimer();
            } else {
                if (haveLastPlaybackPollTime_) {
                    haveLastPlaybackPollTime_ = false;
                    fastTimeDirty_ = true;
                    FlushFastPathNow();
                }
                haveLastPlaybackPollTime_ = false;
                MarkCameraDirtyIfChanged(false);
                PollSelectedTransformGizmoLive();
                if (ShouldPollSelectedGeometryLive()) CheckSelectedGeometryLive();
                PumpTimelineSyncFromTimer();
                CheckSkinnedGeometryLive();
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
            if (allowMaterialPolling && tickCount_ % MATERIAL_DETECT_TICKS == 2) DetectMaterialChanges();
            if (allowHeavyPolling && allowIdlePolling && lightPhase == 0) DetectPropertyChanges();
            if (allowTimelineAuxPolling && allowRealtimeAuxPolling && lightPhase == 1) {
                DetectLightChanges();
                DetectSplatChanges();
            }
            // Audio is cheap (few nodes, 7 params each) — poll every tick
            // and ignore the interactive gate so spinner drags propagate live.
            if (allowTimelineAuxPolling) {
                DetectAudioChanges();
                DetectGLTFChanges();
            }
            if (allowHeavyGeometryPolling && slowPhase == 6) DetectGeometryChanges();
            if (allowIdlePolling && slowPhase == 9) DetectJsModChanges();
            if (allowIdlePolling && slowPhase == 12) DetectPluginInstanceChanges();
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
            if (!node) continue;
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
            const bool preferPositionOnlyDeformSync =
                isDeforming && !forceFullGeometry &&
                (timelineFastLane || ShouldFavorInteractivePerformance());
            const bool hasVertexColors =
                !preferPositionOnlyDeformSync &&
                isDeforming &&
                NodeHasExtractableVertexColors(node, t);

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
            if (!preferPositionOnlyDeformSync) {
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
            // Fast-deform path: positions and normals are re-sent without
            // indices/UVs/material groups. Valid for meshes whose topology and
            // non-position channels are stable between full syncs — i.e.,
            // meshes where the current
            // frame's change is driven by a modifier's deformation, not by
            // a direct edit that could also change UVs or topology.
            //
            // Gated on "is deforming" (Skin or any modifier-stack mesh), not
            // just cache presence — static meshes with manual vertex edits
            // need the full ExtractMesh path so UV/topology changes are not
            // silently dropped.
            bool usedSkinnedFastPositions = false;
            if (wv17 && env12 && isDeforming && !forceFullGeometry &&
                (!hasVertexColors || preferPositionOnlyDeformSync)) {
                // Timeline/interactive deformation is latency-bound, not
                // normal-bound. Normal extraction is exactly the expensive path
                // on faceted Editable Mesh input: it walks smoothing islands
                // and can multiply render vertices. Keep the current normal
                // buffer while Max is playing or scrubbing; idle/full sync can
                // refresh normals after the time slider settles.
                const bool streamLiveNormals = !omitFastChannels && !preferPositionOnlyDeformSync;
                auto sourceIt = skinnedFastSourceCache_.find(handle);
                if (sourceIt != skinnedFastSourceCache_.end()) {
                    usedSkinnedFastPositions = ExtractSkinnedFastGeometry(
                        node, t, sourceIt->second, verts, streamLiveNormals ? &norms : nullptr);
                }
                if (!usedSkinnedFastPositions) {
                    auto cacheIt = skinnedControlIdxCache_.find(handle);
                    if (cacheIt != skinnedControlIdxCache_.end()) {
                        usedSkinnedFastPositions = ExtractSkinnedFastPositions(node, t, cacheIt->second, verts);
                    }
                }
            }

            std::vector<VertexColorAttributeRecord> vertexColors;
            std::vector<int> controlIdx;
            std::vector<FastVertexSource> fastSources;
            std::vector<float>* extractNormals =
                (omitFastChannels || preferPositionOnlyDeformSync) ? nullptr : &norms;
            if (!usedSkinnedFastPositions &&
                !ExtractMesh(node, t, verts, uvs, indices, groups, extractNormals, &controlIdx, &vertexColors, &fastSources, nullptr, !omitFastChannels)) {
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
                if (!isSpline && controlIdx.size() * 3 == verts.size()) {
                    skinnedControlIdxCache_[handle] = std::move(controlIdx);
                    if (fastSources.size() * 3 == verts.size())
                        skinnedFastSourceCache_[handle] = std::move(fastSources);
                    else
                        skinnedFastSourceCache_.erase(handle);
                } else {
                    skinnedControlIdxCache_.erase(handle);
                    skinnedFastSourceCache_.erase(handle);
                }
            }

            JsModData jmFast;
            GetJsModData(node, t, jmFast);

            if (wv17 && env12) {
                size_t totalBytes = verts.size() * 4;
                if (usedSkinnedFastPositions) {
                    totalBytes += norms.size() * 4;
                } else {
                    totalBytes += indices.size() * 4 + uvs.size() * 4 + norms.size() * 4;
                    for (const VertexColorAttributeRecord& attr : vertexColors) {
                        totalBytes += attr.values.size() * sizeof(float);
                    }
                }
                if (totalBytes < 4) totalBytes = 4;

                ComPtr<ICoreWebView2SharedBuffer> buf;
                if (FAILED(env12->CreateSharedBuffer(totalBytes, &buf)) || !buf) continue;

                BYTE* ptr = nullptr;
                buf->get_Buffer(&ptr);
                size_t off = 0;
                memcpy(ptr + off, verts.data(), verts.size() * 4); size_t vOff = off; off += verts.size() * 4;
                size_t iOff = 0;
                size_t uvOff = 0;
                size_t nOff = 0;
                if (usedSkinnedFastPositions) {
                    nOff = off;
                    if (!norms.empty()) { memcpy(ptr + off, norms.data(), norms.size() * 4); off += norms.size() * 4; }
                } else {
                    memcpy(ptr + off, indices.data(), indices.size() * 4); iOff = off; off += indices.size() * 4;
                    uvOff = off;
                    if (!uvs.empty()) { memcpy(ptr + off, uvs.data(), uvs.size() * 4); off += uvs.size() * 4; }
                    nOff = off;
                    if (!norms.empty()) { memcpy(ptr + off, norms.data(), norms.size() * 4); off += norms.size() * 4; }
                    for (VertexColorAttributeRecord& attr : vertexColors) {
                        attr.off = off;
                        if (!attr.values.empty()) {
                            memcpy(ptr + off, attr.values.data(), attr.values.size() * sizeof(float));
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
                ss << L",\"vOff\":" << vOff << L",\"vN\":" << verts.size();
                if (usedSkinnedFastPositions) {
                    if (!norms.empty()) ss << L",\"nOff\":" << nOff << L",\"nN\":" << norms.size();
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

                wv17->PostSharedBufferToScript(buf.Get(),
                    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                    ss.str().c_str());
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
                webview_->PostWebMessageAsJson(ss.str().c_str());
            }
        }
    }

    void SendHairFastUpdate(const std::vector<ULONG>& dirtyHandles) {
        if (!webview_) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();

        std::vector<ULONG> hairDirty;
        for (ULONG h : dirtyHandles) {
            if (hairHandles_.find(h) != hairHandles_.end()) hairDirty.push_back(h);
        }
        if (hairDirty.empty()) return;

        std::vector<HairInstanceGroup> groups;
        for (ULONG h : hairDirty) {
            INode* node = ip->GetINodeByHandle(h);
            if (!node) continue;
            ExtractHairInstances(node, t, groups);
        }
        if (groups.empty()) return;

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
        webview_->PostWebMessageAsJson(ss.str().c_str());
    }

    void FlushFastPath() {
        fastFlushPosted_ = false;

        if (!jsReady_ || !webview_) return;
        if (dirty_ && !CanFlushFastPathDuringPendingFullSync()) return;
        if (!hwnd_ || !IsWindowVisible(hwnd_)) return;

        ConsumePendingTimelineFastSyncWork();

        // Check for lights/splats/audios BEFORE batching to ensure consistent protocol
        // selection even when handles are deferred across frames.
        bool hasDirtyLights = false;
        bool hasDirtySplats = false;
        bool hasDirtyAudios = false;
        bool hasDirtyGLTFs = false;
        for (ULONG handle : fastDirtyHandles_) {
            if (!hasDirtyLights && lightHandles_.find(handle) != lightHandles_.end()) {
                hasDirtyLights = true;
            }
            if (!hasDirtySplats && splatHandles_.find(handle) != splatHandles_.end()) {
                hasDirtySplats = true;
            }
            if (!hasDirtyAudios && audioHandles_.find(handle) != audioHandles_.end()) {
                hasDirtyAudios = true;
            }
            if (!hasDirtyGLTFs && gltfHandles_.find(handle) != gltfHandles_.end()) {
                hasDirtyGLTFs = true;
            }
        }

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
            fastFlushPosted_ = true;
            if (!PostMessage(hwnd_, WM_FAST_FLUSH, 0, 0)) {
                fastFlushPosted_ = false;
            }
        } else {
            fastDirtyHandles_.clear();
        }

        const bool hasDirtyCamera = fastCameraDirty_;
        const bool hasDirtyTime = fastTimeDirty_;

        // Collect geometry-dirty handles before clearing
        std::unordered_set<ULONG> geoDirty;
        geoDirty.swap(geoFastDirtyHandles_);
        std::unordered_set<ULONG> geoFullDirty;
        geoFullDirty.swap(geoFullFastDirtyHandles_);
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

        for (ULONG handle : dirtyHandles) visibilityDirty.erase(handle);
        fastCameraDirty_ = false;
        fastTimeDirty_ = false;

        std::vector<ULONG> combinedNodeHandles = dirtyHandles;
        combinedNodeHandles.reserve(dirtyHandles.size() + visibilityDirty.size());
        for (ULONG handle : visibilityDirty) combinedNodeHandles.push_back(handle);
        SortHandlesByHierarchyDepth(combinedNodeHandles, sortIp);

        // Geometry fast path: send changed mesh vertex data via binary geo_fast.
        // Then fall through to binary delta for transform/visibility/etc updates.
        if (!geoDirty.empty()) {
            SendGeometryFastUpdate(geoDirty, &geoFullDirty);
        }

        const bool hasAnyNodeUpdates = !combinedNodeHandles.empty();
        if (!hasAnyNodeUpdates && !hasDirtyCamera && !hasDirtyTime) return;

        // Also check visibility dirty handles for lights/splats/audios
        for (ULONG handle : visibilityDirty) {
            if (!hasDirtyLights && lightHandles_.find(handle) != lightHandles_.end()) {
                hasDirtyLights = true;
            }
            if (!hasDirtySplats && splatHandles_.find(handle) != splatHandles_.end()) {
                hasDirtySplats = true;
            }
            if (!hasDirtyAudios && audioHandles_.find(handle) != audioHandles_.end()) {
                hasDirtyAudios = true;
            }
            if (!hasDirtyGLTFs && gltfHandles_.find(handle) != gltfHandles_.end()) {
                hasDirtyGLTFs = true;
            }
        }

        // Hair fast path: re-extract world-space hair instances for any dirty
        // hair handles. Covers transforms, deformation, frizz, dynamics — any
        // change that alters GetHairDefinition output.
        SendHairFastUpdate(dirtyHandles);

        if (!useBinary_) {
            if (hasAnyNodeUpdates) SendTransformSync(&combinedNodeHandles);
            else SendCameraSync();
            CaptureCurrentCameraState();
            return;
        }

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!wv17 || !env12) {
            if (hasAnyNodeUpdates) SendTransformSync(&combinedNodeHandles);
            else SendCameraSync();
            CaptureCurrentCameraState();
            return;
        }

        Interface* ip = GetCOREInterface();
        if (!ip) return;

        TimeValue t = ip->GetTime();
        const std::uint32_t frameId = AllocateFrameId();
        maxjs::sync::DeltaFrameBuilder frame(frameId);
        frame.ReserveBytes(32 + dirtyHandles.size() * 160 + visibilityDirty.size() * 12 + (hasDirtyCamera ? 64 : 0) + 16);
        frame.BeginFrame();

        for (ULONG handle : dirtyHandles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                mtlScalarHashMap_.erase(handle);
                mtlFastScalarHashMap_.erase(handle);
                lightHashMap_.erase(handle);
                splatHashMap_.erase(handle);
                audioHashMap_.erase(handle);
                gltfHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                deformChannelHashMap_.erase(handle);
                skinnedControlIdxCache_.erase(handle);
                skinnedFastSourceCache_.erase(handle);
                geomHandles_.erase(handle);
                lightHandles_.erase(handle);
                splatHandles_.erase(handle);
                audioHandles_.erase(handle);
                gltfHandles_.erase(handle);
                hairHandles_.erase(handle);
                helperHandles_.erase(handle);
                deformHandles_.erase(handle);
                lastSentTransforms_.erase(handle);
                materialFastDirtyHandles_.erase(handle);
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
            RememberSentTransform(handle, xform);
            const bool visible = IsMaxJsSyncDrawVisible(node);

            // Use specialized commands for lights/splats/audios
            if (lightHandles_.find(handle) != lightHandles_.end()) {
                maxjs::sync::DeltaFrameBuilder::LightData ld = {};
                ld.matrix16 = xform;
                ld.visible = visible;
                if (ExtractLightBinaryData(node, t, ld)) {
                    frame.UpdateLight(static_cast<std::uint32_t>(handle), ld);
                }
                continue;
            }
            if (splatHandles_.find(handle) != splatHandles_.end()) {
                frame.UpdateSplat(static_cast<std::uint32_t>(handle), xform, visible);
                continue;
            }
            if (audioHandles_.find(handle) != audioHandles_.end()) {
                frame.UpdateAudio(static_cast<std::uint32_t>(handle), xform, visible);
                continue;
            }
            if (gltfHandles_.find(handle) != gltfHandles_.end()) {
                frame.UpdateGLTF(static_cast<std::uint32_t>(handle), xform, visible);
                continue;
            }

            // Regular geometry node
            frame.UpdateTransform(static_cast<std::uint32_t>(handle), xform);
            frame.UpdateSelection(static_cast<std::uint32_t>(handle), node->Selected() != 0);
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), visible);

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
            frame.UpdateVisibility(static_cast<std::uint32_t>(handle), IsMaxJsSyncDrawVisible(node));
        }

        if (hasDirtyCamera) {
            CameraData cam = {};
            GetActiveCamera(cam);
            frame.UpdateCamera(cam.pos, cam.target, cam.up, cam.fov, cam.perspective, cam.viewWidth,
                               cam.dofEnabled, cam.dofFocusDistance, cam.dofFocalLength, cam.dofBokehScale);
            lastSentCamera_ = cam;
            haveLastSentCamera_ = true;
        }

        // Time oracle — JS timeline / ctx.maxTime reads this.
        {
            const std::int32_t tpf = GetTicksPerFrame();
            const std::uint8_t stateFlags = IsAnimationPlaying() ? 0x01 : 0x00;
            frame.UpdateTime(static_cast<std::int32_t>(t), tpf, stateFlags);
        }
        frame.EndFrame();
        if (frame.command_count() == 0) return;

        const auto& frameBytes = frame.bytes();
        const size_t totalBytes = frameBytes.empty() ? 4 : frameBytes.size();

        ComPtr<ICoreWebView2SharedBuffer> sharedBuf;
        HRESULT hr = env12->CreateSharedBuffer(totalBytes, &sharedBuf);
        if (FAILED(hr) || !sharedBuf) {
            if (hasAnyNodeUpdates) SendTransformSync(&combinedNodeHandles);
            else SendCameraSync();
            CaptureCurrentCameraState();
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

        wv17->PostSharedBufferToScript(
            sharedBuf.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            meta.str().c_str());
    }

    EnvData cachedEnv_;
    FogData cachedFog_;
    std::wstring cachedEnvJson_;   // pre-built JSON fragment
    std::wstring cachedFogJson_;   // pre-built JSON fragment
    std::wstring cachedHdriPath_;  // last HDRI path we mapped
    std::wstring cachedHdriUrl_;   // cached MapTexturePath result
    static constexpr int ENV_FOG_POLL_TICKS = 6;  // ~200ms at 33ms tick

    std::wstring lastEnvFogSig_;   // change-detection signature

    // Poll env+fog at reduced cadence; send standalone message ONLY when changed
    void PollEnvFog() {
        if (!webview_) return;

        EnvData env;
        GetEnvironment(env);
        FogData fog;
        GetFogData(fog);

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

        // Build env+fog JSON
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"env_update\",";
        WriteEnvJson(ss, env, hdriUrl);
        ss << L",";
        WriteFogJson(ss, fog);
        ss << L'}';
        std::wstring json = ss.str();

        // Only send if something changed
        if (json == lastEnvFogSig_) return;
        lastEnvFogSig_ = json;
        cachedEnv_ = env;
        cachedFog_ = fog;

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
                skinnedControlIdxCache_.erase(handle);
                skinnedFastSourceCache_.erase(handle);
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
            ss << L"{\"multi\":true,\"count\":" << multiMtl->NumSubMtls() << L",\"mats\":[";
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
                   has(p.specularIntensityMapTransform) || has(p.specularColorMapTransform);
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
            state.structureHash = HashMaterialPBRState(stable);
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

    MaterialSyncState ComputeMaterialSyncState(INode* node, TimeValue t) {
        MaterialSyncState state;
        if (!node) return state;

        Mtl* rawMtl = node->GetMtl();
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

        ss << L",\"volContrib\":" << (HasParam(pb, pl_vol_contrib) ? pb->GetFloat(pl_vol_contrib, t) : 0.0f);
        ss << L'}';

        const std::wstring payload = ss.str();
        return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
    }

    uint64_t ComputeSplatStateHash(INode* node, TimeValue t) {
        if (!node) return 0;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSSplatClassID(os.obj->ClassID())) {
            const std::wstring payload = L"null";
            return HashFNV1a(payload.data(), payload.size() * sizeof(wchar_t));
        }

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_splat_params);
        const MCHAR* rawPath = pb ? pb->GetStr(ps_splat_file) : nullptr;
        std::wstring mappedPath = rawPath ? MapTexturePath(rawPath) : std::wstring{};

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"v\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
        ss << L",\"url\":\"" << EscapeJson(mappedPath.c_str()) << L"\"}";
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

    // Material graph/physical edits use full sync. Preview-safe scalar edits
    // stay on delta_bin so interactive material work does not rebuild the scene.
    void DetectMaterialChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip) return;
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

    void DetectSplatChanges() {
        Interface* ip = GetCOREInterface();
        if (!ip || splatHandles_.empty()) return;

        TimeValue t = ip->GetTime();
        bool changed = false;
        std::vector<ULONG> handles;
        handles.reserve(splatHandles_.size());
        for (ULONG handle : splatHandles_) handles.push_back(handle);

        VisitBudgetedHandles(handles, splatScanCursor_, kMaxIdleSplatHandlesPerTick, [&](ULONG handle) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) return;

            const uint64_t hash = ComputeSplatStateHash(node, t);
            auto it = splatHashMap_.find(handle);
            if (it == splatHashMap_.end()) {
                splatHashMap_[handle] = hash;
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
                    deformHandles_.count(handle);
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

    void DetectPluginInstanceChanges() {
        if (pluginInstHandles_.empty()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        bool requestedFullSync = false;
        std::vector<ULONG> handles;
        handles.reserve(pluginInstHandles_.size());
        for (ULONG handle : pluginInstHandles_) handles.push_back(handle);

        VisitBudgetedHandles(handles, pluginInstScanCursor_, kMaxIdlePluginInstanceHandlesPerTick, [&](ULONG handle) {
            if (requestedFullSync) return;
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                idlePluginInstFullSyncCandidateHash_.erase(handle);
                return;
            }
            const uint64_t stateHash = ComputePluginInstanceStateHash(node, t, ip);

            auto it = pluginInstHash_.find(handle);
            if (it == pluginInstHash_.end()) {
                pluginInstHash_[handle] = stateHash;
                idlePluginInstFullSyncCandidateHash_.erase(handle);
            } else if (it->second != stateHash) {
                if (!ConfirmIdleFullSyncCandidate(idlePluginInstFullSyncCandidateHash_, handle, stateHash)) {
                    return;
                }
                it->second = stateHash;
                requestedFullSync = true;
                RequestIdlePollFullSync();
                return;
            } else {
                idlePluginInstFullSyncCandidateHash_.erase(handle);
            }
        });
    }

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
                   std::fabs(xf.manualGamma - 1.0f) > 1.0e-6f;
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
        writeMap(L"map", L"mapXf", pbr.colorMap, pbr.colorMapTransform);
        writeMap(L"gradMap", nullptr, pbr.gradientMap, pbr.gradientMapTransform);
        writeMap(L"roughMap", L"roughMapXf", pbr.roughnessMap, pbr.roughnessMapTransform);
        writeMap(L"metalMap", L"metalMapXf", pbr.metalnessMap, pbr.metalnessMapTransform);
        writeMap(L"normMap", L"normMapXf", pbr.normalMap, pbr.normalMapTransform);
        writeMap(L"bumpMap", L"bumpMapXf", pbr.bumpMap, pbr.bumpMapTransform);
        writeMap(L"dispMap", L"dispMapXf", pbr.displacementMap, pbr.displacementMapTransform);
        writeMap(L"parallaxMap", L"parallaxMapXf", pbr.parallaxMap, pbr.parallaxMapTransform);
        writeMap(L"aoMap", L"aoMapXf", pbr.aoMap, pbr.aoMapTransform);
        writeMap(L"sssMap", L"sssMapXf", pbr.sssColorMap, pbr.sssColorMapTransform);
        writeMap(L"matcapMap", L"matcapMapXf", pbr.matcapMap, pbr.matcapMapTransform);
        writeMap(L"specMap", L"specMapXf", pbr.specularMap, pbr.specularMapTransform);
        writeMap(L"specIntMap", L"specIntMapXf", pbr.specularIntensityMap, pbr.specularIntensityMapTransform);
        writeMap(L"specColMap", L"specColMapXf", pbr.specularColorMap, pbr.specularColorMapTransform);
        writeMap(L"emMap", L"emMapXf", pbr.emissionMap, pbr.emissionMapTransform);
        writeMap(L"lmMap", L"lmMapXf", pbr.lightmapFile, pbr.lightmapTransform);
        writeMap(L"opMap", L"opMapXf", pbr.opacityMap, pbr.opacityMapTransform);
        writeMap(L"transMap", L"transMapXf", pbr.transmissionMap, pbr.transmissionMapTransform);
        writeMap(L"ccMap", L"ccMapXf", pbr.clearcoatMap, pbr.clearcoatMapTransform);
        writeMap(L"ccRoughMap", L"ccRoughMapXf", pbr.clearcoatRoughnessMap, pbr.clearcoatRoughnessMapTransform);
        writeMap(L"ccNormMap", L"ccNormMapXf", pbr.clearcoatNormalMap, pbr.clearcoatNormalMapTransform);
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
        if (!pbr.bumpMap.empty() || std::fabs(pbr.bumpScale - 1.0f) > 1.0e-6f) {
            ss << L",\"bumpS\":";
            WriteFloatValue(ss, pbr.bumpScale, 1.0f);
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
        if (pbr.materialModel == L"MeshPhysicalMaterial") {
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
        } else if (pbr.materialModel == L"MeshSSSNodeMaterial") {
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
                           << L",\"n\":\"" << EscapeJson(node->GetName()) << L"\"}";
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

        const float volContrib = pb->GetFloat(pl_vol_contrib, t);
        // Always emit so the web side never keeps a stale multiplier when the user returns to 1.0.
        ss << L",\"volContrib\":" << volContrib;

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
        ld.volContrib = (pb && HasParam(pb, pl_vol_contrib)) ? pb->GetFloat(pl_vol_contrib, t) : 0.0f;
        return true;
    }

    bool WriteSplatJson(std::wostringstream& ss, INode* node, TimeValue t,
                        bool includeHandle = false, bool includeVisibility = false,
                        bool trackHandle = false) {
        if (!node) return false;

        ObjectState os = node->EvalWorldState(t);
        if (!os.obj || !IsThreeJSSplatClassID(os.obj->ClassID())) return false;

        IParamBlock2* pb = os.obj->GetParamBlockByID(threejs_splat_params);
        if (!pb) return false;

        const MCHAR* rawPath = pb->GetStr(ps_splat_file);
        std::wstring url = rawPath ? MapTexturePath(rawPath) : std::wstring{};

        const ULONG handle = node->GetHandle();
        float xform[16];
        GetTransform16(node, t, xform);
        if (trackHandle) {
            splatHandles_.insert(handle);
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
        ss << L'}';
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

    void WriteSplatsJson(std::wostringstream& ss, Interface* ip, TimeValue t,
                         bool includeHandle = false, bool includeVisibility = false,
                         bool trackHandles = false) {
        ss << L"\"splats\":[";
        bool firstSplat = true;
        INode* root = ip ? ip->GetRootNode() : nullptr;
        if (root) {
            std::function<void(INode*)> collectSplats = [&](INode* parent) {
                for (int i = 0; i < parent->NumberOfChildren(); i++) {
                    INode* node = parent->GetChildNode(i);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE) && !includeVisibility) {
                        collectSplats(node);
                        continue;
                    }

                    std::wostringstream splatJson;
                    splatJson.imbue(std::locale::classic());
                    if (WriteSplatJson(splatJson, node, t, includeHandle, includeVisibility, trackHandles)) {
                        if (!firstSplat) ss << L',';
                        ss << splatJson.str();
                        firstSplat = false;
                    }

                    collectSplats(node);
                }
            };
            collectSplats(root);
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
        if (ShouldEmitMultiSubMaterialGroups(multiMtl, grp.groups)) {
            // Multi/Sub: write groups + per-group sub-materials
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
