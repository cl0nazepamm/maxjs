// Pixel FX (pixelate / chromatic aberration / sharpen / grade / grain).
// Verbatim move of the pixel block from maxjs_fx.js rebuildPipeline().
// The grain timer (uniforms.pixelTimer) advances in core.updateFrameTimers().
import {
    convertToTexture, dot, float, fract, max, mix, replaceDefaultUV,
    screenSize, screenUV, sin, vec2, vec3, vec4,
} from 'three/tsl';

export function syncPixelUniforms(ctx) {
    const p = ctx.state.pixel;
    const u = ctx.uniforms;
    u.pixelSizeU.value = p.pixelSize;
    u.pixelChromaticIntensityU.value = p.chromaticIntensity;
    u.pixelSharpenStrengthU.value = p.sharpenStrength;
    u.pixelGrainIntensityU.value = p.grainIntensity;
    u.pixelBrightnessU.value = p.brightness;
    u.pixelContrastU.value = p.contrast;
    u.pixelSaturationU.value = p.saturation;
}

export default {
    id: 'pixel',
    stage: 'beauty',
    slot: 120,
    needs: [],
    defaults: {
        enabled: false,
        pixelate: false,
        pixelSize: 4,
        chromatic: false,
        chromaticIntensity: 0.005,
        sharpen: false,
        sharpenStrength: 0.5,
        grain: false,
        grainIntensity: 0.08,
        brightness: 0,
        contrast: 0,
        saturation: 0,
    },
    build(ctx) {
        const p = ctx.state.pixel;
        const u = ctx.uniforms;
        syncPixelUniforms(ctx);
        let beauty = ctx.beauty;

        // Pixelate — snap UVs to a coarse grid
        if (p.pixelate && p.pixelSize > 1) {
            const px = vec2(
                max(screenSize.x.div(u.pixelSizeU), float(1.0)),
                max(screenSize.y.div(u.pixelSizeU), float(1.0))
            );
            beauty = replaceDefaultUV(() => screenUV.mul(px).floor().div(px), beauty);
        }

        // Effects requiring random-access texture sampling
        const needsTex = (p.chromatic && p.chromaticIntensity > 0) ||
                          (p.sharpen && p.sharpenStrength > 0);

        if (needsTex) {
            let bTex = convertToTexture(beauty);
            ctx.pushNode(bTex);

            // Chromatic Aberration — radial RGB split
            if (p.chromatic && p.chromaticIntensity > 0) {
                const dir = screenUV.sub(vec2(0.5, 0.5));
                const uvR = screenUV.add(dir.mul(u.pixelChromaticIntensityU));
                const uvB = screenUV.sub(dir.mul(u.pixelChromaticIntensityU));
                beauty = vec4(
                    bTex.sample(uvR).r,
                    bTex.sample(screenUV).g,
                    bTex.sample(uvB).b,
                    bTex.sample(screenUV).a
                );

                if (p.sharpen && p.sharpenStrength > 0) {
                    bTex = convertToTexture(beauty);
                    ctx.pushNode(bTex);
                }
            }

            // Sharpen — unsharp mask kernel
            if (p.sharpen && p.sharpenStrength > 0) {
                const txX = float(1).div(screenSize.x);
                const txY = float(1).div(screenSize.y);
                const ctr = bTex.sample(screenUV);
                const sl  = bTex.sample(screenUV.sub(vec2(txX, 0)));
                const sr  = bTex.sample(screenUV.add(vec2(txX, 0)));
                const st  = bTex.sample(screenUV.sub(vec2(0, txY)));
                const sb  = bTex.sample(screenUV.add(vec2(0, txY)));
                const avg = sl.add(sr).add(st).add(sb).mul(0.25);
                beauty = vec4(ctr.rgb.add(ctr.rgb.sub(avg.rgb).mul(u.pixelSharpenStrengthU)), ctr.a);
            }
        }

        // Color Grading — brightness / contrast / saturation
        if (p.brightness !== 0 || p.contrast !== 0 || p.saturation !== 0) {
            let col = beauty.rgb;
            if (p.brightness !== 0) {
                col = col.add(u.pixelBrightnessU);
            }
            if (p.contrast !== 0) {
                col = col.sub(0.5).mul(u.pixelContrastU.add(1.0)).add(0.5);
            }
            if (p.saturation !== 0) {
                const luma = col.r.mul(0.2126).add(col.g.mul(0.7152)).add(col.b.mul(0.0722));
                col = mix(vec3(luma, luma, luma), col, u.pixelSaturationU.add(1.0));
            }
            beauty = vec4(col, beauty.a);
        }

        // Film Grain — animated hash noise
        if (p.grain && p.grainIntensity > 0) {
            const seed = screenUV.add(vec2(u.pixelTimer.mul(0.17), u.pixelTimer.mul(0.31)));
            const noise = fract(sin(dot(seed, vec2(12.9898, 78.233))).mul(43758.5453));
            beauty = vec4(beauty.rgb.add(noise.sub(0.5).mul(u.pixelGrainIntensityU)), beauty.a);
        }
        return ctx.withBeautyAlpha(beauty);
    },
};
