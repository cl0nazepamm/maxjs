#pragma once

#include <max.h>
#include <triobj.h>
#include <polyobj.h>
#include <MeshNormalSpec.h>
#include <MNNormalSpec.h>
#include <iepoly.h>
#include <iEPolyMod.h>
#include <mnmesh.h>
#include <splshape.h>
#include <modstack.h>
#include <Scene/IHairModifier.h>

#include "maxjs_core_utils.h"
#include "threejs_deform.h"
#include "threejs_splat.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <immintrin.h>
#include <intrin.h>
#include <memory>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>
#include <ppl.h>

// Runtime AVX2 dispatch — Max 2026's official baseline is SSE4.2, so the
// AVX2 kernels are CPUID-gated instead of compiled with /arch:AVX2 (MSVC
// emits VEX for _mm256 intrinsics without the flag, so mixing is safe as
// long as the guarded paths never execute on older CPUs).
static bool DetectAvx2Support() {
    int info[4] = {};
    __cpuid(info, 0);
    if (info[0] < 7) return false;
    __cpuid(info, 1);
    const bool osxsave = (info[2] & (1 << 27)) != 0;
    const bool avx = (info[2] & (1 << 28)) != 0;
    if (!osxsave || !avx) return false;
    if ((_xgetbv(0) & 0x6) != 0x6) return false; // OS saves ymm state
    __cpuidex(info, 7, 0);
    return (info[1] & (1 << 5)) != 0; // AVX2
}
inline const bool g_maxjsHasAvx2 = DetectAvx2Support();

static float SafeJsonFloat(float value, float fallback = 0.0f) {
    if (!std::isfinite(value)) return fallback;
    if (std::fabs(value) > 1.0e15f) return fallback;
    return value;
}

static void WriteFloatValue(std::wostringstream& ss, float value, float fallback = 0.0f) {
    ss << SafeJsonFloat(value, fallback);
}

static void WriteFloats(std::wostringstream& ss, const float* d, size_t n) {
    ss << L'[';
    for (size_t i = 0; i < n; i++) {
        if (i) ss << L',';
        WriteFloatValue(ss, d[i]);
    }
    ss << L']';
}

static void WriteInts(std::wostringstream& ss, const int* d, size_t n) {
    ss << L'[';
    for (size_t i = 0; i < n; i++) { if (i) ss << L','; ss << d[i]; }
    ss << L']';
}

struct VertexColorAttributeRecord {
    int channel = 0;
    std::string attrName;
    std::vector<float> values;
    size_t off = 0;
};

static std::wstring WidenAscii(const std::string& s) {
    return std::wstring(s.begin(), s.end());
}

static std::string GetVertexColorAttributeName(int channel) {
    if (channel == 0) return "color";
    if (channel == MAP_SHADING) return "maxjs_vc_shading";
    if (channel == MAP_ALPHA) return "maxjs_vc_alpha";
    return "maxjs_vc_" + std::to_string(channel);
}

static bool ShouldAllowVertexColorMapChannel1(INode* node) {
    return node &&
           node->GetVertexColorType() == nvct_map_channel &&
           node->GetVertexColorMapChannel() == 1;
}

static void AppendVertexColorValue(std::vector<float>& dst, const UVVert& value, int channel) {
    if (channel == MAP_ALPHA) {
        dst.push_back(value.x);
        dst.push_back(value.x);
        dst.push_back(value.x);
        dst.push_back(value.x);
        return;
    }

    dst.push_back(value.x);
    dst.push_back(value.y);
    dst.push_back(value.z);
    dst.push_back(1.0f);
}

static UVVert DefaultVertexColorValue(int channel) {
    if (channel == MAP_ALPHA) return UVVert(1.0f, 1.0f, 1.0f);
    return UVVert(0.0f, 0.0f, 0.0f);
}

static bool IsDefaultVertexColorAttribute(const VertexColorAttributeRecord& attr,
                                          float epsilon = 1.0e-6f) {
    if (attr.values.empty() || (attr.values.size() % 4) != 0) return false;

    const bool alphaChannel = attr.channel == MAP_ALPHA;
    for (size_t i = 0; i < attr.values.size(); i += 4) {
        const float expectedRgb = alphaChannel ? 1.0f : 0.0f;
        const float expectedAlpha = 1.0f;
        const float r = attr.values[i + 0];
        const float g = attr.values[i + 1];
        const float b = attr.values[i + 2];
        const float a = attr.values[i + 3];
        if (!std::isfinite(r) || !std::isfinite(g) ||
            !std::isfinite(b) || !std::isfinite(a)) {
            return false;
        }
        if (std::fabs(r - expectedRgb) > epsilon ||
            std::fabs(g - expectedRgb) > epsilon ||
            std::fabs(b - expectedRgb) > epsilon ||
            std::fabs(a - expectedAlpha) > epsilon) {
            return false;
        }
    }
    return true;
}

static void TrimDefaultVertexColorAttributes(std::vector<VertexColorAttributeRecord>& attrs) {
    attrs.erase(
        std::remove_if(
            attrs.begin(),
            attrs.end(),
            [](const VertexColorAttributeRecord& attr) {
                return attr.values.empty() || IsDefaultVertexColorAttribute(attr);
            }),
        attrs.end());
}

// ── Deform weight channel (three.js Deform + sub-object selection) ──
// A Poly Select / Vol. Select below the three.js Deform modifier (or an Edit
// Poly soft selection above it) leaves the pipeline's vertex selection and
// soft-selection falloff in the evaluated mesh. Captured per SOURCE vertex
// here, expanded per render vertex through the controlIdx mapping, and
// shipped as the "deformWeight" vc channel so the web runtime exposes it as
// a geometry attribute. Packed (w,w,w,w) so an all-zero selection never
// matches the default-channel trim patterns. Object-level selection emits
// nothing — absence means "weight 1 everywhere" on the web side.
static constexpr const char* kDeformWeightAttrName = "deformWeight";
static constexpr int kDeformWeightChannel = -100;

static bool NodeHasThreeJSDeformModifier(INode* node) {
    if (!node) return false;
    Object* obj = node->GetObjectRef();
    while (obj && obj->SuperClassID() == GEN_DERIVOB_CLASS_ID) {
        IDerivedObject* dobj = static_cast<IDerivedObject*>(obj);
        for (int i = 0; i < dobj->NumModifiers(); i++) {
            Modifier* mod = dobj->GetModifier(i);
            if (mod && mod->IsEnabled() && IsThreeJSDeformClassID(mod->ClassID())) return true;
        }
        obj = dobj->GetObjRef();
    }
    return false;
}

// Canonical Max deformer weighting: hard-selected verts are 1, otherwise the
// soft-selection falloff weight (0 when none). Mirrors how SimpleMod-style
// modifiers consume the selection channel.
static bool CaptureMeshDeformWeights(Mesh& mesh, std::vector<float>& out) {
    if (mesh.selLevel == MESH_OBJECT) return false;
    const int numVerts = mesh.getNumVerts();
    if (numVerts <= 0) return false;
    BitArray sel = mesh.VertexTempSel();
    const float* vsw = mesh.getVSelectionWeights();
    out.resize(static_cast<size_t>(numVerts));
    for (int i = 0; i < numVerts; ++i) {
        const bool hard = i < sel.GetSize() && sel[i];
        const float w = hard ? 1.0f : (vsw ? vsw[i] : 0.0f);
        out[static_cast<size_t>(i)] = std::clamp(w, 0.0f, 1.0f);
    }
    return true;
}

static bool CaptureMNMeshDeformWeights(MNMesh& mn, std::vector<float>& out) {
    if (mn.selLevel == MNM_SL_OBJECT) return false;
    const int numVerts = mn.numv;
    if (numVerts <= 0) return false;
    BitArray sel = mn.VertexTempSel();
    const float* vsw = mn.getVSelectionWeights();
    out.resize(static_cast<size_t>(numVerts));
    for (int i = 0; i < numVerts; ++i) {
        const bool hard = i < sel.GetSize() && sel[i];
        const float w = hard ? 1.0f : (vsw ? vsw[i] : 0.0f);
        out[static_cast<size_t>(i)] = std::clamp(w, 0.0f, 1.0f);
    }
    return true;
}

static void AppendDeformWeightChannel(const std::vector<float>& srcWeights,
                                      const std::vector<int>& controlIdx,
                                      std::vector<VertexColorAttributeRecord>* outVertexColors) {
    if (!outVertexColors || srcWeights.empty() || controlIdx.empty()) return;
    VertexColorAttributeRecord attr;
    attr.channel = kDeformWeightChannel;
    attr.attrName = kDeformWeightAttrName;
    attr.values.reserve(controlIdx.size() * 4);
    for (const int src : controlIdx) {
        const float w = (src >= 0 && src < static_cast<int>(srcWeights.size()))
            ? srcWeights[static_cast<size_t>(src)]
            : 1.0f;
        attr.values.push_back(w);
        attr.values.push_back(w);
        attr.values.push_back(w);
        attr.values.push_back(w);
    }
    outVertexColors->push_back(std::move(attr));
}

static void WriteVertexColorAttributesJson(std::wostringstream& ss,
                                           const std::vector<VertexColorAttributeRecord>& attrs) {
    if (attrs.empty()) return;
    ss << L",\"vc\":[";
    for (size_t i = 0; i < attrs.size(); ++i) {
        if (i) ss << L',';
        const VertexColorAttributeRecord& attr = attrs[i];
        ss << L"{\"ch\":" << attr.channel;
        ss << L",\"name\":\"" << EscapeJson(WidenAscii(attr.attrName).c_str()) << L'"';
        ss << L",\"itemSize\":4";
        ss << L",\"v\":";
        WriteFloats(ss, attr.values.data(), attr.values.size());
        ss << L'}';
    }
    ss << L']';
}

static void WriteVertexColorOffsetsJson(std::wostringstream& ss,
                                        const std::vector<VertexColorAttributeRecord>& attrs) {
    if (attrs.empty()) return;
    ss << L",\"vc\":[";
    for (size_t i = 0; i < attrs.size(); ++i) {
        if (i) ss << L',';
        const VertexColorAttributeRecord& attr = attrs[i];
        ss << L"{\"ch\":" << attr.channel;
        ss << L",\"name\":\"" << EscapeJson(WidenAscii(attr.attrName).c_str()) << L'"';
        ss << L",\"itemSize\":4";
        ss << L",\"off\":" << attr.off;
        ss << L",\"n\":" << attr.values.size();
        ss << L'}';
    }
    ss << L']';
}

static uint64_t HashFNV1a(const void* data, size_t bytes, uint64_t seed = 1469598103934665603ULL) {
    const unsigned char* p = static_cast<const unsigned char*>(data);
    constexpr uint64_t kPrime = 1099511628211ULL;
    uint64_t h = seed;
    size_t i = 0;
    if (bytes >= 64) {
        // Four independent FNV lanes over 32-byte blocks. A single FNV chain
        // is latency-bound on the serial multiply (~1.5 GB/s); four chains
        // run in the multiplier pipeline concurrently (~4x on bulk buffers,
        // which is what the per-tick geometry dedupe hashes are).
        uint64_t h0 = h;
        uint64_t h1 = h ^ 0x9E3779B97F4A7C15ULL;
        uint64_t h2 = h ^ 0xC2B2AE3D27D4EB4FULL;
        uint64_t h3 = h ^ 0x165667B19E3779F9ULL;
        for (; i + 31 < bytes; i += 32) {
            uint64_t a, b, c, d;
            memcpy(&a, p + i, 8);
            memcpy(&b, p + i + 8, 8);
            memcpy(&c, p + i + 16, 8);
            memcpy(&d, p + i + 24, 8);
            h0 = (h0 ^ a) * kPrime;
            h1 = (h1 ^ b) * kPrime;
            h2 = (h2 ^ c) * kPrime;
            h3 = (h3 ^ d) * kPrime;
        }
        h = h0;
        h = (h ^ h1) * kPrime;
        h = (h ^ h2) * kPrime;
        h = (h ^ h3) * kPrime;
    }
    if (bytes - i >= 16) {
        // Fold remaining 128-bit chunks via XOR + multiply cascade
        for (; i + 15 < bytes; i += 16) {
            uint64_t lo, hi;
            memcpy(&lo, p + i, 8);
            memcpy(&hi, p + i + 8, 8);
            h = (h ^ lo) * kPrime;
            h = (h ^ hi) * kPrime;
        }
    }
    for (; i < bytes; i++) {
        h = (h ^ static_cast<uint64_t>(p[i])) * kPrime;
    }
    return h;
}

static uint64_t HashIntervalState(const Interval& iv, uint64_t seed = 1469598103934665603ULL) {
    const int start = iv.Start();
    const int end = iv.End();
    uint64_t h = HashFNV1a(&start, sizeof(start), seed);
    return HashFNV1a(&end, sizeof(end), h);
}

static uint64_t HashMeshData(const std::vector<float>& verts,
                             const std::vector<int>& indices,
                             const std::vector<float>& uvs,
                             const std::vector<VertexColorAttributeRecord>* vertexColors = nullptr) {
    uint64_t h = 1469598103934665603ULL;
    if (!verts.empty())
        h = HashFNV1a(verts.data(), verts.size() * sizeof(float), h);
    if (!indices.empty())
        h = HashFNV1a(indices.data(), indices.size() * sizeof(int), h);
    if (!uvs.empty())
        h = HashFNV1a(uvs.data(), uvs.size() * sizeof(float), h);
    if (vertexColors) {
        const int count = static_cast<int>(vertexColors->size());
        h = HashFNV1a(&count, sizeof(count), h);
        for (const VertexColorAttributeRecord& attr : *vertexColors) {
            h = HashFNV1a(&attr.channel, sizeof(attr.channel), h);
            if (!attr.values.empty()) {
                h = HashFNV1a(attr.values.data(), attr.values.size() * sizeof(float), h);
            }
        }
    }
    return h;
}

// Block size for packing per-element fields into contiguous runs before
// hashing. Per-field HashFNV1a calls cost more than the hashing itself on
// large meshes; packing turns the state hash into a few bulk passes.
static constexpr int kHashPackBlock = 256;

struct PackedFaceHashState {
    DWORD v[3];
    DWORD smGroup;
    DWORD matID;
};

static uint64_t HashMeshState(Mesh& mesh) {
    uint64_t h = 1469598103934665603ULL;
    const int numVerts = mesh.getNumVerts();
    const int numFaces = mesh.getNumFaces();
    h = HashFNV1a(&numVerts, sizeof(numVerts), h);
    h = HashFNV1a(&numFaces, sizeof(numFaces), h);

    // Vertex positions are a contiguous Point3 array — one bulk pass.
    if (numVerts > 0 && mesh.verts) {
        h = HashFNV1a(mesh.verts, static_cast<size_t>(numVerts) * sizeof(Point3), h);
    }

    PackedFaceHashState block[kHashPackBlock];
    for (int base = 0; base < numFaces; base += kHashPackBlock) {
        const int n = std::min(kHashPackBlock, numFaces - base);
        for (int k = 0; k < n; ++k) {
            Face& face = mesh.faces[base + k];
            block[k].v[0] = face.v[0];
            block[k].v[1] = face.v[1];
            block[k].v[2] = face.v[2];
            block[k].smGroup = face.getSmGroup();
            block[k].matID = face.getMatID();
        }
        h = HashFNV1a(block, sizeof(PackedFaceHashState) * static_cast<size_t>(n), h);
    }

    return h;
}

static uint64_t HashMNMeshState(MNMesh& mn) {
    uint64_t h = 1469598103934665603ULL;
    const int numVerts = mn.VNum();
    const int numFaces = mn.FNum();
    h = HashFNV1a(&numVerts, sizeof(numVerts), h);
    h = HashFNV1a(&numFaces, sizeof(numFaces), h);

    struct PackedMNVertState { float x, y, z; DWORD dead; };
    PackedMNVertState vertBlock[kHashPackBlock];
    for (int base = 0; base < numVerts; base += kHashPackBlock) {
        const int n = std::min(kHashPackBlock, numVerts - base);
        for (int k = 0; k < n; ++k) {
            const int i = base + k;
            const MNVert* vert = mn.V(i);
            const Point3 p = mn.P(i);
            vertBlock[k] = { p.x, p.y, p.z,
                             (vert && vert->GetFlag(MN_DEAD)) ? 1u : 0u };
        }
        h = HashFNV1a(vertBlock, sizeof(PackedMNVertState) * static_cast<size_t>(n), h);
    }

    for (int i = 0; i < numFaces; ++i) {
        const MNFace* face = mn.F(i);
        if (!face) continue;

        const DWORD scalars[4] = {
            face->GetFlag(MN_DEAD) ? 1u : 0u,
            static_cast<DWORD>(face->deg),
            face->smGroup,
            static_cast<DWORD>(face->material),
        };
        h = HashFNV1a(scalars, sizeof(scalars), h);
        if (face->deg > 0 && face->vtx) {
            h = HashFNV1a(face->vtx, sizeof(int) * static_cast<size_t>(face->deg), h);
        }
    }

    return h;
}

// Export-scoped toggle backing the "Export unused channels" snapshot option. When
// false, only the canonical vertex-color channels (0 / shading / alpha) are
// collected; higher map channels (>= 3, which are UVW unless a material reads
// maxjs_vc_N) are dropped. Default true so the live viewport keeps every channel —
// BuildSnapshotBinary flips it from the export option under a scope guard.
inline bool g_includeUnusedVertexColorChannels = true;

static bool ShouldExportMeshVertexColorChannel(Mesh& mesh, int channel, bool allowMapChannel1 = false) {
    if (channel == 1 && !allowMapChannel1) return false;
    // Map channel 2 is the uv2 (second UV / lightmap-UV) slot — it is exported as
    // uv2, never as a vertex color. Excluding it here prevents the same channel
    // from being written twice (once u16n as uv2, once f32 as a vertex color).
    if (channel == 2) return false;
    if (!mesh.mapSupport(channel)) return false;

    const MeshMap& map = mesh.Map(channel);
    if (!map.IsUsed() || map.vnum <= 0 || map.fnum <= 0 || !map.tv || !map.tf) return false;
    if (channel == 0 || channel == MAP_SHADING || channel == MAP_ALPHA) return true;
    if (!g_includeUnusedVertexColorChannels) return false;  // "Export unused channels" off → drop non-canonical
    return (map.flags & MESHMAP_VERTCOLOR) != 0;
}

