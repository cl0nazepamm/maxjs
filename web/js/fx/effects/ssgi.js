// Screen-space global illumination. Verbatim move of the SSGI block from
// maxjs_fx.js rebuildPipeline().
import { add, vec4 } from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';

export default {
    id: 'ssgi',
    stage: 'beauty',
    slot: 40,
    needs: [],
    defaults: {
        enabled: false,
        radius: 8,
        thickness: 1.5,
        aoIntensity: 1.0,
        giIntensity: 1.5,
        expFactor: 1.5,
        sliceCount: 2,
        stepCount: 8,
        temporal: false,
    },
    build(ctx) {
        const { state, sceneTex } = ctx;
        const ssgiPass = ssgi(sceneTex.color, sceneTex.depth, sceneTex.normal, ctx.camera);
        ssgiPass.sliceCount.value = state.ssgi.sliceCount;
        ssgiPass.stepCount.value = state.ssgi.stepCount;
        ssgiPass.radius.value = state.ssgi.radius;
        ssgiPass.thickness.value = state.ssgi.thickness;
        ssgiPass.aoIntensity.value = state.ssgi.aoIntensity;
        ssgiPass.giIntensity.value = state.ssgi.giIntensity;
        ssgiPass.expFactor.value = state.ssgi.expFactor;
        ssgiPass.useTemporalFiltering = state.ssgi.temporal;
        ctx.applyNodeResolutionScale(ssgiPass);
        ctx.pushNode(ssgiPass);

        const ssgiAO = ssgiPass.getAONode().r;
        const ssgiGI = ssgiPass.getGINode().rgb;

        return vec4(
            add(
                ctx.beauty.rgb.mul(ssgiAO),
                sceneTex.diffuse.rgb.mul(ssgiGI)
            ),
            ctx.beautyAlpha
        );
    },
};
