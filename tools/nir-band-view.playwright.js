// node tools/split_smoke_server.mjs 8901
// playwright-cli open http://127.0.0.1:8901/ --browser=msedge
// playwright-cli run-code --filename=tools/nir-band-view.playwright.js
//
// NIR band view (web/js/nir_band_view.js) on both node backends: a hedge and a
// fence painted the same green, as scalar colours and through texture maps,
// lit by a dim white light and an IR illuminator that is black in RGB. In RGB
// the pairs match; as NIR bands the foliage-tagged hedge reads far brighter
// than the paint on both paths, switching back restores the RGB render, and
// PowerShot's tube takes the band input (setNirBands).
async page => {
    const errors = [];
    const onConsole = (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 300)); };
    const onError = (error) => errors.push(error.message);
    page.on('console', onConsole);
    page.on('pageerror', onError);
    try {
        const result = await page.evaluate(async () => {
            const THREE = await import('three');
            const { uniform } = await import('three/tsl');
            const { createNirBandView } = await import('./js/nir_band_view.js');
            const { createIrEmitterGate } = await import('./js/ir_emitters.js');
            const { installHdriDiffuseSplit } = await import('./js/environment_lighting.js');
            const { InfraredPipeline, NIR_BAND_WEIGHTS, INFRARED_PRESETS, applyInfraredProfile } = await import('powershot-threejs/infrared');
            installHdriDiffuseSplit(uniform(1));
            const W = 96, H = 48;
            const out = [];
            for (const backend of ['WebGPU', 'TSL_GL']) {
                const renderer = new THREE.WebGPURenderer({ forceWebGL: backend === 'TSL_GL' });
                renderer.setSize(W, H);
                await renderer.init();
                const scene = new THREE.Scene();
                const green = new THREE.Color().setRGB(0.05, 0.18, 0.04);
                const map = new THREE.DataTexture(new Float32Array([0.05, 0.18, 0.04, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
                map.colorSpace = THREE.LinearSRGBColorSpace;
                map.needsUpdate = true;
                const make = (name, nirAlbedo, textured) => {
                    const material = new THREE.MeshStandardNodeMaterial({
                        name, roughness: 1, metalness: 0,
                        color: textured ? new THREE.Color(1, 1, 1) : green.clone(),
                        map: textured ? map : null,
                    });
                    material.userData.nirAlbedo = nirAlbedo;
                    return material;
                };
                const materials = [make('Hedge', 0.55, false), make('Fence_Paint', 0.07, false), make('HedgeMap', 0.55, true), make('FenceMap', 0.07, true)];
                materials.forEach((material, i) => {
                    const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.6), material);
                    plane.position.x = -1.5 + i;
                    scene.add(plane);
                });
                const white = new THREE.PointLight(0xffffff, 6, 0, 2);
                white.position.set(0, 0, 3);
                const ir = new THREE.PointLight(0x000000, 30, 0, 2);
                ir.position.set(0, 0, 3);
                ir.userData.emitterClass = 'ir';
                scene.add(white, ir);
                const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
                camera.position.z = 5;
                const target = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType });
                const read = async () => {
                    renderer.setRenderTarget(target);
                    await renderer.renderAsync(scene, camera);
                    renderer.setRenderTarget(null);
                    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H);
                    return materials.map((_, i) => {
                        const x0 = 12 + i * 24 - 4;
                        const sum = [0, 0, 0];
                        for (let y = 20; y < 28; y++) for (let x = x0; x < x0 + 8; x++) {
                            for (let k = 0; k < 3; k++) sum[k] += THREE.DataUtils.fromHalfFloat(pixels[(y * W + x) * 4 + k]);
                        }
                        return sum.map((v) => v / 64);
                    });
                };
                const gate = createIrEmitterGate();
                const view = createNirBandView({ scene });

                gate([ir], false, 1);
                const rgb = await read();

                gate([ir], true, 1);
                view.setActive(true);
                for (let i = 0; i < 200 && !view.active; i++) await new Promise((r) => setTimeout(r, 20));
                view.beforeRender();
                const bandRegions = await read();
                view.afterRender();
                const flux = bandRegions.map((c) => c[0] * NIR_BAND_WEIGHTS[0] + c[1] * NIR_BAND_WEIGHTS[1] + c[2] * NIR_BAND_WEIGHTS[2]);

                // The tube collapses the band render itself.
                const tube = new InfraredPipeline(renderer);
                applyInfraredProfile(tube, INFRARED_PRESETS.gen3_white_phosphor_nir);
                tube.setNirBands(true);
                tube.setSize(W, H);
                tube.renderTexture(target.texture, 1, { dt: 1 / 60 });
                await renderer.backend.device?.queue.onSubmittedWorkDone();

                view.setActive(false);
                gate([ir], false, 1);
                const restored = await read();
                const restoredNodes = materials.every((m) => m.colorNode === null);
                view.dispose();
                tube.dispose();
                target.dispose();
                await renderer.dispose();
                const round = (v) => Math.round(v * 1e4) / 1e4;
                out.push({
                    backend,
                    active: true,
                    rgbLum: rgb.map((c) => round(c[1])),
                    flux: flux.map(round),
                    restoredLum: restored.map((c) => round(c[1])),
                    restoredNodes,
                });
            }
            return out;
        });
        for (const r of result) {
            const [hedge, fence, hedgeMap, fenceMap] = r.flux;
            const [rh, rf, rhm, rfm] = r.rgbLum;
            const fail = (msg) => { throw Error(`${r.backend}: ${msg} ${JSON.stringify(r)}`); };
            if (!(rh > 0.01 && Math.abs(rh - rf) < rh * 0.02 && Math.abs(rhm - rfm) < rhm * 0.02)) fail('RGB metamer pair differs');
            if (!(hedge > fence * 4 && hedgeMap > fenceMap * 4)) fail('NIR bands do not separate foliage from paint');
            if (!(Math.abs(hedgeMap - hedge) < hedge * 0.1)) fail('texture path disagrees with scalar path');
            if (!(r.restoredNodes && r.restoredLum.every((v, i) => Math.abs(v - r.rgbLum[i]) < 1e-3))) fail('switching back did not restore RGB');
        }
        if (errors.length) throw Error(JSON.stringify(errors));
        return result;
    } finally {
        page.off('console', onConsole);
        page.off('pageerror', onError);
    }
}
