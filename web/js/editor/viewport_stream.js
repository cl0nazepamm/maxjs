// viewport_stream.js - sends the rendered frame to the host's native viewport.
//
// A host that can show the viewer's frame inside one of its own viewports (the 3ds Max plugin:
// src/maxjs_viewport_fragment.cpp) posts one persistent read/write shared buffer. After each
// rendered frame the viewer copies the canvas pixels into it; the host draws them in place of
// its own shading, with its gizmos on top.
//
// The buffer is 16 little-endian u32 header words, then the pixels. The layout and the lock
// protocol are defined in src/maxjs_viewport_stream.h; the indices below mirror it.
//
// Two ways a frame leaves:
//   - on its own, after a frame of the render loop, once the host has taken the previous one;
//   - on request: the host is drawing a view the last frame does not match, sends that camera and
//     waits. The viewer renders and answers at once, outside the loop's cadence, so the frame and
//     the host gizmos drawn over it come from the same view.

const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;
const MAGIC = 0x46564a4d; // 'MJVF'

const W_MAGIC = 0;
const W_CAPACITY = 2;
const W_FRAME_SEQ = 3;
const W_WIDTH = 4;
const W_HEIGHT = 5;
const W_STRIDE = 6;
const W_FORMAT = 7;
const W_FLAGS = 8;
const W_REQUEST_ECHO = 9;
const W_ACK_SEQ = 10;
const W_LOCK = 11;

const FORMAT_RGBA8 = 0;
const FORMAT_BGRA8 = 1;
const FLAG_BOTTOM_UP = 1;
const FLAG_PREMULTIPLIED = 2;
const LOCK_FREE = 0;
const LOCK_VIEWER_WRITING = 1;

// A host that stopped drawing has not acknowledged the last frame: refresh it this often anyway,
// so its next draw shows something current.
const UNACKED_REFRESH_MS = 200;
// While the host pulls frames on request, those renders are the frame loop.
const REQUEST_OWNS_LOOP_MS = 50;
// WebGPU readbacks are asynchronous; two may overlap.
const GPU_READBACK_SLOTS = 2;

