#pragma once

#include <max.h>
#include <gencam.h>
#include <Scene/IPhysicalCamera.h>
#include <Scene/IHairModifier.h>
#include <ISceneEventManager.h>
#include <iInstanceMgr.h>
#include <iskin.h>
#include <modstack.h>
#include <Graphics/IViewportViewSetting.h>
#include <Graphics/GraphicsEnums.h>

#include "itreesinterface.h"
#include "ircinterface.h"
#include "tyParticleObjectExt.h"
#include "tyVolumeObjectExt.h"
#include "maxjs_core_utils.h"
#include "maxjs_morpher_compat.h"
#include "maxjs_geometry_sync.h"
#include "maxjs_material_sync.h"
#include "threejs_audio.h"
#include "threejs_lights.h"
#include "threejs_splat.h"
#include "threejs_fog.h"
#include "threejs_sky.h"
#include "threejs_deform.h"
#include "threejs_gltf.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <mutex>
#include <numeric>
#include <sstream>
#include <string>
#include <unordered_set>
#include <unordered_map>
#include <vector>
#include <immintrin.h>

class MaxJSPanel;
// ══════════════════════════════════════════════════════════════
//  Transform + Color helpers
// ══════════════════════════════════════════════════════════════

static void GetTransform16(INode* node, TimeValue t, float out[16]) {
    // GetObjTMAfterWSM includes pivot offset — matches object-space vertices
    Matrix3 tm = node->GetObjTMAfterWSM(t);
    Point3 r0 = tm.GetRow(0), r1 = tm.GetRow(1), r2 = tm.GetRow(2), tr = tm.GetTrans();
    out[0]=r0.x; out[1]=r0.y; out[2]=r0.z; out[3]=0;
    out[4]=r1.x; out[5]=r1.y; out[6]=r1.z; out[7]=0;
    out[8]=r2.x; out[9]=r2.y; out[10]=r2.z; out[11]=0;
    out[12]=tr.x; out[13]=tr.y; out[14]=tr.z; out[15]=1;
}

static bool TransformEquals16(const float* a, const float* b, float epsilon = 1.0e-4f) {
    // SSE: compare 4 floats at a time (4 iterations for 16 floats)
    __m128 eps = _mm_set1_ps(epsilon);
    for (int i = 0; i < 16; i += 4) {
        __m128 va = _mm_loadu_ps(a + i);
        __m128 vb = _mm_loadu_ps(b + i);
        __m128 diff = _mm_sub_ps(va, vb);
        // abs(diff): clear sign bit
        __m128 absDiff = _mm_andnot_ps(_mm_set1_ps(-0.0f), diff);
        // if any component > epsilon, not equal
        if (_mm_movemask_ps(_mm_cmpgt_ps(absDiff, eps)) != 0)
            return false;
    }
    return true;
}

// Column-major 4x4 multiply (matches THREE.Matrix4.elements layout).
static void MulMat4CM(const float* a, const float* b, float* o) {
    for (int col = 0; col < 4; col++) {
        for (int row = 0; row < 4; row++) {
            float s = 0.0f;
            for (int k = 0; k < 4; k++)
                s += a[k * 4 + row] * b[col * 4 + k];
            o[col * 4 + row] = s;
        }
    }
}

static bool InvertMat4CM(const float m[16], float invOut[16]) {
    double inv[16], det;
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] +
             m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] -
             m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] +
             m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] -
              m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] -
             m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] +
             m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] -
             m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] +
              m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] +
             m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] -
             m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] +
              m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] -
              m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] -
             m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] +
             m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] -
              m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] +
              m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

    det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (std::fabs(det) < 1.0e-20)
        return false;
    det = 1.0 / det;
    for (int i = 0; i < 16; i++)
        invOut[i] = static_cast<float>(inv[i] * det);
    return true;
}

static void DeltaPoint3ToYUp(const Point3& d, float out[3]) {
    // Same linear map as MaxJSPanel::MaxPointToWorld for vectors (no translation).
    out[0] = d.x;
    out[1] = d.z;
    out[2] = -d.y;
}

class FindModifierOnStackEnum : public GeomPipelineEnumProc {
public:
    Class_ID cid;
    Modifier* mod = nullptr;
    explicit FindModifierOnStackEnum(Class_ID id) : cid(id) {}
    PipeEnumResult proc(ReferenceTarget* object, IDerivedObject* derObj, int index) override {
        (void)derObj;
        (void)index;
        if (object && object->ClassID() == cid) {
            mod = dynamic_cast<Modifier*>(object);
            if (mod)
                return PIPE_ENUM_STOP;
        }
        return PIPE_ENUM_CONTINUE;
    }
};

static Modifier* FindModifierOnNode(INode* node, Class_ID cid) {
    if (!node) return nullptr;
    FindModifierOnStackEnum proc(cid);
    EnumGeomPipeline(&proc, node);
    return proc.mod;
}

struct ModifierStackMatch {
    Modifier* mod = nullptr;
    int topToBottomIndex = -1;
    int derivedDepth = -1;
    int localIndex = -1;
};

static bool IsDerivedObjectForStackWalk(Object* obj) {
    return obj &&
           (obj->ClassID() == derivObjClassID ||
            obj->ClassID() == WSMDerivObjClassID ||
            obj->SuperClassID() == GEN_DERIVOB_CLASS_ID);
}

// Walks the object-space modifier stack from top to bottom. In 3ds Max's
// IDerivedObject contract, index 0 is the top/end of the pipeline and
// NumModifiers()-1 is lower/earlier in evaluation.
static bool FindModifierStackMatchOnNode(INode* node, Class_ID cid, ModifierStackMatch& out) {
    out = ModifierStackMatch();
    if (!node) return false;
    Object* cur = node->GetObjectRef();
    int linearIndex = 0;
    int derivedDepth = 0;
    while (IsDerivedObjectForStackWalk(cur)) {
        IDerivedObject* d = static_cast<IDerivedObject*>(cur);
        for (int i = 0; i < d->NumModifiers(); ++i) {
            Modifier* m = d->GetModifier(i);
            if (m && m->ClassID() == cid) {
                out.mod = m;
                out.topToBottomIndex = linearIndex;
                out.derivedDepth = derivedDepth;
                out.localIndex = i;
                return true;
            }
            linearIndex++;
        }
        cur = d->GetObjRef();
        derivedDepth++;
    }
    return false;
}

// Returns local index of the first modifier matching cid in the matching
// derived object, or -1. Kept for older call sites/debugging.
static int FindModifierStackIndexOnNode(INode* node, Class_ID cid) {
    ModifierStackMatch match;
    return FindModifierStackMatchOnNode(node, cid, match) ? match.localIndex : -1;
}

static bool ModifierEvaluatesBefore(const ModifierStackMatch& earlier,
                                    const ModifierStackMatch& later) {
    return earlier.topToBottomIndex >= 0 &&
           later.topToBottomIndex >= 0 &&
           earlier.topToBottomIndex > later.topToBottomIndex;
}

static void RestoreModifierEnabled(Modifier* mod, int wasEnabled) {
    if (!mod) return;
    if (wasEnabled) mod->EnableMod();
    else mod->DisableMod();
}

static float ReadMorpherChannelInfluence(IMorpherChannel* channel, TimeValue t) {
    if (!channel) return 0.0f;
    if (Control* control = channel->GetControl()) {
        float percent = 0.0f;
        Interval valid = FOREVER;
        control->GetValue(t, &percent, valid, CTRL_ABSOLUTE);
        if (!std::isfinite(percent)) percent = 0.0f;
        return std::clamp(percent / 100.0f, -10.0f, 10.0f);
    }
    float percent = static_cast<float>(channel->GetInitPercent());
    if (!std::isfinite(percent)) percent = 0.0f;
    return std::clamp(percent / 100.0f, -10.0f, 10.0f);
}

static float ReadMorpherPointWeight(IMorpherChannel* channel, int pointIndex) {
    if (!channel || pointIndex < 0 || pointIndex >= channel->NumPoints()) return 1.0f;
    float weight = static_cast<float>(channel->GetWeight(pointIndex));
    if (!std::isfinite(weight)) return 1.0f;
    if (std::fabs(weight) > 1.0f) weight /= 100.0f;
    return std::clamp(weight, -10.0f, 10.0f);
}

static bool IsFinitePoint3(const Point3& value) {
    return std::isfinite(value.x) && std::isfinite(value.y) && std::isfinite(value.z);
}

static void Mat4IdentityCM(float o[16]) {
    for (int i = 0; i < 16; i++) o[i] = 0.0f;
    o[0] = o[5] = o[10] = o[15] = 1.0f;
}

struct SkinWeightSortPair {
    int boneIdx = 0;
    float w = 0.0f;
};
static bool SkinWeightPairGreater(const SkinWeightSortPair& a, const SkinWeightSortPair& b) {
    return a.w > b.w;
}

