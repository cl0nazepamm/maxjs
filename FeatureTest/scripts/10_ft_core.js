// max.js FeatureTest - core runtime layer.
// Exercises: ctx.params (slider/float/color/bool/string), node.userProps, ctx.deform.attach on the
// three.js Deform flag (Vol. Select soft-selection weight, timeline time), ctx.spectral NIR tag,
// spot cookie through node.overrides, a runtime node-material orb with shadows, ctx.js.instanceFromMax
// scattered with a seeded sampleSurface, ctx.maxScene.raycast, camera switching (C), click one-shot audio,
// ctx.anim listing and the max:selection bus event.
// Everything is seeded / time-driven so the live viewer, the snapshot and rendered frames agree.

export const parameters = {
    windStrength: { type: 'slider', value: 14, min: 0, max: 40, step: 0.5 },
    windSpeed: { type: 'slider', value: 1.6, min: 0, max: 6, step: 0.05 },
    scatterCount: { type: 'slider', value: 120, min: 0, max: 400, step: 1 },
    orbTint: { type: 'color', value: '#ff5ad2' },
    showOrb: { type: 'bool', value: true },
    nirPaint: { type: 'float', value: 0.9 },
    note: { type: 'string', value: 'feature test' },
};

// Max world (cm, Z up) -> three world (cm, Y up): x, z, -y.
const fromMax = (x, y, z) => [x, z, -y];

