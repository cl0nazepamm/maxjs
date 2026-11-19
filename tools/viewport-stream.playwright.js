// node tools/split_smoke_server.mjs 8901
// playwright-cli open http://127.0.0.1:8901/ --browser=msedge
// playwright-cli run-code --filename=tools/viewport-stream.playwright.js
//
// The viewer half of the host viewport stream against real renderers: each backend draws a known
// picture, and the frame that lands in the (stand-in) host buffer must be that picture, with the
// layout the header declares. Also times a frame rendered on request, as the 3ds Max side asks
// for one while it waits (src/maxjs_panel_viewport_stream.inl, RequestViewportFrame).
async page => {
    const errors = [];
    const onConsole = msg => { if (msg.type() === 'error') errors.push(msg.text()); };
    const onError = error => errors.push(error.message);
    page.on('console', onConsole);
    page.on('pageerror', onError);
    try {
        return await page.evaluate(async () => {
            const THREE = await import('three');
            const STD = await import('three-std');
            const { createViewportStream } = await import('./js/editor/viewport_stream.js');
            const HEADER_BYTES = 64;
            const W = { capacity: 2, seq: 3, width: 4, height: 5, stride: 6, format: 7, flags: 8, echo: 9, ack: 10, lock: 11 };
            const width = 300;   // 1200 bytes per row: a WebGPU readback pads it to 1280
            const height = 180;
            const results = [];

            for (const backend of ['WebGPU', 'TSL_GL', 'WebGL']) {
                const T = backend === 'WebGL' ? STD : THREE;
                const renderer = backend === 'WebGL'
                    ? new STD.WebGLRenderer({ antialias: false, alpha: true })
                    : new THREE.WebGPURenderer({ antialias: false, alpha: true, forceWebGL: backend === 'TSL_GL' });
                renderer.setPixelRatio(1);
                renderer.setSize(width, height, false);
                if (renderer.init) await renderer.init();
                if (backend === 'WebGPU' && !renderer.backend.isWebGPUBackend) throw Error('WebGPU unavailable');

                // Red everywhere, green in the top-left quarter, blue in the bottom-right quarter.
                const scene = new T.Scene();
                const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 10);
                camera.position.z = 5;
                const quad = (color, x, y, w, h) => {
                    const mesh = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color, toneMapped: false }));
                    mesh.position.set(x, y, 0);
                    scene.add(mesh);
                };
                quad(0xff0000, 0, 0, 2, 2);
                quad(0x00ff00, -0.5, 0.5, 1, 1);
                quad(0x0000ff, 0.5, -0.5, 1, 1);
                scene.children[1].position.z = 1;
                scene.children[2].position.z = 1;

                const stride = Math.ceil((width * 4) / 256) * 256;
                const capacity = stride * height;
                const buffer = new ArrayBuffer(HEADER_BYTES + capacity);
                const words = new Uint32Array(buffer, 0, 16);
                words[0] = 0x46564a4d;
                words[1] = 1;
                words[W.capacity] = capacity;
                const pixels = new Uint8Array(buffer, HEADER_BYTES, capacity);

                const frames = [];
                let waiting = null;
                const stream = createViewportStream({
                    getRenderer: () => renderer,
                    send: (type, data) => {
                        frames.push({ type, ...data });
                        if (waiting) { const done = waiting; waiting = null; done(); }
                    },
                    renderNow: () => { renderer.render(scene, camera); stream.afterRender(); },
                });
                const nextFrame = () => new Promise((resolve, reject) => {
                    waiting = resolve;
                    setTimeout(() => reject(Error(`${backend}: no frame within 2 s`)), 2000);
                });
                if (!stream.attachBuffer(buffer)) throw Error(`${backend}: buffer refused`);
                stream.setState({ enabled: true, width, height });

                // Row 0 of the image is the top row, whatever order the buffer holds.
                const pixelAt = (x, y) => {
                    const bottomUp = (words[W.flags] & 1) !== 0;
                    const row = bottomUp ? words[W.height] - 1 - y : y;
                    const at = row * words[W.stride] + x * 4;
                    const bgra = words[W.format] === 1;
                    return [pixels[at + (bgra ? 2 : 0)], pixels[at + 1], pixels[at + (bgra ? 0 : 2)], pixels[at + 3]];
                };
                const expectColor = (label, got, want) => {
                    if (got.some((value, i) => Math.abs(value - want[i]) > 2)) {
                        throw Error(`${backend}: ${label} is ${got.join(',')}, expected ${want.join(',')}`);
                    }
                };

                // A frame of the loop.
                let arrived = frames.length ? Promise.resolve() : nextFrame();
                renderer.render(scene, camera);
                stream.afterRender();
                await arrived;
                if (words[W.width] !== width || words[W.height] !== height) {
                    throw Error(`${backend}: frame is ${words[W.width]}x${words[W.height]}`);
                }
                if (words[W.lock] !== 0) throw Error(`${backend}: the lock was left taken`);
                expectColor('top left', pixelAt(40, 20), [0, 255, 0, 255]);
                expectColor('bottom right', pixelAt(width - 40, height - 20), [0, 0, 255, 255]);
                expectColor('top right', pixelAt(width - 40, 20), [255, 0, 0, 255]);
                expectColor('bottom left', pixelAt(40, height - 20), [255, 0, 0, 255]);

                // Frames on request: how long the host waits, from sending the request to the echo.
                const waits = [];
                for (let i = 0; i < 20; i += 1) {
                    const request = 100 + i;
                    scene.children[1].material.color.setHex(i % 2 ? 0x00ff00 : 0xffff00);
                    arrived = nextFrame();
                    const started = performance.now();
                    stream.handleRequest({ seq: request });
                    await arrived;
                    waits.push(performance.now() - started);
                    if (words[W.echo] !== request) throw Error(`${backend}: request ${request} echoed as ${words[W.echo]}`);
                    expectColor(`requested frame ${i}`, pixelAt(40, 20), i % 2 ? [0, 255, 0, 255] : [255, 255, 0, 255]);
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                waits.sort((a, b) => a - b);

                results.push({
                    backend,
                    format: words[W.format] === 1 ? 'bgra8' : 'rgba8',
                    stride: words[W.stride],
                    bottomUp: (words[W.flags] & 1) !== 0,
                    premultiplied: (words[W.flags] & 2) !== 0,
                    requestMedianMs: Number(waits[waits.length >> 1].toFixed(2)),
                    requestWorstMs: Number(waits[waits.length - 1].toFixed(2)),
                    stats: stream.getStats(),
                });
                stream.setState({ enabled: false });
                renderer.dispose();
            }
            return results;
        });
    } finally {
        page.off('console', onConsole);
        page.off('pageerror', onError);
        if (errors.length) console.log('page errors:', errors.slice(0, 5));
    }
}
