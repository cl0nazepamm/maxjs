import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');
const { createLayerManager } = await import(new URL('../web/js/layer_manager.js', import.meta.url).href);
const { markOwned, OWNER_MAX } = await import(new URL('../web/js/layer_ownership.js', import.meta.url).href);

function disposableMesh(name, flags) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    geometry.dispose = () => { flags.geometry = true; };
    material.dispose = () => { flags.material = true; };
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    return mesh;
}

function countedDisposable(resource, counts, key) {
    resource.dispose = () => { counts[key] = (counts[key] || 0) + 1; };
    return resource;
}

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
const renderer = {
    capabilities: {},
    info: {},
    domElement: { width: 800, height: 600 },
};
const maxNodeFlags = {};
const maxNode = disposableMesh('max-node', maxNodeFlags);
maxNode.userData.maxjsHandle = 101;
maxNode.userData.jsmod = true;
const initialMaxMaterial = maxNode.material;
const originalMaxMap = new THREE.Texture();
initialMaxMaterial.map = originalMaxMap;
const mixedMaterialMaxNode = disposableMesh('mixed-material-max-node', {});
mixedMaterialMaxNode.userData.maxjsHandle = 103;
const mixedClassicMaterial = mixedMaterialMaxNode.material;
const mixedNodeMaterial = new THREE.MeshBasicMaterial();
mixedNodeMaterial.isNodeMaterial = true;
mixedMaterialMaxNode.material = [mixedClassicMaterial, mixedNodeMaterial];
const classicOnlyMaxNode = disposableMesh('classic-only-max-node', {});
classicOnlyMaxNode.userData.maxjsHandle = 104;
const anchorSource = new THREE.Group();
anchorSource.name = 'anchor-source';
anchorSource.userData.maxjsHandle = 102;
const maxRoot = new THREE.Group();
maxRoot.name = '__max_root__';
maxRoot.add(maxNode, anchorSource, mixedMaterialMaxNode, classicOnlyMaxNode);
scene.add(maxRoot);
const nodeMap = new Map([
    [101, maxNode],
    [102, anchorSource],
    [103, mixedMaterialMaxNode],
    [104, classicOnlyMaxNode],
]);
let visibilityEvents = 0;
let lastVisibilityEvent = null;
let runtimeSceneEvents = 0;
let lastRuntimeSceneEvent = null;
const lifecycleWarnings = [];

const manager = createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap,
    maxRoot,
    debugWarn(...args) {
        lifecycleWarnings.push(args.map(String).join(' '));
    },
    onRuntimeVisibilityChanged(event) {
        visibilityEvents++;
        lastVisibilityEvent = event;
    },
    onRuntimeSceneChanged(event) {
        runtimeSceneEvents++;
        lastRuntimeSceneEvent = event;
    },
});

const removedFlags = {};
const disposedFlags = {};
const trackedFlags = {};
const groupOnlyFlags = {};
const foreignFlags = {};
const sharedMaxMaterialFlags = {};
const lifecycleCounts = {};
let removed = null;
let disposed = null;
let tracked = null;
let groupOnly = null;
let detachedOwnedTexture = null;
let foreign = null;
let sharedGeometry = null;
let sharedMaterial = null;
let sharedMaxMaterialMesh = null;
let earlyOwnedTexture = null;
let followAnchor = null;
let manualAnchor = null;
let jsmodClone = null;
let replacementCloneMaterial = null;
let followedMaxMaterial = null;
let latestMaxMaterial = null;
let params = null;
let paramEvent = null;
let layerCtx = null;

