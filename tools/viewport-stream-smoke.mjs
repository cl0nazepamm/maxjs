// viewport-stream-smoke.mjs - the viewer half of the host viewport stream, against fake
// renderers and a plain ArrayBuffer standing in for the host's shared buffer.
//
// Covers the buffer protocol the 3ds Max side depends on (src/maxjs_viewport_stream.h): header
// fields, the frame sequence, the acknowledge gate, the lock, and frames rendered on request.
//
// Usage: node tools/viewport-stream-smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createViewportStream } from '../web/js/editor/viewport_stream.js';

const HEADER_BYTES = 64;
const W = { magic: 0, version: 1, capacity: 2, seq: 3, width: 4, height: 5, stride: 6, format: 7,
            flags: 8, echo: 9, ack: 10, lock: 11 };

function makeHostBuffer(capacity) {
    const buffer = new ArrayBuffer(HEADER_BYTES + capacity);
    const words = new Uint32Array(buffer, 0, 16);
    words[W.magic] = 0x46564a4d;
    words[W.version] = 1;
    words[W.capacity] = capacity;
    return { buffer, words, pixels: new Uint8Array(buffer, HEADER_BYTES, capacity) };
}

// The header word indices are written twice, once per language. Keep them the same.
{
    const header = readFileSync(new URL('../src/maxjs_viewport_stream.h', import.meta.url), 'utf8');
    const expected = { kWordMagic: 0, kWordVersion: 1, kWordCapacity: 2, kWordFrameSeq: 3, kWordWidth: 4,
                       kWordHeight: 5, kWordStride: 6, kWordFormat: 7, kWordFlags: 8, kWordRequestEcho: 9,
                       kWordAckSeq: 10, kWordLock: 11, kWordCount: 16 };
    for (const [name, value] of Object.entries(expected)) {
        assert.match(header, new RegExp(`${name} = ${value},`), `${name} is ${value} in maxjs_viewport_stream.h`);
    }
    assert.match(header, /kMagic = 0x46564A4D/);
    assert.match(header, /kHeaderBytes = 64/);
    const viewer = readFileSync(new URL('../web/js/editor/viewport_stream.js', import.meta.url), 'utf8');
    for (const [name, value] of Object.entries({ W_CAPACITY: 2, W_FRAME_SEQ: 3, W_WIDTH: 4, W_HEIGHT: 5, W_STRIDE: 6,
                                                 W_FORMAT: 7, W_FLAGS: 8, W_REQUEST_ECHO: 9, W_ACK_SEQ: 10, W_LOCK: 11 })) {
        assert.match(viewer, new RegExp(`const ${name} = ${value};`), `${name} is ${value} in viewport_stream.js`);
    }
}

// ── WebGL: synchronous readback straight into the shared buffer ──────────────
{
    const width = 8;
    const height = 4;
    let readCalls = 0;
    const gl = {
        FRAMEBUFFER: 0x8D40, FRAMEBUFFER_BINDING: 0x8CA6, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
        getParameter: () => null,
        getContextAttributes: () => ({ premultipliedAlpha: true }),
        bindFramebuffer() {},
        readPixels(x, y, w, h, format, type, target) {
            readCalls += 1;
            assert.equal(w, width);
            assert.equal(h, height);
            for (let i = 0; i < w * h * 4; i += 1) target[i] = (i + readCalls) & 0xff;
        },
    };
    const renderer = { isWebGLRenderer: true, domElement: { width, height }, getContext: () => gl };
    const sent = [];
    const released = [];
    let sizeChanges = 0;
    let renders = 0;
    let appliedCamera = null;
    let stream = null;
    stream = createViewportStream({
        getRenderer: () => renderer,
        send: (type, data) => sent.push({ type, ...data }),
        releaseSharedBuffer: buffer => released.push(buffer),
        applyCamera: camera => { appliedCamera = camera; },
        renderNow: () => { renders += 1; stream.afterRender(); },
        onHostSizeChanged: () => { sizeChanges += 1; },
    });

    stream.afterRender();
    assert.equal(sent.length, 0, 'nothing leaves before the host enables the stream');

    const host = makeHostBuffer(width * height * 4);
    assert.equal(stream.attachBuffer(host.buffer), true, 'the viewer keeps the frame buffer');
    assert.equal(stream.attachBuffer(new ArrayBuffer(128)), false, 'a buffer without the magic is refused');
    stream.setState({ enabled: true, width: 800, height: 600, maxFps: 0 });
    assert.deepEqual(stream.getHostSize(), { width: 800, height: 600 });
    assert.equal(sizeChanges, 1, 'the renderer is told the host viewport size');

    stream.afterRender();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { type: 'viewport_frame', seq: 1, request: 0 });
    assert.equal(host.words[W.seq], 1);
    assert.equal(host.words[W.width], width);
    assert.equal(host.words[W.height], height);
    assert.equal(host.words[W.stride], width * 4);
    assert.equal(host.words[W.format], 0, 'WebGL reads RGBA');
    assert.equal(host.words[W.flags], 1 | 2, 'bottom-up rows, premultiplied alpha');
    assert.equal(host.words[W.lock], 0, 'the lock is released after publishing');
    assert.equal(host.pixels[5], (5 + 1) & 0xff, 'the pixels are in the shared buffer');

    stream.afterRender();
    assert.equal(sent.length, 1, 'no new frame until the host acknowledged the last one');
    assert.equal(stream.getStats().skippedUnacked, 1);

    host.words[W.ack] = host.words[W.seq];
    stream.afterRender();
    assert.equal(sent.length, 2);
    assert.equal(host.words[W.seq], 2);

    // The host is copying: the viewer must not write under it.
    host.words[W.ack] = host.words[W.seq];
    host.words[W.lock] = 2;
    stream.afterRender();
    assert.equal(sent.length, 2, 'a frame is dropped while the host holds the lock');
    assert.equal(stream.getStats().skippedBusy, 1);
    host.words[W.lock] = 0;

    // A request is answered at once, acknowledged or not, and echoed in the header.
    host.words[W.ack] = 0;
    stream.handleRequest({ seq: 41, camera: { fov: 50 } });
    assert.deepEqual(appliedCamera, { fov: 50 }, 'the request carries the camera to render');
    assert.equal(renders, 1, 'a request renders outside the frame loop');
    assert.equal(host.words[W.echo], 41);
    assert.equal(host.words[W.seq], 3);
    assert.deepEqual(sent.at(-1), { type: 'viewport_frame', seq: 3, request: 41 });
    assert.equal(stream.shouldSkipLoopFrame(), true, 'requested frames stand in for loop frames');
    assert.equal(stream.isRenderingRequest(), false);

    // A canvas larger than the buffer is skipped, not truncated.
    renderer.domElement.width = 64;
    host.words[W.ack] = host.words[W.seq];
    stream.afterRender();
    assert.equal(stream.getStats().skippedTooLarge, 1);
    assert.equal(host.words[W.seq], 3);
    renderer.domElement.width = width;

    stream.setState({ enabled: false });
    assert.equal(stream.getHostSize(), null);
    assert.deepEqual(released, [host.buffer], 'the buffer is released when the stream stops');
    assert.equal(sizeChanges, 2);
    stream.afterRender();
    assert.equal(host.words[W.seq], 3, 'nothing is written after the stream stopped');
}

