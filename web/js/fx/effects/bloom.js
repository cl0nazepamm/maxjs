// Bloom. Verbatim move of the bloom block from maxjs_fx.js rebuildPipeline().
import { vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

export default {
    id: 'bloom',
    stage: 'beauty',
    slot: 95, // lens: bloom light that already traversed fog (65) / volumetrics (80)
    needs: [],
    defaults: {
        enabled: false,
        strength: 0.4,
        radius: 0.2,
        threshold: 0.75,
        resolutionScale: 0.5, // three's own BloomNode default. 1.0 quadruples the
                              // pixels through the ENTIRE mip chain (bright pass +
                              // 10 gaussian passes, 6-22 taps) at DPR-scaled canvas
                              // res — a multi-ms, framerate-class cost for a soft
                              // low-frequency effect. 0.5 IS the stock three look.
    },
    build(ctx) {
        const { state } = ctx;
        const bloomPass = bloom(
            ctx.beauty,
            state.bloom.strength,
            state.bloom.radius,
            state.bloom.threshold
        );
        // extraScale multiplies the global postFX scale; without it this call
        // was OVERRIDING BloomNode's half-res default up to full resolution.
        ctx.applyNodeResolutionScale(bloomPass, state.bloom.resolutionScale ?? 0.5);
        ctx.pushNode(bloomPass);
        ctx.setActivePass('bloom', bloomPass);
        const bloomLuma = bloomPass.r.mul(0.2126).add(bloomPass.g.mul(0.7152)).add(bloomPass.b.mul(0.0722));
        return vec4(ctx.beauty.rgb.add(bloomPass.rgb), ctx.raiseBeautyAlpha(bloomLuma));
    },
    update(ctx) {
        const bloomPass = ctx.getActivePass('bloom');
        if (!bloomPass) return;
        bloomPass.strength.value = ctx.state.bloom.strength;
        bloomPass.radius.value = ctx.state.bloom.radius;
        bloomPass.threshold.value = ctx.state.bloom.threshold;
        ctx.applyNodeResolutionScale(bloomPass, ctx.state.bloom.resolutionScale ?? 0.5);
    },
};