static std::vector<int> CollectMeshVertexColorChannels(Mesh& mesh, bool allowMapChannel1 = false) {
    std::vector<int> channels;
    if (ShouldExportMeshVertexColorChannel(mesh, 0, allowMapChannel1)) channels.push_back(0);
    if (ShouldExportMeshVertexColorChannel(mesh, MAP_SHADING, allowMapChannel1)) channels.push_back(MAP_SHADING);
    if (ShouldExportMeshVertexColorChannel(mesh, MAP_ALPHA, allowMapChannel1)) channels.push_back(MAP_ALPHA);
    for (int channel = 1; channel < MAX_MESHMAPS; ++channel) {
        if (channel == 0) continue;
        if (ShouldExportMeshVertexColorChannel(mesh, channel, allowMapChannel1)) channels.push_back(channel);
    }
    return channels;
}

static MNMap* TryGetMNMap(MNMesh& mn, int channel) {
    if (channel >= 0 && channel >= mn.MNum()) return nullptr;
    return mn.M(channel);
}

static bool MNMeshHasUsableMapChannel(MNMesh& mn, int channel) {
    MNMap* map = TryGetMNMap(mn, channel);
    return map &&
           map->GetFlag(MN_DEAD) == 0 &&
           map->numv > 0 &&
           map->numf > 0 &&
           map->v;
}

static bool MeshHasUsableMapChannel(Mesh& mesh, int channel) {
    if (!mesh.mapSupport(channel)) return false;
    const MeshMap& map = mesh.Map(channel);
    return map.vnum > 0 &&
           map.fnum > 0 &&
           map.tv &&
           map.tf;
}

static bool ShouldExportMNVertexColorChannel(MNMesh& mn, int channel, bool allowMapChannel1 = false) {
    if (channel == 1 && !allowMapChannel1) return false;
    // Map channel 2 is the uv2 (second UV / lightmap-UV) slot — it is exported as
    // uv2, never as a vertex color. Excluding it here prevents the same channel
    // from being written twice (once u16n as uv2, once f32 as a vertex color).
    if (channel == 2) return false;
    if (!MNMeshHasUsableMapChannel(mn, channel)) return false;
    if (channel == 0 || channel == MAP_SHADING || channel == MAP_ALPHA) return true;
    if (!g_includeUnusedVertexColorChannels) return false;  // "Export unused channels" off → drop non-canonical
    return channel > 1 || (channel == 1 && allowMapChannel1);
}

static std::vector<int> CollectMNMeshVertexColorChannels(MNMesh& mn, bool allowMapChannel1 = false) {
    std::vector<int> channels;
    if (ShouldExportMNVertexColorChannel(mn, 0, allowMapChannel1)) channels.push_back(0);
    if (ShouldExportMNVertexColorChannel(mn, MAP_SHADING, allowMapChannel1)) channels.push_back(MAP_SHADING);
    if (ShouldExportMNVertexColorChannel(mn, MAP_ALPHA, allowMapChannel1)) channels.push_back(MAP_ALPHA);
    for (int channel = 1; channel < mn.MNum(); ++channel) {
        if (ShouldExportMNVertexColorChannel(mn, channel, allowMapChannel1)) channels.push_back(channel);
    }
    return channels;
}

static uint64_t HashMeshVertexColorChannels(Mesh& mesh,
                                            const std::vector<int>& channels,
                                            uint64_t seed) {
    uint64_t h = seed;
    const int count = static_cast<int>(channels.size());
    h = HashFNV1a(&count, sizeof(count), h);
    for (int channel : channels) {
        h = HashFNV1a(&channel, sizeof(channel), h);
        const MeshMap& map = mesh.Map(channel);
        const int numVerts = map.vnum;
        const int numFaces = map.fnum;
        h = HashFNV1a(&numVerts, sizeof(numVerts), h);
        h = HashFNV1a(&numFaces, sizeof(numFaces), h);
        if (numVerts > 0 && map.tv) {
            h = HashFNV1a(map.tv, static_cast<size_t>(numVerts) * sizeof(UVVert), h);
        }
        if (numFaces > 0 && map.tf) {
            // TVFace is just DWORD t[3] — the whole face array hashes in one pass.
            h = HashFNV1a(map.tf, static_cast<size_t>(numFaces) * sizeof(TVFace), h);
        }
    }
    return h;
}

static uint64_t HashMNMeshVertexColorChannels(MNMesh& mn,
                                              const std::vector<int>& channels,
                                              uint64_t seed) {
    uint64_t h = seed;
    const int count = static_cast<int>(channels.size());
    h = HashFNV1a(&count, sizeof(count), h);
    for (int channel : channels) {
        h = HashFNV1a(&channel, sizeof(channel), h);
        MNMap* map = TryGetMNMap(mn, channel);
        const int numVerts = map ? map->numv : 0;
        const int numFaces = map ? map->numf : 0;
        h = HashFNV1a(&numVerts, sizeof(numVerts), h);
        h = HashFNV1a(&numFaces, sizeof(numFaces), h);
        if (!map) continue;
        if (numVerts > 0 && map->v) {
            h = HashFNV1a(map->v, static_cast<size_t>(numVerts) * sizeof(UVVert), h);
        }
        for (int i = 0; i < numFaces; ++i) {
            MNMapFace* mapFace = map->F(i);
            if (!mapFace) {
                const int deg = -1;
                h = HashFNV1a(&deg, sizeof(deg), h);
                continue;
            }
            const int deg = mapFace->deg;
            h = HashFNV1a(&deg, sizeof(deg), h);
            if (deg > 0 && mapFace->tv) {
                h = HashFNV1a(mapFace->tv, sizeof(int) * static_cast<size_t>(deg), h);
            }
        }
    }
    return h;
}

static uint64_t HashMeshStateWithUVs(Mesh& mesh, bool allowMapChannel1 = false) {
    uint64_t h = HashMeshState(mesh);
    const int numTVerts = mesh.getNumTVerts();
    h = HashFNV1a(&numTVerts, sizeof(numTVerts), h);
    if (numTVerts > 0 && mesh.tVerts) {
        h = HashFNV1a(mesh.tVerts, static_cast<size_t>(numTVerts) * sizeof(UVVert), h);
    }

    if (numTVerts > 0 && mesh.tvFace) {
        h = HashFNV1a(mesh.tvFace,
                      static_cast<size_t>(mesh.getNumFaces()) * sizeof(TVFace), h);
    }
    const std::vector<int> vertexColorChannels = CollectMeshVertexColorChannels(mesh, allowMapChannel1);
    h = HashMeshVertexColorChannels(mesh, vertexColorChannels, h);
    return h;
}

static uint64_t HashMeshChannelState(Mesh& mesh, bool allowMapChannel1 = false) {
    uint64_t h = 1469598103934665603ULL;
    const int numVerts = mesh.getNumVerts();
    const int numFaces = mesh.getNumFaces();
    h = HashFNV1a(&numVerts, sizeof(numVerts), h);
    h = HashFNV1a(&numFaces, sizeof(numFaces), h);

    PackedFaceHashState block[kHashPackBlock];
    for (int base = 0; base < numFaces; base += kHashPackBlock) {
        const int n = std::min(kHashPackBlock, numFaces - base);
        for (int k = 0; k < n; ++k) {
            Face& face = mesh.faces[base + k];
            block[k].v[0] = face.v[0];
            block[k].v[1] = face.v[1];
            block[k].v[2] = face.v[2];
            block[k].smGroup = face.getSmGroup();
            block[k].matID = face.getMatID();
        }
        h = HashFNV1a(block, sizeof(PackedFaceHashState) * static_cast<size_t>(n), h);
    }

    const int numTVerts = mesh.getNumTVerts();
    h = HashFNV1a(&numTVerts, sizeof(numTVerts), h);
    if (numTVerts > 0 && mesh.tVerts) {
        h = HashFNV1a(mesh.tVerts, static_cast<size_t>(numTVerts) * sizeof(UVVert), h);
    }

    if (numTVerts > 0 && mesh.tvFace) {
        h = HashFNV1a(mesh.tvFace, static_cast<size_t>(numFaces) * sizeof(TVFace), h);
    }

    const std::vector<int> vertexColorChannels = CollectMeshVertexColorChannels(mesh, allowMapChannel1);
    h = HashMeshVertexColorChannels(mesh, vertexColorChannels, h);
    return h;
}

static uint64_t HashMNMeshStateWithUVs(MNMesh& mn, bool allowMapChannel1 = false) {
    uint64_t h = HashMNMeshState(mn);

    MNMap* uvMap = mn.M(1);
    const bool hasUVs = uvMap && uvMap->GetFlag(MN_DEAD) == 0;
    const int numUVVerts = hasUVs ? uvMap->numv : 0;
    const int numUVFaces = hasUVs ? uvMap->numf : 0;
    h = HashFNV1a(&numUVVerts, sizeof(numUVVerts), h);
    h = HashFNV1a(&numUVFaces, sizeof(numUVFaces), h);
    if (!hasUVs) return h;

    if (numUVVerts > 0 && uvMap->v) {
        h = HashFNV1a(uvMap->v, static_cast<size_t>(numUVVerts) * sizeof(UVVert), h);
    }

    for (int i = 0; i < numUVFaces; ++i) {
        MNMapFace* uvFace = uvMap->F(i);
        if (!uvFace) {
            const int deg = -1;
            h = HashFNV1a(&deg, sizeof(deg), h);
            continue;
        }

        const int deg = uvFace->deg;
        h = HashFNV1a(&deg, sizeof(deg), h);
        if (deg > 0 && uvFace->tv) {
            h = HashFNV1a(uvFace->tv, sizeof(int) * static_cast<size_t>(deg), h);
        }
    }

    const std::vector<int> vertexColorChannels = CollectMNMeshVertexColorChannels(mn, allowMapChannel1);
    h = HashMNMeshVertexColorChannels(mn, vertexColorChannels, h);
    return h;
}

static uint64_t HashMNMeshChannelState(MNMesh& mn, bool allowMapChannel1 = false) {
    uint64_t h = 1469598103934665603ULL;
    const int numVerts = mn.VNum();
    const int numFaces = mn.FNum();
    h = HashFNV1a(&numVerts, sizeof(numVerts), h);
    h = HashFNV1a(&numFaces, sizeof(numFaces), h);

    for (int i = 0; i < numFaces; ++i) {
        const MNFace* face = mn.F(i);
        if (!face) continue;

        const DWORD scalars[4] = {
            face->GetFlag(MN_DEAD) ? 1u : 0u,
            static_cast<DWORD>(face->deg),
            face->smGroup,
            static_cast<DWORD>(face->material),
        };
        h = HashFNV1a(scalars, sizeof(scalars), h);
        if (face->deg > 0 && face->vtx) {
            h = HashFNV1a(face->vtx, sizeof(int) * static_cast<size_t>(face->deg), h);
        }
    }

    MNMap* uvMap = mn.M(1);
    const bool hasUVs = uvMap && uvMap->GetFlag(MN_DEAD) == 0;
    const int numUVVerts = hasUVs ? uvMap->numv : 0;
    const int numUVFaces = hasUVs ? uvMap->numf : 0;
    h = HashFNV1a(&numUVVerts, sizeof(numUVVerts), h);
    h = HashFNV1a(&numUVFaces, sizeof(numUVFaces), h);
    if (hasUVs) {
        if (numUVVerts > 0 && uvMap->v) {
            h = HashFNV1a(uvMap->v, static_cast<size_t>(numUVVerts) * sizeof(UVVert), h);
        }

        for (int i = 0; i < numUVFaces; ++i) {
            MNMapFace* uvFace = uvMap->F(i);
            if (!uvFace) {
                const int deg = -1;
                h = HashFNV1a(&deg, sizeof(deg), h);
                continue;
            }

            const int deg = uvFace->deg;
            h = HashFNV1a(&deg, sizeof(deg), h);
            if (deg > 0 && uvFace->tv) {
                h = HashFNV1a(uvFace->tv, sizeof(int) * static_cast<size_t>(deg), h);
            }
        }
    }

    const std::vector<int> vertexColorChannels = CollectMNMeshVertexColorChannels(mn, allowMapChannel1);
    h = HashMNMeshVertexColorChannels(mn, vertexColorChannels, h);
    return h;
}

static uint64_t MakeGeomValidityKey(const Interval& iv) {
    return static_cast<uint64_t>(iv.Start()) ^ (static_cast<uint64_t>(iv.End()) << 32);
}

static constexpr int kSkinnedHashFullVertexThreshold = 16384;
static constexpr int kSkinnedHashSampleCount = 256;
// Above this triangle count, fast deform updates go compact (positions only,
// UVs/normals preserved viewer-side and refreshed at idle). Lowered from
// 600k: with live normals now streaming on every fast update below the
// threshold, the per-tick normal pass on very heavy meshes costs more than
// frozen normals are worth during interaction.
static constexpr int kMaxBinaryDeltaTriangles = 256000;
static constexpr ULONGLONG kSkinnedLivePollIntervalMs = 16;
static constexpr ULONGLONG kCameraLivePollIntervalMs = 16;

static uint64_t HashSampledPoint3Array(const Point3* points,
                                       int count,
                                       uint64_t seed = 1469598103934665603ULL) {
    uint64_t h = HashFNV1a(&count, sizeof(count), seed);
    if (!points || count <= 0) return h;

    const int sampleCount = (count < kSkinnedHashSampleCount) ? count : kSkinnedHashSampleCount;
    const int stride = (count <= sampleCount) ? 1 : std::max(1, count / sampleCount);
    for (int sampleIdx = 0; sampleIdx < sampleCount; ++sampleIdx) {
        int idx = sampleIdx * stride;
        if (idx >= count) idx = count - 1;
        h = HashFNV1a(&idx, sizeof(idx), h);
        h = HashFNV1a(&points[idx], sizeof(Point3), h);
    }

    const int lastIdx = count - 1;
    h = HashFNV1a(&lastIdx, sizeof(lastIdx), h);
    h = HashFNV1a(&points[lastIdx], sizeof(Point3), h);
    return h;
}

static uint64_t HashAdaptiveSkinnedPositions(Mesh& mesh) {
    const int nv = mesh.getNumVerts();
    uint64_t h = HashFNV1a(&nv, sizeof(nv));
    if (nv <= 0) return h;
    if (nv <= kSkinnedHashFullVertexThreshold) {
        return HashFNV1a(mesh.verts, static_cast<size_t>(nv) * sizeof(Point3), h);
    }
    return HashSampledPoint3Array(mesh.verts, nv, h);
}

static uint64_t HashAdaptiveSkinnedPositions(MNMesh& mn) {
    const int nv = mn.VNum();
    uint64_t h = HashFNV1a(&nv, sizeof(nv));
    if (nv <= 0) return h;
    if (nv <= kSkinnedHashFullVertexThreshold) {
        for (int i = 0; i < nv; ++i) {
            Point3 p = mn.P(i);
            h = HashFNV1a(&p, sizeof(p), h);
        }
        return h;
    }

    const int sampleCount = (nv < kSkinnedHashSampleCount) ? nv : kSkinnedHashSampleCount;
    const int stride = (nv <= sampleCount) ? 1 : std::max(1, nv / sampleCount);
    for (int sampleIdx = 0; sampleIdx < sampleCount; ++sampleIdx) {
        int idx = sampleIdx * stride;
        if (idx >= nv) idx = nv - 1;
        Point3 p = mn.P(idx);
        h = HashFNV1a(&idx, sizeof(idx), h);
        h = HashFNV1a(&p, sizeof(p), h);
    }

    const int lastIdx = nv - 1;
    Point3 lastPoint = mn.P(lastIdx);
    h = HashFNV1a(&lastIdx, sizeof(lastIdx), h);
    h = HashFNV1a(&lastPoint, sizeof(lastPoint), h);
    return h;
}

// Sampled position hash for deform-handle change gating. Cheap enough
// (≤ kSkinnedHashSampleCount probes) to run per node per playback tick —
// static modifier-stack nodes (UVW Map, dormant Edit Poly, …) get skipped
// outright instead of re-extracting and re-sending every frame.
static bool TryHashAdaptiveDeformPositions(INode* node, TimeValue t, uint64_t& outHash) {
    if (!node) return false;
    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        MNMesh& mn = static_cast<PolyObject*>(os.obj)->GetMesh();
        outHash = HashAdaptiveSkinnedPositions(mn);
        return true;
    }
    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;
    outHash = HashAdaptiveSkinnedPositions(tri->GetMesh());
    if (tri != os.obj) tri->DeleteThis();
    return true;
}

static MNMesh* TryGetLiveEditablePolyMesh(INode* node) {
    if (!node) return nullptr;

    Object* cursor = node->GetObjectRef();
    while (cursor &&
           (cursor->ClassID() == derivObjClassID || cursor->ClassID() == WSMDerivObjClassID)) {
        IDerivedObject* derived = static_cast<IDerivedObject*>(cursor);
        const int modCount = derived->NumModifiers();
        if (modCount <= 0) {
            cursor = derived->GetObjRef();
            continue;
        }

        Modifier* topModifier = derived->GetModifier(modCount - 1);
        if (!topModifier) return nullptr;

        if (auto* epMod = static_cast<EPolyMod*>(topModifier->GetInterface(EPOLY_MOD_INTERFACE))) {
            if (MNMesh* mesh = epMod->EpModGetOutputMesh(node)) return mesh;
            if (MNMesh* mesh = epMod->EpModGetMesh(node)) return mesh;
        }

        // A higher non-Edit Poly modifier sits above any deeper Editable Poly state.
        return nullptr;
    }

    if (!cursor) return nullptr;
    if (auto* epoly = static_cast<EPoly*>(cursor->GetInterface(EPOLY_INTERFACE))) {
        return epoly->GetMeshPtr();
    }

    return nullptr;
}

