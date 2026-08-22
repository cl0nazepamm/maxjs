// Runtime-layer spectral material tags. Tags live on the real synced Three
// materials, survive fast-sync replacement, and are restored on layer teardown.

import { freezePlainObject } from './layer_utils.js';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const RASTER_NIR_NODE_BINDINGS = Object.freeze([
    ['colorNode', 'maxjsNirColorNode'],
    ['emissiveNode', 'maxjsNirEmissiveNode'],
]);

function materialsOf(mesh) {
    return Array.isArray(mesh?.material) ? mesh.material : (mesh?.material ? [mesh.material] : []);
}

function normalizeNodeSpec(value) {
    if (value == null) return null;
    if (Array.isArray(value)) {
        const parts = value.map(normalizeNodeSpec).filter(Boolean);
        return parts.length ? { kind: 'multi', parts } : null;
    }
    if (typeof value === 'function') return { kind: 'predicate', test: value };
    if (value instanceof RegExp) return { kind: 'regexp', regexp: value };
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return { kind: 'handle', handle: value };
    }
    const objectHandle = Number(value?.handle);
    if (Number.isFinite(objectHandle) && objectHandle > 0) {
        return { kind: 'handle', handle: objectHandle };
    }
    if (typeof value === 'string' && value) {
        return value.endsWith('*')
            ? { kind: 'prefix', value: value.slice(0, -1).toLowerCase() }
            : { kind: 'name', value: value.toLowerCase() };
    }
    return null;
}

function normalizeMaterialSpec(value) {
    if (value == null) return null;
    if (Array.isArray(value)) {
        const parts = value.map(normalizeMaterialSpec).filter(Boolean);
        return parts.length ? { kind: 'multi', parts } : null;
    }
    if (typeof value === 'function') return { kind: 'predicate', test: value };
    if (value instanceof RegExp) return { kind: 'regexp', regexp: value };
    if (typeof value === 'string' && value) {
        return value.endsWith('*')
            ? { kind: 'prefix', value: value.slice(0, -1).toLowerCase() }
            : { kind: 'name', value: value.toLowerCase() };
    }
    return null;
}

function prefixPattern(value) {
    if (Array.isArray(value)) return value.map(prefixPattern);
    return typeof value === 'string' ? `${value}*` : value;
}

function normalizeSelector(selector) {
    const isObjectSelector = selector && typeof selector === 'object'
        && !Array.isArray(selector)
        && !(selector instanceof RegExp)
        && selector.handle == null
        && ['under', 'objects', 'object', 'objectName', 'objectPrefix',
            'materials', 'material', 'materialName', 'materialPrefix', 'includeSelf']
            .some(key => hasOwn(selector, key));

    if (!isObjectSelector) {
        const objects = normalizeNodeSpec(selector);
        if (!objects) throw new TypeError('ctx.spectral.setNirAlbedo: unsupported target');
        return { objects, under: null, materials: null, includeSelf: true };
    }

    const objectSource = selector.objects ?? selector.object
        ?? selector.objectName ?? prefixPattern(selector.objectPrefix);
    const materialSource = selector.materials ?? selector.material
        ?? selector.materialName ?? prefixPattern(selector.materialPrefix);
    const objects = normalizeNodeSpec(objectSource);
    const under = normalizeNodeSpec(selector.under);
    const materials = normalizeMaterialSpec(materialSource);
    if (!objects && !under && !materials) {
        throw new TypeError('ctx.spectral.setNirAlbedo: selector must include under, objects, or materials');
    }
    return { objects, under, materials, includeSelf: selector.includeSelf === true };
}

function testRegExp(regexp, value) {
    regexp.lastIndex = 0;
    return regexp.test(value);
}

