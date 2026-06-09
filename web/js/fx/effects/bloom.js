// Bloom. Verbatim move of the bloom block from maxjs_fx.js rebuildPipeline().
import { vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

export default {
    id: 'bloom',
    stage: 'beauty',
    slot: 60,
    needs: [],
    defaults: {
        enabled: false,
        strength: 0.4,
        radius: 0.2,
        threshold: 0.75,
    },
    build(ctx) {
        const { state } = ctx;
        const bloomPass = bloom(
            ctx.beauty,
            state.bloom.strength,
            state.bloom.radius,
            state.bloom.threshold
        );
        ctx.applyNodeResolutionScale(bloomPass);
        ctx.pushNode(bloomPass);
        const bloomLuma = bloomPass.r.mul(0.2126).add(bloomPass.g.mul(0.7152)).add(bloomPass.b.mul(0.0722));
        return vec4(ctx.beauty.rgb.add(bloomPass.rgb), ctx.raiseBeautyAlpha(bloomLuma));
    },
};
