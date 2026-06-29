// Screen-space reflections. Verbatim move of the SSR block from
// maxjs_fx.js rebuildPipeline().
import { vec4 } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { recurrentDenoise } from 'three/addons/tsl/display/RecurrentDenoiseNode.js';

let _fallbackEnvironment = null;

function clampFinite(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
}

function getFallbackEnvironment(THREE) {
    if (!_fallbackEnvironment) {
        const data = new Uint8Array([0, 0, 0, 255]);
        _fallbackEnvironment = new THREE.DataTexture(
            data,
            1,
            1,
            THREE.RGBAFormat,
            THREE.UnsignedByteType
        );
        _fallbackEnvironment.name = 'maxjs.SSRBlackEnvironment';
        _fallbackEnvironment.mapping = THREE.EquirectangularReflectionMapping;
        _fallbackEnvironment.colorSpace = THREE.NoColorSpace;
        _fallbackEnvironment.needsUpdate = true;
    }
    return _fallbackEnvironment;
}

function getSSREnvironmentTexture(ctx) {
    // max.js already applies authored HDRI/IBL in the beauty pass. SSR misses
    // must not inject that HDRI a second time or the result becomes tinted and
    // over-bright; a black equirect keeps r185 stochastic SSR's env sampler valid.
    return getFallbackEnvironment(ctx.THREE);
}

export default {
    id: 'ssr',
    stage: 'beauty',
    slot: 50,
    needs: (ctx) => ctx.state.ssr.denoise ? ['depth', 'normal', 'velocity'] : [],
    forcePrePassSamplesOne: (ctx) => !!ctx.state.ssr.denoise,
    needsCopyCompatiblePrePassNormal: (ctx) => !!ctx.state.ssr.denoise,
    defaults: {
        enabled: false,
        quality: 0.45,
        blurQuality: 2,
        maxDistance: 0.5,
        opacity: 0.9,
        thickness: 0.015,
        denoise: false,
        stochastic: false,
        denoiseRadius: 5,
        denoiseStrength: 0.25,
        denoiseFrames: 32,
        denoiseAdaptiveTrust: 0.15,
    },
    build(ctx) {
        const { state, derived, sceneTex } = ctx;
        const useDenoiser = !!state.ssr.denoise
            && !!ctx.prePass?.depth
            && !!ctx.prePass?.normalColor
            && !!ctx.prePass?.velocity;
        const useStochastic = useDenoiser || !!state.ssr.stochastic;
        const metalnessNode = useStochastic
            ? sceneTex.metalrough.r
            : sceneTex.reflectivity;
        const ssrPass = ssr(
            sceneTex.color,
            sceneTex.depth,
            sceneTex.normal,
            {
                stochastic: useStochastic,
                metalnessNode,
                roughnessNode: sceneTex.metalrough.g,
                diffuseNode: sceneTex.diffuse,
                environmentNode: useStochastic
                    ? getSSREnvironmentTexture(ctx)
                    : null,
                camera: ctx.camera,
            }
        );
        ssrPass.quality.value = state.ssr.quality;
        ssrPass.blurQuality = Math.max(1, Math.min(3, Math.round(state.ssr.blurQuality)));
        ssrPass.maxDistance.value = derived.effectiveSSRMaxDistance;
        ssrPass.intensity.value = state.ssr.opacity;
        ssrPass.thickness.value = derived.effectiveSSRThickness;
        ssrPass.screenEdgeFadeBlack = true;
        ssrPass.environmentIntensity.value = 0;
        ctx.applyNodeResolutionScale(ssrPass);
        ctx.pushNode(ssrPass);
        ctx.setActivePass('ssr', ssrPass);

        const reflectionNode = useDenoiser
            ? buildDenoisedSSR(ctx, ssrPass)
            : ssrPass;

        // SSRNode.a is ray length / temporal history, not opacity. Alpha-over
        // compositing treats long hits as full replacement and shifts color.
        return vec4(ctx.beauty.rgb.add(reflectionNode.rgb), ctx.beautyAlpha);
    },
    update(ctx) {
        const ssrPass = ctx.getActivePass('ssr');
        if (!ssrPass) return;
        ssrPass.maxDistance.value = ctx.derived.effectiveSSRMaxDistance;
        ssrPass.thickness.value = ctx.derived.effectiveSSRThickness;
    },
};

function buildDenoisedSSR(ctx, ssrPass) {
    const { state, sceneTex } = ctx;
    const maxFrames = Math.round(clampFinite(state.ssr.denoiseFrames, 1, 64, 32));

    const temporalPass = temporalReproject(
        ssrPass,
        ctx.prePass.depth,
        ctx.prePass.normalColor,
        ctx.prePass.velocity,
        ctx.camera,
        {
            mode: 'specular',
            hitPointReprojection: true,
            accumulate: false,
        }
    );
    temporalPass.maxFrames.value = maxFrames;
    temporalPass.clampIntensity.value = 1;
    temporalPass.flickerSuppression.value = 1;
    ctx.pushNode(temporalPass);

    const denoisePass = recurrentDenoise(
        temporalPass,
        ctx.camera,
        {
            depth: ctx.prePass.depth,
            normal: ctx.prePass.normalColor,
            metalRoughness: sceneTex.metalrough,
            diffuse: sceneTex.diffuse,
            raw: ssrPass,
            mode: 'specular',
            accumulate: true,
        }
    );
    denoisePass.radius.value = clampFinite(state.ssr.denoiseRadius, 0.25, 24, 5);
    denoisePass.strength.value = clampFinite(state.ssr.denoiseStrength, 0.01, 1, 0.25);
    denoisePass.maxFrames.value = maxFrames;
    denoisePass.adaptiveTrust.value = clampFinite(state.ssr.denoiseAdaptiveTrust, 0, 1, 0.15);
    denoisePass.alphaSource = 'raylength';
    ctx.pushNode(denoisePass);

    temporalPass.setHistoryTexture(denoisePass);
    ssrPass.setHistory(denoisePass, ctx.prePass.velocity);
    ctx.setActivePass('ssrTemporal', temporalPass);
    ctx.setActivePass('ssrDenoise', denoisePass);

    return denoisePass;
}
