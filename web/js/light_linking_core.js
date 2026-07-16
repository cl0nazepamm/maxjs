// light_linking_core.js - renderer-agnostic light-link state and mask compiler.
//
// The activation rule is intentionally small: a valid include/exclude mode means
// the light is linked, even when its target set is empty. Only removing the mode
// returns the light to the stock Three.js path.

export const MAXJS_FAST_LINKED_LIGHTS = 64;
export const LIGHT_MASK_LO_KEY = 'maxjsLightMaskLo';
export const LIGHT_MASK_HI_KEY = 'maxjsLightMaskHi';
export const LIGHT_MASK_READY_KEY = 'maxjsLightMaskReady';
export const LIGHT_MASK_GENERATION_KEY = LIGHT_MASK_READY_KEY;
export const LIGHT_OVERFLOW_KEY_PREFIX = 'maxjsLightMaskExtra';
export const LIGHT_LINK_REFRESH_NODE_KEY = 'maxjsLightLinkRefreshNode';

export function handleToken(handle) {
    return handle == null ? '' : String(handle);
}

export function resolveHandle(map, handle) {
    if (!map || handle == null) return null;
    if (map.has(handle)) return handle;
    const token = handleToken(handle);
    if (map.has(token)) return token;
    if (/^-?\d+$/.test(token)) {
        const numeric = Number(token);
        if (Number.isSafeInteger(numeric) && map.has(numeric)) return numeric;
    }
    return null;
}

export function getByHandle(map, handle) {
    const resolved = resolveHandle(map, handle);
    return resolved == null ? undefined : map.get(resolved);
}

export function normalizeLightLinkMode(mode) {
    return mode === 'include' || mode === 'exclude' ? mode : null;
}

export function ensureMeshMaskDefaults(mesh, lo = 0xFFFFFFFF, hi = 0xFFFFFFFF) {
    if (!mesh) return;
    mesh.userData ??= {};
    if (typeof mesh.userData[LIGHT_MASK_LO_KEY] !== 'number') {
        mesh.userData[LIGHT_MASK_LO_KEY] = lo >>> 0;
    }
    if (typeof mesh.userData[LIGHT_MASK_HI_KEY] !== 'number') {
        mesh.userData[LIGHT_MASK_HI_KEY] = hi >>> 0;
    }
}

function findHandleByName(map, name) {
    if (!map || !name) return null;
    for (const [handle, object] of map) {
        if (object?.name === name) return handle;
    }
    return null;
}

function addResolvedObjectHandle(target, nodeMap, rawHandle, fallbackName = '') {
    const authoredHandle = handleToken(rawHandle);
    if (authoredHandle) {
        const resolved = resolveHandle(nodeMap, rawHandle);
        target.add(handleToken(resolved ?? authoredHandle));
        return;
    }
    // Name fallback is legacy-only. A v2 handle may refer to a runtimeScene or
    // project mesh that arrives later and must never bind to a same-name object.
    const resolvedByName = fallbackName ? findHandleByName(nodeMap, fallbackName) : null;
    if (resolvedByName != null) target.add(handleToken(resolvedByName));
}

// v2 is handle-first and preserves duplicate names. The legacy `links` object
// remains alongside it so older viewer builds can still replay new snapshots.
export function serializeLightLinks(links, { lightHandleMap, nodeMap } = {}) {
    const legacyLinks = {};
    const linkEntries = [];

    for (const [rawLightHandle, rawLink] of links ?? []) {
        const mode = normalizeLightLinkMode(rawLink?.mode);
        if (!mode) continue;

        const resolvedLightHandle = resolveHandle(lightHandleMap, rawLightHandle);
        const lightHandle = handleToken(resolvedLightHandle ?? rawLightHandle);
        const light = resolvedLightHandle == null ? null : lightHandleMap.get(resolvedLightHandle);
        const lightName = String(light?.name ?? '').trim();
        const objectHandles = [];
        const objectNames = [];

        for (const rawObjectHandle of rawLink?.objects ?? []) {
            const resolvedObjectHandle = resolveHandle(nodeMap, rawObjectHandle);
            const objectHandle = handleToken(resolvedObjectHandle ?? rawObjectHandle);
            if (!objectHandle) continue;
            const object = resolvedObjectHandle == null ? null : nodeMap.get(resolvedObjectHandle);
            const objectName = String(object?.name ?? '').trim();
            // Keep the arrays positional. Empty names are intentional so a stale
            // handle cannot borrow the following object's fallback name on load.
            objectHandles.push(objectHandle);
            objectNames.push(objectName);
        }

        linkEntries.push({
            lightHandle,
            lightName,
            mode,
            objectHandles,
            objectNames,
        });

        if (lightName) legacyLinks[lightName] = { mode, objects: objectNames };
    }

    return { links: legacyLinks, linkEntries };
}