// Fills skin + optional morph data for snapshot export. Replaces verts/uvs/norms
// with the pre-Skin bind mesh. If a Morpher evaluates before Skin, export its
// channel deltas once and animate morphTargetInfluences separately; never bake
// animated Morpher output into sampled geometry for this path.
static bool TryExtractSkinRigData(
    INode* meshNode,
    TimeValue t,
    std::vector<float>& verts,
    std::vector<float>& uvs,
    std::vector<float>& norms,
    std::vector<int>& indices,
    std::vector<MatGroup>& groups,
    std::vector<ULONG>& outBoneHandles,
    std::vector<int>& outBoneParents,
    std::vector<float>& outBoneBindLocal,
    std::vector<float>& outSkinW,
    std::vector<float>& outSkinIdx,
    std::vector<std::wstring>& outMorphNames,
    std::vector<int>& outMorphChannelIds,
    std::vector<float>& outMorphInfl,
    std::vector<std::vector<float>>& outMorphDeltas) {
    outBoneHandles.clear();
    outBoneParents.clear();
    outBoneBindLocal.clear();
    outSkinW.clear();
    outSkinIdx.clear();
    outMorphNames.clear();
    outMorphChannelIds.clear();
    outMorphInfl.clear();
    outMorphDeltas.clear();

    ModifierStackMatch skinMatch;
    if (!FindModifierStackMatchOnNode(meshNode, SKIN_CLASSID, skinMatch) || !skinMatch.mod) {
        return false;
    }
    Modifier* skinMod = skinMatch.mod;

    ISkin* skin = static_cast<ISkin*>(skinMod->GetInterface(I_SKIN));
    if (!skin) return false;

    ModifierStackMatch morphMatch;
    Modifier* morphMod = nullptr;
    IMorpher* morpher = nullptr;
    if (FindModifierStackMatchOnNode(meshNode, MR3_CLASS_ID, morphMatch) &&
        morphMatch.mod &&
        morphMatch.mod->IsEnabled() &&
        ModifierEvaluatesBefore(morphMatch, skinMatch)) {
        morphMod = morphMatch.mod;
        IMorpher* maybeMorpher = static_cast<IMorpher*>(
            morphMatch.mod->GetInterface(I_MORPHER_INTERFACE_ID));
        if (maybeMorpher) {
            morpher = maybeMorpher;
        }
    }

    // Disable Skin to get undeformed bind pose mesh. If a safe Morpher sits
    // under Skin, disable it too so current channel weights do not pollute
    // the exported base geometry.
    // controlIdx maps split render vertices back to control vertices for skin weight lookup.
    const int skinWasEnabled = skinMod->IsEnabled();
    const int morphWasEnabled = morphMod ? morphMod->IsEnabled() : 0;
    skinMod->DisableMod();
    if (morphMod) morphMod->DisableMod();
    std::vector<float> bindVerts, bindUvs, bindNorms;
    std::vector<int> bindIdx, controlIdx;
    std::vector<MatGroup> bindGroups;
    const bool bindOk = ExtractMesh(meshNode, t, bindVerts, bindUvs, bindIdx, bindGroups, &bindNorms, &controlIdx);
    if (morphMod) RestoreModifierEnabled(morphMod, morphWasEnabled);
    RestoreModifierEnabled(skinMod, skinWasEnabled);
    if (!bindOk) return false;

    const int vCount = static_cast<int>(bindVerts.size() / 3);
    if (vCount <= 0) return false;

    verts = std::move(bindVerts);
    uvs = std::move(bindUvs);
    norms = std::move(bindNorms);
    indices = std::move(bindIdx);
    groups = std::move(bindGroups);

    ISkinContextData* skinData = skin->GetContextInterface(meshNode);
    if (!skinData) return false;
    if (static_cast<int>(controlIdx.size()) != vCount) return false;

    const int numBones = skin->GetNumBones();
    if (numBones <= 0) return false;

    std::vector<INode*> boneNodes;
    {
        boneNodes.resize(static_cast<size_t>(numBones), nullptr);
        outBoneHandles.resize(static_cast<size_t>(numBones));
        std::unordered_map<ULONG, int> handleToSkinIndex;
        for (int bi = 0; bi < numBones; bi++) {
            INode* bn = skin->GetBone(bi);
            boneNodes[static_cast<size_t>(bi)] = bn;
            outBoneHandles[static_cast<size_t>(bi)] = bn ? bn->GetHandle() : 0;
            if (bn) handleToSkinIndex[bn->GetHandle()] = bi;
        }

        outBoneParents.resize(static_cast<size_t>(numBones), -1);
        for (int bi = 0; bi < numBones; bi++) {
            INode* bn = boneNodes[static_cast<size_t>(bi)];
            if (!bn) {
                outBoneParents[static_cast<size_t>(bi)] = -1;
                continue;
            }
            INode* par = bn->GetParentNode();
            if (!par) {
                outBoneParents[static_cast<size_t>(bi)] = -1;
                continue;
            }
            auto it = handleToSkinIndex.find(par->GetHandle());
            outBoneParents[static_cast<size_t>(bi)] =
                (it != handleToSkinIndex.end()) ? it->second : -1;
        }

        // Use ISkin::GetBoneInitTM for true bind pose — the bone transforms from
        // when the Skin modifier was set up, independent of current animation frame.
        auto MatrixToFloat16 = [](const Matrix3& tm, float out[16]) {
            Point3 r0 = tm.GetRow(0), r1 = tm.GetRow(1), r2 = tm.GetRow(2), tr = tm.GetTrans();
            out[0]=r0.x; out[1]=r0.y; out[2]=r0.z; out[3]=0;
            out[4]=r1.x; out[5]=r1.y; out[6]=r1.z; out[7]=0;
            out[8]=r2.x; out[9]=r2.y; out[10]=r2.z; out[11]=0;
            out[12]=tr.x; out[13]=tr.y; out[14]=tr.z; out[15]=1;
        };

        std::vector<float> boneWorld(static_cast<size_t>(numBones) * 16u);
        for (int bi = 0; bi < numBones; bi++) {
            INode* bn = boneNodes[static_cast<size_t>(bi)];
            if (bn) {
                Matrix3 initTM;
                if (skin->GetBoneInitTM(bn, initTM) == SKIN_OK) {
                    MatrixToFloat16(initTM, &boneWorld[static_cast<size_t>(bi) * 16u]);
                } else {
                    GetTransform16(bn, t, &boneWorld[static_cast<size_t>(bi) * 16u]);
                }
            } else {
                Mat4IdentityCM(&boneWorld[static_cast<size_t>(bi) * 16u]);
            }
        }

        // Root bones are parented to the exported SkinnedMesh. Use the node's
        // actual object transform here: some Genesis/Daz split skin parts
        // report an identity Skin init TM even though their mesh node has a
        // non-zero origin, which offsets eyes/brows/mouth in snapshots.
        float meshInitWorld[16];
        GetTransform16(meshNode, t, meshInitWorld);

        outBoneBindLocal.resize(static_cast<size_t>(numBones) * 16u);
        for (int bi = 0; bi < numBones; bi++) {
            INode* bn = boneNodes[static_cast<size_t>(bi)];
            if (!bn) {
                Mat4IdentityCM(&outBoneBindLocal[static_cast<size_t>(bi) * 16u]);
                continue;
            }
            float parentWorld[16];
            const int pi = outBoneParents[static_cast<size_t>(bi)];
            if (pi >= 0 && pi < numBones && boneNodes[static_cast<size_t>(pi)]) {
                memcpy(parentWorld, &boneWorld[static_cast<size_t>(pi) * 16u], sizeof(float) * 16);
            } else {
                // Root bone: parent in Three.js is the SkinnedMesh → use mesh init transform
                memcpy(parentWorld, meshInitWorld, sizeof(float) * 16);
            }
            float invParent[16];
            if (!InvertMat4CM(parentWorld, invParent))
                Mat4IdentityCM(invParent);
            MulMat4CM(invParent, &boneWorld[static_cast<size_t>(bi) * 16u], &outBoneBindLocal[static_cast<size_t>(bi) * 16u]);
        }

        outSkinW.resize(static_cast<size_t>(vCount) * 4u, 0.0f);
        outSkinIdx.resize(static_cast<size_t>(vCount) * 4u, 0.0f);
        std::vector<SkinWeightSortPair> pairs;
        const int nPts = skinData->GetNumPoints();
        for (int vi = 0; vi < vCount; vi++) {
            // Map split render vertex → control vertex for skin weight lookup
            const int ci = (vi < static_cast<int>(controlIdx.size())) ? controlIdx[vi] : vi;
            if (ci < 0 || ci >= nPts) continue;  // out of range safety
            pairs.clear();
            const int nb = skinData->GetNumAssignedBones(ci);
            for (int j = 0; j < nb; j++) {
                const int bSkin = skinData->GetAssignedBone(ci, j);
                const float w = skinData->GetBoneWeight(ci, j);
                if (bSkin < 0 || bSkin >= numBones || w <= 0.0f) continue;
                SkinWeightSortPair p;
                p.boneIdx = bSkin;
                p.w = w;
                pairs.push_back(p);
            }
            std::sort(pairs.begin(), pairs.end(), SkinWeightPairGreater);
            float sum = 0.0f;
            const int take = std::min(4, static_cast<int>(pairs.size()));
            for (int k = 0; k < take; k++) sum += pairs[static_cast<size_t>(k)].w;
            if (sum < 1.0e-8f) sum = 1.0f;
            for (int k = 0; k < 4; k++) {
                if (k < take) {
                    outSkinIdx[static_cast<size_t>(vi) * 4u + static_cast<size_t>(k)] =
                        static_cast<float>(pairs[static_cast<size_t>(k)].boneIdx);
                    outSkinW[static_cast<size_t>(vi) * 4u + static_cast<size_t>(k)] =
                        pairs[static_cast<size_t>(k)].w / sum;
                } else {
                    outSkinIdx[static_cast<size_t>(vi) * 4u + static_cast<size_t>(k)] = 0.0f;
                    outSkinW[static_cast<size_t>(vi) * 4u + static_cast<size_t>(k)] = 0.0f;
                }
            }
        }
    }

    if (morpher && morphMod) {
        const int numChannels = morpher->NumChannels();
        const int skinPointCount = skinData->GetNumPoints();
        for (int channelId = 0; channelId < numChannels; ++channelId) {
            IMorpherChannel* channel = morpher->GetChannel(channelId, false);
            if (!channel || !channel->IsActive()) continue;
            if (channel->IsProgressive()) continue;
            const int morphPointCount = channel->NumPoints();
            if (morphPointCount <= 0 || morphPointCount < skinPointCount) continue;

            std::vector<float> deltas(static_cast<size_t>(vCount) * 3u, 0.0f);
            bool anyDelta = false;
            for (int vi = 0; vi < vCount; ++vi) {
                const int ci = (vi < static_cast<int>(controlIdx.size())) ? controlIdx[vi] : vi;
                if (ci < 0 || ci >= morphPointCount) continue;
                Point3 delta = channel->GetDelta(ci);
                if (!IsFinitePoint3(delta)) continue;
                delta *= ReadMorpherPointWeight(channel, ci);
                if (!IsFinitePoint3(delta)) continue;
                const size_t off = static_cast<size_t>(vi) * 3u;
                deltas[off + 0] = delta.x;
                deltas[off + 1] = delta.y;
                deltas[off + 2] = delta.z;
                if (!anyDelta &&
                    (std::fabs(delta.x) > 1.0e-7f ||
                     std::fabs(delta.y) > 1.0e-7f ||
                     std::fabs(delta.z) > 1.0e-7f)) {
                    anyDelta = true;
                }
            }
            if (!anyDelta) continue;

            const TCHAR* rawName = channel->GetName(false);
            std::wstring name = rawName && rawName[0]
                ? std::wstring(rawName)
                : (L"Morph " + std::to_wstring(channelId + 1));
            outMorphNames.push_back(std::move(name));
            outMorphChannelIds.push_back(channelId);
            outMorphInfl.push_back(ReadMorpherChannelInfluence(channel, t));
            outMorphDeltas.push_back(std::move(deltas));
        }
    }

    return true;
}

// ══════════════════════════════════════════════════════════════
//  Viewport Camera Extraction
// ══════════════════════════════════════════════════════════════

struct CameraData {
    float pos[3];      // Y-up
    float target[3];   // Y-up
    float up[3];       // Y-up
    float fov;         // degrees (horizontal) for perspective
    float viewWidth;   // world-unit width for orthographic
    bool perspective;
    bool clipEnabled;
    float nearClip;
    float farClip;
    // DOF from Physical Camera
    bool dofEnabled;
    float dofFocusDistance;  // world units
    float dofFocalLength;   // Three.js DOF transition zone, world units
    float dofBokehScale;    // artistic bokeh size multiplier
};

static void GetViewportCamera(CameraData& cam) {
    Interface* ip = GetCOREInterface();

    ViewExp& vp = ip->GetActiveViewExp();

    cam.perspective = vp.IsPerspView() != 0;
    cam.fov = vp.GetFOV() * (180.0f / 3.14159265f);

    Matrix3 viewTM;
    vp.GetAffineTM(viewTM);
    Matrix3 camTM = Inverse(viewTM);

    Point3 pos = camTM.GetTrans();
    Point3 fwd = -Normalize(camTM.GetRow(2));
    Point3 up  = Normalize(camTM.GetRow(1));
    Point3 tgt = pos + fwd * 100.0f;
    cam.viewWidth = cam.perspective ? 0.0f : vp.GetVPWorldWidth(tgt);
    cam.clipEnabled = false;
    cam.nearClip = 0.0f;
    cam.farClip = 0.0f;

    // Raw Z-up coordinates — JS handles conversion
    cam.pos[0] = pos.x;    cam.pos[1] = pos.y;    cam.pos[2] = pos.z;
    cam.target[0] = tgt.x; cam.target[1] = tgt.y;  cam.target[2] = tgt.z;
    cam.up[0] = up.x;      cam.up[1] = up.y;       cam.up[2] = up.z;

    // DOF from Physical Camera
    cam.dofEnabled = false;
    cam.dofFocusDistance = 0.0f;
    cam.dofFocalLength = 0.0f;
    cam.dofBokehScale = 0.0f;

    INode* camNode = vp.GetViewCamera();
    if (camNode && cam.perspective) {
        TimeValue t = ip->GetTime();
        ObjectState os = camNode->EvalWorldState(t);
        // Use IPhysicalCamera API — Class_ID differs across Max versions; ParamBlock indices are not stable.
        MaxSDK::IPhysicalCamera* phys = dynamic_cast<MaxSDK::IPhysicalCamera*>(os.obj);
        if (phys) {
            Interval iv = FOREVER;
            cam.dofEnabled = phys->GetDOFEnabled(t, iv);

            if (cam.dofEnabled) {
                iv = FOREVER;
                float focusDist = phys->GetFocusDistance(t, iv);
                if (focusDist < 1e-4f) focusDist = 5.0f;

                iv = FOREVER;
                float fNumber = phys->GetLensApertureFNumber(t, iv);
                if (fNumber < 1e-4f) fNumber = 8.0f;

                iv = FOREVER;
                float focalLenSU = phys->GetEffectiveLensFocalLength(t, iv);
                if (focalLenSU < 1e-6f) focalLenSU = 0.04f;

                iv = FOREVER;
                float filmW = phys->GetFilmWidth(t, iv);
                double mmPerSU = GetSystemUnitScale(UNITS_MILLIMETERS);
                if (mmPerSU < 1e-9) mmPerSU = 1.0;
                if (filmW < 1e-6f) filmW = 36.0f / (float)mmPerSU;

                float cocSU = filmW / 1500.0f;

                float dofHalf = 0.0f;
                if (focalLenSU > 1e-6f) {
                    dofHalf = fNumber * cocSU * focusDist * focusDist / (focalLenSU * focalLenSU);
                }

                cam.dofFocusDistance = focusDist;
                cam.dofFocalLength = std::clamp(dofHalf, 0.01f, focusDist * 10.0f);
                float focalMM = focalLenSU * (float)mmPerSU;
                cam.dofBokehScale = std::clamp(focalMM / fNumber, 0.5f, 30.0f);
            }
        }
    }
}

