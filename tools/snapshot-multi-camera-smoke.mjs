import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');
const { createLayerManager } = await import(
    new URL('../web/js/layer_manager.js', import.meta.url).href
);

const nativeMainSource = readFileSync(
    new URL('../src/maxjs_main.cpp', import.meta.url),
    'utf8',
);
const nativeSyncSource = readFileSync(
    new URL('../src/maxjs_panel_sync.inl', import.meta.url),
    'utf8',
);
const nativeSnapshotSource = readFileSync(
    new URL('../src/maxjs_panel_snapshot_export.inl', import.meta.url),
    'utf8',
);
const snapshotExportUiSource = readFileSync(
    new URL('../web/js/editor/snapshot_export.js', import.meta.url),
    'utf8',
);
const snapshotBootSource = readFileSync(
    new URL('../web/js/snapshot_boot.js', import.meta.url),
    'utf8',
);

assert.match(nativeMainSource, /bool includeSceneCameras = true;/,
    'native snapshot options include scene cameras by default');
assert.match(nativeSyncSource, /ExtractJsonBool\(msg, L"includeSceneCameras", options\.includeSceneCameras\)/,
    'the WebView export checkbox reaches native snapshot options');
assert.match(nativeSnapshotSource,
    /WriteSceneCamerasJson\(ss, true, options\.includeSceneCameras, t\)/,
    'snapshot export requests complete camera records at the snapshot frame');
assert.match(nativeSyncSource, /GetSceneCameraData\(node, sampleTime, cameraData\)/,
    'each exported scene camera carries its own evaluated camera state');
assert.match(snapshotExportUiSource,
    /snapshot-includeSceneCameras[\s\S]*?<span>Scene Cameras<\/span>/,
    'the snapshot panel exposes an animation-independent Scene Cameras checkbox');
assert.match(snapshotBootSource, /function applyPortableCameraRecord\(/,
    'standalone boot can apply an exported camera record directly');
assert.match(snapshotBootSource, /onCameraModeChange:\s*applySnapshotLayerCameraMode/,
    'snapshot layers route camera selection into the portable camera records');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
camera.position.set(0, 1, 5);
const initialPosition = camera.position.clone();
const controls = {
    enabled: true,
    target: new THREE.Vector3(),
};
const renderer = {
    capabilities: {},
    info: {},
    domElement: { width: 800, height: 600 },
};
const sceneCameras = [
    {
        h: 101,
        n: 'Wide',
        active: true,
        pos: [0, -500, 120],
        tgt: [0, 0, 100],
        up: [0, 0, 1],
        fov: 50,
        persp: true,
    },
    {
        h: 202,
        n: 'Close',
        pos: [25, -90, 155],
        tgt: [0, 0, 145],
        up: [0, 0, 1],
        fov: 32,
        persp: true,
    },
];
const modeEvents = [];

const manager = createLayerManager({
    scene,
    camera,
    renderer,
    THREE,
    nodeMap: new Map(),
    controls,
    isSnapshot: true,
    getCamera: () => camera,
    getCameraTarget: target => target.copy(controls.target),
    getSceneCameras: () => sceneCameras,
    onCameraModeChange(mode, options) {
        modeEvents.push({ mode, handle: options.handle });
        if (mode === 'physical') {
            const record = sceneCameras.find(entry => entry.h === Number(options.handle));
            if (!record?.pos) return false;
            camera.position.fromArray(record.pos);
            camera.updateMatrix();
            return true;
        }
        if (mode === 'viewport') {
            camera.position.copy(initialPosition);
            camera.updateMatrix();
        }
        return true;
    },
});

let cameraApi = null;
await manager.mount('snapshot-camera-smoke', ctx => {
    cameraApi = ctx.camera;
    const cameras = cameraApi.listSceneCameras();
    assert.equal(cameras.length, 2, 'both exported cameras reach runtime scripts');
    assert.equal(cameras[0].name, 'Wide');
    assert.equal(cameras[0].active, true, 'the exported initial camera is identified');
    assert.equal(cameras[1].hasSnapshotState, true, 'portable camera state is discoverable');
    assert.equal(cameraApi.getActiveSceneCamera()?.handle, 101,
        'the initial exported camera is queryable before switching');
    return {};
});

assert.ok(cameraApi, 'camera facade mounted');
assert.equal(cameraApi.useSceneCameraByName('Close', { exact: true }), true,
    'a script switches cameras directly by name');
assert.equal(manager.cameraMode, 'physical');
assert.equal(cameraApi.getActiveSceneCamera()?.handle, 202);
assert.equal(camera.position.x, 25, 'the selected record was applied');
assert.equal(controls.enabled, false, 'scene-camera mode locks orbit controls');
assert.equal(camera.matrixAutoUpdate, false, 'portable physical camera is stable between applies');

assert.equal(cameraApi.useSceneCamera(999), false,
    'a missing camera state rejects the switch');
assert.equal(manager.cameraMode, 'physical',
    'a rejected switch preserves the previous camera mode');
assert.equal(cameraApi.getActiveSceneCamera()?.handle, 202,
    'a rejected switch preserves the previously selected camera');

assert.equal(cameraApi.useViewport(), true,
    'releasing a scene camera restores the original exported view');
assert.equal(manager.cameraMode, 'viewport');
assert.equal(cameraApi.getActiveSceneCamera()?.handle, 101);
assert.ok(camera.position.equals(initialPosition), 'viewport restore reapplied the exported initial view');
assert.equal(controls.enabled, true, 'snapshot orbit controls restore after release');
assert.equal(camera.matrixAutoUpdate, true,
    'snapshot viewport cameras remain interactive after release');

assert.equal(cameraApi.usePhysicalCamera(202), true,
    'the legacy physical-camera method remains a compatible alias');
manager.remove('snapshot-camera-smoke');
assert.equal(manager.cameraMode, 'viewport', 'layer teardown releases its selected camera');
assert.ok(modeEvents.some(event => event.mode === 'physical' && event.handle === 202));

console.log('snapshot-multi-camera-smoke: PASS');