static int CountMNMeshTrianglesCapped(MNMesh& mn, int cap) {
    long long triangles = 0;
    const int faceCount = mn.FNum();
    for (int i = 0; i < faceCount; ++i) {
        const MNFace* face = mn.F(i);
        if (!face || face->GetFlag(MN_DEAD) || face->deg < 3) continue;
        triangles += static_cast<long long>(face->deg - 2);
        if (triangles > cap) return cap + 1;
    }
    return static_cast<int>(triangles);
}

static int EstimateRenderableTriangleCountCapped(INode* node, TimeValue t, int cap) {
    if (!node) return 0;

    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return CountMNMeshTrianglesCapped(*liveMN, cap);
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return 0;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return 0;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        MNMesh& mn = static_cast<PolyObject*>(os.obj)->GetMesh();
        return CountMNMeshTrianglesCapped(mn, cap);
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return 0;
    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return 0;

    const int faces = tri->GetMesh().getNumFaces();
    const int cappedFaces = (faces > cap) ? (cap + 1) : faces;
    if (tri != os.obj) tri->DeleteThis();
    return cappedFaces;
}

static bool ExtractSpline(INode* node, TimeValue t,
                          std::vector<float>& verts,
                          std::vector<int>& indices);

static bool IsShapeConsumedByOtherRuntimeNode(INode* node, TimeValue t);

static bool ShouldExtractRenderableShape(INode* node, TimeValue t, const ObjectState* os = nullptr) {
    if (!node) return false;
    const ObjectState localOs = os ? *os : node->EvalWorldState(t);
    return localOs.obj
        && localOs.obj->SuperClassID() == SHAPE_CLASS_ID
        && node->Renderable()
        && !IsShapeConsumedByOtherRuntimeNode(node, t);
}

// Fast-path visibility (delta / xform / splat-audio hashes) must match layer hidden + renderable.
// Sending only IsNodeHidden caused non-renderable meshes to receive vis=1 every frame and fight
// props.rend on the JS side (flicker).
static bool IsMaxJsSyncDrawVisible(INode* node) {
    return node && !node->IsNodeHidden(TRUE) && node->Renderable();
}

static uint64_t HashNodeGeometryState(INode* node, TimeValue t) {
    if (!node) return 0;

    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return HashMNMeshState(*liveMN);
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj) return 0;
    if (ShouldExtractRenderableShape(node, t, &os)) {
        std::vector<float> verts;
        std::vector<int> indices;
        if (!ExtractSpline(node, t, verts, indices)) return 0;
        const std::vector<float> uvs;
        return HashMeshData(verts, indices, uvs);
    }
    if (os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return 0;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return 0;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        return HashMNMeshState(poly->GetMesh());
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return 0;

    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return 0;

    const uint64_t hash = HashMeshState(tri->GetMesh());
    if (tri != os.obj) tri->DeleteThis();
    return hash;
}

// ══════════════════════════════════════════════════════════════
//  SSE SIMD helpers for vertex/normal processing
// ══════════════════════════════════════════════════════════════

// Cross product of two Point3 vectors using SSE
// (b-a) x (c-a), returned as Point3
static __forceinline Point3 CrossProductSSE(const Point3& a, const Point3& b, const Point3& c) {
    // edge1 = b - a, edge2 = c - a
    __m128 va = _mm_set_ps(0, a.z, a.y, a.x);
    __m128 vb = _mm_set_ps(0, b.z, b.y, b.x);
    __m128 vc = _mm_set_ps(0, c.z, c.y, c.x);
    __m128 e1 = _mm_sub_ps(vb, va);
    __m128 e2 = _mm_sub_ps(vc, va);
    // cross = (e1.y*e2.z - e1.z*e2.y, e1.z*e2.x - e1.x*e2.z, e1.x*e2.y - e1.y*e2.x)
    __m128 e1_yzx = _mm_shuffle_ps(e1, e1, _MM_SHUFFLE(3, 0, 2, 1));
    __m128 e2_yzx = _mm_shuffle_ps(e2, e2, _MM_SHUFFLE(3, 0, 2, 1));
    __m128 cross = _mm_sub_ps(_mm_mul_ps(e1, e2_yzx), _mm_mul_ps(e1_yzx, e2));
    cross = _mm_shuffle_ps(cross, cross, _MM_SHUFFLE(3, 0, 2, 1));
    float out[4];
    _mm_storeu_ps(out, cross);
    return Point3(out[0], out[1], out[2]);
}

// Normalize a Point3 using SSE rsqrt + Newton-Raphson refinement
static __forceinline Point3 NormalizeSSE(const Point3& v) {
    __m128 vec = _mm_set_ps(0, v.z, v.y, v.x);
    __m128 dot = _mm_mul_ps(vec, vec);
    // horizontal sum: x*x + y*y + z*z
    __m128 shuf = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 1));
    dot = _mm_add_ss(dot, shuf);
    shuf = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 2));
    dot = _mm_add_ss(dot, shuf);
    dot = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 0));
    // rsqrt + one Newton-Raphson iteration for accuracy
    __m128 rsq = _mm_rsqrt_ps(dot);
    __m128 half = _mm_set1_ps(0.5f);
    __m128 three = _mm_set1_ps(3.0f);
    rsq = _mm_mul_ps(_mm_mul_ps(half, rsq),
                     _mm_sub_ps(three, _mm_mul_ps(dot, _mm_mul_ps(rsq, rsq))));
    // guard against zero-length
    __m128 mask = _mm_cmpgt_ps(dot, _mm_set1_ps(1e-30f));
    rsq = _mm_and_ps(rsq, mask);
    __m128 result = _mm_mul_ps(vec, rsq);
    float out[4];
    _mm_storeu_ps(out, result);
    return Point3(out[0], out[1], out[2]);
}

// Batch normalize an array of Point3 (as float triplets) in-place
static void BatchNormalizeSSE(float* data, size_t count) {
    for (size_t i = 0; i < count; i++) {
        __m128 vec = _mm_set_ps(0, data[i * 3 + 2], data[i * 3 + 1], data[i * 3]);
        __m128 dot = _mm_mul_ps(vec, vec);
        __m128 shuf = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 1));
        dot = _mm_add_ss(dot, shuf);
        shuf = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 2));
        dot = _mm_add_ss(dot, shuf);
        dot = _mm_shuffle_ps(dot, dot, _MM_SHUFFLE(0, 0, 0, 0));
        __m128 rsq = _mm_rsqrt_ps(dot);
        __m128 half = _mm_set1_ps(0.5f);
        __m128 three = _mm_set1_ps(3.0f);
        rsq = _mm_mul_ps(_mm_mul_ps(half, rsq),
                         _mm_sub_ps(three, _mm_mul_ps(dot, _mm_mul_ps(rsq, rsq))));
        __m128 mask = _mm_cmpgt_ps(dot, _mm_set1_ps(1e-30f));
        rsq = _mm_and_ps(rsq, mask);
        __m128 result = _mm_mul_ps(vec, rsq);
        _mm_store_ss(&data[i * 3], result);
        result = _mm_shuffle_ps(result, result, _MM_SHUFFLE(0, 0, 0, 1));
        _mm_store_ss(&data[i * 3 + 1], result);
        result = _mm_shuffle_ps(result, result, _MM_SHUFFLE(0, 0, 0, 1));
        _mm_store_ss(&data[i * 3 + 2], result);
    }
}

// Non-temporal copy for large one-shot writes into WebView2 shared buffers.
// The CPU never reads those bytes back — the renderer process does — so a
// regular memcpy evicts megabytes of useful cache per frame at playback
// rates. Streaming stores bypass the cache hierarchy entirely.
static void StreamCopyBytesAvx2(unsigned char* dst, const unsigned char* src, size_t bytes) {
    const size_t head = (32 - (reinterpret_cast<uintptr_t>(dst) & 31)) & 31;
    if (head) {
        memcpy(dst, src, head);
        dst += head;
        src += head;
        bytes -= head;
    }
    size_t blocks = bytes / 128;
    while (blocks--) {
        const __m256i a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(src));
        const __m256i b = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(src + 32));
        const __m256i c = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(src + 64));
        const __m256i d = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(src + 96));
        _mm256_stream_si256(reinterpret_cast<__m256i*>(dst), a);
        _mm256_stream_si256(reinterpret_cast<__m256i*>(dst + 32), b);
        _mm256_stream_si256(reinterpret_cast<__m256i*>(dst + 64), c);
        _mm256_stream_si256(reinterpret_cast<__m256i*>(dst + 96), d);
        src += 128;
        dst += 128;
    }
    _mm_sfence();
    _mm256_zeroupper();
    const size_t tail = bytes & 127;
    if (tail) memcpy(dst, src, tail);
}

static void StreamCopyBytes(void* dstRaw, const void* srcRaw, size_t bytes) {
    unsigned char* dst = static_cast<unsigned char*>(dstRaw);
    const unsigned char* src = static_cast<const unsigned char*>(srcRaw);
    if (bytes < 4096) {
        memcpy(dst, src, bytes);
        return;
    }
    if (g_maxjsHasAvx2) {
        StreamCopyBytesAvx2(dst, src, bytes);
        return;
    }

    const size_t head = (16 - (reinterpret_cast<uintptr_t>(dst) & 15)) & 15;
    if (head) {
        memcpy(dst, src, head);
        dst += head;
        src += head;
        bytes -= head;
    }

    size_t blocks = bytes / 64;
    while (blocks--) {
        const __m128i a = _mm_loadu_si128(reinterpret_cast<const __m128i*>(src));
        const __m128i b = _mm_loadu_si128(reinterpret_cast<const __m128i*>(src + 16));
        const __m128i c = _mm_loadu_si128(reinterpret_cast<const __m128i*>(src + 32));
        const __m128i d = _mm_loadu_si128(reinterpret_cast<const __m128i*>(src + 48));
        _mm_stream_si128(reinterpret_cast<__m128i*>(dst), a);
        _mm_stream_si128(reinterpret_cast<__m128i*>(dst + 16), b);
        _mm_stream_si128(reinterpret_cast<__m128i*>(dst + 32), c);
        _mm_stream_si128(reinterpret_cast<__m128i*>(dst + 48), d);
        src += 64;
        dst += 64;
    }
    _mm_sfence();

    const size_t tail = bytes & 63;
    if (tail) memcpy(dst, src, tail);
}

static Point3 NormalizeNormalOrFallback(const Point3& value, const Point3& fallback = Point3(0.0f, 0.0f, 1.0f)) {
    if (!std::isfinite(value.x) || !std::isfinite(value.y) || !std::isfinite(value.z)) return fallback;
    return DotProd(value, value) > 1.0e-20f ? NormalizeSSE(value) : fallback;
}

// Normalize an interleaved xyz array in place. Degenerate / non-finite
// vectors become (0,0,1), matching NormalizeNormalOrFallback's default
// fallback. AVX2 path computes 8 inverse lengths per iteration via strided
// gathers + rsqrt with one Newton-Raphson refinement.
static void BatchNormalizeNormalsInPlace(float* data, size_t count) {
    size_t i = 0;
    if (g_maxjsHasAvx2 && count >= 8) {
        alignas(32) static const int kStride3[8] = { 0, 3, 6, 9, 12, 15, 18, 21 };
        const __m256i idx = _mm256_load_si256(reinterpret_cast<const __m256i*>(kStride3));
        const __m256 minLen2 = _mm256_set1_ps(1.0e-20f);
        const __m256 maxLen2 = _mm256_set1_ps(3.0e38f);
        const __m256 half = _mm256_set1_ps(0.5f);
        const __m256 three = _mm256_set1_ps(3.0f);
        for (; i + 8 <= count; i += 8) {
            float* base = data + i * 3;
            const __m256 x = _mm256_i32gather_ps(base + 0, idx, 4);
            const __m256 y = _mm256_i32gather_ps(base + 1, idx, 4);
            const __m256 z = _mm256_i32gather_ps(base + 2, idx, 4);
            const __m256 len2 = _mm256_add_ps(
                _mm256_add_ps(_mm256_mul_ps(x, x), _mm256_mul_ps(y, y)),
                _mm256_mul_ps(z, z));
            __m256 rsq = _mm256_rsqrt_ps(len2);
            rsq = _mm256_mul_ps(_mm256_mul_ps(half, rsq),
                                _mm256_sub_ps(three, _mm256_mul_ps(len2, _mm256_mul_ps(rsq, rsq))));
            // Ordered compares reject NaN; the upper bound rejects +inf from
            // overflowed accumulations.
            const __m256 valid = _mm256_and_ps(
                _mm256_cmp_ps(len2, minLen2, _CMP_GT_OQ),
                _mm256_cmp_ps(len2, maxLen2, _CMP_LT_OQ));
            rsq = _mm256_and_ps(rsq, valid);
            alignas(32) float inv[8];
            _mm256_store_ps(inv, rsq);
            for (int k = 0; k < 8; ++k) {
                float* v = base + k * 3;
                const float s = inv[k];
                if (s == 0.0f) {
                    v[0] = 0.0f;
                    v[1] = 0.0f;
                    v[2] = 1.0f;
                } else {
                    v[0] *= s;
                    v[1] *= s;
                    v[2] *= s;
                }
            }
        }
        _mm256_zeroupper();
    }
    for (; i < count; ++i) {
        float* v = data + i * 3;
        const Point3 n = NormalizeNormalOrFallback(Point3(v[0], v[1], v[2]));
        v[0] = n.x;
        v[1] = n.y;
        v[2] = n.z;
    }
}

// Blocked parallel gather for the position replay loops. Per-index
// parallel_for overhead would swamp the 12-byte copies, so work is split
// into blocks; below the threshold a serial loop wins outright.
static constexpr size_t kParallelGatherMinVerts = 16384;
static constexpr size_t kParallelGatherBlock = 8192;

template <typename CopyBlockFn>
static void ParallelGatherBlocks(size_t count, const CopyBlockFn& copyBlock) {
    if (count < kParallelGatherMinVerts) {
        copyBlock(size_t(0), count);
        return;
    }
    const size_t blocks = (count + kParallelGatherBlock - 1) / kParallelGatherBlock;
    concurrency::parallel_for(size_t(0), blocks, [&](size_t b) {
        const size_t beg = b * kParallelGatherBlock;
        const size_t end = std::min(count, beg + kParallelGatherBlock);
        copyBlock(beg, end);
    });
}

static Point3 ComputeMNMeshFaceNormalSafe(MNMesh& mn, int faceIdx) {
    const Point3 fallback(0.0f, 0.0f, 1.0f);
    if (faceIdx < 0 || faceIdx >= mn.FNum()) return fallback;
    MNFace* face = mn.F(faceIdx);
    if (!face || face->GetFlag(MN_DEAD) || face->deg < 3 || !face->vtx) return fallback;

    Point3 n(0.0f, 0.0f, 0.0f);
    for (int c = 0; c < face->deg; ++c) {
        const int ci = face->vtx[c];
        const int ni = face->vtx[(c + 1) % face->deg];
        if (ci < 0 || ci >= mn.VNum() || ni < 0 || ni >= mn.VNum()) return fallback;
        const Point3 cur = mn.P(ci);
        const Point3 nxt = mn.P(ni);
        n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
        n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
        n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
    }
    return NormalizeNormalOrFallback(n, fallback);
}

static Point3 ComputeMeshFaceNormalSafe(Mesh& mesh, int faceIdx) {
    const Point3 fallback(0.0f, 0.0f, 1.0f);
    if (faceIdx < 0 || faceIdx >= mesh.getNumFaces()) return fallback;
    const Point3 a = mesh.getVert(mesh.faces[faceIdx].v[0]);
    const Point3 b = mesh.getVert(mesh.faces[faceIdx].v[1]);
    const Point3 c = mesh.getVert(mesh.faces[faceIdx].v[2]);
    return NormalizeNormalOrFallback((b - a) ^ (c - a), fallback);
}

// ══════════════════════════════════════════════════════════════
//  Mesh Extraction with UV coordinates + Multi/Sub material groups
// ══════════════════════════════════════════════════════════════

struct MatGroup { int matID; int start; int count; };

struct MeshCornerKey {
    DWORD posIdx = 0;
    DWORD uvIdx = 0;
    DWORD uv2Idx = 0;
    DWORD smGroup = 0;
    uint64_t colorSig = 0;
    // Explicit (specified) normal index, or -1 when the corner's normal is
    // implicit (derived from smoothing groups). Two corners that share a
    // position/uv/color but carry different explicit normals must not merge.
    int normalId = -1;

    bool operator==(const MeshCornerKey& other) const {
        return posIdx == other.posIdx &&
               uvIdx == other.uvIdx &&
               uv2Idx == other.uv2Idx &&
               smGroup == other.smGroup &&
               colorSig == other.colorSig &&
               normalId == other.normalId;
    }
};

struct MeshCornerKeyHash {
    size_t operator()(const MeshCornerKey& key) const noexcept {
        size_t h = static_cast<size_t>(key.posIdx);
        h = h * 16777619u ^ static_cast<size_t>(key.uvIdx);
        h = h * 16777619u ^ static_cast<size_t>(key.uv2Idx);
        h = h * 16777619u ^ static_cast<size_t>(key.smGroup);
        h = h * 16777619u ^ static_cast<size_t>(key.colorSig);
        h = h * 16777619u ^ static_cast<size_t>(key.colorSig >> 32);
        h = h * 16777619u ^ static_cast<size_t>(static_cast<unsigned>(key.normalId));
        return h;
    }
};

struct FastVertexSource {
    int controlIdx = -1;
    DWORD smGroup = 0;
    int faceIdx = -1;
    int localIdx = -1;
};

// ══════════════════════════════════════════════════════════════
//  Fast-deform topology epoch + precomputed normal gather plan
// ══════════════════════════════════════════════════════════════

