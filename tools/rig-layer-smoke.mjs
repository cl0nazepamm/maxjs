import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('../web/vendor/three-r185/build/three.cjs');
const { createLayerManager } = await import(new URL('../web/js/layer_manager.js', import.meta.url).href);

function authoredNode(handle, name, parentHandle = 0) {
    const node = new THREE.Group();
    node.name = name;
    node.matrixAutoUpdate = false;
    node.userData.maxjsHandle = handle;
    node.userData.maxjsParentHandle = parentHandle;
    return node;
}

function scopedBone(meshHandle, handle, x, y, z) {
    const bone = new THREE.Bone();
    bone.matrixAutoUpdate = false;
    bone.matrix.makeTranslation(x, y, z);
    bone.matrix.decompose(bone.position, bone.quaternion, bone.scale);
    bone.userData.maxjsHandle = `${meshHandle}:${handle}`;
    return bone;
}

function skinnedMesh(handle, name, bones) {
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.userData.maxjsHandle = handle;
    for (const bone of bones) mesh.add(bone);
    mesh.bind(new THREE.Skeleton(bones));
    return mesh;
}

const scene = new THREE.Scene();
const maxRoot = new THREE.Group();
scene.add(maxRoot);

const neck = authoredNode(481, 'CC_Base_NeckTwist02');
const head = authoredNode(482, 'CC_Base_Head', 481);
const facial = authoredNode(483, 'CC_Base_FacialBone', 482);
const rightEyeHelper = authoredNode(489, 'CC_Base_R_Eye', 483);
const leftEyeHelper = authoredNode(490, 'CC_Base_L_Eye', 483);
neck.add(head);
head.add(facial);
facial.add(rightEyeHelper, leftEyeHelper);
maxRoot.add(neck);

const bodyHead = scopedBone(546, 482, 0, 2, 0);
const bodyFacial = scopedBone(546, 483, 0, 0.2, 0);
bodyHead.add(bodyFacial);
const body = skinnedMesh(546, 'CC_Base_Body', [bodyHead, bodyFacial]);

const rightEye = scopedBone(552, 489, -0.4, 2.2, 0.5);
const leftEye = scopedBone(552, 490, 0.4, 2.2, 0.5);
const eyes = skinnedMesh(552, 'CC_Base_Eye', [rightEye, leftEye]);
maxRoot.add(body, eyes);

const nodeMap = new Map([
    [481, neck],
    [482, head],
    [483, facial],
    [489, rightEyeHelper],
    [490, leftEyeHelper],
    [546, body],
    ['546:482', bodyHead],
    ['546:483', bodyFacial],
    [552, eyes],
    ['552:489', rightEye],
    ['552:490', leftEye],
]);

const manager = createLayerManager({
    scene,
    camera: new THREE.PerspectiveCamera(50, 1, 0.1, 1000),
    renderer: { capabilities: {}, info: {}, domElement: { width: 800, height: 600 } },
    THREE,
    nodeMap,
    maxRoot,
});

await manager.mount('eye-gaze', (ctx) => {
    ctx.maxScene.getNode('552:489').transform.setRotationEuler(0, 0.2, 0, { mode: 'additive' });
    ctx.maxScene.getNode('552:490').transform.setRotationEuler(0, 0.2, 0, { mode: 'additive' });
    return {};
});

scene.updateMatrixWorld(true);
const rightEyeLocalWithGaze = rightEye.matrix.clone();
const rightEyeWorldBeforeHead = rightEye.matrixWorld.clone();
let headControl = null;

const headMount = await manager.mount('head-motion', (ctx) => {
    headControl = ctx.rig.bind('CC_Base_Head');
    return {
        onBeforeRender() {
            headControl.setRotationEuler(0.08, 0.12, -0.04, { order: 'YXZ' });
        },
    };
});

assert.equal(headMount.error, null, 'head rig layer mounts');
assert.equal(headControl.directCount, 1, 'rig binds the direct body head copy');
assert.equal(headControl.followerCount, 1, 'rig creates one follower for the isolated eye skin');
assert.equal(rightEye.parent?.userData?.maxjsRigFollower, true, 'eye roots receive a private hierarchy parent');

manager.update(1 / 60, 1 / 60);
manager.beforeRender(1 / 60);
scene.updateMatrixWorld(true);

assert.equal(rightEyeLocalWithGaze.equals(rightEye.matrix), true, 'eye-local gaze survives head motion untouched');
assert.equal(rightEyeWorldBeforeHead.equals(rightEye.matrixWorld), false, 'isolated eye roots follow the head in world space');
assert.equal(bodyHead.matrix.equals(new THREE.Matrix4().makeTranslation(0, 2, 0)), false, 'direct head bone receives the additive rotation');

assert.equal(manager.remove('head-motion'), true, 'head rig layer removes');
scene.updateMatrixWorld(true);
assert.equal(rightEye.parent, eyes, 'rig teardown restores the original eye hierarchy');
assert.equal(rightEyeLocalWithGaze.equals(rightEye.matrix), true, 'eye-local gaze remains after head rig teardown');
assert.equal(rightEyeWorldBeforeHead.equals(rightEye.matrixWorld), true, 'head follower teardown restores the eye world pose');

assert.equal(manager.remove('eye-gaze'), true, 'gaze layer removes');
assert.equal(rightEye.matrix.equals(new THREE.Matrix4().makeTranslation(-0.4, 2.2, 0.5)), true, 'gaze teardown restores the authored eye local');

console.log('rig layer smoke ok');
