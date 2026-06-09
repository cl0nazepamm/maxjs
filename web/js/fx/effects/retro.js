// Retro CRT / dither / scanline stack. Verbatim move of the retro block from
// maxjs_fx.js rebuildPipeline(). The PS1 vertex snap (retro.wiggle) is
// material-level and stays in fx/core.js. Retro yields to Shader Lab.
import { posterize, replaceDefaultUV, screenSize } from 'three/tsl';
import { scanlines, vignette, colorBleeding, barrelUV } from 'three/addons/tsl/display/CRT.js';
import { bayerDither } from 'three/addons/tsl/math/Bayer.js';

export function syncRetroUniforms(ctx) {
    const r = ctx.state.retro;
    const u = ctx.uniforms;
    u.retroCurvatureU.value = r.curvature;
    u.retroBleedingU.value = r.bleeding;
    u.retroColorDepthU.value = r.colorDepth;
    u.retroScanlineIntensityU.value = r.scanlineIntensity;
    u.retroScanlineDensityU.value = r.scanlineDensity;
    u.retroVignetteIntensityU.value = r.vignetteIntensity;
}

export default {
    id: 'retro',
    stage: 'beauty',
    slot: 110,
    needs: [],
    defaults: {
        enabled: false,
        wiggle: false,
        affineDistortion: 5.0,
        resolutionScale: 0.25,
        filterTextures: false,
        dither: false,
        colorDepth: 32,
        scanlines: false,
        scanlineIntensity: 0.3,
        scanlineDensity: 1.0,
        crt: false,
        vignetteIntensity: 0.3,
        bleeding: 0.001,
        curvature: 0.02,
    },
    activeWhen(ctx) {
        return !ctx.isShaderLabEnabled();
    },
    build(ctx) {
        const r = ctx.state.retro;
        const u = ctx.uniforms;
        syncRetroUniforms(ctx);
        let beauty = ctx.beauty;

        // CRT barrel distortion + color bleeding
        if (r.crt) {
            const distortedUV = barrelUV(u.retroCurvatureU);
            beauty = replaceDefaultUV(distortedUV, beauty);
            beauty = colorBleeding(beauty, u.retroBleedingU);
        }

        // Dither + posterize
        if (r.dither) {
            beauty = bayerDither(beauty, u.retroColorDepthU);
            beauty = posterize(beauty, u.retroColorDepthU);
        }

        // Vignette
        if (r.vignetteIntensity > 0) {
            beauty = vignette(beauty, u.retroVignetteIntensityU, 0.6);
        }

        // Scanlines
        if (r.scanlines) {
            beauty = scanlines(beauty, u.retroScanlineIntensityU, screenSize.y.mul(u.retroScanlineDensityU), 0.0);
        }
        return ctx.withBeautyAlpha(beauty);
    },
};
