function normalizeBindingPath(path) {
    const raw = String(path ?? '').trim();
    if (!raw) return null;
    if (raw === 'rotationQuaternion') return '.quaternion';
    return raw.startsWith('.') ? raw : `.${raw}`;
}

function normalizeTrackType(trackType, bindingPath) {
    const type = String(trackType ?? '').trim().toLowerCase();
    if (type) return type;

    if (bindingPath === '.position' || bindingPath === '.scale') return 'vector3';
    if (bindingPath === '.quaternion') return 'quaternion';
    if (bindingPath === '.visible') return 'boolean';
    if (bindingPath.endsWith('.color') || bindingPath.endsWith('.emissive')) return 'color';
    return 'number';
}

function toInterpolation(THREE, interpolation) {
    switch (String(interpolation ?? '').trim().toLowerCase()) {
        case 'step':
        case 'discrete':
            return THREE.InterpolateDiscrete;
        case 'cubic':
        case 'smooth':
        case 'spline':
            return THREE.InterpolateSmooth;
        default:
            return THREE.InterpolateLinear;
    }
}

function createTrack(THREE, trackDef) {
    const bindingPath = normalizeBindingPath(trackDef?.path ?? trackDef?.property);
    if (!bindingPath) return null;

    const times = Array.isArray(trackDef?.times) ? trackDef.times : [];
    const values = Array.isArray(trackDef?.values) ? trackDef.values : [];
    if (times.length === 0 || values.length === 0) return null;

    const type = normalizeTrackType(trackDef?.type, bindingPath);
    let track = null;
    switch (type) {
        case 'vector3':
            track = new THREE.VectorKeyframeTrack(bindingPath, times, values);
            break;
        case 'quaternion':
            track = new THREE.QuaternionKeyframeTrack(bindingPath, times, values);
            break;
        case 'color':
            track = new THREE.ColorKeyframeTrack(bindingPath, times, values);
            break;
        case 'boolean':
        case 'bool':
            track = new THREE.BooleanKeyframeTrack(bindingPath, times, values);
            break;
        default:
            track = new THREE.NumberKeyframeTrack(bindingPath, times, values);
            break;
    }

    track.setInterpolation(toInterpolation(THREE, trackDef?.interpolation));
    return track;
}

function applyLoopMode(THREE, action, clipDef) {
    const loop = String(clipDef?.loop ?? 'repeat').trim().toLowerCase();
    if (loop === 'once') {
        action.setLoop(THREE.LoopOnce, 0);
    } else if (loop === 'pingpong') {
        action.setLoop(THREE.LoopPingPong, clipDef?.repetitions ?? Infinity);
    } else {
        action.setLoop(THREE.LoopRepeat, clipDef?.repetitions ?? Infinity);
    }
    action.clampWhenFinished = clipDef?.clampWhenFinished !== false;
}

function collectRuntimeTargets(root, registry) {
    if (!root?.traverse) return;
    root.traverse(object => {
        const snapshotId = object?.userData?.maxjsSnapshotId;
        if (typeof snapshotId === 'string' && snapshotId) {
            registry.set(snapshotId, object);
        }
    });
}

