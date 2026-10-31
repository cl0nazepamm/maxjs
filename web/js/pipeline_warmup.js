// pipeline_warmup.js — compile render pipelines without stalling the GPU process.
//
// three.js creates a render pipeline the first time an object is drawn in a
// render context (target formats, MRT, pass). On the normal render path that
// is the synchronous GPUDevice.createRenderPipeline(), which Chromium serves on
// the GPU process's main thread: the whole browser stops presenting until the
// driver compiler returns. A post-FX scene pass (MRT), shadow passes, the post
// chain and PowerShot's imager are dozens of pipelines at once — measured as
// 2–3 s browser-wide stalls per batch while a snapshot boots.
//
// renderer.compileAsync() cannot prevent that: it compiles one render context
// (the current target), while real frames draw through PassNode MRT targets,
// shadow maps and post quads, each a render context of its own.
//
// Async pipeline mode runs the REAL frame path instead and hands three's
// Pipelines.getForRender() a promises array, the same hook compileAsync()
// uses: every new pipeline goes through createRenderPipelineAsync (WebGPU) or
// KHR_parallel_shader_compile (WebGL2), and three's isReady() gate skips an
// object's draw until its pipeline lands. Frames rendered in this mode can be
// incomplete — keep them behind a cover or a hidden canvas.
//
// WebKit is the exception. Through Safari 27 its createRenderPipelineAsync()
// just calls the synchronous createRenderPipeline() on the GPU process's WebGPU
// thread and defers only the callback (WebKit bug 324043, fixed on main in
// 321042@main, 2026-09-14). Any burst of new pipelines there, "async" or not,
// queues every Metal compile back to back, and the GPU process the whole
// browser presents through stalls until the queue drains — the iPhone
// scene-swap freeze. On WebKit (every iOS browser and desktop Safari) pipeline
// creation is therefore paced for the renderer's whole life, not only during a
// warm-up: one first-time compile in flight at a time. An object whose pipeline
// is not cached yet is skipped for a frame while another compiles, exactly as
// the isReady() gate skips it, and asks again on the next. Outside a warm-up the
// compile it gets is the synchronous one, so it draws in the frame it asked.
// `?pipelines=serial|parallel` overrides the detection.

const MODES = new WeakMap();

// A paced compile releases its slot when it lands, or after this long in any
// case, so a promise that never settles cannot hold back new draws.
const SERIAL_SLOT_TIMEOUT_MS = 3000;

function pipelineCompileOverride() {
    try {
        const value = new URLSearchParams(globalThis.location?.search ?? '').get('pipelines');
        return value === 'serial' || value === 'parallel' ? value : null;
    } catch {
        return null;
    }
}

function usesSerialPipelineCompile() {
    const override = pipelineCompileOverride();
    if (override) return override === 'serial';
    return globalThis.navigator?.vendor === 'Apple Computer, Inc.';
}

// One-shot conversion passes render once and cache the result: PMREM (every
// target it allocates is flagged isPMREMTexture) and equirect → cube
// (CubeRenderTarget). A draw skipped there while its pipeline compiles is
// baked in black for good — a procedural sky's scene.environment and
// scene.background (TELEVISED). Those few pipelines stay synchronous, as does
// any other bake that flags its target texture userData.maxjsOneShot (the TSL
// texmap bake in tsl_materials.js).
function isOneShotTarget(renderTarget) {
    return renderTarget?.isCubeRenderTarget === true
        || renderTarget?.texture?.isPMREMTexture === true
        || renderTarget?.texture?.userData?.maxjsOneShot === true;
}

// True when this render object's pipeline would come straight from the cache.
// Pacing never holds back an object that needs no compile: 35 petals sharing
// one material wait for the first petal's compile, not for each other.
function hasCachedPipeline(pipelines, renderObject) {
    try {
        const builderState = renderObject.getNodeBuilderState();
        const vertex = pipelines.programs.vertex.get(builderState.vertexShader);
        const fragment = pipelines.programs.fragment.get(builderState.fragmentShader);
        return !!vertex && !!fragment
            && pipelines.caches.has(pipelines._getRenderCacheKey(renderObject, vertex, fragment));
    } catch {
        return false;
    }
}

// A synchronous creation has no promise of its own. WebGPU: the device queue
// processes the compile before a later onSubmittedWorkDone() can resolve.
// WebGL2 links synchronously, so one frame is enough.
function synchronousCompileLanded(renderer) {
    const queue = renderer?.backend?.device?.queue;
    if (typeof queue?.onSubmittedWorkDone === 'function') {
        try {
            return queue.onSubmittedWorkDone().then(() => {}, () => {});
        } catch {
            // fall through to one frame
        }
    }
    return nextFrame();
}

function settleWithin(promise, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        const done = () => {
            clearTimeout(timer);
            resolve();
        };
        promise.then(done, done);
    });
}

/**
 * Route new render pipelines through async creation until `end()`. Nests: the
 * renderer returns to synchronous creation when the outermost session ends —
 * paced synchronous creation on WebKit, which never uninstalls.
 * Returns null when the renderer does not expose three's pipeline cache.
 */
