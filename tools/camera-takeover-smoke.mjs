import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');
const { createLayerManager } = await import(
    new URL('../web/js/layer_manager.js', import.meta.url).href
);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(47, 1.5, 0.25, 2400);
camera.position.set(10, 20, 30);
camera.up.set(0, 1, 0);
camera.lookAt(0, 4, 0);
camera.matrixAutoUpdate = false;

const controls = {
    enabled: false,
    target: new THREE.Vector3(0, 4, 0),
    cursor: new THREE.Vector3(1, 2, 3),
    enableDamping: true,
    dampingFactor: 0.08,
    enablePan: true,
    enableRotate: true,
    enableZoom: true,
    rotateSpeed: 0.5,
    panSpeed: 1,
    zoomSpeed: 2,
    mouseButtons: { LEFT: null, MIDDLE: 0, RIGHT: null },
    touches: { ONE: 0, TWO: 2 },
    updateCount: 0,
    update() { this.updateCount++; return false; },
};

const baseline = {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    target: controls.target.clone(),
    cursor: controls.cursor.clone(),
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    matrixAutoUpdate: camera.matrixAutoUpdate,
    enabled: controls.enabled,
    rotateSpeed: controls.rotateSpeed,
    mouseMiddle: controls.mouseButtons.MIDDLE,
};

const modeEvents = [];
const manager = createLayerManager({
    scene,
    camera,
    renderer: {
        capabilities: {},
        info: {},
        domElement: { width: 800, height: 600 },
    },
    THREE,
    nodeMap: new Map(),
    controls,
    getCamera: () => camera,
    getCameraTarget: target => target.copy(controls.target),
    onCameraModeChange(mode, options) {
        modeEvents.push({ mode, ...options });
        return true;
    },
});

let ownerCamera = null;
await manager.mount('camera-owner', ctx => {
    ownerCamera = ctx.camera;
    assert.equal(ctx.camera.takeOver({ controls: 'viewer' }), true,
        'owner can explicitly borrow the max.js viewer controls');
    return {};
});

assert.equal(manager.cameraMode, 'script');
assert.equal(manager.cameraOwner, 'camera-owner');
assert.equal(manager.cameraControlsMode, 'viewer');
assert.equal(controls.enabled, true, 'takeover overrides a pre-existing viewer camera lock');
assert.equal(camera.matrixAutoUpdate, true, 'script camera owns its transform updates');

camera.position.set(90, 80, 70);
camera.fov = 73;
camera.near = 3;
camera.far = 9000;
controls.target.set(8, 9, 10);
controls.cursor.set(5, 6, 7);
controls.rotateSpeed = 1.8;
controls.mouseButtons.MIDDLE = 2;

// Simulate a late postfx/camera-lock restore trying to disable the shared
// OrbitControls after the layer has already taken ownership.
controls.enabled = false;
assert.equal(manager.enforceCameraControls(), true,
    'camera authority corrects a late viewer-control write');
assert.equal(controls.enabled, true, 'runtime ownership wins over viewer camera lock');

let intruderCamera = null;
await manager.mount('camera-intruder', ctx => {
    intruderCamera = ctx.camera;
    return {};
});
assert.equal(intruderCamera.takeOver({ controls: 'viewer' }), false,
    'another layer cannot steal an active camera lease');
assert.equal(intruderCamera.useViewport(), false,
    'another layer cannot release the active camera lease');
assert.equal(ownerCamera.setControlsEnabled(false), true,
    'owner can switch from shared viewer controls to uncontested manual input');
assert.equal(manager.cameraControlsMode, 'none');
assert.equal(controls.enabled, false);
assert.equal(ownerCamera.setControlsEnabled(true), true);
assert.equal(controls.enabled, true);

assert.equal(ownerCamera.release(), true, 'explicit owner release succeeds');
assert.equal(manager.cameraMode, 'viewport');
assert.ok(camera.position.equals(baseline.position), 'explicit release restores the camera');
assert.equal(controls.enabled, baseline.enabled, 'explicit release restores viewer lock');
assert.equal(ownerCamera.takeOver({ controls: 'viewer' }), true,
    'the same live layer can acquire a fresh lease after release');
camera.position.set(90, 80, 70);
controls.target.set(8, 9, 10);
controls.rotateSpeed = 1.8;
controls.mouseButtons.MIDDLE = 2;

assert.equal(manager.remove('camera-owner'), true, 'owner hot-unload succeeds');
assert.equal(manager.cameraMode, 'viewport');
assert.equal(manager.cameraOwner, null);
assert.ok(camera.position.equals(baseline.position), 'camera position restores exactly');
assert.ok(camera.quaternion.equals(baseline.quaternion), 'camera orientation restores exactly');
assert.ok(controls.target.equals(baseline.target), 'viewer orbit target restores exactly');
assert.ok(controls.cursor.equals(baseline.cursor), 'viewer zoom cursor restores exactly');
assert.equal(camera.fov, baseline.fov);
assert.equal(camera.near, baseline.near);
assert.equal(camera.far, baseline.far);
assert.equal(camera.matrixAutoUpdate, baseline.matrixAutoUpdate);
assert.equal(controls.enabled, baseline.enabled, 'original camera-lock state restores');
assert.equal(controls.rotateSpeed, baseline.rotateSpeed, 'borrowed control settings do not leak');
assert.equal(controls.mouseButtons.MIDDLE, baseline.mouseMiddle, 'borrowed input mapping does not leak');
assert.equal(ownerCamera.takeOver({ controls: 'viewer' }), false,
    'stale camera facade cannot reacquire after disposal');
assert.ok(modeEvents.some(event => event.mode === 'script' && event.controls === 'viewer'));
assert.ok(modeEvents.some(event => event.mode === 'viewport' && event.restoring === true));

manager.remove('camera-intruder');
console.log('camera-takeover-smoke: PASS');
