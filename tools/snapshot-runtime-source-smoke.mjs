import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
    new URL('../web/js/snapshot_boot.js', import.meta.url),
    'utf8',
);
const snapshotFxSource = readFileSync(
    new URL('../web/js/snapshot_fx.js', import.meta.url),
    'utf8',
);
const snapshotExportSource = readFileSync(
    new URL('../src/maxjs_panel_snapshot_export.inl', import.meta.url),
    'utf8',
);
const snapshotPages = [
    readFileSync(new URL('../web/snapshot.html', import.meta.url), 'utf8'),
    readFileSync(new URL('../web/snapshot_webgpu.html', import.meta.url), 'utf8'),
];
const sceneLightsSource = readFileSync(
    new URL('../web/js/scene_lights.js', import.meta.url), 'utf8');
const editorLightsSource = readFileSync(
    new URL('../web/js/editor/lights.js', import.meta.url), 'utf8');
const lightSyncSource = readFileSync(
    new URL('../src/maxjs_panel_sync.inl', import.meta.url), 'utf8');
const nativeLightsSource = readFileSync(
    new URL('../src/threejs_lights.cpp', import.meta.url), 'utf8');

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

const irLightGraph = functionBody('async function installSnapshotIrLightGraph(');
assert.match(irLightGraph, /snapshotHasIrEmitters\(lights\)/,
    'snapshot installs specialized lighting only when its payload declares IR emitters');
assert.match(irLightGraph, /import\('\.\/max_lights_node\.js'\)/,
    'IR snapshot lighting uses the same adaptive light graph as live max.js');
assert.match(irLightGraph, /installMaxLightsRenderer\(renderer\)/,
    'IR lights install MaxLightsNode even when Speedball GI and Studio are disabled');
assert.ok(
    boot.indexOf('installSnapshotIrLightGraph(renderer, meta.lights)')
        < boot.indexOf('createScene({ meta, renderer, canvas })'),
    'IR lighting installs before the snapshot scene and its materials compile',
);

const speedballReplay = functionBody('async function createSnapshotSpeedballGi(');
assert.match(speedballReplay, /import\('speedball-gi'\)/,
    'snapshot Speedball replay resolves through the package import map');
assert.match(speedballReplay, /import\('\.\/max_lights_node\.js'\)/,
    'snapshot Speedball replay installs the same adaptive light graph as live max.js');
assert.match(speedballReplay, /installMaxLightsRenderer\(renderer\)/,
    'snapshot Speedball replay installs MaxLightsNode before the first render compile');
assert.doesNotMatch(speedballReplay, /\bgiLights\b/,
    'snapshot Speedball replay does not diverge through the generic library light graph');
assert.match(source, /snapshotUi\?\.speedballGi/,
    'snapshot replay reads the Speedball-branded UI state');
assert.match(speedballReplay, /maxTimeline\.playing\?\.\(\) === true/,
    'snapshot Speedball replay observes standalone timeline playback after warmup');

const nirSensingReplay = functionBody('async function createSnapshotNirSensingController(');
assert.match(nirSensingReplay, /import\('speedball-gi'\)/,
    'snapshot NIR replay resolves the shared direct-light gates lazily');
assert.match(nirSensingReplay, /powerShot\.mode === 'infrared'.*powerShot\.mode === 'nightshot'/s,
    'standalone sensing follows the same PowerShot imager modes as the editor');
for (const consumer of [
    'setNirDirectSensing',
    'setNirIlluminatorGain',
    'setNirSensing',
    'setNirGain',
    'setSpectralRasterSensing',
]) {
    assert.match(nirSensingReplay, new RegExp(`\\b${consumer}\\b`),
        `snapshot NIR replay drives ${consumer}`);
}
assert.match(snapshotFxSource, /getPowerShotOptions\(\)\s*\{\s*return state\.powershot;/,
    'snapshot PowerShot exposes its active imager state to the frame driver');
const snapshotLoop = functionBody('async function startRenderLoop(');
assert.ok(
    snapshotLoop.indexOf('nirSensing.sync();') < snapshotLoop.indexOf('renderer.compileAsync'),
    'snapshot applies NIR sensing before its first render compile',
);
assert.match(snapshotLoop, /renderer\.setAnimationLoop\(null\);\s*nirSensing\.dispose\(\);/,
    'snapshot teardown resets module-shared NIR state');

const animationSource = readFileSync(
    new URL('../web/js/maxjs_animation.js', import.meta.url),
    'utf8',
);
assert.match(animationSource, /syncAnimatedLightTarget\(target\)/,
    'matrix animation keeps free SpotLight and DirectionalLight targets aligned');
assert.match(animationSource, /\.set\(0, -ANIMATED_LIGHT_TARGET_DISTANCE, 0\)/,
    'animated light targeting preserves the exported Max -Y beam convention');

assert.match(snapshotExportSource, /const std::wstring speedballVendor = webDir \+ L"\\\\vendor\\\\speedball-gi";/,
    'standalone export resolves the vendored Speedball package');
assert.match(snapshotExportSource, /CopyDirectoryRecursive\(speedballVendor, outDir \+ L"\\\\vendor\\\\speedball-gi"\)/,
    'standalone export copies Speedball beside the snapshot runtime');
assert.match(snapshotExportSource, /const std::wstring speedballBvhDependency = webDir \+ L"\\\\node_modules\\\\three-mesh-bvh";/,
    'standalone export resolves Speedball\'s BVH peer dependency');
assert.match(snapshotExportSource, /CopyDirectoryRecursive\(speedballBvhDependency, outDir \+ L"\\\\node_modules\\\\three-mesh-bvh"\)/,
    'standalone export copies Speedball\'s BVH peer dependency');
for (const page of snapshotPages) {
    assert.match(page, /"speedball-gi": "\.\/vendor\/speedball-gi\/js\/index\.js"/,
        'every snapshot shell maps the Speedball package to the copied vendor');
}

assert.match(sceneLightsSource, /THREE\.MathUtils\.clamp\(penumbra, 0, 1\)/,
    'snapshot light replay clamps old out-of-range spotlight penumbra values');
assert.match(sceneLightsSource, /lightData\?\.emitterClass/,
    'snapshot light replay prefers the native explicit emitter class');
assert.match(sceneLightsSource, /_ir_\|_nir_\|_illuminator_/,
    'legacy snapshot lights still infer IR intent from conventional names');
assert.match(lightSyncSource, /DetectLightEmitterClass\(node\)/,
    'native light serialization stores spectral emitter intent explicitly');
assert.match(editorLightsSource, /THREE\.MathUtils\.clamp\(penumbra, 0, 1\)/,
    'live light replay clamps old out-of-range spotlight penumbra values');
const transportedPenumbraClamps = lightSyncSource.match(
    /std::clamp\([^\n]*pl_penumbra[^\n]*0\.0f, 1\.0f\)/g,
) ?? [];
assert.ok(transportedPenumbraClamps.length >= 2,
    'native JSON and binary light transports clamp spotlight penumbra to Three.js semantics');
const penumbraRanges = nativeLightsSource.match(/pl_penumbra[\s\S]*?p_range, 0\.0f, 1\.0f,/g) ?? [];
assert.equal(penumbraRanges.length, 2,
    'legacy and dedicated spotlight parameter blocks constrain penumbra to [0, 1]');

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