static bool GetSceneCameraData(INode* camNode, TimeValue t, CameraData& cam) {
    if (!camNode) return false;
    ObjectState os = camNode->EvalWorldState(t);
    if (!os.obj) return false;

    // Must be a camera superclass
    SClass_ID sc = os.obj->SuperClassID();
    if (sc != CAMERA_CLASS_ID) return false;

    GenCamera* genCam = dynamic_cast<GenCamera*>(os.obj);

    Matrix3 camTM = camNode->GetNodeTM(t);
    Point3 pos = camTM.GetTrans();
    Point3 fwd = -Normalize(camTM.GetRow(2));
    Point3 up  = Normalize(camTM.GetRow(1));

    float targetDist = 100.0f;
    Point3 tgt = pos + fwd * targetDist;

    cam.pos[0] = pos.x;    cam.pos[1] = pos.y;    cam.pos[2] = pos.z;
    cam.target[0] = tgt.x; cam.target[1] = tgt.y;  cam.target[2] = tgt.z;
    cam.up[0] = up.x;      cam.up[1] = up.y;       cam.up[2] = up.z;

    // FOV
    cam.perspective = true;
    cam.viewWidth = 0.0f;
    cam.clipEnabled = false;
    cam.nearClip = 0.0f;
    cam.farClip = 0.0f;
    if (genCam) {
        float fovRad = genCam->GetFOV(t);
        cam.fov = fovRad * (180.0f / 3.14159265f);
        if (genCam->IsOrtho()) {
            cam.perspective = false;
            cam.viewWidth = targetDist * 2.0f;
        }
        CameraObject* cameraObj = dynamic_cast<CameraObject*>(os.obj);
        if (cameraObj && cameraObj->GetManualClip()) {
            Interval valid = FOREVER;
            const float nearClip = cameraObj->GetClipDist(t, CAM_HITHER_CLIP, valid);
            valid = FOREVER;
            const float farClip = cameraObj->GetClipDist(t, CAM_YON_CLIP, valid);
            if (nearClip > 0.0f && farClip > nearClip) {
                cam.clipEnabled = true;
                cam.nearClip = nearClip;
                cam.farClip = farClip;
            }
        }
    } else {
        cam.fov = 45.0f;
    }

    // DOF from Physical Camera
    cam.dofEnabled = false;
    cam.dofFocusDistance = 0.0f;
    cam.dofFocalLength = 0.0f;
    cam.dofBokehScale = 0.0f;

    MaxSDK::IPhysicalCamera* phys = dynamic_cast<MaxSDK::IPhysicalCamera*>(os.obj);
    if (phys && cam.perspective) {
        Interval iv = FOREVER;
        cam.dofEnabled = phys->GetDOFEnabled(t, iv);
        if (cam.dofEnabled) {
            iv = FOREVER;
            float focusDist = phys->GetFocusDistance(t, iv);
            if (focusDist < 1e-4f) focusDist = 5.0f;

            iv = FOREVER;
            float fNumber = phys->GetLensApertureFNumber(t, iv);
            if (fNumber < 1e-4f) fNumber = 8.0f;

            iv = FOREVER;
            float focalLenSU = phys->GetEffectiveLensFocalLength(t, iv);
            if (focalLenSU < 1e-6f) focalLenSU = 0.04f;

            iv = FOREVER;
            float filmW = phys->GetFilmWidth(t, iv);
            double mmPerSU = GetSystemUnitScale(UNITS_MILLIMETERS);
            if (mmPerSU < 1e-9) mmPerSU = 1.0;
            if (filmW < 1e-6f) filmW = 36.0f / (float)mmPerSU;

            float cocSU = filmW / 1500.0f;
            float dofHalf = 0.0f;
            if (focalLenSU > 1e-6f) {
                dofHalf = fNumber * cocSU * focusDist * focusDist / (focalLenSU * focalLenSU);
            }

            cam.dofFocusDistance = focusDist;
            cam.dofFocalLength = std::clamp(dofHalf, 0.01f, focusDist * 10.0f);
            float focalMM = focalLenSU * (float)mmPerSU;
            cam.dofBokehScale = std::clamp(focalMM / fNumber, 0.5f, 30.0f);
        }
    }
    return true;
}

static bool GetRenderViewCameraData(INode* renderViewNode, const ViewParams* viewPar,
                                    TimeValue t, CameraData& cam) {
    CameraData nodeCam = {};
    const bool haveNodeCamera = renderViewNode && GetSceneCameraData(renderViewNode, t, nodeCam);

    // When a render camera node is available its world transform is
    // authoritative. The ViewParams handed to this GUP-triggered production
    // render do not reliably carry a populated affineTM; Inverse() then
    // collapses the camera to the world origin and the whole frame renders
    // black (object framed from off-screen). Always prefer the camera node.
    if (haveNodeCamera) {
        cam = nodeCam;
        return true;
    }

    // No camera node: a pure viewport render. Guard against an unpopulated /
    // degenerate affineTM (near-zero basis) — bail so the caller falls back to
    // the live viewport camera instead of placing the camera at the origin.
    if (!viewPar ||
        viewPar->affineTM.GetRow(0).LengthSquared() < 1e-8f ||
        viewPar->affineTM.GetRow(1).LengthSquared() < 1e-8f ||
        viewPar->affineTM.GetRow(2).LengthSquared() < 1e-8f) {
        return false;
    }

    Matrix3 camTM = Inverse(viewPar->affineTM);
    Point3 pos = camTM.GetTrans();
    Point3 fwd = -Normalize(camTM.GetRow(2));
    Point3 up = Normalize(camTM.GetRow(1));

    float targetDist = viewPar->distance;
    if (targetDist < 1.0f) targetDist = 100.0f;
    Point3 tgt = pos + fwd * targetDist;

    cam.pos[0] = pos.x;    cam.pos[1] = pos.y;    cam.pos[2] = pos.z;
    cam.target[0] = tgt.x; cam.target[1] = tgt.y; cam.target[2] = tgt.z;
    cam.up[0] = up.x;      cam.up[1] = up.y;      cam.up[2] = up.z;

    cam.perspective = viewPar->projType != 1; // PROJ_PARALLEL == 1
    cam.fov = viewPar->fov > 1.0e-6f
        ? viewPar->fov * (180.0f / 3.14159265f)
        : (haveNodeCamera ? nodeCam.fov : 60.0f);
    cam.viewWidth = 0.0f;
    cam.clipEnabled = false;
    cam.nearClip = 0.0f;
    cam.farClip = 0.0f;
    if (!cam.perspective) {
        if (haveNodeCamera && !nodeCam.perspective && nodeCam.viewWidth > 1.0e-4f) {
            cam.viewWidth = nodeCam.viewWidth;
        } else if (viewPar->zoom > 1.0e-6f) {
            cam.viewWidth = 2.0f / viewPar->zoom;
        } else {
            cam.viewWidth = std::max(1.0f, targetDist * 2.0f);
        }
    }
    if (haveNodeCamera && nodeCam.clipEnabled) {
        cam.clipEnabled = true;
        cam.nearClip = nodeCam.nearClip;
        cam.farClip = nodeCam.farClip;
    } else if (viewPar->hither > 0.0f && viewPar->yon > viewPar->hither) {
        cam.clipEnabled = true;
        cam.nearClip = viewPar->hither;
        cam.farClip = viewPar->yon;
    }

    cam.dofEnabled = false;
    cam.dofFocusDistance = 0.0f;
    cam.dofFocalLength = 0.0f;
    cam.dofBokehScale = 0.0f;
    if (haveNodeCamera && nodeCam.dofEnabled) {
        cam.dofEnabled = nodeCam.dofEnabled;
        cam.dofFocusDistance = nodeCam.dofFocusDistance;
        cam.dofFocalLength = nodeCam.dofFocalLength;
        cam.dofBokehScale = nodeCam.dofBokehScale;
    }
    return true;
}

static bool IsSceneCameraNode(INode* node) {
    if (!node) return false;
    ObjectState os = node->EvalWorldState(GetCOREInterface()->GetTime());
    return os.obj && os.obj->SuperClassID() == CAMERA_CLASS_ID;
}

static bool IsSceneCameraTargetNode(INode* node, TimeValue t) {
    if (!node || node->IsRootNode()) return false;
    ObjectState os = node->EvalWorldState(t);
    return os.obj && os.obj->ClassID() == Class_ID(TARGET_CLASS_ID, 0);
}

static MaxSDK::Graphics::IViewportViewSetting* GetViewportSettings() {
    Interface* ip = GetCOREInterface();
    if (!ip) return nullptr;
    ViewExp& vp = ip->GetActiveViewExp();
    return static_cast<MaxSDK::Graphics::IViewportViewSetting*>(
        vp.GetInterface(IVIEWPORT_SETTINGS_INTERFACE_ID));
}

static bool IsClayModeActive() {
    auto* s = GetViewportSettings();
    return s && s->GetViewportVisualStyle() == MaxSDK::Graphics::VisualStyleClay;
}

static bool NearlyEqualFloat(float a, float b, float epsilon = 1.0e-4f) {
    return std::fabs(a - b) <= epsilon;
}

static bool CameraEquals(const CameraData& a, const CameraData& b) {
    for (int i = 0; i < 3; ++i) {
        if (!NearlyEqualFloat(a.pos[i], b.pos[i])) return false;
        if (!NearlyEqualFloat(a.target[i], b.target[i])) return false;
        if (!NearlyEqualFloat(a.up[i], b.up[i])) return false;
    }
    if (!NearlyEqualFloat(a.fov, b.fov, 1.0e-3f)) return false;
    if (a.perspective != b.perspective) return false;
    if (a.clipEnabled != b.clipEnabled) return false;
    if (a.clipEnabled) {
        if (!NearlyEqualFloat(a.nearClip, b.nearClip, 0.01f)) return false;
        if (!NearlyEqualFloat(a.farClip, b.farClip, 0.01f)) return false;
    }
    if (a.dofEnabled != b.dofEnabled) return false;
    if (a.dofEnabled) {
        if (!NearlyEqualFloat(a.dofFocusDistance, b.dofFocusDistance, 0.01f)) return false;
        if (!NearlyEqualFloat(a.dofFocalLength, b.dofFocalLength, 0.01f)) return false;
        if (!NearlyEqualFloat(a.dofBokehScale, b.dofBokehScale, 0.01f)) return false;
    }
    return true;
}