export default function featureTestCore(ctx, THREE) {
    const P = ctx.params.values;
    const TSL = THREE.TSL;
    const nodeRenderer = typeof THREE.WebGPURenderer === 'function' && !!TSL;
    const log = (...args) => console.log('[FT core]', ...args);

    // --- user-defined properties (Object Properties > User Defined) ---
    const tagged = ctx.maxScene.findOne('FT_UserProps');
    const orbitSpeed = Number(tagged?.userProps?.speed) || 1;
    log('userProps', tagged?.userProps ?? '(node not found)');

    // --- GPU vertex deform on the jsmod flag; weight = Vol. Select soft selection ---
    const wind = ctx.deform.attach('FT_Jsmod_Flag', {
        timeMode: 'timeline',
        params: { strength: P.windStrength, speed: P.windSpeed },
        position: ({ position, normal, time, params, weight, TSL }) => {
            const phase = position.x.add(position.y).add(position.z).mul(0.045);
            const wave = TSL.sin(phase.add(time.mul(params.speed)));
            const flutter = TSL.sin(phase.mul(2.7).sub(time.mul(params.speed.mul(2.3)))).mul(0.3);
            return position.add(normal.mul(wave.add(flutter).mul(params.strength).mul(weight)));
        },
    });

    // --- NIR reflectance tag (PowerShot infrared / nightshot) ---
    const nir = ctx.spectral?.setNirAlbedo({ materials: 'FT_NIR_TaggedPaint' }, P.nirPaint, { key: 'ft-paint' }) ?? null;

    // --- spot cookie owned by the layer, the rest of the light keeps syncing from Max ---
    const spot = ctx.maxScene.findOne('FT_Spot_Volumetric_Cookie');
    if (spot) {
        const cookie = ctx.js.own(new THREE.TextureLoader().load(new URL('./ft_cookie.png', import.meta.url).href));
        cookie.colorSpace = THREE.SRGBColorSpace;
        spot.overrides.setProperty('map', cookie, { needsUpdate: true, shadowNeedsUpdate: true, materialsNeedUpdate: true });
    }

    // --- runtime object: animated orb (node material on WebGPU/TSL_GL, classic fallback) ---
    const group = ctx.js.createGroup('ft-runtime', { snapshotId: 'ft-runtime' });
    let tintUniform = null;
    let orbMat;
    if (nodeRenderer) {
        orbMat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.2, metalness: 0.0, clearcoat: 1.0 });
        tintUniform = TSL.uniform(new THREE.Color(P.orbTint));
        orbMat.colorNode = tintUniform;
        orbMat.emissiveNode = tintUniform.mul(TSL.sin(TSL.time.mul(2.0)).mul(0.5).add(0.5)).mul(0.8);
    } else {
        orbMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(P.orbTint), roughness: 0.2 });
    }
    ctx.js.own(orbMat);
    const orb = new THREE.Mesh(ctx.js.own(new THREE.SphereGeometry(18, 48, 24)), orbMat);
    orb.castShadow = true;
    orb.receiveShadow = true;
    ctx.js.setSnapshotId(orb, 'ft-orb');
    group.add(orb);

    // --- instanceFromMax scatter on the ground, seeded, kept to the free front-right strip ---
    const ground = ctx.maxScene.findOne('FT_Ground');
    const kit = ctx.maxScene.findOne('FT_Kit_Block');
    let blocks = null;
    if (ground && kit) {
        blocks = ctx.js.instanceFromMax(kit, { capacity: 400, snapshotId: 'ft-blocks' });
        const samples = ground.sampleSurface({ count: 6000, seed: 1337, areaSpace: 'world' }) ?? [];
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const want = Math.round(P.scatterCount);
        const placed = [];
        let k = 0;
        for (const smp of samples) {
            if (placed.length >= want) break;
            const p = smp.point;
            // Max x in [100, 1250], y in [-880, -660]  ->  three x in [100, 1250], z in [660, 880]
            if (p.x < 100 || p.x > 1250 || p.z < 660 || p.z > 880) continue;
            k += 1;
            q.setFromAxisAngle(yAxis, (k * 2.399963) % (Math.PI * 2));
            s.setScalar(0.6 + ((k * 0.618034) % 1) * 0.9);
            placed.push(new THREE.Matrix4().compose(p, q, s));
        }
        blocks.addMany(placed);
        log('scatter', placed.length, 'of', want);
    }

    // --- raycast straight down onto the synced meshes under the orb's orbit centre ---
    const down = ctx.maxScene.raycast(new THREE.Vector3(...fromMax(0, 100, 600)), new THREE.Vector3(0, -1, 0), { far: 2000 });
    log('raycast hit', down?.object?.name ?? down?.[0]?.object?.name ?? down);

    // --- authored animation clips + selection events ---
    log('anim clips', ctx.anim?.list?.() ?? []);
    ctx.bus?.on?.('max:selection', (e) => log('selection', e?.selected));

    // --- input: C cycles the Max cameras, click plays a positional one-shot ---
    const cams = ['FT_Cam_Main', 'FT_Cam_Detail'];
    let camIndex = 0;
    ctx.input.on(window, 'keydown', (e) => {
        if (e.key !== 'c' && e.key !== 'C') return;
        camIndex = (camIndex + 1) % cams.length;
        ctx.camera.usePhysicalCameraByName(cams[camIndex], { exact: true });
        log('camera', cams[camIndex]);
    });
    ctx.input.on(ctx.input.element, 'pointerdown', () => {
        ctx.audio?.playOneShot(new URL('./ft_click.mp3', import.meta.url).href, { volume: 0.5, position: orb.position.toArray(), refDistance: 300 });
    });

    return {
        update(ctx, dt, elapsed) {
            wind.params.strength = P.windStrength;
            wind.params.speed = P.windSpeed;
            nir?.set(P.nirPaint);
            if (tintUniform) tintUniform.value.set(P.orbTint);
            else orbMat.color.set(P.orbTint);
            orb.visible = P.showOrb !== false;
            const a = elapsed * 0.6 * orbitSpeed;
            const [x, y, z] = fromMax(Math.cos(a) * 260, 100 + Math.sin(a) * 160, 140 + Math.sin(a * 2) * 30);
            orb.position.set(x, y, z);
        },
        dispose() {
            spot?.overrides.clearProperty('map', { restoreValue: null, needsUpdate: true, shadowNeedsUpdate: true });
        },
    };
}
