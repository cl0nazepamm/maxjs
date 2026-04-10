// Runtime transform override test — procedural animation on meshes and lights.
// Uses additive offsets so the authored Max transform stays the base.

let box = null;
let light = null;
let frameCount = 0;

function findTargets(ctx) {
    const boxMatches = ctx.scene.findByName('Box001', { exact: true });
    const lightMatches = ctx.scene.findByName('TJS_Point001', { exact: true });
    return {
        box: boxMatches[0] || null,
        light: lightMatches[0] || null,
    };
}

function ensureTargets(ctx) {
    if (!box?.exists) {
        const targets = findTargets(ctx);
        box = targets.box;
        light = targets.light;
        if (box) console.log('[transform_test] Found box:', box.name);
        if (light) console.log('[transform_test] Found light:', light.name);
    }
}

return {
    update(ctx) {
        ensureTargets(ctx);
        if (!box && !light) return;

        frameCount++;
        const t = ctx.clock.elapsed;

        // Animate box with harmonic noise
        if (box?.exists) {
            const bx = Math.sin(t * 1.9) * 10.0;
            const by = Math.sin(t * 3.2) * 5.0;
            const bz = Math.cos(t * 1.4) * 8.0;
            box.transform.setPosition(bx, by, bz, { mode: 'additive' });
        }

        // Animate light with different frequencies
        if (light?.exists) {
            const lx = Math.sin(t * 0.8) * 30.0;
            const ly = Math.cos(t * 1.1) * 20.0;
            const lz = Math.sin(t * 0.5) * 15.0;
            light.transform.setPosition(lx, ly, lz, { mode: 'additive' });
        }

        // Log once per second
        if (frameCount % 60 === 1) {
            console.log('[transform_test] frame', frameCount,
                'box:', box?.transform.hasOverride,
                'light:', light?.transform.hasOverride);
        }
    },

    dispose(ctx) {
        if (box?.transform) box.transform.clear();
        if (light?.transform) light.transform.clear();
        box = null;
        light = null;
        frameCount = 0;
    },
};