// ══════════════════════════════════════════════════════════════
//  Node Object Properties
// ══════════════════════════════════════════════════════════════

static uint64_t ComputeNodePropHash(INode* node, TimeValue t) {
    uint64_t h = 0;
    h = h * 31 + (uint64_t)node->Renderable();
    h = h * 31 + (uint64_t)node->GetBackCull();
    h = h * 31 + (uint64_t)node->CastShadows();
    h = h * 31 + (uint64_t)node->RcvShadows();
    h = h * 31 + (uint64_t)(node->GetPrimaryVisibility() ? 1 : 0);
    h = h * 31 + (uint64_t)(node->GetSecondaryVisibility() ? 1 : 0);
    float vis = node->GetVisibility(t);
    uint32_t visBits; memcpy(&visBits, &vis, 4);
    h = h * 31 + visBits;
    return h;
}

static uint64_t ComputeSyncRelevantNodeStateHash(INode* node, TimeValue t) {
    if (!node) return 0;

    uint64_t h = 1469598103934665603ULL;
    const ULONG handle = node->GetHandle();
    h = HashFNV1a(&handle, sizeof(handle), h);

    float xform[16];
    GetTransform16(node, t, xform);
    h = HashFNV1a(xform, sizeof(xform), h);

    const uint64_t props = ComputeNodePropHash(node, t);
    h = HashFNV1a(&props, sizeof(props), h);

    ObjectState os = node->EvalWorldState(t);
    if (os.obj) {
        const SClass_ID superClass = os.obj->SuperClassID();
        const Class_ID classId = os.obj->ClassID();
        h = HashFNV1a(&superClass, sizeof(superClass), h);
        h = HashFNV1a(&classId, sizeof(classId), h);
        h = HashIntervalState(os.obj->ChannelValidity(t, GEOM_CHAN_NUM), h);
        h = HashIntervalState(os.obj->ChannelValidity(t, TOPO_CHAN_NUM), h);
    }

    if (Mtl* mtl = node->GetMtl()) {
        const Class_ID mtlClass = mtl->ClassID();
        h = HashFNV1a(&mtlClass, sizeof(mtlClass), h);
        // Material validity can flap from editor-preview churn. Actual material changes
        // are tracked through the dedicated material sync paths instead.
    }

    return h;
}

static void CollectReferencedNodeHandlesRecursive(ReferenceMaker* maker,
                                                  ULONG ownerHandle,
                                                  std::unordered_set<ULONG>& out,
                                                  std::unordered_set<const void*>& visited,
                                                  int depth = 0) {
    if (!maker || depth > 8) return;
    if (!visited.insert(maker).second) return;

    if (maker->SuperClassID() == BASENODE_CLASS_ID) {
        INode* depNode = static_cast<INode*>(maker);
        const ULONG depHandle = depNode->GetHandle();
        if (depHandle != ownerHandle) out.insert(depHandle);
        return;
    }

    const int numRefs = maker->NumRefs();
    for (int i = 0; i < numRefs; ++i) {
        RefTargetHandle ref = maker->GetReference(i);
        if (!ref) continue;
        CollectReferencedNodeHandlesRecursive(ref, ownerHandle, out, visited, depth + 1);
    }
}

static void CollectReferenceTargetsForNodeObjectGraph(INode* node,
                                                      std::unordered_set<ReferenceTarget*>& out) {
    if (!node) return;
    Object* obj = node->GetObjectRef();
    while (obj) {
        if (obj->IsRefTarget()) {
            out.insert(static_cast<ReferenceTarget*>(obj));
        }
        if (obj->SuperClassID() != GEN_DERIVOB_CLASS_ID) break;
        obj = static_cast<IDerivedObject*>(obj)->GetObjRef();
    }
}

static bool ReferenceGraphContainsAnyTarget(ReferenceMaker* maker,
                                            const std::unordered_set<ReferenceTarget*>& targets,
                                            std::unordered_set<const void*>& visited,
                                            int depth = 0) {
    if (!maker || targets.empty() || depth > 12) return false;
    if (!visited.insert(maker).second) return false;

    if (maker->IsRefTarget()) {
        ReferenceTarget* asTarget = static_cast<ReferenceTarget*>(maker);
        if (targets.find(asTarget) != targets.end()) {
            return true;
        }
    }

    const int numRefs = maker->NumRefs();
    for (int i = 0; i < numRefs; ++i) {
        RefTargetHandle ref = maker->GetReference(i);
        if (!ref) continue;
        if (targets.find(ref) != targets.end()) {
            return true;
        }
        if (ReferenceGraphContainsAnyTarget(ref, targets, visited, depth + 1)) {
            return true;
        }
    }
    return false;
}

static bool HasConsumptiveDependentRecursive(ReferenceMaker* maker,
                                             INode* targetNode,
                                             const std::unordered_set<ReferenceTarget*>& targetRefs,
                                             TimeValue t,
                                             std::unordered_set<const void*>& visited,
                                             int depth = 0) {
    if (!maker || depth > 10) return false;
    if (!visited.insert(maker).second) return false;

    if (maker->SuperClassID() == BASENODE_CLASS_ID) {
        INode* depNode = static_cast<INode*>(maker);
        if (depNode != targetNode) {
            ObjectState depOs = depNode->EvalWorldState(t);
            const bool geometryConsumer =
                depOs.obj && depOs.obj->SuperClassID() == GEOMOBJECT_CLASS_ID;
            if (geometryConsumer) {
                std::unordered_set<const void*> refVisited;
                if (ReferenceGraphContainsAnyTarget(static_cast<ReferenceMaker*>(depNode->GetObjectRef()), targetRefs, refVisited, 0)) {
                    return true;
                }
            }
        }
    }

    if (!maker->IsRefTarget()) return false;
    DependentIterator iter(static_cast<ReferenceTarget*>(maker));
    for (ReferenceMaker* dep = iter.Next(); dep; dep = iter.Next()) {
        if (HasConsumptiveDependentRecursive(dep, targetNode, targetRefs, t, visited, depth + 1)) {
            return true;
        }
    }
    return false;
}

static bool IsShapeConsumedByOtherRuntimeNode(INode* node, TimeValue t) {
    if (!node) return false;
    std::unordered_set<ReferenceTarget*> targetRefs;
    CollectReferenceTargetsForNodeObjectGraph(node, targetRefs);
    if (targetRefs.empty()) return false;

    std::unordered_set<const void*> visited;
    Object* objRef = node->GetObjectRef();
    if (!objRef || !objRef->IsRefTarget()) return false;
    DependentIterator iter(static_cast<ReferenceTarget*>(objRef));
    for (ReferenceMaker* dep = iter.Next(); dep; dep = iter.Next()) {
        if (HasConsumptiveDependentRecursive(dep, node, targetRefs, t, visited, 0)) {
            return true;
        }
    }
    return false;
}

static uint64_t ComputePluginInstanceStateHash(INode* node, TimeValue t, Interface* ip) {
    if (!node) return 0;

    uint64_t h = ComputeSyncRelevantNodeStateHash(node, t);
    std::unordered_set<ULONG> deps;
    std::unordered_set<const void*> visited;

    Object* base = node->GetObjectRef();
    while (base && base->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
        base = reinterpret_cast<IDerivedObject*>(base)->GetObjRef();
    }
    ReferenceMaker* root = base
        ? static_cast<ReferenceMaker*>(base)
        : static_cast<ReferenceMaker*>(node->GetObjectRef());
    CollectReferencedNodeHandlesRecursive(root, node->GetHandle(), deps, visited);

    std::vector<ULONG> sortedDeps(deps.begin(), deps.end());
    std::sort(sortedDeps.begin(), sortedDeps.end());
    const size_t depCount = sortedDeps.size();
    h = HashFNV1a(&depCount, sizeof(depCount), h);

    for (ULONG depHandle : sortedDeps) {
        h = HashFNV1a(&depHandle, sizeof(depHandle), h);
        INode* depNode = ip ? ip->GetINodeByHandle(depHandle) : nullptr;
        const uint64_t depHash = depNode ? ComputeSyncRelevantNodeStateHash(depNode, t) : 0;
        h = HashFNV1a(&depHash, sizeof(depHash), h);
    }

    return h;
}

// ══════════════════════════════════════════════════════════════
//  Hair And Fur Modifier Extraction
// ══════════════════════════════════════════════════════════════

