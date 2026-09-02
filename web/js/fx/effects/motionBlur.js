// Motion blur. Verbatim move of the motionBlur block from maxjs_fx.js
// rebuildPipeline().
import { convertToTexture, int, uniform, vec4 } from 'three/tsl';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';

export default {
    id: 'motionBlur',
    stage: 'beauty',
    slot: 100,
    needs: ['velocity'],
    defaults: {
        enabled: false,
        amount: 1.0,
        samples: 16,
    },
    build(ctx) {
        if (!ctx.prePass?.velocity) return;
        const { state } = ctx;
        const motionBlurInput = convertToTexture(ctx.beauty);
        ctx.pushNode(motionBlurInput);
        const amount = uniform(state.motionBlur.amount);
        const motionBlurPass = motionBlur(
            motionBlurInput,
            ctx.prePass.velocity.mul(amount),
            int(Math.max(2, Math.round(state.motionBlur.samples)))
        );
        ctx.applyNodeResolutionScale(motionBlurPass);
        ctx.pushNode(motionBlurPass);
        ctx.setActivePass('motionBlurAmount', amount);
        return vec4(motionBlurPass.rgb, ctx.beautyAlpha);
    },
    topologyKeys: ['samples'],
    update(ctx) {
        const amount = ctx.getActivePass('motionBlurAmount');
        if (amount) amount.value = ctx.state.motionBlur.amount;
    },
};
