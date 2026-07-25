// Layer resource ownership and disposal helpers.

const OWNER_KEY = 'maxjsOwner';
const OWNER_MAX = 'max';
const OWNER_JS = 'js';
const OWNER_OVERLAY = 'overlay';

const MATERIAL_MAP_KEYS = [
    'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap',
    'emissiveMap', 'aoMap', 'displacementMap', 'alphaMap', 'envMap',
    'lightMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
    'sheenColorMap', 'sheenRoughnessMap',
];

function setOwner(resource, owner) {
    if (!resource || typeof resource !== 'object') return resource;
    resource.userData ??= {};
    const currentOwner = resource.userData[OWNER_KEY];
    if (
        owner === OWNER_MAX
        && currentOwner != null
        && currentOwner !== OWNER_MAX
        && resource.userData.maxjsHandle == null
    ) {
        return resource;
    }
    if (
        owner !== OWNER_MAX
        && (
            currentOwner === OWNER_MAX
            || resource.userData.maxjsHandle != null
        )
    ) {
        return resource;
    }
    resource.userData[OWNER_KEY] = owner;
    return resource;
}

function getOwner(resource) {
    return resource?.userData?.[OWNER_KEY] ?? null;
}

function isOwnedByMax(resource) {
    return getOwner(resource) === OWNER_MAX || resource?.userData?.maxjsHandle != null;
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
    if (owner !== OWNER_MAX && isOwnedByMax(material)) return material;
    setOwner(material, owner);
    if (getOwner(material) !== owner) return material;
    for (const key of MATERIAL_MAP_KEYS) {
        const map = material[key];
        if (!map || (owner !== OWNER_MAX && isOwnedByMax(map))) continue;
        setOwner(map, owner);
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
            if (owner !== OWNER_MAX && isOwnedByMax(obj)) return;
            setOwner(obj, owner);
            if (obj.geometry && (owner === OWNER_MAX || !isOwnedByMax(obj.geometry))) {
                setOwner(obj.geometry, owner);
            }
            if (Array.isArray(obj.material)) obj.material.forEach(mat => markMaterialOwned(mat, owner));
            else if (obj.material) markMaterialOwned(obj.material, owner);
        });
        return resource;
    }

    if (resource.isMaterial) return markMaterialOwned(resource, owner);
    if (owner !== OWNER_MAX && isOwnedByMax(resource)) return resource;
    if (resource.isBufferGeometry || resource.isTexture || resource.isRenderTarget) return setOwner(resource, owner);
    return setOwner(resource, owner);
}

// Idempotent Max stamp for the fastsync settle path. markOwned() walks the
// whole subtree and re-tests 14 material map slots per object every call —
// on a full sync that is pure redundant work once a node is already stamped.
// CONTRACT: anything that gives an already-stamped node a new geometry,
// material, or CHILD must stamp that resource at the site it introduces it —
// the sync lanes do (geometry/material swaps, flatten clusters, instance
// buckets, line<->mesh rebuilds). This only short-circuits re-walking a tree
// that is already Max-owned; it cannot discover resources added since.
function ensureMaxOwned(resource) {
    if (!resource || typeof resource !== 'object') return resource;
    if (getOwner(resource) === OWNER_MAX) return resource;
    return markOwned(resource, OWNER_MAX);
}

function clearOwner(resource) {
    if (!resource || typeof resource !== 'object') return resource;
    if (resource.userData) {
        resource.userData = { ...resource.userData };
        delete resource.userData[OWNER_KEY];
    }
    return resource;
}

function setSnapshotTargetId(resource, snapshotId) {
    if (!resource || typeof resource !== 'object') return resource;
    resource.userData ??= {};
    resource.userData.maxjsSnapshotId = snapshotId;
    return resource;
}

function disposeOwnedMaterial(material, options = {}) {
    if (!material) return;
    const seen = options.seen ?? new Set();
    const force = options.force === true;
    if (Array.isArray(material)) {
        for (const item of material) disposeOwnedMaterial(item, { seen, force });
        return;
    }
    if (seen.has(material) || isOwnedByMax(material)) return;
    seen.add(material);
    for (const key of MATERIAL_MAP_KEYS) {
        const map = material[key];
        if (!map || seen.has(map) || isOwnedByMax(map)) continue;
        if (force || isOwnedByJs(map)) {
            seen.add(map);
            if (isDisposable(map)) map.dispose();
        }
    }
    if ((force || isOwnedByJs(material)) && isDisposable(material)) material.dispose();
}

function disposeOwnedResource(resource, options = {}) {
    if (!resource) return;

    const seen = options.seen ?? new Set();
    const force = options.force === true;
    if (Array.isArray(resource)) {
        for (const item of resource) disposeOwnedResource(item, { seen, force });
        return;
    }

    if (resource.isMaterial) {
        disposeOwnedMaterial(resource, { seen, force });
        return;
    }

    if (seen.has(resource) || isOwnedByMax(resource)) return;
    seen.add(resource);

    if (resource.isObject3D) {
        while (resource.children.length > 0) {
            const child = resource.children[0];
            resource.remove(child);
            disposeOwnedResource(child, { seen, force });
        }
        disposeOwnedResource(resource.geometry, { seen, force });
        disposeOwnedMaterial(resource.material, { seen, force });
        return;
    }

    if ((force || isOwnedByJs(resource)) && isDisposable(resource)) resource.dispose();
}

export {
    MATERIAL_MAP_KEYS,
    OWNER_MAX,
    OWNER_JS,
    OWNER_OVERLAY,
    setOwner,
    clearOwner,
    isOwnedByJs,
    isOwnedByMax,
    getOwner,
    markOwned,
    ensureMaxOwned,
    setSnapshotTargetId,
    disposeOwnedMaterial,
    disposeOwnedResource,
};
