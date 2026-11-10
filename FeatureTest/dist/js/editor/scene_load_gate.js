// scene_load_gate.js — safe, visible scene loading for the live viewer.
//
// A full-scene sync used to be applied in one synchronous WebView2 event
// handler and then drawn by a first frame that compiled every WebGPU render
// pipeline on the spot. Big scenes froze the browser for seconds with no
// feedback. The gate turns that into:
//
//   1. apply      — scene_sync applies the node list in time slices, yielding
//                   to the event loop between chunks so the overlay paints,
//                   input stays responsive, and newer packets can supersede
//                   the load;
//   2. compile    — renderer.compileAsync() warms the render pipelines on
//                   driver threads instead of the first frame's draw calls;
//   3. firstFrame — the render loop draws ONE frame behind the overlay (any
//                   pipeline compileAsync could not reach compiles here, out
//                   of sight), then drops the overlay.
//
// While the gate is active the render loop skips scene rendering entirely, so
// a half-applied scene is never presented and no pipeline is created early.
// The DOM overlay is created lazily and every DOM touch is guarded, so the
// module also runs under Node for the smoke tests.

export const SCENE_APPLY_SLICE_DEFAULTS = Object.freeze({
    // A sync that carries at least this many fresh geometries, or at least
    // this many bytes, goes through the sliced/gated path. Smaller syncs
    // (material edits, a few new objects) keep the synchronous fast path so
    // their semantics are unchanged.
    minGeometryNodes: 24,
    minBytes: 4 * 1024 * 1024,
    // Per-chunk CPU budget before yielding. Rendering is suspended, so the
    // budget only has to leave room for the overlay to paint and input to
    // be processed.
    chunkBudgetMs: 24,
    // Cap on the pipeline warm-up wait; whatever is left keeps compiling in
    // the background while the first frame renders (same policy as the
    // standalone snapshot boot).
    compileTimeoutMs: 4000,
});

export function shouldTimeSliceSceneApply(meta, byteLength, thresholds = SCENE_APPLY_SLICE_DEFAULTS) {
    if (!meta || !Array.isArray(meta.nodes)) return false;
    let geometryNodes = 0;
    for (const nd of meta.nodes) {
        if (nd && nd.geo && nd.helper !== true) geometryNodes++;
    }
    return geometryNodes >= thresholds.minGeometryNodes
        || (Number.isFinite(byteLength) && byteLength >= thresholds.minBytes);
}

// Yield to the event loop as a MACROTASK. requestAnimationFrame stalls in a
// hidden webview and a microtask would not let the page paint; a MessageChannel
// message (or setTimeout(0)) always runs after pending input and paint.
export function yieldToEventLoop() {
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield();
    }
    if (typeof MessageChannel === 'function') {
        // One channel per yield, closed on delivery: an open port would keep a
        // Node process alive, and a yield happens at most every few
        // milliseconds so the allocation is noise.
        return new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
                channel.port1.close();
                resolve();
            };
            channel.port2.postMessage(null);
        });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// Packets that touch synced nodes (deltas, fast geometry, transforms) must not
// interleave with a sliced apply: they would target half-applied state and be
// overwritten by the older scene payload. They are queued in arrival order and
// replayed once the sliced apply (or the one that superseded it) finishes.
export function createDeferredPacketQueue() {
    const queue = [];
    let deferring = false;
    return {
        get deferring() { return deferring; },
        get size() { return queue.length; },
        begin() { deferring = true; },
        // Returns true when the packet was queued (caller must not run it now).
        defer(run, label = '') {
            if (!deferring) return false;
            queue.push({ run, label });
            return true;
        },
        // Ends deferral and replays everything in order. A packet that throws
        // does not stop the others; the caller reports the errors.
        flush(onError = null) {
            deferring = false;
            const pending = queue.splice(0, queue.length);
            let replayed = 0;
            for (const entry of pending) {
                try {
                    entry.run();
                    replayed++;
                } catch (error) {
                    if (typeof onError === 'function') onError(error, entry.label);
                }
            }
            return replayed;
        },
        clear() {
            deferring = false;
            queue.length = 0;
        },
    };
}

