// Run against tools/split_smoke_server.mjs with playwright-cli run-code.
async page => {
    const errors = [];
    const onConsole = msg => { if (msg.type() === 'error') errors.push(msg.text()); };
    const onError = error => errors.push(error.message);
    page.on('console', onConsole);
    page.on('pageerror', onError);
    try {
        const results = await page.evaluate(async () => {
            const THREE = await import('three');
            const { createMaterialBuilder } = await import('./js/material_builder.js');
            const fixtures = [
                'gltf_pbr_glass_dispersion', 'open_pbr_surface_honey',
                'open_pbr_surface_pearl', 'open_pbr_surface_velvet',
                'standard_surface_color3_vec3_cm_test', 'standard_surface_combined_test',
                'standard_surface_conditional_if_float', 'standard_surface_heightnormal',
                'standard_surface_heighttonormal_normal_input', 'standard_surface_image_transform',
                'standard_surface_ior_test', 'standard_surface_opacity_only_test',
                'standard_surface_opacity_test', 'standard_surface_rotate2d_test',
                'standard_surface_rotate3d_test', 'standard_surface_roughness_test',
                'standard_surface_sheen_test', 'standard_surface_specular_test',
                'standard_surface_texture_opacity_test', 'standard_surface_thin_film_ior_clamp_test',
                'standard_surface_thin_film_rainbow_test', 'standard_surface_transmission_only_test',
                'standard_surface_transmission_rough', 'standard_surface_transmission_test',
            ];
            const results = [];
            for (const backend of ['WebGPU', 'TSL_GL']) {
                const renderer = new THREE.WebGPURenderer({ forceWebGL: backend === 'TSL_GL' });
                renderer.setSize(128, 128);
                await renderer.init();
                const builder = createMaterialBuilder({ renderer });
                const scene = new THREE.Scene();
                scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
                const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
                camera.position.z = 4;
                const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16));
                scene.add(mesh);
                const base = new URL('./vendor/three-r186/examples/materialx/', location.href).href;
                for (const fixture of fixtures) {
                    const material = builder.buildForNode({ nd: { mat: {
                        model: 'MaterialXMaterial', materialXFile: `${base}${fixture}.mtlx`, materialXBase: base,
                    } }, geom: mesh.geometry });
                    const deadline = performance.now() + 10000;
                    while (material.userData.maxjsMaterialXPending && performance.now() < deadline) {
                        await new Promise(resolve => setTimeout(resolve, 20));
                    }
                    if (material.userData.maxjsMaterialXPending || material.userData.maxjsMaterialXError) {
                        throw Error(`${backend}/${fixture}: ${material.userData.maxjsMaterialXError || 'load timeout'}`);
                    }
                    mesh.material.dispose();
                    mesh.material = material;
                    await renderer.compileAsync(scene, camera);
                    renderer.render(scene, camera);
                    if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
                    results.push(`${backend}/${fixture}`);
                }
                // Max exporter compatibility: a weight+map must multiply, zero
                // must disable the lobe, and duplicate normal wrappers must
                // match a single decode. Check actual pixels, not just parsing.
                const wrap = inputs => `<materialx version="1.39">
                    <constant name="weightMap" type="float"><input name="value" type="float" value="0.4" /></constant>
                    <normalmap name="n1" type="vector3"><input name="in" type="vector3" value="0.7,0.4,1" /></normalmap>
                    <normalmap name="n2" type="vector3"><input name="in" type="vector3" nodename="n1" /></normalmap>
                    <open_pbr_surface name="s" type="surfaceshader">${inputs}</open_pbr_surface>
                    <surfacematerial name="m" type="material"><input name="surfaceshader" type="surfaceshader" nodename="s" /></surfacematerial>
                </materialx>`;
                const renderInline = async inputs => {
                    const material = builder.buildForNode({ nd: { mat: {
                        model: 'MaterialXMaterial', materialXInline: wrap(inputs),
                    } }, geom: mesh.geometry });
                    const deadline = performance.now() + 10000;
                    while (material.userData.maxjsMaterialXPending && performance.now() < deadline) {
                        await new Promise(resolve => setTimeout(resolve, 20));
                    }
                    if (material.userData.maxjsMaterialXPending || material.userData.maxjsMaterialXError) throw Error('Max MaterialX load failed');
                    mesh.material.dispose();
                    mesh.material = material;
                    const target = new THREE.RenderTarget(128, 128);
                    renderer.setRenderTarget(target);
                    await renderer.compileAsync(scene, camera);
                    renderer.render(scene, camera);
                    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 128);
                    renderer.setRenderTarget(null);
                    target.dispose();
                    return pixels;
                };
                for (const [name, authored, expected] of [
                    ['weighted-lobe', '<input name="coat_weight" type="float" value="0.5" nodename="weightMap" />', '<input name="coat_weight" type="float" value="0.2" />'],
                    ['zero-lobe', '<input name="transmission_weight" type="float" value="0" nodename="weightMap" />', '<input name="transmission_weight" type="float" value="0" />'],
                    ['nested-normal', '<input name="geometry_normal" type="vector3" nodename="n2" />', '<input name="geometry_normal" type="vector3" nodename="n1" />'],
                ]) {
                    const actual = await renderInline(authored);
                    const reference = await renderInline(expected);
                    const delta = actual.reduce((sum, value, index) => sum + Math.abs(value - reference[index]), 0);
                    if (delta > 10) throw Error(`${backend}/${name}: pixel mismatch ${delta}`);
                    results.push(`${backend}/max-export-${name}`);
                }
                mesh.material.dispose();
                mesh.geometry.dispose();
                builder.dispose();
                await renderer.dispose();
            }
            return results;
        });
        if (errors.length) throw Error(JSON.stringify(errors));
        return { compiled: results.length, fixtures: results };
    } finally {
        page.off('console', onConsole);
        page.off('pageerror', onError);
    }
}
