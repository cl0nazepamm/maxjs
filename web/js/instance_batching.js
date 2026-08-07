const WEBGPU_INSTANCED_MESH_BATCH_SIZE = 32768;

// Node/source-backed materials are already built by the normal material
// pipeline for InstancedMesh.  Keep their full descriptor on WebGPU/TSL_GL;
// the lossy Standard-material safety copy is only for legacy Forest/RC
// descriptors whose arbitrary texture fan-out needs bounding.
const EXACT_INSTANCE_MATERIAL_MODELS = new Set([
    'MaterialXMaterial',
    'MeshBackdropNodeMaterial',
    'MeshSSSNodeMaterial',
    'MeshTSLNodeMaterial',
]);

export function isExactInstanceMaterialDescriptor(material) {
    if (!material || typeof material !== 'object') return false;
    if (EXACT_INSTANCE_MATERIAL_MODELS.has(String(material.model || ''))) return true;
    if (material.tslCode || material.materialXInline || material.materialXFile) return true;
    return Object.entries(material).some(([key, value]) =>
        typeof value === 'string' && value.length > 0 && /(?:TSL|HTML)$/.test(key));
}

export function instanceGroupHasExactMaterialDescriptor(group) {
    if (isExactInstanceMaterialDescriptor(group?.mat)) return true;
    return Array.isArray(group?.mats) && group.mats.some(isExactInstanceMaterialDescriptor);
}

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
