// node tools/split_smoke_server.mjs 8901
// playwright-cli open http://127.0.0.1:8901/ --browser=msedge
// playwright-cli run-code --filename=tools/temporal-resize.playwright.js
//
// TRAA, SSGI temporal reprojection and SSR denoising at a reduced post FX
// resolution scale while the canvas resizes. Stock r187 temporal nodes size
// their depth history from the drawing buffer and fail WebGPU's full-subresource
// depth copy rule here; the patched vendor nodes (web/THREE_MIGRATION.md) do not.
async page => {
    const errors = [];
    const onConsole = msg => { if (msg.type() === 'error' || /WebGPU|validation|copyTextureToTexture/i.test(msg.text())) errors.push(`${msg.type()}: ${msg.text()}`); };
    const onError = error => errors.push(error.message);
    page.on('console', onConsole);
    page.on('pageerror', onError);
    try {
        const result = await page.evaluate(async () => {
            const THREE = await import('three');
            const { createMaxJSFxController } = await import('./js/maxjs_fx.js');
            const { installMaxLightsRenderer } = await import('./js/max_lights_node.js');
            const out = [];
            for (const backend of ['WebGPU', 'TSL_GL']) {
                const renderer = new THREE.WebGPURenderer({ forceWebGL: backend === 'TSL_GL' });
                renderer.setSize(320, 200);
                document.body.appendChild(renderer.domElement);
                await renderer.init();
                installMaxLightsRenderer(renderer);
                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(50, 320 / 200, 0.1, 100);
                camera.position.set(0, 2, 7);
                camera.lookAt(0, 1, 0);
                scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshStandardNodeMaterial({ color: 0xaaaaaa, roughness: 0.2 })));
                const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardNodeMaterial({ color: 0x666666, roughness: 0.3 }));
                floor.rotation.x = -Math.PI / 2;
                scene.add(floor);
                scene.add(new THREE.DirectionalLight(0xffffff, 3));
                const fxErrors = [];
                const fx = createMaxJSFxController({ renderer, scene, camera, backendLabel: backend, onError: (...a) => fxErrors.push(a.map(String).join(' ')) });
                fx.setResolutionScale(0.65);
                fx.setTRAAEnabled(true);
                fx.setEnabled(true); // SSGI
                fx.setSSROptions({ denoise: true });
                fx.setSSREnabled(true);
                const sizes = [[320, 200], [333, 211], [400, 250], [257, 160], [320, 200]];
                for (const [w, h] of sizes) {
                    renderer.setSize(w, h);
                    camera.aspect = w / h;
                    camera.updateProjectionMatrix();
                    fx.resize?.();
                    for (let i = 0; i < 4; i++) fx.render();
                    if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
                    await new Promise((r) => setTimeout(r, 30));
                }
                fx.dispose?.();
                renderer.domElement.remove();
                await renderer.dispose();
                out.push({ backend, fxErrors });
            }
            return out;
        });
        if (errors.length || result.some((r) => r.fxErrors.length)) throw Error(JSON.stringify({ result, errors }, null, 2));
        return result;
    } finally {
        page.off('console', onConsole);
        page.off('pageerror', onError);
    }
}
