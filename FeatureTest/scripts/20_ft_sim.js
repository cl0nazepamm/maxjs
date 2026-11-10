// max.js FeatureTest - stateful GPU compute deform (ctx.deform.simulate, WebGPU only).
// FT_Jsmod_Sim carries the three.js Deform modifier, which simulate() requires. Each vertex is a damped
// spring pulled toward a breathing target along its rest normal; normals are recomputed every frame.
// On the WebGL backends simulate() fails gracefully and the sphere stays at rest.
export default function featureTestSim(ctx) {
    const sim = ctx.deform.simulate('FT_Jsmod_Sim', {
        params: { stiffness: 40, damping: 3.5, push: 9 },
        state: { velocity: 3 },
        normals: 'recompute',
        timeMode: 'timeline',
        compute: ({ position, rest, normal, state, dt, time, params, TSL }) => {
            const p = position.read().toVar();
            const r = rest.read();
            const v = state.velocity.read().toVar();
            const n = normal.read();
            const pulse = TSL.sin(time.mul(2.0).add(r.x.mul(0.15)).add(r.y.mul(0.11))).mul(params.push);
            const accel = r.add(n.mul(pulse)).sub(p).mul(params.stiffness).sub(v.mul(params.damping));
            v.addAssign(accel.mul(dt));
            state.velocity.assign(v);
            position.assign(p.add(v.mul(dt)));
        },
    });
    return {
        dispose() { sim?.dispose?.(); },
    };
}
