#include "sync_protocol.h"

#include <cstring>

namespace maxjs::sync {

namespace {

constexpr std::uint16_t kCommandHeaderSize = 4;

}  // namespace

DeltaFrameBuilder::DeltaFrameBuilder(std::uint32_t frameId)
    : frameId_(frameId) {
    bytes_.reserve(512);

    AppendU32(kDeltaFrameMagic);
    AppendU16(kDeltaFrameVersion);
    AppendU16(0);
    AppendU32(frameId_);
    commandCountOffset_ = bytes_.size();
    AppendU32(0);
}

void DeltaFrameBuilder::BeginFrame() {
    BeginCommand(CommandType::BeginFrame, 4);
    AppendU32(frameId_);
}

void DeltaFrameBuilder::UpdateTransform(std::uint32_t nodeHandle, const float* matrix16) {
    BeginCommand(CommandType::UpdateTransform, 4 + 16 * sizeof(float));
    AppendU32(nodeHandle);
    for (int i = 0; i < 16; ++i) {
        AppendF32(matrix16[i]);
    }
}

void DeltaFrameBuilder::UpdateMaterialScalar(std::uint32_t nodeHandle, const float* color3,
                                             float roughness, float metalness, float opacity) {
    BeginCommand(CommandType::UpdateMaterialScalar, 4 + 3 * sizeof(float) + 3 * sizeof(float));
    AppendU32(nodeHandle);
    AppendF32(color3[0]);
    AppendF32(color3[1]);
    AppendF32(color3[2]);
    AppendF32(roughness);
    AppendF32(metalness);
    AppendF32(opacity);
}

void DeltaFrameBuilder::UpdateSelection(std::uint32_t nodeHandle, bool selected) {
    BeginCommand(CommandType::UpdateSelection, 8);
    AppendU32(nodeHandle);
    AppendU32(selected ? 1u : 0u);
}

void DeltaFrameBuilder::UpdateVisibility(std::uint32_t nodeHandle, bool visible) {
    BeginCommand(CommandType::UpdateVisibility, 8);
    AppendU32(nodeHandle);
    AppendU32(visible ? 1u : 0u);
}

void DeltaFrameBuilder::UpdateCamera(const float* position3, const float* target3, const float* up3,
                                     float fov, bool perspective, float viewWidth,
                                     bool dofEnabled, float dofFocusDistance,
                                     float dofFocalLength, float dofBokehScale) {
    BeginCommand(CommandType::UpdateCamera, 11 * sizeof(float) + 4 + 4 + 3 * sizeof(float));
    for (int i = 0; i < 3; ++i) {
        AppendF32(position3[i]);
    }
    for (int i = 0; i < 3; ++i) {
        AppendF32(target3[i]);
    }
    for (int i = 0; i < 3; ++i) {
        AppendF32(up3[i]);
    }
    AppendF32(fov);
    AppendU32(perspective ? 1u : 0u);
    AppendF32(viewWidth);
    AppendU32(dofEnabled ? 1u : 0u);
    AppendF32(dofFocusDistance);
    AppendF32(dofFocalLength);
    AppendF32(dofBokehScale);
}

void DeltaFrameBuilder::UpdateLight(std::uint32_t handle, const LightData& d) {
    // 4 handle + 64 matrix + 4 vis + 4 type + 12 color + 4 intensity
    // + 4 distance + 4 decay + 4 angle + 4 penumbra + 4 width + 4 height
    // + 12 groundColor + 4 castShadow + 4 shadowBias + 4 shadowRadius
    // + 4 shadowMapSize + 4 volContrib = 148 bytes
    BeginCommand(CommandType::UpdateLight, 148);
    AppendU32(handle);
    for (int i = 0; i < 16; ++i) AppendF32(d.matrix16[i]);
    AppendU32(d.visible ? 1u : 0u);
    AppendU32(d.type);
    AppendF32(d.color[0]); AppendF32(d.color[1]); AppendF32(d.color[2]);
    AppendF32(d.intensity);
    AppendF32(d.distance);
    AppendF32(d.decay);
    AppendF32(d.angle);
    AppendF32(d.penumbra);
    AppendF32(d.width);
    AppendF32(d.height);
    AppendF32(d.groundColor[0]); AppendF32(d.groundColor[1]); AppendF32(d.groundColor[2]);
    AppendU32(d.castShadow ? 1u : 0u);
    AppendF32(d.shadowBias);
    AppendF32(d.shadowRadius);
    AppendU32(d.shadowMapSize);
    AppendF32(d.volContrib);
}

void DeltaFrameBuilder::UpdateSplat(std::uint32_t handle, const float* matrix16, bool visible) {
    BeginCommand(CommandType::UpdateSplat, 4 + 16 * sizeof(float) + 4);
    AppendU32(handle);
    for (int i = 0; i < 16; ++i) {
        AppendF32(matrix16[i]);
    }
    AppendU32(visible ? 1u : 0u);
}

void DeltaFrameBuilder::UpdateAudio(std::uint32_t handle, const float* matrix16, bool visible) {
    BeginCommand(CommandType::UpdateAudio, 4 + 16 * sizeof(float) + 4);
    AppendU32(handle);
    for (int i = 0; i < 16; ++i) {
        AppendF32(matrix16[i]);
    }
    AppendU32(visible ? 1u : 0u);
}

void DeltaFrameBuilder::UpdateGLTF(std::uint32_t handle, const float* matrix16, bool visible) {
    BeginCommand(CommandType::UpdateGLTF, 4 + 16 * sizeof(float) + 4);
    AppendU32(handle);
    for (int i = 0; i < 16; ++i) {
        AppendF32(matrix16[i]);
    }
    AppendU32(visible ? 1u : 0u);
}

void DeltaFrameBuilder::UpdateTime(std::int32_t ticks, std::int32_t tpf, std::uint8_t stateFlags) {
    // 4 ticks + 4 tpf + 1 flags + 3 pad = 12 payload
    BeginCommand(CommandType::UpdateTime, 12);
    AppendU32(static_cast<std::uint32_t>(ticks));
    AppendU32(static_cast<std::uint32_t>(tpf));
    bytes_.push_back(stateFlags);
    bytes_.push_back(0);
    bytes_.push_back(0);
    bytes_.push_back(0);
}

void DeltaFrameBuilder::EndFrame() {
    BeginCommand(CommandType::EndFrame, 0);
}

void DeltaFrameBuilder::BeginCommand(CommandType type, std::uint16_t payloadBytes) {
    AppendU16(static_cast<std::uint16_t>(type));
    AppendU16(static_cast<std::uint16_t>(kCommandHeaderSize + payloadBytes));
    ++commandCount_;
    PatchU32(commandCountOffset_, commandCount_);
}

void DeltaFrameBuilder::AppendU16(std::uint16_t value) {
    const auto* src = reinterpret_cast<const std::uint8_t*>(&value);
    bytes_.insert(bytes_.end(), src, src + sizeof(value));
}

void DeltaFrameBuilder::AppendU32(std::uint32_t value) {
    const auto* src = reinterpret_cast<const std::uint8_t*>(&value);
    bytes_.insert(bytes_.end(), src, src + sizeof(value));
}

void DeltaFrameBuilder::AppendF32(float value) {
    const auto* src = reinterpret_cast<const std::uint8_t*>(&value);
    bytes_.insert(bytes_.end(), src, src + sizeof(value));
}

void DeltaFrameBuilder::PatchU32(std::size_t offset, std::uint32_t value) {
    if (offset + sizeof(value) > bytes_.size()) {
        return;
    }
    std::memcpy(bytes_.data() + offset, &value, sizeof(value));
}

}  // namespace maxjs::sync
