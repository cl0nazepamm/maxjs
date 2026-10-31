// node tools/split_smoke_server.mjs 8901
// playwright-cli open http://127.0.0.1:8901/ --browser=msedge
// playwright-cli run-code --filename=tools/light-probes.playwright.js
//
// Bakes web/js/light_probes.js grids on WebGPU, TSL_GL and classic WebGL and checks
// that bounce light reaches a wall the light never hits directly, that a staged bake
// swaps in only once complete, and that Max probe-grid helper volumes map their
// local divisions onto world axes.
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
            const { createLightProbeSystem, autoVolume, volumeFromHelper } = await import('./js/light_probes.js');
            const { installMaxLightsRenderer } = await import('./js/max_lights_node.js');

            // A rotated helper (Max Z-up under the -90 deg X basis) maps divX/divY/divZ onto
            // world X / -Z / Y.
            const helper = new THREE.Object3D();
            helper.rotation.x = -Math.PI / 2;
            helper.position.set(10, 0, 0);
            const helperVolume = volumeFromHelper(helper, [400, 200, 100], [12, 6, 3]);
            if (helperVolume.resolution.join() !== '12,3,6') throw Error(`helper divisions mapped to ${helperVolume.resolution}`);
            if (Math.abs(helperVolume.max[1] - helperVolume.min[1] - 100) > 1e-3) throw Error('helper height lost');

            const results = [];
            for (const backend of ['WebGPU', 'TSL_GL', 'WebGL']) {
                const classic = backend === 'WebGL';
                const renderer = classic
                    ? new STD.WebGLRenderer({ antialias: false })
                    : new THREE.WebGPURenderer({ forceWebGL: backend === 'TSL_GL' });
                renderer.setSize(128, 96);
                if (renderer.init) await renderer.init();
                if (!classic) installMaxLightsRenderer(renderer);
                const M = classic ? STD : THREE;
                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(60, 128 / 96, 1, 2000);
                camera.position.set(0, 100, 380);
                camera.lookAt(0, 100, 0);
                // Room in cm: the spot only hits the bright floor patch; the back wall
                // facing the camera is lit by bounce alone.
                const wallMaterial = new M.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
                const room = new THREE.Mesh(new THREE.BoxGeometry(400, 300, 400), wallMaterial);
                room.material.side = THREE.BackSide;
                room.position.y = 150;
                scene.add(room);
                const patch = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new M.MeshStandardMaterial({ color: 0xff3300, roughness: 1 }));
                patch.rotation.x = -Math.PI / 2;
                patch.position.y = 0.5;
                scene.add(patch);
                const spot = new THREE.SpotLight(0xffffff, 4e5, 0, Math.PI / 9, 0, 2);
                spot.position.set(0, 290, 0);
                spot.target.position.set(0, 0, 0);
                scene.add(spot, spot.target);
                scene.updateMatrixWorld(true);

                const target = classic ? new STD.WebGLRenderTarget(128, 96) : new THREE.RenderTarget(128, 96);
                const draw = async () => {
                    renderer.setRenderTarget(target);
                    renderer.render(scene, camera);
                    if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
                    let pixels;
                    if (classic) {
                        pixels = new Uint8Array(128 * 96 * 4);
                        renderer.readRenderTargetPixels(target, 0, 0, 128, 96, pixels);
                    } else {
                        pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 96);
                    }
                    renderer.setRenderTarget(null);
                    return pixels;
                };
                // Back wall above the patch: rows near the top of the frame. WebGPU
                // reads rows top-down, the WebGL backends bottom-up.
                const topDown = renderer.backend?.isWebGPUBackend === true;
                const pixelIndex = (x, y) => ((topDown ? 95 - y : y) * 128 + x) * 4;
                const wallLuma = (pixels) => {
                    let sum = 0, n = 0;
                    for (let y = 70; y < 90; y++) for (let x = 44; x < 84; x++) {
                        const i = pixelIndex(x, y);
                        sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
                        n++;
                    }
                    return sum / n;
                };
                const wallRedBias = (pixels) => {
                    let r = 0, b = 0;
                    for (let y = 70; y < 90; y++) for (let x = 44; x < 84; x++) {
                        const i = pixelIndex(x, y);
                        r += pixels[i];
                        b += pixels[i + 2];
                    }
                    return r - b;
                };

                const dark = wallLuma(await draw());
                const probes = createLightProbeSystem({ renderer, scene });
                probes.setSettings({ bounces: 1, cubemapSize: 16, probesPerFrame: 16 });
                probes.setVolumes([autoVolume(new THREE.Box3().setFromObject(room), 6)]);
                // Staged: nothing swaps in until every pass of every grid is done.
                probes.requestBake();
                let steps = 0;
                while (probes.baking && steps < 1000) {
                    await new Promise((r) => setTimeout(r, 0)); // module load + frame cadence
                    probes.update();
                    if (probes.grids.length && probes.baking) throw Error(`${backend}: partial bake was published`);
                    steps++;
                }
                if (probes.grids.length !== 1) throw Error(`${backend}: bake never published (${steps} steps)`);
                const lit = await draw();
                const bounce = wallLuma(lit);
                if (bounce < dark + 6) throw Error(`${backend}: probes added no bounce light (${dark.toFixed(1)} -> ${bounce.toFixed(1)})`);
                if (wallRedBias(lit) <= 0) throw Error(`${backend}: bounce light lost the red floor color`);

                // A rebake replaces the published grid and keeps exactly one in the scene.
                await probes.bakeNow();
                const gridCount = scene.children.filter((o) => o.isLightProbeGrid).length;
                if (gridCount !== 1) throw Error(`${backend}: ${gridCount} grids in the scene after rebake`);
                probes.setSettings({ showProbes: true });
                const helpers = scene.children.filter((o) => o.name === '__maxjs_light_probe_helper__').length;
                if (helpers !== 1) throw Error(`${backend}: probe helper missing`);
                probes.setEnabled(false);
                const off = wallLuma(await draw());
                if (Math.abs(off - dark) > 2) throw Error(`${backend}: disabled probes still light the wall`);

                probes.dispose();
                target.dispose();
                scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
                await renderer.dispose();
                results.push({ backend, steps, dark: +dark.toFixed(1), bounce: +bounce.toFixed(1), off: +off.toFixed(1) });
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
