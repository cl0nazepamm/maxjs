// Runtime transform and material override controller for layer-owned scene edits.

import { freezePlainObject, matrixElementsAlmostEqual } from './layer_utils.js';

function createRuntimeOverrideController({ THREE, nodeMap, lightHandleMap = null }) {
    const runtimeTransformOverrides = new Map();
    let runtimeTransformReapplyNeeded = false;
    // Map<handle, Map<slotName, { texture, layerId }>> — survives sync
    // rebuilds. The scene message handler calls applyMaterialOverrides()
    // after every fastsync material assignment so layer-supplied textures
    // (HTML, canvas, anything) reach displacement / color / etc. on the
    // synced mesh without cloning.
    const materialOverrides = new Map();
    // Map<handle, Map<key, { fn, layerId }>> — node-graph decorators
    // (ctx.deform & friends). Same survival contract as map-slot overrides:
    // reapplied after every fastsync material rebuild through
    // applyMaterialOverridesToMesh(). fn(mesh, handle) must be idempotent —
    // it runs again on every reapply for the same material instance.
    const materialDecorators = new Map();
    const objectPropertyOverrides = new Map();
    const runtimeVisibilityOverrides = new Map();
    let runtimeVisibilityReapplyNeeded = false;
    const transformScratch = {
        localMatrix: new THREE.Matrix4(),
        finalMatrix: new THREE.Matrix4(),
        baseInverse: new THREE.Matrix4(),
        parentWorldMatrix: new THREE.Matrix4(),
        parentWorldInverse: new THREE.Matrix4(),
        worldMatrix: new THREE.Matrix4(),
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(),
        deltaPosition: new THREE.Vector3(),
        deltaQuaternion: new THREE.Quaternion(),
        deltaScale: new THREE.Vector3(),
        euler: new THREE.Euler(),
    };
    
    function applyObjectLocalMatrix(obj, matrix) {
        if (!obj?.isObject3D) return false;
        obj.matrixAutoUpdate = false;
        obj.matrix.copy(matrix);
        obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
        if (obj.parent?.isObject3D) {
            obj.matrixWorld.multiplyMatrices(obj.parent.matrixWorld, obj.matrix);
        } else {
            obj.matrixWorld.copy(obj.matrix);
        }
        obj.matrixWorldNeedsUpdate = false;
        if (obj.children.length > 0) {
            obj.updateWorldMatrix(false, true);
        }
        return true;
    }
    
    function createRuntimeTransformState(handle, layerId, obj = null) {
        const source = obj ?? nodeMap.get(handle) ?? null;
        const baseMatrix = source?.matrix?.clone?.() ?? new THREE.Matrix4();
        return {
            handle,
            ownerLayer: layerId ?? null,
            mode: 'additive',
            baseMatrix,
            lastAppliedMatrix: baseMatrix.clone(),
            position: new THREE.Vector3(0, 0, 0),
            quaternion: new THREE.Quaternion(),
            scale: new THREE.Vector3(1, 1, 1),
        };
    }
    
    function composeRuntimeTransformState(state, target, obj = null) {
        if (state.mode === 'absolute') {
            return target.compose(state.position, state.quaternion, state.scale);
        }
        if (state.mode === 'world') {
            // Build world matrix from world-space position/quaternion/scale
            transformScratch.worldMatrix.compose(state.position, state.quaternion, state.scale);
            // Get parent's world matrix (if object has a parent)
            const parent = obj?.parent;
            if (parent?.isObject3D) {
                transformScratch.parentWorldInverse.copy(parent.matrixWorld).invert();
                // localMatrix = parentWorldInverse * worldMatrix
                return target.copy(transformScratch.parentWorldInverse).multiply(transformScratch.worldMatrix);
            }
            // No parent means world = local
            return target.copy(transformScratch.worldMatrix);
        }
        // additive mode: baseMatrix * localOffset
        transformScratch.localMatrix.compose(state.position, state.quaternion, state.scale);
        return target.copy(state.baseMatrix).multiply(transformScratch.localMatrix);
    }
    
    function syncRuntimeTransformBaseFromScene(state, obj) {
        if (!state || !obj?.isObject3D) return;
        if (!matrixElementsAlmostEqual(obj.matrix, state.lastAppliedMatrix)) {
            state.baseMatrix.copy(obj.matrix);
        }
    }
    
    function setRuntimeTransformStateMode(state, mode, obj, preserveCurrent = true) {
        if (!state || (mode !== 'additive' && mode !== 'absolute' && mode !== 'world') || state.mode === mode) return state;
        const currentMatrix = preserveCurrent
            ? composeRuntimeTransformState(state, transformScratch.finalMatrix, obj)
            : (obj?.matrix?.clone?.() ?? state.baseMatrix.clone());
        if (mode === 'world') {
            // Convert current local matrix to world space
            if (obj?.isObject3D) {
                obj.updateWorldMatrix(true, false);
                transformScratch.worldMatrix.copy(currentMatrix);
                if (obj.parent?.isObject3D) {
                    transformScratch.worldMatrix.premultiply(obj.parent.matrixWorld);
                }
                transformScratch.worldMatrix.decompose(state.position, state.quaternion, state.scale);
            } else {
                currentMatrix.decompose(state.position, state.quaternion, state.scale);
            }
        } else if (mode === 'absolute') {
            currentMatrix.decompose(state.position, state.quaternion, state.scale);
        } else {
            // additive
            transformScratch.baseInverse.copy(state.baseMatrix).invert();
            transformScratch.localMatrix.copy(transformScratch.baseInverse).multiply(currentMatrix);
            transformScratch.localMatrix.decompose(state.position, state.quaternion, state.scale);
        }
        state.mode = mode;
        return state;
    }
    
    function applyRuntimeTransformState(state, obj) {
        if (!state || !obj?.isObject3D) return false;
        syncRuntimeTransformBaseFromScene(state, obj);
        const finalMatrix = composeRuntimeTransformState(state, transformScratch.finalMatrix, obj);
        if (matrixElementsAlmostEqual(obj.matrix, finalMatrix)) {
            state.lastAppliedMatrix.copy(finalMatrix);
            return false;
        }
        applyObjectLocalMatrix(obj, finalMatrix);
        state.lastAppliedMatrix.copy(finalMatrix);
        return true;
    }
    
    function getOrCreateRuntimeTransformState(handle, layerId, obj = null) {
        let state = runtimeTransformOverrides.get(handle);
        if (!state) {
            state = createRuntimeTransformState(handle, layerId, obj);
            runtimeTransformOverrides.set(handle, state);
        }
        if (layerId != null) state.ownerLayer = layerId;
        return state;
    }
    
    function clearRuntimeTransformOverride(handle) {
        const state = runtimeTransformOverrides.get(handle);
        if (!state) return false;
        const obj = nodeMap.get(handle);
        if (obj?.isObject3D) applyObjectLocalMatrix(obj, state.baseMatrix);
        runtimeTransformOverrides.delete(handle);
        if (runtimeTransformOverrides.size === 0) runtimeTransformReapplyNeeded = false;
        return true;
    }
    
    function clearRuntimeTransformOverridesForLayer(layerId) {
        if (!layerId) return;
        for (const [handle, state] of [...runtimeTransformOverrides.entries()]) {
            if (state.ownerLayer === layerId) clearRuntimeTransformOverride(handle);
        }
    }
    
    // ── Material map overrides ────────────────────────────────────
    // Layers register a per-slot texture override on a synced node by
    // handle. The scene sync calls applyMaterialOverridesToMesh() after
    // each material assignment so the override survives the full
    // material rebuild that fastsync does on every scene message.
    
    function applyMaterialOverridesToMesh(handle, mesh) {
        if (!mesh) return;
        const slots = materialOverrides.get(handle);
        if (slots) {
            const mats = Array.isArray(mesh.material) ? mesh.material : (mesh.material ? [mesh.material] : []);
            for (const m of mats) {
                if (!m) continue;
                for (const [slot, entry] of slots) {
                    m[slot] = entry.texture;
                }
                m.needsUpdate = true;
            }
        }
        const decorators = materialDecorators.get(handle);
        if (decorators) {
            for (const entry of decorators.values()) {
                try {
                    entry.fn(mesh, handle);
                } catch (err) {
                    console.error('[maxjs] material decorator error', err);
                }
            }
        }
    }
    
    function setMaterialMapOverride(layerId, handle, slot, texture) {
        let slots = materialOverrides.get(handle);
        if (!slots) {
            slots = new Map();
            materialOverrides.set(handle, slots);
        }
        if (texture == null) {
            slots.delete(slot);
            if (slots.size === 0) materialOverrides.delete(handle);
        } else {
            slots.set(slot, { texture, layerId });
        }
        // Apply to the live mesh immediately so the change is visible
        // before the next scene sync.
        const mesh = nodeMap.get(handle);
        if (mesh) applyMaterialOverridesToMesh(handle, mesh);
    }
    
    function clearMaterialOverridesForLayer(layerId) {
        if (!layerId) return;
        for (const [handle, slots] of [...materialOverrides.entries()]) {
            for (const [slot, entry] of [...slots.entries()]) {
                if (entry.layerId === layerId) slots.delete(slot);
            }
            if (slots.size === 0) materialOverrides.delete(handle);
            // Trigger a fresh sync so the original material reasserts.
            // Cheaper than tracking the original map per slot — next
            // scene message rebuilds the material from Max state.
        }
    }

    // ── Material decorators ───────────────────────────────────────
    // Handle-keyed node-graph mutators (positionNode etc.) that ride the
    // same reapply path as map-slot overrides. The owner restores material
    // state itself on clear — the registry only tracks the functions.

    function setMaterialDecorator(layerId, handle, key, fn) {
        if (typeof fn !== 'function' || !key) return false;
        let decorators = materialDecorators.get(handle);
        if (!decorators) {
            decorators = new Map();
            materialDecorators.set(handle, decorators);
        }
        decorators.set(key, { fn, layerId });
        // Apply immediately so the change is visible before the next sync.
        const mesh = nodeMap.get(handle);
        if (mesh) {
            try {
                fn(mesh, handle);
            } catch (err) {
                console.error('[maxjs] material decorator error', err);
            }
        }
        return true;
    }

    function clearMaterialDecorator(handle, key) {
        const decorators = materialDecorators.get(handle);
        if (!decorators?.delete(key)) return false;
        if (decorators.size === 0) materialDecorators.delete(handle);
        return true;
    }

    function clearMaterialDecoratorsForLayer(layerId) {
        if (!layerId) return;
        for (const [handle, decorators] of [...materialDecorators.entries()]) {
            for (const [key, entry] of [...decorators.entries()]) {
                if (entry.layerId === layerId) decorators.delete(key);
            }
            if (decorators.size === 0) materialDecorators.delete(handle);
        }
    }

    function getRuntimeObjectByHandle(handle, explicitObj = null) {
        return explicitObj?.isObject3D
            ? explicitObj
            : (nodeMap.get(handle) ?? lightHandleMap?.get?.(handle) ?? null);
    }

    function markObjectMaterialsDirty(obj) {
        if (!obj?.isObject3D) return false;
        let changed = false;
        obj.traverse?.((child) => {
            const materials = Array.isArray(child?.material)
                ? child.material
                : (child?.material ? [child.material] : []);
            for (const material of materials) {
                if (!material) continue;
                material.needsUpdate = true;
                changed = true;
            }
        });
        const materials = Array.isArray(obj.material)
            ? obj.material
            : (obj.material ? [obj.material] : []);
        for (const material of materials) {
            if (!material) continue;
            material.needsUpdate = true;
            changed = true;
        }
        return changed;
    }

    function applyObjectPropertyOverrideEntry(obj, property, entry) {
        if (!obj || !property || !entry) return false;
        const nextValue = entry.value;
        const changed = obj[property] !== nextValue;
        if (changed) obj[property] = nextValue;
        const shouldSignal = changed || entry.options?.forceUpdate === true;
        if (shouldSignal && entry.options?.needsUpdate === true && obj.needsUpdate !== true) {
            obj.needsUpdate = true;
        }
        if (shouldSignal && entry.options?.shadowNeedsUpdate === true && obj.shadow) {
            obj.shadow.needsUpdate = true;
        }
        if (shouldSignal && entry.options?.materialsNeedUpdate !== false) {
            markObjectMaterialsDirty(obj.parent?.isObject3D ? obj.parent : obj);
        }
        if (typeof entry.options?.onApply === 'function') {
            try { entry.options.onApply(obj, property, nextValue, changed); } catch (_) {}
        }
        return changed;
    }

    function applyObjectPropertyOverrides(handle, explicitObj = null) {
        const properties = objectPropertyOverrides.get(handle);
        if (!properties || properties.size === 0) return false;
        const obj = getRuntimeObjectByHandle(handle, explicitObj);
        if (!obj) return false;
        let changed = false;
        for (const [property, entry] of properties) {
            changed = applyObjectPropertyOverrideEntry(obj, property, entry) || changed;
        }
        return changed;
    }

    function applyAllObjectPropertyOverrides() {
        let changed = false;
        for (const handle of objectPropertyOverrides.keys()) {
            changed = applyObjectPropertyOverrides(handle) || changed;
        }
        return changed;
    }

    function hasObjectPropertyOverride(handle, property) {
        if (!property || typeof property !== 'string') return false;
        return objectPropertyOverrides.get(handle)?.has(property) === true;
    }

    function setObjectPropertyOverride(layerId, handle, property, value, options = {}) {
        if (!property || typeof property !== 'string') return false;
        let properties = objectPropertyOverrides.get(handle);
        if (!properties) {
            properties = new Map();
            objectPropertyOverrides.set(handle, properties);
        }
        properties.set(property, {
            value,
            layerId,
            options: { ...options },
        });
        applyObjectPropertyOverrides(handle, options.object ?? null);
        return true;
    }

    function clearObjectPropertyOverride(layerId, handle, property, options = {}) {
        const properties = objectPropertyOverrides.get(handle);
        if (!properties) return false;
        const entry = properties.get(property);
        if (!entry || (layerId && entry.layerId !== layerId)) return false;
        properties.delete(property);
        if (properties.size === 0) objectPropertyOverrides.delete(handle);
        if (Object.prototype.hasOwnProperty.call(options, 'restoreValue')) {
            const obj = getRuntimeObjectByHandle(handle, options.object ?? null);
            if (obj) {
                obj[property] = options.restoreValue;
                if (options.needsUpdate === true) obj.needsUpdate = true;
                if (options.shadowNeedsUpdate === true && obj.shadow) obj.shadow.needsUpdate = true;
            }
        }
        return true;
    }

    function clearObjectPropertyOverridesForLayer(layerId) {
        if (!layerId) return;
        for (const [handle, properties] of [...objectPropertyOverrides.entries()]) {
            for (const [property, entry] of [...properties.entries()]) {
                if (entry.layerId === layerId) properties.delete(property);
            }
            if (properties.size === 0) objectPropertyOverrides.delete(handle);
        }
    }
    
    function applyAllRuntimeTransformOverrides(force = false) {
        if (!force && !runtimeTransformReapplyNeeded) return false;
        runtimeTransformReapplyNeeded = false;
        let applied = false;
        for (const [handle, state] of runtimeTransformOverrides.entries()) {
            const obj = nodeMap.get(handle);
            if (!obj?.isObject3D) continue;
            if (applyRuntimeTransformState(state, obj)) applied = true;
        }
        return applied;
    }
    
    function markRuntimeTransformOverridesDirty() {
        if (runtimeTransformOverrides.size > 0) runtimeTransformReapplyNeeded = true;
        if (runtimeVisibilityOverrides.size > 0) runtimeVisibilityReapplyNeeded = true;
    }

    function applyRuntimeVisibilityOverrideToObject(state, obj) {
        if (!state || !obj?.isObject3D) return false;
        const next = state.visible !== false;
        let changed = obj.userData?.maxjsVisible !== next;
        obj.userData ??= {};
        obj.userData.maxjsVisible = next;
        if (obj.visible !== true) {
            obj.visible = true;
            changed = true;
        }
        if (obj.layers?.set) {
            const layer = next ? 0 : 31;
            const mask = 1 << layer;
            if (obj.layers.mask !== mask) {
                obj.layers.set(layer);
                changed = true;
            }
        }
        const materials = Array.isArray(obj.material)
            ? obj.material
            : (obj.material ? [obj.material] : []);
        for (const material of materials) {
            if (material && material.visible !== true) {
                material.visible = true;
                changed = true;
            }
        }
        return changed;
    }

    function setRuntimeVisibilityOverride(layerId, handle, visible, explicitObj = null) {
        const obj = explicitObj?.isObject3D ? explicitObj : nodeMap.get(handle);
        const current = runtimeVisibilityOverrides.get(handle);
        const state = {
            handle,
            ownerLayer: layerId ?? null,
            visible: visible !== false,
            baseVisible: current?.baseVisible ?? (obj ? obj.userData?.maxjsVisible !== false && obj.visible !== false : true),
            object: obj ?? current?.object ?? null,
        };
        runtimeVisibilityOverrides.set(handle, state);
        runtimeVisibilityReapplyNeeded = true;
        return applyRuntimeVisibilityOverrideToObject(state, obj);
    }

    function clearRuntimeVisibilityOverride(handle, explicitObj = null) {
        const state = runtimeVisibilityOverrides.get(handle);
        if (!state) return false;
        runtimeVisibilityOverrides.delete(handle);
        if (runtimeVisibilityOverrides.size === 0) runtimeVisibilityReapplyNeeded = false;
        const obj = explicitObj?.isObject3D ? explicitObj : (nodeMap.get(handle) ?? state.object);
        applyRuntimeVisibilityOverrideToObject({ visible: state.baseVisible !== false }, obj);
        return true;
    }

    function clearRuntimeVisibilityOverridesForLayer(layerId) {
        if (!layerId) return;
        for (const [handle, state] of [...runtimeVisibilityOverrides.entries()]) {
            if (state.ownerLayer === layerId) clearRuntimeVisibilityOverride(handle);
        }
    }

    /** True when a layer currently owns this handle's visibility. The bridge
     *  visibility path checks this so Max hide/unhide flows normally unless a
     *  layer explicitly took over (clone workflows hiding the Max copy). */
    function hasRuntimeVisibilityOverride(handle) {
        return runtimeVisibilityOverrides.has(handle);
    }

    function applyAllRuntimeVisibilityOverrides(force = false) {
        if (!force && !runtimeVisibilityReapplyNeeded) return false;
        runtimeVisibilityReapplyNeeded = false;
        let applied = false;
        for (const [handle, state] of runtimeVisibilityOverrides.entries()) {
            const obj = nodeMap.get(handle) ?? state.object;
            if (!obj?.isObject3D) continue;
            if (applyRuntimeVisibilityOverrideToObject(state, obj)) applied = true;
        }
        return applied;
    }
    
    function getRuntimeTransformStateSnapshot(handle) {
        const state = runtimeTransformOverrides.get(handle);
        if (!state) return null;
        const obj = nodeMap.get(handle);
        const currentMatrix = composeRuntimeTransformState(state, transformScratch.finalMatrix, obj);
        currentMatrix.decompose(transformScratch.position, transformScratch.quaternion, transformScratch.scale);
        return freezePlainObject({
            handle,
            mode: state.mode,
            position: transformScratch.position.toArray(),
            quaternion: transformScratch.quaternion.toArray(),
            scale: transformScratch.scale.toArray(),
            baseMatrix: state.baseMatrix.toArray(),
            matrix: currentMatrix.toArray(),
        });
    }
    
    function serializeRuntimeTransformOverrides() {
        const out = [];
        for (const [handle, state] of runtimeTransformOverrides.entries()) {
            const obj = nodeMap.get(handle);
            const currentMatrix = composeRuntimeTransformState(state, transformScratch.finalMatrix, obj);
            currentMatrix.decompose(transformScratch.position, transformScratch.quaternion, transformScratch.scale);
            out.push({
                handle,
                mode: state.mode,
                position: transformScratch.position.toArray(),
                quaternion: transformScratch.quaternion.toArray(),
                scale: transformScratch.scale.toArray(),
            });
        }
        return out;
    }
    
    function restoreRuntimeTransformOverrides(serialized = []) {
        if (!Array.isArray(serialized)) return 0;
        let restored = 0;
        for (const item of serialized) {
            const handle = item?.handle;
            const obj = nodeMap.get(handle);
            if (!obj?.isObject3D) continue;
            const state = getOrCreateRuntimeTransformState(handle, null, obj);
            state.mode = item.mode === 'world'
                ? 'world'
                : (item.mode === 'absolute' ? 'absolute' : 'additive');
            state.baseMatrix.copy(obj.matrix);
            state.lastAppliedMatrix.copy(obj.matrix);
            if (Array.isArray(item.position) && item.position.length >= 3) state.position.fromArray(item.position);
            else state.position.set(0, 0, 0);
            if (Array.isArray(item.quaternion) && item.quaternion.length >= 4) state.quaternion.fromArray(item.quaternion);
            else state.quaternion.identity();
            if (Array.isArray(item.scale) && item.scale.length >= 3) state.scale.fromArray(item.scale);
            else state.scale.set(1, 1, 1);
            applyRuntimeTransformState(state, obj);
            restored++;
        }
        return restored;
    }
    
    function createTransformApi(handle, getObject, layerId) {
        function getSceneObject() {
            const obj = getObject();
            return obj?.isObject3D ? obj : null;
        }
    
        function ensureState(mode, preserveCurrent = true) {
            const obj = getSceneObject();
            if (!obj) return null;
            const state = getOrCreateRuntimeTransformState(handle, layerId, obj);
            setRuntimeTransformStateMode(state, mode, obj, preserveCurrent);
            return { state, obj };
        }
    
        function mutate(mode, mutator, options = {}) {
            const payload = ensureState(mode, options.preserveCurrent !== false);
            if (!payload) return false;
            const { state, obj } = payload;
            mutator(state.position, state.quaternion, state.scale, state, obj);
            applyRuntimeTransformState(state, obj);
            return true;
        }
    
        return freezePlainObject({
            get hasOverride() { return runtimeTransformOverrides.has(handle); },
            get mode() { return runtimeTransformOverrides.get(handle)?.mode ?? null; },
            clear() { return clearRuntimeTransformOverride(handle); },
            snapshot() { return getRuntimeTransformStateSnapshot(handle); },
            baseSnapshot() {
                const obj = getSceneObject();
                const state = runtimeTransformOverrides.get(handle);
                const matrix = state?.baseMatrix ?? obj?.matrix ?? null;
                if (!matrix) return null;
                matrix.decompose(transformScratch.position, transformScratch.quaternion, transformScratch.scale);
                return freezePlainObject({
                    handle,
                    position: transformScratch.position.toArray(),
                    quaternion: transformScratch.quaternion.toArray(),
                    scale: transformScratch.scale.toArray(),
                    matrix: matrix.toArray(),
                });
            },
            setMode(mode, options = {}) {
                const validMode = mode === 'world' ? 'world' : (mode === 'absolute' ? 'absolute' : 'additive');
                const payload = ensureState(validMode, options.preserveCurrent !== false);
                if (!payload) return false;
                applyRuntimeTransformState(payload.state, payload.obj);
                return true;
            },
            setPosition(x = 0, y = 0, z = 0, options = {}) {
                return mutate(options.mode === 'additive' ? 'additive' : 'absolute', position => {
                    position.set(x, y, z);
                }, options);
            },
            offsetPosition(x = 0, y = 0, z = 0) {
                return mutate('additive', position => {
                    position.add(transformScratch.deltaPosition.set(x, y, z));
                });
            },
            setRotationEuler(x = 0, y = 0, z = 0, options = {}) {
                return mutate(options.mode === 'additive' ? 'additive' : 'absolute', (position, quaternion) => {
                    quaternion.setFromEuler(transformScratch.euler.set(x, y, z, options.order || 'XYZ'));
                }, options);
            },
            offsetRotationEuler(x = 0, y = 0, z = 0, options = {}) {
                return mutate('additive', (position, quaternion) => {
                    transformScratch.deltaQuaternion.setFromEuler(transformScratch.euler.set(x, y, z, options.order || 'XYZ'));
                    quaternion.multiply(transformScratch.deltaQuaternion);
                });
            },
            setQuaternion(x = 0, y = 0, z = 0, w = 1, options = {}) {
                return mutate(options.mode === 'additive' ? 'additive' : 'absolute', (position, quaternion) => {
                    quaternion.set(x, y, z, w).normalize();
                }, options);
            },
            setScale(x = 1, y = x, z = x, options = {}) {
                return mutate(options.mode === 'additive' ? 'additive' : 'absolute', (position, quaternion, scale) => {
                    scale.set(x, y, z);
                }, options);
            },
            multiplyScale(x = 1, y = x, z = x) {
                return mutate('additive', (position, quaternion, scale) => {
                    scale.multiply(transformScratch.deltaScale.set(x, y, z));
                });
            },
            // World-space transform methods for physics
            setWorldPosition(x = 0, y = 0, z = 0) {
                return mutate('world', position => {
                    position.set(x, y, z);
                });
            },
            setWorldQuaternion(x = 0, y = 0, z = 0, w = 1) {
                return mutate('world', (position, quaternion) => {
                    quaternion.set(x, y, z, w).normalize();
                });
            },
            setWorldRotationEuler(x = 0, y = 0, z = 0, options = {}) {
                return mutate('world', (position, quaternion) => {
                    quaternion.setFromEuler(transformScratch.euler.set(x, y, z, options.order || 'XYZ'));
                });
            },
            setWorldTransform(px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = sx, sz = sx) {
                return mutate('world', (position, quaternion, scale) => {
                    position.set(px, py, pz);
                    quaternion.set(qx, qy, qz, qw).normalize();
                    scale.set(sx, sy, sz);
                });
            },
            setWorldMatrix(matrix) {
                // matrix can be THREE.Matrix4 or Float32Array/Array of 16 elements
                return mutate('world', (position, quaternion, scale) => {
                    if (matrix?.isMatrix4) {
                        matrix.decompose(position, quaternion, scale);
                    } else if (Array.isArray(matrix) || ArrayBuffer.isView(matrix)) {
                        transformScratch.worldMatrix.fromArray(matrix);
                        transformScratch.worldMatrix.decompose(position, quaternion, scale);
                    }
                });
            },
        });
    }

    return {
        applyMaterialOverridesToMesh,
        setMaterialMapOverride,
        clearMaterialOverridesForLayer,
        setMaterialDecorator,
        clearMaterialDecorator,
        clearMaterialDecoratorsForLayer,
        setObjectPropertyOverride,
        clearObjectPropertyOverride,
        clearObjectPropertyOverridesForLayer,
        applyObjectPropertyOverrides,
        applyAllObjectPropertyOverrides,
        hasObjectPropertyOverride,
        applyAllRuntimeTransformOverrides,
        applyAllRuntimeVisibilityOverrides,
        markRuntimeTransformOverridesDirty,
        serializeRuntimeTransformOverrides,
        restoreRuntimeTransformOverrides,
        createTransformApi,
        clearRuntimeTransformOverridesForLayer,
        setRuntimeVisibilityOverride,
        clearRuntimeVisibilityOverride,
        clearRuntimeVisibilityOverridesForLayer,
        hasRuntimeVisibilityOverride,
    };
}

export { createRuntimeOverrideController };
