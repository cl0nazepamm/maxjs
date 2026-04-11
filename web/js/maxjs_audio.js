export function createMaxJSAudioSystem({ THREE, parent, getActiveCamera }) {
    const audioRoot = new THREE.Group();
    audioRoot.name = '__maxjs_audio_origins__';
    audioRoot.visible = false;
    audioRoot.matrixAutoUpdate = false;
    audioRoot.userData.maxjsExcludeFromRuntimeSnapshot = true;
    parent?.add?.(audioRoot);

    const entryMap = new Map();
    const bufferCache = new Map();

    const listenerPosition = new THREE.Vector3();
    const listenerForward = new THREE.Vector3();
    const listenerUp = new THREE.Vector3(0, 1, 0);
    const listenerQuaternion = new THREE.Quaternion();
    const sourcePosition = new THREE.Vector3();

    let context = null;
    let masterGain = null;
    let activationArmed = false;
    let muted = false;

    function getAudioContextCtor() {
        return window.AudioContext || window.webkitAudioContext || null;
    }

    function removeActivationHandlers() {
        if (!activationArmed) return;
        activationArmed = false;
        window.removeEventListener('pointerdown', handleUserActivation, true);
        window.removeEventListener('touchstart', handleUserActivation, true);
        window.removeEventListener('keydown', handleUserActivation, true);
    }

    function armActivationHandlers() {
        if (activationArmed) return;
        activationArmed = true;
        window.addEventListener('pointerdown', handleUserActivation, true);
        window.addEventListener('touchstart', handleUserActivation, true);
        window.addEventListener('keydown', handleUserActivation, true);
    }

    async function handleUserActivation() {
        const ctx = ensureContext();
        if (!ctx) {
            removeActivationHandlers();
            return;
        }
        try {
            if (ctx.state !== 'running') await ctx.resume();
        } catch (_) {
        }
        if (ctx.state === 'running') {
            removeActivationHandlers();
            for (const entry of entryMap.values()) {
                syncEntryPlayback(entry, true);
            }
        }
    }

    function ensureContext() {
        if (context) return context;

        const AudioContextCtor = getAudioContextCtor();
        if (!AudioContextCtor) return null;

        context = new AudioContextCtor();
        masterGain = context.createGain();
        masterGain.gain.value = muted ? 0 : 1;
        masterGain.connect(context.destination);
        armActivationHandlers();
        return context;
    }

    function setAudioParam(target, x, y, z) {
        if (!target) return;
        if ('positionX' in target && target.positionX) {
            target.positionX.setValueAtTime(x, context.currentTime);
            target.positionY.setValueAtTime(y, context.currentTime);
            target.positionZ.setValueAtTime(z, context.currentTime);
        } else if (typeof target.setPosition === 'function') {
            target.setPosition(x, y, z);
        }
    }

    function setOrientationParam(target, x, y, z, upX, upY, upZ) {
        if (!target) return;
        if ('forwardX' in target && target.forwardX) {
            target.forwardX.setValueAtTime(x, context.currentTime);
            target.forwardY.setValueAtTime(y, context.currentTime);
            target.forwardZ.setValueAtTime(z, context.currentTime);
            target.upX.setValueAtTime(upX, context.currentTime);
            target.upY.setValueAtTime(upY, context.currentTime);
            target.upZ.setValueAtTime(upZ, context.currentTime);
        } else if (typeof target.setOrientation === 'function') {
            target.setOrientation(x, y, z, upX, upY, upZ);
        }
    }

    function clampCrossfade(entry) {
        const duration = entry.buffer?.duration ?? 0;
        if (!(duration > 0)) return 0;
        const requested = Number(entry.data?.crossfade) || 0;
        return Math.max(0, Math.min(requested / 1000, duration * 0.45));
    }

    function disconnectSourceRecord(record) {
        try {
            record.source?.disconnect?.();
        } catch (_) {
        }
        try {
            record.gain?.disconnect?.();
        } catch (_) {
        }
    }

    function stopSourceRecord(record) {
        if (!record) return;
        try {
            if (record.source) record.source.onended = null;
            record.source?.stop?.(0);
        } catch (_) {
        }
        disconnectSourceRecord(record);
    }

    function stopPlayback(entry, { clearOneShot = false } = {}) {
        if (!entry) return;

        if (entry.loopTimer) {
            clearTimeout(entry.loopTimer);
            entry.loopTimer = 0;
        }

        for (const record of entry.activeSources) {
            stopSourceRecord(record);
        }
        entry.activeSources.clear();
        entry.isLooping = false;

        if (clearOneShot) {
            entry.oneShotSignature = '';
        }
    }

    function updateEntryGain(entry) {
        if (!context || !entry?.outputGain) return;
        const target = entry.visible ? Math.max(0, Number(entry.data?.volume) || 0) : 0;
        entry.outputGain.gain.cancelScheduledValues(context.currentTime);
        entry.outputGain.gain.setTargetAtTime(target, context.currentTime, 0.03);
    }

    function addSourceRecord(entry, source, gain) {
        const record = { source, gain };
        entry.activeSources.add(record);
        source.onended = () => {
            entry.activeSources.delete(record);
            disconnectSourceRecord(record);
        };
        return record;
    }

    function createSource(entry) {
        if (!context || !entry.buffer) return null;
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = entry.buffer;
        source.connect(gain);
        gain.connect(entry.outputGain);
        return { source, gain };
    }

    function scheduleLoopSource(entry, startTime, immediateStart = false) {
        if (!context || !entry.buffer || !entry.data?.loop || !entry.visible) return;

        const sourcePair = createSource(entry);
        if (!sourcePair) return;

        const duration = entry.buffer.duration;
        const crossfade = clampCrossfade(entry);
        const fadeStart = Math.max(startTime, startTime + duration - crossfade);

        if (crossfade > 0 && !immediateStart) {
            sourcePair.gain.gain.setValueAtTime(0, startTime);
            sourcePair.gain.gain.linearRampToValueAtTime(1, startTime + crossfade);
        } else {
            sourcePair.gain.gain.setValueAtTime(1, startTime);
        }

        if (crossfade > 0) {
            sourcePair.gain.gain.setValueAtTime(1, fadeStart);
            sourcePair.gain.gain.linearRampToValueAtTime(0, startTime + duration);
        }

        addSourceRecord(entry, sourcePair.source, sourcePair.gain);
        sourcePair.source.start(startTime);
        sourcePair.source.stop(startTime + duration + 0.05);
        entry.isLooping = true;

        const nextDelayMs = Math.max(0, ((duration - crossfade) * 1000) - 20);
        if (entry.loopTimer) clearTimeout(entry.loopTimer);
        entry.loopTimer = window.setTimeout(() => {
            if (!entryMap.has(entry.handle)) return;
            if (!entry.visible || !entry.data?.loop) return;
            scheduleLoopSource(entry, startTime + Math.max(duration - crossfade, 0.01), false);
        }, nextDelayMs);
    }

    function startLoopPlayback(entry) {
        if (!context || !entry.buffer || !entry.visible) return;
        stopPlayback(entry);
        scheduleLoopSource(entry, context.currentTime + 0.02, true);
    }

    function startOneShotPlayback(entry, signature) {
        if (!context || !entry.buffer || !entry.visible) return;
        stopPlayback(entry);

        const sourcePair = createSource(entry);
        if (!sourcePair) return;

        sourcePair.gain.gain.setValueAtTime(1, context.currentTime);
        addSourceRecord(entry, sourcePair.source, sourcePair.gain);
        sourcePair.source.start(context.currentTime + 0.02);
        entry.oneShotSignature = signature;
    }

    function syncEntryPlayback(entry, forceRestart = false) {
        if (!entry?.data?.url || !entry.buffer || !entry.visible) {
            stopPlayback(entry, { clearOneShot: true });
            updateEntryGain(entry);
            return;
        }

        const ctx = ensureContext();
        if (!ctx) return;
        updateEntryGain(entry);

        if (ctx.state !== 'running') {
            armActivationHandlers();
            return;
        }

        if (entry.data.loop) {
            if (forceRestart || !entry.isLooping || entry.activeSources.size === 0) {
                startLoopPlayback(entry);
            }
            return;
        }

        const playSignature = [
            entry.data.url,
            entry.visible ? '1' : '0',
            entry.data.loop ? '1' : '0',
        ].join('|');

        if (forceRestart || entry.oneShotSignature !== playSignature) {
            startOneShotPlayback(entry, playSignature);
        }
    }

    async function loadBuffer(url) {
        if (!url) return null;
        if (bufferCache.has(url)) return bufferCache.get(url);

        const promise = (async () => {
            const ctx = ensureContext();
            if (!ctx) return null;
            const response = await fetch(url, { cache: 'force-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            const arrayBuffer = await response.arrayBuffer();
            return await ctx.decodeAudioData(arrayBuffer.slice(0));
        })();

        bufferCache.set(url, promise);
        return promise;
    }

    function createEntry(handle) {
        const ctx = ensureContext();
        if (!ctx || !masterGain) return null;

        const object = new THREE.Object3D();
        object.name = `audio_origin_${handle}`;
        object.visible = false;
        object.matrixAutoUpdate = false;
        audioRoot.add(object);

        const outputGain = ctx.createGain();
        const panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 120;
        panner.maxDistance = 5000;
        panner.rolloffFactor = 1;
        outputGain.connect(panner);
        panner.connect(masterGain);

        const entry = {
            handle,
            object,
            outputGain,
            panner,
            activeSources: new Set(),
            loopTimer: 0,
            isLooping: false,
            oneShotSignature: '',
            loadVersion: 0,
            buffer: null,
            data: null,
            visible: true,
        };

        entryMap.set(handle, entry);
        return entry;
    }

    function destroyEntry(handle) {
        const entry = entryMap.get(handle);
        if (!entry) return;

        stopPlayback(entry, { clearOneShot: true });
        try {
            entry.outputGain.disconnect();
        } catch (_) {
        }
        try {
            entry.panner.disconnect();
        } catch (_) {
        }
        if (entry.object.parent) entry.object.parent.remove(entry.object);
        entryMap.delete(handle);
    }

    function applyTransform(entry, data) {
        if (Array.isArray(data?.t) && data.t.length === 16) {
            entry.object.matrix.fromArray(data.t);
        } else {
            entry.object.matrix.identity();
        }
        entry.object.matrixWorldNeedsUpdate = true;
        entry.visible = data?.v == null ? true : !!data.v;
    }

    function applyPannerSettings(entry) {
        entry.panner.refDistance = Math.max(0.01, Number(entry.data?.refDistance) || 120);
        entry.panner.maxDistance = Math.max(entry.panner.refDistance, Number(entry.data?.maxDistance) || 5000);
        entry.panner.rolloffFactor = Math.max(0, Number(entry.data?.rolloff) || 1);
    }

    function normalizeData(data) {
        return {
            url: typeof data?.url === 'string' ? data.url : '',
            volume: Math.max(0, Number(data?.volume) || 0),
            loop: data?.loop !== false,
            crossfade: Math.max(0, Number(data?.crossfade) || 0),
            refDistance: Math.max(0.01, Number(data?.refDistance) || 120),
            maxDistance: Math.max(0.01, Number(data?.maxDistance) || 5000),
            rolloff: Math.max(0, Number(data?.rolloff) || 1),
        };
    }

    function upsertEntry(data) {
        const handle = data?.h;
        if (!Number.isFinite(handle)) return;

        let entry = entryMap.get(handle);
        if (!entry) entry = createEntry(handle);
        if (!entry) return;

        const previous = entry.data;
        entry.data = normalizeData(data);
        applyTransform(entry, data);
        applyPannerSettings(entry);
        updateEntryGain(entry);

        const requiresReload = !previous || previous.url !== entry.data.url;
        const requiresRestart =
            requiresReload ||
            !previous ||
            previous.loop !== entry.data.loop ||
            previous.crossfade !== entry.data.crossfade;

        if (!entry.data.url) {
            entry.buffer = null;
            stopPlayback(entry, { clearOneShot: true });
            return;
        }

        if (requiresReload) {
            const version = ++entry.loadVersion;
            loadBuffer(entry.data.url)
                .then((buffer) => {
                    if (!buffer) return;
                    if (!entryMap.has(handle)) return;
                    if (entry.loadVersion !== version) return;
                    entry.buffer = buffer;
                    syncEntryPlayback(entry, true);
                })
                .catch((error) => {
                    if (entry.loadVersion !== version) return;
                    entry.buffer = null;
                    stopPlayback(entry, { clearOneShot: true });
                    console.warn('[MaxJS audio] buffer load failed', error);
                });
            return;
        }

        syncEntryPlayback(entry, requiresRestart);
    }

    function applyAudios(audioData = []) {
        const incoming = new Set();
        for (const data of audioData) {
            if (Number.isFinite(data?.h)) incoming.add(data.h);
        }
        for (const handle of [...entryMap.keys()]) {
            if (!incoming.has(handle)) destroyEntry(handle);
        }
        for (const data of audioData) upsertEntry(data);
    }

    function applyAudioUpdates(audioData = []) {
        for (const data of audioData) upsertEntry(data);
    }

    function setMuted(nextMuted) {
        muted = !!nextMuted;
        if (!context || !masterGain) return;
        const ctx = context;
        masterGain.gain.cancelScheduledValues(ctx.currentTime);
        masterGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.03);
    }

    function update() {
        if (!context && entryMap.size === 0) return;
        const ctx = context || ensureContext();
        if (!ctx) return;

        const activeCamera = getActiveCamera?.();
        if (activeCamera) {
            activeCamera.updateMatrixWorld?.(true);
            activeCamera.getWorldPosition(listenerPosition);
            activeCamera.getWorldDirection(listenerForward);
            activeCamera.getWorldQuaternion(listenerQuaternion);
            listenerUp.set(0, 1, 0).applyQuaternion(listenerQuaternion).normalize();
            setAudioParam(ctx.listener, listenerPosition.x, listenerPosition.y, listenerPosition.z);
            setOrientationParam(
                ctx.listener,
                listenerForward.x, listenerForward.y, listenerForward.z,
                listenerUp.x, listenerUp.y, listenerUp.z,
            );
        }

        audioRoot.updateMatrixWorld(true);
        for (const entry of entryMap.values()) {
            if (!entry.visible) continue;
            entry.object.getWorldPosition(sourcePosition);
            setAudioParam(entry.panner, sourcePosition.x, sourcePosition.y, sourcePosition.z);
        }
    }

    function applyAudioTransformBinary(handle, matrix, visible) {
        const entry = entryMap.get(handle);
        if (!entry) return;
        entry.object.matrix.fromArray(matrix);
        entry.object.matrixWorldNeedsUpdate = true;
        const wasVisible = entry.visible;
        entry.visible = visible;
        if (wasVisible !== visible) {
            updateEntryGain(entry);
            if (visible && entry.buffer && entry.data?.url) {
                syncEntryPlayback(entry, false);
            }
        }
    }

    return {
        applyAudios,
        applyAudioUpdates,
        applyAudioTransformBinary,
        destroyEntry,
        setMuted,
        update,
    };
}
