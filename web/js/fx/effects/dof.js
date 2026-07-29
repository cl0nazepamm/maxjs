// Depth of field. Verbatim move of the DOF block from maxjs_fx.js
// rebuildPipeline(). Focus-from-camera updates stay a facade method that
// writes the shared dof* uniforms.
import { vec4 } from 'three/tsl';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';

// max.js compatibility patch for three r185.
//
// Upstream DepthOfFieldNode.setup() creates a new GaussianBlurNode every time
// setup is revisited, replacing the material reference without disposing the
// old blur's two full-resolution render targets. Keep setup idempotent for one
// DOF instance. A normal max.js pipeline rebuild creates a new DOF instance,
// so builder context changes still receive a fresh upstream setup.
//
// Remove this wrapper once upstream setup() reuses its internal blur graph.
function stabilizeDofSetup(dofPass) {
    const upstreamSetup = dofPass.setup;
    let setupComplete = false;
    let setupResult = null;

    dofPass.setup = function stableSetup(builder) {
        if (setupComplete) return setupResult;
        setupResult = upstreamSetup.call(this, builder);
        setupComplete = true;
        return setupResult;
    };

    return dofPass;
}

export default {
    id: 'dof',
    stage: 'beauty',
    slot: 70,
    needs: [],
    defaults: {
        enabled: false,
        autoFromCamera: true,
        focusDistance: 100,
        focalLength: 50,
        bokehScale: 5,
    },
    build(ctx) {
        if (!ctx.scenePass) return;
        const { state, uniforms } = ctx;
        uniforms.dofFocusDistanceU.value = state.dof.focusDistance;
        uniforms.dofFocalLengthU.value = state.dof.focalLength;
        uniforms.dofBokehScaleU.value = state.dof.bokehScale;
        // ownedTexture: dof() convertToTexture's its input; an RTT minted
        // inside the factory leaks its render target on every rebuild.
        const dofPass = dof(
            ctx.ownedTexture(ctx.beauty),
            ctx.scenePass.getViewZNode(),
            uniforms.dofFocusDistanceU,
            uniforms.dofFocalLengthU,
            uniforms.dofBokehScaleU
        );
        stabilizeDofSetup(dofPass);
        ctx.applyNodeResolutionScale(dofPass);
        ctx.pushNode(dofPass);
        // Upstream r185 dispose() gap: DepthOfFieldNode wires a gaussianBlur()
        // into its CoC-blur quad material but never disposes that node, so its
        // two full-res internal render targets outlive every rebuild. The
        // assignment happens lazily in setup(), so resolve it at DISPOSAL
        // time, not here (colorNode is still null during build).
        ctx.pushNode({
            dispose() {
                const cocBlur = dofPass._CoCBlurredMaterial?.colorNode;
                if (cocBlur && typeof cocBlur.dispose === 'function') cocBlur.dispose();
            },
        });
        // DepthOfFieldNode composite forces a=1; keep scene alpha for transparent backdrop + fog
        return vec4(dofPass.rgb, ctx.beautyAlpha);
    },
};
