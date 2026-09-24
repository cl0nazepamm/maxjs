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

const MODES = new WeakMap();

// One-shot conversion passes render once and cache the result: PMREM (every
// target it allocates is flagged isPMREMTexture) and equirect → cube
// (CubeRenderTarget). A draw skipped there while its pipeline compiles is
// baked in black for good — a procedural sky's scene.environment and
// scene.background (TELEVISED). Those few pipelines stay synchronous.
function isOneShotTarget(renderTarget) {
    return renderTarget?.isCubeRenderTarget === true
        || renderTarget?.texture?.isPMREMTexture === true;
}

/**
 * Route new render pipelines through async creation until `end()`. Nests: the
 * renderer returns to synchronous creation when the outermost session ends.
 * Returns null when the renderer does not expose three's pipeline cache.
 */
export function beginAsyncPipelineMode(renderer) {
    const pipelines = renderer?._pipelines;
    if (!pipelines || typeof pipelines.getForRender !== 'function') return null;
    let mode = MODES.get(pipelines);
    if (!mode) {
        const hadOwn = Object.prototype.hasOwnProperty.call(pipelines, 'getForRender');
        const original = pipelines.getForRender;
        const state = { depth: 0, requested: 0, pending: new Set(), keys: new Set(), hadOwn, original };
        pipelines.getForRender = function getForRenderAsync(renderObject, promises = null) {
            // compileAsync() passes its own array and awaits it object by object,
            // which runs every compile in series. Keep those promises here instead:
            // compileAsync() still yields between objects, the compiles overlap,
            // and the warm-up waits for them.
            if (promises === null && isOneShotTarget(renderObject.context?.renderTarget)) return original.call(this, renderObject, null);
            const created = [];
            const result = original.call(this, renderObject, created);
            if (created.length === 0) return result;
            for (const promise of created) {
                state.pending.add(promise);
                const settle = () => state.pending.delete(promise);
                promise.then(settle, settle);
            }
            // Count distinct cache keys, not creations: a render object that
            // thrashes between two cached pipelines (three's shadow pass on
            // mixed-side multi-material casters, docs/THREEJS_UPSTREAM_PR_
            // CANDIDATES.md §20) re-creates the same keys every frame and must
            // not keep a warm-up from ever going quiet.
            const key = renderObject.pipeline?.cacheKey;
            if (key === undefined || !state.keys.has(key)) {
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
        get requested() { return mode.requested; },
        get pending() { return mode.pending.size; },
        settled() { return Promise.all([...mode.pending]); },
        end() {
            if (ended) return;
            ended = true;
            mode.depth -= 1;
            if (mode.depth > 0) return;
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
 * and draws when ready.
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
            if (mode.requested === seen && mode.pending === 0) quiet += 1;
            else {
                seen = mode.requested;
                quiet = 0;
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