// Captured when the fast-replay caches (controlIdx / FastVertexSource) are
// built and re-validated on every fast tick before the caches are replayed.
// Catches topology edits the per-index bounds checks cannot see — e.g. a
// dynamic tessellation modifier changing connectivity mid-drag while the new
// vertex count stays above every cached index — so stale mappings are dropped
// instead of stamping scrambled positions onto old topology.
struct FastDeformTopoEpoch {
    bool valid = false;
    bool fromLiveMN = false;   // which mesh source the caches were built from
    bool topoVolatile = false; // stack can animate topology → also compare sampled hash
    int nv = -1;
    int nf = -1;
    uint64_t faceSampleHash = 0;
};

// Incremental ("sparse") update state for sub-object editing of high-poly
// meshes. While a vertex/edge/face drag is active, only a tiny region of the
// mesh moves per tick — so instead of re-extracting everything, control
// positions are diffed against a persistent snapshot and only the moved
// region (positions + 1-ring normals via reverse adjacency) is recomputed
// into persistent render buffers. The wire payload stays full-size and
// byte-identical in layout to the deform fast path, so the viewer needs no
// changes. Allocated lazily per edit session; freed on the next full
// re-extract (plan reset) or cache prune.
struct FastSparseState {
    bool valid = false;                 // buffers primed against current topology
    bool posAdjacencyBuilt = false;
    bool normalsAdjacencyBuilt = false;
    // Persistent mirrors (what the viewer currently has)
    std::vector<float> controlPos;      // nv * 3 — last-seen control positions
    std::vector<float> renderPos;       // sources * 3
    std::vector<float> renderNorms;     // sources * 3 (empty when normals not streamed)
    // Reverse adjacency (CSR), built once per topology epoch
    std::vector<uint32_t> ctrlRenderOff, ctrlRenderIdx; // control vert → render verts
    std::vector<uint32_t> ctrlFaceOff, ctrlFaceIdx;     // control vert → adjacent faces
    std::vector<uint32_t> faceRenderOff, faceRenderIdx; // face → render verts gathering it
    // Dirty tracking scratch (flags reset via the lists each tick)
    std::vector<uint8_t> ctrlMoved, faceDirty, renderDirty;
    std::vector<uint32_t> movedCtrl, dirtyFaceList, dirtyRenderList;
};

// Precomputed normal recipe for the fast-deform path. Topology is constant
// while the epoch holds, so smoothing-group islands and explicit-normal IDs
// are resolved once into a CSR gather table; the per-frame cost collapses to
// face normals + indexed accumulation — no adjacency rebuild, no allocations.
struct FastNormalPlan {
    bool built = false;
    bool hasSpec = false;
    std::vector<int> specId;           // per render vertex: explicit normal id, -1 = gather
    std::vector<uint32_t> gatherOff;   // CSR offsets, size = sources + 1
    std::vector<uint32_t> gatherFaces; // CSR face indices (smoothing groups pre-resolved)
    std::vector<Point3> faceNormalScratch; // persistent per-frame scratch
    // Persisted partitioners keep the same index chunks on the same cores
    // across the 30–60 Hz re-runs of the identical parallel_for ranges, so
    // per-core caches stay warm. Per-instance state — never copied.
    std::unique_ptr<concurrency::affinity_partitioner> facePartitioner;
    std::unique_ptr<concurrency::affinity_partitioner> vertPartitioner;
    // Sub-object sparse-edit session state. Per-instance — never copied.
    std::unique_ptr<FastSparseState> sparse;

    FastNormalPlan() = default;
    FastNormalPlan(FastNormalPlan&&) = default;
    FastNormalPlan& operator=(FastNormalPlan&&) = default;
    FastNormalPlan(const FastNormalPlan& other)
        : built(other.built),
          hasSpec(other.hasSpec),
          specId(other.specId),
          gatherOff(other.gatherOff),
          gatherFaces(other.gatherFaces) {}
    FastNormalPlan& operator=(const FastNormalPlan& other) {
        if (this == &other) return *this;
        built = other.built;
        hasSpec = other.hasSpec;
        specId = other.specId;
        gatherOff = other.gatherOff;
        gatherFaces = other.gatherFaces;
        faceNormalScratch.clear();
        facePartitioner.reset();
        vertPartitioner.reset();
        sparse.reset();
        return *this;
    }
};

struct FastDeformGuard {
    FastDeformTopoEpoch epoch;
    FastNormalPlan plan;
};

// Sampled connectivity hash — only consulted for epoch-volatile nodes where
// face/vertex counts alone could miss an equal-count connectivity swap.
static uint64_t SampleFaceTopologyHash(Mesh& mesh) {
    const int nf = mesh.getNumFaces();
    uint64_t h = HashFNV1a(&nf, sizeof(nf));
    if (nf <= 0 || !mesh.faces) return h;
    const int sampleCount = (nf < kSkinnedHashSampleCount) ? nf : kSkinnedHashSampleCount;
    const int stride = (nf <= sampleCount) ? 1 : std::max(1, nf / sampleCount);
    for (int s = 0; s < sampleCount; ++s) {
        int f = s * stride;
        if (f >= nf) f = nf - 1;
        h = HashFNV1a(&f, sizeof(f), h);
        h = HashFNV1a(mesh.faces[f].v, sizeof(mesh.faces[f].v), h);
    }
    const int lastF = nf - 1;
    h = HashFNV1a(&lastF, sizeof(lastF), h);
    h = HashFNV1a(mesh.faces[lastF].v, sizeof(mesh.faces[lastF].v), h);
    return h;
}

static uint64_t SampleFaceTopologyHash(MNMesh& mn) {
    const int nf = mn.FNum();
    uint64_t h = HashFNV1a(&nf, sizeof(nf));
    if (nf <= 0) return h;
    auto hashFace = [&mn](uint64_t seed, int f) {
        const MNFace* face = mn.F(f);
        const int deg = (face && !face->GetFlag(MN_DEAD)) ? face->deg : -1;
        uint64_t hh = HashFNV1a(&f, sizeof(f), seed);
        hh = HashFNV1a(&deg, sizeof(deg), hh);
        if (deg > 0 && face->vtx) {
            hh = HashFNV1a(face->vtx, sizeof(int) * static_cast<size_t>(deg), hh);
        }
        return hh;
    };
    const int sampleCount = (nf < kSkinnedHashSampleCount) ? nf : kSkinnedHashSampleCount;
    const int stride = (nf <= sampleCount) ? 1 : std::max(1, nf / sampleCount);
    for (int s = 0; s < sampleCount; ++s) {
        int f = s * stride;
        if (f >= nf) f = nf - 1;
        h = hashFace(h, f);
    }
    h = hashFace(h, nf - 1);
    return h;
}

// Stack scan at epoch-capture time: any enabled-in-viewport modifier that
// declares TOPO_CHANNEL output (Tessellate, TurboSmooth with animated iters,
// Optimize, etc.) can change connectivity without a node event mid-drag.
static bool NodeHasTopologyAnimatingModifier(INode* node) {
    if (!node) return false;
    Object* cursor = node->GetObjectRef();
    while (cursor &&
           (cursor->ClassID() == derivObjClassID || cursor->ClassID() == WSMDerivObjClassID)) {
        IDerivedObject* derived = static_cast<IDerivedObject*>(cursor);
        const int modCount = derived->NumModifiers();
        for (int i = 0; i < modCount; ++i) {
            Modifier* mod = derived->GetModifier(i);
            if (!mod || !mod->IsEnabled() || !mod->IsEnabledInViews()) continue;
            if (mod->ChannelsChanged() & TOPO_CHANNEL) return true;
        }
        cursor = derived->GetObjRef();
    }
    return false;
}

static void CaptureFastDeformEpochFromMesh(Mesh& mesh, INode* node, TimeValue t,
                                           Object* evalObj, bool fromLiveMN,
                                           FastDeformTopoEpoch& epoch) {
    epoch.valid = true;
    epoch.fromLiveMN = fromLiveMN;
    epoch.nv = mesh.getNumVerts();
    epoch.nf = mesh.getNumFaces();
    epoch.topoVolatile = NodeHasTopologyAnimatingModifier(node);
    if (!epoch.topoVolatile && evalObj) {
        // Conservative procedural objects report limited topology validity;
        // treating them as volatile only adds a microsecond sampled hash.
        const Interval iv = evalObj->ChannelValidity(t, TOPO_CHAN_NUM);
        epoch.topoVolatile = iv.Start() != TIME_NegInfinity || iv.End() != TIME_PosInfinity;
    }
    epoch.faceSampleHash = SampleFaceTopologyHash(mesh);
}

static void CaptureFastDeformEpochFromMNMesh(MNMesh& mn, INode* node, TimeValue t,
                                             Object* evalObj, bool fromLiveMN,
                                             FastDeformTopoEpoch& epoch) {
    epoch.valid = true;
    epoch.fromLiveMN = fromLiveMN;
    epoch.nv = mn.VNum();
    epoch.nf = mn.FNum();
    epoch.topoVolatile = NodeHasTopologyAnimatingModifier(node);
    if (!epoch.topoVolatile && evalObj) {
        const Interval iv = evalObj->ChannelValidity(t, TOPO_CHAN_NUM);
        epoch.topoVolatile = iv.Start() != TIME_NegInfinity || iv.End() != TIME_PosInfinity;
    }
    epoch.faceSampleHash = SampleFaceTopologyHash(mn);
}

static bool FastDeformEpochMatches(Mesh& mesh, const FastDeformTopoEpoch& epoch) {
    if (!epoch.valid) return false;
    if (mesh.getNumVerts() != epoch.nv || mesh.getNumFaces() != epoch.nf) return false;
    return !epoch.topoVolatile || SampleFaceTopologyHash(mesh) == epoch.faceSampleHash;
}

static bool FastDeformEpochMatches(MNMesh& mn, const FastDeformTopoEpoch& epoch) {
    if (!epoch.valid) return false;
    if (mn.VNum() != epoch.nv || mn.FNum() != epoch.nf) return false;
    return !epoch.topoVolatile || SampleFaceTopologyHash(mn) == epoch.faceSampleHash;
}

// ── MNMesh (PolyObject) extraction — handles ngons correctly ──
static bool ExtractMeshFromMNMesh(MNMesh& mn,
                                  std::vector<float>& verts,
                                  std::vector<float>& uvs,
                                  std::vector<int>& indices,
                                  std::vector<MatGroup>& groups,
                                  std::vector<float>* outNormals = nullptr,
                                  std::vector<int>* outControlIdx = nullptr,
                                  std::vector<VertexColorAttributeRecord>* outVertexColors = nullptr,
                                  bool allowMapChannel1 = false,
                                  std::vector<FastVertexSource>* outFastVertexSources = nullptr,
                                  std::vector<float>* outUV2s = nullptr,
                                  bool emitPrimaryUVs = true) {
    const int numFaces = mn.FNum();
    const int numVerts = mn.VNum();
    if (numFaces == 0 || numVerts == 0) return false;

    // UV map channel 1
    MNMap* uvMap = mn.M(1);
    const bool hasUVs = uvMap && uvMap->GetFlag(MN_DEAD) == 0 && uvMap->numv > 0;
    MNMap* uv2Map = outUV2s ? TryGetMNMap(mn, 2) : nullptr;
    const bool hasUV2s = outUV2s && MNMeshHasUsableMapChannel(mn, 2);
    const std::vector<int> vertexColorChannels = CollectMNMeshVertexColorChannels(mn, allowMapChannel1);
    std::vector<MNMap*> vertexColorMaps;
    vertexColorMaps.reserve(vertexColorChannels.size());
    for (int channel : vertexColorChannels) {
        vertexColorMaps.push_back(TryGetMNMap(mn, channel));
    }

    // Count live faces + sort by matID
    struct FaceRef { int idx; MtlID matID; };
    std::vector<FaceRef> liveFaces;
    liveFaces.reserve(numFaces);
    for (int i = 0; i < numFaces; i++) {
        MNFace* f = mn.F(i);
        if (!f || f->GetFlag(MN_DEAD)) continue;
        liveFaces.push_back({ i, f->material });
    }
    if (liveFaces.empty()) return false;

    // Check for multi-mat and sort
    bool multiMat = false;
    MtlID firstMat = liveFaces[0].matID;
    for (auto& fr : liveFaces) {
        if (fr.matID != firstMat) { multiMat = true; break; }
    }
    if (multiMat) {
        std::sort(liveFaces.begin(), liveFaces.end(),
            [](const FaceRef& a, const FaceRef& b) { return a.matID < b.matID; });
    }

    // Explicit (specified) normals — Edit Normals modifier, weighted normals,
    // imported custom normals, etc. When present these override the implicit
    // smoothing-group computation; otherwise normals are derived below.
    MNNormalSpec* normalSpec = mn.GetSpecifiedNormals();
    const bool hasNormalSpec = normalSpec &&
        normalSpec->GetNumFaces() == numFaces &&
        normalSpec->GetNumNormals() > 0;
    const int specNormalCount = hasNormalSpec ? normalSpec->GetNumNormals() : 0;
    auto resolveSpecNormalId = [&](int faceIdx, int localIdx) -> int {
        if (!hasNormalSpec) return -1;
        MNNormalFace& nf = normalSpec->Face(faceIdx);
        if (localIdx < 0 || localIdx >= nf.GetDegree()) return -1;
        if (!nf.GetSpecified(localIdx)) return -1;
        const int nid = nf.GetNormalID(localIdx);
        return (nid >= 0 && nid < specNormalCount) ? nid : -1;
    };

    const bool smoothZeroSmoothingForDynamic =
        !outNormals && (outFastVertexSources != nullptr || outControlIdx != nullptr);
    auto effectiveSmGrpForDynamic = [smoothZeroSmoothingForDynamic](DWORD smGrp) -> DWORD {
        // Editable Mesh / Poly objects with smGroup 0 are often just bad
        // imported/faceted normals. If we preserve that for deforming MaxJS
        // nodes, extraction splits every face corner into a unique render
        // vertex and playback payloads scale with face count instead of
        // control vertices. Keep authored hard normals whenever this payload
        // includes normals; the compatibility shortcut is only for position-only
        // dynamic/deform extraction.
        return (smoothZeroSmoothingForDynamic && smGrp == 0) ? 0x7fffffffu : smGrp;
    };

    // Per-corner implicit normals. Keep this local and read-only; Max's
    // ComputeRenderNormal path can update internal accel/cache state and is
    // unsafe on the live sync mesh.
    std::vector<int> faceCornerStart;
    std::vector<Point3> faceNormalsFlat;
    std::vector<Point3> cornerNormals;
    if (outNormals) {
        faceCornerStart.assign(numFaces, 0);
        faceNormalsFlat.assign(numFaces, Point3(0, 0, 0));

        concurrency::parallel_for(size_t(0), liveFaces.size(), [&](size_t i) {
            const FaceRef& fr = liveFaces[i];
            faceNormalsFlat[fr.idx] = ComputeMNMeshFaceNormalSafe(mn, fr.idx);
        });

        std::vector<int> vertCornerOff(static_cast<size_t>(numVerts) + 1, 0);
        int totalCorners = 0;
        for (const FaceRef& fr : liveFaces) {
            MNFace* face = mn.F(fr.idx);
            if (!face || !face->vtx) continue;
            faceCornerStart[fr.idx] = totalCorners;
            totalCorners += face->deg;
            for (int v = 0; v < face->deg; v++) {
                const int pIdx = face->vtx[v];
                if (pIdx >= 0 && pIdx < numVerts) vertCornerOff[pIdx + 1]++;
            }
        }
        for (int i = 1; i <= numVerts; i++) vertCornerOff[i] += vertCornerOff[i - 1];

        struct VertCorner { int faceIdx; int localIdx; DWORD smGrp; };
        std::vector<VertCorner> vertCornersFlat(static_cast<size_t>(totalCorners));
        {
            std::vector<int> cursor(numVerts, 0);
            for (const FaceRef& fr : liveFaces) {
                MNFace* face = mn.F(fr.idx);
                if (!face || !face->vtx) continue;
                const DWORD smGrp = effectiveSmGrpForDynamic(face->smGroup);
                for (int v = 0; v < face->deg; v++) {
                    const int pIdx = face->vtx[v];
                    if (pIdx < 0 || pIdx >= numVerts) continue;
                    vertCornersFlat[vertCornerOff[pIdx] + cursor[pIdx]++] = { fr.idx, v, smGrp };
                }
            }
        }

        cornerNormals.assign(static_cast<size_t>(totalCorners), Point3(0, 0, 0));
        concurrency::parallel_for(0, numVerts, [&](int posIdx) {
            const int beg = vertCornerOff[posIdx];
            const int end = vertCornerOff[posIdx + 1];
            for (int i = beg; i < end; i++) {
                const VertCorner& c = vertCornersFlat[i];
                Point3 accum = faceNormalsFlat[c.faceIdx];
                if (c.smGrp != 0) {
                    for (int j = beg; j < end; j++) {
                        if (j == i) continue;
                        const VertCorner& other = vertCornersFlat[j];
                        if (other.faceIdx == c.faceIdx) continue;
                        if ((c.smGrp & other.smGrp) != 0)
                            accum += faceNormalsFlat[other.faceIdx];
                    }
                }
                cornerNormals[faceCornerStart[c.faceIdx] + c.localIdx] = NormalizeNormalOrFallback(accum);
            }
        });
    }

    // Estimate output sizes
    int estTris = 0;
    for (auto& fr : liveFaces) estTris += mn.F(fr.idx)->deg - 2;
    verts.reserve(numVerts * 3);
    if (emitPrimaryUVs && hasUVs) uvs.reserve(numVerts * 2);
    if (hasUV2s) outUV2s->reserve(numVerts * 2);
    indices.reserve(estTris * 3);
    std::vector<float> normals;
    if (outNormals) normals.reserve(numVerts * 3);
    if (outControlIdx) outControlIdx->clear();
    if (outFastVertexSources) outFastVertexSources->clear();
    if (outVertexColors) {
        outVertexColors->clear();
        outVertexColors->reserve(vertexColorChannels.size());
        const size_t estVertexCount = static_cast<size_t>(std::max(numVerts, estTris * 3));
        for (int channel : vertexColorChannels) {
            VertexColorAttributeRecord attr;
            attr.channel = channel;
            attr.attrName = GetVertexColorAttributeName(channel);
            attr.values.reserve(estVertexCount * 4);
            outVertexColors->push_back(std::move(attr));
        }
    }

    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    vertMap.reserve(static_cast<size_t>(estTris) * 3);
    Tab<int> triTab;
    int curMatID = -1;

    for (auto& fr : liveFaces) {
        MNFace* face = mn.F(fr.idx);
        const int deg = face->deg;
        const DWORD smGrp = effectiveSmGrpForDynamic(face->smGroup);
        const int matID = (int)face->material;

        if (matID != curMatID) {
            curMatID = matID;
            groups.push_back({ matID, (int)indices.size(), 0 });
        }

        MNMapFace* uvFace = (hasUVs && fr.idx < uvMap->numf) ? uvMap->F(fr.idx) : nullptr;
        MNMapFace* uv2Face = (hasUV2s && fr.idx < uv2Map->numf) ? uv2Map->F(fr.idx) : nullptr;

        triTab.SetCount(0);
        face->GetTriangles(triTab);
        const int numTris = triTab.Count() / 3;

        for (int ti = 0; ti < numTris; ti++) {
            for (int tv = 0; tv < 3; tv++) {
                int localIdx = triTab[ti * 3 + tv];
                DWORD posIdx = face->vtx[localIdx];
                DWORD uvIdx = (uvFace && localIdx < uvFace->deg) ? uvFace->tv[localIdx] : 0;
                DWORD uv2Idx = (uv2Face && localIdx < uv2Face->deg) ? uv2Face->tv[localIdx] : 0;
                uint64_t colorSig = 1469598103934665603ULL;
                for (size_t ci = 0; ci < vertexColorChannels.size(); ++ci) {
                    const int channel = vertexColorChannels[ci];
                    MNMap* colorMap = vertexColorMaps[ci];
                    int colorIdx = -1;
                    if (colorMap && fr.idx < colorMap->numf) {
                        MNMapFace* colorFace = colorMap->F(fr.idx);
                        if (colorFace && localIdx < colorFace->deg && colorFace->tv) {
                            colorIdx = colorFace->tv[localIdx];
                        }
                    }
                    colorSig = HashFNV1a(&channel, sizeof(channel), colorSig);
                    colorSig = HashFNV1a(&colorIdx, sizeof(colorIdx), colorSig);
                }

                const int specNid = resolveSpecNormalId(fr.idx, localIdx);
                // smGrp 0 = no smoothing: force unique vertices per face for flat normals.
                // Dynamic/deform extraction maps zero smoothing to one smooth
                // island above so bad faceted import normals do not explode
                // live playback topology. Explicit-normal corners merge by
                // their normal ID instead (handled via key.normalId), so they
                // skip the per-face smGrp split.
                DWORD keySmGrp = (specNid < 0 && smGrp == 0)
                    ? (DWORD)(0x80000000u | fr.idx)
                    : smGrp;
                MeshCornerKey key = { posIdx, uvIdx, hasUV2s ? uv2Idx : 0, keySmGrp, colorSig };
                key.normalId = specNid;
                auto it = vertMap.find(key);
                if (it != vertMap.end()) {
                    indices.push_back(it->second);
                } else {
                    int newIdx = (int)(verts.size() / 3);
                    vertMap[key] = newIdx;

                    Point3 p = mn.P(posIdx);
                    verts.push_back(p.x);
                    verts.push_back(p.y);
                    verts.push_back(p.z);

                    if (outNormals) {
                        const Point3 n = specNid >= 0
                            ? NormalizeNormalOrFallback(normalSpec->Normal(specNid), faceNormalsFlat[fr.idx])
                            : cornerNormals[faceCornerStart[fr.idx] + localIdx];
                        normals.push_back(n.x);
                        normals.push_back(n.y);
                        normals.push_back(n.z);
                    }

                    if (emitPrimaryUVs && hasUVs && uvIdx < (DWORD)uvMap->numv) {
                        UVVert uv = uvMap->v[uvIdx];
                        uvs.push_back(uv.x);
                        uvs.push_back(uv.y);
                    } else if (emitPrimaryUVs && hasUVs) {
                        uvs.push_back(0.0f);
                        uvs.push_back(0.0f);
                    }

                    if (hasUV2s) {
                        if (uv2Idx < (DWORD)uv2Map->numv) {
                            UVVert uv2 = uv2Map->v[uv2Idx];
                            outUV2s->push_back(uv2.x);
                            outUV2s->push_back(uv2.y);
                        } else {
                            outUV2s->push_back(0.0f);
                            outUV2s->push_back(0.0f);
                        }
                    }

                    if (outVertexColors) {
                        for (size_t ci = 0; ci < vertexColorChannels.size(); ++ci) {
                            const int channel = vertexColorChannels[ci];
                            MNMap* colorMap = vertexColorMaps[ci];
                            UVVert value = DefaultVertexColorValue(channel);
                            int colorIdx = -1;
                            if (colorMap && fr.idx < colorMap->numf) {
                                MNMapFace* colorFace = colorMap->F(fr.idx);
                                if (colorFace && localIdx < colorFace->deg && colorFace->tv) {
                                    colorIdx = colorFace->tv[localIdx];
                                }
                            }
                            if (colorMap && colorIdx >= 0 && colorIdx < colorMap->numv) {
                                value = colorMap->v[colorIdx];
                            }
                            AppendVertexColorValue((*outVertexColors)[ci].values, value, channel);
                        }
                    }

                    if (outControlIdx) outControlIdx->push_back(static_cast<int>(posIdx));
                    if (outFastVertexSources)
                        outFastVertexSources->push_back({ static_cast<int>(posIdx), smGrp, fr.idx, localIdx });
                    indices.push_back(newIdx);
                }
            }
            groups.back().count += 3;
        }
    }
    if (outNormals) *outNormals = std::move(normals);
    if (outVertexColors && outVertexColors->empty()) outVertexColors->clear();
    return !indices.empty();
}

