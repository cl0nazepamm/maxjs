// Screen-space global illumination. Verbatim move of the SSGI block from
// maxjs_fx.js rebuildPipeline().
import { add, vec4 } from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';

let warnedUnsupported = false;

function supportsSsgi(ctx) {
    const renderer = ctx?.renderer;
    if (renderer?.backend?.isWebGPUBackend !== true || typeof renderer.hasFeature !== 'function') return true;
    return renderer.hasFeature('rg11b10ufloat-renderable') !== false;
}

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
        if (!supportsSsgi(ctx)) {
            if (!warnedUnsupported) {
                warnedUnsupported = true;
                console.warn('[max.js] SSGI disabled: WebGPU device lacks rg11b10ufloat-renderable support required by three r185 SSGINode.');
            }
            return ctx.beauty;
        }

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
        ctx.setActivePass('ssgi', ssgiPass);

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
    update(ctx) {
        const pass = ctx.getActivePass('ssgi');
        if (!pass) return;
        const s = ctx.state.ssgi;
        pass.sliceCount.value = s.sliceCount;
        pass.stepCount.value = s.stepCount;
        pass.radius.value = s.radius;
        pass.thickness.value = s.thickness;
        pass.aoIntensity.value = s.aoIntensity;
        pass.giIntensity.value = s.giIntensity;
        pass.expFactor.value = s.expFactor;
        pass.useTemporalFiltering = s.temporal;
        ctx.applyNodeResolutionScale(pass);
    },
};
