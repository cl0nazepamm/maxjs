// Ground-truth ambient occlusion. Verbatim move of the GTAO block from
// maxjs_fx.js rebuildPipeline().
import { screenUV, builtinAOContext } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';

export default {
    id: 'gtao',
    stage: 'context',
    slot: 20,
    needs: ['depth', 'normal'],
    defaults: {
        enabled: false,
        samples: 16,
        distanceExponent: 1.0,
        distanceFallOff: 1.0,
        radius: 0.5,
        scale: 2.0,
        thickness: 1.0,
        resolutionScale: 1.0,
    },
    build(ctx) {
        if (!ctx.prePass?.depth || !ctx.prePass?.normal) return;
        const { state, derived } = ctx;
        const aoPass = ao(ctx.prePass.depth, ctx.prePass.normal, ctx.camera);
        aoPass.samples.value = state.gtao.samples;
        aoPass.distanceExponent.value = state.gtao.distanceExponent;
        aoPass.distanceFallOff.value = state.gtao.distanceFallOff;
        aoPass.radius.value = derived.effectiveGTAORadius;
        aoPass.scale.value = state.gtao.scale;
        aoPass.thickness.value = derived.effectiveGTAOThickness;
        ctx.applyNodeResolutionScale(aoPass, state.gtao.resolutionScale);
        aoPass.useTemporalFiltering = ctx.has('traa');
        ctx.pushNode(aoPass);
        ctx.setActivePass('ao', aoPass);

        const aoSample = aoPass.getTextureNode().sample(screenUV).r;
        ctx.sceneContext = builtinAOContext(aoSample, ctx.sceneContext);
    },
    update(ctx) {
        const aoPass = ctx.getActivePass('ao');
        if (!aoPass) return;
        aoPass.radius.value = ctx.derived.effectiveGTAORadius;
        aoPass.thickness.value = ctx.derived.effectiveGTAOThickness;
    },
};