// ── TriObject (Mesh) extraction — standard triangle meshes ──
static bool ExtractMeshFromTriObject(TriObject* tri, Object* srcObj,
                                     std::vector<float>& verts,
                                     std::vector<float>& uvs,
                                     std::vector<int>& indices,
                                     std::vector<MatGroup>& groups,
                                     std::vector<float>* outNormals = nullptr,
                                     std::vector<int>* outControlIdx = nullptr,
                                     std::vector<VertexColorAttributeRecord>* outVertexColors = nullptr,
                                     bool allowMapChannel1 = false,
                                     std::vector<FastVertexSource>* outFastVertexSources = nullptr,
                                     std::vector<float>* outUV2s = nullptr,
                                     bool emitPrimaryUVs = true) {
    Mesh& mesh = tri->GetMesh();
    int nv = mesh.getNumVerts();
    int nf = mesh.getNumFaces();

    if (nv == 0 || nf == 0) {
        if (tri != srcObj) tri->DeleteThis();
        return false;
    }

    bool hasUVs = mesh.getNumTVerts() > 0 && mesh.tvFace != nullptr;
    MeshMap* uv2Map = (outUV2s && MeshHasUsableMapChannel(mesh, 2)) ? &mesh.Map(2) : nullptr;
    const bool hasUV2s = uv2Map != nullptr;
    const std::vector<int> vertexColorChannels = CollectMeshVertexColorChannels(mesh, allowMapChannel1);
    const bool smoothZeroSmoothingForDynamic =
        !outNormals && (outFastVertexSources != nullptr || outControlIdx != nullptr);
    auto effectiveSmGrpForDynamic = [smoothZeroSmoothingForDynamic](DWORD smGrp) -> DWORD {
        return (smoothZeroSmoothingForDynamic && smGrp == 0) ? 0x7fffffffu : smGrp;
    };

    std::vector<int> faceOrder;
    faceOrder.reserve(nf);
    int firstMatID = (int)mesh.faces[0].getMatID();
    bool multiMatIDs = false;
    for (int f = 0; f < nf; f++) {
        faceOrder.push_back(f);
        if ((int)mesh.faces[f].getMatID() != firstMatID) multiMatIDs = true;
    }
    if (multiMatIDs) {
        std::sort(faceOrder.begin(), faceOrder.end(), [&](int a, int b) {
            return mesh.faces[a].getMatID() < mesh.faces[b].getMatID();
        });
    }

    // Explicit (specified) normals — Edit Normals modifier, weighted normals,
    // imported custom normals, etc. Override the implicit smoothing-group
    // computation per corner when present.
    MeshNormalSpec* normalSpec = mesh.GetSpecifiedNormals();
    const bool hasNormalSpec = normalSpec &&
        normalSpec->GetNumFaces() == nf &&
        normalSpec->GetNumNormals() > 0;
    const int specNormalCount = hasNormalSpec ? normalSpec->GetNumNormals() : 0;
    auto resolveSpecNormalId = [&](int faceIdx, int corner) -> int {
        if (!hasNormalSpec || corner < 0 || corner > 2) return -1;
        MeshNormalFace& nf = normalSpec->Face(faceIdx);
        if (!nf.GetSpecified(corner)) return -1;
        const int nid = nf.GetNormalID(corner);
        return (nid >= 0 && nid < specNormalCount) ? nid : -1;
    };

    std::vector<Point3> faceNormals;
    std::vector<Point3> cornerNormals;
    if (outNormals) {
        faceNormals.assign(nf, Point3(0, 0, 0));

        concurrency::parallel_for(0, nf, [&](int f) {
            faceNormals[f] = ComputeMeshFaceNormalSafe(mesh, f);
        });

        std::vector<int> vertCornerOff(static_cast<size_t>(nv) + 1, 0);
        for (int f = 0; f < nf; f++) {
            for (int v = 0; v < 3; v++) vertCornerOff[mesh.faces[f].v[v] + 1]++;
        }
        for (int i = 1; i <= nv; i++) vertCornerOff[i] += vertCornerOff[i - 1];

        struct TriCorner { int faceIdx; int localV; DWORD smGrp; };
        std::vector<TriCorner> vertCornersFlat(static_cast<size_t>(nf) * 3);
        {
            std::vector<int> cursor(nv, 0);
            for (int f = 0; f < nf; f++) {
                DWORD smGrp = effectiveSmGrpForDynamic(mesh.faces[f].getSmGroup());
                for (int v = 0; v < 3; v++) {
                    int pIdx = mesh.faces[f].v[v];
                    vertCornersFlat[vertCornerOff[pIdx] + cursor[pIdx]++] = { f, v, smGrp };
                }
            }
        }

        cornerNormals.assign(static_cast<size_t>(nf) * 3, Point3(0, 0, 0));
        concurrency::parallel_for(0, nv, [&](int posIdx) {
            const int beg = vertCornerOff[posIdx];
            const int end = vertCornerOff[posIdx + 1];
            for (int i = beg; i < end; i++) {
                const TriCorner& c = vertCornersFlat[i];
                Point3 accum = faceNormals[c.faceIdx];
                if (c.smGrp != 0) {
                    for (int j = beg; j < end; j++) {
                        if (j == i) continue;
                        const TriCorner& other = vertCornersFlat[j];
                        if (other.faceIdx == c.faceIdx) continue;
                        if ((other.smGrp & c.smGrp) != 0) accum += faceNormals[other.faceIdx];
                    }
                }
                cornerNormals[c.faceIdx * 3 + c.localV] = NormalizeNormalOrFallback(accum);
            }
        });
    }

    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    verts.reserve(nv * 3);
    if (emitPrimaryUVs && hasUVs) uvs.reserve(nv * 2);
    if (hasUV2s) outUV2s->reserve(nv * 2);
    indices.reserve(nf * 3);
    std::vector<float> normals;
    if (outNormals) normals.reserve(nv * 3);
    if (outControlIdx) outControlIdx->clear();
    if (outFastVertexSources) outFastVertexSources->clear();
    if (outVertexColors) {
        outVertexColors->clear();
        outVertexColors->reserve(vertexColorChannels.size());
        for (int channel : vertexColorChannels) {
            VertexColorAttributeRecord attr;
            attr.channel = channel;
            attr.attrName = GetVertexColorAttributeName(channel);
            attr.values.reserve(static_cast<size_t>(nf) * 3 * 4);
            outVertexColors->push_back(std::move(attr));
        }
    }

    int curMatID = -1;
    for (int fi = 0; fi < nf; fi++) {
        int f = faceOrder[fi];
        int matID = (int)mesh.faces[f].getMatID();

        if (matID != curMatID) {
            curMatID = matID;
            groups.push_back({ matID, (int)indices.size(), 0 });
        }

        for (int v = 0; v < 3; v++) {
            DWORD posIdx = mesh.faces[f].v[v];
            DWORD uvIdx  = hasUVs ? mesh.tvFace[f].t[v] : 0;
            DWORD uv2Idx = (hasUV2s && f < uv2Map->fnum) ? uv2Map->tf[f].t[v] : 0;
            DWORD smGrp  = effectiveSmGrpForDynamic(mesh.faces[f].getSmGroup());
            uint64_t colorSig = 1469598103934665603ULL;
            for (int channel : vertexColorChannels) {
                int colorIdx = -1;
                const MeshMap& colorMap = mesh.Map(channel);
                if (colorMap.tf && f < colorMap.fnum) {
                    colorIdx = colorMap.tf[f].t[v];
                }
                colorSig = HashFNV1a(&channel, sizeof(channel), colorSig);
                colorSig = HashFNV1a(&colorIdx, sizeof(colorIdx), colorSig);
            }
            const int specNid = resolveSpecNormalId(f, v);
            const DWORD keySmGrp = (specNid < 0 && smGrp == 0)
                ? (DWORD)(0x80000000u | static_cast<DWORD>(f))
                : smGrp;
            MeshCornerKey key = { posIdx, uvIdx, hasUV2s ? uv2Idx : 0, keySmGrp, colorSig };
            key.normalId = specNid;

            auto it = vertMap.find(key);
            if (it != vertMap.end()) {
                indices.push_back(it->second);
            } else {
                int newIdx = (int)(verts.size() / 3);
                vertMap[key] = newIdx;

                Point3 p = mesh.getVert(posIdx);
                verts.push_back(p.x);
                verts.push_back(p.y);
                verts.push_back(p.z);

                if (outNormals) {
                    const Point3 n = specNid >= 0
                        ? NormalizeNormalOrFallback(normalSpec->Normal(specNid), faceNormals[f])
                        : cornerNormals[f * 3 + v];
                    normals.push_back(n.x);
                    normals.push_back(n.y);
                    normals.push_back(n.z);
                }

                if (emitPrimaryUVs && hasUVs) {
                    UVVert uv = mesh.tVerts[uvIdx];
                    uvs.push_back(uv.x);
                    uvs.push_back(uv.y);
                }

                if (hasUV2s) {
                    if (uv2Idx < static_cast<DWORD>(uv2Map->vnum)) {
                        UVVert uv2 = uv2Map->tv[uv2Idx];
                        outUV2s->push_back(uv2.x);
                        outUV2s->push_back(uv2.y);
                    } else {
                        outUV2s->push_back(0.0f);
                        outUV2s->push_back(0.0f);
                    }
                }

                if (outVertexColors) {
                    for (size_t ci = 0; ci < vertexColorChannels.size(); ++ci) {
                        const int channel = vertexColorChannels[ci];
                        const MeshMap& colorMap = mesh.Map(channel);
                        UVVert value = DefaultVertexColorValue(channel);
                        int colorIdx = -1;
                        if (colorMap.tf && f < colorMap.fnum) {
                            colorIdx = colorMap.tf[f].t[v];
                        }
                        if (colorIdx >= 0 && colorIdx < colorMap.vnum && colorMap.tv) {
                            value = colorMap.tv[colorIdx];
                        }
                        AppendVertexColorValue((*outVertexColors)[ci].values, value, channel);
                    }
                }

                if (outControlIdx) outControlIdx->push_back(static_cast<int>(posIdx));
                if (outFastVertexSources)
                    outFastVertexSources->push_back({ static_cast<int>(posIdx), smGrp, f, v });
                indices.push_back(newIdx);
            }
        }
        groups.back().count += 3;
    }

    if (outNormals) *outNormals = std::move(normals);
    if (tri != srcObj) tri->DeleteThis();
    return true;
}

