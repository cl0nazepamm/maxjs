import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    refitFlatTlasRange,
    runLatestBudgetedTask,
} from '../web/vendor/speedball-gi/js/gi_refit.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

// A one-leaf refit proves the vendored dependency is executable without
// loading Three.js/WebGPU.
const nodes = new Float32Array(12);
nodes[7] = 0;
nodes[8] = 1;
assert.equal(refitFlatTlasRange({
    nodes,
    instanceBounds: new Float32Array([-1, -2, -3, 4, 5, 6]),
}), true);
assert.deepEqual(Array.from(nodes.subarray(0, 6)), [-1, -2, -3, 4, 5, 6]);

// A visible viewer must yield long refits to the next presented frame. A
// scheduler.yield continuation can run before paint and recreate the 12 fps
// post-scrub tail even when every individual slice is only 2 ms.
{
    const savedRaf = globalThis.requestAnimationFrame;
    const savedScheduler = globalThis.scheduler;
    const savedDocument = globalThis.document;
    let rafYields = 0;
    let schedulerYields = 0;
    globalThis.document = { visibilityState: 'visible' };
    globalThis.requestAnimationFrame = (cb) => {
        rafYields++;
        cb(0);
        return rafYields;
    };
    globalThis.scheduler = {
        yield() {
            schedulerYields++;
            return Promise.resolve();
        },
    };
    let steps = 0;
    await runLatestBudgetedTask({
        capture: () => ({ invalid: false }),
        createTask: () => ({
            done: false,
            step() {
                steps++;
                this.done = steps >= 3;
                return true;
            },
        }),
        validate: () => true,
        commit: () => ({ steps }),
    });
    assert.equal(rafYields, 2);
    assert.equal(schedulerYields, 0);
    if (savedRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = savedRaf;
    if (savedScheduler === undefined) delete globalThis.scheduler;
    else globalThis.scheduler = savedScheduler;
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
}

const glue = await read('../web/js/editor/pathtracing_glue.js');
assert.match(glue, /schedulePathTracingLiveRebuild\(changeKind = 'full'\)/);
assert.match(glue, /clearTimeout\(pathTracingLiveRebuildTimer\)/, 'scheduler is trailing-edge');
assert.match(glue, /maxTimeline\?\.playing\?\.\(\) === true/, 'PT work is held during playback');
assert.match(glue, /markTransformsDirty/);
assert.match(glue, /markDeformsDirty/);
assert.match(glue, /markLightsDirty/);
assert.match(glue, /pathTracingInactiveUpdateMask/,
    'PT invalidations survive while Probe view owns the renderer');
assert.match(glue, /mergePathTracingUpdateMasks\(/,
    'typed inactive invalidations preserve full-dominates semantics');

const sync = await read('../web/js/editor/scene_sync.js');
assert.match(sync, /!flattenedGroupDissolved &&\s*!deferredFullReady && guardedDeform\s*\? 'deform'/,
    'only the native guarded deform lane may bypass a full PT build');
assert.match(sync, /pathTraceUpdateReady = !guardedDeform \|\| hasExactIncomingNormals/,
    'position-only deformation waits for the exact settle-normal packet');
assert.match(sync, /pathTraceFullAfterNormalHandles\.add\(meta\.h\)[\s\S]*pathTraceFullAfterNormalHandles\.delete\(meta\.h\)/,
    'flatten-group dissolution retains structural PT debt through normal settle');
assert.match(sync, /maxTimeline\.noteSceneSync\?\.\(\)/,
    'geometry delivery extends HALO interaction gating through native settle');
assert.match(sync, /schedulePathTracingLiveRebuild\('transform'\)/);
assert.match(sync, /schedulePathTracingLiveRebuild\('light'\)/,
    'changed light packets use the packed-light lane instead of a BVH rebuild');
assert.match(sync, /const lightChanged = deps\.applyLightData/,
    'unchanged native light packets do not invalidate PT');
assert.match(sync, /transformChanged = applyTransform\(mesh, nd\.t\)/,
    'identical transform packets do not invalidate GI/PT');
assert.match(sync, /maxjsLightCarrier = nd\.lightCarrier === true/,
    'camera-light hierarchy carriers retain their structural full-sync tag');
assert.match(sync, /lightCarrierHasSurfaceDescendant[\s\S]*maxjsLightCarrierHasSurface/,
    'a carrier pays the descendant classification cost only once per full-sync epoch');
assert.match(sync, /hierarchyLightTransformsChanged[\s\S]*markLightProbeLightsDirty[\s\S]*pathTraceLightsChanged = true/,
    'inherited light motion invalidates light state without a full light payload');
assert.match(sync, /affectsSurface && change\.transformChanged/,
    'a light-only camera carrier does not masquerade as moving geometry');

const timeline = await read('../web/js/maxjs_timeline.js');
assert.match(timeline, /emitChange\(\{ defer: true \}\);/,
    'paused seek and playback notifications share one rAF mailbox');
assert.doesNotMatch(timeline, /emitChange\(\{ defer: nextPlaying \}\)/);
assert.match(timeline, /function lastUpdateMs\(\)/);
assert.match(timeline, /function noteSceneSync\(\)/);

const giGlue = await read('../web/js/editor/gi_volume_glue.js');
assert.match(giGlue, /Math\.min\(nowMs - deps\.haloGiLastInteractionMs, timelineIdleMs\)/,
    'HALO idle gate includes scrub/step/stop activity');

const lights = await read('../web/js/editor/lights.js');
assert.match(lights, /function lightTracePayloadSignature\(/,
    'full and delta light application share a stable PT change signature');
assert.match(lights, /return traceChanged;/,
    'light application reports whether the packed tracer input actually changed');

const tracer = await read('../web/vendor/speedball-gi/js/spectral_tracer.js');
assert.match(tracer, /function markTransformsDirty\(\)/);
assert.match(tracer, /function markDeformsDirty\(/);
assert.match(tracer, /function markLightsDirty\(\)/);
assert.match(tracer, /gpu = \{[^\n]*built \};/);

const spectralScene = await read('../web/vendor/speedball-gi/js/spectral_scene.js');
const updateDeforms = spectralScene.match(/function updateDeforms\([\s\S]*?\n    \}/)?.[0];
assert.ok(updateDeforms);
assert.match(updateDeforms, /if \(posChanged && !refitFlatBlasRange/,
    'normal-only settle packets never refit BLAS bounds');
assert.match(updateDeforms, /if \(refitted === 0 \|\| !updateTlas\)/,
    'normal-only settle packets never rewrite the TLAS');

const probes = await read('../web/vendor/speedball-gi/js/gi_probes.js');
assert.match(probes, /const RAYS_PER_TICK_MIN = 2_048/);
assert.match(probes, /if \(!moving && wasMoving\) \{[\s\S]*probeBudgetAfterInteraction\(tickBudgetRays\)/,
    'HALO resumes a stopped scrub with GPU headroom for the settle lane');

console.log('timeline-hitch-source-smoke: OK');
