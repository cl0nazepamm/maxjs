import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
    new URL('../web/js/snapshot_boot.js', import.meta.url),
    'utf8',
);

function functionBody(signature) {
    const signatureOffset = source.indexOf(signature);
    assert.ok(signatureOffset >= 0, `missing ${signature}`);
    const closeParenOffset = source.indexOf(')', signatureOffset + signature.length);
    assert.ok(closeParenOffset >= 0, `missing parameter close for ${signature}`);
    const bodyOffset = source.indexOf('{', closeParenOffset);
    assert.ok(bodyOffset >= 0, `missing body for ${signature}`);
    let depth = 0;
    for (let i = bodyOffset; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(bodyOffset + 1, i);
        }
    }
    assert.fail(`unterminated body for ${signature}`);
}

const applyRuntimeScene = functionBody('async function applyRuntimeScene(');
assert.doesNotMatch(applyRuntimeScene, /noteExtractionDeferred/,
    'runtimeScene replay is implemented, not deferred');
assert.match(applyRuntimeScene, /parseRuntimeSubtree/,
    'baked Object3D trees are parsed');
assert.match(applyRuntimeScene, /enforceRuntimeHiddenSources/,
    'baked clones hide their synced Max sources');

const parser = functionBody('async function parseRuntimeSubtree(');
assert.match(parser, /THREE\.ObjectLoader/,
    'standalone runtime trees use the standard Three.js ObjectLoader');
assert.match(parser, /patchRuntimeMaterialTypes/,
    'node-material JSON is degraded before classic ObjectLoader parsing');

const detachBaked = functionBody('function detachBakedLayer(');
assert.match(detachBaked, /maxjsLayerId/,
    'baked/live dedupe keys on the serialized layer id');
assert.match(detachBaked, /parent\.remove/,
    'a baked twin is detached before its live sidecar initializes');

const restoreBaked = functionBody('function restoreDetachedBakedLayer(');
assert.match(restoreBaked, /parent\.add/,
    'failed live sidecars restore their detached baked fallback');

const disposeRuntime = functionBody('function disposeRuntimeObjects(');
assert.match(disposeRuntime, /skeleton\.dispose/,
    'baked skinned meshes release their skeleton bone textures');

const restore = functionBody('function restoreSnapshotTransformOverrides(');
assert.match(restore, /ownerLayer/,
    'transform restore distinguishes mounted sidecar owners');
assert.match(restore, /restoreTransformOverrides/,
    'standalone boot restores durable transform overrides');

const buildLayerManager = functionBody('function buildLayerManager(');
for (const getter of ['getAnimationSystem', 'getAudioSystem', 'getGLTFSystem']) {
    assert.match(buildLayerManager, new RegExp(`\\b${getter}\\b`),
        `${getter} is wired into snapshot layer context`);
}
assert.match(buildLayerManager, /isSnapshot:\s*true/,
    'snapshot layers can branch explicitly on ctx.runtime.isSnapshot');

const projectRuntime = functionBody('function bindSnapshotProjectRuntime(');
assert.match(projectRuntime, /readOnly:\s*true/,
    'snapshot ctx.project reports read-only state');
assert.doesNotMatch(projectRuntime, /throw\s+new\s+Error/,
    'snapshot ctx.project does not kill layers on live-only calls');

const boot = functionBody('export async function boot(');
assert.match(boot, /applyMaterialScalar:\s*applySnapshotMaterialScalar/,
    'snapshot material animation tracks have a scalar applier');
assert.match(boot, /optionalModules\.gltf\?\.applyGLTFs/,
    'snapshot glTF payload reaches the runtime system');
assert.match(boot, /enforceRuntimeHiddenSources\(runtimeSceneState\.hiddenSourceHandles,\s*nodeMap\)/,
    'hidden Max sources are reasserted after animation and delta changes');

const runtimeIndex = boot.indexOf('applyRuntimeScene(');
const animationIndex = boot.indexOf('animationSystem.loadSnapshotAnimations');
const timelineIndex = boot.indexOf('maxTimeline.initStandalone');
const bindIndex = boot.indexOf('bindLayerProject(');
assert.ok(runtimeIndex >= 0 && animationIndex > runtimeIndex,
    'baked runtime targets exist before animation registration');
assert.ok(timelineIndex > runtimeIndex && timelineIndex < bindIndex,
    'standalone timeline state exists before layer init');
assert.ok(bindIndex > animationIndex,
    'animation state exists before layer init');

console.log('snapshot-runtime-source-smoke: PASS');
