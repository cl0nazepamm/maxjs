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
#include "threejs_splat.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <immintrin.h>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>
#include <ppl.h>

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
    uint64_t h = seed;
    // SSE: process 16 bytes at a time for large buffers
    // Fold 128-bit chunks into the hash via XOR + multiply cascade
    size_t i = 0;
    if (bytes >= 32) {
        for (; i + 15 < bytes; i += 16) {
            uint64_t lo, hi;
            memcpy(&lo, p + i, 8);
            memcpy(&hi, p + i + 8, 8);
            h ^= lo;
            h *= 1099511628211ULL;
            h ^= hi;
            h *= 1099511628211ULL;
        }
    }
    for (; i < bytes; i++) {
        h ^= static_cast<uint64_t>(p[i]);
        h *= 1099511628211ULL;
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

static uint64_t HashMeshState(Mesh& mesh) {
    uint64_t h = 1469598103934665603ULL;
    const int numVerts = mesh.getNumVerts();
    const int numFaces = mesh.getNumFaces();
    h = HashFNV1a(&numVerts, sizeof(numVerts), h);
    h = HashFNV1a(&numFaces, sizeof(numFaces), h);

    for (int i = 0; i < numVerts; ++i) {
        Point3 p = mesh.getVert(i);
        h = HashFNV1a(&p, sizeof(p), h);
    }

    for (int i = 0; i < numFaces; ++i) {
        Face& face = mesh.faces[i];
        const DWORD smGroup = face.getSmGroup();
        const MtlID matID = face.getMatID();
        h = HashFNV1a(face.v, sizeof(face.v), h);
        h = HashFNV1a(&smGroup, sizeof(smGroup), h);
        h = HashFNV1a(&matID, sizeof(matID), h);
    }

    return h;
}

static uint64_t HashMNMeshState(MNMesh& mn) {
    uint64_t h = 1469598103934665603ULL;
    const int numVerts = mn.VNum();
    const int numFaces = mn.FNum();
    h = HashFNV1a(&numVerts, sizeof(numVerts), h);
    h = HashFNV1a(&numFaces, sizeof(numFaces), h);

    for (int i = 0; i < numVerts; ++i) {
        const MNVert* vert = mn.V(i);
        const DWORD dead = (vert && vert->GetFlag(MN_DEAD)) ? 1u : 0u;
        const Point3 p = mn.P(i);
        h = HashFNV1a(&dead, sizeof(dead), h);
        h = HashFNV1a(&p, sizeof(p), h);
    }

    for (int i = 0; i < numFaces; ++i) {
        const MNFace* face = mn.F(i);
        if (!face) continue;

        const DWORD dead = face->GetFlag(MN_DEAD) ? 1u : 0u;
        const int deg = face->deg;
        const DWORD smGroup = face->smGroup;
        const MtlID matID = face->material;
        h = HashFNV1a(&dead, sizeof(dead), h);
        h = HashFNV1a(&deg, sizeof(deg), h);
        h = HashFNV1a(&smGroup, sizeof(smGroup), h);
        h = HashFNV1a(&matID, sizeof(matID), h);
        if (deg > 0 && face->vtx) {
            h = HashFNV1a(face->vtx, sizeof(int) * static_cast<size_t>(deg), h);
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
            for (int i = 0; i < numFaces; ++i) {
                h = HashFNV1a(map.tf[i].t, sizeof(map.tf[i].t), h);
            }
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
        for (int i = 0; i < numVerts; ++i) {
            const UVVert value = map->v[i];
            h = HashFNV1a(&value, sizeof(value), h);
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
        const int numFaces = mesh.getNumFaces();
        for (int i = 0; i < numFaces; ++i) {
            h = HashFNV1a(mesh.tvFace[i].t, sizeof(mesh.tvFace[i].t), h);
        }
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

    for (int i = 0; i < numFaces; ++i) {
        Face& face = mesh.faces[i];
        const DWORD smGroup = face.getSmGroup();
        const MtlID matID = face.getMatID();
        h = HashFNV1a(face.v, sizeof(face.v), h);
        h = HashFNV1a(&smGroup, sizeof(smGroup), h);
        h = HashFNV1a(&matID, sizeof(matID), h);
    }

    const int numTVerts = mesh.getNumTVerts();
    h = HashFNV1a(&numTVerts, sizeof(numTVerts), h);
    if (numTVerts > 0 && mesh.tVerts) {
        h = HashFNV1a(mesh.tVerts, static_cast<size_t>(numTVerts) * sizeof(UVVert), h);
    }

    if (numTVerts > 0 && mesh.tvFace) {
        for (int i = 0; i < numFaces; ++i) {
            h = HashFNV1a(mesh.tvFace[i].t, sizeof(mesh.tvFace[i].t), h);
        }
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

    for (int i = 0; i < numUVVerts; ++i) {
        UVVert uv = uvMap->v[i];
        h = HashFNV1a(&uv, sizeof(uv), h);
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

        const DWORD dead = face->GetFlag(MN_DEAD) ? 1u : 0u;
        const int deg = face->deg;
        const DWORD smGroup = face->smGroup;
        const MtlID matID = face->material;
        h = HashFNV1a(&dead, sizeof(dead), h);
        h = HashFNV1a(&deg, sizeof(deg), h);
        h = HashFNV1a(&smGroup, sizeof(smGroup), h);
        h = HashFNV1a(&matID, sizeof(matID), h);
        if (deg > 0 && face->vtx) {
            h = HashFNV1a(face->vtx, sizeof(int) * static_cast<size_t>(deg), h);
        }
    }

    MNMap* uvMap = mn.M(1);
    const bool hasUVs = uvMap && uvMap->GetFlag(MN_DEAD) == 0;
    const int numUVVerts = hasUVs ? uvMap->numv : 0;
    const int numUVFaces = hasUVs ? uvMap->numf : 0;
    h = HashFNV1a(&numUVVerts, sizeof(numUVVerts), h);
    h = HashFNV1a(&numUVFaces, sizeof(numUVFaces), h);
    if (hasUVs) {
        for (int i = 0; i < numUVVerts; ++i) {
            UVVert uv = uvMap->v[i];
            h = HashFNV1a(&uv, sizeof(uv), h);
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
static constexpr int kMaxBinaryDeltaTriangles = 600000;
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

static Point3 NormalizeNormalOrFallback(const Point3& value, const Point3& fallback = Point3(0.0f, 0.0f, 1.0f)) {
    if (!std::isfinite(value.x) || !std::isfinite(value.y) || !std::isfinite(value.z)) return fallback;
    return DotProd(value, value) > 1.0e-20f ? NormalizeSSE(value) : fallback;
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
                        bool emitPrimaryUVs = true) {
    const bool allowMapChannel1 = ShouldAllowVertexColorMapChannel1(node);
    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        // When UV2 is requested, prefer the evaluated object if the live
        // Editable Poly mesh does not carry map channel 2. This catches UVW /
        // Unwrap modifiers that author lightmap UVs above the base object
        // without putting UV2 into the hot geo_fast path.
        if (!outUV2s || MNMeshHasUsableMapChannel(*liveMN, 2)) {
            return ExtractMeshFromMNMesh(*liveMN, verts, uvs, indices, groups, normals, controlIdx, outVertexColors, allowMapChannel1, outFastVertexSources, outUV2s, emitPrimaryUVs);
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
        return ExtractMeshFromMNMesh(mn, verts, uvs, indices, groups, normals, controlIdx, outVertexColors, allowMapChannel1, outFastVertexSources, outUV2s, emitPrimaryUVs);
    }

    // Fallback: convert to TriObject for non-poly geometry (primitives, patches, etc.)
    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(
        os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;
    return ExtractMeshFromTriObject(tri, os.obj, verts, uvs, indices, groups, normals, controlIdx, outVertexColors, allowMapChannel1, outFastVertexSources, outUV2s, emitPrimaryUVs);
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
                                        std::vector<float>& outVerts) {
    outVerts.clear();
    if (!node || controlIdx.empty()) return false;

    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        outVerts.resize(controlIdx.size() * 3);
        for (size_t i = 0; i < controlIdx.size(); ++i) {
            const int ci = controlIdx[i];
            if (ci < 0 || ci >= liveMN->VNum()) {
                outVerts.clear();
                return false;
            }
            const Point3 p = liveMN->P(ci);
            outVerts[i * 3 + 0] = p.x;
            outVerts[i * 3 + 1] = p.y;
            outVerts[i * 3 + 2] = p.z;
        }
        return true;
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        MNMesh& mn = static_cast<PolyObject*>(os.obj)->GetMesh();
        outVerts.resize(controlIdx.size() * 3);
        for (size_t i = 0; i < controlIdx.size(); ++i) {
            const int ci = controlIdx[i];
            if (ci < 0 || ci >= mn.VNum()) {
                outVerts.clear();
                return false;
            }
            const Point3 p = mn.P(ci);
            outVerts[i * 3 + 0] = p.x;
            outVerts[i * 3 + 1] = p.y;
            outVerts[i * 3 + 2] = p.z;
        }
        return true;
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    Mesh& mesh = tri->GetMesh();
    outVerts.resize(controlIdx.size() * 3);
    bool ok = true;
    for (size_t i = 0; i < controlIdx.size(); ++i) {
        const int ci = controlIdx[i];
        if (ci < 0 || ci >= mesh.getNumVerts()) {
            ok = false;
            break;
        }
        const Point3 p = mesh.getVert(ci);
        outVerts[i * 3 + 0] = p.x;
        outVerts[i * 3 + 1] = p.y;
        outVerts[i * 3 + 2] = p.z;
    }

    if (!ok) outVerts.clear();
    if (tri != os.obj) tri->DeleteThis();
    return ok;
}

static bool ExtractMNMeshFastGeometry(MNMesh& mn,
                                      const std::vector<FastVertexSource>& sources,
                                      std::vector<float>& outVerts,
                                      std::vector<float>* outNormals) {
    const int nv = mn.VNum();
    const int nf = mn.FNum();
    outVerts.clear();
    if (nv <= 0 || sources.empty()) return false;

    outVerts.resize(sources.size() * 3);
    for (size_t i = 0; i < sources.size(); ++i) {
        const int ci = sources[i].controlIdx;
        if (ci < 0 || ci >= nv) {
            outVerts.clear();
            if (outNormals) outNormals->clear();
            return false;
        }
        const Point3 p = mn.P(ci);
        outVerts[i * 3 + 0] = p.x;
        outVerts[i * 3 + 1] = p.y;
        outVerts[i * 3 + 2] = p.z;
    }

    if (!outNormals) return true;
    outNormals->clear();
    if (nf <= 0) return true;

    MNNormalSpec* normalSpec = mn.GetSpecifiedNormals();
    const bool hasNormalSpec = normalSpec &&
        normalSpec->GetNumFaces() == nf &&
        normalSpec->GetNumNormals() > 0;
    const int specNormalCount = hasNormalSpec ? normalSpec->GetNumNormals() : 0;

    std::vector<Point3> faceNormals(nf, Point3(0, 0, 0));
    concurrency::parallel_for(0, nf, [&](int f) {
        faceNormals[f] = ComputeMNMeshFaceNormalSafe(mn, f);
    });

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

    struct FastMNCorner { int faceIdx; DWORD smGrp; };
    std::vector<FastMNCorner> vertCornersFlat(static_cast<size_t>(totalCorners));
    {
        std::vector<int> cursor(nv, 0);
        for (int f = 0; f < nf; ++f) {
            MNFace* face = mn.F(f);
            if (!face || face->GetFlag(MN_DEAD)) continue;
            const DWORD smGrp = face->smGroup;
            for (int v = 0; v < face->deg; ++v) {
                const int pIdx = face->vtx[v];
                if (pIdx < 0 || pIdx >= nv) continue;
                vertCornersFlat[vertCornerOff[pIdx] + cursor[pIdx]++] = { f, smGrp };
            }
        }
    }

    outNormals->resize(sources.size() * 3);
    const Point3 fallback(0.0f, 0.0f, 1.0f);
    concurrency::parallel_for(size_t(0), sources.size(), [&](size_t i) {
        const FastVertexSource& src = sources[i];
        const bool validFace = src.faceIdx >= 0 && src.faceIdx < nf;
        if (hasNormalSpec && validFace) {
            MNNormalFace& nfSpec = normalSpec->Face(src.faceIdx);
            if (src.localIdx >= 0 &&
                src.localIdx < nfSpec.GetDegree() &&
                nfSpec.GetSpecified(src.localIdx)) {
                const int nid = nfSpec.GetNormalID(src.localIdx);
                if (nid >= 0 && nid < specNormalCount) {
                    const Point3 n = NormalizeNormalOrFallback(normalSpec->Normal(nid), faceNormals[src.faceIdx]);
                    (*outNormals)[i * 3 + 0] = n.x;
                    (*outNormals)[i * 3 + 1] = n.y;
                    (*outNormals)[i * 3 + 2] = n.z;
                    return;
                }
            }
        }

        Point3 accum(0, 0, 0);
        if (src.smGroup == 0) {
            accum = validFace ? faceNormals[src.faceIdx] : fallback;
        } else {
            const int beg = vertCornerOff[src.controlIdx];
            const int end = vertCornerOff[src.controlIdx + 1];
            for (int j = beg; j < end; ++j) {
                const FastMNCorner& other = vertCornersFlat[j];
                if ((other.smGrp & src.smGroup) != 0) {
                    accum += faceNormals[other.faceIdx];
                }
            }
            if (DotProd(accum, accum) <= 1.0e-20f && validFace) {
                accum = faceNormals[src.faceIdx];
            }
        }
        const Point3 n = NormalizeNormalOrFallback(accum, fallback);
        (*outNormals)[i * 3 + 0] = n.x;
        (*outNormals)[i * 3 + 1] = n.y;
        (*outNormals)[i * 3 + 2] = n.z;
    });
    return true;
}

static bool ExtractMeshFastGeometry(Mesh& mesh,
                                    const std::vector<FastVertexSource>& sources,
                                    std::vector<float>& outVerts,
                                    std::vector<float>* outNormals) {
    const int nv = mesh.getNumVerts();
    const int nf = mesh.getNumFaces();
    outVerts.clear();
    if (nv <= 0 || sources.empty()) return false;

    outVerts.resize(sources.size() * 3);
    for (size_t i = 0; i < sources.size(); ++i) {
        const int ci = sources[i].controlIdx;
        if (ci < 0 || ci >= nv) {
            outVerts.clear();
            if (outNormals) outNormals->clear();
            return false;
        }
        const Point3 p = mesh.getVert(ci);
        outVerts[i * 3 + 0] = p.x;
        outVerts[i * 3 + 1] = p.y;
        outVerts[i * 3 + 2] = p.z;
    }

    if (!outNormals) return true;
    outNormals->clear();
    if (nf <= 0) return true;

    MeshNormalSpec* normalSpec = mesh.GetSpecifiedNormals();
    const bool hasNormalSpec = normalSpec &&
        normalSpec->GetNumFaces() == nf &&
        normalSpec->GetNumNormals() > 0;
    const int specNormalCount = hasNormalSpec ? normalSpec->GetNumNormals() : 0;

    std::vector<Point3> faceNormals(nf, Point3(0, 0, 0));
    concurrency::parallel_for(0, nf, [&](int f) {
        faceNormals[f] = ComputeMeshFaceNormalSafe(mesh, f);
    });

    std::vector<int> vertCornerOff(static_cast<size_t>(nv) + 1, 0);
    for (int f = 0; f < nf; ++f) {
        for (int v = 0; v < 3; ++v) vertCornerOff[mesh.faces[f].v[v] + 1]++;
    }
    for (int i = 1; i <= nv; ++i) vertCornerOff[i] += vertCornerOff[i - 1];

    struct FastTriCorner { int faceIdx; DWORD smGrp; };
    std::vector<FastTriCorner> vertCornersFlat(static_cast<size_t>(nf) * 3);
    {
        std::vector<int> cursor(nv, 0);
        for (int f = 0; f < nf; ++f) {
            const DWORD smGrp = mesh.faces[f].getSmGroup();
            for (int v = 0; v < 3; ++v) {
                const int pIdx = mesh.faces[f].v[v];
                vertCornersFlat[vertCornerOff[pIdx] + cursor[pIdx]++] = { f, smGrp };
            }
        }
    }

    outNormals->resize(sources.size() * 3);
    const Point3 fallback(0.0f, 0.0f, 1.0f);
    concurrency::parallel_for(size_t(0), sources.size(), [&](size_t i) {
        const FastVertexSource& src = sources[i];
        const bool validFace = src.faceIdx >= 0 && src.faceIdx < nf;
        if (hasNormalSpec && validFace) {
            MeshNormalFace& nfSpec = normalSpec->Face(src.faceIdx);
            if (src.localIdx >= 0 &&
                src.localIdx < 3 &&
                nfSpec.GetSpecified(src.localIdx)) {
                const int nid = nfSpec.GetNormalID(src.localIdx);
                if (nid >= 0 && nid < specNormalCount) {
                    const Point3 n = NormalizeNormalOrFallback(normalSpec->Normal(nid), faceNormals[src.faceIdx]);
                    (*outNormals)[i * 3 + 0] = n.x;
                    (*outNormals)[i * 3 + 1] = n.y;
                    (*outNormals)[i * 3 + 2] = n.z;
                    return;
                }
            }
        }

        Point3 accum(0, 0, 0);
        if (src.smGroup == 0) {
            accum = validFace ? faceNormals[src.faceIdx] : fallback;
        } else {
            const int beg = vertCornerOff[src.controlIdx];
            const int end = vertCornerOff[src.controlIdx + 1];
            for (int j = beg; j < end; ++j) {
                const FastTriCorner& other = vertCornersFlat[j];
                if ((other.smGrp & src.smGroup) != 0) {
                    accum += faceNormals[other.faceIdx];
                }
            }
            if (DotProd(accum, accum) <= 1.0e-20f && validFace) {
                accum = faceNormals[src.faceIdx];
            }
        }
        const Point3 n = NormalizeNormalOrFallback(accum, fallback);
        (*outNormals)[i * 3 + 0] = n.x;
        (*outNormals)[i * 3 + 1] = n.y;
        (*outNormals)[i * 3 + 2] = n.z;
    });
    return true;
}

static bool ExtractSkinnedFastGeometry(INode* node,
                                       TimeValue t,
                                       const std::vector<FastVertexSource>& sources,
                                       std::vector<float>& outVerts,
                                       std::vector<float>* outNormals) {
    if (!node || sources.empty()) return false;

    if (MNMesh* liveMN = TryGetLiveEditablePolyMesh(node)) {
        return ExtractMNMeshFastGeometry(*liveMN, sources, outVerts, outNormals);
    }

    ObjectState os = node->EvalWorldState(t);
    if (!os.obj || os.obj->SuperClassID() != GEOMOBJECT_CLASS_ID) return false;
    if (IsThreeJSSplatClassID(os.obj->ClassID())) return false;

    if (os.obj->IsSubClassOf(polyObjectClassID)) {
        MNMesh& mn = static_cast<PolyObject*>(os.obj)->GetMesh();
        return ExtractMNMeshFastGeometry(mn, sources, outVerts, outNormals);
    }

    if (!os.obj->CanConvertToType(Class_ID(TRIOBJ_CLASS_ID, 0))) return false;
    TriObject* tri = static_cast<TriObject*>(os.obj->ConvertToType(t, Class_ID(TRIOBJ_CLASS_ID, 0)));
    if (!tri) return false;

    bool ok = ExtractMeshFastGeometry(tri->GetMesh(), sources, outVerts, outNormals);
    if (tri != os.obj) tri->DeleteThis();
    return ok;
}
