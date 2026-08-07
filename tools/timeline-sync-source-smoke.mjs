import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const syncSource = readFileSync(new URL('../src/maxjs_panel_sync.inl', import.meta.url), 'utf8');
const callbacksSource = readFileSync(new URL('../src/maxjs_panel_callbacks.inl', import.meta.url), 'utf8');
const hostSource = readFileSync(new URL('../src/maxjs_panel_host.inl', import.meta.url), 'utf8');
const fullSyncSource = readFileSync(new URL('../src/maxjs_panel_fullsync.inl', import.meta.url), 'utf8');
const syncEntrySource = readFileSync(new URL('../src/maxjs_panel_sync_entry.inl', import.meta.url), 'utf8');
const geometrySource = readFileSync(new URL('../src/maxjs_geometry_sync.h', import.meta.url), 'utf8');
const timelineSource = readFileSync(new URL('../web/js/maxjs_timeline.js', import.meta.url), 'utf8');
const protocolHeader = readFileSync(new URL('../src/sync_protocol.h', import.meta.url), 'utf8');
const protocolSource = readFileSync(new URL('../src/sync_protocol.cpp', import.meta.url), 'utf8');

function functionBody(source, signature) {
    const signatureOffset = source.indexOf(signature);
    assert.ok(signatureOffset >= 0, `missing ${signature}`);
    const bodyOffset = source.indexOf('{', signatureOffset + signature.length);
    assert.ok(bodyOffset >= 0, `missing body for ${signature}`);

    let depth = 0;
    for (let i = bodyOffset; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(bodyOffset + 1, i);
        }
    }
    assert.fail(`unterminated body for ${signature}`);
}

const timeChanged = functionBody(syncSource, 'void OnTimelineTimeChanged(TimeValue t)');
for (const forbidden of [
    'MarkAnimatedTransformsDirty',
    'CheckSkinnedGeometryLive',
    'MarkCameraDirtyIfChanged',
    'FlushFastPathNow',
    'SendPlaybackDeltaAtTime',
    'EvalWorldState',
    'PostSharedBufferToScript',
]) {
    assert.doesNotMatch(timeChanged, new RegExp(`\\b${forbidden}\\b`),
        `TimeChanged must not synchronously call ${forbidden}`);
}
assert.match(timeChanged, /QueuePostedTimelineSync\s*\(\s*\)/,
    'TimeChanged queues one deferred timeline flush');

const queuePosted = functionBody(syncSource, 'void QueuePostedTimelineSync()');
assert.match(queuePosted, /playbackFlushPending_\s*=\s*true/,
    'timeline mailbox remains pending until delivery');
assert.match(queuePosted, /playbackFlushPosted_[\s\S]*!hwnd_[\s\S]*!IsWindow\s*\(\s*hwnd_\s*\)[\s\S]*!IsWindowVisible\s*\(\s*hwnd_\s*\)/,
    'timeline posts are coalesced and never target a hidden or invalid HWND');
assert.match(queuePosted, /playbackFlushRetryNotBeforeTick_[\s\S]*now\s*<\s*playbackFlushRetryNotBeforeTick_[\s\S]*return/,
    'timeline transport retry observes its timer deadline');
assert.match(queuePosted, /!IsWindowVisible[\s\S]*playbackFlushRetryNotBeforeTick_\s*=\s*now\s*\+\s*kTransportRetryBackoffMs/,
    'hidden viewport-host mailboxes are backoff paced instead of checked every timer tick');
