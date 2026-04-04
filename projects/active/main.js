export default function activeProject(ctx, THREE) {
    const host = ctx.js.createGroup('active_project');
    const pivot = ctx.js.createGroup('active_project_pivot');
    host.add(pivot);

    const core = ctx.js.own(new THREE.Mesh(
        new THREE.IcosahedronGeometry(18, 1),
        new THREE.MeshStandardMaterial({
            color: 0xff7a1a,
            emissive: 0x331100,
            roughness: 0.28,
            metalness: 0.12,
        }),
    ));
    core.castShadow = true;
    core.receiveShadow = true;
    pivot.add(core);

    const orbit = ctx.js.own(new THREE.Mesh(
        new THREE.TorusGeometry(34, 1.2, 20, 120),
        new THREE.MeshStandardMaterial({
            color: 0x00d9ff,
            emissive: 0x00333d,
            roughness: 0.18,
            metalness: 0.65,
        }),
    ));
    orbit.rotation.x = Math.PI * 0.5;
    pivot.add(orbit);

    const nodes = ctx.maxScene.listNodes();
    if (nodes.length > 0) {
        const anchor = ctx.js.createAnchor(nodes[0].handle);
        anchor.add(host);
        host.position.set(0, 0, 65);
    } else {
        ctx.js.add(host);
        host.position.set(0, 0, 65);
    }

    return {
        update(_ctx, dt, elapsed) {
            pivot.rotation.z += dt * 0.9;
            core.rotation.x += dt * 0.8;
            core.rotation.y += dt * 1.15;
            host.position.z = 65 + Math.sin(elapsed * 1.25) * 8;
        },
    };
}
