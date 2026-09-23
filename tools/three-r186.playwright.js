// node tools/split_smoke_server.mjs 8901
// playwright-cli open http://127.0.0.1:8901/ --browser=msedge
// playwright-cli run-code --filename=tools/three-r186.playwright.js
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
            const { createSky } = await import('./js/scene_sky.js');
            const { createMaxJSFxController } = await import('./js/maxjs_fx.js');
            const { installMaxLightsRenderer } = await import('./js/max_lights_node.js');
            const { createMaterialBuilder } = await import('./js/material_builder.js');
            const { assignGatedMaterialScalar } = await import('./js/material_contract.js');
            if (THREE.REVISION !== '186' || STD.REVISION !== '186') throw Error('Mixed Three versions');
            const results = [];
            for (const backend of ['WebGPU', 'TSL_GL', 'WebGL']) {
                const renderer = backend === 'WebGL'
                    ? new STD.WebGLRenderer({ antialias: false })
                    : new THREE.WebGPURenderer({ forceWebGL: backend === 'TSL_GL' });
                renderer.setSize(256, 192);
                renderer.shadowMap.enabled = true;
                renderer.shadowMap.type = THREE.PCFShadowMap;
                if (renderer.init) await renderer.init();
                if (backend === 'WebGPU' && !renderer.backend.isWebGPUBackend) throw Error('WebGPU unavailable');
                if (backend !== 'WebGL') installMaxLightsRenderer(renderer);
                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(50, 256 / 192, 0.1, 100);
                camera.position.set(0, 2, 7);
                camera.lookAt(0, 1, 0);
                const material = backend === 'WebGL'
                    ? new STD.MeshPhysicalMaterial({ color: 0xaaaaaa, roughness: 0.3, metalness: 0.5 })
                    : new THREE.MeshPhysicalNodeMaterial({ color: 0xaaaaaa, roughness: 0.3, metalness: 0.5 });
                const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), material);
                ball.position.y = 1;
                ball.castShadow = true;
                scene.add(ball);
                const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new STD.MeshPhysicalMaterial({ color: 0x666666, roughness: 0.25 }));
                floor.rotation.x = -Math.PI / 2;
                floor.receiveShadow = true;
                scene.add(floor);
                const lamp = new THREE.PointLight(0xffffff, 35, 30);
                lamp.position.copy(camera.position);
                scene.add(lamp);
                const builder = createMaterialBuilder({ renderer });
                const authoredMaterial = builder.buildForNode({
                    nd: { mat: { model: 'MeshPhysicalMaterial', color: [0.5, 0.5, 0.5],
                        specularIntensity: 0, retroreflectivity: 0.75 } }, geom: ball.geometry,
                });
                if (!authoredMaterial.isMeshPhysicalMaterial || authoredMaterial.retroreflectivity !== 0.75) {
                    throw Error(`${backend}: authored retroreflection was lost or routed to Lambert`);
                }
                if (!assignGatedMaterialScalar(authoredMaterial, 'retroreflectivity', 0) ||
                    !assignGatedMaterialScalar(authoredMaterial, 'retroreflectivity', 1)) {
                    throw Error(`${backend}: animated retroreflection did not invalidate its shader`);
                }
                ball.material = authoredMaterial;
                const target = backend === 'WebGL' ? new STD.WebGLRenderTarget(256, 192) : new THREE.RenderTarget(256, 192);
                const draw = async () => {
                    renderer.setRenderTarget(target);
                    renderer.render(scene, camera);
                    if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
                    const pixels = backend === 'WebGL' ? new Uint8Array(256 * 192 * 4)
                        : await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 192);
                    if (backend === 'WebGL') renderer.readRenderTargetPixels(target, 0, 0, 256, 192, pixels);
                    renderer.setRenderTarget(null);
                    return pixels;
                };
                const difference = (a, b) => a.reduce((sum, x, i) => sum + Math.abs(x - b[i]), 0);
                await draw();
                ball.material = material;
                authoredMaterial.dispose();
                const plain = await draw();
                material.retroreflectivity = 1;
                const retro = await draw();
                const retroDelta = difference(plain, retro);
                if (retroDelta < 100) throw Error(`${backend}: retroreflection made no pixel change`);
                const sky = createSky({ scene, renderer });
                await sky.apply({ elevation: 35, sunShadows: true, sunShadowDistance: 40, cloudCoverage: 0 });
                const clear = await draw();
                ball.castShadow = false;
                const unshadowed = await draw();
                const shadowDelta = difference(clear, unshadowed);
                if (shadowDelta < 100) throw Error(`${backend}: SunLight cast no visible shadow`);
                ball.castShadow = true;
                await sky.apply({ elevation: 35, sunShadows: true, sunShadowDistance: 40, cloudCoverage: 0.65 });
                const cloudy = await draw();
                const cloudDelta = difference(clear, cloudy);
                if (cloudDelta < 100 || !sky.sun.isSunLight || !sky.sun.castShadow) throw Error(`${backend}: sky controls failed`);
                const fxErrors = [];
                const passes = [];
                if (backend !== 'WebGL') {
                    const fx = createMaxJSFxController({ renderer, scene, camera, backendLabel: backend, onError: (...args) => fxErrors.push(args.map(String).join(' ')) });
                    fx.setResolutionScale(0.65);
                    for (const effect of ['SSR', 'SSGI', 'GTAO', 'Dof', 'TRAA']) {
                        const setter = effect === 'SSGI' ? 'setEnabled' : `set${effect}Enabled`;
                        fx[setter](true);
                        for (let i = 0; i < 3; i++) fx.render();
                        if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
                        fx[setter](false);
                        passes.push(effect);
                    }
                    fx.setSSROptions({ denoise: true });
                    fx.setSSREnabled(true);
                    for (let i = 0; i < 3; i++) fx.render();
                    if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
                    passes.push('SSR denoise');
                    fx.setSSREnabled(false);
                    fx.render();
                    fx.dispose?.();
                }
                await sky.apply({ sunShadows: false, cloudCoverage: 0 });
                if (!sky.sun.isDirectionalLight || sky.sun.castShadow) throw Error('Legacy sky defaults not restored');
                sky.dispose();
                builder.dispose();
                target.dispose();
                scene.traverse(obj => { obj.geometry?.dispose(); obj.material?.dispose(); obj.dispose(); });
                await renderer.dispose();
                results.push({ backend, retroDelta, cloudDelta, shadowDelta, passes, fxErrors });
            }
            return results;
        }).then(result => {
            if (errors.length || result.some(r => r.fxErrors.length)) throw Error(JSON.stringify({ result, errors }, null, 2));
            return result;
        });
    } finally {
        page.off('console', onConsole);
        page.off('pageerror', onError);
    }
}