// ── Raw Mesh extraction — for Forest Pack fi.mesh pointers ──
static bool ExtractMeshFromRawMesh(Mesh& mesh,
                                   std::vector<float>& verts,
                                   std::vector<float>& uvs,
                                   std::vector<int>& indices,
                                   std::vector<MatGroup>& groups,
                                   std::vector<float>* outNormals = nullptr,
                                   std::vector<VertexColorAttributeRecord>* outVertexColors = nullptr,
                                   bool allowMapChannel1 = false) {
    int nv = mesh.getNumVerts();
    int nf = mesh.getNumFaces();
    if (nv == 0 || nf == 0) return false;

    bool hasUVs = mesh.getNumTVerts() > 0;
    const std::vector<int> vertexColorChannels = CollectMeshVertexColorChannels(mesh, allowMapChannel1);

    std::vector<int> faceOrder;
    faceOrder.reserve(nf);
    int firstMatID = (int)mesh.faces[0].getMatID();
    bool multiMatIDs = false;
    for (int f = 0; f < nf; f++) {
        faceOrder.push_back(f);
        if ((int)mesh.faces[f].getMatID() != firstMatID) multiMatIDs = true;
    }
    if (multiMatIDs) {
        std::sort(faceOrder.begin(), faceOrder.end(), [&](int a, int b) {
            return mesh.faces[a].getMatID() < mesh.faces[b].getMatID();
        });
    }

    std::vector<Point3> faceNormals;
    std::vector<Point3> cornerNormals;
    if (outNormals) {
        faceNormals.assign(nf, Point3(0, 0, 0));

        concurrency::parallel_for(0, nf, [&](int f) {
            faceNormals[f] = ComputeMeshFaceNormalSafe(mesh, f);
        });

        std::vector<int> vertCornerOff(static_cast<size_t>(nv) + 1, 0);
        for (int f = 0; f < nf; f++) {
            for (int v = 0; v < 3; v++) vertCornerOff[mesh.faces[f].v[v] + 1]++;
        }
        for (int i = 1; i <= nv; i++) vertCornerOff[i] += vertCornerOff[i - 1];

        struct TriCorner { int faceIdx; int localV; DWORD smGrp; };
        std::vector<TriCorner> vertCornersFlat(static_cast<size_t>(nf) * 3);
        {
            std::vector<int> cursor(nv, 0);
            for (int f = 0; f < nf; f++) {
                DWORD smGrp = mesh.faces[f].getSmGroup();
                for (int v = 0; v < 3; v++) {
                    int pIdx = mesh.faces[f].v[v];
                    vertCornersFlat[vertCornerOff[pIdx] + cursor[pIdx]++] = { f, v, smGrp };
                }
            }
        }

        cornerNormals.assign(static_cast<size_t>(nf) * 3, Point3(0, 0, 0));
        concurrency::parallel_for(0, nv, [&](int posIdx) {
            const int beg = vertCornerOff[posIdx];
            const int end = vertCornerOff[posIdx + 1];
            for (int i = beg; i < end; i++) {
                const TriCorner& c = vertCornersFlat[i];
                Point3 accum = faceNormals[c.faceIdx];
                if (c.smGrp != 0) {
                    for (int j = beg; j < end; j++) {
                        if (j == i) continue;
                        const TriCorner& other = vertCornersFlat[j];
                        if (other.faceIdx == c.faceIdx) continue;
                        if ((other.smGrp & c.smGrp) != 0) accum += faceNormals[other.faceIdx];
                    }
                }
                cornerNormals[c.faceIdx * 3 + c.localV] = NormalizeNormalOrFallback(accum);
            }
        });
    }

    std::unordered_map<MeshCornerKey, int, MeshCornerKeyHash> vertMap;
    vertMap.reserve(static_cast<size_t>(nf) * 3);
    verts.reserve(nv * 3);
    if (hasUVs) uvs.reserve(nv * 2);
    indices.reserve(nf * 3);
    std::vector<float> normals;
    if (outNormals) normals.reserve(nv * 3);
    if (outVertexColors) {
        outVertexColors->clear();
        outVertexColors->reserve(vertexColorChannels.size());
        for (int channel : vertexColorChannels) {
            VertexColorAttributeRecord attr;
            attr.channel = channel;
            attr.attrName = GetVertexColorAttributeName(channel);
            attr.values.reserve(static_cast<size_t>(nf) * 3 * 4);
            outVertexColors->push_back(std::move(attr));
        }
    }

    int curMatID = -1;
    for (int fi = 0; fi < nf; fi++) {
        int f = faceOrder[fi];
        int matID = (int)mesh.faces[f].getMatID();

        if (matID != curMatID) {
            curMatID = matID;
            groups.push_back({ matID, (int)indices.size(), 0 });
        }

        for (int v = 0; v < 3; v++) {
            DWORD posIdx = mesh.faces[f].v[v];
            DWORD uvIdx  = hasUVs ? mesh.tvFace[f].t[v] : 0;
            DWORD smGrp  = mesh.faces[f].getSmGroup();
            uint64_t colorSig = 1469598103934665603ULL;
            for (int channel : vertexColorChannels) {
                int colorIdx = -1;
                const MeshMap& colorMap = mesh.Map(channel);
                if (colorMap.tf && f < colorMap.fnum) {
                    colorIdx = colorMap.tf[f].t[v];
                }
                colorSig = HashFNV1a(&channel, sizeof(channel), colorSig);
                colorSig = HashFNV1a(&colorIdx, sizeof(colorIdx), colorSig);
            }
            const DWORD keySmGrp = smGrp == 0
                ? (DWORD)(0x80000000u | static_cast<DWORD>(f))
                : smGrp;
            MeshCornerKey key = { posIdx, uvIdx, 0, keySmGrp, colorSig };

            auto it = vertMap.find(key);
            if (it != vertMap.end()) {
                indices.push_back(it->second);
            } else {
                int newIdx = (int)(verts.size() / 3);
                vertMap[key] = newIdx;

                Point3 p = mesh.getVert(posIdx);
                verts.push_back(p.x);
                verts.push_back(p.y);
                verts.push_back(p.z);

                if (outNormals) {
                    const Point3& n = cornerNormals[f * 3 + v];
                    normals.push_back(n.x);
                    normals.push_back(n.y);
                    normals.push_back(n.z);
                }

                if (hasUVs) {
                    UVVert uv = mesh.tVerts[uvIdx];
                    uvs.push_back(uv.x);
                    uvs.push_back(uv.y);
                }

                if (outVertexColors) {
                    for (size_t ci = 0; ci < vertexColorChannels.size(); ++ci) {
                        const int channel = vertexColorChannels[ci];
                        const MeshMap& colorMap = mesh.Map(channel);
                        UVVert value = DefaultVertexColorValue(channel);
                        int colorIdx = -1;
                        if (colorMap.tf && f < colorMap.fnum) {
                            colorIdx = colorMap.tf[f].t[v];
                        }
                        if (colorIdx >= 0 && colorIdx < colorMap.vnum && colorMap.tv) {
                            value = colorMap.tv[colorIdx];
                        }
                        AppendVertexColorValue((*outVertexColors)[ci].values, value, channel);
                    }
                }

                indices.push_back(newIdx);
            }
        }
        groups.back().count += 3;
    }
    if (outNormals) *outNormals = std::move(normals);
    return !indices.empty();
}

static bool ProbeHairModifierOnNode(INode* node, MaxSDK::IHairModifier*& outHair, MSTR* outSourceClassName = nullptr);

class MaxJSNullView : public View {
public:
    Point2 ViewToScreen(Point3 p) override { return Point2(p.x, p.y); }
    MaxJSNullView() {
        worldToView.IdentityMatrix();
        affineTM.IdentityMatrix();
        screenW = 640.0f;
        screenH = 480.0f;
        projType = 0;
        fov = 0.0f;
        pixelSize = 1.0f;
        flags = 0;
    }
};

static bool ShouldUseHairRenderMeshFallback(INode* node) {
    // Disabled — IsHairEnabled() is unreliable on built-in HairMod.
    // Hair-bearing nodes are now handled exclusively by the strand extraction path.
    (void)node;
    return false;
}

static void ApplyMatrixToVertexBuffer(std::vector<float>& verts, const Matrix3& tm) {
    for (size_t i = 0; i + 2 < verts.size(); i += 3) {
        Point3 p(verts[i + 0], verts[i + 1], verts[i + 2]);
        p = p * tm;
        verts[i + 0] = p.x;
        verts[i + 1] = p.y;
        verts[i + 2] = p.z;
    }
}

static void AppendExtractedGeometry(std::vector<float>& dstVerts,
                                    std::vector<int>& dstIndices,
                                    std::vector<MatGroup>& dstGroups,
                                    const std::vector<float>& srcVerts,
                                    const std::vector<int>& srcIndices,
                                    const std::vector<MatGroup>& srcGroups) {
    const int vertexBase = static_cast<int>(dstVerts.size() / 3);
    const int indexBase = static_cast<int>(dstIndices.size());

    dstVerts.insert(dstVerts.end(), srcVerts.begin(), srcVerts.end());
    for (int idx : srcIndices) {
        dstIndices.push_back(vertexBase + idx);
    }
    for (const MatGroup& group : srcGroups) {
        dstGroups.push_back({ group.matID, indexBase + group.start, group.count });
    }
}

static bool ExtractRenderMeshGeometry(INode* node, TimeValue t,
                                      std::vector<float>& verts,
                                      std::vector<float>& uvs,
                                      std::vector<int>& indices,
                                      std::vector<MatGroup>& groups) {
    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;

    GeomObject* geom = static_cast<GeomObject*>(os.obj);
    MaxJSNullView view;
    bool any = false;

    auto appendMesh = [&](Mesh* mesh, const Matrix3* meshTM) {
        if (!mesh) return;
        std::vector<float> meshVerts, meshUvs;
        std::vector<int> meshIndices;
        std::vector<MatGroup> meshGroups;
        if (!ExtractMeshFromRawMesh(*mesh, meshVerts, meshUvs, meshIndices, meshGroups, nullptr)) return;
        if (meshTM) {
            ApplyMatrixToVertexBuffer(meshVerts, *meshTM);
        }
        AppendExtractedGeometry(verts, indices, groups, meshVerts, meshIndices, meshGroups);
        any = true;
    };

    const int renderMeshCount = geom->NumberOfRenderMeshes();
    if (renderMeshCount > 0) {
        for (int meshIndex = 0; meshIndex < renderMeshCount; ++meshIndex) {
            BOOL needDelete = FALSE;
            Mesh* mesh = geom->GetMultipleRenderMesh(t, node, view, needDelete, meshIndex);
            Matrix3 meshTM;
            Interval meshTMValid = FOREVER;
            geom->GetMultipleRenderMeshTM(t, node, view, meshIndex, meshTM, meshTMValid);
            appendMesh(mesh, &meshTM);
            if (needDelete && mesh) delete mesh;
        }
    } else {
        BOOL needDelete = FALSE;
        Mesh* mesh = geom->GetRenderMesh(t, node, view, needDelete);
        appendMesh(mesh, nullptr);
        if (needDelete && mesh) delete mesh;
    }

    uvs.clear(); // Mixed render meshes may not provide stable UVs; prefer position-only fallback.
    return any && !verts.empty() && !indices.empty();
}

// ── Spline extraction — sample BezierShape curves into line vertices ──
static bool ExtractSpline(INode* node, TimeValue t,
                          std::vector<float>& verts,
                          std::vector<int>& indices) {
    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != SHAPE_CLASS_ID) return false;

    // Get BezierShape — either directly or via conversion
    SplineShape* converted = nullptr;
    BezierShape* bezShape = nullptr;

    if (os.obj->ClassID() == splineShapeClassID) {
        bezShape = &static_cast<SplineShape*>(os.obj)->shape;
    } else if (os.obj->CanConvertToType(splineShapeClassID)) {
        SplineShape* conv = static_cast<SplineShape*>(
            os.obj->ConvertToType(t, splineShapeClassID));
        if (conv && conv != os.obj) converted = conv;
        if (conv) bezShape = &conv->shape;
    }

    if (!bezShape || bezShape->SplineCount() == 0) {
        if (converted) converted->DeleteThis();
        return false;
    }

    const int STEPS = 6; // steps per spline segment
    int vertOffset = 0;

    for (int s = 0; s < bezShape->SplineCount(); s++) {
        Spline3D* spline = bezShape->GetSpline(s);
        if (!spline || spline->Segments() <= 0) continue;

        const int totalSteps = spline->Segments() * STEPS;
        const int startVert = vertOffset;

        for (int i = 0; i <= totalSteps; i++) {
            const float param = static_cast<float>(i) / static_cast<float>(totalSteps);
            Point3 pt = bezShape->InterpCurve3D(s, param, PARAM_SIMPLE);
            verts.push_back(pt.x);
            verts.push_back(pt.y);
            verts.push_back(pt.z);
            vertOffset++;
        }

        for (int i = startVert; i < vertOffset - 1; i++) {
            indices.push_back(i);
            indices.push_back(i + 1);
        }

        if (spline->Closed() && vertOffset - startVert > 2) {
            indices.push_back(vertOffset - 1);
            indices.push_back(startVert);
        }
    }

    if (converted) converted->DeleteThis();
    return !verts.empty();
}

// ── Unified ExtractMesh — MNMesh path for PolyObject, TriObject fallback ──
static bool ExtractMesh(INode* node, TimeValue t,
                        std::vector<float>& verts,
                        std::vector<float>& uvs,
                        std::vector<int>& indices,
                        std::vector<MatGroup>& groups,
                        std::vector<float>* normals = nullptr,
                        std::vector<int>* controlIdx = nullptr,
                        std::vector<VertexColorAttributeRecord>* outVertexColors = nullptr,
                        std::vector<FastVertexSource>* outFastVertexSources = nullptr,
                        std::vector<float>* outUV2s = nullptr,
                        bool emitPrimaryUVs = true,
                        FastDeformTopoEpoch* outEpoch = nullptr) {
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    // three.js Deform weight channel — needs the render→source vertex mapping
    // even when the caller didn't request controlIdx.
    const bool wantsDeformWeights = outVertexColors && NodeHasThreeJSDeformModifier(node);
    std::vector<int> deformWeightControlIdx;
    std::vector<int>* weightedControlIdx = controlIdx;
    if (wantsDeformWeights && !weightedControlIdx) weightedControlIdx = &deformWeightControlIdx;
    std::vector<float> deformWeights;

    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        // When UV2 is requested, prefer the evaluated object if the live
        // Editable Poly mesh does not carry map channel 2. This catches UVW /
        // Unwrap modifiers that author lightmap UVs above the base object
        // without putting UV2 into the hot geo_fast path.
        if (!outUV2s || MNMeshHasUsableMapChannel(*liveMN, 2)) {
            if (wantsDeformWeights) CaptureMNMeshDeformWeights(*liveMN, deformWeights);
            const bool ok = ExtractMeshFromMNMesh(*liveMN, verts, uvs, indices, groups, normals, weightedControlIdx, outVertexColors, allowMapChannel1, outFastVertexSources, outUV2s, emitPrimaryUVs);
            if (ok && wantsDeformWeights && !deformWeights.empty())
                AppendDeformWeightChannel(deformWeights, *weightedControlIdx, outVertexColors);
            if (ok && outEpoch)
                CaptureFastDeformEpochFromMNMesh(*liveMN, node, t, nullptr, true, *outEpoch);
            return ok;
        }
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (ShouldUseHairRenderMeshFallback(node)) {
        return ExtractRenderMeshGeometry(node, t, verts, uvs, indices, groups);
    }

    // Prefer MNMesh path — handles ngons natively without ConvertToType
    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        MNMesh& mn = poly->GetMesh();
        if (wantsDeformWeights) CaptureMNMeshDeformWeights(mn, deformWeights);
        const bool ok = ExtractMeshFromMNMesh(mn, verts, uvs, indices, groups, normals, weightedControlIdx, outVertexColors, allowMapChannel1, outFastVertexSources, outUV2s, emitPrimaryUVs);
        if (ok && wantsDeformWeights && !deformWeights.empty())
            AppendDeformWeightChannel(deformWeights, *weightedControlIdx, outVertexColors);
        if (ok && outEpoch)
            CaptureFastDeformEpochFromMNMesh(mn, node, t, os.obj, false, *outEpoch);
        return ok;
    }

    // Fallback: convert to TriObject for non-poly geometry (primitives, patches, etc.)
    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;
    // Capture before extraction — ExtractMeshFromTriObject deletes converted
    // TriObjects on its way out.
    if (wantsDeformWeights) CaptureMeshDeformWeights(tri->GetMesh(), deformWeights);
    FastDeformTopoEpoch triEpoch;
    if (outEpoch)
        CaptureFastDeformEpochFromMesh(tri->GetMesh(), node, t, os.obj, false, triEpoch);
    const bool ok = ExtractMeshFromTriObject(tri, os.obj, verts, uvs, indices, groups, normals, weightedControlIdx, outVertexColors, allowMapChannel1, outFastVertexSources, outUV2s, emitPrimaryUVs);
    if (ok && wantsDeformWeights && !deformWeights.empty())
        AppendDeformWeightChannel(deformWeights, *weightedControlIdx, outVertexColors);
    if (ok && outEpoch) *outEpoch = triEpoch;
    return ok;
}

static bool TryHashExtractedRenderableGeometry(INode* node, TimeValue t, uint64_t& outHash) {
    std::vector<float> verts, uvs;
    std::vector<int> indices;
    std::vector<MatGroup> groups;
    std::vector<VertexColorAttributeRecord> vertexColors;
    if (ExtractMesh(node, t, verts, uvs, indices, groups, nullptr, nullptr, &vertexColors)) {
        outHash = HashMeshData(verts, indices, uvs, &vertexColors);
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!ShouldExtractRenderableShape(node, t, &os)) return false;
    if (!ExtractSpline(node, t, verts, indices)) return false;

    outHash = HashMeshData(verts, indices, uvs);
    return true;
}

static bool TryHashRenderableGeometryState(INode* node, TimeValue t, uint64_t& outHash) {
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        outHash = HashMNMeshStateWithUVs(*liveMN, allowMapChannel1);
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj) return false;

    if (os.obj->SuperClassID() == SHAPE_CLASS_ID) {
        return TryHashExtractedRenderableGeometry(node, t, outHash);
    }

    if (os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (ShouldUseHairRenderMeshFallback(node)) {
        return TryHashExtractedRenderableGeometry(node, t, outHash);
    }

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        outHash = HashMNMeshStateWithUVs(poly->GetMesh(), allowMapChannel1);
        return true;
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    outHash = HashMeshStateWithUVs(tri->GetMesh(), allowMapChannel1);
    if (tri != os.obj) tri->DeleteThis();
    return true;
}