export function deserializeLightLinks(data, { lightHandleMap, nodeMap } = {}) {
    const result = new Map();
    if (!data || typeof data !== 'object') return result;

    const add = (entry, fallbackLightName = '') => {
        const mode = normalizeLightLinkMode(entry?.mode);
        if (!mode) return;

        const rawLightHandle = entry?.lightHandle ?? entry?.handle ?? entry?.h;
        const authoredLightHandle = handleToken(rawLightHandle);
        let resolvedLightHandle = resolveHandle(lightHandleMap, rawLightHandle);
        const lightName = String(entry?.lightName ?? entry?.name ?? fallbackLightName ?? '').trim();
        if (resolvedLightHandle == null && !authoredLightHandle && lightName) {
            resolvedLightHandle = findHandleByName(lightHandleMap, lightName);
        }
        const resultLightHandle = handleToken(resolvedLightHandle ?? authoredLightHandle);
        if (!resultLightHandle) return;

        const objects = new Set();
        const objectHandles = Array.isArray(entry?.objectHandles) ? entry.objectHandles : [];
        const objectNames = Array.isArray(entry?.objectNames)
            ? entry.objectNames
            : (Array.isArray(entry?.objects) ? entry.objects : []);
        const count = Math.max(objectHandles.length, objectNames.length);
        for (let i = 0; i < count; i++) {
            addResolvedObjectHandle(objects, nodeMap, objectHandles[i], objectNames[i]);
        }

        result.set(resultLightHandle, { mode, objects });
    };

    if (Array.isArray(data.linkEntries)) {
        for (const entry of data.linkEntries) add(entry);
        return result;
    }

    // v1: { links: { LightName: { mode, objects:[ObjectName] } } }
    // Very old payloads were the flat name map itself.
    const rawLinks = data.links || (data.env === undefined ? data : {});
    for (const [lightName, entry] of Object.entries(rawLinks ?? {})) {
        add(entry, lightName);
    }
    return result;
}

export function hasActiveLightLinksPayload(data) {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.linkEntries)) {
        return data.linkEntries.some((entry) => normalizeLightLinkMode(entry?.mode) !== null);
    }
    const rawLinks = data.links || (data.env === undefined ? data : {});
    return Object.values(rawLinks ?? {}).some((entry) => normalizeLightLinkMode(entry?.mode) !== null);
}

function writeFastBit(mesh, lightId, enabled) {
    const key = lightId < 32 ? LIGHT_MASK_LO_KEY : LIGHT_MASK_HI_KEY;
    const bit = (1 << (lightId & 31)) >>> 0;
    const current = mesh.userData[key] >>> 0;
    mesh.userData[key] = enabled
        ? ((current | bit) >>> 0)
        : ((current & ~bit) >>> 0);
}