export function beginAsyncPipelineMode(renderer) {
    const pipelines = renderer?._pipelines;
    if (!pipelines || typeof pipelines.getForRender !== 'function') return null;
    let mode = MODES.get(pipelines);
    if (!mode) {
        const hadOwn = Object.prototype.hasOwnProperty.call(pipelines, 'getForRender');
        const original = pipelines.getForRender;
        const state = {
            depth: 0, requested: 0, deferred: 0, calls: 0,
            pending: new Set(), slot: new Set(), keys: new Set(),
            hadOwn, original, renderer, serial: usesSerialPipelineCompile(),
        };
        pipelines.getForRender = function getForRenderAsync(renderObject, promises = null) {
            state.calls += 1;
            if (promises === null && isOneShotTarget(renderObject.context?.renderTarget)) return original.call(this, renderObject, null);
            if (state.serial && promises === null && state.slot.size > 0
                && this.get(renderObject).pipeline === undefined
                && !hasCachedPipeline(this, renderObject)) {
                state.deferred += 1;
                return undefined;
            }
            // compileAsync() passes its own array and awaits it object by object,
            // which runs every compile in series. Keep those promises here instead:
            // compileAsync() still yields between objects, the compiles overlap,
            // and the warm-up waits for them. A serial session leaves them in
            // compileAsync()'s array: one compile at a time. Outside a session
            // (WebKit only) three creates as it normally would.
            let created = [];
            if (state.depth === 0 || (state.serial && promises !== null)) created = promises;
            const first = created?.length ?? 0;
            const cachedPipelines = this.caches?.size ?? 0;
            const result = original.call(this, renderObject, created);
            const fresh = created ? created.slice(first) : [];
            if (state.serial && fresh.length === 0 && (this.caches?.size ?? 0) > cachedPipelines) {
                const landed = synchronousCompileLanded(state.renderer);
                fresh.push(landed);
                created?.push(landed);
            }
            if (fresh.length === 0) return result;
            // Count distinct cache keys, not creations: a render object that
            // thrashes between two cached pipelines (three's shadow pass on
            // mixed-side multi-material casters, docs/THREEJS_UPSTREAM_PR_
            // CANDIDATES.md §20) re-creates the same keys every frame and must
            // not keep a warm-up from ever going quiet — nor, on WebKit, hold
            // the compile slot and starve every other object.
            const key = renderObject.pipeline?.cacheKey;
            const firstTime = key === undefined || !state.keys.has(key);
            for (const promise of fresh) {
                state.pending.add(promise);
                const settle = () => state.pending.delete(promise);
                promise.then(settle, settle);
                if (state.serial && firstTime) {
                    const slot = settleWithin(promise, SERIAL_SLOT_TIMEOUT_MS);
                    state.slot.add(slot);
                    slot.then(() => state.slot.delete(slot));
                }
            }
            if (firstTime) {
                state.requested += 1;
                if (key !== undefined) state.keys.add(key);
            }
            return result;
        };
        MODES.set(pipelines, state);
        mode = state;
    }
    mode.depth += 1;
    let ended = false;
    return {
        get serial() { return mode.serial; },
        get requested() { return mode.requested; },
        get deferred() { return mode.deferred; },
        get calls() { return mode.calls; },
        get pending() { return mode.pending.size; },
        settled() { return Promise.all([...mode.pending]); },
        end() {
            if (ended) return;
            ended = true;
            mode.depth -= 1;
            if (mode.depth > 0 || mode.serial) return;
            if (mode.hadOwn) pipelines.getForRender = mode.original;
            else delete pipelines.getForRender;
            MODES.delete(pipelines);
        },
    };
}

// One display frame, but never hang on requestAnimationFrame: it stops firing
// in a background tab.
function nextFrame() {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve();
        };
        const timer = setTimeout(finish, 100);
        requestAnimationFrame(() => {
            clearTimeout(timer);
            finish();
        });
    });
}

function wait(ms) {
    let timer = 0;
    const promise = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); });
    return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Warm every render pipeline the current frame path needs, asynchronously.
 *
 * `renderFrame` renders one frame; omit it when a running animation loop
 * already renders. Resolves once `quietFrames` consecutive frames requested no
 * new pipeline and nothing is pending (and at least `minFrames` ran), or at
 * `maxMs` — whatever is still compiling then keeps compiling asynchronously
 * and draws when ready. On WebKit a quiet frame must also have rendered: a
 * frame-capped loop skips ticks, and a tick that drew nothing proves nothing.
 */
export async function warmRenderPipelines(renderer, {
    renderFrame = null,
    minFrames = 0,
    quietFrames = 3,
    maxMs = 10000,
    isCancelled = null,
} = {}) {
    const mode = beginAsyncPipelineMode(renderer);
    if (!mode) return { supported: false, pipelines: 0, frames: 0, ms: 0, timedOut: false };
    const start = performance.now();
    const requestedAtStart = mode.requested;
    let seen = mode.requested;
    let deferredSeen = mode.deferred;
    let callsSeen = mode.calls;
    let frames = 0;
    let quiet = 0;
    let timedOut = false;
    try {
        for (;;) {
            if (typeof isCancelled === 'function' && isCancelled()) break;
            if (typeof renderFrame === 'function') renderFrame();
            await nextFrame();
            frames += 1;
            let remaining = maxMs - (performance.now() - start);
            if (mode.pending > 0 && remaining > 0) {
                const timeout = wait(remaining);
                await Promise.race([mode.settled(), timeout.promise]);
                timeout.cancel();
                remaining = maxMs - (performance.now() - start);
            }
            if (remaining <= 0) {
                timedOut = true;
                break;
            }
            const rendered = mode.calls !== callsSeen;
            callsSeen = mode.calls;
            if (mode.requested !== seen || mode.deferred !== deferredSeen || mode.pending !== 0) {
                seen = mode.requested;
                deferredSeen = mode.deferred;
                quiet = 0;
            } else if (rendered || !mode.serial) {
                quiet += 1;
            }
            if (quiet >= quietFrames && frames >= minFrames) break;
        }
    } finally {
        mode.end();
    }
    return {
        supported: true,
        pipelines: mode.requested - requestedAtStart,
        frames,
        ms: Math.round(performance.now() - start),
        timedOut,
    };
}