// ── WebGPU: asynchronous readback through a mapped buffer ────────────────────
{
    globalThis.GPUBufferUsage = { COPY_DST: 8, MAP_READ: 1 };
    globalThis.GPUMapMode = { READ: 1 };
    const width = 100;      // 400 bytes per row: padded to 512
    const height = 3;
    const stride = 512;
    const copies = [];
    const pendingMaps = [];
    const makeBuffer = ({ size }) => {
        const data = new Uint8Array(size);
        return {
            size,
            destroyed: false,
            mapAsync: () => new Promise(resolve => pendingMaps.push(() => { data.fill(7); resolve(); })),
            getMappedRange: (offset, length) => data.buffer.slice(offset, offset + length),
            unmap() {},
            destroy() { this.destroyed = true; },
        };
    };
    const device = {
        createBuffer: makeBuffer,
        createCommandEncoder: () => ({
            copyTextureToBuffer: (source, destination, size) => copies.push({ destination, size }),
            finish: () => ({}),
        }),
        queue: { submit() {} },
    };
    const renderer = {
        domElement: { width, height },
        backend: {
            device,
            parameters: { alpha: true },
            utils: { getPreferredCanvasFormat: () => 'bgra8unorm' },
            context: { getCurrentTexture: () => ({}) },
        },
    };
    const sent = [];
    const stream = createViewportStream({
        getRenderer: () => renderer,
        send: (type, data) => sent.push({ type, ...data }),
    });
    const host = makeHostBuffer(stride * height);
    stream.attachBuffer(host.buffer);
    stream.setState({ enabled: true, width: 100, height: 3 });

    stream.afterRender();
    assert.equal(copies.length, 1);
    assert.equal(copies[0].destination.bytesPerRow, stride, 'rows are padded to 256 bytes');
    assert.equal(sent.length, 0, 'the frame is not published before the readback lands');
    pendingMaps.shift()();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sent.length, 1);
    assert.equal(host.words[W.stride], stride);
    assert.equal(host.words[W.format], 1, 'the canvas is BGRA');
    assert.equal(host.words[W.flags], 2, 'top-down rows, premultiplied alpha');
    assert.equal(host.pixels[0], 7);
    assert.equal(host.words[W.lock], 0);

    // An rgba16float canvas cannot be streamed as bytes.
    renderer.backend.utils.getPreferredCanvasFormat = () => 'rgba16float';
    host.words[W.ack] = host.words[W.seq];
    const warn = console.warn;
    console.warn = () => {};
    stream.afterRender();
    console.warn = warn;
    assert.equal(stream.getStats().skippedUnsupported, 1);
    assert.equal(copies.length, 1);
}

console.log('viewport-stream-smoke: OK');