const mountResult = await manager.mount('runtime-smoke', (ctx) => {
    layerCtx = ctx;
    assert.equal(ctx.runtime.isSnapshot, false, 'live layer contexts default to non-snapshot mode');
    assert.equal(
        JSON.stringify(initialMaxMaterial.userData).includes('maxjsOwner'),
        false,
        'internal ownership stamps are not serialized as authored userData',
    );
    const copiedOwnerWarningCount = lifecycleWarnings.length;
    const promotedMaterial = new THREE.MeshBasicMaterial();
    promotedMaterial.userData = { ...initialMaxMaterial.userData };
    assert.equal(
        promotedMaterial.userData.maxjsOwner,
        undefined,
        'fresh materials do not inherit Max ownership through a userData spread',
    );
    ctx.js.own(promotedMaterial);
    assert.equal(promotedMaterial.userData.maxjsOwner, 'js', 'ctx.js.own accepts the fresh promoted material');
    assert.equal(
        lifecycleWarnings.length,
        copiedOwnerWarningCount,
        'owning a fresh material copied from Max userData does not emit a false warning',
    );
    ctx.js.own(initialMaxMaterial);
    assert.equal(initialMaxMaterial.userData.maxjsOwner, 'max', 'ctx.js.own still refuses the real Max material');
    assert.equal(
        lifecycleWarnings.length,
        copiedOwnerWarningCount + 1,
        'attempting to own the real Max material still emits the safety warning',
    );
    ctx.deform.attach(103, {
        key: 'mixed-material-deform',
        position: ({ position }) => position,
    });
    ctx.deform.attach(104, {
        key: 'classic-only-deform',
        position: ({ position }) => position,
    });
    params = ctx.params.define({
        speed: { type: 'slider', value: 1, min: 0, max: 2, step: 0.1 },
        lift: { type: 'float', value: 3.5, step: 0.1 },
        tint: { type: 'color', value: '#336699' },
    });
    ctx.params.onChange((event) => {
        paramEvent = event;
    });
    assert.equal(params.speed, 1, 'ctx.params.define creates live numeric values');
    assert.equal(params.tint, '#336699', 'ctx.params.define normalizes color values');

    removed = ctx.js.add(disposableMesh('remove-me', removedFlags));
    assert.equal(removed.parent, ctx.group, 'ctx.js.add parents runtime objects under the layer group');
    assert.equal(ctx.js.remove(removed), true, 'ctx.js.remove returns true for JS-owned Object3Ds');
    assert.equal(removed.parent, null, 'ctx.js.remove detaches the object');
    assert.equal(removedFlags.geometry, true, 'ctx.js.remove disposes owned geometry');
    assert.equal(removedFlags.material, true, 'ctx.js.remove disposes owned material');

    disposed = ctx.js.add(disposableMesh('dispose-me', disposedFlags));
    ctx.js.dispose(disposed);
    assert.equal(disposed.parent, null, 'ctx.js.dispose detaches Object3Ds before freeing resources');
    assert.equal(disposedFlags.geometry, true, 'ctx.js.dispose disposes owned geometry');
    assert.equal(disposedFlags.material, true, 'ctx.js.dispose disposes owned material');

    groupOnly = disposableMesh('group-only', groupOnlyFlags);
    ctx.group.add(groupOnly);
    assert.equal(groupOnly.userData.maxjsOwner, undefined, 'raw ctx.group.add does not need an owner stamp');

    detachedOwnedTexture = countedDisposable(new THREE.Texture(), lifecycleCounts, 'detachedOwnedTexture');
    ctx.js.own(detachedOwnedTexture);
    assert.equal(detachedOwnedTexture.userData.maxjsOwner, 'js', 'ctx.js.own stamps detached resources');

    sharedGeometry = countedDisposable(new THREE.BoxGeometry(1, 1, 1), lifecycleCounts, 'sharedGeometry');
    sharedMaterial = countedDisposable(new THREE.MeshBasicMaterial(), lifecycleCounts, 'sharedMaterial');
    ctx.group.add(
        new THREE.Mesh(sharedGeometry, sharedMaterial),
        new THREE.Mesh(sharedGeometry, sharedMaterial),
    );

    sharedMaxMaterialMesh = disposableMesh('shared-max-material', sharedMaxMaterialFlags);
    sharedMaxMaterialMesh.material = initialMaxMaterial;
    ctx.group.add(sharedMaxMaterialMesh);
    assert.equal(initialMaxMaterial.userData.maxjsOwner, 'max', 'existing Max materials are protected recursively');

    foreign = disposableMesh('foreign', foreignFlags);
    scene.add(foreign);
    assert.equal(ctx.js.remove(foreign), true, 'ctx.js.remove detaches foreign runtime objects');
    assert.equal(foreign.parent, null, 'foreign runtime object is detached');
    assert.equal(foreignFlags.geometry, undefined, 'foreign geometry is not disposed');
    assert.equal(foreignFlags.material, undefined, 'foreign material is not disposed');

    assert.equal(ctx.js.add(maxNode), null, 'ctx.js.add refuses Max-managed objects');
    assert.equal(maxNode.parent, maxRoot, 'refused Max object remains under maxRoot');

    earlyOwnedTexture = countedDisposable(new THREE.Texture(), lifecycleCounts, 'earlyOwnedTexture');
    ctx.js.own(earlyOwnedTexture);
    assert.equal(ctx.js.dispose(earlyOwnedTexture), true, 'ctx.js.dispose handles detached owned resources');
    assert.equal(lifecycleCounts.earlyOwnedTexture, 1, 'explicit dispose runs once');

    followAnchor = ctx.js.createAnchor(102);
    manualAnchor = ctx.js.createAnchor(102, { followVisibility: false });
    manualAnchor.visible = false;

    jsmodClone = ctx.js.cloneFromMax(101);
    assert.ok(jsmodClone, 'ctx.js.cloneFromMax clones a jsmod mesh');
    assert.equal(jsmodClone.material, initialMaxMaterial, 'jsmod clone initially follows the Max material');
    assert.equal(jsmodClone.userData.maxjsHandle, undefined, 'runtime clone does not retain the Max handle');
    assert.equal(jsmodClone.userData.maxjsOwner, 'js', 'runtime clone receives JS ownership');
    assert.equal(initialMaxMaterial.userData.maxjsOwner, 'max', 'jsmod clone does not poison its source material');

    replacementCloneMaterial = countedDisposable(
        new THREE.MeshBasicMaterial(),
        lifecycleCounts,
        'replacementCloneMaterial',
    );
    ctx.js.own(replacementCloneMaterial);

    tracked = ctx.js.add(disposableMesh('tracked-me', trackedFlags));
    ctx.js.track(tracked);
    assert.equal(tracked.parent, ctx.group, 'tracked Object3D starts parented for teardown test');

    const sceneEventBaseline = runtimeSceneEvents;
    assert.ok(sceneEventBaseline >= 5, 'ctx.js graph mutations notify host scene changes');

    const maxNodeAdapter = ctx.maxScene.getNode(101);
    assert.ok(maxNodeAdapter, 'ctx.maxScene exposes Max node adapters');
    maxNodeAdapter.hide();
    assert.equal(visibilityEvents, 1, 'runtime node hide notifies host visibility changes');
    assert.equal(lastVisibilityEvent?.handle, 101, 'visibility event includes node handle');
    assert.equal(lastVisibilityEvent?.visible, false, 'visibility event includes hidden state');
    assert.equal(maxNode.layers.mask, 0x80000000, 'runtime hide moves Max node to hidden layer');
    maxNodeAdapter.hide();
    assert.equal(visibilityEvents, 1, 'repeated runtime hide does not notify unchanged visibility');
    maxNodeAdapter.show();
    assert.equal(visibilityEvents, 2, 'runtime node show notifies host visibility changes');
    assert.equal(lastVisibilityEvent?.visible, true, 'visibility event includes visible state');
    assert.equal(maxNode.layers.mask, 1, 'runtime show restores visible layer');
    assert.equal(maxNodeAdapter.resetVisibility(), true, 'runtime visibility reset clears override');
    assert.equal(visibilityEvents, 3, 'runtime visibility reset notifies host visibility changes');
    assert.equal(lastVisibilityEvent?.reset, true, 'visibility reset event is flagged');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 3, 'visibility changes also notify runtime scene changes');

    assert.equal(maxNodeAdapter.transform.setPosition(2, 0, 0), true, 'runtime transform override applies');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 4, 'runtime transform override notifies host scene changes');
    assert.equal(lastRuntimeSceneEvent?.type, 'transform', 'runtime transform event is typed');
    assert.equal(maxNodeAdapter.resetTransform(), true, 'runtime transform reset clears override');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 5, 'runtime transform reset notifies host scene changes');

    const overrideTexture = new THREE.Texture();
    assert.equal(maxNodeAdapter.setMap('map', overrideTexture), true, 'runtime material map override applies');
    assert.equal(maxNode.material.map, overrideTexture, 'runtime material map override reaches the live material');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 6, 'runtime material map override notifies host scene changes');
    assert.equal(lastRuntimeSceneEvent?.type, 'materialMap', 'runtime material map event is typed');
    assert.equal(maxNodeAdapter.setMap('map', overrideTexture), false, 'unchanged runtime material map override is ignored');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 6, 'unchanged runtime material map override does not notify');
    assert.equal(maxNodeAdapter.setMap('map', null), true, 'runtime material map override clears');
    assert.equal(maxNode.material.map, originalMaxMap, 'runtime material map clear restores the Max material map immediately');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 7, 'runtime material map clear notifies host scene changes');

    assert.equal(maxNodeAdapter.overrides.setProperty('castShadow', true), true, 'runtime property override applies');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 8, 'runtime property override notifies host scene changes');
    assert.equal(lastRuntimeSceneEvent?.type, 'property', 'runtime property event is typed');
    assert.equal(maxNodeAdapter.overrides.setProperty('castShadow', true), true, 'unchanged runtime property override remains a valid override');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 8, 'unchanged runtime property override does not notify');
    assert.equal(maxNodeAdapter.overrides.clearProperty('castShadow', { restoreValue: false }), true, 'runtime property override clears');
    assert.equal(maxNode.castShadow, false, 'runtime property clear restores the requested Max property value');
    assert.equal(runtimeSceneEvents, sceneEventBaseline + 9, 'runtime property clear notifies host scene changes');

    return {};
});

