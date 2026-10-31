// node tools/split_smoke_server.mjs 8901
// playwright-cli open http://127.0.0.1:8901/ --browser=msedge
// playwright-cli run-code --filename=tools/lightmap-pathtracer.playwright.js
//
// GI lightmaps (web/js/lightmap_baker.js) on WebGPU and TSL_GL: baked from a probe
// grid into uv1, they light a wall the light never reaches and replace the probe
// grid on that material. Then the WebGPU path tracer (web/js/editor/path_tracer.js)
// accumulates samples, follows a transform edit and a deform refit, and captures a
// fixed sample count.
async page => {
    const errors = [];
    const onConsole = msg => { if (msg.type() === 'error') errors.push(msg.text()); };
    const onError = error => errors.push(error.message);
    page.on('console', onConsole);
    page.on('pageerror', onError);
    try {
        return await page.evaluate(async () => {
            const THREE = await import('three');
            const { createLightProbeSystem, autoVolume } = await import('./js/light_probes.js');
            const { createLightmapBaker, isLightmapCandidate } = await import('./js/lightmap_baker.js');
            const { installMaxLightsRenderer } = await import('./js/max_lights_node.js');
            const { createPathTracer, normalizePathTracerSettings } = await import('./js/editor/path_tracer.js');

            function buildRoom() {
                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(60, 128 / 96, 1, 2000);
                camera.position.set(0, 100, 380);
                camera.lookAt(0, 100, 0);
                const room = new THREE.Mesh(new THREE.BoxGeometry(400, 300, 400),
                    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.BackSide }));
                room.position.y = 150;
                // Box faces carry non-overlapping uv; reuse them as the Max channel 2 set.
                room.geometry.setAttribute('uv1', room.geometry.getAttribute('uv').clone());
                const patch = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: 0xff3300, roughness: 1 }));
                patch.rotation.x = -Math.PI / 2;
                patch.position.y = 0.5;
                const spot = new THREE.SpotLight(0xffffff, 4e5, 0, Math.PI / 9, 0, 2);
                spot.position.set(0, 290, 0);
                spot.target.position.set(0, 0, 0);
                scene.add(room, patch, spot, spot.target);
                scene.updateMatrixWorld(true);
                return { scene, camera, room, patch };
            }

            async function readPixels(renderer, target) {
                if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
                return renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 96);
            }
            const regionLuma = (renderer, pixels, y0, y1) => {
                const topDown = renderer.backend?.isWebGPUBackend === true;
                let sum = 0, n = 0;
                for (let y = y0; y < y1; y++) for (let x = 44; x < 84; x++) {
                    const i = ((topDown ? 95 - y : y) * 128 + x) * 4;
                    sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
                    n++;
                }
                return sum / n;
            };

            const results = [];
            for (const backend of ['WebGPU', 'TSL_GL']) {
                const renderer = new THREE.WebGPURenderer({ forceWebGL: backend === 'TSL_GL' });
                renderer.setSize(128, 96);
                await renderer.init();
                installMaxLightsRenderer(renderer);
                const { scene, camera, room, patch } = buildRoom();
                const target = new THREE.RenderTarget(128, 96);
                const draw = async () => {
                    renderer.setRenderTarget(target);
                    renderer.render(scene, camera);
                    const pixels = await readPixels(renderer, target);
                    renderer.setRenderTarget(null);
                    return regionLuma(renderer, pixels, 70, 90);
                };
                const dark = await draw();
                const probes = createLightProbeSystem({ renderer, scene });
                probes.setSettings({ bounces: 1, cubemapSize: 16 });
                probes.setVolumes([autoVolume(new THREE.Box3().setFromObject(room), 6)]);
                await probes.bakeNow();
                const probeLit = await draw();

                if (!isLightmapCandidate(room) || isLightmapCandidate(patch)) throw Error(`${backend}: lightmap candidates wrong`);
                const baker = createLightmapBaker({ renderer });
                const started = baker.start(probes.grids, [room, patch], { resolution: 128, samples: 16 });
                if (started.meshes !== 1) throw Error(`${backend}: ${started.meshes} lightmap meshes`);
                let done = null;
                for (let i = 0; i < 10 && !done; i++) done = baker.update(4);
                if (!done?.has(room)) throw Error(`${backend}: lightmap bake did not finish`);
                room.material.lightMap = done.get(room);
                room.material.needsUpdate = true;
                const lightmapped = await draw();
                // The probe grid no longer lights the lightmapped wall: removing it keeps the result.
                probes.setEnabled(false);
                const lightmapOnly = await draw();
                if (lightmapped < dark + 6) throw Error(`${backend}: lightmap added no bounce (${dark} -> ${lightmapped})`);
                if (Math.abs(lightmapOnly - lightmapped) > 3) throw Error(`${backend}: probes still lit the lightmapped wall (${lightmapped} vs ${lightmapOnly})`);
                if (Math.abs(lightmapped - probeLit) > probeLit * 0.5) throw Error(`${backend}: lightmap (${lightmapped}) far from live probes (${probeLit})`);

                let pathTrace = null;
                if (backend === 'WebGPU') {
                    room.material.lightMap = null;
                    room.material.needsUpdate = true;
                    probes.dispose();
                    const settings = normalizePathTracerSettings({ bounces: 4 });
                    const ptErrors = [];
                    const tracer = createPathTracer({ renderer, scene, camera, settings, onError: (e) => ptErrors.push(String(e?.stack || e)) });
                    if (!tracer.supported) throw Error('path tracer unsupported on native WebGPU');
                    tracer.start();
                    const traceFrame = async () => {
                        renderer.setRenderTarget(target);
                        const ok = tracer.render();
                        const pixels = await readPixels(renderer, target);
                        renderer.setRenderTarget(null);
                        return { ok, wall: regionLuma(renderer, pixels, 70, 90), floor: regionLuma(renderer, pixels, 5, 25) };
                    };
                    let frame = { ok: false };
                    for (let i = 0; i < 400 && !frame.ok; i++) {
                        await new Promise((r) => setTimeout(r, 10));
                        frame = await traceFrame();
                    }
                    if (!frame.ok) throw Error(`path tracer never rendered: ${ptErrors.join(' | ')}`);
                    tracer.setCaptureMode(true, 8);
                    for (let i = 0; i < 400 && !tracer.isCaptureReady(); i++) {
                        await new Promise((r) => setTimeout(r, 10));
                        frame = await traceFrame();
                    }
                    if (!tracer.isCaptureReady()) throw Error(`path tracer capture never converged: ${ptErrors.join(' | ')}`);
                    if (frame.floor < 20 || frame.wall < 1) throw Error(`path traced image too dark: ${JSON.stringify(frame)}`);
                    const before = frame.floor;
                    patch.position.x += 400; // move the red patch out of view
                    patch.updateMatrixWorld(true);
                    tracer.markTransformsDirty();
                    tracer.setCaptureMode(true, 8);
                    for (let i = 0; i < 400 && !tracer.isCaptureReady(); i++) {
                        await new Promise((r) => setTimeout(r, 10));
                        frame = await traceFrame();
                    }
                    if (Math.abs(frame.floor - before) < 2) throw Error(`transform edit did not reach the path tracer (${before} -> ${frame.floor})`);
                    const position = room.geometry.getAttribute('position');
                    for (let i = 0; i < position.count; i++) position.setY(i, position.getY(i) * 0.98);
                    position.needsUpdate = true;
                    tracer.markDeformsDirty();
                    tracer.setCaptureMode(true, 4);
                    for (let i = 0; i < 400 && !tracer.isCaptureReady(); i++) {
                        await new Promise((r) => setTimeout(r, 10));
                        frame = await traceFrame();
                    }
                    if (!tracer.isCaptureReady()) throw Error('deform refit stalled the path tracer');
                    if (ptErrors.length) throw Error(ptErrors.join(' | '));
                    tracer.dispose();
                    pathTrace = { floor: +frame.floor.toFixed(1), wall: +frame.wall.toFixed(1), movedFrom: +before.toFixed(1) };
                } else {
                    probes.dispose();
                }
                baker.dispose();
                target.dispose();
                scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
                await renderer.dispose();
                results.push({ backend, dark: +dark.toFixed(1), probeLit: +probeLit.toFixed(1), lightmapped: +lightmapped.toFixed(1), lightmapOnly: +lightmapOnly.toFixed(1), pathTrace });
            }
            return results;
        }).then(result => {
            if (errors.length) throw Error(JSON.stringify({ result, errors }, null, 2));
            return result;
        });
    } finally {
        page.off('console', onConsole);
        page.off('pageerror', onError);
    }
}
