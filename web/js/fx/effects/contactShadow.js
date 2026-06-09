// Contact shadows (screen-space shadow sweep along the main directional light).
// Verbatim move of the contactShadow block from maxjs_fx.js rebuildPipeline().
import { screenUV, builtinShadowContext } from 'three/tsl';
import { sss } from 'three/addons/tsl/display/SSSNode.js';

export default {
    id: 'contactShadow',
    stage: 'context',
    slot: 10,
    needs: ['depth'],
    defaults: {
        enabled: false,
        maxDistance: 0.1,
        thickness: 0.006,
        shadowIntensity: 0.85,
        quality: 0.3,
        temporal: false,
    },
    activeWhen(ctx) {
        return !!ctx.mainLight;
    },
    build(ctx) {
        if (!ctx.prePass?.depth) return;
        const { state, derived } = ctx;
        const contactShadowTemporal = state.contactShadow.temporal && ctx.has('traa');
        const sssPass = sss(ctx.prePass.depth, ctx.camera, ctx.mainLight);
        sssPass.maxDistance.value = derived.effectiveContactShadowMaxDistance;
        sssPass.thickness.value = derived.effectiveContactShadowThickness;
        sssPass.shadowIntensity.value = state.contactShadow.shadowIntensity;
        sssPass.quality.value = state.contactShadow.quality;
        sssPass.useTemporalFiltering = contactShadowTemporal;
        ctx.pushNode(sssPass);
        ctx.setActivePass('contactShadow', sssPass);

        const sssSample = sssPass.getTextureNode().sample(screenUV).r;
        ctx.sceneContext = builtinShadowContext(sssSample, ctx.mainLight, ctx.sceneContext);
    },
    update(ctx) {
        const sssPass = ctx.getActivePass('contactShadow');
        if (!sssPass) return;
        sssPass.maxDistance.value = ctx.derived.effectiveContactShadowMaxDistance;
        sssPass.thickness.value = ctx.derived.effectiveContactShadowThickness;
    },
};
