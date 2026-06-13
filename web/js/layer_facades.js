// Small facades exposed on layer contexts.

import { freezePlainObject } from './layer_utils.js';

function createNodeMapFacade(nodeMap, getAdapter) {
    const facade = {
        get size() { return nodeMap.size; },
        has(handle) { return nodeMap.has(handle); },
        get(handle) { return nodeMap.has(handle) ? getAdapter(handle) : null; },
        keys() { return nodeMap.keys(); },
        *values() {
            for (const handle of nodeMap.keys()) yield getAdapter(handle);
        },
        *entries() {
            for (const handle of nodeMap.keys()) yield [handle, getAdapter(handle)];
        },
        forEach(fn, thisArg) {
            for (const handle of nodeMap.keys()) {
                fn.call(thisArg, getAdapter(handle), handle, facade);
            }
        },
        [Symbol.iterator]() {
            return this.entries();
        },
    };
    return freezePlainObject(facade);
}

// ctx.instances — read/write access to synced instanced groups (ForestPack /
// RailClone / tyFlow scatters). Each group lands as a THREE.InstancedMesh tagged
// userData.maxjsInstanceGroup and keyed by userData.maxjsSource (see
// scene_applier.js applyForestInstances). Built through createLayerManager, so it
// behaves identically in the live viewer and in exported standalone snapshots.
//
// Groups are addressed by their baked source key. NOTE: that key is currently
// derived from a Mesh* pointer on the C++ side, so it is stable WITHIN one exported
// snapshot but NOT reproducible across re-exports. For code that must survive a
// re-export, resolve by iteration/index rather than a hard-coded key (a stable-id
// follow-up on the C++ extractor would remove this caveat).
//
// Typical use: resolve the group ONCE (cheap traverse) and hold the handle; the
// per-instance accessors then go straight to the mesh with no traversal.
//   const bricks = ctx.instances.get('...');
//   bricks.setPositionAt(3, x, y, z);   // moves instance 3, flags an upload
function createInstancesFacade({ THREE, getRoot }) {
    const scratch = new THREE.Matrix4();      // used by the mutation helpers
    const iterScratch = new THREE.Matrix4();  // separate, so a mutating forEach
                                              // callback can't clobber iteration
    const handleCache = new WeakMap();        // one stable wrapper per mesh

    function eachGroupMesh(visit) {
        const root = typeof getRoot === 'function' ? getRoot() : null;
        if (!root) return;
        const stack = [root];
        while (stack.length) {
            const o = stack.pop();
            if (o && o.isInstancedMesh && o.userData && o.userData.maxjsInstanceGroup) visit(o);
            const kids = o && o.children;
            if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
        }
    }

    function findMesh(key) {
        const want = String(key);
        let hit = null;
        eachGroupMesh(m => { if (!hit && String(m.userData.maxjsSource) === want) hit = m; });
        return hit;
    }

    function findMeshes(key) {
        const want = String(key);
        const hits = [];
        eachGroupMesh(m => { if (String(m.userData.maxjsSource) === want) hits.push(m); });
        hits.sort((a, b) =>
            (Number(a.userData.maxjsInstanceStart) || 0) -
            (Number(b.userData.maxjsInstanceStart) || 0));
        return hits;
    }

    function wrap(mesh) {
        if (!mesh) return null;
        const cached = handleCache.get(mesh);
        if (cached) return cached;
        const inRange = (i) => Number.isInteger(i) && i >= 0 && i < mesh.count;
        const handle = freezePlainObject({
            get key() { return mesh.userData.maxjsSource; },
            get count() { return mesh.count; },
            get raw() { return mesh; },
            getMatrixAt(i, out = new THREE.Matrix4()) {
                if (!inRange(i)) return null;
                mesh.getMatrixAt(i, out);
                return out;
            },
            setMatrixAt(i, matrix) {
                if (!inRange(i) || !matrix || !matrix.isMatrix4) return false;
                mesh.setMatrixAt(i, matrix);
                mesh.instanceMatrix.needsUpdate = true;
                return true;
            },
            getPositionAt(i, out = new THREE.Vector3()) {
                if (!inRange(i)) return null;
                mesh.getMatrixAt(i, scratch);
                return out.setFromMatrixPosition(scratch);
            },
            // Move instance i, preserving its rotation/scale. Accepts (x,y,z) or a
            // Vector3 / array-like as the first argument.
            setPositionAt(i, x, y, z) {
                if (!inRange(i)) return false;
                mesh.getMatrixAt(i, scratch);
                if (x && typeof x === 'object') {
                    scratch.setPosition(x.x ?? x[0] ?? 0, x.y ?? x[1] ?? 0, x.z ?? x[2] ?? 0);
                } else {
                    scratch.setPosition(x, y, z);
                }
                mesh.setMatrixAt(i, scratch);
                mesh.instanceMatrix.needsUpdate = true;
                return true;
            },
            forEach(fn) {
                if (typeof fn !== 'function') return;
                for (let i = 0; i < mesh.count; i++) {
                    mesh.getMatrixAt(i, iterScratch);
                    fn(i, iterScratch, handle);
                }
            },
            // Call after a batch of setMatrixAt() if you bypassed the helpers.
            flush() { mesh.instanceMatrix.needsUpdate = true; return true; },
        });
        handleCache.set(mesh, handle);
        return handle;
    }

    function wrapMany(meshes, key) {
        if (!Array.isArray(meshes) || meshes.length === 0) return null;
        if (meshes.length === 1) return wrap(meshes[0]);
        const totalFromPayload = Number(meshes[0]?.userData?.maxjsInstanceTotal);
        const totalCount = Number.isFinite(totalFromPayload) && totalFromPayload > 0
            ? totalFromPayload
            : meshes.reduce((sum, mesh) => sum + (mesh?.count || 0), 0);

        function locate(globalIndex) {
            if (!Number.isInteger(globalIndex) || globalIndex < 0 || globalIndex >= totalCount) return null;
            let runningStart = 0;
            for (const mesh of meshes) {
                const declaredStart = Number(mesh.userData.maxjsInstanceStart);
                const start = Number.isFinite(declaredStart) ? declaredStart : runningStart;
                const end = start + mesh.count;
                if (globalIndex >= start && globalIndex < end) {
                    return { mesh, localIndex: globalIndex - start };
                }
                runningStart = end;
            }
            return null;
        }

        return freezePlainObject({
            get key() { return key; },
            get count() { return totalCount; },
            get raw() { return meshes[0]; },
            get rawMeshes() { return meshes.slice(); },
            getMatrixAt(i, out = new THREE.Matrix4()) {
                const hit = locate(i);
                if (!hit) return null;
                hit.mesh.getMatrixAt(hit.localIndex, out);
                return out;
            },
            setMatrixAt(i, matrix) {
                const hit = locate(i);
                if (!hit || !matrix || !matrix.isMatrix4) return false;
                hit.mesh.setMatrixAt(hit.localIndex, matrix);
                hit.mesh.instanceMatrix.needsUpdate = true;
                return true;
            },
            getPositionAt(i, out = new THREE.Vector3()) {
                const hit = locate(i);
                if (!hit) return null;
                hit.mesh.getMatrixAt(hit.localIndex, scratch);
                return out.setFromMatrixPosition(scratch);
            },
            setPositionAt(i, x, y, z) {
                const hit = locate(i);
                if (!hit) return false;
                hit.mesh.getMatrixAt(hit.localIndex, scratch);
                if (x && typeof x === 'object') {
                    scratch.setPosition(x.x ?? x[0] ?? 0, x.y ?? x[1] ?? 0, x.z ?? x[2] ?? 0);
                } else {
                    scratch.setPosition(x, y, z);
                }
                hit.mesh.setMatrixAt(hit.localIndex, scratch);
                hit.mesh.instanceMatrix.needsUpdate = true;
                return true;
            },
            forEach(fn) {
                if (typeof fn !== 'function') return;
                let runningStart = 0;
                for (const mesh of meshes) {
                    const declaredStart = Number(mesh.userData.maxjsInstanceStart);
                    const start = Number.isFinite(declaredStart) ? declaredStart : runningStart;
                    for (let i = 0; i < mesh.count; i++) {
                        mesh.getMatrixAt(i, iterScratch);
                        fn(start + i, iterScratch, this);
                    }
                    runningStart = start + mesh.count;
                }
            },
            flush() {
                for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
                return true;
            },
        });
    }

    return freezePlainObject({
        get count() { return this.keys().length; },
        keys() { const out = new Set(); eachGroupMesh(m => out.add(m.userData.maxjsSource)); return [...out]; },
        has(key) { return findMesh(key) !== null; },
        get(key) { return wrapMany(findMeshes(key), String(key)); },
        all() { return this.keys().map(key => this.get(key)).filter(Boolean); },
        forEach(fn) {
            if (typeof fn !== 'function') return;
            for (const key of this.keys()) fn(this.get(key), key);
        },
        [Symbol.iterator]() { return this.all()[Symbol.iterator](); },
    });
}

