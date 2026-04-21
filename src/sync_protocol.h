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
    void BeginCommand(CommandType type, std::uint16_t payloadBytes);
    void AppendU16(std::uint16_t value);
    void AppendU32(std::uint32_t value);
    void AppendF32(float value);
    void PatchU32(std::size_t offset, std::uint32_t value);

    std::uint32_t frameId_ = 0;
    std::uint32_t commandCount_ = 0;
    std::size_t commandCountOffset_ = 0;
    std::vector<std::uint8_t> bytes_;
};

}  // namespace maxjs::sync