export function createMaxJSAnimationSystem({
    THREE,
    nodeMap,
    getCamera,
    getJsRoot,
    getOverlayRoot,
}) {
    const targetRegistry = new Map();
    const mixers = new Map();
    const clipGroups = new Map();
    let registryDirty = true;
    let loadedPayload = null;

    function getMixer(target) {
        let mixer = mixers.get(target);
        if (!mixer) {
            mixer = new THREE.AnimationMixer(target);
            mixers.set(target, mixer);
        }
        return mixer;
    }

    function capturePlaybackState() {
        const stateByClip = new Map();
        for (const [clipId, group] of clipGroups.entries()) {
            const firstEntry = group.entries[0];
            stateByClip.set(clipId, {
                time: firstEntry?.action?.time ?? 0,
                playing: group.playing,
                speed: group.speed,
            });
        }
        return stateByClip;
    }

    function clear() {
        for (const group of clipGroups.values()) {
            for (const entry of group.entries) {
                entry.action.stop();
                entry.mixer.uncacheClip(entry.clip);
            }
        }
        clipGroups.clear();
        mixers.clear();
    }

    function rebuildTargetRegistry() {
        targetRegistry.clear();

        for (const [handle, object] of nodeMap.entries()) {
            if (object) targetRegistry.set(`handle:${handle}`, object);
        }

        const camera = getCamera?.();
        if (camera) targetRegistry.set('camera:active', camera);

        collectRuntimeTargets(getJsRoot?.(), targetRegistry);
        collectRuntimeTargets(getOverlayRoot?.(), targetRegistry);

        registryDirty = false;
        return targetRegistry;
    }

    function mountPayload(payload, stateByClip = new Map()) {
        loadedPayload = payload ?? null;
        if (!payload || !Array.isArray(payload.clips)) {
            return { clipCount: 0, targetCount: targetRegistry.size };
        }

        let clipCount = 0;
        for (const clipDef of payload.clips) {
            const clipId = String(clipDef?.id || clipDef?.name || `clip_${clipCount}`);
            const clipState = stateByClip.get(clipId);
            const group = {
                id: clipId,
                name: clipDef?.name || clipId,
                entries: [],
                speed: Number.isFinite(clipState?.speed) ? clipState.speed : (clipDef?.speed ?? 1),
                playing: clipState?.playing ?? (clipDef?.autoPlay !== false),
            };

            for (const targetDef of (Array.isArray(clipDef?.targets) ? clipDef.targets : [])) {
                const targetId = String(targetDef?.target || '');
                const target = targetRegistry.get(targetId);
                if (!target) continue;

                const tracks = [];
                for (const trackDef of (Array.isArray(targetDef?.tracks) ? targetDef.tracks : [])) {
                    const track = createTrack(THREE, trackDef);
                    if (track) tracks.push(track);
                }
                if (tracks.length === 0) continue;

                const duration = Number.isFinite(clipDef?.duration)
                    ? clipDef.duration
                    : (Number.isFinite(clipDef?.end) && Number.isFinite(clipDef?.start)
                        ? Math.max(0, clipDef.end - clipDef.start)
                        : -1);

                const clip = new THREE.AnimationClip(group.name, duration, tracks);
                const mixer = getMixer(target);
                const action = mixer.clipAction(clip);
                applyLoopMode(THREE, action, clipDef);
                action.enabled = true;
                action.paused = !group.playing;
                action.timeScale = group.speed;
                action.play();
                if (Number.isFinite(clipState?.time)) {
                    action.time = clipState.time;
                } else if (Number.isFinite(clipDef?.start) && clipDef.start > 0) {
                    action.time = clipDef.start;
                }

                group.entries.push({ targetId, clip, mixer, action });
            }

            if (group.entries.length > 0) {
                clipGroups.set(clipId, group);
                clipCount += 1;
            }
        }

        return { clipCount, targetCount: targetRegistry.size };
    }

    function loadSnapshotAnimations(payload) {
        if (registryDirty) rebuildTargetRegistry();
        clear();
        return mountPayload(payload);
    }

    function refreshTargets() {
        const playbackState = capturePlaybackState();
        rebuildTargetRegistry();
        clear();
        return mountPayload(loadedPayload, playbackState);
    }

    function invalidateTargets() {
        registryDirty = true;
    }

    function update(deltaSeconds) {
        if (registryDirty) refreshTargets();
        if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
        for (const mixer of mixers.values()) {
            mixer.update(deltaSeconds);
        }
    }

    function setClipPlaying(clipId, playing) {
        const group = clipGroups.get(clipId);
        if (!group) return false;
        group.playing = !!playing;
        for (const entry of group.entries) {
            entry.action.paused = !group.playing;
            if (group.playing && !entry.action.isRunning()) entry.action.play();
        }
        return true;
    }

    function setClipTime(clipId, timeSeconds) {
        const group = clipGroups.get(clipId);
        if (!group || !Number.isFinite(timeSeconds)) return false;
        for (const entry of group.entries) {
            entry.action.time = timeSeconds;
        }
        return true;
    }

    function setClipSpeed(clipId, speed) {
        const group = clipGroups.get(clipId);
        if (!group || !Number.isFinite(speed)) return false;
        group.speed = speed;
        for (const entry of group.entries) {
            entry.action.timeScale = speed;
        }
        return true;
    }

    function getState() {
        return {
            targetCount: targetRegistry.size,
            clipCount: clipGroups.size,
            loaded: !!loadedPayload,
            clips: [...clipGroups.values()].map(group => ({
                id: group.id,
                name: group.name,
                targets: group.entries.length,
                playing: group.playing,
                speed: group.speed,
            })),
        };
    }

    return {
        rebuildTargetRegistry,
        refreshTargets,
        invalidateTargets,
        loadSnapshotAnimations,
        update,
        clear,
        setClipPlaying,
        setClipTime,
        setClipSpeed,
        getState,
    };
}