static bool TryHashRenderableGeometryStateWithoutUVs(INode* node, TimeValue t, uint64_t& outHash) {
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        outHash = HashMNMeshState(*liveMN);
        const std::vector<int> channels = CollectMNMeshVertexColorChannels(*liveMN, allowMapChannel1);
        outHash = HashMNMeshVertexColorChannels(*liveMN, channels, outHash);
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj) return false;

    if (os.obj->SuperClassID() == SHAPE_CLASS_ID) {
        outHash = HashNodeGeometryState(node, t);
        return outHash != 0;
    }

    if (os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (ShouldUseHairRenderMeshFallback(node)) {
        outHash = HashNodeGeometryState(node, t);
        return outHash != 0;
    }

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        MNMesh& mn = static_cast<PolyObject*>(os.obj)->GetMesh();
        outHash = HashMNMeshState(mn);
        const std::vector<int> channels = CollectMNMeshVertexColorChannels(mn, allowMapChannel1);
        outHash = HashMNMeshVertexColorChannels(mn, channels, outHash);
        return true;
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    Mesh& mesh = tri->GetMesh();
    outHash = HashMeshState(mesh);
    const std::vector<int> channels = CollectMeshVertexColorChannels(mesh, allowMapChannel1);
    outHash = HashMeshVertexColorChannels(mesh, channels, outHash);
    if (tri != os.obj) tri->DeleteThis();
    return true;
}

static bool TryHashRenderableGeometryFastState(INode* node,
                                               TimeValue t,
                                               bool omitChannels,
                                               uint64_t& outHash) {
    return omitChannels
        ? TryHashRenderableGeometryStateWithoutUVs(node, t, outHash)
        : TryHashRenderableGeometryState(node, t, outHash);
}

static bool TryHashRenderableGeometryChannels(INode* node, TimeValue t, uint64_t& outHash) {
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        outHash = HashMNMeshChannelState(*liveMN, allowMapChannel1);
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;
    if (ShouldUseHairRenderMeshFallback(node)) return false;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        outHash = HashMNMeshChannelState(poly->GetMesh(), allowMapChannel1);
        return true;
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    outHash = HashMeshChannelState(tri->GetMesh(), allowMapChannel1);
    if (tri != os.obj) tri->DeleteThis();
    return true;
}

static bool NodeHasExtractableVertexColors(INode* node, TimeValue t) {
    if (!node) return false;
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return !CollectMNMeshVertexColorChannels(*liveMN, allowMapChannel1).empty();
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        PolyObject* poly = static_cast<PolyObject*>(os.obj);
        return !CollectMNMeshVertexColorChannels(poly->GetMesh(), allowMapChannel1).empty();
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;
    const bool hasVertexColors = !CollectMeshVertexColorChannels(tri->GetMesh(), allowMapChannel1).empty();
    if (tri != os.obj) tri->DeleteThis();
    return hasVertexColors;
}

