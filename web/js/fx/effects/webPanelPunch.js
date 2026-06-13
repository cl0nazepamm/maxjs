// Depth-occluded web panel punch-through. CSS3D panels behind the alpha:true
// canvas need their pixels transparent wherever the panel is the nearest
// surface — but geometryCoverageAlpha (core.js) seals any depth-writing
// occluder mesh back to alpha 1 inside the FX pipeline. This descriptor
// re-punches analytically: for each panel rect, compare the scene depth
// against the ray/rect intersection in panel-local space and multiply the
// final beauty alpha down where the panel wins. No extra render pass; ≤8
// rects unrolled with mat4 uniforms.
//
// Enabled state is derived by maxjs_fx (rects present AND some other effect
// already forces the pipeline path) — the punch alone never drags rendering
// off the cheap direct path, where the occluder meshes handle punching
// natively. Rects are supplied via ctx.shared.webPanelPunch = { rects } from
// maxjs_webapp.js: [{ object: THREE.Object3D (unit-rect plane), getOpacity }].
import {
    cameraProjectionMatrixInverse,
    cameraWorldMatrix,
    float,
    getViewPosition,
    screenUV,
    texture,
    uniform,
    vec2,
    vec4,
} from 'three/tsl';

export const MAX_PUNCH_RECTS = 8;

// texture(null) is illegal in TSL — TextureNode.getUniformHash() reads
// value.uuid during build, so a null mask crashes the whole pipeline build.
// 1×1 white (alpha 1) = "punch the full rect by opacity", the pre-mask
// behavior, used until a panel's DOM mask texture exists.
let _fallbackMask = null;
function fallbackMask(THREE) {
    if (!_fallbackMask) {
        _fallbackMask = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        _fallbackMask.needsUpdate = true;
    }
    return _fallbackMask;
}

export default {
    id: 'webPanelPunch',
    stage: 'beauty',
    slot: 200,  // after fog (130) — nothing raises beauty alpha later
    needs: [],
    defaults: {
        enabled: false,
    },
    activeWhen(ctx) {
        return (ctx.shared.webPanelPunch?.rects?.length ?? 0) > 0;
    },
    build(ctx) {
        const reg = ctx.shared.webPanelPunch;
        const rects = reg?.rects?.slice(0, MAX_PUNCH_RECTS) ?? [];
        if (rects.length === 0 || !ctx.sceneTex?.depth) return null;

        reg.uniforms = rects.map(() => ({
            invWorld: uniform(new ctx.THREE.Matrix4()),
            opacity: uniform(1),
            mask: texture(fallbackMask(ctx.THREE)),
        }));

        const d = ctx.sceneTex.depth.r;
        // Anchor the ray segment at the near plane (not cameraPosition) so the
        // same parametric compare is correct for perspective AND orthographic.
        const nearWorld = cameraWorldMatrix
            .mul(vec4(getViewPosition(screenUV, float(0), cameraProjectionMatrixInverse), 1)).xyz;
        const sceneWorld = cameraWorldMatrix
            .mul(vec4(getViewPosition(screenUV, d, cameraProjectionMatrixInverse), 1)).xyz;

        let punch = float(0);
        for (const u of reg.uniforms) {
            // Panel-local frame: the occluder is a unit PlaneGeometry(1,1), so
            // the rect spans [-0.5, 0.5]^2 at z = 0.
            const lo = u.invWorld.mul(vec4(nearWorld, 1)).xyz;
            const le = u.invWorld.mul(vec4(sceneWorld, 1)).xyz;
            const ld = le.sub(lo);
            // ld.z == 0 → t = ±inf/NaN → every comparison below fails → no punch.
            const t = lo.z.negate().div(ld.z);
            const hit = lo.add(ld.mul(t)).xy;
            const valid = t.greaterThan(float(0))
                .and(t.lessThan(float(0.9999)))  // panel strictly nearer than the scene sample
                .and(hit.x.abs().lessThanEqual(float(0.5)))
                .and(hit.y.abs().lessThanEqual(float(0.5)));
            const maskUv = hit.add(vec2(0.5, 0.5));
            const maskAlpha = u.mask.sample(maskUv).a.mul(u.opacity);
            punch = punch.max(valid.select(maskAlpha, float(0)));
        }

        ctx.beautyAlpha = ctx.beautyAlpha.mul(punch.oneMinus());
        return null;  // beauty rgb untouched — alpha-only effect
    },
    update(ctx) {
        const reg = ctx.shared.webPanelPunch;
        if (!reg?.rects || !reg.uniforms) return;
        const count = Math.min(reg.rects.length, reg.uniforms.length);
        for (let i = 0; i < count; i++) {
            const rect = reg.rects[i];
            const u = reg.uniforms[i];
            if (!rect?.object || !u) continue;
            u.invWorld.value.copy(rect.object.matrixWorld).invert();
            u.opacity.value = rect.getOpacity ? rect.getOpacity() : 1;
            u.mask.value = (rect.getMaskTexture && rect.getMaskTexture()) || fallbackMask(ctx.THREE);
        }
    },
};
