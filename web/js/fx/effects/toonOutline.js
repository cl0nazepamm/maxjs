// Toon outlines. Replaces the default scene pass with toonOutlinePass when
// toon materials exist — outlines + MRT so SSGI/SSR/Bloom all stack on top.
// Verbatim move from maxjs_fx.js rebuildPipeline().
import * as THREE from 'three';
import { toonOutlinePass } from 'three/tsl';

export default {
    id: 'toonOutline',
    stage: 'scenePass',
    slot: 30,
    needs: [],
    defaults: {
        enabled: false,
        color: [0, 0, 0],
        thickness: 0.003,
        alpha: 1.0,
    },
    build(ctx) {
        // Only takes over the scene pass when toon materials exist; the core
        // falls back to a plain pass(scene, camera) otherwise.
        if (ctx.getToonMeshes().length === 0) return null;
        const toc = ctx.state.toonOutline;
        return toonOutlinePass(ctx.scene, ctx.camera,
            new THREE.Color(toc.color[0], toc.color[1], toc.color[2]),
            toc.thickness,
            toc.alpha);
    },
};
