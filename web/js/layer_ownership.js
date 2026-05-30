// Layer resource ownership and disposal helpers.

const OWNER_KEY = 'maxjsOwner';
const OWNER_MAX = 'max';
const OWNER_JS = 'js';
const OWNER_OVERLAY = 'overlay';

const MATERIAL_MAP_KEYS = [
    'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap',
    'emissiveMap', 'aoMap', 'displacementMap', 'alphaMap', 'envMap',
    'lightMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
];

function setOwner(resource, owner) {
    if (!resource || typeof resource !== 'object') return resource;
    resource.userData ??= {};
    resource.userData[OWNER_KEY] = owner;
    return resource;
}

function getOwner(resource) {
    return resource?.userData?.[OWNER_KEY] ?? null;
}

function isDisposable(resource) {
    return !!resource && typeof resource.dispose === 'function';
}

function isOwnedByJs(resource) {
    const owner = getOwner(resource);
    return owner === OWNER_JS || owner === OWNER_OVERLAY;
}

function markMaterialOwned(material, owner) {
    if (!material) return material;
    setOwner(material, owner);
    for (const key of MATERIAL_MAP_KEYS) {
        if (material[key]) setOwner(material[key], owner);
    }
    return material;
}

function markOwned(resource, owner = OWNER_JS) {
    if (!resource) return resource;

    if (Array.isArray(resource)) {
        for (const item of resource) markOwned(item, owner);
        return resource;
    }

    if (resource.isObject3D) {
        resource.traverse(obj => {
            setOwner(obj, owner);
            if (obj.geometry) setOwner(obj.geometry, owner);
            if (Array.isArray(obj.material)) obj.material.forEach(mat => markMaterialOwned(mat, owner));
            else if (obj.material) markMaterialOwned(obj.material, owner);
        });
        return resource;
    }

    if (resource.isMaterial) return markMaterialOwned(resource, owner);
    if (resource.isBufferGeometry || resource.isTexture || resource.isRenderTarget) return setOwner(resource, owner);
    return setOwner(resource, owner);
}

function setSnapshotTargetId(resource, snapshotId) {
    if (!resource || typeof resource !== 'object') return resource;
    resource.userData ??= {};
    resource.userData.maxjsSnapshotId = snapshotId;
    return resource;
}

function disposeOwnedMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
        for (const item of material) disposeOwnedMaterial(item);
        return;
    }
    for (const key of MATERIAL_MAP_KEYS) {
        const map = material[key];
        if (isOwnedByJs(map) && isDisposable(map)) map.dispose();
    }
    if (isOwnedByJs(material) && isDisposable(material)) material.dispose();
}

function disposeOwnedResource(resource) {
    if (!resource) return;

    if (Array.isArray(resource)) {
        for (const item of resource) disposeOwnedResource(item);
        return;
    }

    if (resource.isObject3D) {
        while (resource.children.length > 0) {
            const child = resource.children[0];
            resource.remove(child);
            disposeOwnedResource(child);
        }
        if (isOwnedByJs(resource.geometry) && isDisposable(resource.geometry)) resource.geometry.dispose();
        disposeOwnedMaterial(resource.material);
        return;
    }

    if (resource.isMaterial) {
        disposeOwnedMaterial(resource);
        return;
    }

    if (isOwnedByJs(resource) && isDisposable(resource)) resource.dispose();
}

export {
    MATERIAL_MAP_KEYS,
    OWNER_MAX,
    OWNER_JS,
    OWNER_OVERLAY,
    setOwner,
    isOwnedByJs,
    getOwner,
    markOwned,
    setSnapshotTargetId,
    disposeOwnedMaterial,
    disposeOwnedResource,
};
