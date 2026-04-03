// layer_manager.js — dual-world JS runtime for MaxJS inline modules.
// Max-owned scene content stays read-only behind adapters.
// JS-authored content lives under its own roots and owns its own resources.

const MAX_CONSECUTIVE_ERRORS = 60;
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

function freezePlainObject(obj) {
    return Object.freeze(obj);
}

function createCameraAdapter(camera, THREE, ownForJs) {
    return freezePlainObject({
        getState() {
            return {
                type: camera.type,
                fov: camera.fov,
                near: camera.near,
                far: camera.far,
                up: camera.up.toArray(),
                matrix: camera.matrix.toArray(),
                matrixWorld: camera.matrixWorld.toArray(),
                projectionMatrix: camera.projectionMatrix.toArray(),
            };
        },
        clone(options = {}) {
            const clone = camera.clone();
            clone.matrix.copy(camera.matrix);
            clone.matrixWorld.copy(camera.matrixWorld);
            clone.projectionMatrix.copy(camera.projectionMatrix);
            clone.matrixAutoUpdate = camera.matrixAutoUpdate;
            if (options.name) clone.name = options.name;
            return ownForJs(clone, options.overlay ? OWNER_OVERLAY : OWNER_JS);
        },
    });
}

function createMaxNodeAdapter({ handle, getObject, THREE, createAnchor }) {
    return freezePlainObject({
        handle,
        get exists() { return !!getObject(); },
        get name() { return getObject()?.name ?? ''; },
        get type() { return getObject()?.type ?? null; },
        get visible() { return !!getObject()?.visible; },
        get isMesh() { return !!getObject()?.isMesh; },
        get materialType() {
            const obj = getObject();
            const mat = Array.isArray(obj?.material) ? obj.material[0] : obj?.material;
            return mat?.type ?? null;
        },
        getWorldMatrix() {
            const obj = getObject();
            return obj ? obj.matrixWorld.clone() : null;
        },
        getWorldPosition() {
            const obj = getObject();
            if (!obj) return null;
            const position = new THREE.Vector3();
            obj.getWorldPosition(position);
            return position;
        },
        getWorldQuaternion() {
            const obj = getObject();
            if (!obj) return null;
            const quaternion = new THREE.Quaternion();
            obj.getWorldQuaternion(quaternion);
            return quaternion;
        },
        getWorldScale() {
            const obj = getObject();
            if (!obj) return null;
            const scale = new THREE.Vector3();
            obj.getWorldScale(scale);
            return scale;
        },
        getBoundingBox() {
            const obj = getObject();
            return obj ? new THREE.Box3().setFromObject(obj) : null;
        },
        snapshot() {
            const obj = getObject();
            if (!obj) return null;
            const position = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            obj.matrixWorld.decompose(position, quaternion, scale);
            return {
                handle,
                name: obj.name,
                type: obj.type,
                visible: !!obj.visible,
                matrixWorld: obj.matrixWorld.toArray(),
                position: position.toArray(),
                quaternion: quaternion.toArray(),
                scale: scale.toArray(),
            };
        },
        createAnchor(options = {}) {
            return createAnchor(handle, options);
        },
    });
}

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

function createMaxSceneFacade({ scene, nodeMap, getAdapter, createAnchor }) {
    return freezePlainObject({
        get size() { return nodeMap.size; },
        get background() { return scene.background?.clone?.() ?? scene.background ?? null; },
        get environment() { return scene.environment?.clone?.() ?? null; },
        get fog() { return scene.fog?.clone?.() ?? null; },
        has(handle) { return nodeMap.has(handle); },
        getNode(handle) { return nodeMap.has(handle) ? getAdapter(handle) : null; },
        listHandles() { return Array.from(nodeMap.keys()); },
        listNodes() { return Array.from(nodeMap.keys(), handle => getAdapter(handle)); },
        findByName(name, options = {}) {
            const query = String(name ?? '').toLowerCase();
            const exact = options.exact === true;
            const matches = [];
            for (const [handle, obj] of nodeMap) {
                const current = String(obj?.name ?? '').toLowerCase();
                if (!query) continue;
                if ((exact && current === query) || (!exact && current.includes(query))) {
                    matches.push(getAdapter(handle));
                }
            }
            return matches;
        },
        createAnchor(handle, options = {}) {
            return createAnchor(handle, options);
        },
    });
}

