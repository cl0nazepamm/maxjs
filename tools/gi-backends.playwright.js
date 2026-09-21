// Serve the repository root on port 8780, then run:
// playwright-cli run-code --filename=tools/gi-backends.playwright.js
async page => {
    const results = [];
    const fields = [];
    for (const backend of ['webgl', 'webgpu']) {
        const tab = await page.context().newPage();
        const errors = [];
        tab.on('pageerror', error => errors.push(error.message));
        tab.on('console', message => {
            if (['error', 'warning'].includes(message.type())) errors.push(message.text());
        });
        try {
            await tab.goto(`http://127.0.0.1:8780/tools/gi-backends.html?backend=${backend}&maps&emitter&classify&reflections=high&steps=4`);
            await tab.waitForFunction(() => window.ready, null, { timeout: 120000 });
            const result = await tab.evaluate(async () => {
                const { gi, renderer, light } = testGI;
                const before = Array.from(await gi.advanced.debug.read('irr'));
                if (!before.length || !before.every(Number.isFinite) || !before.some(v => v > 0)) throw new Error('Invalid irradiance');
                if (!renderer.lighting.createNode.maxjsAdaptiveLighting) throw new Error('max.js lighting not installed');
                light.intensity *= 3;
                gi.forceLightingRefresh();
                await testGI.step(4);
                const after = await gi.advanced.debug.read('irr');
                if (!after.every(Number.isFinite) || !after.some((v, i) => Math.abs(v - before[i]) > 0.001)) throw new Error('Lighting edits did not reach GI');
                return { backend: renderer.backend.isWebGLBackend ? 'webgl' : 'webgpu', supported: gi.isSupported(), data: gi.hasData(), probes: gi.getStats().probes, before };
            });
            if (result.backend !== backend || !result.supported || !result.data || errors.length) throw new Error(`${backend}: ${errors.join('\n') || 'field unavailable'}`);
            fields.push(result.before);
            delete result.before;
            results.push(result);
        } finally { await tab.close(); }
    }
    const [a, b] = fields;
    if (a.length !== b.length) throw new Error('Atlas sizes differ');
    let delta = 0, scale = 0, max = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]); delta += d; scale += Math.abs(b[i]); max = Math.max(max, d);
    }
    const relative = delta / Math.max(scale, 1e-6);
    if (relative >= 0.005 || max >= 0.02) throw new Error(`Backend mismatch: ${relative}, ${max}`);
    return { results, irradianceDifference: { relative, max } };
}
