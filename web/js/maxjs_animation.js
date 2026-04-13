function normalizeBindingPath(path) {
    const raw = String(path ?? '').trim();
    if (!raw) return null;
    if (raw === 'rotationQuaternion') return '.quaternion';
    if (raw === 'fovHorizontal') return '.userData.maxjsHorizontalFov';
    if (raw === 'viewWidth') return '.userData.maxjsViewWidth';
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

function normalizeCustomTrackPath(trackDef) {
    return String(trackDef?.path ?? trackDef?.property ?? '').trim();
}

function getCustomTrackKind(trackDef) {
    const rawPath = normalizeCustomTrackPath(trackDef);
    const type = String(trackDef?.type ?? '').trim().toLowerCase();
    if (type === 'matrix16' || rawPath === 'matrix') return 'matrix16';
    if (type === 'geometryframes' || rawPath === 'geometry') return 'geometry';
    if (/^materials?\[?\d*\]?\.|^material\./.test(rawPath) || rawPath.startsWith('material.') || rawPath.startsWith('materials[')) {
        return 'material';
    }
    if (rawPath === 'visible') return 'boolean';
    if (rawPath === 'position' || rawPath === 'cameraTarget' || rawPath === 'cameraUp') return 'vector3';
    if (rawPath === 'fovHorizontal' || rawPath === 'viewWidth') return 'number';
    return null;
}

function parseMaterialTrackPath(path) {
    const raw = String(path ?? '').trim();
    const multiMatch = /^materials\[(\d+)\]\.(.+)$/.exec(raw);
    if (multiMatch) {
        return { materialIndex: Number(multiMatch[1]), property: multiMatch[2] };
    }
    if (raw.startsWith('material.')) {
        return { materialIndex: null, property: raw.slice('material.'.length) };
    }
    return null;
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
    lightHandleMap,
    getCamera,
    getControls,
    getJsRoot,
    getOverlayRoot,
    getViewportAspect,
    buildGeometry,
    applyMaterialScalar,
}) {
    const targetRegistry = new Map();
    const mixers = new Map();
    const clipGroups = new Map();
    let registryDirty = true;
    let loadedPayload = null;
    let loadedBinary = null;
    const matrixA = new THREE.Matrix4();
    const matrixB = new THREE.Matrix4();
    const matrixSample = new THREE.Matrix4();
    const posA = new THREE.Vector3();
    const posB = new THREE.Vector3();
    const scaleA = new THREE.Vector3();
    const scaleB = new THREE.Vector3();
    const posSample = new THREE.Vector3();
    const scaleSample = new THREE.Vector3();
    const quatA = new THREE.Quaternion();
    const quatB = new THREE.Quaternion();
    const quatSample = new THREE.Quaternion();
    const vectorA = new THREE.Vector3();
    const vectorB = new THREE.Vector3();
    const vectorSample = new THREE.Vector3();

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
        loadedBinary = null;
        const camera = getCamera?.();
        if (camera?.userData) {
            delete camera.userData.maxjsHorizontalFov;
            delete camera.userData.maxjsViewWidth;
            delete camera.userData.maxjsAnimatedTarget;
        }
    }

    function syncAnimatedCamera(camera) {
        if (!camera?.isCamera) return;
        const animatedTarget = camera.userData?.maxjsAnimatedTarget;
        if (animatedTarget?.isVector3) {
            camera.lookAt(animatedTarget);
            const controls = getControls?.();
            if (controls?.target?.copy) controls.target.copy(animatedTarget);
        }

        if (camera.isPerspectiveCamera) {
            const horizontalFov = Number.isFinite(camera.userData?.maxjsHorizontalFov)
                ? camera.userData.maxjsHorizontalFov
                : null;
            if (horizontalFov && horizontalFov > 0 && horizontalFov < 170) {
                const aspect = Math.max(1e-6, getViewportAspect?.() ?? camera.aspect ?? 1);
                const horizontalRad = horizontalFov * Math.PI / 180;
                camera.fov = 2 * Math.atan(Math.tan(horizontalRad / 2) / aspect) * 180 / Math.PI;
            }
            camera.updateProjectionMatrix();
            return;
        }

        if (camera.isOrthographicCamera) {
            const aspect = Math.max(1e-6, getViewportAspect?.() ?? 1);
            const viewWidth = Number.isFinite(camera.userData?.maxjsViewWidth) && camera.userData.maxjsViewWidth > 0
                ? camera.userData.maxjsViewWidth
                : Math.max(1e-3, camera.right - camera.left);
            camera.left = -viewWidth / 2;
            camera.right = viewWidth / 2;
            camera.top = viewWidth / (2 * aspect);
            camera.bottom = -viewWidth / (2 * aspect);
            camera.updateProjectionMatrix();
        }
    }

    function getTrackInterpolation(trackDef) {
        return String(trackDef?.interpolation ?? 'linear').trim().toLowerCase();
    }

    function isStepTrack(trackDef) {
        const interpolation = getTrackInterpolation(trackDef);
        return interpolation === 'step' || interpolation === 'discrete';
    }

    function getGroupDuration(group) {
        return Number.isFinite(group?.duration) && group.duration > 0 ? group.duration : 0;
    }

    function normalizeGroupTime(group, time) {
        const duration = getGroupDuration(group);
        if (!Number.isFinite(time)) return 0;
        if (duration <= 0) return Math.max(0, time);

        const loop = String(group?.loop ?? 'repeat').trim().toLowerCase();
        if (loop === 'once') {
            return Math.min(Math.max(time, 0), duration);
        }
        if (loop === 'pingpong') {
            const cycle = duration * 2;
            let wrapped = ((time % cycle) + cycle) % cycle;
            if (wrapped > duration) wrapped = cycle - wrapped;
            return wrapped;
        }
        return ((time % duration) + duration) % duration;
    }

    function getGroupPlaybackTime(group) {
        const firstEntry = group?.entries?.[0];
        if (firstEntry?.action) {
            group.time = firstEntry.action.time;
            return group.time;
        }
        return Number.isFinite(group?.time) ? group.time : 0;
    }

    function findTrackSegment(times, timeSeconds) {
        const count = Array.isArray(times) ? times.length : 0;
        if (count === 0) return null;
        if (count === 1 || timeSeconds <= times[0]) {
            return { indexA: 0, indexB: 0, alpha: 0 };
        }
        const lastIndex = count - 1;
        if (timeSeconds >= times[lastIndex]) {
            return { indexA: lastIndex, indexB: lastIndex, alpha: 0 };
        }

        let lo = 0;
        let hi = lastIndex;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const value = times[mid];
            if (value === timeSeconds) {
                return { indexA: mid, indexB: mid, alpha: 0 };
            }
            if (value < timeSeconds) lo = mid + 1;
            else hi = mid - 1;
        }

        const indexA = Math.max(0, hi);
        const indexB = Math.min(lastIndex, lo);
        const t0 = times[indexA];
        const t1 = times[indexB];
        const alpha = t1 > t0 ? (timeSeconds - t0) / (t1 - t0) : 0;
        return { indexA, indexB, alpha };
    }

    function readVector3At(values, index, target) {
        const offset = index * 3;
        target.set(
            Number(values[offset] ?? 0),
            Number(values[offset + 1] ?? 0),
            Number(values[offset + 2] ?? 0),
        );
        return target;
    }

    function sampleVectorTrack(trackDef, timeSeconds, target) {
        const times = Array.isArray(trackDef?.times) ? trackDef.times : [];
        const values = Array.isArray(trackDef?.values) ? trackDef.values : [];
        if (times.length === 0 || values.length < times.length * 3) return false;

        const segment = findTrackSegment(times, timeSeconds);
        if (!segment) return false;

        readVector3At(values, segment.indexA, vectorA);
        if (segment.indexA === segment.indexB || isStepTrack(trackDef) || segment.alpha <= 0) {
            target.copy(vectorA);
            return true;
        }

        readVector3At(values, segment.indexB, vectorB);
        target.lerpVectors(vectorA, vectorB, segment.alpha);
        return true;
    }

    function sampleNumberTrack(trackDef, timeSeconds) {
        const times = Array.isArray(trackDef?.times) ? trackDef.times : [];
        const values = Array.isArray(trackDef?.values) ? trackDef.values : [];
        if (times.length === 0 || values.length < times.length) return null;

        const segment = findTrackSegment(times, timeSeconds);
        if (!segment) return null;

        const a = Number(values[segment.indexA] ?? 0);
        if (segment.indexA === segment.indexB || isStepTrack(trackDef) || segment.alpha <= 0) {
            return a;
        }

        const b = Number(values[segment.indexB] ?? a);
        return a + (b - a) * segment.alpha;
    }

    function sampleBooleanTrack(trackDef, timeSeconds) {
        const times = Array.isArray(trackDef?.times) ? trackDef.times : [];
        const values = Array.isArray(trackDef?.values) ? trackDef.values : [];
        if (times.length === 0 || values.length < times.length) return null;

        const segment = findTrackSegment(times, timeSeconds);
        if (!segment) return null;
        return !!values[segment.indexA];
    }

    function readBinaryFloatArray(offset, count) {
        if (!(loadedBinary instanceof ArrayBuffer)) return null;
        if (!Number.isInteger(offset) || !Number.isInteger(count) || offset < 0 || count < 0) return null;
        if ((offset % 4) !== 0 || (offset + count * 4) > loadedBinary.byteLength) return null;
        return new Float32Array(loadedBinary.slice(offset, offset + count * 4));
    }

    function readBinaryIndexArray(offset, count) {
        if (!(loadedBinary instanceof ArrayBuffer)) return null;
        if (!Number.isInteger(offset) || !Number.isInteger(count) || offset < 0 || count < 0) return null;
        if ((offset % 4) !== 0 || (offset + count * 4) > loadedBinary.byteLength) return null;
        return new Uint32Array(loadedBinary.slice(offset, offset + count * 4));
    }

    function sampleGeometryFrame(trackDef, timeSeconds) {
        const times = Array.isArray(trackDef?.times) ? trackDef.times : [];
        const frames = Array.isArray(trackDef?.frames) ? trackDef.frames : [];
        if (times.length === 0 || frames.length < times.length) return null;

        const segment = findTrackSegment(times, timeSeconds);
        if (!segment) return null;
        return frames[segment.indexA] ?? null;
    }

    function sampleMatrixTrack(trackDef, timeSeconds, targetMatrix) {
        const times = Array.isArray(trackDef?.times) ? trackDef.times : [];
        const values = Array.isArray(trackDef?.values) ? trackDef.values : [];
        if (times.length === 0 || values.length < times.length * 16) return false;

        const segment = findTrackSegment(times, timeSeconds);
        if (!segment) return false;

        matrixA.fromArray(values, segment.indexA * 16);
        if (segment.indexA === segment.indexB || isStepTrack(trackDef) || segment.alpha <= 0) {
            targetMatrix.copy(matrixA);
            return true;
        }

        matrixB.fromArray(values, segment.indexB * 16);
        matrixA.decompose(posA, quatA, scaleA);
        matrixB.decompose(posB, quatB, scaleB);
        posSample.lerpVectors(posA, posB, segment.alpha);
        scaleSample.lerpVectors(scaleA, scaleB, segment.alpha);
        quatSample.copy(quatA).slerp(quatB, segment.alpha);
        targetMatrix.compose(posSample, quatSample, scaleSample);
        return true;
    }

    function applyGeometryFrame(target, frame) {
        if (!target?.geometry || typeof buildGeometry !== 'function' || !frame) return;
        if (target.userData?.maxjsSkinRig) return;

        const isLineTarget = !!(target.isLine || target.isLineSegments);
        if (!!frame.spline !== isLineTarget) return;

        const vertices = readBinaryFloatArray(frame.vOff, frame.vN);
        const indices = readBinaryIndexArray(frame.iOff, frame.iN);
        if (!vertices || !indices) return;

        const uvs = frame.uvOff != null && frame.uvN ? readBinaryFloatArray(frame.uvOff, frame.uvN) : null;
        const normals = frame.nOff != null && frame.nN ? readBinaryFloatArray(frame.nOff, frame.nN) : null;
        const geometry = target.geometry;

        const currentPosition = geometry.getAttribute('position');
        if (currentPosition?.array?.length === vertices.length) {
            currentPosition.copyArray(vertices);
            currentPosition.needsUpdate = true;
        } else {
            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        }

        const currentIndex = geometry.getIndex();
        if (currentIndex?.array?.length === indices.length) {
            currentIndex.copyArray(indices);
            currentIndex.needsUpdate = true;
        } else {
            geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        }

        if (uvs) {
            const currentUv = geometry.getAttribute('uv');
            if (currentUv?.array?.length === uvs.length) {
                currentUv.copyArray(uvs);
                currentUv.needsUpdate = true;
            } else {
                geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            }
        } else if (geometry.getAttribute('uv')) {
            geometry.deleteAttribute('uv');
        }

        if (normals && !frame.spline) {
            const currentNormal = geometry.getAttribute('normal');
            if (currentNormal?.array?.length === normals.length) {
                currentNormal.copyArray(normals);
                currentNormal.needsUpdate = true;
            } else {
                geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
            }
        } else {
            if (geometry.getAttribute('normal')) {
                geometry.deleteAttribute('normal');
            }
            if (!frame.spline) {
                geometry.computeVertexNormals();
                const recomputedNormal = geometry.getAttribute('normal');
                if (recomputedNormal) recomputedNormal.needsUpdate = true;
            }
        }

        if (Array.isArray(frame.groups)) {
            geometry.clearGroups();
            for (const group of frame.groups) {
                if (!Array.isArray(group) || group.length < 3) continue;
                geometry.addGroup(group[0], group[1], group[2]);
            }
        }
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
    }

    function applyMaterialTrack(target, path, kind, trackDef, timeSeconds) {
        if (typeof applyMaterialScalar !== 'function') return;
        const binding = parseMaterialTrackPath(path);
        if (!binding) return;

        let payload = null;
        if (kind === 'vector3') {
            if (!sampleVectorTrack(trackDef, timeSeconds, vectorSample)) return;
            payload = {
                [binding.property]: [vectorSample.x, vectorSample.y, vectorSample.z],
            };
        } else if (kind === 'number') {
            const value = sampleNumberTrack(trackDef, timeSeconds);
            if (!Number.isFinite(value)) return;
            payload = { [binding.property]: value };
        } else if (kind === 'boolean') {
            const value = sampleBooleanTrack(trackDef, timeSeconds);
            if (value == null) return;
            payload = { [binding.property]: value };
        }

        if (payload) {
            applyMaterialScalar(target, payload, binding.materialIndex);
        }
    }

    function applyCustomEntry(entry, timeSeconds) {
        const { target, kind, path, trackDef } = entry;
        if (!target) return;

        switch (kind) {
            case 'matrix16':
                if (sampleMatrixTrack(trackDef, timeSeconds, matrixSample)) {
                    target.matrixAutoUpdate = false;
                    target.matrix.copy(matrixSample);
                    target.matrix.decompose(target.position, target.quaternion, target.scale);
                    target.matrixWorldNeedsUpdate = true;
                }
                break;
            case 'boolean': {
                const visible = sampleBooleanTrack(trackDef, timeSeconds);
                if (visible != null && path === 'visible') target.visible = visible;
                break;
            }
            case 'geometry': {
                const frame = sampleGeometryFrame(trackDef, timeSeconds);
                if (frame) applyGeometryFrame(target, frame);
                break;
            }
            case 'material':
                applyMaterialTrack(target, path, normalizeTrackType(trackDef?.type, path), trackDef, timeSeconds);
                break;
            case 'vector3':
                if (!sampleVectorTrack(trackDef, timeSeconds, vectorSample)) break;
                if (path === 'position') {
                    target.position.copy(vectorSample);
                    target.matrixWorldNeedsUpdate = true;
                } else if (path === 'cameraTarget') {
                    const lookTarget = target.userData.maxjsAnimatedTarget instanceof THREE.Vector3
                        ? target.userData.maxjsAnimatedTarget
                        : (target.userData.maxjsAnimatedTarget = new THREE.Vector3());
                    lookTarget.copy(vectorSample);
                } else if (path === 'cameraUp') {
                    target.up.copy(vectorSample).normalize();
                    target.matrixWorldNeedsUpdate = true;
                }
                break;
            case 'number': {
                const value = sampleNumberTrack(trackDef, timeSeconds);
                if (!Number.isFinite(value)) break;
                if (path === 'fovHorizontal') target.userData.maxjsHorizontalFov = value;
                else if (path === 'viewWidth') target.userData.maxjsViewWidth = value;
                break;
            }
        }
    }

    function applyCustomEntries() {
        for (const group of clipGroups.values()) {
            if (!group.customEntries.length) continue;
            const timeSeconds = getGroupPlaybackTime(group);
            for (const entry of group.customEntries) {
                applyCustomEntry(entry, timeSeconds);
            }
        }
    }

    function syncAnimatedTargets() {
        applyCustomEntries();
        const activeCamera = getCamera?.();
        if (activeCamera) syncAnimatedCamera(activeCamera);
    }

    function applyInstantPose() {
        for (const mixer of mixers.values()) {
            mixer.update(0);
        }
        syncAnimatedTargets();
    }

    function rebuildTargetRegistry() {
        targetRegistry.clear();

        for (const [handle, object] of nodeMap.entries()) {
            if (object) targetRegistry.set(`handle:${handle}`, object);
        }

        // Include lights for animation (lights may have animated parent transforms)
        if (lightHandleMap) {
            for (const [handle, light] of lightHandleMap.entries()) {
                if (light) targetRegistry.set(`handle:${handle}`, light);
            }
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
                customEntries: [],
                speed: Number.isFinite(clipState?.speed) ? clipState.speed : (clipDef?.speed ?? 1),
                playing: clipState?.playing ?? (clipDef?.autoPlay !== false),
                loop: clipDef?.loop ?? 'repeat',
                duration: Number.isFinite(clipDef?.duration)
                    ? clipDef.duration
                    : (Number.isFinite(clipDef?.end) && Number.isFinite(clipDef?.start)
                        ? Math.max(0, clipDef.end - clipDef.start)
                        : -1),
                time: Number.isFinite(clipState?.time)
                    ? clipState.time
                    : (Number.isFinite(clipDef?.time)
                        ? clipDef.time
                        : (Number.isFinite(clipDef?.start) ? clipDef.start : 0)),
            };

            for (const targetDef of (Array.isArray(clipDef?.targets) ? clipDef.targets : [])) {
                const targetId = String(targetDef?.target || '');
                const target = targetRegistry.get(targetId);
                if (!target) continue;

                const tracks = [];
                for (const trackDef of (Array.isArray(targetDef?.tracks) ? targetDef.tracks : [])) {
                    const customKind = getCustomTrackKind(trackDef);
                    if (customKind) {
                        group.customEntries.push({
                            targetId,
                            target,
                            trackDef,
                            path: normalizeCustomTrackPath(trackDef),
                            kind: customKind,
                        });
                        continue;
                    }
                    const track = createTrack(THREE, trackDef);
                    if (track) tracks.push(track);
                }
                if (tracks.length === 0) continue;

                const clip = new THREE.AnimationClip(group.name, group.duration, tracks);
                const mixer = getMixer(target);
                const action = mixer.clipAction(clip);
                applyLoopMode(THREE, action, clipDef);
                action.enabled = true;
                action.paused = !group.playing;
                action.timeScale = group.speed;
                action.play();
                action.time = group.time;

                group.entries.push({ targetId, clip, mixer, action });
            }

            if (group.entries.length > 0 || group.customEntries.length > 0) {
                clipGroups.set(clipId, group);
                clipCount += 1;
            }
        }

        applyInstantPose();
        return { clipCount, targetCount: targetRegistry.size };
    }

    function loadSnapshotAnimations(payload, binaryBuffer = null) {
        if (registryDirty) rebuildTargetRegistry();
        clear();
        loadedBinary = binaryBuffer instanceof ArrayBuffer ? binaryBuffer : null;
        return mountPayload(payload);
    }

    function refreshTargets() {
        const playbackState = capturePlaybackState();
        const binaryBuffer = loadedBinary;
        rebuildTargetRegistry();
        clear();
        loadedBinary = binaryBuffer;
        return mountPayload(loadedPayload, playbackState);
    }

    function invalidateTargets() {
        registryDirty = true;
    }

    function isDrivingSceneCamera() {
        for (const group of clipGroups.values()) {
            if (!group.playing) continue;
            for (const entry of group.customEntries) {
                if (entry.targetId === 'camera:active') return true;
            }
        }
        return false;
    }

    function update(deltaSeconds) {
        if (registryDirty) refreshTargets();
        if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
            syncAnimatedTargets();
            return;
        }
        for (const mixer of mixers.values()) {
            mixer.update(deltaSeconds);
        }
        for (const group of clipGroups.values()) {
            if (group.entries.length > 0 || !group.playing) continue;
            group.time = normalizeGroupTime(group, group.time + deltaSeconds * group.speed);
        }
        syncAnimatedTargets();
    }

    function setClipPlaying(clipId, playing) {
        const group = clipGroups.get(clipId);
        if (!group) return false;
        group.playing = !!playing;
        for (const entry of group.entries) {
            entry.action.paused = !group.playing;
            if (group.playing && !entry.action.isRunning()) entry.action.play();
        }
        applyInstantPose();
        return true;
    }

    function setClipTime(clipId, timeSeconds) {
        const group = clipGroups.get(clipId);
        if (!group || !Number.isFinite(timeSeconds)) return false;
        group.time = normalizeGroupTime(group, timeSeconds);
        for (const entry of group.entries) {
            entry.action.time = group.time;
        }
        applyInstantPose();
        return true;
    }

    function setClipSpeed(clipId, speed) {
        const group = clipGroups.get(clipId);
        if (!group || !Number.isFinite(speed)) return false;
        group.speed = speed;
        for (const entry of group.entries) {
            entry.action.timeScale = speed;
        }
        syncAnimatedTargets();
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

    function seekAllClips(timeSeconds) {
        if (!Number.isFinite(timeSeconds)) return false;
        for (const group of clipGroups.values()) {
            group.time = normalizeGroupTime(group, timeSeconds);
            for (const entry of group.entries) {
                entry.action.time = group.time;
            }
        }
        applyInstantPose();
        return true;
    }

    function restorePlaybackState(stateByClip) {
        if (!(stateByClip instanceof Map)) return false;
        for (const [clipId, playback] of stateByClip.entries()) {
            const group = clipGroups.get(clipId);
            if (!group) continue;
            if (Number.isFinite(playback.time)) {
                group.time = normalizeGroupTime(group, playback.time);
                for (const entry of group.entries) {
                    entry.action.time = group.time;
                }
            }
            if (Number.isFinite(playback.speed)) {
                group.speed = playback.speed;
                for (const entry of group.entries) {
                    entry.action.timeScale = playback.speed;
                }
            }
            if (typeof playback.playing === 'boolean') {
                group.playing = playback.playing;
                for (const entry of group.entries) {
                    entry.action.paused = !group.playing;
                    if (group.playing && !entry.action.isRunning()) entry.action.play();
                }
            }
        }
        applyInstantPose();
        return true;
    }

    return {
        rebuildTargetRegistry,
        refreshTargets,
        invalidateTargets,
        isDrivingSceneCamera,
        loadSnapshotAnimations,
        update,
        clear,
        setClipPlaying,
        setClipTime,
        setClipSpeed,
        seekAllClips,
        capturePlaybackState,
        restorePlaybackState,
        getState,
    };
}
