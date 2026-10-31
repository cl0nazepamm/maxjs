import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const glue = await read('../web/js/editor/pathtracing_glue.js');
assert.match(glue, /schedulePathTracingLiveRebuild\(changeKind = 'full'\)/);
assert.match(glue, /clearTimeout\(pathTracingLiveRebuildTimer\)/, 'scheduler is trailing-edge');
assert.match(glue, /maxTimeline\?\.playing\?\.\(\) === true/, 'PT work is held during playback');
assert.match(glue, /markTransformsDirty/);
assert.match(glue, /markDeformsDirty/);
assert.match(glue, /markLightsDirty/);
assert.match(glue, /pathTracingInactiveUpdateMask/,
    'PT invalidations survive while the raster view owns the renderer');
assert.match(glue, /mergePathTracingUpdateMasks\(/,
    'typed inactive invalidations preserve full-dominates semantics');

const sync = await read('../web/js/editor/scene_sync.js');
assert.match(sync, /applyDeltaFrame\(buffer,[\s\S]*meta\?\.stats\?\.producerBytes\)/,
    'retained playback buffers decode only their native-reported logical prefix');
const hostBridge = await read('../web/js/editor/host_bridge.js');
assert.match(hostBridge, /captureRetainedDeltaFrame\([\s\S]*meta\?\.stats\?\.producerBytes/,
    'retained playback slots are captured before editor and Relay consumers run');
assert.match(hostBridge, /captured\.frameId\s*===\s*lastDeliveredDeltaFrameId/,
    'multiple delayed views of the same overwritten slot are coalesced');
assert.match(sync, /!flattenedGroupDissolved &&\s*!deferredFullReady && guardedDeform\s*\? 'deform'/,
    'only the native guarded deform lane may bypass a full PT build');
assert.match(sync, /pathTraceUpdateReady = !guardedDeform \|\| hasExactIncomingNormals/,
    'position-only deformation waits for the exact settle-normal packet');
assert.match(sync, /pathTraceFullAfterNormalHandles\.add\(meta\.h\)[\s\S]*pathTraceFullAfterNormalHandles\.delete\(meta\.h\)/,
    'flatten-group dissolution retains structural PT debt through normal settle');
assert.match(sync, /maxTimeline\.noteSceneSync\?\.\(\)/,
    'geometry delivery extends timeline interaction gating through native settle');
assert.match(sync, /schedulePathTracingLiveRebuild\('transform'\)/);
assert.match(sync, /schedulePathTracingLiveRebuild\('light'\)/,
    'changed light packets use the packed-light lane instead of a BVH rebuild');
assert.match(sync, /const lightChanged = deps\.applyLightData/,
    'unchanged native light packets do not invalidate PT');
assert.match(sync, /transformChanged = applyTransform\(mesh, nd\.t\)/,
    'identical transform packets do not invalidate probes/PT');
assert.match(sync, /maxjsLightCarrier = nd\.lightCarrier === true/,
    'camera-light hierarchy carriers retain their structural full-sync tag');
assert.match(sync, /lightCarrierHasSurfaceDescendant[\s\S]*maxjsLightCarrierHasSurface/,
    'a carrier pays the descendant classification cost only once per full-sync epoch');
assert.match(sync, /hierarchyLightTransformsChanged[\s\S]*scheduleLightProbeFromCurrentScene[\s\S]*pathTraceLightsChanged = true/,
    'inherited light motion invalidates light state without a full light payload');
assert.match(sync, /affectsSurface && change\.transformChanged/,
    'a light-only camera carrier does not masquerade as moving geometry');

const timeline = await read('../web/js/maxjs_timeline.js');
assert.match(timeline, /emitChange\(\{ defer: true \}\);/,
    'paused seek and playback notifications share one rAF mailbox');
assert.doesNotMatch(timeline, /emitChange\(\{ defer: nextPlaying \}\)/);
assert.match(timeline, /function lastUpdateMs\(\)/);
assert.match(timeline, /function noteSceneSync\(\)/);

const boot = await read('../web/js/editor/boot.js');
assert.match(boot, /renderer\.inspector = passiveRendererInspector/,
    'hiding Debug detaches the expensive Three inspector');
assert.match(boot, /renderer\.backend\.trackTimestamp = false/,
    'normal playback cannot retain hidden GPU timestamp tracking');
assert.match(boot, /onRuntimeSceneChanged: \(event\) => \{[\s\S]*?event\?\.type === 'transform'[\s\S]*?queueRuntimeTransformRefresh\(event\);[\s\S]*?return;[\s\S]*?maxjsFx\.markSceneChanged/,
    'runtime pose writes bypass the SSR scene-topology cache refresh');
assert.match(boot, /queueRuntimeTransformRefresh[\s\S]*schedulePathTracingLiveRebuild\('transform'\)/,
    'runtime surface motion keeps the cheap transform-aware tracer invalidation');

const probeGlue = await read('../web/js/editor/light_probe_glue.js');
assert.match(probeGlue, /maxTimeline\?\.playing\?\.\(\) === true[\s\S]*PLAYBACK_RETRY_MS/,
    'probe rebakes wait for playback to stop');

const lights = await read('../web/js/editor/lights.js');
assert.match(lights, /function lightTracePayloadSignature\(/,
    'full and delta light application share a stable PT change signature');
assert.match(lights, /return traceChanged;/,
    'light application reports whether the packed tracer input actually changed');

const tracer = await read('../web/js/editor/path_tracer.js');
assert.match(tracer, /markTransformsDirty\(\) \{ dirty\.transforms = true; \}/);
assert.match(tracer, /markDeformsDirty\(/);
assert.match(tracer, /markLightsDirty\(\) \{ dirty\.lights = true; \}/);
assert.match(tracer, /function refitDeformedGeometry\(\)[\s\S]*bvh\.refit\(\)/,
    'in-place deformation refits the existing BVH instead of rebuilding it');
assert.match(tracer, /maxjsPathTraceVersion === position\.version\) return;/,
    'an unchanged position buffer skips the refit');

console.log('timeline-hitch-source-smoke: OK');