export function createSceneLoadGate({
    document: doc = (typeof document !== 'undefined' ? document : null),
    onBegin = null,
    onEnd = null,
    fadeMs = 180,
} = {}) {
    // 'idle' | 'apply' | 'compile' | 'firstFrame'
    let state = 'idle';
    let generation = 0;
    let label = '';
    let phaseText = '';
    let done = 0;
    let total = 0;
    let startedAt = 0;
    let dom = null;
    let hideTimer = 0;

    function ensureDom() {
        if (dom || !doc || !doc.body) return dom;
        const root = doc.createElement('div');
        root.id = 'sceneLoadGate';
        root.setAttribute('role', 'status');
        root.setAttribute('aria-live', 'polite');
        root.innerHTML = [
            '<div class="scene-load-card">',
            '  <div class="scene-load-title"></div>',
            '  <div class="scene-load-phase"></div>',
            '  <div class="scene-load-bar"><div class="scene-load-bar-fill"></div></div>',
            '</div>',
        ].join('');
        doc.body.appendChild(root);
        dom = {
            root,
            title: root.querySelector('.scene-load-title'),
            phase: root.querySelector('.scene-load-phase'),
            bar: root.querySelector('.scene-load-bar'),
            fill: root.querySelector('.scene-load-bar-fill'),
        };
        return dom;
    }

    function paint() {
        const d = ensureDom();
        if (!d) return;
        d.title.textContent = label;
        d.phase.textContent = phaseText;
        const determinate = total > 0;
        d.bar.classList.toggle('indeterminate', !determinate);
        d.fill.style.width = determinate ? `${Math.round(Math.min(1, done / total) * 100)}%` : '';
    }

    function show() {
        const d = ensureDom();
        if (!d) return;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
        d.root.classList.add('active');
    }

    function hide() {
        if (!dom) return;
        dom.root.classList.remove('active');
    }

    function describePhase() {
        switch (state) {
            case 'apply': return total > 0 ? `Applying scene ${done} / ${total}` : 'Applying scene';
            case 'compile': return 'Compiling shaders';
            case 'firstFrame': return 'Preparing first frame';
            default: return '';
        }
    }

    return {
        get state() { return state; },
        get generation() { return generation; },
        get active() { return state !== 'idle'; },
        get elapsedMs() { return state === 'idle' ? 0 : performance.now() - startedAt; },
        // Render loop contract: skip scene rendering while the gate applies or
        // compiles; render exactly one frame in 'firstFrame', then call end().
        isBlockingRender() { return state === 'apply' || state === 'compile'; },
        isFirstFrame() { return state === 'firstFrame'; },
        begin({ label: nextLabel = 'Loading scene', total: nextTotal = 0 } = {}) {
            generation += 1;
            state = 'apply';
            label = nextLabel;
            done = 0;
            total = Math.max(0, nextTotal | 0);
            phaseText = describePhase();
            startedAt = performance.now();
            show();
            paint();
            if (typeof onBegin === 'function') onBegin({ generation, label });
            return generation;
        },
        // Progress inside the apply phase. Painting is rate-limited by the
        // caller's yield cadence, so this is cheap to call per chunk.
        progress(nextDone, nextTotal = total) {
            if (state !== 'apply') return;
            done = Math.max(0, nextDone | 0);
            total = Math.max(0, nextTotal | 0);
            phaseText = describePhase();
            paint();
        },
        setState(next) {
            if (state === 'idle') return;
            if (next !== 'apply' && next !== 'compile' && next !== 'firstFrame') return;
            state = next;
            if (state !== 'apply') { done = 0; total = 0; }
            phaseText = describePhase();
            paint();
        },
        // Ends the gate. `reason` is informational ('rendered', 'aborted',
        // 'superseded', 'error').
        end(reason = 'rendered') {
            if (state === 'idle') return;
            const elapsed = performance.now() - startedAt;
            state = 'idle';
            phaseText = '';
            done = 0;
            total = 0;
            hide();
            if (dom && fadeMs > 0) {
                hideTimer = setTimeout(() => { hideTimer = 0; }, fadeMs);
            }
            if (typeof onEnd === 'function') onEnd({ generation, reason, elapsedMs: elapsed });
        },
        // A newer load supersedes the one in flight: the same overlay carries
        // on with the new generation, so there is no flicker between loads.
        isCurrent(gen) { return gen === generation && state !== 'idle'; },
    };
}