assert.equal(mountResult.error, null, 'runtime layer mounted without lifecycle errors');
assert.equal(maxNode.userData.maxjsOwner, 'max', 'existing Max objects are protected recursively');
assert.equal(maxNode.geometry.userData.maxjsOwner, 'max', 'existing Max geometry is protected recursively');

followedMaxMaterial = countedDisposable(
    new THREE.MeshBasicMaterial(),
    lifecycleCounts,
    'followedMaxMaterial',
);
maxNode.material = followedMaxMaterial;
manager.update(1 / 60, 0);
assert.equal(jsmodClone.material, followedMaxMaterial, 'jsmod clone follows a source material replacement');
assert.equal(followedMaxMaterial.userData.maxjsOwner, 'max', 'followed Max material is protected before assignment');
assert.equal(
    lifecycleWarnings.some(message => message.includes('mixed-material-deform')),
    false,
    'ctx.deform accepts a mixed classic/node Multi/Sub stack without a false warning',
);
assert.ok(
    mixedNodeMaterial.positionNode,
    'ctx.deform still decorates the compatible slot in a mixed Multi/Sub stack',
);
assert.ok(
    lifecycleWarnings.some(message => message.includes('classic-only-deform') && message.includes('deformation inactive')),
    'ctx.deform still warns when a matched drawable has no compatible node-material slot',
);

