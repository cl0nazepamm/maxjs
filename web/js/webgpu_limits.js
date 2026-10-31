// WebGPU devices come up at spec-MINIMUM limits unless asked otherwise — 16
// sampled textures per shader stage is one shadow-casting light away from
// overflowing a scene material's bind group once shadow maps and probe grid
// textures fold in (2026-07-24: "add one light and the floor vanishes" —
// BindGroupLayout creation failed, every mesh on that material stopped
// rendering). Mirror the adapter's real limits into the device request
// (WebGPURenderer `requiredLimits`) so the hardware ceiling, not the spec
// floor, is the budget. Probe with the SAME adapter options three's
// WebGPUBackend uses (featureLevel 'compatibility') so the mirrored values are
// valid for the adapter it will pick.
const MIRRORED_LIMITS = [
    'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D',
    'maxTextureArrayLayers', 'maxBindGroups', 'maxBindingsPerBindGroup',
    'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout',
    'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage',
    'maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage',
    'maxUniformBuffersPerShaderStage', 'maxUniformBufferBindingSize',
    'maxStorageBufferBindingSize', 'maxVertexBuffers', 'maxBufferSize',
    'maxVertexAttributes', 'maxVertexBufferArrayStride', 'maxInterStageShaderVariables',
    'maxColorAttachments', 'maxColorAttachmentBytesPerSample',
    'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
    'maxComputeWorkgroupsPerDimension',
];

export async function resolveWebGPULimits() {
    try {
        const adapter = await globalThis.navigator?.gpu?.requestAdapter?.({ featureLevel: 'compatibility' });
        if (!adapter?.limits) return undefined;
        const requiredLimits = {};
        for (const key of MIRRORED_LIMITS) {
            const value = adapter.limits[key];
            if (typeof value === 'number' && Number.isFinite(value)) requiredLimits[key] = value;
        }
        return Object.keys(requiredLimits).length ? requiredLimits : undefined;
    } catch (_) {
        return undefined;
    }
}
