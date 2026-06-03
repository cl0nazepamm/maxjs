const WEBGPU_INSTANCED_MESH_BATCH_SIZE = 32768;

export function isWebGpuInstancingPath({ renderer = null, backendLabel = '' } = {}) {
    const label = String(backendLabel || renderer?.userData?.maxjsBackendLabel || '');
    return label === 'WebGPU' ||
        label === 'TSL_GL' ||
        renderer?.backend?.isWebGPUBackend === true ||
        renderer?.isWebGPURenderer === true;
}

export function getInstancedMeshBatchSize({ renderer = null, backendLabel = '', count = 0 } = {}) {
    const numericCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (!isWebGpuInstancingPath({ renderer, backendLabel })) return numericCount || Infinity;
    return WEBGPU_INSTANCED_MESH_BATCH_SIZE;
}

export function instanceGroupKey(group, fallback = '') {
    const rawKey = group?.key ?? group?.src ?? fallback;
    const key = String(rawKey);
    if (key.includes(':')) return key;
    const kind = String(group?.kind ?? 'instance').trim().toLowerCase();
    return `${kind || 'instance'}:${key}`;
}
