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
                      float fov, bool perspective, float viewWidth = 0.0f);
    void EndFrame();

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