function createMaxSceneFacade({ scene, nodeMap, lightHandleMap, getAdapter, createAnchor, THREE }) {
    const parentHandleOf = (obj) => {
        const h = Number(obj?.userData?.maxjsParentHandle);
        return Number.isFinite(h) && h > 0 ? h : null;
    };
    const adapterMatches = (adapter, options = {}) => {
        if (!adapter) return false;
        if (options.meshOnly === true && !adapter.isMesh) return false;
        if (options.visibleOnly === true && !adapter.visible) return false;
        return true;
    };
    const resolveAdapter = (value, options = {}) => {
        if (value?.handle != null) return getAdapter(Number(value.handle));
        if (Number.isFinite(Number(value))) return getAdapter(Number(value));
        if (typeof value === 'string') {
            const hits = [];
            const query = value.toLowerCase();
            const exact = options.exact !== false;
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                const current = String(adapter?.name ?? '').toLowerCase();
                if ((exact && current === query) || (!exact && current.includes(query))) hits.push(adapter);
            }
            if (lightHandleMap) {
                for (const [handle, light] of lightHandleMap.entries()) {
                    const current = String(light?.name ?? '').toLowerCase();
                    if ((exact && current === query) || (!exact && current.includes(query))) hits.push(getAdapter(handle, light));
                }
            }
            return hits[0] ?? null;
        }
        return null;
    };
    const pushChildrenFromMap = (out, map, parentHandle) => {
        if (!map) return;
        for (const [handle, obj] of map.entries()) {
            if (parentHandleOf(obj) === parentHandle) out.push(getAdapter(handle, obj));
        }
    };
    const collectDescendants = (out, parentHandle, options = {}, seen = new Set()) => {
        if (seen.has(parentHandle)) return;
        seen.add(parentHandle);
        const children = [];
        pushChildrenFromMap(children, nodeMap, parentHandle);
        pushChildrenFromMap(children, lightHandleMap, parentHandle);
        for (const child of children) {
            if (adapterMatches(child, options)) out.push(child);
            collectDescendants(out, child.handle, options, seen);
        }
    };
    const findByNameInternal = (name, options = {}) => {
        const query = String(name ?? '').toLowerCase();
        const exact = options.exact === true;
        const matches = [];
        for (const handle of nodeMap.keys()) {
            const adapter = getAdapter(handle);
            const current = String(adapter?.name ?? '').toLowerCase();
            if (!query) continue;
            if ((exact && current === query) || (!exact && current.includes(query))) {
                matches.push(adapter);
            }
        }
        if (lightHandleMap) {
            for (const [handle, light] of lightHandleMap.entries()) {
                const current = String(light?.name ?? '').toLowerCase();
                if (!query) continue;
                if ((exact && current === query) || (!exact && current.includes(query))) {
                    matches.push(getAdapter(handle, light));
                }
            }
        }
        return matches;
    };
    return freezePlainObject({
        get size() { return nodeMap.size; },
        get background() { return scene.background?.clone?.() ?? scene.background ?? null; },
        get environment() { return scene.environment ?? null; },
        get fog() { return scene.fog?.clone?.() ?? null; },
        has(handle) { return nodeMap.has(handle); },
        getNode(handle) {
            if (nodeMap.has(handle)) return getAdapter(handle);
            if (lightHandleMap?.has(handle)) return getAdapter(handle, lightHandleMap.get(handle));
            return null;
        },
        getParent(handle) {
            const obj = nodeMap.get(handle) ?? lightHandleMap?.get(handle) ?? null;
            const parentHandle = parentHandleOf(obj);
            return parentHandle != null ? getAdapter(parentHandle) : null;
        },
        getChildren(handle) {
            const parentHandle = Number(handle);
            if (!Number.isFinite(parentHandle)) return Object.freeze([]);
            const out = [];
            pushChildrenFromMap(out, nodeMap, parentHandle);
            pushChildrenFromMap(out, lightHandleMap, parentHandle);
            return Object.freeze(out);
        },
        listRoots() {
            const out = [];
            for (const [handle, obj] of nodeMap.entries()) {
                if (parentHandleOf(obj) == null) out.push(getAdapter(handle));
            }
            if (lightHandleMap) {
                for (const [handle, light] of lightHandleMap.entries()) {
                    if (parentHandleOf(light) == null) out.push(getAdapter(handle, light));
                }
            }
            return Object.freeze(out);
        },
        listHandles() { return Array.from(nodeMap.keys()); },
        listNodes() { return Array.from(nodeMap.keys(), handle => getAdapter(handle)); },
        findOne(name, options = {}) {
            return findByNameInternal(name, { exact: options.exact !== false })[0] ?? null;
        },
        resolve(value, options = {}) {
            return resolveAdapter(value, options);
        },
        under(parent, options = {}) {
            const root = resolveAdapter(parent, options);
            if (!root) return Object.freeze([]);
            const out = [];
            if (options.includeSelf === true && adapterMatches(root, options)) out.push(root);
            collectDescendants(out, root.handle, options);
            return Object.freeze(out);
        },
        /** Meshes whose Max stack has three.js Deform (bridge sets adapter.jsmod). Safe to poll every frame — nodeMap grows as sync arrives. */
        listJsmodNodes() {
            const out = [];
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                if (adapter?.isMesh && adapter.jsmod) out.push(adapter);
            }
            return out;
        },
        /** Nodes currently selected in Max (bridge stamps userData.maxjsSelected).
         *  Safe to poll; subscribe to bus event 'max:selection' for changes. */
        listSelected() {
            const out = [];
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                if (adapter?.selected) out.push(adapter);
            }
            return out;
        },
        findByName(name, options = {}) {
            return findByNameInternal(name, options);
        },
        createAnchor(handle, options = {}) {
            return createAnchor(handle, options);
        },
        raycast(origin, direction, options = {}) {
            const rc = new THREE.Raycaster(origin, direction);
            if (Number.isFinite(options.near)) rc.near = options.near;
            if (Number.isFinite(options.far)) rc.far = options.far;
            const targets = [];
            for (const obj of nodeMap.values()) {
                if (obj?.visible) targets.push(obj);
            }
            return rc.intersectObjects(targets, true).filter((hit) => {
                return hit.object?.userData?.maxjsVisible !== false;
            }).map((hit) => {
                let normal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0);
                if (hit.face?.normal && hit.object?.matrixWorld) {
                    normal.transformDirection(hit.object.matrixWorld);
                    if (normal.lengthSq() > 0) normal.normalize();
                }
                return {
                    point: hit.point.clone(),
                    normal,
                    distance: hit.distance,
                    handle: hit.object?.userData?.maxjsHandle ?? null,
                    name: hit.object?.name ?? '',
                    uv: hit.uv ? hit.uv.clone() : null,
                };
            });
        },
    });
}