function createViewportStream(deps = {}) {
    let enabled = false;
    let hostSize = null;         // { width, height }: the pixel size the host wants rendered
    let maxFps = 0;
    let shared = null;           // { buffer, words, lock, pixels, capacity }
    let frameSeq = 0;
    let pendingRequest = 0;      // newest host request without an answer
    let capturedRequest = 0;     // newest request a capture was started for
    let renderingRequest = false;
    let lastRequestMs = -Infinity;
    let lastPublishMs = -Infinity;
    let gpuSlots = [];
    let gpuDevice = null;
    let gpuOrder = 0;
    let gpuPublishedOrder = 0;
    let lastWarning = '';
    const stats = {
        published: 0,
        requests: 0,
        skippedUnacked: 0,
        skippedBusy: 0,
        skippedTooLarge: 0,
        skippedUnsupported: 0,
    };

    function warnOnce(message) {
        if (message === lastWarning) return;
        lastWarning = message;
        console.warn(`[max.js viewport stream] ${message}`);
    }

    function releaseShared() {
        if (!shared) return;
        const buffer = shared.buffer;
        shared = null;
        deps.releaseSharedBuffer?.(buffer);
    }

    function destroyGpuSlots() {
        for (const slot of gpuSlots) {
            // A buffer still being mapped is destroyed by its own completion.
            if (!slot.busy) slot.buffer.destroy();
            else slot.discard = true;
        }
        gpuSlots = [];
        gpuDevice = null;
    }

    // The host posted its frame buffer. Kept until the host posts another or the stream stops.
    function attachBuffer(buffer) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= HEADER_BYTES) return false;
        const words = new Uint32Array(buffer, 0, HEADER_WORDS);
        if (words[W_MAGIC] !== MAGIC) return false;
        const previous = shared;
        const capacity = Math.min(words[W_CAPACITY], buffer.byteLength - HEADER_BYTES);
        shared = {
            buffer,
            words,
            lock: new Int32Array(buffer, 0, HEADER_WORDS),
            pixels: new Uint8Array(buffer, HEADER_BYTES, capacity),
            capacity,
        };
        frameSeq = words[W_FRAME_SEQ] >>> 0;
        if (previous && previous.buffer !== buffer) deps.releaseSharedBuffer?.(previous.buffer);
        return true;
    }

    function setState(msg = {}) {
        const wasEnabled = enabled;
        const previous = hostSize;
        enabled = msg.enabled === true;
        maxFps = Number.isFinite(Number(msg.maxFps)) ? Math.max(0, Number(msg.maxFps)) : 0;
        const width = Math.floor(Number(msg.width));
        const height = Math.floor(Number(msg.height));
        hostSize = enabled && width >= 16 && height >= 16 ? { width, height } : null;
        if (!enabled) {
            pendingRequest = 0;
            capturedRequest = 0;
            releaseShared();
            destroyGpuSlots();
        }
        const sizeChanged = (previous?.width ?? 0) !== (hostSize?.width ?? 0)
            || (previous?.height ?? 0) !== (hostSize?.height ?? 0);
        if (sizeChanged || enabled !== wasEnabled) deps.onHostSizeChanged?.();
    }

    function renderRequestedFrame() {
        renderingRequest = true;
        try {
            deps.renderNow?.();
        } finally {
            renderingRequest = false;
        }
    }

    // The host is drawing `msg.camera` and waits for a frame of it.
    function handleRequest(msg = {}) {
        if (!enabled) return;
        const seq = Number(msg.seq) >>> 0;
        if (!seq) return;
        pendingRequest = seq;
        lastRequestMs = performance.now();
        stats.requests += 1;
        if (msg.camera) deps.applyCamera?.(msg.camera);
        renderRequestedFrame();
    }

    function tryLock() {
        return Atomics.compareExchange(shared.lock, W_LOCK, LOCK_FREE, LOCK_VIEWER_WRITING) === LOCK_FREE;
    }

    function unlock() {
        Atomics.store(shared.lock, W_LOCK, LOCK_FREE);
    }

    // Called with the lock held and the pixels in place.
    function publish(width, height, stride, format, flags, request) {
        const words = shared.words;
        words[W_WIDTH] = width;
        words[W_HEIGHT] = height;
        words[W_STRIDE] = stride;
        words[W_FORMAT] = format;
        words[W_FLAGS] = flags;
        if (request) words[W_REQUEST_ECHO] = request;
        frameSeq = ((frameSeq + 1) >>> 0) || 1;
        words[W_FRAME_SEQ] = frameSeq;
        unlock();
        if (request && pendingRequest === request) pendingRequest = 0;
        lastPublishMs = performance.now();
        stats.published += 1;
        deps.send?.('viewport_frame', { seq: frameSeq, request });
    }

    // WebGL: read the drawing buffer straight into the shared buffer. Synchronous, so the frame
    // is with the host before this task ends.
    function captureGl(gl, width, height, request, premultiplied) {
        const bytes = width * height * 4;
        if (bytes > shared.capacity) {
            stats.skippedTooLarge += 1;
            return;
        }
        if (!tryLock()) {
            stats.skippedBusy += 1;
            return;
        }
        let published = false;
        const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        const readTarget = isWebGL2 ? gl.READ_FRAMEBUFFER : gl.FRAMEBUFFER;
        const boundFramebuffer = gl.getParameter(isWebGL2 ? gl.READ_FRAMEBUFFER_BINDING : gl.FRAMEBUFFER_BINDING);
        const boundPackBuffer = isWebGL2 ? gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) : null;
        try {
            // The renderer tracks its own bindings: put back whatever was bound.
            if (boundFramebuffer) gl.bindFramebuffer(readTarget, null);
            if (boundPackBuffer) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, shared.pixels);
            capturedRequest = request || capturedRequest;
            publish(width, height, width * 4, FORMAT_RGBA8,
                FLAG_BOTTOM_UP | (premultiplied ? FLAG_PREMULTIPLIED : 0), request);
            published = true;
        } finally {
            if (boundPackBuffer) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, boundPackBuffer);
            if (boundFramebuffer) gl.bindFramebuffer(readTarget, boundFramebuffer);
            if (!published) unlock();
        }
    }

    function acquireGpuSlot(device, bytes) {
        if (gpuDevice !== device) {
            destroyGpuSlots();
            gpuDevice = device;
        }
        for (let i = gpuSlots.length - 1; i >= 0; i -= 1) {
            const slot = gpuSlots[i];
            if (slot.busy) continue;
            if (slot.bytes === bytes) return slot;
            slot.buffer.destroy();
            gpuSlots.splice(i, 1);
        }
        if (gpuSlots.length >= GPU_READBACK_SLOTS) return null;
        const slot = {
            buffer: device.createBuffer({
                label: 'maxjs viewport stream readback',
                size: bytes,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            }),
            bytes,
            busy: false,
            discard: false,
        };
        gpuSlots.push(slot);
        return slot;
    }

    // WebGPU: copy the canvas texture of this frame into a buffer and map it. The pixels arrive
    // a few milliseconds later, in a later task.
    function captureGpu(renderer, width, height, request, premultiplied) {
        const backend = renderer.backend;
        const device = backend.device;
        const canvasFormat = backend.utils?.getPreferredCanvasFormat?.();
        const format = canvasFormat === 'bgra8unorm' ? FORMAT_BGRA8
            : (canvasFormat === 'rgba8unorm' ? FORMAT_RGBA8 : -1);
        if (format < 0) {
            stats.skippedUnsupported += 1;
            warnOnce(`canvas format ${canvasFormat} cannot be streamed`);
            return;
        }
        // copyTextureToBuffer wants rows that are multiples of 256 bytes.
        const stride = Math.ceil((width * 4) / 256) * 256;
        const bytes = stride * height;
        if (bytes > shared.capacity) {
            stats.skippedTooLarge += 1;
            return;
        }
        const slot = acquireGpuSlot(device, bytes);
        if (!slot) {
            stats.skippedBusy += 1;
            return;
        }
        const texture = backend.context.getCurrentTexture();
        const encoder = device.createCommandEncoder({ label: 'maxjs viewport stream' });
        encoder.copyTextureToBuffer(
            { texture },
            { buffer: slot.buffer, bytesPerRow: stride, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish()]);

        const order = ++gpuOrder;
        slot.busy = true;
        capturedRequest = request || capturedRequest;
        const flags = premultiplied ? FLAG_PREMULTIPLIED : 0;
        slot.buffer.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
            try {
                // An older readback that finishes after a newer one has nothing to add.
                if (enabled && shared && bytes <= shared.capacity && order > gpuPublishedOrder && !slot.discard) {
                    if (tryLock()) {
                        let published = false;
                        try {
                            shared.pixels.set(new Uint8Array(slot.buffer.getMappedRange(0, bytes)));
                            gpuPublishedOrder = order;
                            publish(width, height, stride, format, flags, request);
                            published = true;
                        } finally {
                            if (!published && shared) unlock();
                        }
                    } else {
                        stats.skippedBusy += 1;
                    }
                }
            } finally {
                slot.buffer.unmap();
                slot.busy = false;
                if (slot.discard) slot.buffer.destroy();
            }
            // A request that came in while every readback was busy still wants its frame.
            if (enabled && pendingRequest && pendingRequest !== capturedRequest) renderRequestedFrame();
        }, error => {
            slot.busy = false;
            if (slot.discard) slot.buffer.destroy();
            warnOnce(`readback failed: ${error?.message || error}`);
        });
    }

    // Called by the render loop right after a frame was drawn to the canvas.
    function afterRender() {
        if (!enabled || !shared) return;
        if (deps.isCaptureSuspended?.()) return;
        const renderer = deps.getRenderer?.();
        const canvas = renderer?.domElement;
        if (!canvas) return;

        const request = pendingRequest !== capturedRequest ? pendingRequest : 0;
        if (!request) {
            const now = performance.now();
            // The host acknowledges each frame it copied. Until then a new one would only replace
            // pixels nobody has seen.
            const acknowledged = shared.words[W_ACK_SEQ] === shared.words[W_FRAME_SEQ];
            if (!acknowledged && now - lastPublishMs < UNACKED_REFRESH_MS) {
                stats.skippedUnacked += 1;
                return;
            }
            if (maxFps > 0 && now - lastPublishMs < 1000 / maxFps - 0.5) return;
        }

        const width = canvas.width | 0;
        const height = canvas.height | 0;
        if (width < 1 || height < 1) return;
        try {
            const gl = renderer.isWebGLRenderer === true ? renderer.getContext() : (renderer.backend?.gl ?? null);
            if (gl) {
                const premultiplied = gl.getContextAttributes?.()?.premultipliedAlpha !== false;
                captureGl(gl, width, height, request, premultiplied);
            } else if (renderer.backend?.device && renderer.backend?.context) {
                captureGpu(renderer, width, height, request, renderer.backend.parameters?.alpha === true);
            } else {
                stats.skippedUnsupported += 1;
                warnOnce('this renderer backend cannot be streamed');
            }
        } catch (error) {
            warnOnce(`capture failed: ${error?.message || error}`);
        }
    }

    return {
        attachBuffer,
        setState,
        handleRequest,
        afterRender,
        // The render size the host viewport wants, or null while the stream is off.
        getHostSize: () => hostSize,
        isEnabled: () => enabled,
        // True while the frame being rendered answers a host request: it must not be skipped.
        isRenderingRequest: () => renderingRequest,
        // True while requested frames arrive faster than the loop would render them.
        shouldSkipLoopFrame: () => enabled && !renderingRequest
            && (performance.now() - lastRequestMs) < REQUEST_OWNS_LOOP_MS,
        getStats: () => ({ ...stats, enabled, hostSize, frameSeq, capacity: shared?.capacity ?? 0 }),
    };
}

export { createViewportStream };
