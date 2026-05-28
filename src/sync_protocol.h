#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace maxjs::sync {

constexpr std::uint32_t kDeltaFrameMagic = 0x424A584D;  // "MXJB" in little-endian bytes
constexpr std::uint16_t kDeltaFrameVersion = 1;

enum class CommandType : std::uint16_t {
    BeginFrame = 1,
    UpdateTransform = 2,
    UpdateMaterialScalar = 3,
    UpdateSelection = 4,
    UpdateVisibility = 5,
    UpdateCamera = 6,
    EndFrame = 7,
    UpdateLight = 8,
    UpdateSplat = 9,
    UpdateAudio = 10,
    UpdateTime = 11,
    UpdateGLTF = 12,
};

// ── Wire layout descriptors ──────────────────────────────────────
// Each delta command's payload is described once as a list of typed fields;
// the byte count is then computed at compile time. This is the single source
// of truth for payload sizes, so the encoder can't drift from the hand-tuned
// literals it used to carry (and the JS decoder, which must agree on the same
// totals + the 4-byte command header).
enum class Wire : std::uint8_t {
    U8,        // 1 byte
    PadU8,     // 1 byte, explicit padding
    U16,       // 2 bytes
    U32,       // 4 bytes
    F32,       // 4 bytes
    BoolU32,   // bool encoded as a 4-byte u32 (0/1)
    Vec3,      // 3 × f32 = 12 bytes
    Mat16,     // 16 × f32 = 64 bytes
};

constexpr std::size_t WireBytes(Wire w) {
    switch (w) {
        case Wire::U8:
        case Wire::PadU8:   return 1;
        case Wire::U16:     return 2;
        case Wire::U32:
        case Wire::F32:
        case Wire::BoolU32: return 4;
        case Wire::Vec3:    return 12;
        case Wire::Mat16:   return 64;
    }
    return 0;
}

template <Wire... Fields>
struct Layout {
    static constexpr std::size_t size = (WireBytes(Fields) + ... + std::size_t{0});
};

// One declaration per command payload (header is added separately by BeginCommand).
using BeginFrameLayout     = Layout<Wire::U32>;
using TransformLayout      = Layout<Wire::U32, Wire::Mat16>;
using MaterialScalarLayout = Layout<Wire::U32, Wire::Vec3, Wire::F32, Wire::F32, Wire::F32>;
using SelectionLayout      = Layout<Wire::U32, Wire::BoolU32>;
using VisibilityLayout     = Layout<Wire::U32, Wire::BoolU32>;
using CameraLayout         = Layout<Wire::Vec3, Wire::Vec3, Wire::Vec3, Wire::F32,
                                    Wire::BoolU32, Wire::F32, Wire::BoolU32, Wire::F32,
                                    Wire::F32, Wire::F32>;
using LightLayout          = Layout<Wire::U32, Wire::Mat16, Wire::BoolU32, Wire::U32,
                                    Wire::Vec3, Wire::F32, Wire::F32, Wire::F32, Wire::F32,
                                    Wire::F32, Wire::F32, Wire::F32, Wire::Vec3, Wire::BoolU32,
                                    Wire::F32, Wire::F32, Wire::U32, Wire::F32>;
using SplatLayout          = Layout<Wire::U32, Wire::Mat16, Wire::BoolU32>;
using AudioLayout          = SplatLayout;
using GLTFLayout           = SplatLayout;
using TimeLayout           = Layout<Wire::U32, Wire::U32, Wire::U8,
                                    Wire::PadU8, Wire::PadU8, Wire::PadU8>;
using EndFrameLayout       = Layout<>;

// Tripwires: if a struct/encoder edit changes a payload, these fail the build
// until the layout above (and the matching JS decoder in web/js/protocol.js,
// which expects size + 4 header bytes) are updated to agree.
static_assert(BeginFrameLayout::size == 4);
static_assert(TransformLayout::size == 68);
static_assert(MaterialScalarLayout::size == 28);
static_assert(SelectionLayout::size == 8);
static_assert(VisibilityLayout::size == 8);
static_assert(CameraLayout::size == 64);
static_assert(LightLayout::size == 148);
static_assert(SplatLayout::size == 72);
static_assert(TimeLayout::size == 12);
static_assert(EndFrameLayout::size == 0);

class DeltaFrameBuilder {
public:
    explicit DeltaFrameBuilder(std::uint32_t frameId);

    void BeginFrame();
    void UpdateTransform(std::uint32_t nodeHandle, const float* matrix16);
    void UpdateMaterialScalar(std::uint32_t nodeHandle, const float* color3,
                              float roughness, float metalness, float opacity);
    void UpdateSelection(std::uint32_t nodeHandle, bool selected);
    void UpdateVisibility(std::uint32_t nodeHandle, bool visible);
    void UpdateCamera(const float* position3, const float* target3, const float* up3,
                      float fov, bool perspective, float viewWidth = 0.0f,
                      bool dofEnabled = false, float dofFocusDistance = 0.0f,
                      float dofFocalLength = 0.0f, float dofBokehScale = 0.0f);
    struct LightData {
        const float* matrix16;
        bool visible;
        std::uint32_t type;
        float color[3];
        float intensity;
        float distance;
        float decay;
        float angle;
        float penumbra;
        float width;
        float height;
        float groundColor[3];
        bool castShadow;
        float shadowBias;
        float shadowRadius;
        std::uint32_t shadowMapSize;
        float volContrib;
    };
    void UpdateLight(std::uint32_t handle, const LightData& data);
    void UpdateSplat(std::uint32_t handle, const float* matrix16, bool visible);
    void UpdateAudio(std::uint32_t handle, const float* matrix16, bool visible);
    void UpdateGLTF(std::uint32_t handle, const float* matrix16, bool visible);
    // Max → JS time oracle. ticks is Max TimeValue (1/4800s). tpf is ticks per
    // frame (GetTicksPerFrame()). stateFlags: bit 0 = playing, bits 1-7 reserved.
    void UpdateTime(std::int32_t ticks, std::int32_t tpf, std::uint8_t stateFlags);
    void EndFrame();
    void ReserveBytes(std::size_t totalBytes);

    std::uint32_t frame_id() const { return frameId_; }
    std::uint32_t command_count() const { return commandCount_; }
    const std::vector<std::uint8_t>& bytes() const { return bytes_; }
    std::size_t size() const { return bytes_.size(); }

private:
    void BeginCommand(CommandType type, std::size_t payloadBytes);
    void AppendU16(std::uint16_t value);
    void AppendU32(std::uint32_t value);
    void AppendF32(float value);
    void PatchU32(std::size_t offset, std::uint32_t value);

    std::uint32_t frameId_ = 0;
    std::uint32_t commandCount_ = 0;
    std::size_t commandCountOffset_ = 0;
    std::vector<std::uint8_t> bytes_;

    // Debug-only guard: tracks where the open command's payload must end so
    // BeginCommand can assert the previous command appended exactly its
    // declared byte count. Compiled out in release (see BeginCommand).
    std::size_t expectedCommandEnd_ = 0;
    bool hasOpenCommand_ = false;
};

}  // namespace maxjs::sync