// Compiles every active link into one per-mesh pass. The first 64 active links
// keep the batched two-word shader path. Additional active links remain linked
// through explicit per-light userData keys; MaxLightsNode routes only those
// overflow lights through stock per-light nodes plus a mask multiply.
export function createLightLinkMaskApplier({
    lightHandleMap,
    forEachRenderableMesh,
    onPrepareMesh = null,
    onOverflow = null,
} = {}) {
    if (!lightHandleMap) throw new Error('createLightLinkMaskApplier: lightHandleMap required');
    if (typeof forEachRenderableMesh !== 'function') {
        throw new Error('createLightLinkMaskApplier: forEachRenderableMesh required');
    }

    const fastIdByKey = new Map();
    const fastSlots = new Uint8Array(MAXJS_FAST_LINKED_LIGHTS);
    const overflowKeyByLight = new Map();
    const freeOverflowKeys = [];
    const retiredOverflowKeys = new Set();
    let nextOverflowKey = 0;
    let generation = 0;

    function allocateFastId(stableKey) {
        const preferred = fastIdByKey.get(stableKey);
        if (
            Number.isInteger(preferred)
            && preferred >= 0
            && preferred < MAXJS_FAST_LINKED_LIGHTS
            && fastSlots[preferred] === 0
        ) {
            fastSlots[preferred] = 1;
            return preferred;
        }
        for (let id = 0; id < MAXJS_FAST_LINKED_LIGHTS; id++) {
            if (fastSlots[id] !== 0) continue;
            fastSlots[id] = 1;
            fastIdByKey.set(stableKey, id);
            return id;
        }
        return -1;
    }

    function allocateOverflowKey(stableKey) {
        let key = overflowKeyByLight.get(stableKey);
        if (!key) {
            key = freeOverflowKeys.pop() ?? `${LIGHT_OVERFLOW_KEY_PREFIX}${nextOverflowKey++}`;
            overflowKeyByLight.set(stableKey, key);
        }
        return key;
    }

    function resetLightState() {
        for (const [, light] of lightHandleMap) {
            if (!light) continue;
            light.userData ??= {};
            light.userData.maxjsLightLinked = false;
            light.userData.maxjsLightId = -1;
            light.userData.maxjsLightMaskKey = null;
            light.userData.maxjsLightMaskDefault = 1;
        }
    }

    function apply(links) {
        generation = (generation + 1) >>> 0;
        if (generation === 0) generation = 1;
        fastSlots.fill(0);
        resetLightState();

        const active = [];
        const overflow = [];
        const activeOverflowStableKeys = new Set();
        let defaultLo = 0xFFFFFFFF;
        let defaultHi = 0xFFFFFFFF;

        for (const [rawLightHandle, rawLink] of links ?? []) {
            const mode = normalizeLightLinkMode(rawLink?.mode);
            if (!mode) continue;
            const resolvedLightHandle = resolveHandle(lightHandleMap, rawLightHandle);
            if (resolvedLightHandle == null) continue;
            const light = lightHandleMap.get(resolvedLightHandle);
            if (!light) continue;

            const stableKey = `h:${handleToken(resolvedLightHandle)}`;
            const id = allocateFastId(stableKey);
            const entry = {
                light,
                lightHandle: handleToken(resolvedLightHandle),
                mode,
                objects: rawLink?.objects instanceof Set
                    ? rawLink.objects
                    : new Set(rawLink?.objects ?? []),
                id,
                overflowKey: null,
            };

            light.userData ??= {};
            light.userData.maxjsLightLinked = true;
            light.userData.maxjsLightId = id;

            if (id >= 0) {
                if (mode === 'include') {
                    const bit = (1 << (id & 31)) >>> 0;
                    if (id < 32) defaultLo = (defaultLo & ~bit) >>> 0;
                    else defaultHi = (defaultHi & ~bit) >>> 0;
                }
            } else {
                entry.overflowKey = allocateOverflowKey(stableKey);
                activeOverflowStableKeys.add(stableKey);
                light.userData.maxjsLightMaskKey = entry.overflowKey;
                light.userData.maxjsLightMaskDefault = mode === 'include' ? 0 : 1;
                overflow.push(entry);
            }
            active.push(entry);
        }

        for (const [stableKey, key] of overflowKeyByLight) {
            if (activeOverflowStableKeys.has(stableKey)) continue;
            overflowKeyByLight.delete(stableKey);
            freeOverflowKeys.push(key);
            retiredOverflowKeys.add(key);
        }

        if (overflow.length > 0) onOverflow?.(overflow.length, active.length);
        if (active.length === 0) {
            return { activeCount: 0, fastCount: 0, overflowCount: 0, defaultLo, defaultHi, generation };
        }

        const meshesByHandle = new Map();
        const seenMeshes = new WeakSet();
        forEachRenderableMesh((rawHandle, mesh) => {
            if (!mesh?.isMesh || seenMeshes.has(mesh)) return;
            seenMeshes.add(mesh);
            onPrepareMesh?.(mesh);
            mesh.userData ??= {};
            mesh.userData[LIGHT_MASK_READY_KEY] = generation;
            mesh.userData[LIGHT_MASK_LO_KEY] = defaultLo >>> 0;
            mesh.userData[LIGHT_MASK_HI_KEY] = defaultHi >>> 0;
            for (const retiredKey of retiredOverflowKeys) delete mesh.userData[retiredKey];
            for (const entry of overflow) {
                mesh.userData[entry.overflowKey] = entry.mode === 'include' ? 0 : 1;
            }
            const token = handleToken(rawHandle);
            if (!token) return;
            const list = meshesByHandle.get(token);
            if (list) list.push(mesh);
            else meshesByHandle.set(token, [mesh]);
        });
        retiredOverflowKeys.clear();

        for (const entry of active) {
            const selectedValue = entry.mode === 'include';
            for (const rawObjectHandle of entry.objects) {
                const meshes = meshesByHandle.get(handleToken(rawObjectHandle));
                if (!meshes) continue;
                for (const mesh of meshes) {
                    if (entry.id >= 0) writeFastBit(mesh, entry.id, selectedValue);
                    else mesh.userData[entry.overflowKey] = selectedValue ? 1 : 0;
                }
            }
        }

        return {
            activeCount: active.length,
            fastCount: active.length - overflow.length,
            overflowCount: overflow.length,
            defaultLo: defaultLo >>> 0,
            defaultHi: defaultHi >>> 0,
            generation,
        };
    }

    return { apply, resetLightState };
}