function createRendererFacade(renderer) {
    return freezePlainObject({
        get capabilities() { return renderer.capabilities; },
        get info() { return renderer.info; },
        get width() { return renderer.domElement?.width ?? 0; },
        get height() { return renderer.domElement?.height ?? 0; },
    });
}

const SANDBOX_PRELUDE = [
    '"use strict";',
    'const window = undefined;',
    'const document = undefined;',
    'const globalThis = undefined;',
    'const self = undefined;',
    'const chrome = undefined;',
    'const fetch = undefined;',
    'const XMLHttpRequest = undefined;',
    'const WebSocket = undefined;',
    'const localStorage = undefined;',
    'const sessionStorage = undefined;',
].join('\n');

function buildInlineFactory(code) {
    return new Function('ctx', 'THREE', `${SANDBOX_PRELUDE}\n${code}`);
}

export function createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap,
    maxRoot = null,
    jsRoot = null,
    overlayRoot = null,
}) {
    const layers = new Map();
    let projectControl = null;

    const jsWorldRoot = markOwned(jsRoot || new THREE.Group(), OWNER_JS);
    jsWorldRoot.name ||= '__maxjs_js_root__';
    if (!jsWorldRoot.parent) scene.add(jsWorldRoot);

    const overlayWorldRoot = markOwned(overlayRoot || new THREE.Group(), OWNER_OVERLAY);
    overlayWorldRoot.name ||= '__maxjs_overlay_root__';
    if (!overlayWorldRoot.parent) scene.add(overlayWorldRoot);

    if (maxRoot) setOwner(maxRoot, OWNER_MAX);

    const isWebGPU = !!(renderer?.backend?.parameters?.forceWebGL === undefined
        && renderer?.backend?.constructor?.name !== 'WebGLBackend');

    let dt = 0;
    let elapsed = 0;

    function ownForLayer(resource, owner = OWNER_JS) {
        return markOwned(resource, owner);
    }

    function cloneMaterialForLayer(material, owner) {
        if (!material) return material;
        if (Array.isArray(material)) return material.map(item => cloneMaterialForLayer(item, owner));
        const clone = material.clone();
        for (const key of MATERIAL_MAP_KEYS) {
            if (material[key]?.clone) clone[key] = markOwned(material[key].clone(), owner);
        }
        return markOwned(clone, owner);
    }

    function cloneMaxNode(handle, options = {}) {
        const source = nodeMap.get(handle);
        if (!source?.isObject3D) return null;
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        const clone = source.clone(false);
        clone.name = options.name || `${source.name || 'node'}_clone`;
        clone.matrixAutoUpdate = false;
        clone.matrix.copy(source.matrixWorld);
        clone.matrixWorld.copy(source.matrixWorld);
        clone.matrixWorldNeedsUpdate = true;
        clone.visible = source.visible;
        if (source.geometry?.clone) clone.geometry = markOwned(source.geometry.clone(), owner);
        if (source.material) clone.material = cloneMaterialForLayer(source.material, owner);
        return markOwned(clone, owner);
    }

    function createAnchorForLayer(layer, handle, options = {}) {
        const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
        const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
        const anchor = markOwned(new THREE.Group(), owner);
        anchor.name = options.name || `anchor_${handle}`;
        anchor.matrixAutoUpdate = false;
        anchor.userData.maxjsAnchorHandle = handle;
        anchor.userData.maxjsFollowVisibility = options.followVisibility !== false;
        anchor.userData.maxjsCopyWorldMatrix = options.copyWorldMatrix !== false;
        layer.anchors.push(anchor);
        parent.add(anchor);
        return anchor;
    }

    function getLayerNodeAdapter(layer, handle) {
        if (!nodeMap.has(handle)) return null;
        return createMaxNodeAdapter({
            handle,
            getObject: () => nodeMap.get(handle) ?? null,
            THREE,
            createAnchor: (nextHandle, options) => createAnchorForLayer(layer, nextHandle, options),
        });
    }

    function buildContext(layer) {
        const rendererFacade = createRendererFacade(renderer);
        const cameraFacade = createCameraAdapter(camera, THREE, ownForLayer);
        const nodeMapFacade = createNodeMapFacade(nodeMap, handle => getLayerNodeAdapter(layer, handle));
        const maxSceneFacade = createMaxSceneFacade({
            scene,
            nodeMap,
            getAdapter: handle => getLayerNodeAdapter(layer, handle),
            createAnchor: (handle, options = {}) => createAnchorForLayer(layer, handle, options),
        });

        const runtimeFacade = freezePlainObject({
            get id() { return layer.id; },
            get name() { return layer.name; },
            get isWebGPU() { return isWebGPU; },
            get dt() { return dt; },
            get elapsed() { return elapsed; },
            log: (...args) => console.log(`[Layer:${layer.id}]`, ...args),
            warn: (...args) => console.warn(`[Layer:${layer.id}]`, ...args),
            error: (...args) => console.error(`[Layer:${layer.id}]`, ...args),
        });

        const projectFacade = freezePlainObject({
            setDirectory(dir, options = {}) {
                if (!projectControl?.setProjectDirectory) {
                    throw new Error('Project runtime is not bound');
                }
                return projectControl.setProjectDirectory(dir, options);
            },
            reload(force = true) {
                if (!projectControl?.reload) {
                    throw new Error('Project runtime is not bound');
                }
                return projectControl.reload(force);
            },
            getState() {
                return projectControl?.getState?.() ?? null;
            },
        });

        const jsFacade = freezePlainObject({
            root: layer.group,
            overlayRoot: layer.overlayGroup,
            own(resource, options = {}) {
                return ownForLayer(resource, options.overlay ? OWNER_OVERLAY : OWNER_JS);
            },
            add(resource, options = {}) {
                if (!resource?.isObject3D) return null;
                const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
                const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
                markOwned(resource, owner);
                parent.add(resource);
                return resource;
            },
            remove(resource) {
                if (!resource?.isObject3D || !isOwnedByJs(resource)) return false;
                resource.parent?.remove(resource);
                disposeOwnedResource(resource);
                return true;
            },
            createGroup(name = '', options = {}) {
                const owner = options.overlay ? OWNER_OVERLAY : OWNER_JS;
                const group = markOwned(new THREE.Group(), owner);
                if (name) group.name = name;
                const parent = owner === OWNER_OVERLAY ? layer.overlayGroup : layer.group;
                parent.add(group);
                return group;
            },
            createAnchor(handle, options = {}) {
                return createAnchorForLayer(layer, handle, options);
            },
            cloneFromMax(handle, options = {}) {
                const clone = cloneMaxNode(handle, options);
                if (!clone) return null;
                const parent = options.overlay ? layer.overlayGroup : layer.group;
                parent.add(clone);
                return clone;
            },
            track(resource, options = {}) {
                if (!resource) return resource;
                markOwned(resource, options.overlay ? OWNER_OVERLAY : OWNER_JS);
                layer.tracked.add(resource);
                return resource;
            },
            dispose(resource) {
                disposeOwnedResource(resource);
            },
        });

        return {
            layer: freezePlainObject({ id: layer.id, name: layer.name }),
            group: layer.group,
            overlayGroup: layer.overlayGroup,
            js: jsFacade,
            scene: maxSceneFacade,
            maxScene: maxSceneFacade,
            nodeMap: nodeMapFacade,
            camera: cameraFacade,
            renderer: rendererFacade,
            THREE,
            clock: freezePlainObject({
                get dt() { return dt; },
                get elapsed() { return elapsed; },
            }),
            runtime: runtimeFacade,
            project: projectFacade,
            track(resource, options = {}) {
                return jsFacade.track(resource, options);
            },
        };
    }

    function syncAnchors(layer) {
        for (const anchor of layer.anchors) {
            const source = nodeMap.get(anchor.userData.maxjsAnchorHandle);
            if (!source) {
                anchor.visible = false;
                continue;
            }
            anchor.visible = anchor.userData.maxjsFollowVisibility ? !!source.visible : true;
            if (anchor.userData.maxjsCopyWorldMatrix) {
                source.updateWorldMatrix(true, false);
                anchor.matrix.copy(source.matrixWorld);
                anchor.matrixWorldNeedsUpdate = true;
            }
        }
    }

    function createLayerState(id, options = {}) {
        if (layers.has(id)) remove(id);

        const group = markOwned(new THREE.Group(), OWNER_JS);
        group.name = `__inline_${id}__`;
        group.matrixAutoUpdate = false;
        group.matrix.identity();

        const overlayGroup = markOwned(new THREE.Group(), OWNER_OVERLAY);
        overlayGroup.name = `__inline_overlay_${id}__`;
        overlayGroup.matrixAutoUpdate = false;
        overlayGroup.matrix.identity();

        const layer = {
            id,
            name: options.name || id,
            code: options.code || '',
            group,
            overlayGroup,
            source: options.source || 'inline',
            entry: options.entry || '',
            hooks: null,
            active: true,
            loading: false,
            error: null,
            errorCount: 0,
            tracked: new Set(),
            anchors: [],
            ctx: null,
        };

        jsWorldRoot.add(group);
        overlayWorldRoot.add(overlayGroup);
        layer.ctx = buildContext(layer);
        layers.set(id, layer);
        return layer;
    }

    async function mount(id, createHooks, options = {}) {
        const layer = createLayerState(id, options);
        const mountToken = Symbol(id);
        layer.loading = true;
        layer.mountToken = mountToken;
        try {
            const hooks = await createHooks(layer.ctx, THREE);
            if (layers.get(id) !== layer || layer.mountToken !== mountToken) {
                return { id, error: 'Layer replaced during load' };
            }
            layer.hooks = hooks || {};
            if (typeof layer.hooks.init === 'function') {
                await layer.hooks.init(layer.ctx);
            }
        } catch (err) {
            layer.error = err?.message || String(err);
            layer.active = false;
            console.error(`[LayerManager] Layer "${id}" init error:`, err);
        } finally {
            if (layers.get(id) === layer) layer.loading = false;
        }
        return { id, error: layer.error };
    }

    function inject(id, code, name) {
        return mount(id, async (ctx, runtimeThree) => {
            const factory = buildInlineFactory(code);
            return factory(ctx, runtimeThree);
        }, { name: name || id, code, source: 'inline' });
    }

    function remove(id) {
        const layer = layers.get(id);
        if (!layer) return false;

        if (layer.hooks && typeof layer.hooks.dispose === 'function') {
            try {
                layer.hooks.dispose(layer.ctx);
            } catch (err) {
                console.warn(`[LayerManager] Layer "${id}" dispose error:`, err);
            }
        }

        for (const resource of layer.tracked) {
            try {
                disposeOwnedResource(resource);
            } catch (err) {
                console.warn(`[LayerManager] Layer "${id}" tracked dispose error:`, err);
            }
        }
        layer.tracked.clear();
        layer.anchors.length = 0;

        jsWorldRoot.remove(layer.group);
        overlayWorldRoot.remove(layer.overlayGroup);
        disposeOwnedResource(layer.group);
        disposeOwnedResource(layer.overlayGroup);

        layers.delete(id);
        return true;
    }

    function clear() {
        for (const id of [...layers.keys()]) remove(id);
    }

    function list() {
        return [...layers.values()].map(layer => ({
            id: layer.id,
            name: layer.name,
            active: layer.active,
            error: layer.error,
        }));
    }

    function update(frameDt, frameElapsed) {
        dt = frameDt;
        elapsed = frameElapsed;

        for (const layer of layers.values()) {
            if (layer.loading || !layer.active || !layer.hooks || typeof layer.hooks.update !== 'function') {
                syncAnchors(layer);
                continue;
            }
            try {
                syncAnchors(layer);
                layer.hooks.update(layer.ctx, dt, elapsed);
                layer.errorCount = 0;
            } catch (err) {
                layer.errorCount++;
                if (layer.errorCount >= MAX_CONSECUTIVE_ERRORS) {
                    layer.active = false;
                    layer.error = `Auto-deactivated after ${MAX_CONSECUTIVE_ERRORS} errors: ${err.message}`;
                    console.error(`[LayerManager] Layer "${layer.id}" deactivated:`, err);
                }
            }
        }
    }

    function getLayerCode(id) {
        return layers.get(id)?.code ?? null;
    }

    function serialize() {
        return [...layers.values()].map(layer => ({
            id: layer.id,
            name: layer.name,
            code: layer.code,
            enabled: layer.active,
        }));
    }

    return {
        mount,
        bindProjectRuntime(control) {
            projectControl = control;
        },
        inject,
        remove,
        clear,
        list,
        update,
        getLayerCode,
        serialize,
        roots: freezePlainObject({
            maxRoot,
            jsRoot: jsWorldRoot,
            overlayRoot: overlayWorldRoot,
        }),
    };
}
