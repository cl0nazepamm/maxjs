// node tools/split_smoke_server.mjs 8901
// playwright-cli open http://127.0.0.1:8901/ --browser=msedge
// playwright-cli run-code --filename=tools/speedball-probes.playwright.js
//
// The 'speedball' light probe mode (web/js/speedball_probes.js) on WebGPU and
// TSL_GL: Speedball's traced probes reach a wall the light never hits directly
// through MaxLightsNode, keep the red floor's colour, follow a reflection
// quality change that rebuilds the field, and leave the wall as it was when
// paused or disposed. Also maps a speedballGi block saved before Speedball
// became a probe mode, and checks that a classic WebGLRenderer is refused.
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
            const { createSpeedballProbes } = await import('./js/speedball_probes.js');
            const { installMaxLightsRenderer } = await import('./js/max_lights_node.js');
            const { lightProbesFromLegacySpeedballGi, normalizeLightProbeSettings } = await import('./js/light_probes.js');

            // dream's export: Speedball on with one sized volume, the probe toggle off.
            const legacy = lightProbesFromLegacySpeedballGi({
                enabled: true, intensity: 2.85, rays: 160, cascades: 1, continuous: false, hysteresis: 0.98,
                roughReflections: true, reflectionIntensity: 0.3,
                volumes: [{ min: [-533.276, -39.794, 1432.61], max: [1464.724, 460.206, 1755.61], res: [8, 4, 6] }],
            });
            if (!legacy.enabled || legacy.settings.mode !== 'speedball') throw Error('legacy speedballGi did not map to the speedball mode');
            const sb = legacy.settings.speedball;
            if (sb.intensity !== 2.85 || sb.rays !== 160 || sb.hysteresis !== 0.98 || sb.continuous !== false || sb.reflectionQuality !== 'ultra') {
                throw Error(`legacy tuning lost: ${JSON.stringify(sb)}`);
            }
            if (legacy.volumes[0].resolution.join() !== '8,4,6') throw Error('legacy volume resolution lost');
            if (normalizeLightProbeSettings(legacy.settings).mode !== 'speedball') throw Error('mode did not survive normalization');

            const classicRenderer = new STD.WebGLRenderer();
            if (await createSpeedballProbes({ renderer: classicRenderer, scene: new THREE.Scene() }) !== null) {
                throw Error('classic WebGLRenderer was accepted');
            }
            classicRenderer.dispose();

            const results = [];
            for (const backend of ['WebGPU', 'TSL_GL']) {
                const renderer = new THREE.WebGPURenderer({ forceWebGL: backend === 'TSL_GL' });
                renderer.setSize(128, 96);
                await renderer.init();
                installMaxLightsRenderer(renderer);
                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(60, 128 / 96, 1, 2000);
                camera.position.set(0, 100, 380);
                camera.lookAt(0, 100, 0);
                // Room in cm: the spot only hits the red floor patch; the back wall
                // facing the camera is lit by bounce alone.
                const room = new THREE.Mesh(new THREE.BoxGeometry(400, 300, 400),
                    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.BackSide }));
                room.position.y = 150;
                scene.add(room);
                const patch = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: 0xff3300, roughness: 1 }));
                patch.rotation.x = -Math.PI / 2;
                patch.position.y = 0.5;
                scene.add(patch);
                const spot = new THREE.SpotLight(0xffffff, 4e5, 0, Math.PI / 9, 0, 2);
                spot.position.set(0, 290, 0);
                spot.target.position.set(0, 0, 0);
                scene.add(spot, spot.target);
                scene.updateMatrixWorld(true);

                const target = new THREE.RenderTarget(128, 96);
                const topDown = renderer.backend.isWebGPUBackend === true;
                const draw = async () => {
                    renderer.setRenderTarget(target);
                    renderer.render(scene, camera);
                    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 96);
                    renderer.setRenderTarget(null);
                    return pixels;
                };
                const wall = (pixels) => {
                    let r = 0, g = 0, b = 0, n = 0;
                    for (let y = 70; y < 90; y++) for (let x = 44; x < 84; x++) {
                        const i = ((topDown ? 95 - y : y) * 128 + x) * 4;
                        r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; n++;
                    }
                    return { luma: (r + g + b) / n, redBias: (r - b) / n };
                };
                const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
                const converge = async (speedball, frames = 240) => {
                    for (let i = 0; i < frames; i++) {
                        speedball.update({ camera });
                        await draw();
                        await frame();
                    }
                    if (!speedball.hasData()) throw Error(`${backend}: Speedball produced no probe data`);
                };

                const dark = wall(await draw());
                // One field per page: a failed case must not leave its field behind.
                let speedball = null;
                try {
                    speedball = await createSpeedballProbes({ renderer, scene, settings: { intensity: 10, divisions: 8, rays: 64 } });
                    if (!speedball) throw Error(`${backend}: Speedball unsupported`);
                    speedball.setVolumes([]);
                    speedball.setEnabled(true);
                    await converge(speedball);
                    const lit = wall(await draw());
                    if (lit.luma < dark.luma + 6) throw Error(`${backend}: Speedball added no bounce light (${dark.luma.toFixed(1)} -> ${lit.luma.toFixed(1)})`);
                    if (lit.redBias <= dark.redBias) throw Error(`${backend}: bounce light lost the red floor color`);

                    // Reflection quality is structural: a new field takes over and converges.
                    speedball.setSettings({ reflectionQuality: 'rough' });
                    if (speedball.getStats().reflectionQuality !== 'rough') throw Error(`${backend}: reflection quality not applied`);
                    await converge(speedball, 180);
                    const rebuilt = wall(await draw());
                    if (rebuilt.luma < dark.luma + 6) throw Error(`${backend}: rebuilt field added no bounce light`);

                    speedball.setEnabled(false);
                    for (let i = 0; i < 3; i++) await draw();
                    const paused = wall(await draw());
                    if (Math.abs(paused.luma - dark.luma) > 2) throw Error(`${backend}: paused Speedball still lights the wall`);
                    speedball.dispose();
                    speedball = null;
                    const disposed = wall(await draw());
                    if (Math.abs(disposed.luma - dark.luma) > 2) throw Error(`${backend}: disposed Speedball still lights the wall`);
                    results.push({ backend, dark: +dark.luma.toFixed(1), lit: +lit.luma.toFixed(1), rebuilt: +rebuilt.luma.toFixed(1), paused: +paused.luma.toFixed(1) });
                } finally {
                    speedball?.dispose();
                    target.dispose();
                    scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
                    await renderer.dispose();
                }
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