static void HairDebugLog(const std::wstring& line) {
#ifndef _DEBUG
    (void)line;
    return;
#else
    static std::mutex sMutex;
    std::lock_guard<std::mutex> lock(sMutex);
    wchar_t tempPath[MAX_PATH] = {};
    DWORD tempLen = GetTempPathW(static_cast<DWORD>(std::size(tempPath)), tempPath);
    if (!tempLen || tempLen >= std::size(tempPath)) return;
    std::wstring logPath(tempPath);
    if (!logPath.empty() && logPath.back() != L'\\' && logPath.back() != L'/') logPath += L'\\';
    logPath += L"maxjs_hair_debug.log";
    HANDLE h = CreateFileW(logPath.c_str(),
        FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, nullptr, FILE_END);
    const std::string utf8 = WideToUtf8(line + L"\r\n");
    DWORD written = 0;
    WriteFile(h, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
    CloseHandle(h);
#endif
}

class FindHairModifierOnStackEnum : public GeomPipelineEnumProc {
public:
    MaxSDK::IHairModifier* hair = nullptr;
    MSTR sourceClassName;
    bool dumpAll = false;
    int stepCount = 0;
    PipeEnumResult proc(ReferenceTarget* object, IDerivedObject* derObj, int index) override {
        (void)derObj;
        stepCount++;
        if (!object) {
            if (dumpAll) {
                std::wostringstream ss;
                ss << L"  step[" << stepCount << L"] object=<null> derObj=" << (derObj ? L"yes" : L"no") << L" idx=" << index;
                HairDebugLog(ss.str());
            }
            return PIPE_ENUM_CONTINUE;
        }
        const Class_ID cid = object->ClassID();
        const SClass_ID sid = object->SuperClassID();
        MaxSDK::IHairModifier* maybeHair = dynamic_cast<MaxSDK::IHairModifier*>(object);
        if (dumpAll) {
            std::wostringstream ss;
            ss << L"  step[" << stepCount << L"] class=" << object->ClassName().data()
               << L" sid=0x" << std::hex << sid << std::dec
               << L" cid=(" << cid.PartA() << L"," << cid.PartB() << L")"
               << L" idx=" << index
               << L" hairCast=" << (maybeHair ? L"YES" : L"no");
            HairDebugLog(ss.str());
        }
        if (maybeHair && !hair) {
            hair = maybeHair;
            sourceClassName = object->ClassName();
        }
        return PIPE_ENUM_CONTINUE; // walk full stack so we see everything
    }
};

static MaxSDK::IHairModifier* FindHairModifierOnNode(INode* node) {
    if (!node) return nullptr;
    FindHairModifierOnStackEnum proc;
    EnumGeomPipeline(&proc, node);
    return proc.hair;
}

static bool ProbeHairModifierOnNode(INode* node, MaxSDK::IHairModifier*& outHair, MSTR* outSourceClassName) {
    outHair = nullptr;
    if (!node) return false;
    FindHairModifierOnStackEnum proc;
    EnumGeomPipeline(&proc, node);
    outHair = proc.hair;
    if (outSourceClassName) {
        *outSourceClassName = proc.sourceClassName;
    }
    return outHair != nullptr;
}

static bool HasEnabledHairModifier(INode* node) {
    MaxSDK::IHairModifier* hair = FindHairModifierOnNode(node);
    return hair && hair->IsHairEnabled();
}

static bool SafeNormalizePoint3(Point3& value, float eps = 1.0e-6f) {
    const float lenSq = DotProd(value, value);
    if (lenSq <= eps * eps) return false;
    value *= 1.0f / std::sqrt(lenSq);
    return true;
}

static Point3 FallbackHairNormal(const Point3& tangent) {
    Point3 normal = CrossProd(tangent, Point3(0.0f, 0.0f, 1.0f));
    if (!SafeNormalizePoint3(normal)) {
        normal = CrossProd(tangent, Point3(0.0f, 1.0f, 0.0f));
        if (!SafeNormalizePoint3(normal)) {
            normal = Point3(1.0f, 0.0f, 0.0f);
        }
    }
    return normal;
}

static void WriteBasisTransform16(const Point3& basisX,
                                  const Point3& basisY,
                                  const Point3& basisZ,
                                  const Point3& translation,
                                  float out[16]) {
    out[0] = basisX.x; out[1] = basisX.y; out[2] = basisX.z; out[3] = 0.0f;
    out[4] = basisY.x; out[5] = basisY.y; out[6] = basisY.z; out[7] = 0.0f;
    out[8] = basisZ.x; out[9] = basisZ.y; out[10] = basisZ.z; out[11] = 0.0f;
    out[12] = translation.x; out[13] = translation.y; out[14] = translation.z; out[15] = 1.0f;
}

static void FillHairPBR(INode* node,
                        TimeValue t,
                        const MaxSDK::IHairModifier::ShadingParameters& shading,
                        MaxJSPBR& outPbr) {
    outPbr = MaxJSPBR();
    outPbr.materialModel = L"MeshPhysicalMaterial";
    outPbr.doubleSided = true;
    outPbr.color[0] = 1.0f;
    outPbr.color[1] = 1.0f;
    outPbr.color[2] = 1.0f;
    outPbr.roughness = std::clamp(1.0f - shading.gloss, 0.02f, 1.0f);
    outPbr.physicalSpecularIntensity = std::clamp(shading.specular, 0.0f, 1.0f);
    outPbr.physicalSpecularColor[0] = std::max(0.0f, shading.specular_tint.r);
    outPbr.physicalSpecularColor[1] = std::max(0.0f, shading.specular_tint.g);
    outPbr.physicalSpecularColor[2] = std::max(0.0f, shading.specular_tint.b);
    outPbr.opacity = 1.0f;

    if (shading.shader) {
        ExtractPBRFromMtl(shading.shader, node, t, outPbr);
        outPbr.doubleSided = true;
    }
}

struct HairInstanceGroup {
    ULONG handle = 0;
    bool visible = true;
    int instanceCount = 0;
    float nodeTransform[16] = {
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    std::vector<float> transforms;
    std::vector<float> colors;
    MaxJSPBR pbr;
};

static bool ExtractHairInstances(INode* node,
                                 TimeValue t,
                                 std::vector<HairInstanceGroup>& outGroups) {
    MaxSDK::IHairModifier* hair = FindHairModifierOnNode(node);
    if (!hair) return false;
    // NOTE: ignore IsHairEnabled() — the built-in HairMod returns false even when
    // hair primitives ARE available via GetHairDefinition. Empirically, calling
    // GetHairDefinition unconditionally is the only way to actually retrieve the strands.

    MaxSDK::Array<unsigned int> perHairVertexCount;
    MaxSDK::Array<Point3> vertices;
    MaxSDK::Array<float> perVertexRadius;
    MaxSDK::Array<Color> perVertexColor;
    MaxSDK::Array<Point3> perVertexNormal;
    MaxSDK::Array<Point3> perVertexVelocity;
    MaxSDK::Array<float> perVertexOpacity;
    MaxSDK::Array<Point2> perVertexUv;

    const bool getDefOk = hair->GetHairDefinition(t, *node,
                                 perHairVertexCount, vertices, perVertexRadius,
                                 perVertexColor, perVertexNormal, perVertexVelocity,
                                 perVertexOpacity, perVertexUv);
    {
        std::wostringstream ss;
        ss << L"  GetHairDefinition: ok=" << (getDefOk ? L"1" : L"0")
           << L" strands=" << perHairVertexCount.length()
           << L" verts=" << vertices.length()
           << L" radii=" << perVertexRadius.length()
           << L" normals=" << perVertexNormal.length()
           << L" colors=" << perVertexColor.length();
        if (vertices.length() > 0) {
            const Point3& v0 = vertices[0];
            ss << L" v0=(" << v0.x << L"," << v0.y << L"," << v0.z << L")";
        }
        HairDebugLog(ss.str());
    }
    if (!getDefOk) return false;

    if (perHairVertexCount.length() <= 0 || vertices.length() <= 0) return false;

    HairInstanceGroup group;
    group.handle = node->GetHandle();
    group.visible = IsMaxJsSyncDrawVisible(node);
    GetTransform16(node, t, group.nodeTransform);

    Interval hairValidity = FOREVER;
    FillHairPBR(node, t, hair->GetShadingParameters(t, hairValidity), group.pbr);

    double opacitySum = 0.0;
    size_t opacityCount = 0;
    size_t vertexBase = 0;

    for (size_t hairIndex = 0; hairIndex < perHairVertexCount.length(); ++hairIndex) {
        const unsigned int vertexCount = perHairVertexCount[hairIndex];
        if (vertexCount < 2 || (vertexBase + vertexCount) > vertices.length()) {
            vertexBase += vertexCount;
            continue;
        }

        const Point3 root = vertices[vertexBase];
        Point3 tangentSum(0.0f, 0.0f, 0.0f);
        float totalLength = 0.0f;

        for (unsigned int vi = 1; vi < vertexCount; ++vi) {
            Point3 segment = vertices[vertexBase + vi] - vertices[vertexBase + vi - 1];
            const float segLen = Length(segment);
            if (segLen <= 1.0e-5f) continue;
            tangentSum += segment;
            totalLength += segLen;
        }

        if (totalLength <= 1.0e-5f || !SafeNormalizePoint3(tangentSum)) {
            vertexBase += vertexCount;
            continue;
        }

        Point3 normalSum(0.0f, 0.0f, 0.0f);
        if (perVertexNormal.length() == vertices.length()) {
            for (unsigned int vi = 0; vi < vertexCount; ++vi) {
                normalSum += perVertexNormal[vertexBase + vi];
            }
        }
        normalSum -= tangentSum * DotProd(normalSum, tangentSum);
        if (!SafeNormalizePoint3(normalSum)) {
            normalSum = FallbackHairNormal(tangentSum);
        }

        Point3 side = CrossProd(normalSum, tangentSum);
        if (!SafeNormalizePoint3(side)) {
            normalSum = FallbackHairNormal(tangentSum);
            side = CrossProd(normalSum, tangentSum);
            if (!SafeNormalizePoint3(side)) {
                vertexBase += vertexCount;
                continue;
            }
        }

        float radiusSum = 0.0f;
        int radiusCount = 0;
        if (perVertexRadius.length() == vertices.length()) {
            for (unsigned int vi = 0; vi < vertexCount; ++vi) {
                radiusSum += std::max(0.0f, perVertexRadius[vertexBase + vi]);
                radiusCount++;
            }
        }
        const float avgRadius = radiusCount > 0 ? (radiusSum / static_cast<float>(radiusCount)) : 0.0f;
        const float widthFromRadius = avgRadius * 2.0f;
        const float widthFromLength = totalLength * 0.035f;
        const float bladeWidth = std::max(std::max(widthFromRadius, widthFromLength), 0.25f);

        float matrix[16];
        WriteBasisTransform16(side * bladeWidth, tangentSum * totalLength, normalSum, root, matrix);
        group.transforms.insert(group.transforms.end(), matrix, matrix + 16);

        float color[3] = { group.pbr.color[0], group.pbr.color[1], group.pbr.color[2] };
        if (perVertexColor.length() == vertices.length()) {
            Point3 strandColor(0.0f, 0.0f, 0.0f);
            for (unsigned int vi = 0; vi < vertexCount; ++vi) {
                const Color c = perVertexColor[vertexBase + vi];
                strandColor += Point3(c.r, c.g, c.b);
            }
            strandColor *= (1.0f / static_cast<float>(vertexCount));
            color[0] = std::max(0.0f, strandColor.x);
            color[1] = std::max(0.0f, strandColor.y);
            color[2] = std::max(0.0f, strandColor.z);
        }
        group.colors.insert(group.colors.end(), color, color + 3);

        if (perVertexOpacity.length() == vertices.length()) {
            float strandOpacity = 0.0f;
            for (unsigned int vi = 0; vi < vertexCount; ++vi) {
                strandOpacity += std::clamp(perVertexOpacity[vertexBase + vi], 0.0f, 1.0f);
            }
            opacitySum += strandOpacity / static_cast<float>(vertexCount);
            opacityCount++;
        }

        group.instanceCount++;
        vertexBase += vertexCount;
    }

    if (group.instanceCount <= 0) return false;

    if (opacityCount > 0) {
        group.pbr.opacity = static_cast<float>(std::clamp(opacitySum / static_cast<double>(opacityCount), 0.0, 1.0));
    }

    outGroups.push_back(std::move(group));
    return true;
}

// ── JS Modifier detection (three.js Deform in modifier stack) ──
struct JsModData {
    bool found = false;
};

static void GetJsModData(INode* node, TimeValue t, JsModData& out) {
    out = {};
    Object* obj = node->GetObjectRef();
    while (obj && obj->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
        IDerivedObject* dobj = static_cast<IDerivedObject*>(obj);
        for (int i = 0; i < dobj->NumModifiers(); i++) {
            Modifier* mod = dobj->GetModifier(i);
            if (mod && mod->IsEnabled() && IsThreeJSDeformClassID(mod->ClassID())) {
                out.found = true;
                return;
            }
        }
        obj = dobj->GetObjRef();
    }
}

static void WriteJsModJson(std::wostringstream& ss, const JsModData&) {
    ss << L"\"jsmod\":true";
}

static bool IsMaxJSHierarchyNode(INode* node, TimeValue t) {
    if (!node || node->IsRootNode()) return false;
    if (node->IsGroupHead()) return true;
    ObjectState os = node->EvalWorldState(t);
    return os.obj && (os.obj->SuperClassID() == HELPER_CLASS_ID || IsSceneCameraTargetNode(node, t));
}

static ULONG GetMaxJSParentHandle(INode* node) {
    if (!node) return 0;
    INode* parent = node->GetParentNode();
    if (!parent || parent->IsRootNode()) return 0;
    return parent->GetHandle();
}

static void WriteNodeParentJson(std::wostringstream& ss, INode* node) {
    const ULONG parentHandle = GetMaxJSParentHandle(node);
    if (parentHandle != 0) ss << L",\"p\":" << parentHandle;
}

static void WriteNodePropsJson(std::wostringstream& ss, INode* node, TimeValue t) {
    ss << L"\"rend\":" << (node->Renderable() ? L'1' : L'0');
    ss << L",\"bcull\":" << (node->GetBackCull() ? L'1' : L'0');
    ss << L",\"cshadow\":" << (node->CastShadows() ? L'1' : L'0');
    ss << L",\"rshadow\":" << (node->RcvShadows() ? L'1' : L'0');
    ss << L",\"visCam\":" << (node->GetPrimaryVisibility() ? L'1' : L'0');
    ss << L",\"visRefl\":" << (node->GetSecondaryVisibility() ? L'1' : L'0');
    float opacity = node->GetVisibility(t);
    if (opacity < 0.0f) opacity = 0.0f;
    if (opacity > 1.0f) opacity = 1.0f;
    ss << L",\"opacity\":" << opacity;
}

// ══════════════════════════════════════════════════════════════
//  ForestPack Instance Extraction
// ══════════════════════════════════════════════════════════════

static bool IsForestPackClassID(const Class_ID& id) {
    return id == TFOREST_CLASS_ID || id == FIVY_CLASS_ID;
}

// Walk past modifiers/derived objects to find the base object
static Object* GetBaseObject(Object* obj) {
    while (obj && obj->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
        obj = reinterpret_cast<IDerivedObject*>(obj)->GetObjRef();
    }
    return obj;
}

static bool IsDerivedObjectRef(Object* obj) {
    return obj &&
           (obj->ClassID() == derivObjClassID ||
            obj->ClassID() == WSMDerivObjClassID ||
            obj->SuperClassID() == GEN_DERIVOB_CLASS_ID);
}

static bool ObjectChainHasModifierStack(Object* obj) {
    while (IsDerivedObjectRef(obj)) {
        auto* derived = static_cast<IDerivedObject*>(obj);
        if (derived->NumModifiers() > 0) return true;
        obj = derived->GetObjRef();
    }
    return false;
}

static bool NodeHasModifierStack(INode* node) {
    if (!node) return false;
    // Space warps such as Path Deform can live on the node WSM stack instead
    // of the object ref stack; those still need live deform polling.
    if (IDerivedObject* wsm = node->GetWSMDerivedObject()) {
        if (ObjectChainHasModifierStack(static_cast<Object*>(wsm))) return true;
    }
    return ObjectChainHasModifierStack(node->GetObjectRef());
}

// Check base object ClassID (EvalWorldState returns collapsed mesh, not Forest Pack)
static bool IsForestPackNode(INode* node) {
    if (!node) return false;
    Object* base = GetBaseObject(node->GetObjectRef());
    return base && IsForestPackClassID(base->ClassID());
}

// Check if ForestPack plugin is actually loaded before touching its interfaces
static bool IsForestPackAvailable() {
    static int cached = -1;
    if (cached < 0) {
        // ForestPack's main DLL — if not loaded, don't touch anything
        cached = (GetModuleHandleW(L"Forest.dlo") != nullptr ||
                  GetModuleHandleW(L"ForestPack.dlo") != nullptr ||
                  GetModuleHandleW(L"ForestPackPro.dlo") != nullptr ||
                  GetModuleHandleW(L"ForestPro.dlo") != nullptr) ? 1 : 0;
    }
    return cached == 1;
}

enum class InstanceGroupKind {
    ForestPack,
    RailClone,
    TyFlow
};

static const wchar_t* InstanceGroupKindName(InstanceGroupKind kind) {
    switch (kind) {
    case InstanceGroupKind::RailClone: return L"railclone";
    case InstanceGroupKind::TyFlow: return L"tyflow";
    case InstanceGroupKind::ForestPack:
    default: return L"forestpack";
    }
}

struct ForestInstanceGroup {
    InstanceGroupKind kind = InstanceGroupKind::ForestPack;
    uintptr_t groupKey = 0;           // unique key: source node handle or mesh pointer
    uintptr_t ownerKey = 0;           // plugin object handle that produced this group
    std::vector<float> verts, uvs, norms;
    std::vector<int> indices;
    std::vector<MatGroup> groups;
    std::vector<float> transforms;    // flat array of 16-float matrices
    int instanceCount = 0;
    Mtl* mtl = nullptr;               // material for this group (may be multi-sub)
    INode* mtlNode = nullptr;         // node for wire color fallback
    size_t vOff = 0, vN = 0;
    size_t iOff = 0, iN = 0;
    std::wstring iType;
    size_t uvOff = 0, uvN = 0;
    std::wstring uvType;
    size_t nOff = 0, nN = 0;
    std::wstring nType;
    size_t xformOff = 0, xformN = 0;
    std::wstring xformType;
    bool requiresSubobjectMaterials = false;
};

// Register MaxJS as a Forest Pack render engine (once per session)
static bool g_forestEngineRegistered = false;
static void RegisterForestPackEngine() {
    if (g_forestEngineRegistered) return;
    __try {
        IForestPackInterface* fpi = GetForestPackInterface();
        if (!fpi) return;
        fpi->IForestRegisterEngine();
        TForestEngineFeatures features;
        features.edgeMode = FALSE;
        features.meshesSupport = TRUE;
        features.animProxySupport = FALSE;
        features.ivySupport = TRUE;
        fpi->IForestSetEngineFeatures((INT_PTR)&features);
        g_forestEngineRegistered = true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
}

// SEH wrapper — isolates crash guard from C++ object unwinding
static bool SafeGetForestInterface(INode* fpNode, ITreesInterface** out) {
    __try {
        Object* base = GetBaseObject(fpNode->GetObjectRef());
        if (!base) return false;
        *out = GetTreesInterface(base);
        return *out != nullptr;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static bool SafeForestRenderBegin(ITreesInterface* itrees, TimeValue t,
                                   TForestInstance** outInstances, int* outCount) {
    __try {
        itrees->IForestRenderBegin(t);
        *outCount = 0;
        INT_PTR rawPtr = itrees->IForestGetRenderNodes(*outCount);
        *outInstances = reinterpret_cast<TForestInstance*>(rawPtr);
        return *outInstances != nullptr && *outCount > 0;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// Convert a Matrix3 to a 16-float row-major array
static void Matrix3To16(const Matrix3& m, float out[16]) {
    Point3 r0 = m.GetRow(0), r1 = m.GetRow(1), r2 = m.GetRow(2), tr = m.GetTrans();
    out[0]=r0.x; out[1]=r0.y; out[2]=r0.z; out[3]=0;
    out[4]=r1.x; out[5]=r1.y; out[6]=r1.z; out[7]=0;
    out[8]=r2.x; out[9]=r2.y; out[10]=r2.z; out[11]=0;
    out[12]=tr.x; out[13]=tr.y; out[14]=tr.z; out[15]=1;
}

// Extract ForestPack instances from a Forest object node.
// Instance TMs are in local coords of the Forest object — multiplied by the node's world TM.
static bool ExtractForestPackInstances(INode* fpNode, TimeValue t,
                                       std::vector<ForestInstanceGroup>& outGroups) {
    if (!IsForestPackAvailable()) return false;
    if (!IsForestPackNode(fpNode)) return false;
    RegisterForestPackEngine();

    ITreesInterface* itrees = nullptr;
    if (!SafeGetForestInterface(fpNode, &itrees)) return false;

    TForestInstance* instances = nullptr;
    int numInstances = 0;
    if (!SafeForestRenderBegin(itrees, t, &instances, &numInstances)) return false;

    // Forest node's world TM — instance TMs are in local coords, need world
    // API says "multiply by the INode TM" — GetNodeTM(), not GetObjTMAfterWSM()
    Matrix3 nodeTM = fpNode->GetNodeTM(t);

    std::unordered_map<uintptr_t, size_t> keyToGroupIdx;

    for (int i = 0; i < numInstances; i++) {
        TForestInstance& fi = instances[i];
        if (!fi.mesh && !fi.node) continue;

        // Group by mesh pointer when available, else by node handle
        uintptr_t groupKey = fi.mesh ? reinterpret_cast<uintptr_t>(fi.mesh)
                                     : static_cast<uintptr_t>(fi.node->GetHandle());
        size_t groupIdx;

        auto it = keyToGroupIdx.find(groupKey);
        if (it != keyToGroupIdx.end()) {
            groupIdx = it->second;
        } else {
            groupIdx = outGroups.size();
            keyToGroupIdx[groupKey] = groupIdx;
            outGroups.emplace_back();
            ForestInstanceGroup& grp = outGroups.back();
            grp.kind = InstanceGroupKind::ForestPack;
            grp.groupKey = groupKey;
            grp.ownerKey = static_cast<uintptr_t>(fpNode->GetHandle());

            // Extract geometry — prefer fi.mesh (raw Mesh*), fall back to fi.node
            if (fi.mesh) {
                ExtractMeshFromRawMesh(*fi.mesh, grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
            } else if (fi.node) {
                ExtractMesh(fi.node, t, grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
            }

            // Material: per-instance mtl override, source node mtl, or FP node mtl
            grp.mtl = fi.mtl ? fi.mtl : (fi.node ? fi.node->GetMtl() : fpNode->GetMtl());
            grp.mtlNode = fi.node ? fi.node : fpNode;
        }

        ForestInstanceGroup& grp = outGroups[groupIdx];

        // Instance TM (local) * Forest node TM → world TM
        Matrix3 worldTM = fi.tm * nodeTM;
        float xform[16];
        Matrix3To16(worldTM, xform);
        grp.transforms.insert(grp.transforms.end(), xform, xform + 16);
        grp.instanceCount++;
    }

    itrees->IForestClearRenderNodes();
    itrees->IForestRenderEnd(t);
    return !outGroups.empty();
}

// ══════════════════════════════════════════════════════════════
//  RailClone Instance Extraction
// ══════════════════════════════════════════════════════════════

static bool IsRailCloneClassID(const Class_ID& id) {
    return id == TRAIL_CLASS_ID || id == TRAIL_PROXY_CLASS_ID;
}

static bool IsRailCloneNode(INode* node) {
    if (!node) return false;
    Object* base = GetBaseObject(node->GetObjectRef());
    return base && IsRailCloneClassID(base->ClassID());
}

static bool IsRailCloneAvailable() {
    static int cached = -1;
    if (cached < 0) {
        cached = (GetModuleHandleW(L"railclonepro.dlo") != nullptr ||
                  GetModuleHandleW(L"RailClone.dlo") != nullptr ||
                  GetModuleHandleW(L"RailClonePro.dlo") != nullptr) ? 1 : 0;
    }
    return cached == 1;
}

static bool g_rcEngineRegistered = false;
static TRCEngineFeatures g_rcFeatures;

static void RegisterRailCloneEngine() {
    if (g_rcEngineRegistered) return;
    __try {
        IRCStaticInterface* isrc = GetRCStaticInterface();
        if (!isrc) return;
        isrc->IRCRegisterEngine();
        g_rcFeatures.supportNoGeomObjects = false;
        if (isrc->functions.Count() > 2)
            isrc->IRCSetEngineFeatures((INT_PTR)&g_rcFeatures);
        g_rcEngineRegistered = true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
}

static bool SafeGetRCInterface(INode* rcNode, IRCInterface** out) {
    __try {
        Object* base = GetBaseObject(rcNode->GetObjectRef());
        if (!base) return false;
        *out = GetRCInterface(base);
        return *out != nullptr;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// SEH wrappers for RailClone API calls (can't mix __try with C++ objects)
static bool SafeRCRenderBegin(IRCInterface* irc, TimeValue t) {
    __try { irc->IRCRenderBegin(t); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static Mesh** SafeRCGetMeshes(IRCInterface* irc, int* numMeshes) {
    __try { return reinterpret_cast<Mesh**>(irc->IRCGetMeshes(*numMeshes)); }
    __except (EXCEPTION_EXECUTE_HANDLER) { *numMeshes = 0; return nullptr; }
}
static TRCInstance* SafeRCGetInstances(IRCInterface* irc, int* numInstances) {
    __try { return RCGetInstances(irc, g_rcFeatures, *numInstances); }
    __except (EXCEPTION_EXECUTE_HANDLER) { *numInstances = 0; return nullptr; }
}
static void SafeRCRenderEnd(IRCInterface* irc, TimeValue t) {
    __try { irc->IRCClearInstances(); irc->IRCClearMeshes(); irc->IRCRenderEnd(t); }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
}

// Reuses ForestInstanceGroup for output (same structure: mesh + transforms)
static bool ExtractRailCloneInstances(INode* rcNode, TimeValue t,
                                      std::vector<ForestInstanceGroup>& outGroups) {
    if (!IsRailCloneAvailable()) return false;
    if (!IsRailCloneNode(rcNode)) return false;
    RegisterRailCloneEngine();

    IRCInterface* irc = nullptr;
    if (!SafeGetRCInterface(rcNode, &irc)) return false;
    if (!SafeRCRenderBegin(irc, t)) return false;

    // Get unique meshes
    int numMeshes = 0;
    Mesh** pmeshes = SafeRCGetMeshes(irc, &numMeshes);

    // Build mesh pointer → group index map, extract geometry for each unique mesh
    std::unordered_map<uintptr_t, size_t> meshToGroupIdx;
    if (pmeshes && numMeshes > 0) {
        for (int m = 0; m < numMeshes; m++) {
            if (!pmeshes[m]) continue;
            uintptr_t key = reinterpret_cast<uintptr_t>(pmeshes[m]);
            if (meshToGroupIdx.count(key)) continue;
            size_t idx = outGroups.size();
            meshToGroupIdx[key] = idx;
            outGroups.emplace_back();
            ForestInstanceGroup& grp = outGroups.back();
            grp.kind = InstanceGroupKind::RailClone;
            grp.groupKey = key;
            grp.ownerKey = static_cast<uintptr_t>(rcNode->GetHandle());
            grp.requiresSubobjectMaterials = true;
            ExtractMeshFromRawMesh(*pmeshes[m], grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
            // RailClone: all segments use the RC node's material
            grp.mtl = rcNode->GetMtl();
            grp.mtlNode = rcNode;
        }
    }

    // Get instances
    int numInstances = 0;
    TRCInstance* inst = SafeRCGetInstances(irc, &numInstances);

    Matrix3 nodeTM = rcNode->GetNodeTM(t);

    if (inst && numInstances > 0) {
        for (int i = 0; i < numInstances; i++) {
            if (!inst->mesh) {
                inst = RCGetNextInstance(inst, g_rcFeatures);
                continue;
            }
            uintptr_t key = reinterpret_cast<uintptr_t>(inst->mesh);
            auto it = meshToGroupIdx.find(key);
            if (it == meshToGroupIdx.end()) {
                size_t idx = outGroups.size();
                meshToGroupIdx[key] = idx;
                outGroups.emplace_back();
                ForestInstanceGroup& grp = outGroups.back();
                grp.kind = InstanceGroupKind::RailClone;
                grp.groupKey = key;
                grp.ownerKey = static_cast<uintptr_t>(rcNode->GetHandle());
                grp.requiresSubobjectMaterials = true;
                ExtractMeshFromRawMesh(*inst->mesh, grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
                // Per-segment material override (RCv4+), or RC node material
                if (RCisV4(g_rcFeatures)) {
                    TRCInstanceV400* rci4 = static_cast<TRCInstanceV400*>(inst);
                    grp.mtl = rci4->mtl ? rci4->mtl : rcNode->GetMtl();
                } else {
                    grp.mtl = rcNode->GetMtl();
                }
                grp.mtlNode = rcNode;
                it = meshToGroupIdx.find(key);
            }

            ForestInstanceGroup& grp = outGroups[it->second];
            Matrix3 worldTM = inst->tm * nodeTM;
            float xform[16];
            Matrix3To16(worldTM, xform);
            grp.transforms.insert(grp.transforms.end(), xform, xform + 16);
            grp.instanceCount++;

            inst = RCGetNextInstance(inst, g_rcFeatures);
        }
    }

    SafeRCRenderEnd(irc, t);
    return !outGroups.empty();
}

// ══════════════════════════════════════════════════════════════
//  tyFlow Particle Instance Extraction
// ══════════════════════════════════════════════════════════════

#define TYFLOW_CLASS_ID   Class_ID(825370769, 1895152074)

static bool IsTyFlowClassID(const Class_ID& id) {
    return id == TYFLOW_CLASS_ID;
}

static bool IsTyFlowNode(INode* node) {
    if (!node) return false;
    Object* base = GetBaseObject(node->GetObjectRef());
    return base && IsTyFlowClassID(base->ClassID());
}

static bool IsTyFlowAvailable() {
    static int cached = -1;
    if (cached < 0) {
        cached = (GetModuleHandleW(L"tyFlow_2026.dlo") != nullptr ||
                  GetModuleHandleW(L"tyFlow.dlo") != nullptr) ? 1 : 0;
    }
    return cached == 1;
}

// SEH wrappers for tyFlow API
static tyFlow::tyParticleInterface* SafeGetTyInterface(INode* node) {
    __try {
        Object* base = GetBaseObject(node->GetObjectRef());
        if (!base) return nullptr;
        return tyFlow::GetTyParticleInterfaceForced(static_cast<BaseObject*>(base));
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { return nullptr; }
}

// Can't use __try here due to TSTR having a destructor — call directly
static tyFlow::tyVector<tyFlow::tyInstanceInfo>* SafeTyCollectInstances(
    tyFlow::tyParticleInterface* tyObj, INode* node, TimeValue t) {
    return tyObj->CollectInstances(
        node, tyFlow::DataFlags::mesh, t, t, _T("maxjs"));
}

static void SafeTyReleaseInstances(tyFlow::tyParticleInterface* tyObj,
                                   tyFlow::tyVector<tyFlow::tyInstanceInfo>* inst) {
    __try { tyObj->ReleaseInstances(inst); }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
}

static bool ExtractTyFlowInstances(INode* tyNode, TimeValue t,
                                   std::vector<ForestInstanceGroup>& outGroups) {
    if (!IsTyFlowAvailable()) return false;
    if (!IsTyFlowNode(tyNode)) return false;

    tyFlow::tyParticleInterface* tyObj = SafeGetTyInterface(tyNode);
    if (!tyObj) return false;

    tyFlow::tyVector<tyFlow::tyInstanceInfo>* infos =
        SafeTyCollectInstances(tyObj, tyNode, t);
    if (!infos || infos->size() == 0) return false;

    Matrix3 nodeTM = tyNode->GetNodeTM(t);

    std::unordered_map<uintptr_t, size_t> meshToGroupIdx;

    for (size_t g = 0; g < infos->size(); g++) {
        tyFlow::tyInstanceInfo& info = (*infos)[g];
        if (!(info.flags & tyFlow::DataFlags::mesh) || !info.data) continue;

        Mesh* srcMesh = static_cast<Mesh*>(info.data);
        uintptr_t key = reinterpret_cast<uintptr_t>(srcMesh);

        // Extract geometry once per unique mesh
        auto it = meshToGroupIdx.find(key);
        if (it == meshToGroupIdx.end()) {
            size_t idx = outGroups.size();
            meshToGroupIdx[key] = idx;
            outGroups.emplace_back();
            ForestInstanceGroup& grp = outGroups.back();
            grp.kind = InstanceGroupKind::TyFlow;
            grp.groupKey = key;
            grp.ownerKey = static_cast<uintptr_t>(tyNode->GetHandle());
            ExtractMeshFromRawMesh(*srcMesh, grp.verts, grp.uvs, grp.indices, grp.groups, &grp.norms);
            // tyFlow: use node material (instance overrides handled below)
            grp.mtl = tyNode->GetMtl();
            grp.mtlNode = tyNode;
            it = meshToGroupIdx.find(key);
        }

        ForestInstanceGroup& grp = outGroups[it->second];

        // Each tyInstance has a tyVector<Matrix3> tms — use tms[0] for current frame
        for (size_t i = 0; i < info.instances.size(); i++) {
            tyFlow::tyInstance& inst = info.instances[i];
            if (inst.tms.size() == 0) continue;

            Matrix3 worldTM = inst.tms[0] * nodeTM;
            float xform[16];
            Matrix3To16(worldTM, xform);
            grp.transforms.insert(grp.transforms.end(), xform, xform + 16);
            grp.instanceCount++;
        }

        // Clean up mesh if flagged
        if (info.flags & tyFlow::DataFlags::pluginMustDelete) {
            delete srcMesh;
            info.data = nullptr;
        }
    }

    SafeTyReleaseInstances(tyObj, infos);
    return !outGroups.empty();
}

// ══════════════════════════════════════════════════════════════
//  tyFlow Volume Extraction (smoke/fire)
// ══════════════════════════════════════════════════════════════

struct VolumeData {
    ULONG handle;
    int dimX, dimY, dimZ;           // voxel counts
    float voxelSize[3];             // world-space size per voxel
    float origin[3];                // world origin (first voxel center)
    float transform[16];            // world transform of the volume
    std::vector<float> density;     // flat density array [dimX * dimY * dimZ]
    float stepSize = 1.0f;          // raymarching step size
};

static bool ExtractTyFlowVolumes(INode* tyNode, TimeValue t,
                                 std::vector<VolumeData>& outVolumes) {
    if (!IsTyFlowAvailable()) return false;
    if (!IsTyFlowNode(tyNode)) return false;

    Object* base = GetBaseObject(tyNode->GetObjectRef());
    if (!base) return false;

    // Try v3 first (has step size + fuel color), fall back to v1
    tyFlow::tyVolumeObjectExt_v3* volIf3 = tyFlow::GetTyVolumeInterface_v3(static_cast<BaseObject*>(base));
    tyFlow::tyVolumeObjectExt_v1* volIf = volIf3
        ? static_cast<tyFlow::tyVolumeObjectExt_v1*>(volIf3)
        : tyFlow::GetTyVolumeInterface_v1(static_cast<BaseObject*>(base));
    if (!volIf) return false;

    volIf->UpdateVolumes(t, _T("maxjs"));

    int numVolumes = volIf->NumVolumes();
    if (numVolumes <= 0) {
        volIf->ReleaseVolumes();
        return false;
    }

    float stepSize = volIf3 ? volIf3->GetVolumeRaymarchingStepSize() : 1.0f;

    // For the combined bounding box, all volumes share same dimensions/scale (axiom 1)
    tyFlow::tyVolume_v1* vol0 = volIf->GetVolume(0);
    if (!vol0) { volIf->ReleaseVolumes(); return false; }

    IPoint3 dim = vol0->dimensions;
    if (dim.x <= 0 || dim.y <= 0 || dim.z <= 0) {
        volIf->ReleaseVolumes();
        return false;
    }

    // Compute voxel size from the transform (scale of axes / dimensions)
    Matrix3 tm0 = vol0->transform;
    Point3 axisX = tm0.GetRow(0);
    Point3 axisY = tm0.GetRow(1);
    Point3 axisZ = tm0.GetRow(2);
    float voxelSizeX = axisX.Length() / (float)dim.x;
    float voxelSizeY = axisY.Length() / (float)dim.y;
    float voxelSizeZ = axisZ.Length() / (float)dim.z;

    // For MVP: extract each volume block as a separate VolumeData
    // (JS side will render each as a separate volume)
    for (int vi = 0; vi < numVolumes; vi++) {
        tyFlow::tyVolume_v1* vol = volIf->GetVolume(vi);
        if (!vol) continue;

        VolumeData vd;
        vd.handle = tyNode->GetHandle();
        vd.dimX = dim.x;
        vd.dimY = dim.y;
        vd.dimZ = dim.z;
        vd.voxelSize[0] = voxelSizeX;
        vd.voxelSize[1] = voxelSizeY;
        vd.voxelSize[2] = voxelSizeZ;
        vd.stepSize = stepSize;

        // Volume origin in world space
        Point3 orig = vol->transform.GetTrans();
        vd.origin[0] = orig.x;
        vd.origin[1] = orig.y;
        vd.origin[2] = orig.z;

        Matrix3To16(vol->transform, vd.transform);

        // Extract density voxels
        int totalVoxels = dim.x * dim.y * dim.z;
        vd.density.resize(totalVoxels);

        for (int z = 0; z < dim.z; z++) {
            for (int y = 0; y < dim.y; y++) {
                for (int x = 0; x < dim.x; x++) {
                    Point3 coord((float)x, (float)y, (float)z);
                    float d = vol->GetScalar(coord, tyFlow::tyVolume_v1::density);
                    vd.density[x + y * dim.x + z * dim.x * dim.y] = d;
                }
            }
        }

        outVolumes.push_back(std::move(vd));
    }

    volIf->ReleaseVolumes();
    return !outVolumes.empty();
}

// ══════════════════════════════════════════════════════════════
//  Environment HDRI — full param extraction
// ══════════════════════════════════════════════════════════════

struct EnvData {
    bool hasMap = false;
    bool hasHdri = false;
    std::wstring hdriPath;
    float rotation = 0;
    float exposure = 0;
    float gamma = 1.0f;
    int   zup = 0;
    int   flip = 0;

    // ThreeJS Sky (when env map is ThreeJS Sky texmap)
    bool  isSky = false;
    float skyTurbidity  = 10.0f;
    float skyRayleigh   = 3.0f;
    float skyMieCoeff   = 0.005f;
    float skyMieDirG    = 0.7f;
    float skyElevation  = 2.0f;
    float skyAzimuth    = 180.0f;
    float skyExposure   = 0.5f;
    int   skyModel      = threejs_sky_model_classic;
    bool  skyShowSunDisc = true;
    float skyPlanetAltitude = 1200.0f;
};

// Generic: find a named float/int/string in any paramblock of a map
static float FindPBFloat(Texmap* map, const MCHAR* name, float def) {
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 && pd.type == TYPE_FLOAT)
                return pb->GetFloat(pid);
        }
    }
    return def;
}

static int FindPBInt(Texmap* map, const MCHAR* name, int def) {
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 &&
                (pd.type == TYPE_INT || pd.type == TYPE_BOOL))
                return pb->GetInt(pid);
        }
    }
    return def;
}

static std::wstring FindPBString(Texmap* map, const MCHAR* name) {
    for (int b = 0; b < map->NumParamBlocks(); b++) {
        IParamBlock2* pb = map->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 &&
                (pd.type == TYPE_STRING || pd.type == TYPE_FILENAME)) {
                const MCHAR* s = pb->GetStr(pid);
                return s ? s : L"";
            }
        }
    }
    return {};
}

static std::wstring FindPBString(Mtl* mtl, const MCHAR* name) {
    if (!mtl) return {};
    for (int b = 0; b < mtl->NumParamBlocks(); b++) {
        IParamBlock2* pb = mtl->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 &&
                (pd.type == TYPE_STRING || pd.type == TYPE_FILENAME)) {
                const MCHAR* s = pb->GetStr(pid);
                return s ? s : L"";
            }
        }
    }
    return {};
}

static int FindPBInt(Mtl* mtl, const MCHAR* name, int def) {
    if (!mtl) return def;
    for (int b = 0; b < mtl->NumParamBlocks(); b++) {
        IParamBlock2* pb = mtl->GetParamBlock(b);
        if (!pb) continue;
        for (int i = 0; i < pb->NumParams(); i++) {
            ParamID pid = pb->IndextoID(i);
            const ParamDef& pd = pb->GetParamDef(pid);
            if (pd.int_name && _tcsicmp(pd.int_name, name) == 0 &&
                (pd.type == TYPE_INT || pd.type == TYPE_BOOL)) {
                return pb->GetInt(pid);
            }
        }
    }
    return def;
}

static void GetEnvironment(EnvData& env) {
    env = EnvData{};
    Texmap* envMap = GetCOREInterface()->GetEnvironmentMap();
    if (!envMap) return;
    env.hasMap = true;

    // Check if env map is ThreeJS Sky
    if (IsThreeJSSkyClassID(envMap->ClassID())) {
        IParamBlock2* pb = envMap->GetParamBlock(0);
        if (pb) {
            env.isSky = true;
            env.skyTurbidity = pb->GetFloat(psky_turbidity);
            env.skyRayleigh  = pb->GetFloat(psky_rayleigh);
            env.skyMieCoeff  = pb->GetFloat(psky_mie_coeff);
            env.skyMieDirG   = pb->GetFloat(psky_mie_dir_g);
            env.skyElevation = pb->GetFloat(psky_elevation);
            env.skyAzimuth   = pb->GetFloat(psky_azimuth);
            env.skyExposure  = pb->GetFloat(psky_exposure);
            env.skyModel     = pb->GetInt(psky_model);
            env.skyShowSunDisc = pb->GetInt(psky_show_sun_disc) != 0;
            env.skyPlanetAltitude = pb->GetFloat(psky_planet_altitude);
        }
        return;
    }

    // Try named string param "HDRI" first (OSL HDRI Environment)
    env.hdriPath = FindPBString(envMap, _T("HDRI"));
    if (env.hdriPath.empty() || !IsImageFile(env.hdriPath.c_str())) {
        // Fallback: walk for any image file
        env.hdriPath = FindBitmapFile(envMap);
    }
    env.hasHdri = !env.hdriPath.empty() && IsImageFile(env.hdriPath.c_str());

    // Read OSL HDRI Environment params
    env.rotation = FindPBFloat(envMap, _T("rotation"), 0);
    env.exposure = FindPBFloat(envMap, _T("exposure"), 0);
    env.gamma    = FindPBFloat(envMap, _T("gamma"), 1.0f);
    env.zup      = FindPBInt(envMap, _T("zup"), 0);
    env.flip     = FindPBInt(envMap, _T("flip"), 0);
}

// ══════════════════════════════════════════════════════════════
//  ThreeJS Fog — read from Rendering > Environment > Atmosphere
// ══════════════════════════════════════════════════════════════

struct FogData {
    bool active = false;
    int  type   = 0;        // 0=Range, 1=Density, 2=Custom
    float r = 0.85f, g = 0.85f, b = 0.9f;
    float opacity    = 1.0f;
    float nearDist   = 10.0f;
    float farDist    = 500.0f;
    float density    = 0.01f;
    float noiseScale = 0.005f;
    float noiseSpeed = 0.2f;
    float height     = 20.0f;
};

static void GetFogData(FogData& fog) {
    fog = FogData{};
    Interface* ip = GetCOREInterface();
    if (!ip) return;

    int numAtmos = ip->NumAtmospheric();
    for (int i = 0; i < numAtmos; i++) {
        Atmospheric* atm = ip->GetAtmospheric(i);
        if (!atm || !IsThreeJSFogClassID(atm->ClassID())) continue;
        if (!atm->Active(ip->GetTime())) continue;

        IParamBlock2* pb = atm->GetParamBlock(0);
        if (!pb) continue;

        fog.active   = true;
        fog.type     = pb->GetInt(pf_type);
        Color c      = pb->GetColor(pf_color);
        fog.r = c.r; fog.g = c.g; fog.b = c.b;
        fog.opacity    = pb->GetFloat(pf_opacity);
        fog.nearDist   = pb->GetFloat(pf_near);
        fog.farDist    = pb->GetFloat(pf_far);
        fog.density    = pb->GetFloat(pf_density);
        fog.noiseScale = pb->GetFloat(pf_noise_scale);
        fog.noiseSpeed = pb->GetFloat(pf_noise_speed);
        fog.height     = pb->GetFloat(pf_height);
        break;  // use first active ThreeJS Fog
    }
}

static void WriteFogJson(std::wostringstream& ss, const FogData& fog) {
    ss << L"\"fog\":{\"active\":" << (fog.active ? L'1' : L'0');
    ss << L",\"type\":" << fog.type;
    ss << L",\"color\":[" << fog.r << L',' << fog.g << L',' << fog.b << L']';
    ss << L",\"opacity\":" << fog.opacity;
    ss << L",\"near\":" << fog.nearDist;
    ss << L",\"far\":" << fog.farDist;
    ss << L",\"density\":" << fog.density;
    ss << L",\"noiseScale\":" << fog.noiseScale;
    ss << L",\"noiseSpeed\":" << fog.noiseSpeed;
    ss << L",\"height\":" << fog.height;
    ss << L'}';
}

// Helper: write full env JSON block (includes sky or HDRI data)
static void WriteEnvJson(std::wostringstream& ss, const EnvData& env,
                         const std::wstring& hdriUrl = {}) {
    const bool hasHdriUrl = !hdriUrl.empty();
    const bool enabled = env.isSky || hasHdriUrl;
    ss << L"\"env\":{";
    ss << L"\"enabled\":" << (enabled ? L"true" : L"false");
    if (env.isSky) {
        ss << L",\"type\":\"sky\"";
        ss << L",\"sky\":{";
        ss << L"\"turbidity\":" << env.skyTurbidity;
        ss << L",\"rayleigh\":" << env.skyRayleigh;
        ss << L",\"mieCoefficient\":" << env.skyMieCoeff;
        ss << L",\"mieDirectionalG\":" << env.skyMieDirG;
        ss << L",\"elevation\":" << env.skyElevation;
        ss << L",\"azimuth\":" << env.skyAzimuth;
        ss << L",\"exposure\":" << env.skyExposure;
        ss << L",\"model\":" << env.skyModel;
        ss << L",\"showSunDisc\":" << (env.skyShowSunDisc ? L"true" : L"false");
        ss << L",\"cameraAltitude\":" << env.skyPlanetAltitude;
        ss << L'}';
    } else if (hasHdriUrl) {
        ss << L",\"type\":\"hdri\"";
        ss << L",\"hdri\":\"" << EscapeJson(hdriUrl.c_str()) << L"\"";
        ss << L",\"rot\":";
        WriteFloatValue(ss, env.rotation, 0.0f);
        ss << L",\"exp\":";
        WriteFloatValue(ss, env.exposure, 0.0f);
        ss << L",\"gamma\":";
        WriteFloatValue(ss, env.gamma, 1.0f);
        ss << L",\"zup\":" << env.zup;
        ss << L",\"flip\":" << env.flip;
    } else {
        ss << L",\"type\":\"none\"";
    }
    ss << L'}';
}

// ── Scene change notification ─────────────────────────────────

static void OnSceneChanged(void* param, NotifyInfo*);

class MaxJSFastNodeEventCallback : public INodeEventCallback {
public:
    explicit MaxJSFastNodeEventCallback(MaxJSPanel* owner) : owner_(owner) {}

    void ControllerStructured(NodeKeyTab& nodes) override;
    void ControllerOtherEvent(NodeKeyTab& nodes) override;
    void LinkChanged(NodeKeyTab& nodes) override;
    void SelectionChanged(NodeKeyTab& nodes) override;
    void HideChanged(NodeKeyTab& nodes) override;
    void GeometryChanged(NodeKeyTab& nodes) override;
    void TopologyChanged(NodeKeyTab& nodes) override;
    void MaterialStructured(NodeKeyTab& nodes) override;
    void MaterialOtherEvent(NodeKeyTab& nodes) override;

private:
    MaxJSPanel* owner_;
};

class MaxJSFastRedrawCallback : public RedrawViewsCallback {
public:
    explicit MaxJSFastRedrawCallback(MaxJSPanel* owner) : owner_(owner) {}

    void proc(Interface* ip) override;

private:
    MaxJSPanel* owner_;
};

class MaxJSFastTimeChangeCallback : public TimeChangeCallback {
public:
    explicit MaxJSFastTimeChangeCallback(MaxJSPanel* owner) : owner_(owner) {}

    void TimeChanged(TimeValue t) override;

private:
    MaxJSPanel* owner_;
};