static bool ExtractSkinnedFastPositions(INode* node,
                                        TimeValue t,
                                        const std::vector<int>& controlIdx,
                                        const FastDeformTopoEpoch& epoch,
                                        std::vector<float>& outVerts) {
    outVerts.clear();
    if (!node || controlIdx.empty() || !epoch.valid) return false;

    auto copyFromMN = [&](MNMesh& mn) {
        outVerts.resize(controlIdx.size() * 3);
        for (size_t i = 0; i < controlIdx.size(); ++i) {
            // Epoch match guarantees the cached index is valid for this topology.
            const Point3 p = mn.P(controlIdx[i]);
            outVerts[i * 3 + 0] = p.x;
            outVerts[i * 3 + 1] = p.y;
            outVerts[i * 3 + 2] = p.z;
        }
    };

    // Replay must read the same mesh source the cache was built from —
    // mixing the live Editable Poly mesh with an evaluated-stack mesh maps
    // indices across different topologies even when counts happen to agree.
    if (epoch.fromLiveMN) {
        MNMesh* liveMN = TryGetLiveEditablePolyMesh(node);
        if (!liveMN || !FastDeformEpochMatches(*liveMN, epoch)) return false;
        copyFromMN(*liveMN);
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        MNMesh& mn = static_cast<PolyObject*>(os.obj)->GetMesh();
        if (!FastDeformEpochMatches(mn, epoch)) return false;
        copyFromMN(mn);
        return true;
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    Mesh& mesh = tri->GetMesh();
    const bool ok = FastDeformEpochMatches(mesh, epoch);
    if (ok) {
        outVerts.resize(controlIdx.size() * 3);
        for (size_t i = 0; i < controlIdx.size(); ++i) {
            const Point3 p = mesh.getVert(controlIdx[i]);
            outVerts[i * 3 + 0] = p.x;
            outVerts[i * 3 + 1] = p.y;
            outVerts[i * 3 + 2] = p.z;
        }
    }
    if (tri != os.obj) tri->DeleteThis();
    return ok;
}

// ── Normal gather plan: build once per topology epoch ──
static void BuildFastNormalPlanFromMNMesh(MNMesh& mn,
                                          const std::vector<FastVertexSource>& sources,
                                          FastNormalPlan& plan) {
    const int nv = mn.VNum();
    const int nf = mn.FNum();
    plan.specId.clear();
    plan.gatherOff.clear();
    plan.gatherFaces.clear();

    MNNormalSpec* normalSpec = mn.GetSpecifiedNormals();
    plan.hasSpec = normalSpec &&
        normalSpec->GetNumFaces() == nf &&
        normalSpec->GetNumNormals() > 0;
    const int specNormalCount = plan.hasSpec ? normalSpec->GetNumNormals() : 0;

    // Build-time-only vertex → (face, smGroup) adjacency over live faces.
    std::vector<int> vertCornerOff(static_cast<size_t>(nv) + 1, 0);
    int totalCorners = 0;
    for (int f = 0; f < nf; ++f) {
        MNFace* face = mn.F(f);
        if (!face || face->GetFlag(MN_DEAD)) continue;
        for (int v = 0; v < face->deg; ++v) {
            const int pIdx = face->vtx[v];
            if (pIdx < 0 || pIdx >= nv) continue;
            vertCornerOff[pIdx + 1]++;
            totalCorners++;
        }
    }
    for (int i = 1; i <= nv; ++i) vertCornerOff[i] += vertCornerOff[i - 1];

    struct PlanCorner { int faceIdx; DWORD smGrp; };
    std::vector<PlanCorner> corners(static_cast<size_t>(totalCorners));
    {
        std::vector<int> cursor(nv, 0);
        for (int f = 0; f < nf; ++f) {
            MNFace* face = mn.F(f);
            if (!face || face->GetFlag(MN_DEAD)) continue;
            const DWORD smGrp = face->smGroup;
            for (int v = 0; v < face->deg; ++v) {
                const int pIdx = face->vtx[v];
                if (pIdx < 0 || pIdx >= nv) continue;
                corners[vertCornerOff[pIdx] + cursor[pIdx]++] = { f, smGrp };
            }
        }
    }

    plan.specId.assign(sources.size(), -1);
    plan.gatherOff.resize(sources.size() + 1);
    plan.gatherOff[0] = 0;
    plan.gatherFaces.reserve(sources.size());
    for (size_t i = 0; i < sources.size(); ++i) {
        const FastVertexSource& src = sources[i];
        const bool validFace = src.faceIdx >= 0 && src.faceIdx < nf;
        int specNid = -1;
        if (plan.hasSpec && validFace && src.localIdx >= 0) {
            MNNormalFace& nfSpec = normalSpec->Face(src.faceIdx);
            if (src.localIdx < nfSpec.GetDegree() && nfSpec.GetSpecified(src.localIdx)) {
                const int nid = nfSpec.GetNormalID(src.localIdx);
                if (nid >= 0 && nid < specNormalCount) specNid = nid;
            }
        }
        plan.specId[i] = specNid;
        if (specNid < 0) {
            const size_t rowStart = plan.gatherFaces.size();
            if (src.smGroup == 0) {
                if (validFace) plan.gatherFaces.push_back(static_cast<uint32_t>(src.faceIdx));
            } else if (src.controlIdx >= 0 && src.controlIdx < nv) {
                const int beg = vertCornerOff[src.controlIdx];
                const int end = vertCornerOff[src.controlIdx + 1];
                for (int j = beg; j < end; ++j) {
                    if ((corners[j].smGrp & src.smGroup) != 0)
                        plan.gatherFaces.push_back(static_cast<uint32_t>(corners[j].faceIdx));
                }
            }
            if (plan.gatherFaces.size() == rowStart && validFace)
                plan.gatherFaces.push_back(static_cast<uint32_t>(src.faceIdx));
        }
        plan.gatherOff[i + 1] = static_cast<uint32_t>(plan.gatherFaces.size());
    }
    plan.built = true;
}

static void BuildFastNormalPlanFromMesh(Mesh& mesh,
                                        const std::vector<FastVertexSource>& sources,
                                        FastNormalPlan& plan) {
    const int nv = mesh.getNumVerts();
    const int nf = mesh.getNumFaces();
    plan.specId.clear();
    plan.gatherOff.clear();
    plan.gatherFaces.clear();

    MeshNormalSpec* normalSpec = mesh.GetSpecifiedNormals();
    plan.hasSpec = normalSpec &&
        normalSpec->GetNumFaces() == nf &&
        normalSpec->GetNumNormals() > 0;
    const int specNormalCount = plan.hasSpec ? normalSpec->GetNumNormals() : 0;

    std::vector<int> vertCornerOff(static_cast<size_t>(nv) + 1, 0);
    for (int f = 0; f < nf; ++f) {
        for (int v = 0; v < 3; ++v) vertCornerOff[mesh.faces[f].v[v] + 1]++;
    }
    for (int i = 1; i <= nv; ++i) vertCornerOff[i] += vertCornerOff[i - 1];

    struct PlanCorner { int faceIdx; DWORD smGrp; };
    std::vector<PlanCorner> corners(static_cast<size_t>(nf) * 3);
    {
        std::vector<int> cursor(nv, 0);
        for (int f = 0; f < nf; ++f) {
            const DWORD smGrp = mesh.faces[f].getSmGroup();
            for (int v = 0; v < 3; ++v) {
                const int pIdx = mesh.faces[f].v[v];
                corners[vertCornerOff[pIdx] + cursor[pIdx]++] = { f, smGrp };
            }
        }
    }

    plan.specId.assign(sources.size(), -1);
    plan.gatherOff.resize(sources.size() + 1);
    plan.gatherOff[0] = 0;
    plan.gatherFaces.reserve(sources.size());
    for (size_t i = 0; i < sources.size(); ++i) {
        const FastVertexSource& src = sources[i];
        const bool validFace = src.faceIdx >= 0 && src.faceIdx < nf;
        int specNid = -1;
        if (plan.hasSpec && validFace && src.localIdx >= 0 && src.localIdx < 3) {
            MeshNormalFace& nfSpec = normalSpec->Face(src.faceIdx);
            if (nfSpec.GetSpecified(src.localIdx)) {
                const int nid = nfSpec.GetNormalID(src.localIdx);
                if (nid >= 0 && nid < specNormalCount) specNid = nid;
            }
        }
        plan.specId[i] = specNid;
        if (specNid < 0) {
            const size_t rowStart = plan.gatherFaces.size();
            if (src.smGroup == 0) {
                if (validFace) plan.gatherFaces.push_back(static_cast<uint32_t>(src.faceIdx));
            } else if (src.controlIdx >= 0 && src.controlIdx < nv) {
                const int beg = vertCornerOff[src.controlIdx];
                const int end = vertCornerOff[src.controlIdx + 1];
                for (int j = beg; j < end; ++j) {
                    if ((corners[j].smGrp & src.smGroup) != 0)
                        plan.gatherFaces.push_back(static_cast<uint32_t>(corners[j].faceIdx));
                }
            }
            if (plan.gatherFaces.size() == rowStart && validFace)
                plan.gatherFaces.push_back(static_cast<uint32_t>(src.faceIdx));
        }
        plan.gatherOff[i + 1] = static_cast<uint32_t>(plan.gatherFaces.size());
    }
    plan.built = true;
}

// ── Per-frame normal pass: face normals + CSR gather, zero allocations
//    beyond the persistent scratch. Replaces the per-frame adjacency
//    rebuild + smoothing-group scan the old fast path paid on every tick. ──
static void ApplyFastNormalPlan(MNMesh& mn,
                                const std::vector<FastVertexSource>& sources,
                                FastNormalPlan& plan,
                                std::vector<float>& outNormals) {
    const int nf = mn.FNum();
    MNNormalSpec* normalSpec = mn.GetSpecifiedNormals();
    const bool hasSpec = normalSpec &&
        normalSpec->GetNumFaces() == nf &&
        normalSpec->GetNumNormals() > 0;
    if (!plan.built || plan.hasSpec != hasSpec ||
        plan.gatherOff.size() != sources.size() + 1) {
        BuildFastNormalPlanFromMNMesh(mn, sources, plan);
    }
    const int specNormalCount = (plan.hasSpec && normalSpec) ? normalSpec->GetNumNormals() : 0;

    if (!plan.facePartitioner) plan.facePartitioner = std::make_unique<concurrency::affinity_partitioner>();
    if (!plan.vertPartitioner) plan.vertPartitioner = std::make_unique<concurrency::affinity_partitioner>();

    plan.faceNormalScratch.resize(static_cast<size_t>(nf));
    Point3* faceNormals = plan.faceNormalScratch.data();
    concurrency::parallel_for(0, nf, [&](int f) {
        faceNormals[f] = ComputeMNMeshFaceNormalSafe(mn, f);
    }, *plan.facePartitioner);

    outNormals.resize(sources.size() * 3);
    float* out = outNormals.data();
    concurrency::parallel_for(size_t(0), sources.size(), [&](size_t i) {
        const FastVertexSource& src = sources[i];
        const bool validFace = src.faceIdx >= 0 && src.faceIdx < nf;
        // Written unnormalized — the single batched (AVX2 8-wide when
        // available) normalize pass below replaces the per-corner rsqrt.
        Point3 n;
        const int specNid = plan.specId.empty() ? -1 : plan.specId[i];
        if (specNid >= 0 && specNid < specNormalCount) {
            n = normalSpec->Normal(specNid);
        } else {
            Point3 accum(0.0f, 0.0f, 0.0f);
            const uint32_t beg = plan.gatherOff[i];
            const uint32_t end = plan.gatherOff[i + 1];
            for (uint32_t j = beg; j < end; ++j) accum += faceNormals[plan.gatherFaces[j]];
            if (DotProd(accum, accum) <= 1.0e-20f && validFace) accum = faceNormals[src.faceIdx];
            n = accum;
        }
        out[i * 3 + 0] = n.x;
        out[i * 3 + 1] = n.y;
        out[i * 3 + 2] = n.z;
    }, *plan.vertPartitioner);
    ParallelGatherBlocks(sources.size(), [&](size_t beg, size_t end) {
        BatchNormalizeNormalsInPlace(out + beg * 3, end - beg);
    });
}

static void ApplyFastNormalPlan(Mesh& mesh,
                                const std::vector<FastVertexSource>& sources,
                                FastNormalPlan& plan,
                                std::vector<float>& outNormals) {
    const int nf = mesh.getNumFaces();
    MeshNormalSpec* normalSpec = mesh.GetSpecifiedNormals();
    const bool hasSpec = normalSpec &&
        normalSpec->GetNumFaces() == nf &&
        normalSpec->GetNumNormals() > 0;
    if (!plan.built || plan.hasSpec != hasSpec ||
        plan.gatherOff.size() != sources.size() + 1) {
        BuildFastNormalPlanFromMesh(mesh, sources, plan);
    }
    const int specNormalCount = (plan.hasSpec && normalSpec) ? normalSpec->GetNumNormals() : 0;

    if (!plan.facePartitioner) plan.facePartitioner = std::make_unique<concurrency::affinity_partitioner>();
    if (!plan.vertPartitioner) plan.vertPartitioner = std::make_unique<concurrency::affinity_partitioner>();

    plan.faceNormalScratch.resize(static_cast<size_t>(nf));
    Point3* faceNormals = plan.faceNormalScratch.data();
    concurrency::parallel_for(0, nf, [&](int f) {
        faceNormals[f] = ComputeMeshFaceNormalSafe(mesh, f);
    }, *plan.facePartitioner);

    outNormals.resize(sources.size() * 3);
    float* out = outNormals.data();
    concurrency::parallel_for(size_t(0), sources.size(), [&](size_t i) {
        const FastVertexSource& src = sources[i];
        const bool validFace = src.faceIdx >= 0 && src.faceIdx < nf;
        // Written unnormalized — the single batched (AVX2 8-wide when
        // available) normalize pass below replaces the per-corner rsqrt.
        Point3 n;
        const int specNid = plan.specId.empty() ? -1 : plan.specId[i];
        if (specNid >= 0 && specNid < specNormalCount) {
            n = normalSpec->Normal(specNid);
        } else {
            Point3 accum(0.0f, 0.0f, 0.0f);
            const uint32_t beg = plan.gatherOff[i];
            const uint32_t end = plan.gatherOff[i + 1];
            for (uint32_t j = beg; j < end; ++j) accum += faceNormals[plan.gatherFaces[j]];
            if (DotProd(accum, accum) <= 1.0e-20f && validFace) accum = faceNormals[src.faceIdx];
            n = accum;
        }
        out[i * 3 + 0] = n.x;
        out[i * 3 + 1] = n.y;
        out[i * 3 + 2] = n.z;
    }, *plan.vertPartitioner);
    ParallelGatherBlocks(sources.size(), [&](size_t beg, size_t end) {
        BatchNormalizeNormalsInPlace(out + beg * 3, end - beg);
    });
}

static bool ExtractMNMeshFastGeometry(MNMesh& mn,
                                      const std::vector<FastVertexSource>& sources,
                                      FastDeformGuard& guard,
                                      std::vector<float>& outVerts,
                                      std::vector<float>* outNormals) {
    outVerts.clear();
    if (outNormals) outNormals->clear();
    if (sources.empty() || !FastDeformEpochMatches(mn, guard.epoch)) return false;

    outVerts.resize(sources.size() * 3);
    float* dst = outVerts.data();
    const FastVertexSource* src = sources.data();
    ParallelGatherBlocks(sources.size(), [&](size_t beg, size_t end) {
        for (size_t i = beg; i < end; ++i) {
            // Epoch match guarantees the cached index is valid for this topology.
            const Point3 p = mn.P(src[i].controlIdx);
            dst[i * 3 + 0] = p.x;
            dst[i * 3 + 1] = p.y;
            dst[i * 3 + 2] = p.z;
        }
    });

    if (outNormals && mn.FNum() > 0)
        ApplyFastNormalPlan(mn, sources, guard.plan, *outNormals);
    return true;
}

static bool ExtractMeshFastGeometry(Mesh& mesh,
                                    const std::vector<FastVertexSource>& sources,
                                    FastDeformGuard& guard,
                                    std::vector<float>& outVerts,
                                    std::vector<float>* outNormals) {
    outVerts.clear();
    if (outNormals) outNormals->clear();
    if (sources.empty() || !FastDeformEpochMatches(mesh, guard.epoch)) return false;

    outVerts.resize(sources.size() * 3);
    float* dst = outVerts.data();
    const FastVertexSource* src = sources.data();
    ParallelGatherBlocks(sources.size(), [&](size_t beg, size_t end) {
        for (size_t i = beg; i < end; ++i) {
            const Point3 p = mesh.getVert(src[i].controlIdx);
            dst[i * 3 + 0] = p.x;
            dst[i * 3 + 1] = p.y;
            dst[i * 3 + 2] = p.z;
        }
    });

    if (outNormals && mesh.getNumFaces() > 0)
        ApplyFastNormalPlan(mesh, sources, guard.plan, *outNormals);
    return true;
}

// ══════════════════════════════════════════════════════════════
//  Sparse sub-object edit path
// ══════════════════════════════════════════════════════════════
// Above this moved-fraction the touched region is no longer "sparse" and a
// full plan-path refresh of the persistent buffers is cheaper than the
// per-vertex bookkeeping (soft selection / large-region drags).
static constexpr float kSparseMaxMovedFraction = 0.30f;
// Dirty lists below this size run serial — parallel_for overhead dominates.
static constexpr size_t kSparseParallelMinItems = 512;

// Result contract: 0 = cannot sparse-update (caller drops caches and takes
// the full extract path), 1 = buffers updated, send them, 2 = positions are
// byte-identical to what the viewer already has — skip the send entirely.
template <typename GetPosFn, typename FaceNormalFn, typename CornerNormalFn, typename ApplyFullNormalsFn>
static int FastSparseUpdateCore(int nv, int nf,
                                const std::vector<FastVertexSource>& sources,
                                FastNormalPlan& plan,
                                bool wantNormals,
                                const GetPosFn& getPos,
                                const FaceNormalFn& faceNormal,
                                const CornerNormalFn& cornerNormal,
                                const ApplyFullNormalsFn& applyFullNormals) {
    FastSparseState& sp = *plan.sparse;
    const size_t n = sources.size();
    if (nv <= 0 || n == 0) return 0;
    const size_t ctrlFloats = static_cast<size_t>(nv) * 3;
    const size_t renderFloats = n * 3;
    const FastVertexSource* srcArr = sources.data();

    const bool primed = sp.valid &&
        sp.controlPos.size() == ctrlFloats &&
        sp.renderPos.size() == renderFloats &&
        (!wantNormals || sp.renderNorms.size() == renderFloats) &&
        sp.ctrlMoved.size() == static_cast<size_t>(nv);
    if (!primed) {
        sp.controlPos.resize(ctrlFloats);
        float* cp = sp.controlPos.data();
        ParallelGatherBlocks(static_cast<size_t>(nv), [&](size_t beg, size_t end) {
            for (size_t c = beg; c < end; ++c) {
                const Point3 p = getPos(static_cast<int>(c));
                cp[c * 3 + 0] = p.x;
                cp[c * 3 + 1] = p.y;
                cp[c * 3 + 2] = p.z;
            }
        });
        sp.renderPos.resize(renderFloats);
        float* rp = sp.renderPos.data();
        ParallelGatherBlocks(n, [&](size_t beg, size_t end) {
            for (size_t i = beg; i < end; ++i) {
                const size_t c = static_cast<size_t>(srcArr[i].controlIdx);
                rp[i * 3 + 0] = cp[c * 3 + 0];
                rp[i * 3 + 1] = cp[c * 3 + 1];
                rp[i * 3 + 2] = cp[c * 3 + 2];
            }
        });
        if (wantNormals) applyFullNormals(sp.renderNorms);
        else sp.renderNorms.clear();
        sp.ctrlMoved.assign(static_cast<size_t>(nv), 0);
        sp.faceDirty.assign(wantNormals ? static_cast<size_t>(nf) : 0, 0);
        sp.renderDirty.assign(wantNormals ? n : 0, 0);
        sp.valid = true;
        return 1;
    }

    // Diff control positions against the persistent snapshot (exact float
    // compare — both sides came from the same pipeline). Updates the
    // snapshot in place and flags movers.
    float* cp = sp.controlPos.data();
    uint8_t* movedFlags = sp.ctrlMoved.data();
    ParallelGatherBlocks(static_cast<size_t>(nv), [&](size_t beg, size_t end) {
        for (size_t c = beg; c < end; ++c) {
            const Point3 p = getPos(static_cast<int>(c));
            float* dst = cp + c * 3;
            if (p.x != dst[0] || p.y != dst[1] || p.z != dst[2]) {
                dst[0] = p.x;
                dst[1] = p.y;
                dst[2] = p.z;
                movedFlags[c] = 1;
            }
        }
    });

    sp.movedCtrl.clear();
    const size_t maxMoved = static_cast<size_t>(nv * kSparseMaxMovedFraction) + 1;
    bool tooMany = false;
    for (int c = 0; c < nv; ++c) {
        if (!movedFlags[c]) continue;
        movedFlags[c] = 0;
        if (sp.movedCtrl.size() >= maxMoved) tooMany = true;
        else sp.movedCtrl.push_back(static_cast<uint32_t>(c));
    }
    if (!tooMany && sp.movedCtrl.empty()) return 2;

    float* rp = sp.renderPos.data();
    if (tooMany) {
        // Large-region edit: refresh everything through the plan path. The
        // control snapshot is already updated, so positions are a linear copy.
        ParallelGatherBlocks(n, [&](size_t beg, size_t end) {
            for (size_t i = beg; i < end; ++i) {
                const size_t c = static_cast<size_t>(srcArr[i].controlIdx);
                rp[i * 3 + 0] = cp[c * 3 + 0];
                rp[i * 3 + 1] = cp[c * 3 + 1];
                rp[i * 3 + 2] = cp[c * 3 + 2];
            }
        });
        if (wantNormals) applyFullNormals(sp.renderNorms);
        return 1;
    }

    // Sparse apply: scatter moved positions to their render verts and mark
    // every adjacent face dirty.
    sp.dirtyFaceList.clear();
    for (uint32_t c : sp.movedCtrl) {
        const float* P = cp + static_cast<size_t>(c) * 3;
        for (uint32_t k = sp.ctrlRenderOff[c]; k < sp.ctrlRenderOff[c + 1]; ++k) {
            const uint32_t r = sp.ctrlRenderIdx[k];
            rp[r * 3 + 0] = P[0];
            rp[r * 3 + 1] = P[1];
            rp[r * 3 + 2] = P[2];
        }
        if (wantNormals) {
            for (uint32_t k = sp.ctrlFaceOff[c]; k < sp.ctrlFaceOff[c + 1]; ++k) {
                const uint32_t f = sp.ctrlFaceIdx[k];
                if (!sp.faceDirty[f]) {
                    sp.faceDirty[f] = 1;
                    sp.dirtyFaceList.push_back(f);
                }
            }
        }
    }

    if (wantNormals && !sp.dirtyFaceList.empty()) {
        if (plan.faceNormalScratch.size() != static_cast<size_t>(nf)) return 0; // scratch lost — bail to full path
        Point3* fn = plan.faceNormalScratch.data();
        const std::vector<uint32_t>& dfl = sp.dirtyFaceList;
        if (dfl.size() >= kSparseParallelMinItems) {
            concurrency::parallel_for(size_t(0), dfl.size(), [&](size_t k) {
                fn[dfl[k]] = faceNormal(static_cast<int>(dfl[k]));
            });
        } else {
            for (uint32_t f : dfl) fn[f] = faceNormal(static_cast<int>(f));
        }

        sp.dirtyRenderList.clear();
        for (uint32_t f : dfl) {
            for (uint32_t k = sp.faceRenderOff[f]; k < sp.faceRenderOff[f + 1]; ++k) {
                const uint32_t r = sp.faceRenderIdx[k];
                if (!sp.renderDirty[r]) {
                    sp.renderDirty[r] = 1;
                    sp.dirtyRenderList.push_back(r);
                }
            }
            sp.faceDirty[f] = 0;
        }

        float* rn = sp.renderNorms.data();
        const std::vector<uint32_t>& drl = sp.dirtyRenderList;
        if (drl.size() >= kSparseParallelMinItems) {
            concurrency::parallel_for(size_t(0), drl.size(), [&](size_t k) {
                const Point3 nrm = cornerNormal(static_cast<size_t>(drl[k]));
                rn[drl[k] * 3 + 0] = nrm.x;
                rn[drl[k] * 3 + 1] = nrm.y;
                rn[drl[k] * 3 + 2] = nrm.z;
            });
        } else {
            for (uint32_t r : drl) {
                const Point3 nrm = cornerNormal(static_cast<size_t>(r));
                rn[r * 3 + 0] = nrm.x;
                rn[r * 3 + 1] = nrm.y;
                rn[r * 3 + 2] = nrm.z;
            }
        }
        for (uint32_t r : drl) sp.renderDirty[r] = 0;
    }
    return 1;
}

static int FastSparseUpdateFromMNMesh(MNMesh& mn,
                                      const std::vector<FastVertexSource>& sources,
                                      FastNormalPlan& plan,
                                      bool wantNormals) {
    const int nv = mn.VNum();
    const int nf = mn.FNum();
    const size_t n = sources.size();
    if (nv <= 0 || n == 0) return 0;

    MNNormalSpec* normalSpec = mn.GetSpecifiedNormals();
    const bool hasSpec = normalSpec &&
        normalSpec->GetNumFaces() == nf &&
        normalSpec->GetNumNormals() > 0;
    if (wantNormals && (!plan.built || plan.hasSpec != hasSpec ||
                        plan.gatherOff.size() != n + 1)) {
        BuildFastNormalPlanFromMNMesh(mn, sources, plan);
        if (plan.sparse) {
            // Gather table changed — the reverse face→render mapping is stale.
            plan.sparse->valid = false;
            plan.sparse->normalsAdjacencyBuilt = false;
        }
    }
    if (!plan.sparse) plan.sparse = std::make_unique<FastSparseState>();
    FastSparseState& sp = *plan.sparse;

    if (!sp.posAdjacencyBuilt) {
        sp.ctrlRenderOff.assign(static_cast<size_t>(nv) + 1, 0);
        for (size_t i = 0; i < n; ++i) sp.ctrlRenderOff[sources[i].controlIdx + 1]++;
        for (int c = 1; c <= nv; ++c) sp.ctrlRenderOff[c] += sp.ctrlRenderOff[c - 1];
        sp.ctrlRenderIdx.resize(n);
        {
            std::vector<uint32_t> cursor(sp.ctrlRenderOff.begin(), sp.ctrlRenderOff.end() - 1);
            for (size_t i = 0; i < n; ++i)
                sp.ctrlRenderIdx[cursor[sources[i].controlIdx]++] = static_cast<uint32_t>(i);
        }
        sp.posAdjacencyBuilt = true;
    }

    if (wantNormals && !sp.normalsAdjacencyBuilt) {
        // control vert → adjacent faces (all of them — any adjacent face
        // normal changes when the vertex moves, regardless of smoothing).
        sp.ctrlFaceOff.assign(static_cast<size_t>(nv) + 1, 0);
        for (int f = 0; f < nf; ++f) {
            MNFace* face = mn.F(f);
            if (!face || face->GetFlag(MN_DEAD)) continue;
            for (int v = 0; v < face->deg; ++v) {
                const int c = face->vtx[v];
                if (c >= 0 && c < nv) sp.ctrlFaceOff[c + 1]++;
            }
        }
        for (int c = 1; c <= nv; ++c) sp.ctrlFaceOff[c] += sp.ctrlFaceOff[c - 1];
        sp.ctrlFaceIdx.resize(sp.ctrlFaceOff[nv]);
        {
            std::vector<uint32_t> cursor(sp.ctrlFaceOff.begin(), sp.ctrlFaceOff.end() - 1);
            for (int f = 0; f < nf; ++f) {
                MNFace* face = mn.F(f);
                if (!face || face->GetFlag(MN_DEAD)) continue;
                for (int v = 0; v < face->deg; ++v) {
                    const int c = face->vtx[v];
                    if (c >= 0 && c < nv) sp.ctrlFaceIdx[cursor[c]++] = static_cast<uint32_t>(f);
                }
            }
        }

        // face → render verts that gather it: invert the plan's CSR rows,
        // plus each corner's own face (covers spec corners with empty rows).
        sp.faceRenderOff.assign(static_cast<size_t>(nf) + 1, 0);
        for (size_t i = 0; i < n; ++i) {
            const int ownFace = sources[i].faceIdx;
            if (ownFace >= 0 && ownFace < nf) sp.faceRenderOff[ownFace + 1]++;
            for (uint32_t j = plan.gatherOff[i]; j < plan.gatherOff[i + 1]; ++j)
                sp.faceRenderOff[plan.gatherFaces[j] + 1]++;
        }
        for (int f = 1; f <= nf; ++f) sp.faceRenderOff[f] += sp.faceRenderOff[f - 1];
        sp.faceRenderIdx.resize(sp.faceRenderOff[nf]);
        {
            std::vector<uint32_t> cursor(sp.faceRenderOff.begin(), sp.faceRenderOff.end() - 1);
            for (size_t i = 0; i < n; ++i) {
                const int ownFace = sources[i].faceIdx;
                if (ownFace >= 0 && ownFace < nf)
                    sp.faceRenderIdx[cursor[ownFace]++] = static_cast<uint32_t>(i);
                for (uint32_t j = plan.gatherOff[i]; j < plan.gatherOff[i + 1]; ++j)
                    sp.faceRenderIdx[cursor[plan.gatherFaces[j]]++] = static_cast<uint32_t>(i);
            }
        }
        sp.normalsAdjacencyBuilt = true;
    }

    const int specNormalCount = hasSpec ? normalSpec->GetNumNormals() : 0;
    const Point3 fallback(0.0f, 0.0f, 1.0f);
    const FastVertexSource* srcArr = sources.data();
    auto getPos = [&mn](int c) { return mn.P(c); };
    auto faceNormalFn = [&mn](int f) { return ComputeMNMeshFaceNormalSafe(mn, f); };
    auto cornerNormalFn = [&](size_t i) -> Point3 {
        const FastVertexSource& src = srcArr[i];
        const bool validFace = src.faceIdx >= 0 && src.faceIdx < nf;
        const Point3* fn = plan.faceNormalScratch.data();
        const int specNid = plan.specId.empty() ? -1 : plan.specId[i];
        if (specNid >= 0 && specNid < specNormalCount) {
            return NormalizeNormalOrFallback(normalSpec->Normal(specNid),
                                             validFace ? fn[src.faceIdx] : fallback);
        }
        Point3 accum(0.0f, 0.0f, 0.0f);
        for (uint32_t j = plan.gatherOff[i]; j < plan.gatherOff[i + 1]; ++j)
            accum += fn[plan.gatherFaces[j]];
        if (DotProd(accum, accum) <= 1.0e-20f && validFace) accum = fn[src.faceIdx];
        return NormalizeNormalOrFallback(accum, fallback);
    };
    auto applyFullNormals = [&](std::vector<float>& out) {
        ApplyFastNormalPlan(mn, sources, plan, out);
    };
    return FastSparseUpdateCore(nv, nf, sources, plan, wantNormals,
                                getPos, faceNormalFn, cornerNormalFn, applyFullNormals);
}

// Sub-object edit replay: same dispatch contract as ExtractSkinnedFastGeometry
// but incremental. v1 covers the live Editable Poly / Edit Poly path —
// exactly the meshes whose sub-object transforms are position-only, which is
// what makes the sparse diff safe (UV/color edits go through other edit
// objects and take the full path). Results live in guard.plan.sparse.
static int ExtractSubobjectSparseGeometry(INode* node,
                                          TimeValue t,
                                          const std::vector<FastVertexSource>& sources,
                                          FastDeformGuard& guard,
                                          bool wantNormals) {
    (void)t;
    if (!node || sources.empty() || !guard.epoch.valid) return 0;
    if (!guard.epoch.fromLiveMN) return 0;
    MNMesh* liveMN = TryGetLiveEditablePolyMesh(node);
    if (!liveMN || !FastDeformEpochMatches(*liveMN, guard.epoch)) return 0;
    return FastSparseUpdateFromMNMesh(*liveMN, sources, guard.plan, wantNormals);
}

static bool ExtractSkinnedFastGeometry(INode* node,
                                       TimeValue t,
                                       const std::vector<FastVertexSource>& sources,
                                       FastDeformGuard& guard,
                                       std::vector<float>& outVerts,
                                       std::vector<float>* outNormals) {
    if (!node || sources.empty() || !guard.epoch.valid) return false;

    // Replay the same mesh source the cache was built from (see
    // ExtractSkinnedFastPositions for why mixing sources corrupts).
    if (guard.epoch.fromLiveMN) {
        MNMesh* liveMN = TryGetLiveEditablePolyMesh(node);
        if (!liveMN) return false;
        return ExtractMNMeshFastGeometry(*liveMN, sources, guard, outVerts, outNormals);
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        MNMesh& mn = static_cast<PolyObject*>(os.obj)->GetMesh();
        return ExtractMNMeshFastGeometry(mn, sources, guard, outVerts, outNormals);
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    bool ok = ExtractMeshFastGeometry(tri->GetMesh(), sources, guard, outVerts, outNormals);
    if (tri != os.obj) tri->DeleteThis();
    return ok;
}