function createRendererFacade(renderer, THREE, scene) {
    let pmremGenerator = null;

    function getPMREMGenerator() {
        if (!pmremGenerator) {
            pmremGenerator = new THREE.PMREMGenerator(renderer);
            pmremGenerator.compileEquirectangularShader?.();
            pmremGenerator.compileCubemapShader?.();
        }
        return pmremGenerator;
    }

    function retainPMREMTexture(renderTarget) {
        const texture = renderTarget?.texture ?? null;
        if (!texture) {
            renderTarget?.dispose?.();
            return null;
        }
        texture.userData ??= {};
        if (!texture.userData.maxjsPMREMDisposeWrapped) {
            let disposed = false;
            const originalDispose = texture.dispose?.bind(texture);
            texture.dispose = () => {
                if (disposed) return;
                disposed = true;
                const target = texture.userData?.maxjsPMREMRenderTarget;
                if (target) target.dispose?.();
                else originalDispose?.();
                if (texture.userData) {
                    delete texture.userData.maxjsPMREMRenderTarget;
                    delete texture.userData.maxjsPMREMDisposeWrapped;
                }
            };
            texture.userData.maxjsPMREMDisposeWrapped = true;
        }
        texture.userData.maxjsPMREMRenderTarget = renderTarget;
        return texture;
    }

    function pmremFromScene(sceneOrObj, sigma = 0, near = 0.1, far = 1_000_000) {
        const pmrem = getPMREMGenerator();
        const target = sceneOrObj?.isScene
            ? sceneOrObj
            : (() => {
                const s = new THREE.Scene();
                if (sceneOrObj) s.add(sceneOrObj);
                return s;
            })();
        const rt = pmrem.fromScene(target, sigma, near, far);
        return retainPMREMTexture(rt);
    }
    function pmremFromEquirectangular(texture) {
        const pmrem = getPMREMGenerator();
        const rt = pmrem.fromEquirectangular(texture);
        return retainPMREMTexture(rt);
    }
    return freezePlainObject({
        get capabilities() { return renderer.capabilities; },
        get info() { return renderer.info; },
        get domElement() { return renderer.domElement; },
        get width() { return renderer.domElement?.width ?? 0; },
        get height() { return renderer.domElement?.height ?? 0; },
        get sceneRoot() { return scene; },
        pmremFromScene,
        pmremFromEquirectangular,
    });
}

function createInputHelper(renderer) {
    const el = renderer.domElement;
    const listeners = [];
    function on(target, event, fn, opts) {
        target.addEventListener(event, fn, opts);
        listeners.push({ target, event, fn, opts });
    }
    return {
        get element() { return el; },
        get document() { return el?.ownerDocument; },
        on,
        dispose() {
            for (const { target, event, fn, opts } of listeners)
                target.removeEventListener(event, fn, opts);
            listeners.length = 0;
        },
    };
}
export {
    createNodeMapFacade,
    createInstancesFacade,
    createMaxSceneFacade,
    createRendererFacade,
    createInputHelper,
};
