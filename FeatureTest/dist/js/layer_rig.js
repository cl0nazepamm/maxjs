// Hierarchy-aware skeletal controls exposed as ctx.rig.
//
// Max skin partitions own private Bone copies keyed as `${mesh}:${bone}`.
// A control can therefore appear directly in body/hair skeletons while a
// descendant-only island (eyes, teeth, accessories) contains only children of
// that control. A rig binding drives every direct copy and inserts an identity
// follower above descendant-only roots, preserving their own local animation.

import { freezePlainObject } from './layer_utils.js';

function createRigFacade({ THREE, nodeMap, maxScene, getAdapter, isActive = () => true }) {
    const bindings = new Map();

    const authoredHandleFromBone = (bone) => {
        const value = bone?.userData?.maxjsHandle;
        if (Number.isFinite(Number(value))) return Number(value);
        const text = String(value ?? '');
        const separator = text.lastIndexOf(':');
        if (separator < 0) return null;
        const handle = Number(text.slice(separator + 1));
        return Number.isFinite(handle) ? handle : null;
    };

    const parentHandleOf = (handle) => {
        const object = nodeMap.get(Number(handle));
        const parentHandle = Number(object?.userData?.maxjsParentHandle);
        return Number.isFinite(parentHandle) && parentHandle > 0 ? parentHandle : null;
    };

    const isAuthoredDescendant = (handle, ancestorHandle) => {
        const seen = new Set();
        let cursor = Number(handle);
        while (Number.isFinite(cursor) && cursor > 0 && !seen.has(cursor)) {
            if (cursor === ancestorHandle) return handle !== ancestorHandle;
            seen.add(cursor);
            cursor = parentHandleOf(cursor);
        }
        return false;
    };

    function createBinding(target, options = {}) {
        const targetAdapter = maxScene.resolve(target, { exact: options.exact !== false });
        if (!targetAdapter) return null;

        const targetHandle = Number(targetAdapter.handle);
        if (!Number.isFinite(targetHandle)) return null;
        const directBones = new Map();
        const followers = new Map();
        const deltaMatrix = new THREE.Matrix4();
        const deltaQuaternion = new THREE.Quaternion();
        const deltaEuler = new THREE.Euler();
        const targetWorld = new THREE.Matrix4();
        const targetWorldInverse = new THREE.Matrix4();
        const worldDelta = new THREE.Matrix4();
        const meshWorldInverse = new THREE.Matrix4();
        const proxyLocal = new THREE.Matrix4();
        let disposed = false;

        function resetFollower(entry) {
            entry.proxy.matrix.identity();
            entry.proxy.matrixWorldNeedsUpdate = true;
            entry.proxy.updateWorldMatrix(false, true);
        }

        function disposeFollower(entry) {
            resetFollower(entry);
            const parent = entry.proxy.parent ?? entry.mesh;
            for (const root of entry.roots) {
                if (root?.parent === entry.proxy && parent?.isObject3D) parent.add(root);
            }
            entry.proxy.parent?.remove(entry.proxy);
        }

        function ensureFollower(mesh, roots) {
            let entry = followers.get(mesh);
            if (!entry) {
                const proxy = new THREE.Object3D();
                proxy.name = `__maxjs_rig_${targetHandle}_${mesh.userData?.maxjsHandle ?? mesh.id}__`;
                proxy.matrixAutoUpdate = false;
                proxy.matrix.identity();
                proxy.userData.maxjsRigFollower = true;
                proxy.userData.maxjsRigTargetHandle = targetHandle;
                mesh.add(proxy);
                entry = { mesh, proxy, roots: [] };
                followers.set(mesh, entry);
            }
            for (const root of roots) {
                if (!entry.roots.includes(root)) entry.roots.push(root);
                if (root.parent === mesh) entry.proxy.add(root);
            }
            return entry;
        }

        function refresh() {
            if (disposed || !isActive()) return false;
            const nextDirect = new Map();
            const nextFollowerMeshes = new Set();
            const seenMeshes = new Set();

            for (const object of nodeMap.values()) {
                if (!object?.isSkinnedMesh || !object.skeleton || seenMeshes.has(object)) continue;
                seenMeshes.add(object);
                const bones = object.skeleton.bones ?? [];
                const direct = bones.filter(bone => authoredHandleFromBone(bone) === targetHandle);
                if (direct.length > 0) {
                    for (const bone of direct) {
                        const scopedHandle = bone.userData?.maxjsHandle;
                        const adapter = getAdapter(scopedHandle, bone);
                        if (adapter) nextDirect.set(scopedHandle, adapter);
                    }
                    continue;
                }
                if (options.followDescendants === false) continue;

                const boneSet = new Set(bones);
                const existingProxy = followers.get(object)?.proxy ?? null;
                const roots = bones.filter((bone) => (
                    !boneSet.has(bone.parent)
                    && (bone.parent === object || bone.parent === existingProxy)
                    && isAuthoredDescendant(authoredHandleFromBone(bone), targetHandle)
                ));
                if (roots.length === 0) continue;
                ensureFollower(object, roots);
                nextFollowerMeshes.add(object);
            }

            if (nextDirect.size === 0 && targetAdapter.raw?.isBone) {
                nextDirect.set(targetAdapter.handle, targetAdapter);
            }

            for (const [handle, adapter] of directBones) {
                if (!nextDirect.has(handle) && adapter?.transform?.hasOverride) adapter.transform.clear();
            }
            directBones.clear();
            for (const [handle, adapter] of nextDirect) directBones.set(handle, adapter);

            for (const [mesh, entry] of [...followers]) {
                if (nextFollowerMeshes.has(mesh)) continue;
                disposeFollower(entry);
                followers.delete(mesh);
            }
            return directBones.size > 0 || followers.size > 0;
        }

        function getBaseTargetWorld() {
            const representative = directBones.values().next().value;
            const raw = representative?.raw;
            const base = representative?.transform?.baseSnapshot?.();
            if (raw?.isObject3D && Array.isArray(base?.matrix)) {
                targetWorld.fromArray(base.matrix);
                if (raw.parent?.isObject3D) {
                    raw.parent.updateWorldMatrix(true, false);
                    targetWorld.premultiply(raw.parent.matrixWorld);
                }
                return targetWorld;
            }

            const authored = targetAdapter.raw;
            if (!authored?.isObject3D) return null;
            authored.updateWorldMatrix(true, false);
            return targetWorld.copy(authored.matrixWorld);
        }

        function applyFollowers() {
            if (followers.size === 0) return;
            const baseWorld = getBaseTargetWorld();
            if (!baseWorld) return;
            targetWorldInverse.copy(baseWorld).invert();
            worldDelta.copy(baseWorld).multiply(deltaMatrix).multiply(targetWorldInverse);

            for (const entry of followers.values()) {
                entry.mesh.updateWorldMatrix(true, false);
                meshWorldInverse.copy(entry.mesh.matrixWorld).invert();
                proxyLocal.copy(meshWorldInverse).multiply(worldDelta).multiply(entry.mesh.matrixWorld);
                entry.proxy.matrix.copy(proxyLocal);
                entry.proxy.matrixWorldNeedsUpdate = true;
                entry.proxy.updateWorldMatrix(false, true);
            }
        }

        function applyDirect(method, args, order) {
            for (const adapter of directBones.values()) {
                if (!adapter?.exists) continue;
                adapter.transform[method](...args, { mode: 'additive', order });
            }
        }

        function setRotationEuler(x = 0, y = 0, z = 0, setOptions = {}) {
            if (disposed || !isActive()) return false;
            refresh();
            const order = setOptions.order || 'XYZ';
            deltaQuaternion.setFromEuler(deltaEuler.set(x, y, z, order));
            deltaMatrix.makeRotationFromQuaternion(deltaQuaternion);
            applyDirect('setRotationEuler', [x, y, z], order);
            applyFollowers();
            return directBones.size > 0 || followers.size > 0;
        }

        function setQuaternion(x = 0, y = 0, z = 0, w = 1) {
            if (disposed || !isActive()) return false;
            refresh();
            deltaQuaternion.set(x, y, z, w).normalize();
            deltaMatrix.makeRotationFromQuaternion(deltaQuaternion);
            applyDirect('setQuaternion', [
                deltaQuaternion.x,
                deltaQuaternion.y,
                deltaQuaternion.z,
                deltaQuaternion.w,
            ]);
            applyFollowers();
            return directBones.size > 0 || followers.size > 0;
        }

        function clear() {
            if (disposed) return false;
            let changed = false;
            for (const adapter of directBones.values()) {
                if (adapter?.transform?.hasOverride) changed = adapter.transform.clear() || changed;
            }
            for (const entry of followers.values()) {
                resetFollower(entry);
                changed = true;
            }
            deltaQuaternion.identity();
            deltaMatrix.identity();
            return changed;
        }

        function dispose() {
            if (disposed) return;
            if (isActive()) clear();
            for (const entry of followers.values()) disposeFollower(entry);
            followers.clear();
            directBones.clear();
            disposed = true;
            bindings.delete(targetHandle);
        }

        refresh();
        return freezePlainObject({
            get target() { return targetAdapter; },
            get exists() { return !disposed && targetAdapter.exists; },
            get directCount() { return directBones.size; },
            get followerCount() { return followers.size; },
            refresh,
            setRotationEuler,
            setQuaternion,
            clear,
            dispose,
        });
    }

    const facade = freezePlainObject({
        bind(target, options = {}) {
            if (!isActive()) return null;
            const resolved = maxScene.resolve(target, { exact: options.exact !== false });
            const handle = Number(resolved?.handle);
            if (!Number.isFinite(handle)) return null;
            const existing = bindings.get(handle);
            if (existing) return existing;
            const binding = createBinding(resolved, options);
            if (binding) bindings.set(handle, binding);
            return binding;
        },
        disposeAll() {
            for (const binding of [...bindings.values()]) binding.dispose();
            bindings.clear();
        },
    });
    return facade;
}

export { createRigFacade };
