// Screen-space reflections. Verbatim move of the SSR block from
// maxjs_fx.js rebuildPipeline().
import { blendColor, max, vec4 } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';

export default {
    id: 'ssr',
    stage: 'beauty',
    slot: 50,
    needs: [],
    defaults: {
        enabled: false,
        quality: 0.45,
        blurQuality: 2,
        maxDistance: 0.5,
        opacity: 0.9,
        thickness: 0.015,
    },
    build(ctx) {
        const { state, derived, sceneTex } = ctx;
        const ssrPass = ssr(
            sceneTex.color,
            sceneTex.depth,
            sceneTex.normal,
            sceneTex.reflectivity,
            sceneTex.metalrough.g,
            ctx.camera
        );
        ssrPass.quality.value = state.ssr.quality;
        ssrPass.blurQuality.value = state.ssr.blurQuality;
        ssrPass.maxDistance.value = derived.effectiveSSRMaxDistance;
        ssrPass.opacity.value = state.ssr.opacity;
        ssrPass.thickness.value = derived.effectiveSSRThickness;
        ctx.applyNodeResolutionScale(ssrPass);
        ctx.pushNode(ssrPass);
        ctx.setActivePass('ssr', ssrPass);
        // SSR has no proper environment fallback, so do not let it darken
        // the existing beauty pass. Keep the brighter of the base lighting
        // (including HDRI/IBL) and the SSR-composited result.
        const ssrBlended = blendColor(ctx.beauty, ssrPass);
        return vec4(max(ctx.beauty.rgb, ssrBlended.rgb), ctx.beautyAlpha);
    },
    update(ctx) {
        const ssrPass = ctx.getActivePass('ssr');
        if (!ssrPass) return;
        ssrPass.maxDistance.value = ctx.derived.effectiveSSRMaxDistance;
        ssrPass.thickness.value = ctx.derived.effectiveSSRThickness;
    },
};