jsmodClone.material = replacementCloneMaterial;
manager.update(1 / 60, 1 / 60);
assert.equal(jsmodClone.material, replacementCloneMaterial, 'external clone material assignment sticks');
assert.equal(jsmodClone.userData.maxjsFollowSourceMaterial, undefined, 'external assignment stops source material following');

latestMaxMaterial = countedDisposable(
    new THREE.MeshBasicMaterial(),
    lifecycleCounts,
    'latestMaxMaterial',
);
maxNode.material = latestMaxMaterial;
manager.update(1 / 60, 2 / 60);
assert.equal(jsmodClone.material, replacementCloneMaterial, 'stopped clone does not resume following later source materials');

anchorSource.userData.maxjsVisible = false;
anchorSource.visible = true;
manualAnchor.visible = false;
manager.update(1 / 60, 3 / 60);
assert.equal(followAnchor.visible, false, 'anchor follows maxjsVisible instead of raw Object3D.visible');
assert.equal(manualAnchor.visible, false, 'followVisibility:false preserves manual hidden state');

anchorSource.userData.maxjsVisible = true;
manualAnchor.visible = true;
manager.update(1 / 60, 4 / 60);
assert.equal(followAnchor.visible, true, 'anchor becomes visible with its source');
assert.equal(manualAnchor.visible, true, 'followVisibility:false preserves manual visible state');

nodeMap.delete(102);
manualAnchor.visible = true;
manager.update(1 / 60, 5 / 60);
assert.equal(followAnchor.visible, false, 'following anchor hides when its source disappears');
assert.equal(manualAnchor.visible, true, 'non-following anchor visibility survives a missing source');
nodeMap.set(102, anchorSource);