export function createSpectralMaterialSystem({
    nodeMap,
    setMaterialDecorator,
    clearMaterialDecorator,
    onChange = null,
    debugWarn = () => {},
}) {
    const entries = new Map();
    const materialStates = new WeakMap();
    let nextEntryId = 1;
    let nextOrder = 1;
    let nextScanAt = 0;
    // Raster NV band swap: while the imager senses NIR, a TAGGED material's
    // diffuse scalar becomes grey at its authored NIR level. TSL materials may
    // additionally provide per-pixel `userData.maxjsNirColorNode` and
    // `maxjsNirEmissiveNode`; those replace the visible nodes only for the NIR
    // pass. The scalar tag remains the spectral tracer fallback because the PT
    // cannot execute arbitrary raster material graphs. The true visible color
    // is parked in userData.giColor, which the spectral/probe packer honors
    // FIRST, so PT and probe-bounce albedo stay band-correct throughout.
    let rasterSensing = false;

    function applyRasterSwap(material, state, value) {
        const hasScalarColor = material?.color?.isColor === true;
        const hasNodeOverride = RASTER_NIR_NODE_BINDINGS.some(([, userDataKey]) =>
            material?.userData?.[userDataKey] != null);
        if (!hasScalarColor && !hasNodeOverride) return;
        if (!state.rasterSaved) {
            state.rasterSaved = true;
            state.savedColor = hasScalarColor ? material.color.clone() : null;
            state.hadGiColor = hasOwn(material.userData ?? {}, 'giColor');
            state.savedGiColor = material.userData?.giColor;
            material.userData ??= {};
            if (state.savedColor) material.userData.giColor = state.savedColor;
        }

        state.savedRasterNodes ??= {};
        let nodeChanged = false;
        let hasNirColorNode = false;
        for (const [materialKey, userDataKey] of RASTER_NIR_NODE_BINDINGS) {
            const nirNode = material.userData?.[userDataKey];
            if (nirNode == null) continue;
            if (materialKey === 'colorNode') hasNirColorNode = true;
            if (!hasOwn(state.savedRasterNodes, materialKey)) {
                state.savedRasterNodes[materialKey] = material[materialKey];
            }
            if (material[materialKey] === nirNode) continue;
            material[materialKey] = nirNode;
            nodeChanged = true;
        }
        if (nodeChanged) material.needsUpdate = true;
        if (!hasNirColorNode && hasScalarColor) {
            material.color.setScalar(Math.min(1, Math.max(0, value)));
        }
    }

    function clearRasterSwap(material, state) {
        if (!state?.rasterSaved) return;
        state.rasterSaved = false;
        let nodeChanged = false;
        for (const [materialKey] of RASTER_NIR_NODE_BINDINGS) {
            if (!hasOwn(state.savedRasterNodes ?? {}, materialKey)) continue;
            if (material?.[materialKey] !== state.savedRasterNodes[materialKey]) {
                material[materialKey] = state.savedRasterNodes[materialKey];
                nodeChanged = true;
            }
        }
        if (nodeChanged && material) material.needsUpdate = true;
        if (material?.color?.isColor && state.savedColor) material.color.copy(state.savedColor);
        if (material?.userData) {
            if (state.hadGiColor) material.userData.giColor = state.savedGiColor;
            else delete material.userData.giColor;
        }
        state.savedColor = null;
        state.savedRasterNodes = null;
        state.savedGiColor = undefined;
    }

    function nodeSpecMatches(spec, handle, object, getAdapter) {
        if (!spec) return true;
        switch (spec.kind) {
            case 'multi': return spec.parts.some(part => nodeSpecMatches(part, handle, object, getAdapter));
            case 'handle': return spec.handle === handle;
            case 'name': return String(object?.name ?? '').toLowerCase() === spec.value;
            case 'prefix': return String(object?.name ?? '').toLowerCase().startsWith(spec.value);
            case 'regexp': return testRegExp(spec.regexp, String(object?.name ?? ''));
            case 'predicate': {
                try { return spec.test(getAdapter?.(handle)) === true; }
                catch (error) { debugWarn('[ctx.spectral] object predicate failed', error); return false; }
            }
            default: return false;
        }
    }

    function materialSpecMatches(spec, material, adapter) {
        if (!spec) return true;
        const names = [material?.name, material?.userData?.maxjsSourceMaterialName]
            .filter((name, index, all) => typeof name === 'string' && name && all.indexOf(name) === index);
        switch (spec.kind) {
            case 'multi': return spec.parts.some(part => materialSpecMatches(part, material, adapter));
            case 'name': return names.some(name => name.toLowerCase() === spec.value);
            case 'prefix': return names.some(name => name.toLowerCase().startsWith(spec.value));
            case 'regexp': return names.some(name => testRegExp(spec.regexp, name));
            case 'predicate': {
                try { return spec.test(material, adapter) === true; }
                catch (error) { debugWarn('[ctx.spectral] material predicate failed', error); return false; }
            }
            default: return false;
        }
    }

    function rootHandles(entry) {
        if (!entry.selector.under) return null;
        const roots = new Set();
        for (const [handle, object] of nodeMap) {
            if (nodeSpecMatches(entry.selector.under, handle, object, entry.getAdapter)) roots.add(handle);
        }
        return roots;
    }

    function isUnder(handle, object, roots, includeSelf) {
        if (!roots) return true;
        if (includeSelf && roots.has(handle)) return true;
        let parent = Number(object?.userData?.maxjsParentHandle);
        const seen = new Set();
        while (Number.isFinite(parent) && parent > 0 && !seen.has(parent)) {
            if (roots.has(parent)) return true;
            seen.add(parent);
            parent = Number(nodeMap.get(parent)?.userData?.maxjsParentHandle);
        }
        return false;
    }

    function matchingMaterials(entry, handle, mesh) {
        const adapter = entry.getAdapter?.(handle);
        return new Set(materialsOf(mesh).filter(material =>
            material && materialSpecMatches(entry.selector.materials, material, adapter)));
    }

    function applyMaterialState(material, state) {
        let winner = null;
        for (const assignment of state.assignments.values()) {
            if (!winner || assignment.order > winner.order) winner = assignment;
        }
        material.userData ??= {};
        if (winner) {
            if (rasterSensing) applyRasterSwap(material, state, winner.value);
            if (material.userData.nirAlbedo === winner.value) return false;
            material.userData.nirAlbedo = winner.value;
            return true;
        }
        clearRasterSwap(material, state);
        let changed = false;
        if (state.hadOwn) {
            changed = material.userData.nirAlbedo !== state.baseline;
            material.userData.nirAlbedo = state.baseline;
        } else if (hasOwn(material.userData, 'nirAlbedo')) {
            delete material.userData.nirAlbedo;
            changed = true;
        }
        materialStates.delete(material);
        return changed;
    }

    function addMaterialAssignment(entry, material) {
        let state = materialStates.get(material);
        if (!state) {
            const userData = material.userData ?? {};
            state = {
                hadOwn: hasOwn(userData, 'nirAlbedo'),
                baseline: userData.nirAlbedo,
                assignments: new Map(),
            };
            materialStates.set(material, state);
        }
        state.assignments.set(entry.id, { order: entry.order, value: entry.value });
        return applyMaterialState(material, state);
    }

    function removeMaterialAssignment(entry, material) {
        const state = materialStates.get(material);
        if (!state?.assignments.delete(entry.id)) return false;
        return applyMaterialState(material, state);
    }

    function syncHandleMaterials(entry, handle, mesh, nextMaterials = null) {
        const previous = entry.handleMaterials.get(handle) ?? new Set();
        const next = nextMaterials ?? matchingMaterials(entry, handle, mesh);
        let changed = false;
        for (const material of previous) {
            if (next.has(material)) continue;
            const count = (entry.materialCounts.get(material) ?? 1) - 1;
            if (count <= 0) {
                entry.materialCounts.delete(material);
                changed = removeMaterialAssignment(entry, material) || changed;
            } else {
                entry.materialCounts.set(material, count);
            }
        }
        for (const material of next) {
            if (previous.has(material)) continue;
            const count = entry.materialCounts.get(material) ?? 0;
            entry.materialCounts.set(material, count + 1);
            if (count === 0) changed = addMaterialAssignment(entry, material) || changed;
        }
        if (next.size) entry.handleMaterials.set(handle, next);
        else entry.handleMaterials.delete(handle);
        return changed;
    }

    const decoratorKey = entry => `spectral:nir:${entry.id}`;

    function addHandle(entry, handle, mesh) {
        entry.matched.add(handle);
        setMaterialDecorator(entry.layerId, handle, decoratorKey(entry), nextMesh => {
            entry.pendingChange = syncHandleMaterials(entry, handle, nextMesh) || entry.pendingChange;
        });
        entry.pendingChange = syncHandleMaterials(entry, handle, mesh) || entry.pendingChange;
    }

    function removeHandle(entry, handle) {
        clearMaterialDecorator(handle, decoratorKey(entry));
        entry.pendingChange = syncHandleMaterials(entry, handle, null, new Set()) || entry.pendingChange;
        entry.matched.delete(handle);
    }

    function nodeMatches(entry, handle, mesh, roots) {
        if (!mesh?.isMesh) return false;
        if (!nodeSpecMatches(entry.selector.objects, handle, mesh, entry.getAdapter)) return false;
        if (!isUnder(handle, mesh, roots, entry.selector.includeSelf)) return false;
        return matchingMaterials(entry, handle, mesh).size > 0;
    }

    function emitEntryChange(entry, action = 'set') {
        if (!entry.pendingChange) return;
        entry.pendingChange = false;
        if (typeof onChange !== 'function') return;
        onChange({
            type: 'spectralMaterial',
            action,
            layerId: entry.layerId,
            key: entry.key,
            handles: [...entry.matched],
        });
    }

    function scanEntry(entry, action = 'set') {
        if (entry.disposed) return;
        const roots = rootHandles(entry);
        for (const handle of [...entry.matched]) {
            const mesh = nodeMap.get(handle);
            if (!nodeMatches(entry, handle, mesh, roots)) removeHandle(entry, handle);
        }
        for (const [handle, mesh] of nodeMap) {
            if (entry.matched.has(handle) || !nodeMatches(entry, handle, mesh, roots)) continue;
            addHandle(entry, handle, mesh);
        }
        for (const handle of entry.matched) {
            const mesh = nodeMap.get(handle);
            if (mesh) entry.pendingChange = syncHandleMaterials(entry, handle, mesh) || entry.pendingChange;
        }
        emitEntryChange(entry, action);
    }

    function setEntryValue(entry, value) {
        const next = Math.min(1, Math.max(0, Number(value)));
        if (!Number.isFinite(next)) throw new TypeError('ctx.spectral.setNirAlbedo: value must be finite');
        if (next === entry.value) return false;
        entry.value = next;
        for (const material of entry.materialCounts.keys()) {
            const state = materialStates.get(material);
            const assignment = state?.assignments.get(entry.id);
            if (!assignment) continue;
            assignment.value = next;
            entry.pendingChange = applyMaterialState(material, state) || entry.pendingChange;
        }
        emitEntryChange(entry, 'value');
        return true;
    }

    function disposeEntry(entry) {
        if (entry.disposed) return false;
        entry.disposed = true;
        for (const handle of [...entry.matched]) removeHandle(entry, handle);
        entries.delete(entry.id);
        emitEntryChange(entry, 'dispose');
        return true;
    }

    function createEntry(layerId, getAdapter, selector, value, options = {}) {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new TypeError('ctx.spectral.setNirAlbedo: value must be finite');
        const entry = {
            id: nextEntryId++,
            order: nextOrder++,
            key: typeof options.key === 'string' && options.key ? options.key : `nir_${nextEntryId - 1}`,
            layerId,
            getAdapter,
            selector: normalizeSelector(selector),
            value: Math.min(1, Math.max(0, number)),
            matched: new Set(),
            handleMaterials: new Map(),
            materialCounts: new Map(),
            pendingChange: false,
            disposed: false,
        };
        entries.set(entry.id, entry);
        scanEntry(entry);
        return freezePlainObject({
            get key() { return entry.key; },
            get value() { return entry.value; },
            get matched() { return Object.freeze([...entry.matched]); },
            get materials() { return Object.freeze([...entry.materialCounts.keys()]); },
            get active() { return !entry.disposed; },
            set(next) { return setEntryValue(entry, next); },
            refresh() {
                for (const handle of [...entry.matched]) removeHandle(entry, handle);
                scanEntry(entry, 'refresh');
                return [...entry.matched];
            },
            dispose() { return disposeEntry(entry); },
        });
    }

    function update(_dt, elapsed) {
        const now = Number(elapsed);
        if (Number.isFinite(now)) {
            if (now < nextScanAt) return;
            nextScanAt = now + 0.2;
        }
        for (const entry of entries.values()) scanEntry(entry);
    }

    function disposeLayer(layerId) {
        for (const entry of [...entries.values()]) {
            if (entry.layerId === layerId) disposeEntry(entry);
        }
    }

    // Flip the raster band swap for every currently-tagged material. Driven
    // per-frame by the render loop from the NV sensing state — cheap no-op
    // when unchanged. Winner resolution matches applyMaterialState (highest
    // order wins), so overlapping entries swap to the same value they tag.
    function setRasterSensing(on) {
        const next = on === true;
        if (next === rasterSensing) return false;
        rasterSensing = next;
        const seen = new Set();
        for (const entry of entries.values()) {
            if (entry.disposed) continue;
            for (const material of entry.materialCounts.keys()) {
                if (seen.has(material)) continue;
                seen.add(material);
                const state = materialStates.get(material);
                if (!state) continue;
                if (next) {
                    let winner = null;
                    for (const a of state.assignments.values()) {
                        if (!winner || a.order > winner.order) winner = a;
                    }
                    if (winner) applyRasterSwap(material, state, winner.value);
                } else {
                    clearRasterSwap(material, state);
                }
            }
        }
        return true;
    }

    function createLayerFacade(layerId, getAdapter, isActive = () => true) {
        return freezePlainObject({
            setNirAlbedo(selector, value, options = {}) {
                if (!isActive()) return null;
                return createEntry(layerId, getAdapter, selector, value, options);
            },
            list() {
                if (!isActive()) return [];
                return [...entries.values()]
                    .filter(entry => entry.layerId === layerId && !entry.disposed)
                    .map(entry => freezePlainObject({
                        key: entry.key,
                        value: entry.value,
                        matched: Object.freeze([...entry.matched]),
                    }));
            },
            clear() {
                if (!isActive()) return 0;
                const owned = [...entries.values()].filter(entry => entry.layerId === layerId);
                for (const entry of owned) disposeEntry(entry);
                return owned.length;
            },
        });
    }

    return { createLayerFacade, update, disposeLayer, setRasterSensing };
}
