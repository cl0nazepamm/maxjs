// Per-channel morph controls for Max-owned meshes.
//
// Snapshot M3 data stores morphs as vertex-delta buffers. scene_binary turns
// those buffers into Three.js morphAttributes plus the retained
// morphTargetInfluences array. This system deliberately operates on that live
// array in place; it does not invent an animation or vertex cache.

import { freezePlainObject } from './layer_utils.js';

const NO_APPLIED_VALUE = Symbol('maxjsNoAppliedMorphValue');
const VALUE_EPSILON = 1.0e-7;

function createMorphSystem({ nodeMap, lightHandleMap = null } = {}) {
    // Map<handle, Map<channelKey, entry>>. Each entry keeps per-render-object
    // state in a WeakMap so a full sync can replace the mesh without retaining
    // the dead object or losing the newest authored value underneath it.
    const overrides = new Map();
    // Layer-owned channel broadcasts. A matching override is retained by
    // morph name and re-scanned during applyAll(), so newly synced face
    // partitions automatically join without being named by layer code.
    const matchingOverrides = new Map();

    function resolveTarget(target) {
        if (target == null) return null;

        if (target?.handle != null) {
            const handle = Number(target.handle);
            if (!Number.isFinite(handle)) return null;
            return {
                handle,
                object: target.raw?.isObject3D
                    ? target.raw
                    : (nodeMap.get(handle) ?? lightHandleMap?.get?.(handle) ?? null),
            };
        }

        if (target?.isObject3D) {
            const handle = Number(target.userData?.maxjsHandle);
            return Number.isFinite(handle) ? { handle, object: target } : null;
        }

        const numericHandle = Number(target);
        if (typeof target !== 'string' && Number.isFinite(numericHandle)) {
            return {
                handle: numericHandle,
                object: nodeMap.get(numericHandle) ?? lightHandleMap?.get?.(numericHandle) ?? null,
            };
        }

        if (typeof target === 'string' && target) {
            for (const [handle, object] of nodeMap) {
                if (object?.name === target) return { handle, object };
            }
        }
        return null;
    }

    function resolveChannel(object, channel) {
        const influences = object?.morphTargetInfluences;
        if (!Array.isArray(influences)) return null;

        if (Number.isInteger(channel)) {
            return channel >= 0 && channel < influences.length
                ? { index: channel, name: channelNameAt(object, channel), influences }
                : null;
        }

        if (typeof channel !== 'string' || !channel) return null;
        const index = object?.morphTargetDictionary?.[channel];
        return Number.isInteger(index) && index >= 0 && index < influences.length
            ? { index, name: channel, influences }
            : null;
    }

    function channelNameAt(object, index) {
        const dictionary = object?.morphTargetDictionary;
        if (!dictionary) return null;
        for (const [name, nextIndex] of Object.entries(dictionary)) {
            if (nextIndex === index) return name;
        }
        return null;
    }

    function channelKey(channel) {
        return Number.isInteger(channel) ? `index:${channel}` : `name:${String(channel)}`;
    }

    function read(target, channel) {
        const resolvedTarget = resolveTarget(target);
        const resolvedChannel = resolveChannel(resolvedTarget?.object, channel);
        if (!resolvedChannel) return null;
        const value = Number(resolvedChannel.influences[resolvedChannel.index]);
        return Number.isFinite(value) ? value : 0;
    }

    function list(target) {
        const object = resolveTarget(target)?.object;
        const influences = object?.morphTargetInfluences;
        const dictionary = object?.morphTargetDictionary;
        if (!Array.isArray(influences) || !dictionary) return Object.freeze([]);

        return Object.freeze(
            Object.entries(dictionary)
                .filter(([, index]) => Number.isInteger(index) && index >= 0 && index < influences.length)
                .sort((a, b) => a[1] - b[1])
                .map(([name, index]) => freezePlainObject({
                    name,
                    index,
                    value: Number(influences[index]) || 0,
                })),
        );
    }

    function matchingHandles(channel) {
        if (typeof channel !== 'string' || !channel) return Object.freeze([]);
        const out = [];
        for (const [handle, object] of nodeMap) {
            if (!Number.isFinite(Number(handle))) continue;
            if (resolveChannel(object, channel)) out.push(Number(handle));
        }
        return Object.freeze(out);
    }

    function applyEntry(object, channel, entry) {
        const resolved = resolveChannel(object, channel);
        if (!resolved) return false;

        let state = entry.objectStates.get(object);
        if (
            !state
            || state.influences !== resolved.influences
            || state.index !== resolved.index
        ) {
            const current = Number(resolved.influences[resolved.index]);
            state = {
                influences: resolved.influences,
                index: resolved.index,
                base: Number.isFinite(current) ? current : 0,
                applied: NO_APPLIED_VALUE,
            };
            entry.objectStates.set(object, state);
        }

        const current = Number(state.influences[state.index]);
        if (
            state.applied === NO_APPLIED_VALUE
            || !Number.isFinite(current)
            || Math.abs(current - state.applied) > VALUE_EPSILON
        ) {
            // Animation, fast-sync, or a rebuild wrote a newer authored value.
            // Keep it underneath the layer override so clear() restores truth.
            state.base = Number.isFinite(current) ? current : 0;
        }

        let nextValue = entry.mode === 'additive'
            ? state.base + entry.value
            : entry.value;
        if (entry.clamp === true) nextValue = Math.min(1, Math.max(0, nextValue));

        const changed = !Number.isFinite(current) || Math.abs(current - nextValue) > VALUE_EPSILON;
        if (changed) state.influences[state.index] = nextValue;
        state.applied = nextValue;
        return changed;
    }

    function applyHandle(handle, explicitObject = null) {
        const channels = overrides.get(handle);
        if (!channels?.size) return false;
        const object = explicitObject
            ?? nodeMap.get(handle)
            ?? lightHandleMap?.get?.(handle)
            ?? null;
        if (!object) return false;

        let changed = false;
        for (const entry of channels.values()) {
            changed = applyEntry(object, entry.channel, entry) || changed;
        }
        return changed;
    }

    function applyMatchingEntry(layerId, entry) {
        let matched = 0;
        for (const handle of matchingHandles(entry.channel)) {
            if (set(layerId, handle, entry.channel, entry.value, entry.options)) matched++;
        }
        return matched;
    }

    function applyAllMatching() {
        for (const [layerId, entries] of matchingOverrides) {
            for (const entry of entries.values()) applyMatchingEntry(layerId, entry);
        }
    }

    function applyAll() {
        applyAllMatching();
        let changed = false;
        for (const handle of overrides.keys()) changed = applyHandle(handle) || changed;
        return changed;
    }

    function set(layerId, target, channel, value, options = {}) {
        const resolvedTarget = resolveTarget(target);
        const numericValue = Number(value);
        if (!resolvedTarget || !Number.isFinite(numericValue)) return false;
        if (!resolveChannel(resolvedTarget.object, channel)) return false;

        let channels = overrides.get(resolvedTarget.handle);
        if (!channels) {
            channels = new Map();
            overrides.set(resolvedTarget.handle, channels);
        }

        const key = channelKey(channel);
        let entry = channels.get(key);
        if (!entry) {
            entry = {
                channel,
                layerId,
                value: numericValue,
                mode: 'absolute',
                clamp: false,
                objectStates: new WeakMap(),
            };
            channels.set(key, entry);
        }
        entry.channel = channel;
        entry.layerId = layerId;
        entry.value = numericValue;
        entry.mode = options.mode === 'additive' ? 'additive' : 'absolute';
        entry.clamp = options.clamp === true;
        applyEntry(resolvedTarget.object, channel, entry);
        return true;
    }

    function restoreEntry(handle, entry, explicitObject = null) {
        const object = explicitObject
            ?? nodeMap.get(handle)
            ?? lightHandleMap?.get?.(handle)
            ?? null;
        const state = object ? entry?.objectStates?.get(object) : null;
        if (!state || state.influences !== object?.morphTargetInfluences) return false;
        const current = Number(state.influences[state.index]);
        if (!Number.isFinite(current) || Math.abs(current - state.applied) > VALUE_EPSILON) return false;
        const changed = Math.abs(current - state.base) > VALUE_EPSILON;
        if (changed) state.influences[state.index] = state.base;
        return changed;
    }

    function clear(layerId, target, channel) {
        const resolvedTarget = resolveTarget(target);
        if (!resolvedTarget) return false;
        const channels = overrides.get(resolvedTarget.handle);
        if (!channels) return false;
        const key = channelKey(channel);
        const entry = channels.get(key);
        if (!entry || (layerId && entry.layerId !== layerId)) return false;
        restoreEntry(resolvedTarget.handle, entry, resolvedTarget.object);
        channels.delete(key);
        if (channels.size === 0) overrides.delete(resolvedTarget.handle);
        return true;
    }

    function setMatching(layerId, channel, value, options = {}) {
        const numericValue = Number(value);
        if (!layerId || typeof channel !== 'string' || !channel || !Number.isFinite(numericValue)) return 0;
        let entries = matchingOverrides.get(layerId);
        if (!entries) {
            entries = new Map();
            matchingOverrides.set(layerId, entries);
        }
        const entry = {
            channel,
            value: numericValue,
            options: {
                mode: options.mode === 'additive' ? 'additive' : 'absolute',
                clamp: options.clamp === true,
            },
        };
        entries.set(channelKey(channel), entry);
        return applyMatchingEntry(layerId, entry);
    }

    function clearMatching(layerId, channel) {
        if (!layerId || typeof channel !== 'string' || !channel) return 0;
        const key = channelKey(channel);
        const entries = matchingOverrides.get(layerId);
        entries?.delete(key);
        if (entries?.size === 0) matchingOverrides.delete(layerId);

        let cleared = 0;
        for (const [handle, channels] of [...overrides]) {
            const entry = channels.get(key);
            if (!entry || entry.layerId !== layerId) continue;
            if (clear(layerId, handle, channel)) cleared++;
        }
        return cleared;
    }

    function clearTargetForLayer(layerId, target) {
        const resolvedTarget = resolveTarget(target);
        if (!resolvedTarget) return 0;
        const channels = overrides.get(resolvedTarget.handle);
        if (!channels) return 0;
        let count = 0;
        for (const [key, entry] of [...channels.entries()]) {
            if (entry.layerId !== layerId) continue;
            restoreEntry(resolvedTarget.handle, entry, resolvedTarget.object);
            channels.delete(key);
            count++;
        }
        if (channels.size === 0) overrides.delete(resolvedTarget.handle);
        return count;
    }

    function clearLayer(layerId) {
        if (!layerId) return 0;
        matchingOverrides.delete(layerId);
        let count = 0;
        for (const [handle, channels] of [...overrides.entries()]) {
            for (const [key, entry] of [...channels.entries()]) {
                if (entry.layerId !== layerId) continue;
                restoreEntry(handle, entry);
                channels.delete(key);
                count++;
            }
            if (channels.size === 0) overrides.delete(handle);
        }
        return count;
    }

    function has(layerId, target, channel) {
        const resolvedTarget = resolveTarget(target);
        const entry = resolvedTarget
            ? overrides.get(resolvedTarget.handle)?.get(channelKey(channel))
            : null;
        return !!entry && (!layerId || entry.layerId === layerId);
    }

    function createLayerFacade(layerId, isActive = () => true) {
        return freezePlainObject({
            list,
            matching: matchingHandles,
            has(target, channel) {
                return isActive() && has(layerId, target, channel);
            },
            get(target, channel) {
                return read(target, channel);
            },
            set(target, channel, value, options = {}) {
                return isActive() && set(layerId, target, channel, value, options);
            },
            setMatching(channel, value, options = {}) {
                return isActive() ? setMatching(layerId, channel, value, options) : 0;
            },
            clear(target, channel) {
                return isActive() && clear(layerId, target, channel);
            },
            clearMatching(channel) {
                return isActive() ? clearMatching(layerId, channel) : 0;
            },
            clearAll(target = null) {
                if (!isActive()) return 0;
                return target == null
                    ? clearLayer(layerId)
                    : clearTargetForLayer(layerId, target);
            },
        });
    }

    return {
        createLayerFacade,
        applyAll,
        applyHandle,
        clearLayer,
        has,
    };
}

export { createMorphSystem };
