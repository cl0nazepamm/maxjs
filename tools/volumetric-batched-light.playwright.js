// node tools/split_smoke_server.mjs 8901
// playwright-cli open http://127.0.0.1:8901/ --browser=msedge
// playwright-cli run-code --filename=tools/volumetric-batched-light.playwright.js
//
// Volumetric scattering from a point light on both node backends, through the
// MaxLightsNode batched path (no shadow) and the per-light path (shadow). r187's
// VolumetricLightingModel only scatters analytic light nodes, so the batched
// path's finite-light marker must advertise isAnalyticLightNode.
async page => {
    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { Fn, float } = await import('three/tsl');
        const { installMaxLightsRenderer } = await import('./js/max_lights_node.js');
        const out = [];
        for (const backend of ['WebGPU', 'TSL_GL']) {
            const renderer = new THREE.WebGPURenderer({ forceWebGL: backend === 'TSL_GL' });
            renderer.setSize(64, 64);
            await renderer.init();
            renderer.shadowMap.enabled = true;
            installMaxLightsRenderer(renderer);
            const target = new THREE.RenderTarget(64, 64, { type: THREE.HalfFloatType });
            const read = async (castShadow) => {
                const scene = new THREE.Scene();
                const material = new THREE.VolumeNodeMaterial();
                material.steps = 16;
                material.scatteringNode = Fn(() => float(1));
                scene.add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), material));
                const light = new THREE.PointLight(0xffffff, 40, 0, 2);
                light.castShadow = castShadow;
                scene.add(light);
                const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
                camera.position.set(0, 0, 6);
                camera.lookAt(0, 0, 0);
                renderer.setRenderTarget(target);
                await renderer.renderAsync(scene, camera);
                const pixels = await renderer.readRenderTargetPixelsAsync(target, 24, 24, 16, 16);
                renderer.setRenderTarget(null);
                material.dispose();
                let sum = 0;
                for (let i = 0; i < pixels.length; i += 4) sum += THREE.DataUtils.fromHalfFloat(pixels[i]);
                return Math.round((sum / (pixels.length / 4)) * 1000) / 1000;
            };
            const batched = await read(false);
            const shadowed = await read(true);
            target.dispose();
            await renderer.dispose();
            out.push({ backend, batched, shadowed });
        }
        return out;
    });
    for (const r of result) {
        if (!(r.shadowed > 0.01)) throw Error(`${r.backend}: no scattering from the shadowed light ${JSON.stringify(r)}`);
        if (!(r.batched > r.shadowed * 0.5)) throw Error(`${r.backend}: batched light does not scatter ${JSON.stringify(result)}`);
    }
    return result;
}