const speedParam = manager.setParameter('runtime-smoke', 'speed', '1.7');
assert.equal(speedParam.value, 1.7, 'manager.setParameter updates slider values from UI strings');
assert.equal(params.speed, 1.7, 'ctx.params live proxy reflects manager updates');
assert.equal(paramEvent?.name, 'speed', 'ctx.params.onChange receives manager updates');
assert.equal(paramEvent?.value, 1.7, 'ctx.params.onChange receives coerced values');

const tintParam = manager.setParameter('runtime-smoke', 'tint', [1, 0.5, 0]);
assert.equal(tintParam.value, '#ff8000', 'manager.setParameter normalizes RGB array colors');
assert.equal(params.tint, '#ff8000', 'ctx.params live proxy reflects color updates');

const layerSnapshot = manager.getLayerSnapshot('runtime-smoke');
assert.equal(layerSnapshot.parameters.length, 3, 'layer snapshots include parameter metadata');
assert.equal(layerSnapshot.parameters.find(p => p.name === 'speed')?.value, 1.7, 'layer snapshots include current parameter values');

const runtimeSnapshot = manager.serializeSnapshot();
assert.equal(runtimeSnapshot.layers[0].parameters.find(p => p.name === 'tint')?.value, '#ff8000', 'runtime snapshots include parameter values');

let restartRestoredParams = null;
const restartRestoredResult = await manager.mount('restart-restored-params', (ctx) => {
    restartRestoredParams = ctx.params.define({
        speed: { type: 'slider', value: 0.25, min: 0, max: 4, step: 0.05 },
        numericLabel: { type: 'string', value: 'default' },
    });
    return {};
}, {
    source: 'inline',
    entry: 'scripts/restart-restored-params.js',
    paramValues: {
        speed: 2.75,
        numericLabel: '007',
    },
});
assert.equal(restartRestoredResult.error, null, 'restart-restored parameter layer mounts');
assert.equal(restartRestoredParams.speed, 2.75, 'restart-restored numeric value reaches the layer factory');
assert.equal(restartRestoredParams.numericLabel, '007', 'restart-restored string value reaches the layer factory');
const restartRestoredSnapshot = manager.serializeSnapshot();
const restartRestoredLayer = restartRestoredSnapshot.layers.find(layer => layer.id === 'restart-restored-params');
assert.equal(
    restartRestoredLayer?.parameters.find(param => param.name === 'speed')?.value,
    2.75,
    'runtimeScene carries restart-restored numeric parameter values',
);
assert.equal(
    restartRestoredLayer?.parameters.find(param => param.name === 'numericLabel')?.value,
    '007',
    'runtimeScene carries restart-restored string parameter values',
);
manager.remove('restart-restored-params');

const remountResult = await manager.mount('runtime-smoke', (ctx) => {
    params = ctx.params.define({
        speed: { type: 'slider', value: 0.2, min: 0, max: 2, step: 0.1 },
    });
    return {};
});
assert.equal(remountResult.error, null, 'runtime layer remounts without lifecycle errors');
assert.equal(params.speed, 1.7, 'hot reload preserves stored parameter values by layer id');
assert.equal(groupOnly.parent, null, 'raw ctx.group.add object is detached on teardown');
assert.equal(groupOnlyFlags.geometry, true, 'raw ctx.group.add geometry is force-disposed');
assert.equal(groupOnlyFlags.material, true, 'raw ctx.group.add material is force-disposed');
assert.equal(lifecycleCounts.detachedOwnedTexture, 1, 'detached ctx.js.own resource is disposed once');
assert.equal(lifecycleCounts.earlyOwnedTexture, 1, 'explicitly disposed tracked resource is not disposed twice');
assert.equal(lifecycleCounts.sharedGeometry, 1, 'shared geometry is disposed once across the layer subtree');
assert.equal(lifecycleCounts.sharedMaterial, 1, 'shared material is disposed once across the layer subtree');
assert.equal(sharedMaxMaterialFlags.geometry, true, 'runtime geometry sharing a Max material is disposed');
assert.equal(maxNodeFlags.geometry, undefined, 'Max geometry is not disposed by layer teardown');
assert.equal(maxNodeFlags.material, undefined, 'original Max material is not disposed by layer teardown');
assert.equal(lifecycleCounts.followedMaxMaterial, undefined, 'followed Max material is not disposed by layer teardown');
assert.equal(lifecycleCounts.latestMaxMaterial, undefined, 'latest Max material is not disposed by layer teardown');
assert.equal(lifecycleCounts.replacementCloneMaterial, 1, 'tracked clone replacement material is disposed exactly once');
assert.ok(
    lifecycleWarnings.some(message => message.includes('foreign object without disposing')),
    'foreign detach emits a lifecycle warning',
);
assert.ok(
    lifecycleWarnings.some(message => message.includes('cannot add a Max-managed object')),
    'Max-object add refusal emits a lifecycle warning',
);

