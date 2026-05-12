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

function createMaxSceneFacade({ scene, nodeMap, lightHandleMap, getAdapter, createAnchor, THREE }) {
    return freezePlainObject({
        get size() { return nodeMap.size; },
        get background() { return scene.background?.clone?.() ?? scene.background ?? null; },
        get environment() { return scene.environment ?? null; },
        get fog() { return scene.fog?.clone?.() ?? null; },
        has(handle) { return nodeMap.has(handle); },
        getNode(handle) { return nodeMap.has(handle) ? getAdapter(handle) : null; },
        listHandles() { return Array.from(nodeMap.keys()); },
        listNodes() { return Array.from(nodeMap.keys(), handle => getAdapter(handle)); },
        /** Meshes whose Max stack has three.js Deform (bridge sets adapter.jsmod). Safe to poll every frame — nodeMap grows as sync arrives. */
        listJsmodNodes() {
            const out = [];
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                if (adapter?.isMesh && adapter.jsmod) out.push(adapter);
            }
            return out;
        },
        findByName(name, options = {}) {
            const query = String(name ?? '').toLowerCase();
            const exact = options.exact === true;
            const matches = [];
            // Search meshes in nodeMap
            for (const handle of nodeMap.keys()) {
                const adapter = getAdapter(handle);
                const current = String(adapter?.name ?? '').toLowerCase();
                if (!query) continue;
                if ((exact && current === query) || (!exact && current.includes(query))) {
                    matches.push(adapter);
                }
            }
            // Search lights in lightHandleMap
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
            return rc.intersectObjects(targets, true).map((hit) => {
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
    createMaxSceneFacade,
    createRendererFacade,
    createInputHelper,
};
