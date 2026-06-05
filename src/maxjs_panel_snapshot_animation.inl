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
                                         INode* localParentNode,
                                         SnapshotAnimationTargetDef& outTarget) {
        if (!node) return false;

        std::vector<TimeValue> discoveryTimes;
        const bool hasTransformAnimation =
            BuildAnimatableTimeSamples(node->GetTMController(), range, currentTime, discoveryTimes);
        const bool hasVisibilityAnimation =
            BuildAnimatableTimeSamples(node->GetVisController(), range, currentTime, discoveryTimes);
        if (!localParentNode) {
            // Only world-space targets need parent key discovery. Parented
            // snapshot nodes write local matrices, so parent motion belongs to
            // the parent track instead of being duplicated on every child.
            for (INode* parent = node->GetParentNode(); parent; parent = parent->GetParentNode()) {
                if (parent->IsRootNode()) break;
                BuildAnimatableTimeSamples(parent->GetTMController(), range, currentTime, discoveryTimes);
            }
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
            if (localParentNode) {
                float parentWorld[16];
                GetTransform16(localParentNode, sampleTime, parentWorld);
                float invParent[16];
                if (!InvertMat4CM(parentWorld, invParent))
                    Mat4IdentityCM(invParent);
                float localMatrix[16];
                MulMat4CM(invParent, matrixValues, localMatrix);
                std::copy(std::begin(localMatrix), std::end(localMatrix), matrixValues);
            }

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

    struct BinaryFloatRangeRef {
        size_t off = 0;
        size_t n = 0;
    };

    struct BinaryIndexRangeRef {
        size_t off = 0;
        size_t n = 0;
        std::wstring type;
    };

    struct GeometryFrameBinaryCache {
        std::unordered_map<std::string, BinaryFloatRangeRef> floats;
        std::unordered_map<std::string, BinaryIndexRangeRef> indices;
        std::unordered_map<std::string, BinaryIndexRangeRef> uvs;
        std::unordered_map<std::string, BinaryIndexRangeRef> normals;
    };

    static void AppendCachedGeometryFloats(std::string& binary,
                                           const std::vector<float>& values,
                                           GeometryFrameBinaryCache& cache,
                                           size_t& outOffset,
                                           size_t& outCount) {
        const std::string key = MakeRawBinaryKey(
            values.empty() ? nullptr : values.data(),
            values.size() * sizeof(float));
        if (!key.empty()) {
            auto it = cache.floats.find(key);
            if (it != cache.floats.end()) {
                outOffset = it->second.off;
                outCount = it->second.n;
                return;
            }
        }
        AppendBinaryFloats(binary, values, outOffset, outCount);
        if (!key.empty()) {
            cache.floats.emplace(key, BinaryFloatRangeRef{outOffset, outCount});
        }
    }

    static void AppendCachedGeometryIndices(std::string& binary,
                                            const std::vector<int>& values,
                                            GeometryFrameBinaryCache& cache,
                                            size_t& outOffset,
                                            size_t& outCount,
                                            std::wstring& outType) {
        const std::string key = MakeRawBinaryKey(
            values.empty() ? nullptr : values.data(),
            values.size() * sizeof(int));
        if (!key.empty()) {
            auto it = cache.indices.find(key);
            if (it != cache.indices.end()) {
                outOffset = it->second.off;
                outCount = it->second.n;
                outType = it->second.type;
                return;
            }
        }
        AppendBinaryIndices(binary, values, outOffset, outCount, outType);
        if (!key.empty()) {
            cache.indices.emplace(key, BinaryIndexRangeRef{outOffset, outCount, outType});
        }
    }

    static void AppendCachedGeometryNormals(std::string& binary,
                                            const std::vector<float>& values,
                                            GeometryFrameBinaryCache& cache,
                                            size_t& outOffset,
                                            size_t& outCount,
                                            std::wstring& outType) {
        const std::string key = MakeRawBinaryKey(
            values.empty() ? nullptr : values.data(),
            values.size() * sizeof(float));
        if (!key.empty()) {
            auto it = cache.normals.find(key);
            if (it != cache.normals.end()) {
                outOffset = it->second.off;
                outCount = it->second.n;
                outType = it->second.type;
                return;
            }
        }
        AppendBinaryNormals(binary, values, outOffset, outCount, outType);
        if (!key.empty()) {
            cache.normals.emplace(key, BinaryIndexRangeRef{outOffset, outCount, outType});
        }
    }

    static void AppendCachedGeometryUvs(std::string& binary,
                                        const std::vector<float>& values,
                                        GeometryFrameBinaryCache& cache,
                                        size_t& outOffset,
                                        size_t& outCount,
                                        std::wstring& outType) {
        const std::string key = MakeRawBinaryKey(
            values.empty() ? nullptr : values.data(),
            values.size() * sizeof(float));
        if (!key.empty()) {
            auto it = cache.uvs.find(key);
            if (it != cache.uvs.end()) {
                outOffset = it->second.off;
                outCount = it->second.n;
                outType = it->second.type;
                return;
            }
        }
        AppendBinaryUvs(binary, values, outOffset, outCount, outType);
        if (!key.empty()) {
            cache.uvs.emplace(key, BinaryIndexRangeRef{outOffset, outCount, outType});
        }
    }

    static void AppendGeometryFrame(std::string& binary,
                                    const SnapshotGeometrySample& sample,
                                    SnapshotAnimationTrackDef::GeometryFrameRef& frame,
                                    GeometryFrameBinaryCache& cache) {
        AppendCachedGeometryFloats(binary, sample.verts, cache, frame.vOff, frame.vN);
        AppendCachedGeometryIndices(binary, sample.indices, cache, frame.iOff, frame.iN, frame.iType);
        AppendCachedGeometryUvs(binary, sample.uvs, cache, frame.uvOff, frame.uvN, frame.uvType);
        AppendCachedGeometryNormals(binary, sample.norms, cache, frame.nOff, frame.nN, frame.nType);
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
        GeometryFrameBinaryCache localBinaryCache;
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
            AppendGeometryFrame(localBinary, sample, frame, localBinaryCache);
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
        if (ShouldEmitMultiSubMaterialGroups(multiMtl, nodeRecord.groups)) {
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
                if (!frame.iType.empty()) {
                    ss << L",\"iType\":\"" << frame.iType << L"\"";
                }
                if (frame.uvN > 0) {
                    ss << L",\"uvOff\":" << frame.uvOff
                       << L",\"uvN\":" << frame.uvN;
                    if (!frame.uvType.empty()) {
                        ss << L",\"uvType\":\"" << frame.uvType << L"\"";
                    }
                }
                if (frame.nN > 0) {
                    ss << L",\"nOff\":" << frame.nOff
                       << L",\"nN\":" << frame.nN;
                    if (!frame.nType.empty()) {
                        ss << L",\"nType\":\"" << frame.nType << L"\"";
                    }
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
                                                int sampleStepFrames,
                                                std::vector<TimeValue>& outTimes) {
        if (!channel) return false;
        Control* control = channel->GetControl();
        if (!control) return false;

        std::vector<TimeValue> controllerTimes;
        std::unordered_set<const Animatable*> visited;
        CollectAnimatableKeyTimesRecursive(control, range, controllerTimes, visited);
        for (TimeValue tv : controllerTimes) {
            AppendUniqueTimeValue(outTimes, tv);
        }

        if (outTimes.empty()) {
            if (control->IsAnimated() == FALSE) return false;
            AppendFrameSampleTimes(outTimes, range, sampleStepFrames);
        }

        AppendUniqueTimeValue(outTimes, range.Start());
        AppendUniqueTimeValue(outTimes, range.End());
        SortUniqueTimeValues(outTimes);
        return outTimes.size() >= 2;
    }

    static bool MorpherChannelHasKeysInRange(IMorpherChannel* channel,
                                             const Interval& range) {
        if (!channel) return false;
        Control* control = channel->GetControl();
        if (!control) return false;
        std::vector<TimeValue> keyTimes;
        std::unordered_set<const Animatable*> visited;
        CollectAnimatableKeyTimesRecursive(control, range, keyTimes, visited);
        return !keyTimes.empty();
    }

    static void PruneZeroUnkeyedMorphTargets(INode* meshNode,
                                             const Interval& range,
                                             MorphTargetSet& morphTargets) {
        if (!meshNode || morphTargets.empty()) return;

        ModifierStackMatch morphMatch;
        if (!FindModifierStackMatchOnNode(meshNode, MR3_CLASS_ID, morphMatch) ||
            !morphMatch.mod ||
            !morphMatch.mod->IsEnabled()) {
            return;
        }
        IMorpher* morpher =
            static_cast<IMorpher*>(morphMatch.mod->GetInterface(I_MORPHER_INTERFACE_ID));
        if (!morpher) return;

        constexpr float kZeroInfluenceEpsilon = 1.0e-5f;
        std::vector<MorphChannel> kept;
        kept.reserve(morphTargets.channels.size());
        for (MorphChannel& channel : morphTargets.channels) {
            const bool hasCurrentValue =
                std::isfinite(channel.influence) &&
                std::fabs(channel.influence) > kZeroInfluenceEpsilon;
            if (hasCurrentValue) {
                kept.push_back(std::move(channel));
                continue;
            }

            IMorpherChannel* maxChannel = morpher->GetChannel(channel.channelId, false);
            if (!maxChannel) {
                kept.push_back(std::move(channel));
                continue;
            }
            if (MorpherChannelHasKeysInRange(maxChannel, range)) {
                kept.push_back(std::move(channel));
            }
        }
        morphTargets.channels = std::move(kept);
    }

    // Samples a scalar animatable across sampleTimes, drops the track when it never
    // deviates from its first value (within epsilon), and emits seconds/value pairs.
    // Generic over the per-time sampler so any float source reuses the same change
    // detection + keyframe emission.
    template <typename SampleAt>
    static bool BuildSparseScalarTrack(const std::vector<TimeValue>& sampleTimes,
                                       TimeValue rangeStart,
                                       float epsilon,
                                       SampleAt&& sampleAt,
                                       std::vector<float>& outTimes,
                                       std::vector<float>& outValues) {
        if (sampleTimes.size() < 2) return false;
        std::vector<float> vals;
        vals.reserve(sampleTimes.size());
        for (TimeValue tv : sampleTimes) vals.push_back(static_cast<float>(sampleAt(tv)));
        bool changed = false;
        for (size_t i = 1; i < vals.size(); ++i) {
            if (std::fabs(vals[i] - vals[0]) > epsilon) { changed = true; break; }
        }
        if (!changed) return false;
        outTimes.clear();
        outValues.clear();
        outTimes.reserve(sampleTimes.size());
        outValues.reserve(vals.size());
        for (size_t i = 0; i < sampleTimes.size(); ++i) {
            outTimes.push_back(TimeValueToAnimationSeconds(sampleTimes[i], rangeStart));
            outValues.push_back(vals[i]);
        }
        return true;
    }

    static bool BuildMorpherInfluenceAnimationTracks(Interface* ip,
                                                     INode* meshNode,
                                                     const Interval& range,
                                                     TimeValue currentTime,
                                                     const SnapshotExportOptions& options,
                                                     const MorphTargetSet& morphTargets,
                                                     SnapshotAnimationTargetDef& outTarget) {
        (void)currentTime;
        if (!ip || !meshNode || morphTargets.empty()) return false;

        ModifierStackMatch morphMatch;
        if (!FindModifierStackMatchOnNode(meshNode, MR3_CLASS_ID, morphMatch) ||
            !morphMatch.mod ||
            !morphMatch.mod->IsEnabled()) {
            return false;
        }
        // With a Skin rig present the Morpher must evaluate before it (the order the
        // deltas were captured against); a standalone Morpher has no such constraint.
        ModifierStackMatch skinMatch;
        if (FindModifierStackMatchOnNode(meshNode, SKIN_CLASSID, skinMatch) &&
            skinMatch.mod &&
            skinMatch.mod->IsEnabled() &&
            !ModifierEvaluatesBefore(morphMatch, skinMatch)) {
            return false;
        }

        Modifier* morphMod = morphMatch.mod;
        IMorpher* morpher = static_cast<IMorpher*>(morphMod->GetInterface(I_MORPHER_INTERFACE_ID));
        if (!morpher) return false;

        bool anyTrack = false;

        // Channel order in morphTargets IS the morphTargetInfluences[] index order.
        for (size_t mi = 0; mi < morphTargets.channels.size(); ++mi) {
            IMorpherChannel* ch = morpher->GetChannel(morphTargets.channels[mi].channelId, false);
            if (!ch || !ch->IsActive()) continue;

            std::vector<TimeValue> sampleTimes;
            if (!AppendMorpherChannelTimeSamples(
                    ch, range, options.animationSampleStepFrames, sampleTimes)) {
                continue;
            }

            SnapshotAnimationTrackDef tr;
            tr.path = L".morphTargetInfluences[" + std::to_wstring(mi) + L"]";
            tr.type = L"number";
            tr.interpolation = L"linear";
            if (!BuildSparseScalarTrack(
                    sampleTimes, range.Start(), 1.0e-5f,
                    [ch](TimeValue tv) { return ReadMorpherChannelInfluence(ch, tv); },
                    tr.times, tr.values)) {
                continue;
            }
            outTarget.tracks.push_back(std::move(tr));
            anyTrack = true;
        }

        // Bind influences to this mesh. Required for morph-only meshes (no transform/
        // geometry track to seed the target), else MergeSnapshotAnimationTarget leaves
        // the target empty and the clip never resolves.
        if (anyTrack) {
            outTarget.target = L"handle:" + std::to_wstring(meshNode->GetHandle());
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
        std::unordered_map<std::wstring, SnapshotAnimationTargetDef> skinBoneTrackCache;
        std::unordered_set<std::wstring> skinBoneTrackMisses;
        std::unordered_set<ULONG> exportedNodeHandles;
        exportedNodeHandles.reserve(nodes.size());
        for (const auto& node : nodes) {
            if (node.handle != 0) exportedNodeHandles.insert(node.handle);
        }

        for (const auto& node : nodes) {
            SnapshotAnimationTargetDef target;
            SnapshotAnimationTargetDef part;
            INode* localParentNode = nullptr;
            if (node.parentHandle != 0 &&
                exportedNodeHandles.find(node.parentHandle) != exportedNodeHandles.end()) {
                localParentNode = ip->GetINodeByHandle(node.parentHandle);
            }
            if (options.includeTransformAnimation &&
                BuildNodeAnimationTarget(node.node, range, currentTime, options, localParentNode, part)) {
                MergeSnapshotAnimationTarget(target, std::move(part));
            }
            part = SnapshotAnimationTargetDef();
            if (options.includeGeometryAnimation &&
                !node.helper &&
                node.morphTargets.empty() &&  // morph meshes animate via influences, not baked vertices
                skinRigMeshHandles.find(node.handle) == skinRigMeshHandles.end() &&
                BuildNodeGeometryAnimationTarget(node.node, range, currentTime, options, part, outAnimBinary)) {
                MergeSnapshotAnimationTarget(target, std::move(part));
            }
            part = SnapshotAnimationTargetDef();
            if (options.includeMaterialAnimation &&
                !node.helper &&
                BuildNodeMaterialAnimationTarget(node, range, currentTime, options, part)) {
                MergeSnapshotAnimationTarget(target, std::move(part));
            }
            part = SnapshotAnimationTargetDef();
            if (options.includeGeometryAnimation && !node.morphTargets.empty() &&
                BuildMorpherInfluenceAnimationTracks(
                    ip, node.node, range, currentTime, options, node.morphTargets, part)) {
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

                    const ULONG parentHandle = parentNode ? parentNode->GetHandle() : 0;
                    const std::wstring cacheKey =
                        std::to_wstring(bh) + L":" + std::to_wstring(parentHandle);
                    if (skinBoneTrackMisses.find(cacheKey) != skinBoneTrackMisses.end()) {
                        skinBonesAnimated.insert(scopedKey);
                        continue;
                    }

                    auto cached = skinBoneTrackCache.find(cacheKey);
                    if (cached == skinBoneTrackCache.end()) {
                        SnapshotAnimationTargetDef sampledTarget;
                        if (BuildBoneAnimationTarget(bn, parentNode, range, currentTime, options, sampledTarget)) {
                            cached = skinBoneTrackCache.emplace(cacheKey, std::move(sampledTarget)).first;
                        } else {
                            skinBoneTrackMisses.insert(cacheKey);
                        }
                    }

                    if (cached != skinBoneTrackCache.end()) {
                        SnapshotAnimationTargetDef boneTarget = cached->second;
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
                        if (BuildNodeAnimationTarget(node, range, currentTime, options, nullptr, lightTarget)) {
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