assert.equal(manager.remove('runtime-smoke'), true, 'layer remove succeeds');
assert.equal(tracked.parent, null, 'layer teardown detaches tracked Object3Ds');
assert.equal(trackedFlags.geometry, true, 'layer teardown disposes tracked geometry');
assert.equal(trackedFlags.material, true, 'layer teardown disposes tracked material');

const teardownBaseMapA = countedDisposable(
    new THREE.Texture(),
    lifecycleCounts,
    'teardownBaseMapA',
);
latestMaxMaterial.map = teardownBaseMapA;
let teardownOverrideTexture = null;
const teardownMount = await manager.mount('override-teardown', (ctx) => {
    teardownOverrideTexture = new THREE.Texture();
    teardownOverrideTexture.dispose = () => {
        assert.notEqual(
            maxNode.material.map,
            teardownOverrideTexture,
            'live Max material releases the runtime map before texture disposal',
        );
        lifecycleCounts.teardownOverrideTexture = (lifecycleCounts.teardownOverrideTexture || 0) + 1;
    };
    ctx.js.own(teardownOverrideTexture);
    const node = ctx.maxScene.getNode(101);
    assert.equal(
        node.setMap('map', teardownOverrideTexture),
        true,
        'teardown fixture applies an owned runtime map override',
    );
    assert.equal(
        node.overrides.setProperty('castShadow', true),
        true,
        'teardown fixture applies a runtime property override',
    );
    return {};
});
assert.equal(teardownMount.error, null, 'teardown override layer mounts');
assert.equal(maxNode.material.map, teardownOverrideTexture, 'teardown fixture leaves the runtime map attached');
assert.equal(maxNode.castShadow, true, 'teardown fixture leaves the runtime property applied');

const teardownBaseMapB = countedDisposable(
    new THREE.Texture(),
    lifecycleCounts,
    'teardownBaseMapB',
);
const teardownReplacementMaterial = new THREE.MeshBasicMaterial({ map: teardownBaseMapB });
maxNode.material = teardownReplacementMaterial;
manager.applyMaterialOverrides(101, maxNode);
assert.equal(maxNode.material.map, teardownOverrideTexture, 'runtime map survives a Max material replacement');
markOwned(maxNode, OWNER_MAX);
assert.equal(
    teardownOverrideTexture.userData.maxjsOwner,
    'js',
    'Max resource restamping does not steal a layer-owned override texture',
);

assert.equal(manager.remove('override-teardown'), true, 'teardown override layer removes');
assert.equal(maxNode.material.map, teardownBaseMapB, 'layer removal restores the newest live Max map before disposal');
assert.equal(maxNode.castShadow, false, 'layer removal restores the live Max property baseline');
assert.equal(lifecycleCounts.teardownOverrideTexture, 1, 'layer removal disposes its detached override texture once');
assert.equal(lifecycleCounts.teardownBaseMapA, undefined, 'layer removal does not dispose the original Max map');
assert.equal(lifecycleCounts.teardownBaseMapB, undefined, 'layer removal does not dispose the replacement Max map');

const staleInitStarted = deferred();
const staleInitResume = deferred();
const asyncReasons = [];
const unsubscribeAsyncReasons = manager.subscribe(reason => asyncReasons.push(reason));
let staleCtx = null;
let staleAdapter = null;
let staleOwnedTexture = null;
let staleRawMesh = null;
const staleRawFlags = {};
let stalePropertyResult = null;
let staleCameraResult = null;
let staleServiceResult = undefined;
let staleBusCalls = 0;
let replacementBusCalls = 0;
let staleDisposeRuns = 0;

