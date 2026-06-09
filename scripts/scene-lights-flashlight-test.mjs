// Flashlight regression test for scene_lights.js — verifies that a light
// parented in Max (ld.p > 0) keeps its beam aimed correctly both in the
// static pose AND when an animated matrix16 track overwrites its transform
// (the camera-flashlight case). Run: node scripts/scene-lights-flashlight-test.mjs
import * as THREE from '../web/node_modules/three/build/three.module.js';
import { createSceneLights } from '../web/js/scene_lights.js';

const EPS = 1e-3;
let failed = 0;
function expectClose(label, a, b) {
    if (a.distanceTo(b) > EPS) {
        failed++;
        console.error(`FAIL ${label}: got ${a.toArray().map(n => n.toFixed(4))}, want ${b.toArray().map(n => n.toFixed(4))}`);
    }
}

// Scene with a Max-basis root (Z-up → Y-up rotation), like maxBasisRoot.
const scene = new THREE.Scene();
const maxRoot = new THREE.Group();
maxRoot.rotation.x = -Math.PI / 2;
scene.add(maxRoot);

const lightHandleMap = new Map();
const nodeMap = new Map(); // camera node NOT exported — matches real snapshots

const sceneLights = createSceneLights({ scene, parent: maxRoot, lightHandleMap, nodeMap });

// Spot light parented to a camera in Max (p=999, camera not in nodeMap).
// Exported pose: at (10, 20, 5) aiming along +X (root space), per
// WriteLightJson convention dir = -row1 of the node TM.
const dirRoot = new THREE.Vector3(1, 0, 0);
sceneLights.apply([{
    h: 42, p: 999, type: 2, name: 'flashlight',
    pos: [10, 20, 5], dir: dirRoot.toArray(),
    color: [1, 1, 1], intensity: 1,
}]);

const light = lightHandleMap.get(42);
const target = light.userData.maxjsTarget;
if (target.parent !== light) { failed++; console.error('FAIL: target not parented under light'); }

scene.updateMatrixWorld(true);

const TARGET_DISTANCE = 1000;
const rootToWorld = maxRoot.matrixWorld;
const expectStatic = new THREE.Vector3(10 + 1000, 20, 5).applyMatrix4(rootToWorld);
expectClose('static aim', target.getWorldPosition(new THREE.Vector3()), expectStatic);

// ── Animated frame: matrix16 track overwrites the light's local matrix with
// a sampled Max node TM (applyCustomEntry 'matrix16' path, verbatim).
// Camera turned: light now at (50, 0, 30), beam along -Y root (TM row1 = +Y).
const animTM = new THREE.Matrix4().makeTranslation(50, 0, 30); // identity rotation → -row1 = (0,-1,0)
light.matrixAutoUpdate = false;
light.matrix.copy(animTM);
light.matrix.decompose(light.position, light.quaternion, light.scale);
light.matrixWorldNeedsUpdate = true;
scene.updateMatrixWorld(true);

const expectAnimA = new THREE.Vector3(50, 0 - TARGET_DISTANCE, 30).applyMatrix4(rootToWorld);
expectClose('animated aim (identity TM)', target.getWorldPosition(new THREE.Vector3()), expectAnimA);

// Camera rolled 90° about root Z: TM rotation Rz(90°) → row1(+Y axis) maps to (-1,0,0) → beam = +X.
const animTM2 = new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(7, 8, 9);
light.matrix.copy(animTM2);
light.matrix.decompose(light.position, light.quaternion, light.scale);
light.matrixWorldNeedsUpdate = true;
scene.updateMatrixWorld(true);

const expectAnimB = new THREE.Vector3(7 + TARGET_DISTANCE, 8, 9).applyMatrix4(rootToWorld);
expectClose('animated aim (rolled TM)', target.getWorldPosition(new THREE.Vector3()), expectAnimB);

// ── Free light (no p): target must stay a world-space sibling, old behavior.
sceneLights.apply([{
    h: 7, type: 2, name: 'free spot',
    pos: [0, 0, 100], dir: [0, 0, -1],
    color: [1, 1, 1], intensity: 1,
}]);
const freeLight = lightHandleMap.get(7);
const freeTarget = freeLight.userData.maxjsTarget;
if (freeTarget.parent === freeLight) { failed++; console.error('FAIL: free light target wrongly parented under light'); }
scene.updateMatrixWorld(true);
const expectFree = new THREE.Vector3(0, 0, 100 - 1000).applyMatrix4(rootToWorld);
expectClose('free light aim', freeTarget.getWorldPosition(new THREE.Vector3()), expectFree);

console.log(failed === 0 ? 'all flashlight cases passed' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
