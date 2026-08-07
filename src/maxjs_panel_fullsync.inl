    // ── Full scene sync ──────────────────────────────────────
    void CollectLiveCameraLightCarriers(INode* parent, TimeValue t,
                                        std::unordered_set<ULONG>& out) {
        if (!parent) return;
        for (int i = 0; i < parent->NumberOfChildren(); ++i) {
            INode* node = parent->GetChildNode(i);
            if (!node) continue;

            ObjectState os = node->EvalWorldState(t);
            if (os.obj && IsThreeJSLightClassID(os.obj->ClassID())) {
                for (INode* ancestor = node->GetParentNode();
                     ancestor && !ancestor->IsRootNode();
                     ancestor = ancestor->GetParentNode()) {
                    if (IsSceneCameraNode(ancestor)) {
                        out.insert(ancestor->GetHandle());
                    }
                }
            }
            CollectLiveCameraLightCarriers(node, t, out);
        }
    }

    bool SendFullSync() {
        Interface* ip = GetCOREInterface();
        if (!ip || !webview_) {
            HandleFullSyncDeliveryFailure();
            return false;
        }
        // Serialization touches every material/texmap — keep the watcher from
        // re-queuing our own evaluation echoes as user edits.
        SuppressMaterialEditCaptureScope suppressEcho(*this);
        TimeValue t = ip->GetTime();
        INode* root = ip->GetRootNode();
        if (!root) {
            HandleFullSyncDeliveryFailure();
            return false;
        }
        const std::uint32_t frameId = AllocateFrameId();

        std::unordered_set<ULONG> prevGeom = std::move(geomHandles_);
        geomHandles_.clear();
        skinnedHandles_.clear();
        lightHandles_.clear();
        audioHandles_.clear();
        gltfHandles_.clear();
        webappHandles_.clear();
        hairHandles_.clear();
        helperHandles_.clear();
        deformHandles_.clear();
        pointInstanceHandles_.clear();
        ClearMaterialEditHandleCache();
        lastSentTransforms_.clear();
        lastProbeGridSig_.clear(); // resend probe grids on every full sync (covers viewer reload)

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"scene\",\"frame\":" << frameId << L",\"nodes\":[";
        bool first = true;
        MaterialLibraryBuilder materialLibrary;
        std::unordered_set<ULONG> cameraLightCarriers;
        CollectLiveCameraLightCarriers(root, t, cameraLightCarriers);
        WriteSceneNodes(root, t, ss, first, prevGeom, cameraLightCarriers, materialLibrary);
        PruneFastDeformState();
        ss << L"],";
        WriteMaterialLibraryJson(ss, materialLibrary);
        ss << L",";

        // Camera + scene camera list
        WriteCameraJson(ss);
        ss << L",";
        WriteSceneCamerasJson(ss);

        // Environment
        EnvData envData;
        GetEnvironment(envData);
        std::wstring hdriUrl;
        if (!envData.isSky && !envData.hdriPath.empty())
            hdriUrl = MapTexturePath(envData.hdriPath);

        ss << L",";
        WriteEnvJson(ss, envData, hdriUrl);

        ss << L",";
        WriteLightsJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteAudiosJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteGLTFsJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteWebAppsJson(ss, ip, t, true, false, true);

        // ForestPack + RailClone instance groups (GPU instancing)
        {
            std::vector<ForestInstanceGroup> allInstGroups;
            std::function<void(INode*)> collectInstances = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE)) {
                        collectInstances(node);
                        continue;
                    }
                    if (IsMaxJsSyncDrawVisible(node)) {
                        if (IsForestPackAvailable() && IsForestPackNode(node))
                            ExtractForestPackInstances(node, t, allInstGroups);
                        else if (IsRailCloneAvailable() && IsRailCloneNode(node))
                            ExtractRailCloneInstances(node, t, allInstGroups);
                        else if (IsTyFlowAvailable() && IsTyFlowNode(node))
                            ExtractTyFlowInstances(node, t, allInstGroups);
                        else if (SupportsRenderTimeInstancing(node, t))
                            ExtractRenderTimeInstances(node, t, allInstGroups);
                    }
                    collectInstances(node);
                }
            };
            collectInstances(root);
            if (!allInstGroups.empty()) {
                ss << L",\"forestInstances\":[";
                bool firstGrp = true;
                for (auto& grp : allInstGroups) {
                    if (grp.verts.empty() || grp.transforms.empty()) continue;
                    if (!firstGrp) ss << L',';
                    firstGrp = false;
                    ss << L"{\"src\":" << grp.groupKey;
                    ss << L",\"kind\":\"" << InstanceGroupKindName(grp.kind) << L"\"";
                    ss << L",\"key\":\"" << InstanceGroupKindName(grp.kind) << L":" << grp.ownerKey << L":" << grp.groupKey << L"\"";
                    ss << L",\"count\":" << grp.instanceCount;
                    ss << L",\"v\":"; WriteFloats(ss, grp.verts.data(), grp.verts.size());
                    ss << L",\"i\":"; WriteInts(ss, grp.indices.data(), grp.indices.size());
                    if (!grp.uvs.empty()) {
                        ss << L",\"uv\":"; WriteFloats(ss, grp.uvs.data(), grp.uvs.size());
                    }
                    if (!grp.norms.empty()) {
                        ss << L",\"norm\":"; WriteFloats(ss, grp.norms.data(), grp.norms.size());
                    }
                    ss << L",\"xforms\":";
                    WriteFloats(ss, grp.transforms.data(), grp.transforms.size());
                    WriteInstanceGroupMaterial(ss, grp, t);
                    ss << L'}';
                }
                ss << L']';
            }
        }
        WriteHairInstanceGroupsJson(ss, root, t);

        // TODO: tyFlow volume rendering (smoke/fire) — disabled pending shader fixes
        if (false && IsTyFlowAvailable()) {
            std::vector<VolumeData> volumes;
            std::function<void(INode*)> collectVolumes = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (IsTyFlowNode(node))
                        ExtractTyFlowVolumes(node, t, volumes);
                    collectVolumes(node);
                }
            };
            collectVolumes(root);
            if (!volumes.empty()) {
                ss << L",\"volumes\":[";
                for (size_t vi = 0; vi < volumes.size(); vi++) {
                    if (vi) ss << L',';
                    auto& vd = volumes[vi];
                    ss << L"{\"h\":" << vd.handle;
                    ss << L",\"dim\":[" << vd.dimX << L',' << vd.dimY << L',' << vd.dimZ << L']';
                    ss << L",\"voxSize\":[";
                    WriteFloats(ss, vd.voxelSize, 3);
                    ss << L"],\"origin\":[";
                    WriteFloats(ss, vd.origin, 3);
                    ss << L"],\"tm\":";
                    WriteFloats(ss, vd.transform, 16);
                    ss << L",\"step\":" << vd.stepSize;
                    ss << L",\"density\":";
                    WriteFloats(ss, vd.density.data(), vd.density.size());
                    ss << L'}';
                }
                ss << L']';
            }
        }

        ss << L'}';

        const HRESULT scenePostResult = webview_->PostWebMessageAsJson(ss.str().c_str());
        if (FAILED(scenePostResult)) {
            HandleFullSyncDeliveryFailure();
            return false;
        }
        ClearPendingDeformNormalRefresh();
        ClearGeometryFastFlushQueue();
        fullSyncRetryNotBeforeTick_ = 0;
        SendProbeGridSync();
        SendRenderOutputSettings(true);
        ResetFastPathState(true);
        CapturePlaybackDeliveredStateAtTime(t);
        return true;
    }

    void WriteSceneNodes(INode* parent, TimeValue t,
                         std::wostringstream& ss, bool& first,
                         const std::unordered_set<ULONG>& prevGeom,
                         const std::unordered_set<ULONG>& cameraLightCarriers,
                         MaterialLibraryBuilder& materialLibrary) {
        for (int i = 0; i < parent->NumberOfChildren(); i++) {
            INode* node = parent->GetChildNode(i);
            if (!node) continue;
            ObjectState os = node->EvalWorldState(t);
            if (os.obj && (IsThreeJSAudioClassID(os.obj->ClassID()) || IsThreeJSGLTFClassID(os.obj->ClassID()) || IsThreeJSWebAppClassID(os.obj->ClassID()))) {
                WriteSceneNodes(node, t, ss, first, prevGeom, cameraLightCarriers, materialLibrary);
                continue;
            }
            // Skip Forest Pack / ForestIvy / RailClone / tyFlow / native
            // RenderTimeInstancing producers — handled via GPU instancing
            if (IsForestPackNode(node) || IsRailCloneNode(node) ||
                (IsTyFlowAvailable() && IsTyFlowNode(node)) ||
                SupportsRenderTimeInstancing(node, t)) {
                WriteSceneNodes(node, t, ss, first, prevGeom, cameraLightCarriers, materialLibrary);
                continue;
            }

            ULONG handle = node->GetHandle();
            const bool cameraLightCarrier =
                cameraLightCarriers.find(handle) != cameraLightCarriers.end();
            // Cameras normally ship as view metadata. Mirror only those that
            // actually carry a max.js light, as transform-only Object3Ds, so
            // the child rides its parent without adding work for other cameras.
            if (IsMaxJSHierarchyNode(node, t) || cameraLightCarrier) {
                float xform[16]; GetTransform16(node, t, xform);
                if (!first) ss << L',';
                ss << L"{\"h\":" << handle;
                ss << L",\"n\":\"" << EscapeJson(node->GetName()) << L'"';
                ss << L",\"helper\":true";
                // Group heads are flagged so the viewer's Flatten Groups pass
                // can target actual Max groups and not generic helper parents.
                if (node->IsGroupHead()) ss << L",\"grp\":1";
                if (cameraLightCarrier) ss << L",\"lightCarrier\":true";
                ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
                ss << L",\"vis\":" << (IsMaxJsSyncDrawVisible(node) ? L'1' : L'0');
                WriteNodeParentJson(ss, node);
                WriteUserPropsJson(ss, node);
                ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                ss << L'}';
                first = false;
                helperHandles_.insert(handle);
                RememberSentTransform(handle, xform);
                WriteSceneNodes(node, t, ss, first, prevGeom, cameraLightCarriers, materialLibrary);
                continue;
            }
            // Hidden render nodes are skipped, but their helper/group parents
            // above still stay in sync as transform-only hierarchy carriers.
            if (node->IsNodeHidden(TRUE)) {
                WriteSceneNodes(node, t, ss, first, prevGeom, cameraLightCarriers, materialLibrary);
                continue;
            }
            // Skip expensive ExtractMesh for previously-tracked nodes with unchanged geometry
            bool skipExtract = false;
            if (prevGeom.count(handle) && geoHashMap_.count(handle)) {
                if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                    Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                    uint64_t validKey = MakeGeomValidityKey(gv);
                    auto bboxIt = lastBBoxHash_.find(handle);
                    if (bboxIt != lastBBoxHash_.end() && bboxIt->second == validKey) {
                        skipExtract = true;
                    }
                    lastBBoxHash_[handle] = validKey;
                }
            }

            // A multi/sub-object node with no cached face groups would fall through
            // to the single-material emit in the skip-extract branch below and
            // collapse every face onto slot 0 ("instanced objects lose their
            // material IDs"). A material-structure delta can drop groupCache_ while
            // the geometry still hashes as unchanged (geoHashMap_/bbox repopulated
            // by a later geometry tick before this full sync runs), so the test
            // above can't see the gap. Force a re-extract for that case so the face
            // groups are recomputed instead of silently downgrading to one material.
            if (skipExtract && !groupCache_.count(handle)) {
                Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                if (multiMtl && multiMtl->NumSubMtls() > 0) skipExtract = false;
            }

            if (skipExtract) {
                // Geometry unchanged — send node with transform + material, no geometry data.
                // JS side keeps existing BufferGeometry when v/i fields are absent.
                float xform[16]; GetTransform16(node, t, xform);

                if (!first) ss << L',';
                ss << L"{\"h\":" << handle;
                ss << L",\"n\":\"" << EscapeJson(node->GetName()) << L'"';
                ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
                WriteNodeParentJson(ss, node);
                ss << L",\"props\":{"; WriteNodePropsJson(ss, node, t); ss << L'}';
                { JsModData jm; GetJsModData(node, t, jm); if (jm.found) { ss << L","; WriteJsModJson(ss, jm); } }
                WriteUserPropsJson(ss, node);
                ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                RememberSentTransform(handle, xform);

                auto cachedGroups = groupCache_.find(handle);
                Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                if (cachedGroups != groupCache_.end() && ShouldEmitMultiSubMaterialGroups(multiMtl, cachedGroups->second)) {
                    ss << L",\"groups\":[";
                    for (size_t g = 0; g < cachedGroups->second.size(); g++) {
                        if (g) ss << L',';
                        ss << L'[' << cachedGroups->second[g].start << L',' << cachedGroups->second[g].count << L',' << g << L']';
                    }
                    ss << L"],\"matRefs\":[";
                    for (size_t g = 0; g < cachedGroups->second.size(); g++) {
                        if (g) ss << L',';
                        Mtl* subMtl = GetSubMtlFromMatID(multiMtl, cachedGroups->second[g].matID);
                        MaxJSPBR subPBR;
                        ExtractPBRFromMtl(subMtl, node, t, subPBR);
                        ss << InternMaterial(materialLibrary, subPBR);
                    }
                    ss << L"]";
                } else {
                    MaxJSPBR pbr;
                    ExtractPBR(node, t, pbr);
                    ss << L",\"matRef\":" << InternMaterial(materialLibrary, pbr);
                }

                ss << L'}';
                first = false;
                geomHandles_.insert(handle);
                if (FindModifierOnNode(node, SKIN_CLASSID)) skinnedHandles_.insert(handle);
                if (NodeHasPointInstanceStack(node)) pointInstanceHandles_.insert(handle);
                else pointInstanceHandles_.erase(handle);
                if (NodeHasModifierStack(node) && !pointInstanceHandles_.count(handle))
                    deformHandles_.insert(handle);
                else deformHandles_.erase(handle);
            } else {
                std::vector<float> verts, uvs, uv2s, norms;
                std::vector<VertexColorAttributeRecord> vertexColors;
                std::vector<int> indices;
                std::vector<MatGroup> groups;
                const bool isSkinned = FindModifierOnNode(node, SKIN_CLASSID) != nullptr;
                const bool hasModifierStack = NodeHasModifierStack(node);
                const bool isPointInstanceStack = NodeHasPointInstanceStack(node);
                if (isPointInstanceStack) pointInstanceHandles_.insert(handle);
                else pointInstanceHandles_.erase(handle);
                std::vector<int> controlIdx;
                std::vector<FastVertexSource> fastSources;
                // Always capture the control-vertex mapping — any topology-
                // stable deforming modifier (Skin, Path Deform, Bend, FFD, etc.)
                // can then route through the fast-positions path instead of
                // the full ExtractMesh (smaller payload, single EvalWorldState).
                FastDeformTopoEpoch fastEpoch;
                FastNormalPlan fastNormalPlan;
                bool extracted = ExtractMesh(
                    node, t, verts, uvs, indices, groups,
                    &norms, &controlIdx, &vertexColors, &fastSources, &uv2s,
                    true, &fastEpoch,
                    (isSkinned || hasModifierStack) ? &fastNormalPlan : nullptr);

                // Spline fallback — extract as line geometry
                bool isSpline = false;
                if (!extracted && ShouldExtractRenderableShape(node, t, &os)) {
                    extracted = ExtractSpline(node, t, verts, indices);
                    isSpline = extracted;
                    if (extracted) {
                        uv2s.clear();
                        vertexColors.clear();
                    }
                }

                if (extracted) {
                    float xform[16]; GetTransform16(node, t, xform);

                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        lastBBoxHash_[handle] = MakeGeomValidityKey(gv);
                    }
                    groupCache_[handle] = groups;
                    if (isSkinned) skinnedHandles_.insert(handle);
                    if (!isSpline && controlIdx.size() * 3 == verts.size() && fastEpoch.valid) {
                        skinnedControlIdxCache_[handle] = std::move(controlIdx);
                        const bool haveFastSources = fastSources.size() * 3 == verts.size();
                        if (haveFastSources)
                            skinnedFastSourceCache_[handle] = std::move(fastSources);
                        else
                            skinnedFastSourceCache_.erase(handle);
                        FastDeformGuard& guard = fastDeformGuardMap_[handle];
                        guard.epoch = fastEpoch;
                        const bool haveBuiltFastNormalPlan =
                            haveFastSources && fastNormalPlan.built;
                        guard.plan = haveBuiltFastNormalPlan
                            ? std::move(fastNormalPlan)
                            : FastNormalPlan{};
                        // If this mesh has a modifier stack it can deform without
                        // firing a node event (e.g. Path Deform driven by time).
                        // Mark it for per-frame polling so playback catches it
                        // without waiting for the idle geometry detector.
                        if (hasModifierStack && !isPointInstanceStack) {
                            deformHandles_.insert(handle);
                        } else {
                            deformHandles_.erase(handle);
                        }
                    } else {
                        EraseFastDeformReplayState(handle);
                        deformHandles_.erase(handle);
                    }

                    if (!first) ss << L',';
                    ss << L"{\"h\":" << handle;
                    ss << L",\"n\":\"" << EscapeJson(node->GetName()) << L'"';
                    ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
                    WriteNodeParentJson(ss, node);
                    ss << L",\"props\":{"; WriteNodePropsJson(ss, node, t); ss << L'}';
                    { JsModData jm; GetJsModData(node, t, jm); if (jm.found) { ss << L","; WriteJsModJson(ss, jm); } }
                    WriteUserPropsJson(ss, node);
                    ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                    if (isSpline) ss << L",\"spline\":true";
                    RememberSentTransform(handle, xform);
                    ss << L",\"v\":"; WriteFloats(ss, verts.data(), verts.size());
                    ss << L",\"i\":"; WriteInts(ss, indices.data(), indices.size());
                    if (!uvs.empty()) {
                        ss << L",\"uv\":"; WriteFloats(ss, uvs.data(), uvs.size());
                    }
                    if (!uv2s.empty()) {
                        ss << L",\"uv2\":"; WriteFloats(ss, uv2s.data(), uv2s.size());
                    }
                    if (!norms.empty()) {
                        ss << L",\"norm\":"; WriteFloats(ss, norms.data(), norms.size());
                    }
                    WriteVertexColorAttributesJson(ss, vertexColors);

                    // Multi/Sub material support. Spline extraction has no
                    // face groups, so it naturally takes the single matRef path.
                    Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                    if (ShouldEmitMultiSubMaterialGroups(multiMtl, groups)) {
                        ss << L",\"groups\":[";
                        for (size_t g = 0; g < groups.size(); g++) {
                            if (g) ss << L',';
                            ss << L'[' << groups[g].start << L',' << groups[g].count << L',' << g << L']';
                        }
                        ss << L"],\"matRefs\":[";
                        for (size_t g = 0; g < groups.size(); g++) {
                            if (g) ss << L',';
                            Mtl* subMtl = GetSubMtlFromMatID(multiMtl, groups[g].matID);
                            MaxJSPBR subPBR;
                            ExtractPBRFromMtl(subMtl, node, t, subPBR);
                            ss << InternMaterial(materialLibrary, subPBR);
                        }
                        ss << L"]";
                    } else {
                        MaxJSPBR pbr;
                        ExtractPBR(node, t, pbr);
                        ss << L",\"matRef\":" << InternMaterial(materialLibrary, pbr);
                    }

                    ss << L'}';
                    first = false;
                    geomHandles_.insert(handle);
                    if (FindModifierOnNode(node, SKIN_CLASSID)) skinnedHandles_.insert(handle);
                }
            }

            WriteSceneNodes(node, t, ss, first, prevGeom, cameraLightCarriers, materialLibrary);
        }
    }

    // ── Binary scene sync via SharedBuffer ─────────────────

    bool SendFullSyncBinary() {
        Interface* ip = GetCOREInterface();
        if (!ip || !webview_ || !env_) {
            HandleFullSyncDeliveryFailure();
            return false;
        }
        // Same echo suppression as SendFullSync.
        SuppressMaterialEditCaptureScope suppressEcho(*this);
        TimeValue t = ip->GetTime();
        INode* root = ip->GetRootNode();
        if (!root) {
            HandleFullSyncDeliveryFailure();
            return false;
        }
        const std::uint32_t frameId = AllocateFrameId();

        ComPtr<ICoreWebView2_17> wv17;
        ComPtr<ICoreWebView2Environment12> env12;
        webview_->QueryInterface(IID_PPV_ARGS(&wv17));
        env_->QueryInterface(IID_PPV_ARGS(&env12));
        if (!wv17 || !env12) return SendFullSync();

        // Save previous tracking so we can skip extraction for unchanged nodes
        std::unordered_set<ULONG> prevGeom = std::move(geomHandles_);
        ClearMaterialEditHandleCache();
        geomHandles_.clear();
        skinnedHandles_.clear();
        lightHandles_.clear();
        audioHandles_.clear();
        gltfHandles_.clear();
        webappHandles_.clear();
        hairHandles_.clear();
        helperHandles_.clear();
        deformHandles_.clear();
        pointInstanceHandles_.clear();
        lastSentTransforms_.clear();
        lastProbeGridSig_.clear(); // resend probe grids on every (binary) full sync

        // Collect all geometry nodes
        struct NodeGeo {
            ULONG handle;
            INode* node;
            ULONG parentHandle = 0;
            std::vector<float> verts, uvs, uv2s, norms;
            std::vector<VertexColorAttributeRecord> vertexColors;
            std::vector<int> indices;
            std::vector<MatGroup> groups;
            bool changed;
            bool visible = true;
            bool spline = false;
            bool helper = false;
            bool groupHead = false;
            bool cameraLightCarrier = false;
            size_t vOff, iOff, uvOff, uv2Off, nOff;
            uint64_t objId = 0;      // evaluated Object* — instances share this
            ULONG instOfHandle = 0;  // 0 = owns geometry, else = shares from this handle
        };
        std::vector<NodeGeo> geos;
        size_t totalBytes = 0;
        std::unordered_set<ULONG> cameraLightCarriers;
        CollectLiveCameraLightCarriers(root, t, cameraLightCarriers);

        // Build instance groups via IInstanceMgr — maps each node handle to a canonical "source" handle.
        // All instances of the same object get the same source; only the source extracts geometry.
        std::unordered_map<ULONG, ULONG> instanceSourceMap; // handle → source handle (0 = self)
        {
            IInstanceMgr* imgr = IInstanceMgr::GetInstanceMgr();
            std::unordered_set<ULONG> visited;
            std::function<void(INode*)> buildInstMap = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    ULONG h = node->GetHandle();
                    if (!visited.insert(h).second) { buildInstMap(node); continue; }
                    if (instanceSourceMap.count(h)) { buildInstMap(node); continue; }

                    INodeTab instTab;
                    if (imgr) imgr->GetInstances(*node, instTab);
                    if (instTab.Count() > 1) {
                        // Use the first handle we *traverse* as the source. GetInstances
                        // returns group members in InstanceMgr order, which does NOT match
                        // the scene DFS order used below in collect(). If the chosen source
                        // is visited after its siblings, extractedSources is empty when
                        // they're checked and nobody ever gets instOfHandle set.
                        ULONG srcH = h;
                        for (int i = 0; i < instTab.Count(); i++) {
                            if (!instTab[i]) continue;
                            ULONG ih = instTab[i]->GetHandle();
                            instanceSourceMap[ih] = srcH;
                            visited.insert(ih);
                        }
                    }
                    buildInstMap(node);
                }
            };
            buildInstMap(root);
        }

        // Track which source handle has already been extracted
        std::unordered_set<ULONG> extractedSources;

        std::function<void(INode*)> collect = [&](INode* parent) {
            for (int i = 0; i < parent->NumberOfChildren(); i++) {
                INode* node = parent->GetChildNode(i);
                if (!node) continue;
                ObjectState os = node->EvalWorldState(t);
                if (os.obj && (IsThreeJSAudioClassID(os.obj->ClassID()) || IsThreeJSGLTFClassID(os.obj->ClassID()) || IsThreeJSWebAppClassID(os.obj->ClassID()))) {
                    collect(node);
                    continue;
                }
                // Skip Forest Pack / ForestIvy / RailClone / tyFlow / native
                // RenderTimeInstancing producers — handled via GPU instancing
                if (IsForestPackNode(node) || IsRailCloneNode(node) ||
                    (IsTyFlowAvailable() && IsTyFlowNode(node)) ||
                    SupportsRenderTimeInstancing(node, t)) {
                    collect(node);
                    continue;
                }
                const bool cameraLightCarrier =
                    cameraLightCarriers.find(node->GetHandle()) != cameraLightCarriers.end();
                if (IsMaxJSHierarchyNode(node, t) || cameraLightCarrier) {
                    NodeGeo helper = {};
                    helper.node = node;
                    helper.handle = node->GetHandle();
                    helper.parentHandle = GetMaxJSParentHandle(node);
                    helper.visible = IsMaxJsSyncDrawVisible(node);
                    helper.helper = true;
                    helper.groupHead = node->IsGroupHead();
                    helper.cameraLightCarrier = cameraLightCarrier;
                    geos.push_back(std::move(helper));
                    helperHandles_.insert(node->GetHandle());
                    collect(node);
                    continue;
                }
                NodeGeo ng;
                ng.node = node;
                ng.handle = node->GetHandle();
                ng.parentHandle = GetMaxJSParentHandle(node);
                ng.changed = false;
                ng.visible = IsMaxJsSyncDrawVisible(node);
                // Instance detection via IInstanceMgr
                auto instIt = instanceSourceMap.find(ng.handle);
                ULONG srcHandle = (instIt != instanceSourceMap.end()) ? instIt->second : 0;
                ng.objId = srcHandle; // used as instance group ID in JSON

                // Skip expensive ExtractMesh for previously-tracked nodes with unchanged geometry.
                bool skipExtract = false;
                if (prevGeom.count(ng.handle) && geoHashMap_.count(ng.handle)) {
                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        uint64_t validKey = MakeGeomValidityKey(gv);
                        auto bboxIt = lastBBoxHash_.find(ng.handle);
                        if (bboxIt != lastBBoxHash_.end() && bboxIt->second == validKey) {
                            skipExtract = true;
                        }
                        lastBBoxHash_[ng.handle] = validKey;
                    }
                }

                // A multi/sub-object node with no cached face groups must not skip
                // extraction: the skip branch would emit a single matRef and collapse
                // every face onto slot 0 ("instanced objects lose their material
                // IDs"). A material-structure delta can drop groupCache_ while a
                // later geometry tick repopulates geoHashMap_/lastBBoxHash_ before
                // this full sync runs, so the bbox test alone can't see the gap.
                // Mirror of the guard in WriteSceneNodes (the JSON writer).
                if (skipExtract && !groupCache_.count(ng.handle)) {
                    Mtl* multiMtl = FindMultiSubMtl(node->GetMtl());
                    if (multiMtl && multiMtl->NumSubMtls() > 0) skipExtract = false;
                }

                // Instance dedup: if another node in this group already extracted, skip
                if (!skipExtract && srcHandle != 0 && srcHandle != ng.handle) {
                    if (extractedSources.count(srcHandle)) {
                        ng.instOfHandle = srcHandle;
                        skipExtract = true;
                    }
                }

                if (skipExtract) {
                    auto gIt = groupCache_.find(ng.handle);
                    if (gIt != groupCache_.end()) ng.groups = gIt->second;
                    if (ng.instOfHandle != 0 && geoHashMap_.count(ng.instOfHandle)) {
                        geoHashMap_[ng.handle] = geoHashMap_[ng.instOfHandle];
                        if (deformChannelHashMap_.count(ng.instOfHandle))
                            deformChannelHashMap_[ng.handle] = deformChannelHashMap_[ng.instOfHandle];
                        if (groupCache_.count(ng.instOfHandle))
                            ng.groups = groupCache_[ng.instOfHandle];
                        if (skinnedControlIdxCache_.count(ng.instOfHandle))
                            skinnedControlIdxCache_[ng.handle] = skinnedControlIdxCache_[ng.instOfHandle];
                        if (skinnedFastSourceCache_.count(ng.instOfHandle))
                            skinnedFastSourceCache_[ng.handle] = skinnedFastSourceCache_[ng.instOfHandle];
                        if (fastDeformGuardMap_.count(ng.instOfHandle)) {
                            // Instances share topology — the epoch and the
                            // normal gather plan are both valid as-is.
                            fastDeformGuardMap_[ng.handle] = fastDeformGuardMap_[ng.instOfHandle];
                        }
                    }
                    geos.push_back(std::move(ng));
                    geomHandles_.insert(node->GetHandle());
                    if (FindModifierOnNode(node, SKIN_CLASSID)) skinnedHandles_.insert(node->GetHandle());
                    if (NodeHasPointInstanceStack(node)) pointInstanceHandles_.insert(node->GetHandle());
                    else pointInstanceHandles_.erase(node->GetHandle());
                    if (NodeHasModifierStack(node) && !pointInstanceHandles_.count(node->GetHandle()))
                        deformHandles_.insert(node->GetHandle());
                    else deformHandles_.erase(node->GetHandle());
                } else {
                    const bool isSkinned = FindModifierOnNode(node, SKIN_CLASSID) != nullptr;
                    const bool hasModifierStack = NodeHasModifierStack(node);
                    const bool isPointInstanceStack = NodeHasPointInstanceStack(node);
                    if (isPointInstanceStack) pointInstanceHandles_.insert(node->GetHandle());
                    else pointInstanceHandles_.erase(node->GetHandle());
                    std::vector<int> controlIdx;
                    std::vector<FastVertexSource> fastSources;
                    FastDeformTopoEpoch fastEpoch;
                    FastNormalPlan fastNormalPlan;
                    bool extracted = ExtractMesh(node, t, ng.verts, ng.uvs, ng.indices, ng.groups,
                        &ng.norms, &controlIdx, &ng.vertexColors, &fastSources, &ng.uv2s,
                        true, &fastEpoch,
                        (isSkinned || hasModifierStack) ? &fastNormalPlan : nullptr);
                    if (!extracted && ShouldExtractRenderableShape(node, t, &os)) {
                        extracted = ExtractSpline(node, t, ng.verts, ng.indices);
                        ng.spline = extracted;
                        if (extracted) {
                            ng.uvs.clear();
                            ng.uv2s.clear();
                            ng.norms.clear();
                            ng.vertexColors.clear();
                            ng.groups.clear();
                        }
                    }
                    if (!extracted) {
                        collect(node);
                        continue;
                    }

                    // Use raw hash consistent with DetectGeometryChanges
                    uint64_t hash = 0;
                    if (!TryHashRenderableGeometryState(node, t, hash))
                        hash = HashMeshData(ng.verts, ng.indices, ng.uvs, &ng.vertexColors);
                    auto it = geoHashMap_.find(ng.handle);
                    ng.changed = (it == geoHashMap_.end() || it->second != hash);
                    geoHashMap_[ng.handle] = hash;
                    uint64_t channelHash = 0;
                    if (TryHashRenderableGeometryChannels(node, t, channelHash))
                        deformChannelHashMap_[ng.handle] = channelHash;
                    else
                        deformChannelHashMap_.erase(ng.handle);
                    groupCache_[ng.handle] = ng.groups;

                    if (os.obj && os.obj->SuperClassID() == GEOMOBJECT_CLASS_ID) {
                        Interval gv = os.obj->ChannelValidity(t, GEOM_CHAN_NUM);
                        lastBBoxHash_[ng.handle] = MakeGeomValidityKey(gv);
                    }
                    if (isSkinned) skinnedHandles_.insert(node->GetHandle());
                    if (!ng.spline && controlIdx.size() * 3 == ng.verts.size() && fastEpoch.valid) {
                        skinnedControlIdxCache_[ng.handle] = std::move(controlIdx);
                        const bool haveFastSources = fastSources.size() * 3 == ng.verts.size();
                        if (haveFastSources)
                            skinnedFastSourceCache_[ng.handle] = std::move(fastSources);
                        else
                            skinnedFastSourceCache_.erase(ng.handle);
                        FastDeformGuard& guard = fastDeformGuardMap_[ng.handle];
                        guard.epoch = fastEpoch;
                        const bool haveBuiltFastNormalPlan =
                            haveFastSources && fastNormalPlan.built;
                        guard.plan = haveBuiltFastNormalPlan
                            ? std::move(fastNormalPlan)
                            : FastNormalPlan{};
                        if (hasModifierStack && !isPointInstanceStack) {
                            deformHandles_.insert(ng.handle);
                        } else {
                            deformHandles_.erase(ng.handle);
                        }
                    } else {
                        EraseFastDeformReplayState(ng.handle);
                        deformHandles_.erase(ng.handle);
                    }

                    if (srcHandle != 0) extractedSources.insert(srcHandle);

                    if (ng.changed) {
                        ng.vOff = totalBytes;
                        totalBytes += ng.verts.size() * sizeof(float);
                        ng.iOff = totalBytes;
                        totalBytes += ng.indices.size() * sizeof(int);
                        ng.uvOff = totalBytes;
                        if (!ng.uvs.empty())
                            totalBytes += ng.uvs.size() * sizeof(float);
                        ng.uv2Off = totalBytes;
                        if (!ng.uv2s.empty())
                            totalBytes += ng.uv2s.size() * sizeof(float);
                        ng.nOff = totalBytes;
                        if (!ng.norms.empty())
                            totalBytes += ng.norms.size() * sizeof(float);
                        for (VertexColorAttributeRecord& attr : ng.vertexColors) {
                            attr.off = totalBytes;
                            if (!attr.values.empty())
                                totalBytes += attr.values.size() * sizeof(float);
                        }
                    }
                    geos.push_back(std::move(ng));
                    geomHandles_.insert(node->GetHandle());
                }
                collect(node);
            }
        };
        collect(root);

        // Prevent stale hashes for deleted handles (important if handles are reused).
        for (auto it = geoHashMap_.begin(); it != geoHashMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = geoHashMap_.erase(it);
            else ++it;
        }
        for (auto it = geoFastTriangleCountMap_.begin(); it != geoFastTriangleCountMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = geoFastTriangleCountMap_.erase(it);
            else ++it;
        }
        for (auto it = mtlHashMap_.begin(); it != mtlHashMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = mtlHashMap_.erase(it);
            else ++it;
        }
        for (auto it = mtlScalarHashMap_.begin(); it != mtlScalarHashMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = mtlScalarHashMap_.erase(it);
            else ++it;
        }
        for (auto it = mtlFastScalarHashMap_.begin(); it != mtlFastScalarHashMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = mtlFastScalarHashMap_.erase(it);
            else ++it;
        }
        for (auto it = lightHashMap_.begin(); it != lightHashMap_.end(); ) {
            if (lightHandles_.find(it->first) == lightHandles_.end()) it = lightHashMap_.erase(it);
            else ++it;
        }
        for (auto it = audioHashMap_.begin(); it != audioHashMap_.end(); ) {
            if (audioHandles_.find(it->first) == audioHandles_.end()) it = audioHashMap_.erase(it);
            else ++it;
        }
        for (auto it = gltfHashMap_.begin(); it != gltfHashMap_.end(); ) {
            if (gltfHandles_.find(it->first) == gltfHandles_.end()) it = gltfHashMap_.erase(it);
            else ++it;
        }
        for (auto it = webappHashMap_.begin(); it != webappHashMap_.end(); ) {
            if (webappHandles_.find(it->first) == webappHandles_.end()) it = webappHashMap_.erase(it);
            else ++it;
        }
        for (auto it = groupCache_.begin(); it != groupCache_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = groupCache_.erase(it);
            else ++it;
        }
        for (auto it = lastBBoxHash_.begin(); it != lastBBoxHash_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = lastBBoxHash_.erase(it);
            else ++it;
        }
        for (auto it = lastLiveGeomHash_.begin(); it != lastLiveGeomHash_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = lastLiveGeomHash_.erase(it);
            else ++it;
        }
        for (auto it = deformChannelHashMap_.begin(); it != deformChannelHashMap_.end(); ) {
            if (geomHandles_.find(it->first) == geomHandles_.end()) it = deformChannelHashMap_.erase(it);
            else ++it;
        }
        PruneFastDeformState();

        // Create shared buffer
        if (totalBytes == 0) totalBytes = 4;  // min size
        ComPtr<ICoreWebView2SharedBuffer> sharedBuf;
        HRESULT hr = env12->CreateSharedBuffer(totalBytes, &sharedBuf);
        if (FAILED(hr) || !sharedBuf) {
            // Collection above has already advanced producer caches. A JSON
            // fallback at this point could treat those unsent values as the
            // viewer baseline and omit geometry, so retry from an invalidated
            // full-sync epoch instead.
            HandleFullSyncDeliveryFailure();
            return false;
        }

        BYTE* bufPtr = nullptr;
        const HRESULT bufferResult = sharedBuf->get_Buffer(&bufPtr);
        if (FAILED(bufferResult) || !bufPtr) {
            HandleFullSyncDeliveryFailure();
            return false;
        }

        // Build metadata JSON + copy geometry into buffer
        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        MaterialLibraryBuilder materialLibrary;
        ss << L"{\"type\":\"scene_bin\",\"frame\":" << frameId;
        ss << L",\"format\":\"m3\",\"formatVersion\":1,\"schemaVersion\":1";
        ss << L",\"units\":{\"label\":\"cm\",\"metersPerUnit\":0.01}";
        ss << L",\"stats\":{\"producerBytes\":" << totalBytes << L"}";
        ss << L",\"nodes\":[";
        bool first = true;

        for (auto& ng : geos) {
            float xform[16]; GetTransform16(ng.node, t, xform);
            RememberSentTransform(ng.handle, xform);

            if (!first) ss << L',';
            ss << L"{\"h\":" << ng.handle;
            ss << L",\"n\":\"" << EscapeJson(ng.node->GetName()) << L'"';
            ss << L",\"s\":" << (ng.node->Selected() ? L'1' : L'0');
            if (ng.parentHandle != 0) ss << L",\"p\":" << ng.parentHandle;
            if (ng.helper) {
                ss << L",\"helper\":true";
                if (ng.groupHead) ss << L",\"grp\":1";
                if (ng.cameraLightCarrier) ss << L",\"lightCarrier\":true";
                WriteUserPropsJson(ss, ng.node);
                ss << L",\"vis\":" << (ng.visible ? L'1' : L'0');
                ss << L",\"t\":"; WriteFloats(ss, xform, 16);
                ss << L'}';
                first = false;
                continue;
            }
            MaxJSPBR pbr; ExtractPBR(ng.node, t, pbr);
            ss << L",\"props\":{"; WriteNodePropsJson(ss, ng.node, t); ss << L'}';
            { JsModData jm; GetJsModData(ng.node, t, jm); if (jm.found) { ss << L","; WriteJsModJson(ss, jm); } }
            WriteUserPropsJson(ss, ng.node);
            ss << L",\"vis\":" << (ng.visible ? L'1' : L'0');
            if (ng.objId != 0) ss << L",\"objId\":" << ng.objId;
            if (ng.instOfHandle != 0) ss << L",\"instOf\":" << ng.instOfHandle;
            ss << L",\"t\":"; WriteFloats(ss, xform, 16);
            if (ng.spline) ss << L",\"spline\":true";

            // Geometry: byte offsets into shared buffer (or -1 if unchanged)
            if (ng.changed) {
                StreamCopyBytes(bufPtr + ng.vOff, ng.verts.data(), ng.verts.size() * sizeof(float));
                StreamCopyBytes(bufPtr + ng.iOff, ng.indices.data(), ng.indices.size() * sizeof(int));
                if (!ng.uvs.empty())
                    StreamCopyBytes(bufPtr + ng.uvOff, ng.uvs.data(), ng.uvs.size() * sizeof(float));
                if (!ng.uv2s.empty())
                    StreamCopyBytes(bufPtr + ng.uv2Off, ng.uv2s.data(), ng.uv2s.size() * sizeof(float));
                if (!ng.norms.empty())
                    StreamCopyBytes(bufPtr + ng.nOff, ng.norms.data(), ng.norms.size() * sizeof(float));
                for (const VertexColorAttributeRecord& attr : ng.vertexColors) {
                    if (!attr.values.empty()) {
                        StreamCopyBytes(bufPtr + attr.off, attr.values.data(), attr.values.size() * sizeof(float));
                    }
                }

                ss << L",\"geo\":{\"vOff\":" << ng.vOff;
                ss << L",\"vN\":" << ng.verts.size();
                ss << L",\"iOff\":" << ng.iOff;
                ss << L",\"iN\":" << ng.indices.size();
                if (!ng.uvs.empty()) {
                    ss << L",\"uvOff\":" << ng.uvOff;
                    ss << L",\"uvN\":" << ng.uvs.size();
                }
                if (!ng.uv2s.empty()) {
                    ss << L",\"uv2Off\":" << ng.uv2Off;
                    ss << L",\"uv2N\":" << ng.uv2s.size();
                }
                if (!ng.norms.empty()) {
                    ss << L",\"nOff\":" << ng.nOff;
                    ss << L",\"nN\":" << ng.norms.size();
                }
                WriteVertexColorOffsetsJson(ss, ng.vertexColors);
                ss << L'}';
            }

            // Multi/Sub material support
            Mtl* multiMtl = FindMultiSubMtl(ng.node->GetMtl());
            if (ShouldEmitMultiSubMaterialGroups(multiMtl, ng.groups)) {
                ss << L",\"groups\":[";
                for (size_t g = 0; g < ng.groups.size(); g++) {
                    if (g) ss << L',';
                    ss << L'[' << ng.groups[g].start << L',' << ng.groups[g].count << L',' << g << L']';
                }
                ss << L"],\"matRefs\":[";
                for (size_t g = 0; g < ng.groups.size(); g++) {
                    if (g) ss << L',';
                    Mtl* subMtl = GetSubMtlFromMatID(multiMtl, ng.groups[g].matID);
                    MaxJSPBR subPBR;
                    ExtractPBRFromMtl(subMtl, ng.node, t, subPBR);
                    ss << InternMaterial(materialLibrary, subPBR);
                }
                ss << L"]";
            } else {
                ss << L",\"matRef\":" << InternMaterial(materialLibrary, pbr);
            }

            ss << L'}';  // node
            first = false;
        }

        ss << L"],";
        WriteMaterialLibraryJson(ss, materialLibrary);
        ss << L",";
        WriteCameraJson(ss);

        // Environment
        EnvData envData; GetEnvironment(envData);
        std::wstring hdriUrl;
        if (!envData.isSky && !envData.hdriPath.empty())
            hdriUrl = MapTexturePath(envData.hdriPath);

        ss << L",";
        WriteEnvJson(ss, envData, hdriUrl);
        ss << L",";
        WriteLightsJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteAudiosJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteGLTFsJson(ss, ip, t, true, false, true);
        ss << L",";
        WriteWebAppsJson(ss, ip, t, true, false, true);

        // ForestPack + RailClone instance groups (GPU instancing)
        {
            std::vector<ForestInstanceGroup> allInstGroups;
            std::function<void(INode*)> collectInstances = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (node->IsNodeHidden(TRUE)) {
                        collectInstances(node);
                        continue;
                    }
                    if (IsMaxJsSyncDrawVisible(node)) {
                        if (IsForestPackAvailable() && IsForestPackNode(node))
                            ExtractForestPackInstances(node, t, allInstGroups);
                        else if (IsRailCloneAvailable() && IsRailCloneNode(node))
                            ExtractRailCloneInstances(node, t, allInstGroups);
                        else if (IsTyFlowAvailable() && IsTyFlowNode(node))
                            ExtractTyFlowInstances(node, t, allInstGroups);
                        else if (SupportsRenderTimeInstancing(node, t))
                            ExtractRenderTimeInstances(node, t, allInstGroups);
                    }
                    collectInstances(node);
                }
            };
            collectInstances(root);

            if (!allInstGroups.empty()) {
                ss << L",\"forestInstances\":[";
                bool firstGrp = true;
                for (auto& grp : allInstGroups) {
                    if (grp.verts.empty() || grp.transforms.empty()) continue;
                    if (!firstGrp) ss << L',';
                    firstGrp = false;

                    ss << L"{\"src\":" << grp.groupKey;
                    ss << L",\"kind\":\"" << InstanceGroupKindName(grp.kind) << L"\"";
                    ss << L",\"key\":\"" << InstanceGroupKindName(grp.kind) << L":" << grp.ownerKey << L":" << grp.groupKey << L"\"";
                    ss << L",\"count\":" << grp.instanceCount;
                    ss << L",\"v\":"; WriteFloats(ss, grp.verts.data(), grp.verts.size());
                    ss << L",\"i\":"; WriteInts(ss, grp.indices.data(), grp.indices.size());
                    if (!grp.uvs.empty()) {
                        ss << L",\"uv\":"; WriteFloats(ss, grp.uvs.data(), grp.uvs.size());
                    }
                    if (!grp.norms.empty()) {
                        ss << L",\"norm\":"; WriteFloats(ss, grp.norms.data(), grp.norms.size());
                    }
                    ss << L",\"xforms\":";
                    WriteFloats(ss, grp.transforms.data(), grp.transforms.size());
                    WriteInstanceGroupMaterial(ss, grp, t);
                    ss << L'}';
                }
                ss << L']';
            }
        }
        WriteHairInstanceGroupsJson(ss, root, t);

        // TODO: tyFlow volume rendering (smoke/fire) — disabled pending shader fixes
        if (false && IsTyFlowAvailable()) {
            std::vector<VolumeData> volumes;
            std::function<void(INode*)> collectVolumes = [&](INode* parent) {
                for (int c = 0; c < parent->NumberOfChildren(); c++) {
                    INode* node = parent->GetChildNode(c);
                    if (!node) continue;
                    if (IsTyFlowNode(node))
                        ExtractTyFlowVolumes(node, t, volumes);
                    collectVolumes(node);
                }
            };
            collectVolumes(root);
            if (!volumes.empty()) {
                ss << L",\"volumes\":[";
                for (size_t vi = 0; vi < volumes.size(); vi++) {
                    if (vi) ss << L',';
                    auto& vd = volumes[vi];
                    ss << L"{\"h\":" << vd.handle;
                    ss << L",\"dim\":[" << vd.dimX << L',' << vd.dimY << L',' << vd.dimZ << L']';
                    ss << L",\"voxSize\":";
                    WriteFloats(ss, vd.voxelSize, 3);
                    ss << L",\"origin\":";
                    WriteFloats(ss, vd.origin, 3);
                    ss << L",\"tm\":";
                    WriteFloats(ss, vd.transform, 16);
                    ss << L",\"step\":" << vd.stepSize;
                    ss << L",\"density\":";
                    WriteFloats(ss, vd.density.data(), vd.density.size());
                    ss << L'}';
                }
                ss << L']';
            }
        }

        ss << L",";
        WriteSceneCamerasJson(ss);
        ss << L'}';

        const HRESULT scenePostResult = wv17->PostSharedBufferToScript(sharedBuf.Get(),
            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
            ss.str().c_str());
        if (FAILED(scenePostResult)) {
            HandleFullSyncDeliveryFailure();
            return false;
        }
        ClearPendingDeformNormalRefresh();
        ClearGeometryFastFlushQueue();
        fullSyncRetryNotBeforeTick_ = 0;
        SendProbeGridSync();
        SendRenderOutputSettings(true);
        ResetFastPathState(true);
        CapturePlaybackDeliveredStateAtTime(t);
        return true;
    }

    // ── Transform-only sync ──────────────────────────────────

    void SendTransformSync(const std::vector<ULONG>* handles = nullptr, bool includeMaterialScalars = true) {
        if (!handles && !HasTrackedNodes()) return;
        Interface* ip = GetCOREInterface();
        if (!ip) return;
        TimeValue t = ip->GetTime();
        const std::uint32_t frameId = AllocateFrameId();

        std::vector<ULONG> scratchHandles;
        const std::vector<ULONG>* sourceHandles = handles;
        if (sourceHandles) {
            scratchHandles.assign(sourceHandles->begin(), sourceHandles->end());
            SortHandlesByHierarchyDepth(scratchHandles, ip);
            sourceHandles = &scratchHandles;
        } else {
            scratchHandles.reserve(geomHandles_.size() + helperHandles_.size());
            for (ULONG handle : helperHandles_) scratchHandles.push_back(handle);
            for (ULONG handle : geomHandles_) scratchHandles.push_back(handle);
            SortHandlesByHierarchyDepth(scratchHandles, ip);
            sourceHandles = &scratchHandles;
        }

        std::wostringstream ss;
        ss.imbue(std::locale::classic());
        ss << L"{\"type\":\"xform\",\"frame\":" << frameId << L",\"nodes\":[";
        bool first = true;
        for (ULONG handle : *sourceHandles) {
            INode* node = ip->GetINodeByHandle(handle);
            if (!node) {
                mtlHashMap_.erase(handle);
                mtlScalarHashMap_.erase(handle);
                mtlFastScalarHashMap_.erase(handle);
                lightHashMap_.erase(handle);
                audioHashMap_.erase(handle);
                gltfHashMap_.erase(handle);
                geoHashMap_.erase(handle);
                deformChannelHashMap_.erase(handle);
                EraseFastDeformState(handle);
                selectionDirtyHandles_.erase(handle);
                helperHandles_.erase(handle);
                lastSentTransforms_.erase(handle);
                continue;
            }

            const bool isHelper = helperHandles_.find(handle) != helperHandles_.end();
            if (!isHelper && geomHandles_.find(handle) == geomHandles_.end()) {
                continue;
            }
            float xform[16]; GetTransform16(node, t, xform);
            RememberSentTransform(handle, xform);

            const bool visible = IsMaxJsSyncDrawVisible(node);

            if (!first) ss << L',';
            ss << L"{\"h\":" << handle;
            ss << L",\"s\":" << (node->Selected() ? L'1' : L'0');
            ss << L",\"vis\":" << (visible ? L'1' : L'0');
            if (isHelper) {
                ss << L",\"helper\":true";
                WriteNodeParentJson(ss, node);
            } else {
                { JsModData jm; GetJsModData(node, t, jm); ss << L",\"jsmod\":" << (jm.found ? L"true" : L"false"); }
            }
            ss << L",\"t\":"; WriteFloats(ss, xform, 16);
            // For Multi/Sub objects, skip scalar material pushes to avoid
            // corrupting material arrays on the web side.
            Mtl* multiMtl = (!isHelper && includeMaterialScalars) ? FindMultiSubMtl(node->GetMtl()) : nullptr;
            if (!isHelper && includeMaterialScalars && !(multiMtl && multiMtl->NumSubMtls() > 1)) {
                float col[3] = {0.8f,0.8f,0.8f};
                float rough = 0.5f, metal = 0.0f, opac = 1.0f;
                Mtl* foundMtl = FindSupportedMaterial(node->GetMtl());
                ExtractMaterialScalarPreview(foundMtl, node, t, col, rough, metal, opac);
                ss << L",\"mat\":{\"color\":[";
                WriteFloatValue(ss, col[0], 0.8f); ss << L',';
                WriteFloatValue(ss, col[1], 0.8f); ss << L',';
                WriteFloatValue(ss, col[2], 0.8f); ss << L']';
                ss << L",\"rough\":";
                WriteFloatValue(ss, rough, 0.5f);
                ss << L",\"metal\":";
                WriteFloatValue(ss, metal, 0.0f);
                if (opac < 0.999f) {
                    ss << L",\"opacity\":";
                    WriteFloatValue(ss, opac, 1.0f);
                }
                ss << L"}";
            }
            ss << L"}";
            first = false;
        }
        ss << L"],";
        WriteCameraJson(ss);
        ss << L",";
        WriteLightsJson(ss, ip, t, true, true, true);
        ss << L",";
        WriteAudiosJson(ss, ip, t, true, true, true);
        ss << L",";
        WriteGLTFsJson(ss, ip, t, true, true, true);
        ss << L",";
        WriteWebAppsJson(ss, ip, t, true, true, true);
        ss << L'}';
        webview_->PostWebMessageAsJson(ss.str().c_str());
        SendProbeGridSync();
    }
