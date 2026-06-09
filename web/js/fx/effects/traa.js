// Temporal reprojection anti-aliasing. Verbatim move of the TRAA block from
// maxjs_fx.js rebuildPipeline(). forcePrePassSamplesOne: TRAA copies depth —
// the shared pre-pass MSAA sample count must be 1 to avoid mismatch.
import { convertToTexture, vec4 } from 'three/tsl';
import { traa } from 'three/addons/tsl/display/TRAANode.js';

export default {
    id: 'traa',
    stage: 'beauty',
    slot: 90,
    needs: ['depth', 'velocity'],
    forcePrePassSamplesOne: true,
    defaults: {
        enabled: false,
        useSubpixelCorrection: true,
        depthThreshold: 0.0005,
        edgeDepthDiff: 0.001,
        maxVelocityLength: 128,
    },
    build(ctx) {
        if (!ctx.prePass?.depth || !ctx.prePass?.velocity) return;
        const { state } = ctx;
        const traaInput = convertToTexture(ctx.beauty);
        ctx.pushNode(traaInput);

        const traaPass = traa(traaInput, ctx.prePass.depth, ctx.prePass.velocity, ctx.camera);
        traaPass.useSubpixelCorrection = state.traa.useSubpixelCorrection;
        traaPass.depthThreshold = state.traa.depthThreshold;
        traaPass.edgeDepthDiff = state.traa.edgeDepthDiff;
        traaPass.maxVelocityLength = state.traa.maxVelocityLength;
        ctx.applyNodeResolutionScale(traaPass);
        ctx.pushNode(traaPass);
        return vec4(traaPass.rgb, ctx.beautyAlpha);
    },
};