const staleMount = manager.mount('async-replace', () => ({
    async init(ctx) {
        staleCtx = ctx;
        staleAdapter = ctx.maxScene.getNode(101);
        staleInitStarted.resolve();
        await staleInitResume.promise;

        staleOwnedTexture = countedDisposable(
            new THREE.Texture(),
            lifecycleCounts,
            'staleOwnedTexture',
        );
        ctx.js.own(staleOwnedTexture);
        staleRawMesh = disposableMesh('stale-raw-mesh', staleRawFlags);
        ctx.group.add(staleRawMesh);
        stalePropertyResult = staleAdapter.overrides.setProperty('castShadow', false);
        staleCameraResult = ctx.camera.takeOver();
        ctx.bus.on('async-stale-probe', () => { staleBusCalls++; });
        staleServiceResult = ctx.services.provide('async-replacement-service', 'stale');
        ctx.params.define({ lateOnly: 1 });
    },
    dispose() {
        staleDisposeRuns++;
    },
}));

await staleInitStarted.promise;
let replacementCtx = null;
const replacementMount = await manager.mount('async-replace', (ctx) => {
    replacementCtx = ctx;
    assert.equal(
        ctx.maxScene.getNode(101).overrides.setProperty('castShadow', true),
        true,
        'replacement layer owns the current property override',
    );
    assert.equal(ctx.camera.takeOver(), true, 'replacement layer claims the camera');
    ctx.bus.on('async-stale-probe', () => { replacementBusCalls++; });
    ctx.services.provide('async-replacement-service', 'replacement');
    return {};
});
assert.equal(replacementMount.error, null, 'same-id replacement mounts while the old init is pending');

staleInitResume.resolve();
const staleResult = await staleMount;
assert.equal(staleResult.error, 'Layer replaced during load', 'stale async init reports replacement');
assert.equal(staleDisposeRuns, 1, 'pending layer dispose hook runs exactly once');
assert.equal(lifecycleCounts.staleOwnedTexture, 1, 'late ctx.js.own resource is disposed immediately');
assert.equal(staleRawMesh.parent, null, 'late raw group child is detached by stale-instance cleanup');
assert.equal(staleRawFlags.geometry, true, 'late raw group geometry is disposed');
assert.equal(staleRawFlags.material, true, 'late raw group material is disposed');
assert.equal(stalePropertyResult, false, 'stale node adapter cannot overwrite replacement state');
assert.equal(staleCameraResult, false, 'stale camera facade cannot steal the replacement claim');
assert.equal(staleServiceResult, null, 'stale service registration is ignored');
assert.equal(
    replacementCtx.services.get('async-replacement-service'),
    'replacement',
    'stale cleanup preserves the replacement service record',
);
assert.equal(maxNode.castShadow, true, 'stale property work does not clobber the replacement override');
assert.equal(manager.isCameraOverridden, true, 'stale cleanup preserves the replacement camera claim');
assert.equal(
    manager.getLayerSnapshot('async-replace')?.parameters.some(param => param.name === 'lateOnly'),
    false,
    'stale parameter definitions do not enter the replacement layer',
);
manager.getBus().emit('async-stale-probe');
assert.equal(staleBusCalls, 0, 'stale bus subscriptions are ignored');
assert.equal(replacementBusCalls, 1, 'replacement bus subscription remains active');
assert.equal(
    asyncReasons.filter(reason => reason === 'mounted').length,
    1,
    'stale async init does not emit a second mounted event',
);
assert.equal(manager.remove('async-replace'), true, 'replacement layer removes normally');
assert.equal(maxNode.castShadow, false, 'replacement removal restores its property baseline');
assert.equal(manager.isCameraOverridden, false, 'replacement removal releases its camera claim');
assert.equal(staleCtx.group.children.length, 0, 'stale layer group is empty after final cleanup');
unsubscribeAsyncReasons();

const sceneReady = deferred();
const readyScene = new THREE.Scene();
let replacedHookRuns = 0;
let currentHookRuns = 0;
let snapshotRuntimeFlag = null;
const readyManager = createLayerManager({
    scene: readyScene,
    camera: new THREE.PerspectiveCamera(50, 1, 0.1, 1000),
    renderer,
    THREE,
    nodeMap: new Map(),
    whenSceneReady: () => sceneReady.promise,
    isSnapshot: true,
});

const replacedMount = readyManager.mount('ready-gated', () => {
    replacedHookRuns++;
    return {};
});
const currentMount = readyManager.mount('ready-gated', (ctx) => {
    currentHookRuns++;
    snapshotRuntimeFlag = ctx.runtime.isSnapshot;
    return {};
});
await Promise.resolve();
assert.equal(replacedHookRuns, 0, 'scene readiness prevents replaced hooks from running early');
assert.equal(currentHookRuns, 0, 'scene readiness prevents current hooks from running early');