assert.match(queuePosted, /PostMessage\s*\(\s*hwnd_\s*,\s*WM_PLAYBACK_FLUSH/,
    'timeline mailbox uses the window queue');
assert.match(queuePosted, /playbackFlushPosted_\s*=\s*true/,
    'the posted flag changes only after PostMessage succeeds');

const postedFlush = functionBody(syncSource, 'void FlushPostedPlaybackSync()');
assert.match(postedFlush, /GetCOREInterface\s*\(\s*\)/, 'posted flush samples Max on delivery');
assert.match(postedFlush, /ip->GetTime\s*\(\s*\)/, 'posted flush uses the latest actual Max time');
assert.match(postedFlush, /ip->IsAnimPlaying\s*\(\s*\)\s*!=\s*0/,
    'posted flush uses the latest actual playback state');
assert.match(postedFlush, /SendPlaybackDeltaAtTime\s*\(\s*t\s*,\s*playing\s*\)/,
    'posted flush forwards the sampled state');
assert.match(postedFlush, /result\s*==\s*PlaybackSyncResult::NeedsSlice[\s\S]*QueuePostedTimelineSync\s*\(\s*\)[\s\S]*return;/,
    'only bounded continuation work reposts immediately after yielding');
const retryLaterBranch = postedFlush.slice(postedFlush.indexOf('result == PlaybackSyncResult::RetryLater'));
assert.match(retryLaterBranch, /playbackFlushRetryNotBeforeTick_\s*=\s*now\s*\+\s*kTransportRetryBackoffMs/,
    'transport failure arms timer backoff');
assert.doesNotMatch(retryLaterBranch.slice(0, retryLaterBranch.indexOf('playbackFlushPending_ = false')),
    /QueuePostedTimelineSync\s*\(/,
    'RetryLater cannot create an immediate persistent-transport message loop');

const deltaSend = functionBody(syncSource, 'PlaybackSyncResult SendPlaybackDeltaAtTime(TimeValue t, bool playing)');
assert.match(deltaSend, /visited\s*<\s*kMaxTimelineSnapshotHandlesPerPass/,
    'each playback sampling turn has a hard handle cap');
assert.match(deltaSend, /TimelineBudgetExpired\s*\(\s*passStart\s*\)/,
    'each playback sampling turn also has a wall-clock budget');
// The budget constant now lives inside the shared helper, so pin the
// guarantee there: it must be measured on QPC, not GetTickCount64. That
// clock's granularity is the system timer tick (15.6ms by default), which
// cannot resolve a 4ms budget — a turn measured with it runs until the tick
// rolls over and the "bounded" sweep is not bounded at all.
const budgetHelper = functionBody(syncSource, 'static bool TimelineBudgetExpired(double passStartMs)');
assert.match(budgetHelper, /QpcNowMs\s*\(\s*\)\s*-\s*passStartMs[\s\S]*kTimelineSampleBudgetMs/,
    'the shared timeline budget is measured against the high-resolution clock');
const qpcHelper = functionBody(syncSource, 'static double QpcNowMs()');
assert.match(qpcHelper, /QueryPerformanceCounter/,
    'QpcNowMs is backed by QueryPerformanceCounter');
assert.doesNotMatch(qpcHelper, /GetTickCount64/,
    'QpcNowMs must not fall back to the coarse tick clock');
for (const setName of [
    'helperHandles_', 'geomHandles_', 'lightHandles_',
    'audioHandles_', 'gltfHandles_', 'webappHandles_', 'hairHandles_',
]) {
    assert.doesNotMatch(deltaSend, new RegExp(`for\\s*\\([^)]*:\\s*${setName}`),
        `playback must not rediscover the complete ${setName} set`);
}
assert.doesNotMatch(deltaSend, /SortHandlesByHierarchyDepth/,
    'playback reuses the full-sync epoch hierarchy order');
assert.match(deltaSend, /targetSupersedesActive[\s\S]*\(!playbackSnapshotPlaying_\s*\|\|\s*!playing\)[\s\S]*ResetInProgressPlaybackSnapshot/,
    'Stop and stopped seeks supersede stale in-progress samples');
assert.match(deltaSend, /During continuous[\s\S]*never starve/,
    'continuous playback finishes one atomic sample while coalescing the newest target');
assert.match(deltaSend, /playbackStateSentSerial_\s*!=\s*playbackRequestSerial_[\s\S]*SendTimelineStateOnly[\s\S]*playbackStateSentSerial_\s*=\s*playbackRequestSerial_/,
    'every coalesced request publishes its latest lightweight time/state once');
assert.ok(
    deltaSend.indexOf('playbackStateSentSerial_ != playbackRequestSerial_') <
        deltaSend.indexOf('targetSupersedesActive'),
    'new time/state is delivered even while an older pose snapshot is active',
);
assert.match(deltaSend, /playbackSnapshotFrame_\.UpdateCamera[\s\S]*playbackSnapshotFrame_\.EndFrame/,
    'camera and the complete sampled pose share one finalized frame');
assert.doesNotMatch(deltaSend, /playbackSnapshotFrame_\.UpdateTime/,
    'a completed older pose cannot regress the newer lightweight timeline state');
assert.match(deltaSend, /!playbackSnapshotTransformStageReady_[\s\S]*playbackSnapshotTransforms_\.erase\s*\(\s*playbackSnapshotTransforms_\.begin\s*\(\s*\)\s*\)[\s\S]*kMaxTimelineSnapshotHandlesPerPass/,
    'the inactive transform map is emptied incrementally while retaining buckets');
assert.doesNotMatch(deltaSend, /playbackSnapshotTransforms_\.clear\s*\(\s*\)/,
    'a play/stop turn cannot clear the complete old transform map at once');
assert.match(deltaSend, /CopyAndPostFinalizedPlaybackSnapshot/,
    'playback uses the retained finalized-frame transport');
const playbackCopyForCommit = functionBody(
    syncSource, 'PlaybackSyncResult CopyAndPostFinalizedPlaybackSnapshot()');
assert.ok(
    playbackCopyForCommit.indexOf('PostPreparedSharedDeltaBuffer(') <
        playbackCopyForCommit.indexOf('lastSentTransforms_.swap(playbackSnapshotTransforms_)') &&
    playbackCopyForCommit.indexOf('PostPreparedSharedDeltaBuffer(') <
        playbackCopyForCommit.indexOf('lastSentPlaybackAux_.swap(playbackSnapshotAux_)'),
    'accepted pose atomically advances complete transform and auxiliary baselines',
);
assert.doesNotMatch(deltaSend, /RememberSentTransform|RememberSkippedParentedTransform/,
    'incremental sampling cannot mutate delivered-transform caches');
assert.match(deltaSend, /HasTransformChangedForSync[\s\S]*if\s*\(\s*transformChanged\s*\)[\s\S]*UpdateTransform/,
    'static transforms remain staged but are omitted from the browser payload');
assert.match(deltaSend, /visibilityChanged[\s\S]*if\s*\(\s*visibilityChanged\s*\)[\s\S]*UpdateVisibility/,
    'visibility commands are exact-change filtered');
assert.match(deltaSend, /lightStateChanged[\s\S]*hasLightStateHash[\s\S]*transformChanged\s*\|\|\s*lightStateChanged/,
    'static lights use an exact delivered-state cache instead of dominating each frame');

const stateOnly = functionBody(syncSource, 'bool SendTimelineStateOnly(TimeValue t, bool playing)');
assert.match(stateOnly, /playbackStateFrame_\.Reset[\s\S]*playbackStateFrame_\.UpdateTime\([\s\S]*playing\s*\?\s*0x01\s*:\s*0x00/,
    'the lightweight mailbox packet reports authoritative play/stop state immediately');
assert.doesNotMatch(stateOnly, /DeltaFrameBuilder\s+frame|ReserveBytes/,
    'per-tick time/state delivery reuses preallocated storage');
assert.doesNotMatch(stateOnly, /CreateSharedBuffer/,
    'time-state delivery never allocates a shared buffer on the interaction path');
const timelineOnTime = functionBody(timelineSource, 'function onTime({ ticks, tpf, stateFlags })');
assert.match(timelineOnTime, /emitChange\s*\(\s*\{\s*defer:\s*true\s*\}\s*\)/,
    'time-only packets cannot synchronously run scene listeners against a stale pose');

const sharedDeltaSend = functionBody(syncSource, 'bool SendSharedDeltaFrame(maxjs::sync::DeltaFrameBuilder& frame,');
assert.match(sharedDeltaSend, /frame\.EndFrame\s*\(\s*\)/,
    'ordinary delta frames are finalized once');
assert.match(sharedDeltaSend, /PostSharedDeltaBytes/,
    'ordinary and retryable playback frames share the checked transport');
const postSharedBytes = functionBody(syncSource, 'bool PostSharedDeltaBytes(const std::vector<std::uint8_t>& frameBytes,');
assert.match(postSharedBytes, /PostPreparedSharedDeltaBuffer/,
    'ordinary shared deltas use the checked post helper');
const preparedPost = functionBody(syncSource, 'bool PostPreparedSharedDeltaBuffer(ICoreWebView2SharedBuffer* sharedBuf,');
assert.match(preparedPost, /const HRESULT postResult\s*=\s*wv17->PostSharedBufferToScript/,
    'shared delta delivery observes WebView post failure');
assert.match(preparedPost, /return\s+SUCCEEDED\s*\(\s*postResult\s*\)/,
    'shared delta delivery reports WebView acceptance');

const timer = functionBody(syncSource, 'void OnTimer()');
assert.match(timer, /haveLastPlaybackPollTime_[\s\S]*OnTimelineTimeChanged\s*\(/,
    'timer-detected Stop uses the same coalesced timeline mailbox');
assert.ok(
    timer.indexOf('haveLastPlaybackPollTime_') <
        timer.indexOf('if (dirty_)', timer.indexOf('haveLastPlaybackPollTime_')),
    'timer-detected Stop must run before dirty/full-sync branching',
);
const playbackPump = functionBody(syncSource, 'void PumpPlaybackSyncFromTimer()');
assert.ok(
    playbackPump.indexOf('if (playbackFlushPending_)') <
        playbackPump.indexOf('if (!IsAnimationPlaying())'),
    'a stopped final-pose RetryLater mailbox is still woken by the timer',
);
assert.match(timer, /fullSyncRetryReady[\s\S]*fullSyncRetryNotBeforeTick_[\s\S]*debounceReady\s*&&\s*fullSyncRetryReady/,
    'failed full syncs cannot rerun their complete extraction every timer tick');
assert.match(timer, /slowJsonSyncMode_[\s\S]*dirty_[\s\S]*fullSyncRetryReady[\s\S]*SendFullSync\s*\(\s*\)/,
    'failed explicit JSON full syncs remain retryable in slow-json mode');

const cameraDirty = functionBody(syncSource, 'void MarkCameraDirtyIfChanged(bool respectThrottle = true)');
assert.match(cameraDirty, /lockedCameraHandle_[\s\S]*helperHandles_[\s\S]*fastDirtyHandles_\.insert\s*\(\s*lockedCameraHandle_\s*\)/,
    'a live locked camera updates its transform-only hierarchy carrier in the camera frame');
assert.doesNotMatch(cameraDirty, /lightHandles_|\.UpdateLight\s*\(/,
    'camera motion never scans lights or emits light-state payloads');
assert.doesNotMatch(callbacksSource, /PollHierarchyHoleLightsLive/,
    'redraw callbacks cannot poll every parented light');
assert.doesNotMatch(syncSource, /void\s+PollHierarchyHoleLightsLive\s*\(/,
    'the native sync path has no redraw-time hierarchy-hole light scan');
const collectCameraLightCarriers = functionBody(fullSyncSource, 'void CollectLiveCameraLightCarriers(INode* parent, TimeValue t,');
assert.match(collectCameraLightCarriers, /IsThreeJSLightClassID[\s\S]*IsSceneCameraNode[\s\S]*out\.insert/,
    'only cameras above an actual max.js light enter the live hierarchy');
assert.equal((fullSyncSource.match(/\\\"lightCarrier\\\":true/g) || []).length, 2,
    'JSON and binary live full syncs both tag camera-light hierarchy carriers');
assert.doesNotMatch(hostSource, /playbackFlushTime_/,
    'no stale authored time is retained for a later playback post');
assert.match(hostSource, /maxjs::sync::DeltaFrameBuilder playbackSnapshotFrame_\{0\}/,
    'the atomic frame builder survives across bounded WndProc turns');
assert.match(hostSource, /maxjs::sync::DeltaFrameBuilder playbackStateFrame_\{0\}/,
    'the lightweight time frame also reuses persistent storage');
assert.match(hostSource, /playbackSnapshotTransforms_/,
    'playback transform acknowledgement uses an inactive staging cache');
assert.match(hostSource, /playbackStateSentSerial_/,
    'time-only delivery is tracked independently from slower pose sampling');

const rebuildTimelineCaches = functionBody(syncSource, 'void RebuildTimelineHandleCaches()');
assert.match(rebuildTimelineCaches, /SortHandlesByHierarchyDepth\s*\(\s*playbackSnapshotHandles_/,
    'snapshot candidates are hierarchy ordered once per full-sync epoch');
assert.match(rebuildTimelineCaches, /playbackSnapshotTransforms_\.reserve\s*\(\s*playbackSnapshotHandles_\.size\s*\(\s*\)\s*\)/,
    'the full-sync epoch preallocates the inactive transform cache');
assert.match(rebuildTimelineCaches, /playbackSnapshotFrame_\.ReserveBytes/,
    'the full-sync epoch preallocates the persistent atomic frame buffer');
assert.match(rebuildTimelineCaches, /playbackStateFrame_\.ReserveBytes/,
    'the full-sync epoch preallocates the lightweight time frame');
assert.match(rebuildTimelineCaches, /EnsurePlaybackSharedBuffers\s*\(\s*playbackSnapshotCapacity\s*\)/,
    'the full-sync cache rebuild preallocates playback shared buffers');
assert.match(hostSource, /PlaybackSharedBufferSlot playbackSnapshotSharedBuffers_\s*\[\s*2\s*\]/,
    'finalized pose transport owns a persistent double buffer');
assert.match(hostSource, /PlaybackSharedBufferSlot playbackStateSharedBuffers_\s*\[\s*2\s*\]/,
    'lightweight time transport also avoids interaction-time allocation');
const ensurePlaybackBuffers = functionBody(syncSource, 'bool EnsurePlaybackSharedBuffers(size_t snapshotCapacity)');
assert.match(ensurePlaybackBuffers, /CreateSharedBuffer/,
    'playback shared-buffer allocation is isolated to the full-sync epoch helper');
const copyPlaybackFrame = functionBody(syncSource, 'PlaybackSyncResult CopyAndPostFinalizedPlaybackSnapshot()');
assert.match(copyPlaybackFrame, /copiedThisPass\s*<\s*kTimelineTransportCopyBytesPerPass/,
    'finalized pose copying has a fixed byte cap per posted turn');
assert.match(copyPlaybackFrame, /GetTickCount64\s*\(\s*\)\s*-\s*passStart[\s\S]*kTimelineSampleBudgetMs/,
    'finalized pose copying also has the four-millisecond wall-clock budget');
assert.match(copyPlaybackFrame, /playbackSnapshotCopyOffset_\s*<\s*frameBytes\.size\s*\(\s*\)[\s\S]*PlaybackSyncResult::NeedsSlice[\s\S]*PostPreparedSharedDeltaBuffer/,
    'the shared buffer is posted only after every finalized byte is copied');
assert.match(copyPlaybackFrame, /playbackSnapshotPosted_[\s\S]*return\s+PlaybackSyncResult::Complete/,
    'a post retry reuses the retained completed buffer instead of copying again');
assert.doesNotMatch(copyPlaybackFrame, /CreateSharedBuffer/,
    'finalized playback transport cannot allocate on Play, Stop, or scrub');
const startSnapshot = functionBody(syncSource, 'void StartPlaybackSnapshot(TimeValue t, bool playing, std::uint64_t requestSerial)');
assert.match(startSnapshot, /playbackSnapshotFrame_\.Reset\s*\(\s*frameId\s*\)/,
    'playback reinitializes its persistent builder without replacing capacity');
assert.doesNotMatch(startSnapshot, /ReserveBytes|playbackSnapshotTransforms_\.reserve|DeltaFrameBuilder\s*\(/,
    'Play/Stop cannot trigger whole-scene frame or map reservation');
assert.match(protocolHeader, /void Reset\s*\(\s*std::uint32_t frameId\s*\)/,
    'the wire builder exposes a capacity-preserving reset');
const resetBuilder = functionBody(protocolSource, 'void DeltaFrameBuilder::Reset(std::uint32_t frameId)');
assert.match(resetBuilder, /bytes_\.clear\s*\(\s*\)/,
    'builder reset retains vector capacity');
assert.match(resetBuilder, /commandCount_\s*=\s*0[\s\S]*hasOpenCommand_\s*=\s*false/,
    'builder reset restores command and debug invariants');
const timelineReset = functionBody(syncSource, 'void ResetFastPathState(bool refreshCameraState = false)');
assert.match(timelineReset, /RebuildTimelineHandleCaches\s*\(\s*\)/,
    'successful full-sync reset refreshes playback and deformer candidates');

const deformScan = functionBody(syncSource, 'void CheckSkinnedGeometryLive(bool forceForCurrentTime = false)');
assert.match(deformScan, /timelineDeformScanCursor_\+\+/,
    'timeline deformation owns a persistent fair cursor');
assert.match(deformScan, /visited\s*<\s*kMaxDeformingGeometryHandlesPerTick/,
    'deformation pre-scan has a hard per-turn handle cap');
assert.match(deformScan, /TimelineBudgetExpired\s*\(\s*passStart\s*\)/,
    'deformation pre-scan shares the UI-thread time budget');
assert.match(deformScan, /timelineDeformScanCursor_\s*<\s*timelineDeformHandles_\.size\s*\(\s*\)[\s\S]*pendingTimelineDeformScan_\s*=\s*true/,
    'an incomplete deformation sweep re-arms its pending request');
assert.match(deformScan, /!playing\s*\|\|\s*!timelineDeformScanPlaying_[\s\S]*timelineDeformScanCursor_\s*=\s*0/,
    'the final stopped target restarts an exact full deformer sweep');
assert.doesNotMatch(deformScan, /std::vector<ULONG>\s+deformingHandles/,
    'timeline deformation does not rebuild an all-handle vector per turn');

const consumeTimeline = functionBody(syncSource, 'void ConsumePendingTimelineFastSyncWork()');
assert.match(consumeTimeline, /pendingTimelineTransformScan_[\s\S]*pendingTimelineDeformScan_[\s\S]*QueueFastFlush\s*\(\s*\)/,
    'bounded fallback scans explicitly post their next slice');

assert.match(hostSource, /deformNormalRefreshPendingHandles_/,
    'position-only deform posts retain per-handle normal debt');
assert.match(hostSource, /deformNormalRefreshDueTick_/,
    'normal debt has an explicit settle/retry deadline');
assert.match(hostSource, /deformNormalRefreshQueuedHandle_/,
    'only one pending normal refresh is selected per settle pass');

const normalRecord = functionBody(syncSource, 'void RecordDeformNormalPost(ULONG handle,');
assert.match(normalRecord, /liveNormalsPosted\s*&&\s*SUCCEEDED\s*\(\s*postResult\s*\)/,
    'normal debt clears only after an exact payload is accepted by WebView');
assert.match(normalRecord, /deformNormalRefreshPendingHandles_\.erase\s*\(\s*handle\s*\)/,
    'successful exact delivery clears that handle');
assert.match(normalRecord, /deformNormalRefreshPendingHandles_\.insert\s*\(\s*handle\s*\)/,
    'position-only or failed exact delivery keeps repair debt');
assert.match(normalRecord, /now\s*\+\s*kInteractiveCooldownMs/,
    'normal settle and failed-post retries are cooldown-backed');

const normalQueue = functionBody(syncSource, 'bool QueuePendingDeformNormalRefresh()');
assert.match(normalQueue, /ShouldUseTimelineGeometryFastLane\s*\(\s*\)[\s\S]*ShouldFavorInteractivePerformance\s*\(\s*\)/,
    'normal settle cannot run during playback, timeline scrubbing, or interaction cooldown');
assert.match(normalQueue, /GetTickCount64\s*\(\s*\)\s*<\s*deformNormalRefreshDueTick_/,
    'normal settle waits for its post-time deadline');
assert.match(normalQueue, /deformNormalRefreshQueuedHandle_\s*=\s*refreshHandle/,
    'the settle lane selects one explicit handle');
assert.match(normalQueue, /inspected\s*<\s*kMaxGeometryFastFlushHandlesPerPass/,
    'selecting a settle handle cannot scan the complete pending set');
assert.match(normalQueue, /geoFastDirtyHandles_\.insert\s*\(\s*refreshHandle\s*\)/,
    'settle bypasses sampled-position equality by directly queuing geometry');
assert.doesNotMatch(normalQueue, /lastLiveGeomHash_\s*[.\[]/,
    'settle must not depend on the already-advanced live position hash');

assert.ok(
    timer.indexOf('QueuePendingDeformNormalRefresh()') < timer.indexOf('CheckSkinnedGeometryLive()', timer.indexOf('QueuePendingDeformNormalRefresh()')),
    'due normal settle is queued before the idle deform hash/eval',
);

const geometrySend = functionBody(syncSource, 'void SendGeometryFastUpdate(const std::unordered_set<ULONG>& handles,');
assert.match(geometrySend, /forceLiveNormalRefresh\s*=\s*[\s\S]*deformNormalRefreshQueuedHandle_\s*==\s*handle[\s\S]*normalRefreshDue/,
    'only the explicit due handle can force a normal refresh');
assert.match(geometrySend, /streamLiveNormals\s*=\s*[\s\S]*!preferPositionOnlyDeformSync[\s\S]*!gpuNormalsLive_/,
    'interactive deform sync never invokes CPU live normals');
assert.match(geometrySend, /!sparsePrimed\s*&&\s*!forceLiveNormalRefresh/,
    'forced settle bypasses the unchanged geometry prehash');
assert.match(geometrySend, /!omitFastChannels\s*\|\|\s*forceLiveNormalRefresh/,
    'forced settle overrides compact-channel normal omission');
assert.match(geometrySend, /norms\.empty\s*\(\s*\)\s*\|\|\s*norms\.size\s*\(\s*\)\s*!=\s*verts\.size\s*\(\s*\)[\s\S]*usedSkinnedFastPositions\s*=\s*false/,
    'an incomplete fast-normal extraction falls through to exact extraction');
assert.match(geometrySend, /!usedSkinnedFastPositions\s*&&\s*!forceLiveNormalRefresh[\s\S]*ExtractSkinnedFastPositions/,
    'forced settle cannot fall back to a position-only replay');
assert.match(geometrySend, /liveNormalsExtracted\s*=\s*!payloadNormals\.empty\s*\(\s*\)\s*&&\s*payloadNormals\.size\s*\(\s*\)\s*==\s*payloadVertFloats/,
    'normal completion requires one nonempty normal per render vertex');
// The fused gather writes positions straight into the mapped SharedBuffer and
// leaves `verts` empty, so payloadVerts.size() is no longer the payload count.
// Pin the fallback: without fusion it must still be exactly that vector's size,
// or every size question in the post path silently reads zero.
assert.match(geometrySend, /payloadVertFloats\s*=\s*fusedVertFloats\s*\?\s*fusedVertFloats\s*:\s*payloadVerts\.size\s*\(\s*\)/,
    'payload vertex count falls back to the extracted vector when not fused');
assert.match(geometrySend, /\\"vN\\":"\s*<<\s*payloadVertFloats/,
    'the wire vertex count is the authoritative payload count');
// A failed gather can leave a partially written slot; only a success may
// publish it, otherwise the viewer receives torn positions.
assert.match(geometrySend, /if\s*\(\s*usedSkinnedFastPositions\s*\)\s*\{[\s\S]{0,400}?fusedBuf\s*=\s*candidateBuf/,
    'the fused slot is only published after a successful gather');
assert.ok(
    geometrySend.indexOf('RecordDeformNormalPost(') < geometrySend.indexOf('CreateSharedBuffer('),
    'normal debt is armed before transport allocation can fail',
);
assert.ok((geometrySend.match(/const HRESULT postResult\s*=\s*(?:wv17->PostSharedBufferToScript|webview_->PostWebMessageAsJson)/g) || []).length === 2,
    'both binary and JSON geometry posts expose delivery success');

const resetFastPath = functionBody(syncSource, 'void ResetFastPathState(bool refreshCameraState = false)');
assert.doesNotMatch(resetFastPath, /deformNormalRefresh/,
    'generic fast-path resets must not discard undelivered normal debt');
const jsonFullSync = fullSyncSource.slice(
    fullSyncSource.indexOf('bool SendFullSync()'),
    fullSyncSource.indexOf('void WriteSceneNodes('),
);
const binaryFullSync = fullSyncSource.slice(
    fullSyncSource.indexOf('bool SendFullSyncBinary()'),
    fullSyncSource.indexOf('// ── Transform-only sync'),
);
for (const [name, body] of [['JSON', jsonFullSync], ['binary', binaryFullSync]]) {
    assert.match(body, /FAILED\s*\(\s*scenePostResult\s*\)[\s\S]*HandleFullSyncDeliveryFailure\s*\(\s*\)[\s\S]*return\s+false/,
        `${name} full sync preserves ownership on post failure`);
    assert.ok(
        body.indexOf('FAILED(scenePostResult)') < body.indexOf('ResetFastPathState(true)'),
        `${name} full sync resets fast ownership only after delivery`,
    );
    assert.match(body, /ClearPendingDeformNormalRefresh\s*\(\s*\)[\s\S]*ClearGeometryFastFlushQueue\s*\(\s*\)/,
        `${name} full sync retires delta debt only on success`);
}
assert.match(binaryFullSync, /CreateSharedBuffer[\s\S]*FAILED\s*\(\s*hr\s*\)[\s\S]*HandleFullSyncDeliveryFailure\s*\(\s*\)[\s\S]*return\s+false/,
    'post-collection binary allocation failure invalidates unsent producer caches');
assert.match(binaryFullSync, /get_Buffer[\s\S]*FAILED\s*\(\s*bufferResult\s*\)[\s\S]*HandleFullSyncDeliveryFailure\s*\(\s*\)[\s\S]*return\s+false/,
    'post-collection binary mapping failure cannot enter an unsafe JSON fallback');
const fullSyncFailure = functionBody(syncSource, 'void HandleFullSyncDeliveryFailure()');
assert.match(fullSyncFailure, /lastSentTransforms_\.clear\s*\(\s*\)[\s\S]*haveLastSentCamera_\s*=\s*false/,
    'failed full sync clears false transform and camera acknowledgement');
assert.match(fullSyncFailure, /lastSentPlaybackAux_\.clear\s*\(\s*\)/,
    'failed full sync clears auxiliary visibility, selection, and light acknowledgement');
assert.match(fullSyncFailure, /geoHashMap_\.clear\s*\(\s*\)[\s\S]*deformChannelHashMap_\.clear\s*\(\s*\)/,
    'failed full sync forces retry geometry to include unsent bytes');
assert.match(fullSyncFailure, /SetDirtyImmediate\s*\(\s*false\s*\)[\s\S]*fullSyncRetryNotBeforeTick_[\s\S]*kFullSyncTransportRetryBackoffMs/,
    'failed full sync re-arms dirty ownership with bounded retry backoff');
assert.match(fullSyncFailure, /ResetInProgressPlaybackSnapshot[\s\S]*RebuildTimelineHandleCaches/,
    'failed full sync safely invalidates and rebuilds timeline epoch state');
const canFlushPendingFull = functionBody(syncSource, 'bool CanFlushFastPathDuringPendingFullSync() const');
assert.match(canFlushPendingFull, /fullSyncRetryNotBeforeTick_\s*!=\s*0[\s\S]*return\s+false/,
    'failed full-sync baseline cannot be repopulated by geo-fast before retry');
assert.ok((fullSyncSource.match(/ClearGeometryFastFlushQueue\s*\(\s*\)/g) || []).length === 2,
    'successful full syncs supersede queued geometry deltas');

const ordinaryFastFlush = functionBody(syncSource, 'void FlushFastPath()');
assert.match(ordinaryFastFlush, /restoreConsumedFastWork[\s\S]*fastDirtyHandles_\.insert[\s\S]*materialFastDirtyHandles_\.insert[\s\S]*visibilityDirtyHandles_\.insert[\s\S]*selectionDirtyHandles_\.insert/,
    'ordinary binary failure restores every consumed node/material/visibility/selection owner');
assert.match(ordinaryFastFlush, /deduplicatedVisibilityOwners[\s\S]*visibilityDirtyHandles_\.insert\s*\([\s\S]*deduplicatedVisibilityOwners\.begin/,
    'visibility owners removed only for frame dedupe are still restored on failure');
assert.match(ordinaryFastFlush, /fastCameraDirty_[\s\S]*hasDirtyCamera[\s\S]*fastTimeDirty_[\s\S]*hasDirtyTime/,
    'ordinary binary failure restores consumed camera and time ownership');
assert.match(ordinaryFastFlush, /PostSharedDeltaBytes[\s\S]*restoreConsumedFastWork\s*\(\s*\)[\s\S]*return/,
    'ordinary binary transport failure is observed and requeued');
assert.ok(
    ordinaryFastFlush.indexOf('PostSharedDeltaBytes(') <
        ordinaryFastFlush.indexOf('lastSentTransforms_[handle] = transform'),
    'ordinary transform acknowledgement commits only after a successful post',
);
assert.ok(
    ordinaryFastFlush.indexOf('PostSharedDeltaBytes(') <
        ordinaryFastFlush.indexOf('lastSentCamera_ = stagedCamera'),
    'ordinary camera acknowledgement commits only after a successful post',
);
assert.doesNotMatch(ordinaryFastFlush, /RememberSentTransform\s*\(/,
    'ordinary binary frame construction cannot pre-commit transforms');
assert.doesNotMatch(ordinaryFastFlush, /PostMessage\s*\(\s*hwnd_\s*,\s*WM_FAST_FLUSH/,
    'deferred ordinary batches cannot chain immediate WndProc turns');
const queueFastFlush = functionBody(syncEntrySource, 'void QueueFastFlush()');
assert.match(queueFastFlush, /fastFlushRetryNotBeforeTick_[\s\S]*now\s*<\s*fastFlushRetryNotBeforeTick_[\s\S]*return/,
    'ordinary binary retry is timer/backoff gated');
const hairFastSend = functionBody(syncSource, 'bool SendHairFastUpdate(const std::vector<ULONG>& dirtyHandles)');
assert.match(hairFastSend, /const HRESULT postResult\s*=\s*webview_->PostWebMessageAsJson[\s\S]*return\s+SUCCEEDED\s*\(\s*postResult\s*\)/,
    'hair fast-path delivery reports JSON transport failure');
assert.match(ordinaryFastFlush, /hairTransportFailed[\s\S]*hairHandles_\.find[\s\S]*fastDirtyHandles_\.insert/,
    'failed hair payloads retain dirty ownership for timer-backed retry');

assert.match(syncSource, /kMaxGeometryFastFlushHandlesPerPass\s*=\s*8/,
    'geometry extraction has a fixed per-pass handle cap');
const geometryBatch = functionBody(syncSource, 'void TakeGeometryFastFlushBatch(std::unordered_set<ULONG>& batch,');
assert.match(geometryBatch, /batch\.size\s*\(\s*\)\s*<\s*kMaxGeometryFastFlushHandlesPerPass/,
    'geometry batch size is capped');
assert.match(geometryBatch, /geoFastDirtyHandles_\.erase\s*\(\s*handle\s*\)/,
    'only selected geometry handles leave the owning dirty queue');
assert.doesNotMatch(geometryBatch, /std::vector|std::sort|upper_bound|candidates/,
    'taking a bounded geometry batch cannot copy or sort the complete dirty queue');
assert.match(geometryBatch, /geometryFastFlushNotBeforeTick_\s*=\s*now\s*\+\s*SYNC_INTERVAL_MS/,
    'remaining geometry waits for the next sync-timer cadence');
assert.doesNotMatch(geometryBatch, /PostMessage|QueueFastFlush/,
    'geometry batching cannot chain immediate UI-thread flush messages');
assert.match(timer, /geometryFastFlushNotBeforeTick_[\s\S]*QueueFastFlush\s*\(\s*\)/,
    'the sync timer resumes a due deferred geometry batch');
assert.match(syncEntrySource, /RequestFullGeometryResync[\s\S]*ClearGeometryFastFlushQueue\s*\(\s*\)/,
    'explicit full geometry resync clears obsolete queued deltas');

const extractMesh = functionBody(geometrySource, 'static bool ExtractMesh(INode* node, TimeValue t,');
assert.match(extractMesh, /outFastNormalPlan[\s\S]*outEpoch->valid[\s\S]*normals->size\s*\(\s*\)\s*==\s*verts\.size\s*\(\s*\)[\s\S]*outFastVertexSources->size\s*\(\s*\)\s*\*\s*3\s*==\s*verts\.size\s*\(\s*\)/,
    'full extraction prebuild requires exact normals, matching sources, and a valid topology epoch');
assert.ok((extractMesh.match(/BuildFastNormalPlanFromMNMesh\s*\(/g) || []).length === 2,
    'live and evaluated MNMesh extraction retain a normal plan');
assert.match(extractMesh, /BuildFastNormalPlanFromMesh\s*\(\s*tri->GetMesh\s*\(\s*\)[\s\S]*tri->DeleteThis\s*\(\s*\)/,
    'converted TriObject retains its plan before the evaluated mesh is released');
assert.ok((fullSyncSource.match(/FastNormalPlan fastNormalPlan/g) || []).length === 2,
    'JSON and binary full sync request a retained normal plan');
assert.ok((fullSyncSource.match(/\(isSkinned\s*\|\|\s*hasModifierStack\)\s*\?\s*&fastNormalPlan\s*:\s*nullptr/g) || []).length === 2,
    'normal plans are prebuilt only for deform-capable full-sync meshes');
assert.ok((fullSyncSource.match(/haveFastSources\s*&&\s*fastNormalPlan\.built/g) || []).length === 2,
    'full sync installs only plans that were actually built for the retained sources');
assert.ok((fullSyncSource.match(/guard\.plan\s*=\s*haveBuiltFastNormalPlan[\s\S]{0,100}std::move\s*\(\s*fastNormalPlan\s*\)/g) || []).length === 2,
    'both full-sync protocols retain the built plan instead of resetting it cold');
assert.doesNotMatch(fullSyncSource, /guard\.plan\s*=\s*FastNormalPlan\s*\{\s*\}\s*;/,
    'full sync must not unconditionally discard the prebuilt plan');
assert.match(geometrySend, /\(isDeforming\s*&&\s*extractNormals\)\s*\?\s*&extractedNormalPlan\s*:\s*nullptr/,
    'interactive position-only extraction cannot request a normal-plan build');

console.log('timeline sync source smoke: PASS');
