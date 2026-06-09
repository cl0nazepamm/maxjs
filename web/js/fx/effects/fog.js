// Post-pass depth fog overlay. Verbatim move of the fog block from
// maxjs_fx.js rebuildPipeline(). The material-level scene.fogNode variant
// (applyFog) is core-resident — see fx/core.js applySceneFog().
import { float, vec3, vec4 } from 'three/tsl';

export default {
    id: 'fog',
    stage: 'beauty',
    slot: 130,
    needs: [],
    defaults: {
        enabled: false,
        type: 0,          // 0=Range, 1=Density, 2=Custom (procedural)
        color: [0.85, 0.85, 0.9],
        opacity: 1.0,
        near: 10.0,
        far: 500.0,
        density: 0.01,
        noiseScale: 0.005,
        noiseSpeed: 0.2,
        height: 20.0,
    },
    build(ctx) {
        // Fog: blend fog color based on depth, works over geometry AND background
        if (!ctx.sceneTex?.depth) return;
        const f = ctx.state.fog;
        const d = ctx.sceneTex.depth.r;
        const cn = float(ctx.camera.near);
        const cf = float(ctx.camera.far);
        const z = cn.mul(cf).div(cf.sub(d.mul(cf.sub(cn))));

        let fogAlpha;
        if (f.type === 0) {
            fogAlpha = z.sub(float(f.near)).div(float(Math.max(f.far - f.near, 0.001)))
                .saturate().mul(float(f.opacity));
        } else {
            const dens = float(f.type === 1 ? f.density : (f.density || 0.01));
            fogAlpha = z.mul(dens).negate().exp().oneMinus().mul(float(f.opacity));
        }

        const fogCol = vec3(f.color[0], f.color[1], f.color[2]);
        // Blend fog color over scene based on depth-computed alpha
        const blended = ctx.beauty.rgb.mul(fogAlpha.oneMinus()).add(fogCol.mul(fogAlpha));
        return vec4(blended, ctx.raiseBeautyAlpha(fogAlpha));
    },
};
