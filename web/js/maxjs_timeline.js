// Max → JS timeline oracle.
//
// Read-only surface for JS-side code (inline layers, project layers, TSL
// entry points, HTML overlays, Canvas panel DOM) to know what time Max is
// at. Does NOT drive authored-animation scene sync — that goes through the
// existing delta transform/light/material pipeline. Purely a time scalar
// that consumers can key their own generative motion to.
//
// Two modes:
//  - Live Max: C++ packs an UpdateTime command into every delta_bin frame.
//    onTime() is fed from the protocol decoder. now() extrapolates between
//    pushes during playback so RAF-rate reads are smooth even when Max
//    pushes at 30 or 24 Hz.
//  - Standalone snapshot: no Max. initStandalone() kicks a local RAF clock
//    so ctx.maxTime has the same API shape for exported viewers.

const TICKS_PER_SECOND = 4800; // Max TimeValue unit.

const state = {
    ticks: 0,
    tpf: 160,            // ticks per frame (Max default at 30fps)
    fps: 30,
    seconds: 0,
    frame: 0,
    playing: false,
    source: 'none',      // 'live' | 'standalone' | 'none'
    // Extrapolation anchors
    _lastPushSeconds: 0,
    _lastPushMono: 0,
    // Standalone mode bookkeeping
    _standaloneRaf: 0,
    _standaloneStartMono: 0,
    _standaloneStartSeconds: 0,
};

const listeners = {
    change: new Set(),
    play: new Set(),
    pause: new Set(),
};

function emit(event) {
    const set = listeners[event];
    if (!set) return;
    for (const fn of set) {
        try { fn(snapshot()); } catch (err) { console.warn('[maxTimeline] listener threw:', err); }
    }
}

function snapshot() {
    return {
        ticks: state.ticks,
        fps: state.fps,
        seconds: state.seconds,
        frame: state.frame,
        playing: state.playing,
        source: state.source,
    };
}

// Called by the protocol decoder for every UpdateTime command.
function onTime({ ticks, tpf, stateFlags }) {
    if (state.source !== 'live') state.source = 'live';
    if (state._standaloneRaf) {
        cancelAnimationFrame(state._standaloneRaf);
        state._standaloneRaf = 0;
    }

    const wasPlaying = state.playing;
    const nextPlaying = (stateFlags & 0x01) !== 0;
    const safeTpf = tpf > 0 ? tpf : state.tpf;
    const seconds = ticks / TICKS_PER_SECOND;
    const fps = TICKS_PER_SECOND / safeTpf;
    const frame = Math.round(ticks / safeTpf);

    // Drift-snap: if we were extrapolating during playback and the
    // authoritative value is off by more than 1.5 frames, trust it
    // immediately rather than waiting for extrapolation to catch up.
    if (wasPlaying && nextPlaying) {
        const projected = state._lastPushSeconds + (performance.now() - state._lastPushMono) / 1000;
        const driftFrames = Math.abs(projected - seconds) * fps;
        if (driftFrames < 1.5) {
            // Within tolerance — keep the smoother extrapolation anchor only
            // slightly updated so we don't visibly snap each push.
            state._lastPushSeconds = seconds;
            state._lastPushMono = performance.now();
        } else {
            state._lastPushSeconds = seconds;
            state._lastPushMono = performance.now();
        }
    } else {
        state._lastPushSeconds = seconds;
        state._lastPushMono = performance.now();
    }

    state.ticks = ticks;
    state.tpf = safeTpf;
    state.fps = fps;
    state.seconds = seconds;
    state.frame = frame;
    state.playing = nextPlaying;

    emit('change');
    if (!wasPlaying && nextPlaying) emit('play');
    else if (wasPlaying && !nextPlaying) emit('pause');
}

// Current seconds with sub-frame extrapolation during playback.
// During scrub / pause the authoritative push value is returned raw so
// there's no perceptible drift while scrubbing.
function now() {
    if (!state.playing) return state.seconds;
    const elapsed = (performance.now() - state._lastPushMono) / 1000;
    return state._lastPushSeconds + elapsed;
}

function currentFrame() {
    if (!state.playing) return state.frame;
    return Math.round(now() * state.fps);
}

function fps() { return state.fps; }
function playing() { return state.playing; }
function getSource() { return state.source; }

function on(event, fn) {
    const set = listeners[event];
    if (!set) return () => {};
    set.add(fn);
    return () => set.delete(fn);
}

// Standalone snapshot viewer: no Max, tick a local clock with the same API.
// Accepts { fps, startFrame, endFrame, defaultPlaying } from snapshot.json.
function initStandalone(options = {}) {
    state.source = 'standalone';
    const sfps = Number.isFinite(options.fps) && options.fps > 0 ? options.fps : 30;
    state.fps = sfps;
    state.tpf = TICKS_PER_SECOND / sfps;
    const startFrame = Number.isFinite(options.startFrame) ? options.startFrame : 0;
    state.frame = startFrame;
    state.seconds = startFrame / sfps;
    state.ticks = Math.round(state.seconds * TICKS_PER_SECOND);
    const wantsPlay = options.defaultPlaying !== false;
    state.playing = !!wantsPlay;
    state._standaloneStartMono = performance.now();
    state._standaloneStartSeconds = state.seconds;
    state._lastPushSeconds = state.seconds;
    state._lastPushMono = state._standaloneStartMono;

    if (state._standaloneRaf) cancelAnimationFrame(state._standaloneRaf);
    const tick = () => {
        if (state.source !== 'standalone') return;
        if (state.playing) {
            const elapsed = (performance.now() - state._standaloneStartMono) / 1000;
            state.seconds = state._standaloneStartSeconds + elapsed;
            state.frame = Math.round(state.seconds * state.fps);
            state.ticks = Math.round(state.seconds * TICKS_PER_SECOND);
            state._lastPushSeconds = state.seconds;
            state._lastPushMono = performance.now();
            emit('change');
        }
        state._standaloneRaf = requestAnimationFrame(tick);
    };
    state._standaloneRaf = requestAnimationFrame(tick);
    emit('change');
    if (wantsPlay) emit('play');
}

function standalonePlay() {
    if (state.source !== 'standalone') return;
    if (state.playing) return;
    state._standaloneStartMono = performance.now();
    state._standaloneStartSeconds = state.seconds;
    state.playing = true;
    emit('play');
    emit('change');
}

function standalonePause() {
    if (state.source !== 'standalone') return;
    if (!state.playing) return;
    state.playing = false;
    emit('pause');
    emit('change');
}

function standaloneSeek(seconds) {
    if (state.source !== 'standalone') return;
    state.seconds = Math.max(0, seconds);
    state.frame = Math.round(state.seconds * state.fps);
    state.ticks = Math.round(state.seconds * TICKS_PER_SECOND);
    state._standaloneStartMono = performance.now();
    state._standaloneStartSeconds = state.seconds;
    state._lastPushSeconds = state.seconds;
    state._lastPushMono = state._standaloneStartMono;
    emit('change');
}

export const maxTimeline = {
    onTime,
    now,
    frame: currentFrame,
    fps,
    playing,
    source: getSource,
    on,
    initStandalone,
    standalonePlay,
    standalonePause,
    standaloneSeek,
    snapshot,
};

export default maxTimeline;