sceneReady.resolve();
const [replacedResult, currentResult] = await Promise.all([replacedMount, currentMount]);
assert.equal(replacedResult.error, 'Layer replaced during load', 'readiness gate re-checks layer identity after await');
assert.equal(replacedHookRuns, 0, 'replaced layer hooks never run after readiness resolves');
assert.equal(currentResult.error, null, 'current layer mounts after scene readiness resolves');
assert.equal(currentHookRuns, 1, 'current layer hooks run exactly once after readiness resolves');
assert.equal(snapshotRuntimeFlag, true, 'snapshot layer contexts expose ctx.runtime.isSnapshot');
readyManager.remove('ready-gated');

function createTransformFixture(parentX = 0, localX = 10) {
    const fixtureScene = new THREE.Scene();
    const fixtureMaxRoot = new THREE.Group();
    const fixtureParent = new THREE.Group();
    const fixtureNode = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial(),
    );
    fixtureParent.matrixAutoUpdate = false;
    fixtureParent.matrix.makeTranslation(parentX, 0, 0);
    fixtureNode.matrixAutoUpdate = false;
    fixtureNode.matrix.makeTranslation(localX, 0, 0);
    fixtureNode.userData.maxjsHandle = 501;
    fixtureParent.add(fixtureNode);
    fixtureMaxRoot.add(fixtureParent);
    fixtureScene.add(fixtureMaxRoot);
    fixtureScene.updateMatrixWorld(true);
    const fixtureManager = createLayerManager({
        scene: fixtureScene,
        camera: new THREE.PerspectiveCamera(50, 1, 0.1, 1000),
        renderer,
        THREE,
        nodeMap: new Map([[501, fixtureNode]]),
        maxRoot: fixtureMaxRoot,
    });
    return { manager: fixtureManager, node: fixtureNode, scene: fixtureScene };
}

const additiveSource = createTransformFixture();
await additiveSource.manager.mount('transform-owner', (ctx) => {
    assert.equal(
        ctx.maxScene.getNode(501).transform.offsetPosition(2, 0, 0),
        true,
        'additive transform fixture applies an offset',
    );
    return {};
});
assert.equal(additiveSource.node.matrix.elements[12], 12);
const additiveRecord = additiveSource.manager.serializeSnapshot().transformOverrides[0];
assert.equal(additiveRecord.version, 2, 'transform snapshots use mode-parameter encoding');
assert.equal(additiveRecord.mode, 'additive');
assert.equal(additiveRecord.position[0], 2, 'additive snapshots store the offset, not the final local position');

const additiveRestored = createTransformFixture();
assert.equal(additiveRestored.manager.restoreTransformOverrides([additiveRecord]), 1);
assert.equal(additiveRestored.node.matrix.elements[12], 12,
    'additive transform restore does not apply the exported result twice');

const worldSource = createTransformFixture(5, 10);
await worldSource.manager.mount('world-transform-owner', (ctx) => {
    assert.equal(
        ctx.maxScene.getNode(501).transform.setWorldPosition(20, 0, 0),
        true,
        'world transform fixture applies a world-space position',
    );
    return {};
});
const worldRecord = worldSource.manager.serializeSnapshot().transformOverrides[0];
assert.equal(worldRecord.mode, 'world');
assert.equal(worldRecord.position[0], 20, 'world snapshots retain world-space parameters');
const worldRestored = createTransformFixture(5, 10);
assert.equal(worldRestored.manager.restoreTransformOverrides([worldRecord]), 1);
worldRestored.scene.updateMatrixWorld(true);
assert.equal(worldRestored.node.matrixWorld.elements[12], 20,
    'world transform restore respects the fresh parent transform');

const legacyRestored = createTransformFixture();
const { version: _ignoredVersion, ...legacyRecord } = additiveRecord;
legacyRecord.position = [12, 0, 0];
assert.equal(legacyRestored.manager.restoreTransformOverrides([legacyRecord]), 1);
assert.equal(legacyRestored.node.matrix.elements[12], 12,
    'legacy final-local payloads replay as absolute instead of double-applying');

console.log('runtime layer lifecycle smoke ok');
