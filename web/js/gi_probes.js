// gi_probes.js — HALO-GI DDGI irradiance field (docs/GI_HALO_design.md §3).
//
// A world-space grid of octahedral irradiance probes traced against the SAME
// stackless BVH the spectral path tracer uses (shared byte-identically via
// spectral_traverse.js — no second acceleration structure). Pure WebGPU/TSL
// compute; nothing reads back to the CPU.
//
// MVP (Phase 1): single grid, trace + cosine-gather blend + temporal hysteresis,
// infinite bounce over frames (trace reads last frame's atlas), miss = BLACK
// (the load-bearing energy invariant — probes carry ONLY surface inter-reflection;
// PMREM IBL owns the sky). Leak-free Chebyshev + relocation/classification and
// SSILVB are Phase 2/3.
//
// Churn-free by construction (fixes the surfel-grid recompile freeze):
//   • irradiance STATE lives in a read_write StorageBufferAttribute (irrBuffer).
//   • a write-only StorageTexture ATLAS is uploaded from it for HW-bilinear
//     sampling; the material's atlas binding is STABLE, so per-tick data writes
//     never change the material cache key. Only grid resize / enable flips it.

import * as THREE from 'three';
import { LightingNode } from 'three/webgpu';
import {
    Fn, If, Loop, Return, instanceIndex, storage, uniform, texture,
    float, int, uint, vec2, vec3, vec4, uvec2,
    max as tslMax, min as tslMin, mix, clamp, floor, normalize, dot, cross, length,
    abs as tslAbs, sqrt, cos, sin, pow, textureStore, positionWorld, normalWorld, select,
} from 'three/tsl';

// buildSpectralScene (pulls three-mesh-bvh) is lazy-loaded in rebuild() so
// importing this module for the GiProbeNode (e.g. from max_lights_node.js) does
// NOT drag the CPU BVH builder into that module graph.
let _buildSpectralScene = null;
let _collectLights = null;       // cheap light re-collect for reactivity (no BVH rebuild)
let _LIGHT_STRIDE = 16;
import { buildTraversal, T_MAX, RAY_EPS, PI } from './spectral_traverse.js';
import { octEncodeNode, octDecodeNode } from './gi_oct.js';

// namespace injected into the octahedral node builders (gi_oct.js).
const TSL = { float, vec2, vec3, abs: tslAbs, select, max: tslMax, normalize };

const OCT_RES = 6;                 // interior octahedral resolution per probe
const BORDER = 1;                  // 1px gutter on every side
const TILE = OCT_RES + 2 * BORDER; // 8×8 atlas tile
const RAYS_PER_PROBE = 64;         // MVP ray budget (doc target 144)
const CLASSIFY_RAYS = 32;          // fixed full-sphere rays for classification
const BACKFACE_FRACTION = 0.25;    // > this fraction backface hits → probe is buried → INACTIVE
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TARGET_PROBES_LONG_AXIS = 12;
const MAX_PROBES_PER_AXIS = 24;
const MAX_TRIANGLES = 4_000_000;
const MAX_LIGHTS = 64;             // matches spectral_scene LIGHT_STRIDE table
// ── reactivity: respond to live light/geometry edits ──
const REACTIVE_TICKS = 40;         // ticks of fast (low-hysteresis) convergence after a change
const REACTIVE_HYSTERESIS = 0.4;   // hysteresis during a reactivity burst (vs steady-state)
const LIGHT_CHECK_INTERVAL = 6;    // ticks between light-change checks
const GEO_CHECK_INTERVAL = 24;     // ticks between geometry-change checks (full rebuild = expensive)

let _node = null;

// ── injection node: samples the atlas at the shaded surface and adds the
// probe irradiance into builder.context.irradiance (mirrors the GiVolumeNode /
// hemisphere addAssign pattern at max_lights_node.js:224). Stable atlas binding
// → its cacheToken changes ONLY on grid resize / enable, never on data writes.
export class GiProbeNode extends LightingNode {
    static get type() { return 'GiProbeNode'; }

    constructor() {
        super();
        this._atlas = null;
        this._depthAtlas = null;
        this._stateAtlas = null;
        this._enabled = false;
        this._hasData = false;
        this._structGen = 0;     // bumps on grid resize / atlas realloc ONLY
        this.intensity = 1.0;

        this.gridMinNode = uniform(new THREE.Vector3());
        this.gridSizeNode = uniform(new THREE.Vector3(1, 1, 1));
        this.resNode = uniform(new THREE.Vector3(2, 2, 2));
        this.atlasDimNode = uniform(new THREE.Vector2(1, 1));
        this.intensityNode = uniform(1.0);
        this.normalBiasNode = uniform(0.04);
        // 0 → no visibility test (pure trilinear, leaks); 1 → full Chebyshev.
        this.chebyStrengthNode = uniform(1.0);
        // 0 → classification IGNORED (default — safe for thin 2-sided walls, which
        // a backface test misreads); 1 → drop probes buried in SOLID geometry.
        this.classifyStrengthNode = uniform(0.0);
    }

    get active() { return this._enabled && this._hasData && this.intensity > 0; }
    // structure-only token: data writes (textureStore) do NOT change this, so
    // materials never recompile on a probe tick — only on resize/enable.
    get cacheToken() { return `gi-halo-probes:${this._structGen}`; }

    setEnabled(on) { this._enabled = on === true; }
    setIntensity(v) {
        this.intensity = Number.isFinite(v) ? Math.max(0, v) : 0;
        this.intensityNode.value = this.intensity;
    }
    setChebyStrength(v) { if (Number.isFinite(v)) this.chebyStrengthNode.value = THREE.MathUtils.clamp(v, 0, 1); }
    setClassifyStrength(v) { if (Number.isFinite(v)) this.classifyStrengthNode.value = THREE.MathUtils.clamp(v, 0, 1); }
    setAtlases(atlas, depthAtlas, stateAtlas) {
        this._atlas = atlas || null;
        this._depthAtlas = depthAtlas || null;
        this._stateAtlas = stateAtlas || null;
        this._hasData = !!atlas;
        this._structGen++;
    }
    setGrid(gridMin, gridSize, res, atlasW, atlasH, normalBias) {
        this.gridMinNode.value.copy(gridMin);
        this.gridSizeNode.value.copy(gridSize);
        this.resNode.value.copy(res);
        this.atlasDimNode.value.set(atlasW, atlasH);
        if (Number.isFinite(normalBias)) this.normalBiasNode.value = Math.max(1e-4, normalBias);
        this._structGen++;
    }

    // world position of grid probe (px,py,pz).
    _probePos(px, py, pz) {
        const f = vec3(px, py, pz).div(this.resNode.sub(1.0).max(vec3(1.0)));
        return this.gridMinNode.add(f.mul(this.gridSizeNode));
    }

    // tile-local atlas uv for probe (col,row) at octahedral coord octUV.
    _tileUV(col, row, octUV) {
        const ox = col.mul(float(TILE)).add(float(BORDER)).add(octUV.x.mul(float(OCT_RES))).add(0.5);
        const oy = row.mul(float(TILE)).add(float(BORDER)).add(octUV.y.mul(float(OCT_RES))).add(0.5);
        return vec2(ox.div(this.atlasDimNode.x), oy.div(this.atlasDimNode.y));
    }

    // sample the probe field at world (P, N): trilinear over the 8 cage probes,
    // each fetched octahedrally in the shading-normal direction and weighted by
    // a depth-moment Chebyshev visibility test (leak-free through thin walls).
    sampleIrradiance(P, N) {
        const atlas = this._atlas;
        const depthAtlas = this._depthAtlas;
        const res = this.resNode;
        const ry = res.y;
        const cell = this.gridSizeNode.div(res.sub(1.0).max(vec3(1.0)));
        const gridF = P.sub(this.gridMinNode).div(cell.max(vec3(1e-6)));
        const baseF = gridF.floor().clamp(vec3(0.0), res.sub(2.0).max(vec3(0.0)));
        const frac = gridF.sub(baseF).clamp(0.0, 1.0);
        const octN = octEncodeNode(N.normalize(), TSL); // irradiance dir = shading normal

        // PURE-EXPRESSION accumulation (NO toVar/addAssign): this runs inside a
        // fragment material colorNode (not an Fn-wrapped compute kernel), where
        // var mutation does NOT sequence — toVar/addAssign would silently yield 0.
        // The loop is unrolled (8 taps), so a plain expression tree is correct.
        let acc = vec3(0.0);
        let wsum = float(0.0);
        const bx = baseF.x.toUint(), by = baseF.y.toUint(), bz = baseF.z.toUint();
        for (let i = 0; i < 8; i++) {
            const dx = i & 1, dy = (i >> 1) & 1, dz = (i >> 2) & 1;
            const px = float(bx.add(uint(dx)));
            const py = float(by.add(uint(dy)));
            const pz = float(bz.add(uint(dz)));
            const col = px;
            const row = pz.mul(ry).add(py);
            const wx = dx ? frac.x : float(1.0).sub(frac.x);
            const wy = dy ? frac.y : float(1.0).sub(frac.y);
            const wz = dz ? frac.z : float(1.0).sub(frac.z);
            const wTri = wx.mul(wy).mul(wz).add(1e-4);

            // per-probe meta (NEAREST): R=state, GBA=relocation offset. Gated by
            // classifyStrength (default 0 = ignored) — relocation/classification by a
            // backface test misreads thin 2-sided walls, so it's opt-in for solid scenes.
            const metaUV = vec2(col.add(0.5).div(this.resNode.x), row.add(0.5).div(this.resNode.y.mul(this.resNode.z)));
            const meta = texture(this._stateAtlas, metaUV);
            const stateV = meta.x;
            const reloc = vec3(meta.y, meta.z, meta.w).mul(this.classifyStrengthNode);

            // Chebyshev visibility: relocated probe → surface direction vs stored depth.
            const probePos = this._probePos(px, py, pz).add(reloc);
            const toSurf = P.sub(probePos);
            const dist = length(toSurf);
            const octD = octEncodeNode(toSurf.div(dist.max(float(1e-6))), TSL);
            const m = texture(depthAtlas, this._tileUV(col, row, octD));
            const m1 = m.x; const m2 = m.y;
            const variance = m2.sub(m1.mul(m1)).abs();
            const dm = dist.sub(m1);
            const chebyRaw = variance.div(variance.add(dm.mul(dm)).max(float(1e-6)));
            const cheby = select(dist.lessThanEqual(m1), float(1.0), chebyRaw);
            const visW = mix(float(1.0), tslMax(cheby.mul(cheby).mul(cheby), float(0.05)), this.chebyStrengthNode);

            const stateEff = mix(float(1.0), stateV, this.classifyStrengthNode);
            const w = wTri.mul(visW).mul(stateEff);
            const e = texture(atlas, this._tileUV(col, row, octN)).xyz;
            acc = acc.add(e.mul(w));
            wsum = wsum.add(w);
        }
        return acc.div(wsum.max(float(1e-4)));
    }

    setup(builder) {
        if (!this._hasData || !this._atlas || !this._depthAtlas || !this._stateAtlas) return;
        const P = positionWorld.add(normalWorld.mul(this.normalBiasNode));
        const N = normalWorld;
        const E = this.sampleIrradiance(P, N).max(vec3(0.0)).mul(this.intensityNode);
        builder.context.irradiance.addAssign(E);
    }
}

export function getGiProbeNode() {
    if (!_node) _node = new GiProbeNode();
    return _node;
}

function computeGridResolution(size) {
    const longest = Math.max(size.x, size.y, size.z, 1e-3);
    const spacing = longest / TARGET_PROBES_LONG_AXIS;
    const axis = (s) => THREE.MathUtils.clamp(Math.round(s / spacing) + 1, 2, MAX_PROBES_PER_AXIS);
    return new THREE.Vector3(axis(size.x), axis(size.y), axis(size.z));
}

export function createProbeField({ renderer, scene, intensity = 1.0, hysteresis = 0.95 } = {}) {
    const node = getGiProbeNode();
    node.setIntensity(intensity);

    const gridMin = new THREE.Vector3();
    const gridSize = new THREE.Vector3(1, 1, 1);
    const res = new THREE.Vector3(2, 2, 2);
    let probeTotal = 0;
    let atlasW = 1, atlasH = 1;

    let gpu = null;           // { buffers, kernels, atlases, buffers... }
    let dirty = true;
    let needsClassify = true; // one-shot probe classification after a rebuild
    let inFlight = false;
    let disposed = false;
    let probeCursor = 0;
    let frameCounter = 0;
    let updatedPerTick = 1;
    // reactivity: self-detect live light/geometry edits and re-converge fast.
    const baseHysteresis = THREE.MathUtils.clamp(hysteresis, 0, 0.99);
    let lastLightSig = null;
    let lastGeoSig = null;
    let geoChanged = false;   // debounce: rebuild only after geometry edits SETTLE
    let checkCounter = 0;
    let reactiveTicks = 0;
    const _sigVec = new THREE.Vector3();

    const U = {
        gridMin: uniform(new THREE.Vector3()),
        gridSize: uniform(new THREE.Vector3(1, 1, 1)),
        resX: uniform(2, 'uint'), resY: uniform(2, 'uint'), resZ: uniform(2, 'uint'),
        probeTotal: uniform(1, 'uint'),
        probeOffset: uniform(0, 'uint'),
        updatedCount: uniform(1, 'uint'),
        atlasDim: uniform(new THREE.Vector2(1, 1)),
        lightCount: uniform(0, 'uint'),
        frameJitter: uniform(0.0),
        hysteresis: uniform(THREE.MathUtils.clamp(hysteresis, 0, 0.99)),
        maxDist: uniform(100.0),        // miss-ray depth (probe sees "far") = grid diagonal
        depthSharpness: uniform(50.0),  // cosine power → depth tracks nearest occluder crisply
        radianceClamp: uniform(8.0),    // cap the multibounce feedback term (anti-runaway)
        cellMin: uniform(0.1),          // min grid cell spacing (relocation margin)
        relocClamp: uniform(0.045),     // max relocation offset (< 0.45·cell → probe stays in cell)
        classifyStrength: uniform(0.0), // gates relocation APPLY (mirrors node.classifyStrengthNode)
    };

    function isSupported() {
        return renderer?.backend?.isWebGPUBackend === true
            && typeof renderer.computeAsync === 'function'
            && typeof THREE.StorageTexture === 'function'
            && typeof THREE.StorageBufferAttribute === 'function';
    }

    function disposeGPU() {
        if (!gpu) return;
        for (const k of ['bvhNodes', 'triIndex', 'vertexData', 'triMaterial', 'materials', 'lights']) gpu.buffers[k]?.dispose?.();
        gpu.irrBuffer?.dispose?.();
        gpu.depthBuffer?.dispose?.();
        gpu.stateBuffer?.dispose?.();
        gpu.rayBuffer?.dispose?.();
        gpu.atlas?.dispose?.();
        gpu.depthAtlas?.dispose?.();
        gpu.stateAtlas?.dispose?.();
        if (gpu.maps) for (const t of Object.values(gpu.maps)) t?.dispose?.();
        gpu = null;
        node.setAtlases(null, null, null);
    }

    // spherical-Fibonacci ray k of N, with a per-frame jitter to decorrelate
    // frames. MUST be reproduced identically in the blend gather.
    function rayDir(kNode, jitterNode) {
        const fk = float(kNode).add(jitterNode);
        const z = float(1.0).sub(fk.add(0.5).div(float(RAYS_PER_PROBE)).mul(2.0));
        const r = sqrt(tslMax(float(0.0), float(1.0).sub(z.mul(z))));
        const phi = fk.mul(float(GOLDEN_ANGLE));
        return vec3(r.mul(cos(phi)), r.mul(sin(phi)), z);
    }

    // fixed full-sphere Fibonacci ray for classification (NO frame jitter).
    function classifyRayDir(kNode) {
        const z = float(1.0).sub(float(kNode).add(0.5).div(float(CLASSIFY_RAYS)).mul(2.0));
        const r = sqrt(tslMax(float(0.0), float(1.0).sub(z.mul(z))));
        const phi = float(kNode).mul(float(GOLDEN_ANGLE));
        return vec3(r.mul(cos(phi)), r.mul(sin(phi)), z);
    }

    function probeWorldPos(pIndexNode) {
        const ix = pIndexNode.mod(U.resX);
        const iy = pIndexNode.div(U.resX).mod(U.resY);
        const iz = pIndexNode.div(U.resX.mul(U.resY));
        const fx = float(ix).div(tslMax(float(1.0), float(U.resX).sub(1.0)));
        const fy = float(iy).div(tslMax(float(1.0), float(U.resY).sub(1.0)));
        const fz = float(iz).div(tslMax(float(1.0), float(U.resZ).sub(1.0)));
        return vec3(
            U.gridMin.x.add(fx.mul(U.gridSize.x)),
            U.gridMin.y.add(fy.mul(U.gridSize.y)),
            U.gridMin.z.add(fz.mul(U.gridSize.z)),
        );
    }

    function buildKernels(built) {
        const buffers = {
            bvhNodes: new THREE.StorageBufferAttribute(built.bvhNodes, 1),
            triIndex: new THREE.StorageBufferAttribute(built.triIndex, 1),
            vertexData: new THREE.StorageBufferAttribute(built.vertexData, 1),
            triMaterial: new THREE.StorageBufferAttribute(built.triMaterial, 1),
            materials: new THREE.StorageBufferAttribute(built.materials, 1),
            lights: new THREE.StorageBufferAttribute(built.lights, 1),
        };
        const bvhNodes = storage(buffers.bvhNodes, 'uint', buffers.bvhNodes.count).toReadOnly();
        const triIndex = storage(buffers.triIndex, 'uint', buffers.triIndex.count).toReadOnly();
        const vertexData = storage(buffers.vertexData, 'float', buffers.vertexData.count).toReadOnly();
        const triMaterial = storage(buffers.triMaterial, 'uint', buffers.triMaterial.count).toReadOnly();
        const materials = storage(buffers.materials, 'float', buffers.materials.count).toReadOnly();
        const lights = storage(buffers.lights, 'float', buffers.lights.count).toReadOnly();

        const Utrav = { nodeCount: uniform(built.nodeCount >>> 0, 'uint'), envRotation: uniform(0.0), envIntensity: uniform(1.0) };
        const trav = buildTraversal({
            storages: { bvhNodes, triIndex, vertexData, triMaterial, materials },
            U: Utrav, env: null, lut: null, lutRes: 0, maps: {},
        });
        const { fetchVert, fetchNorm, traverseClosest, traverseAny, matFloat, triVert } = trav;

        // ray scratch: 4 floats per (probe,ray) = rgb + hitT. itemSize-1 'float'
        // scalar storage — the proven in-repo pattern (gi_irradiance_volume), not
        // the unproven vec4 binding.
        const rayBuffer = new THREE.StorageBufferAttribute(new Float32Array(Math.max(4, updatedCap() * RAYS_PER_PROBE * 4)), 1);
        const rayData = storage(rayBuffer, 'float', rayBuffer.count);

        // irradiance STATE buffer (read_write): 4 floats per probe texel.
        const irrBuffer = new THREE.StorageBufferAttribute(new Float32Array(Math.max(4, probeTotal * TILE * TILE * 4)), 1);
        const irr = storage(irrBuffer, 'float', irrBuffer.count);
        const irrRead = storage(irrBuffer, 'float', irrBuffer.count).toReadOnly();

        // write-only sampled atlas (HW bilinear) — uploaded from irrBuffer.
        const atlas = new THREE.StorageTexture(atlasW, atlasH);
        atlas.type = THREE.HalfFloatType; atlas.format = THREE.RGBAFormat;
        atlas.minFilter = THREE.LinearFilter; atlas.magFilter = THREE.LinearFilter;
        atlas.wrapS = THREE.ClampToEdgeWrapping; atlas.wrapT = THREE.ClampToEdgeWrapping;
        atlas.generateMipmaps = false; atlas.mipmapsAutoUpdate = false;

        // depth-moment STATE (read_write): 2 floats per probe texel (meanR, meanR²),
        // + a sampled depth atlas for the Chebyshev visibility test (leak-free).
        const depthBuffer = new THREE.StorageBufferAttribute(new Float32Array(Math.max(2, probeTotal * TILE * TILE * 2)), 1);
        const depthS = storage(depthBuffer, 'float', depthBuffer.count);
        const depthRead = storage(depthBuffer, 'float', depthBuffer.count).toReadOnly();
        const depthAtlas = new THREE.StorageTexture(atlasW, atlasH);
        depthAtlas.type = THREE.HalfFloatType; depthAtlas.format = THREE.RGBAFormat;
        depthAtlas.minFilter = THREE.LinearFilter; depthAtlas.magFilter = THREE.LinearFilter;
        depthAtlas.wrapS = THREE.ClampToEdgeWrapping; depthAtlas.wrapT = THREE.ClampToEdgeWrapping;
        depthAtlas.generateMipmaps = false; depthAtlas.mipmapsAutoUpdate = false;

        // probe META: 4 floats/probe = [state(1=active/0=buried), offset.xyz(relocation)].
        // Sampled (NEAREST, per-probe) by the node; atlas packs R=state, GBA=offset.
        const stateBuffer = new THREE.StorageBufferAttribute(new Float32Array(Math.max(4, probeTotal * 4)), 1);
        const stateS = storage(stateBuffer, 'float', stateBuffer.count);
        const stateRead = storage(stateBuffer, 'float', stateBuffer.count).toReadOnly();
        const stateAtlas = new THREE.StorageTexture(Math.max(1, res.x), Math.max(1, res.y * res.z));
        stateAtlas.type = THREE.HalfFloatType; stateAtlas.format = THREE.RGBAFormat;
        stateAtlas.minFilter = THREE.NearestFilter; stateAtlas.magFilter = THREE.NearestFilter;
        stateAtlas.wrapS = stateAtlas.wrapT = THREE.ClampToEdgeWrapping;
        stateAtlas.generateMipmaps = false; stateAtlas.mipmapsAutoUpdate = false;

        const loadLightVec3 = (base, off) => vec3(lights.element(base.add(uint(off))), lights.element(base.add(uint(off + 1))), lights.element(base.add(uint(off + 2))));

        // sample the (last-frame) atlas irradiance at world (P,N) — for multibounce.
        const sampleAtlas = (P, N) => {
            const cell = vec3(
                U.gridSize.x.div(tslMax(float(1.0), float(U.resX).sub(1.0))),
                U.gridSize.y.div(tslMax(float(1.0), float(U.resY).sub(1.0))),
                U.gridSize.z.div(tslMax(float(1.0), float(U.resZ).sub(1.0))),
            );
            const gridF = P.sub(U.gridMin).div(cell.max(vec3(1e-6)));
            const resV = vec3(float(U.resX), float(U.resY), float(U.resZ));
            const baseF = gridF.floor().clamp(vec3(0.0), resV.sub(2.0).max(vec3(0.0)));
            const frac = gridF.sub(baseF).clamp(0.0, 1.0);
            const octUV = octEncodeNode(N.normalize(), TSL);
            const acc = vec3(0.0).toVar();
            const wsum = float(0.0).toVar();
            for (let i = 0; i < 8; i++) {
                const dx = i & 1, dy = (i >> 1) & 1, dz = (i >> 2) & 1;
                const px = baseF.x.add(float(dx));
                const py = baseF.y.add(float(dy));
                const pz = baseF.z.add(float(dz));
                const wx = dx ? frac.x : float(1.0).sub(frac.x);
                const wy = dy ? frac.y : float(1.0).sub(frac.y);
                const wz = dz ? frac.z : float(1.0).sub(frac.z);
                const w = wx.mul(wy).mul(wz).add(1e-4);
                const col = px;
                const row = pz.mul(float(U.resY)).add(py);
                const ox = col.mul(float(TILE)).add(float(BORDER)).add(octUV.x.mul(float(OCT_RES))).add(0.5);
                const oy = row.mul(float(TILE)).add(float(BORDER)).add(octUV.y.mul(float(OCT_RES))).add(0.5);
                const uv = vec2(ox.div(U.atlasDim.x), oy.div(U.atlasDim.y));
                acc.addAssign(texture(atlas, uv).xyz.mul(w));
                wsum.addAssign(w);
            }
            return acc.div(wsum.max(float(1e-4)));
        };

        // ── TRACE: one thread per (updated probe, ray). RGB shade; miss=BLACK ──
        const traceKernel = Fn(() => {
            const gid = instanceIndex.toVar();
            const slot = gid.div(uint(RAYS_PER_PROBE)).toVar();
            If(slot.greaterThanEqual(U.updatedCount), () => { Return(); });
            const k = gid.mod(uint(RAYS_PER_PROBE)).toVar();
            const probeIndex = U.probeOffset.add(slot).mod(U.probeTotal).toVar();
            const ro = probeWorldPos(probeIndex).toVar();
            // apply relocation offset (gated by classifyStrength; 0 = no relocation).
            const mbT = probeIndex.mul(uint(4));
            ro.addAssign(vec3(stateRead.element(mbT.add(uint(1))), stateRead.element(mbT.add(uint(2))), stateRead.element(mbT.add(uint(3)))).mul(U.classifyStrength));
            const rd = normalize(rayDir(k, U.frameJitter)).toVar();

            const outRgb = vec3(0.0).toVar();
            const hitT = float(-1.0).toVar();
            const bestT = float(T_MAX).toVar();
            const bestTri = int(-1).toVar();
            traverseClosest(ro, rd, bestT, bestTri);

            If(bestTri.greaterThanEqual(int(0)), () => {
                hitT.assign(bestT);
                const triId = uint(bestTri);
                const matId = triMaterial.element(triId);
                const p0 = fetchVert(triVert(triId, 0));
                const p1 = fetchVert(triVert(triId, 1));
                const p2 = fetchVert(triVert(triId, 2));
                const ngRaw = normalize(cross(p1.sub(p0), p2.sub(p0)));
                const faceFwd = dot(ngRaw, rd).lessThan(float(0.0));
                const ng = ngRaw.mul(select(faceFwd, float(1.0), float(-1.0))).toVar();
                const hitPoint = ro.add(rd.mul(bestT));
                const hitPos = hitPoint.add(ng.mul(float(RAY_EPS))).toVar();

                const baseColor = vec3(matFloat(matId, 0), matFloat(matId, 1), matFloat(matId, 2)).toVar();
                const emissive = vec3(matFloat(matId, 7), matFloat(matId, 8), matFloat(matId, 9));
                const radiance = emissive.toVar();

                // NEE over ALL lights (count small; loop avoids sampling noise).
                Loop({ start: uint(0), end: U.lightCount, type: 'uint', condition: '<' }, ({ i: li }) => {
                    const lb = li.mul(uint(16)).toVar();
                    const ltype = lights.element(lb);
                    const lpos = loadLightVec3(lb, 1);
                    const ldir = loadLightVec3(lb, 4);
                    const lcol = loadLightVec3(lb, 7);
                    const lrange = lights.element(lb.add(uint(10)));
                    const ldecay = lights.element(lb.add(uint(11)));
                    const lcosAngle = lights.element(lb.add(uint(12)));
                    const lcosPen = lights.element(lb.add(uint(13)));
                    const isDir = ltype.lessThan(float(0.5));
                    const isSpot = float(ltype.sub(float(2.0)).abs()).lessThan(float(0.5));
                    const toLight = select(isDir, ldir.mul(-1.0), lpos.sub(hitPos));
                    const dist = select(isDir, float(1e4), tslMax(length(toLight), float(1e-4)));
                    const wi = normalize(toLight);
                    const ndl = tslMax(dot(ng, wi), float(0.0));
                    If(ndl.greaterThan(float(0.0)), () => {
                        const blocked = traverseAny(hitPos, wi, dist.sub(float(RAY_EPS)));
                        If(blocked.lessThan(float(0.5)), () => {
                            const falloff = float(1.0).div(tslMax(pow(dist, ldecay), float(0.01)));
                            const rr = dist.div(tslMax(lrange, float(1e-4)));
                            const rr2 = rr.mul(rr);
                            const win = clamp(float(1.0).sub(rr2.mul(rr2)), float(0.0), float(1.0));
                            const ranged = falloff.mul(win.mul(win));
                            const posAtten = select(lrange.greaterThan(float(0.0)), ranged, falloff);
                            const distAtten = select(isDir, float(1.0), posAtten);
                            const angleCos = dot(wi, ldir).mul(-1.0);
                            const spotAtten = clamp(angleCos.sub(lcosAngle).div(tslMax(lcosPen.sub(lcosAngle), float(1e-4))), float(0.0), float(1.0));
                            const atten = distAtten.mul(select(isSpot, spotAtten, float(1.0)));
                            const diffuse = baseColor.mul(float(1.0).div(float(PI)));
                            radiance.addAssign(diffuse.mul(ndl).mul(lcol).mul(atten));
                        });
                    });
                });

                // multibounce: add last frame's irradiance × albedo (the atlas is
                // re-uploaded every tick, so this reads a valid prior field; on
                // tick 1 it reads zero, which is correct). Lambert: E·albedo/π.
                const bounce = sampleAtlas(hitPos, ng).mul(baseColor).mul(float(1.0).div(float(PI)));
                radiance.addAssign(tslMin(bounce, vec3(U.radianceClamp))); // clamp feedback spikes
                outRgb.assign(radiance);
            });
            // miss → outRgb stays BLACK (CRITICAL: never sample sky here — IBL
            // owns the sky hemisphere; sampling it would double-count IBL).

            const rb = slot.mul(uint(RAYS_PER_PROBE)).add(k).mul(uint(4)).toVar();
            rayData.element(rb).assign(outRgb.x);
            rayData.element(rb.add(uint(1))).assign(outRgb.y);
            rayData.element(rb.add(uint(2))).assign(outRgb.z);
            rayData.element(rb.add(uint(3))).assign(hitT);
        })().compute(updatedCap() * RAYS_PER_PROBE);

        // ── BLEND: one thread per (updated probe, atlas texel). Cosine-gather
        // the probe's rays for this texel's octahedral direction; hysteresis. ──
        const blendKernel = Fn(() => {
            const gid = instanceIndex.toVar();
            const slot = gid.div(uint(TILE * TILE)).toVar();
            If(slot.greaterThanEqual(U.updatedCount), () => { Return(); });
            const local = gid.mod(uint(TILE * TILE)).toVar();
            const lx = local.mod(uint(TILE)).toVar();
            const ly = local.div(uint(TILE)).toVar();
            const probeIndex = U.probeOffset.add(slot).mod(U.probeTotal).toVar();

            // texel direction (border texels get slightly-out-of-range uv → a
            // natural octahedral gutter; continuous under HW bilinear for MVP).
            const u = float(lx).sub(float(BORDER)).add(0.5).div(float(OCT_RES));
            const v = float(ly).sub(float(BORDER)).add(0.5).div(float(OCT_RES));
            const dir = octDecodeNode(vec2(u, v), TSL).toVar();

            const acc = vec3(0.0).toVar();
            const wsum = float(0.0).toVar();
            const dAcc = float(0.0).toVar();   // Σ w·dist  (sharp cosine weight)
            const dAcc2 = float(0.0).toVar();  // Σ w·dist²
            const dwsum = float(0.0).toVar();
            Loop({ start: uint(0), end: uint(RAYS_PER_PROBE), type: 'uint', condition: '<' }, ({ i: k }) => {
                const rb = slot.mul(uint(RAYS_PER_PROBE)).add(k).mul(uint(4));
                const rrgb = vec3(rayData.element(rb), rayData.element(rb.add(uint(1))), rayData.element(rb.add(uint(2))));
                const hitT = rayData.element(rb.add(uint(3)));
                const rdir = normalize(rayDir(k, U.frameJitter));
                const cw = tslMax(dot(dir, rdir), float(0.0));
                acc.addAssign(rrgb.mul(cw));
                wsum.addAssign(cw);
                // depth moments: miss → "far" so the probe stays visible that way.
                const rdist = select(hitT.lessThan(float(0.0)), U.maxDist, hitT);
                const dw = pow(cw, U.depthSharpness);
                dAcc.addAssign(rdist.mul(dw));
                dAcc2.addAssign(rdist.mul(rdist).mul(dw));
                dwsum.addAssign(dw);
            });
            const meanRad = acc.div(wsum.max(float(1e-4)));
            const meanR = dAcc.div(dwsum.max(float(1e-4)));
            const meanR2 = dAcc2.div(dwsum.max(float(1e-4)));

            // irradiance: read prev + write blended through ONE read_write 'float'
            // binding (proven surfel-grid pattern).
            const ib = probeIndex.mul(uint(TILE * TILE)).add(local).mul(uint(4)).toVar();
            const prev = vec3(irr.element(ib), irr.element(ib.add(uint(1))), irr.element(ib.add(uint(2))));
            const wasBlack = dot(prev, vec3(1.0)).lessThan(float(1e-6));
            const h = select(wasBlack, float(0.0), U.hysteresis);
            const blended = mix(meanRad, prev, h);
            irr.element(ib).assign(blended.x);
            irr.element(ib.add(uint(1))).assign(blended.y);
            irr.element(ib.add(uint(2))).assign(blended.z);

            // depth moments: same hysteresis; fill instantly when unseeded.
            const db = probeIndex.mul(uint(TILE * TILE)).add(local).mul(uint(2)).toVar();
            const dprev = vec2(depthS.element(db), depthS.element(db.add(uint(1))));
            const dWasZero = dprev.x.lessThan(float(1e-6));
            const dh = select(dWasZero, float(0.0), U.hysteresis);
            const dblended = mix(vec2(meanR, meanR2), dprev, dh);
            depthS.element(db).assign(dblended.x);
            depthS.element(db.add(uint(1))).assign(dblended.y);
        })().compute(updatedCap() * TILE * TILE);

        // ── UPLOAD: copy irrBuffer → atlas StorageTexture (full field each tick;
        // cheap, keeps the sampled atlas authoritative without read-after-write). ──
        const uploadKernel = Fn(() => {
            const gid = instanceIndex.toVar();
            const total = uint(probeTotal * TILE * TILE);
            If(gid.greaterThanEqual(total), () => { Return(); });
            const probeIndex = gid.div(uint(TILE * TILE)).toVar();
            const local = gid.mod(uint(TILE * TILE)).toVar();
            const lx = local.mod(uint(TILE)).toVar();
            const ly = local.div(uint(TILE)).toVar();
            const col = probeIndex.mod(U.resX);
            const row = probeIndex.div(U.resX.mul(U.resY)).mul(U.resY).add(probeIndex.div(U.resX).mod(U.resY));
            const tx = col.mul(uint(TILE)).add(lx);
            const ty = row.mul(uint(TILE)).add(ly);
            const ib = gid.mul(uint(4));
            const e = vec3(irrRead.element(ib), irrRead.element(ib.add(uint(1))), irrRead.element(ib.add(uint(2))));
            textureStore(atlas, uvec2(tx, ty), vec4(e, float(1.0))).toWriteOnly();
            const db = gid.mul(uint(2));
            const dd = vec2(depthRead.element(db), depthRead.element(db.add(uint(1))));
            textureStore(depthAtlas, uvec2(tx, ty), vec4(dd.x, dd.y, float(0.0), float(1.0))).toWriteOnly();
        })().compute(probeTotal * TILE * TILE);

        // ── CLASSIFY: one thread per probe. Fixed full-sphere rays; if too many
        // hit BACKFACES the probe is buried in geometry → mark INACTIVE. ──
        const classifyKernel = Fn(() => {
            const p = instanceIndex.toVar();
            If(p.greaterThanEqual(U.probeTotal), () => { Return(); });
            const ro = probeWorldPos(p).toVar();
            const back = float(0.0).toVar();
            const hits = float(0.0).toVar();
            const closeBackDist = float(1e30).toVar();
            const closeBackDir = vec3(0.0).toVar();
            const closeFrontDist = float(1e30).toVar();
            Loop({ start: uint(0), end: uint(CLASSIFY_RAYS), type: 'uint', condition: '<' }, ({ i: k }) => {
                const rd = normalize(classifyRayDir(k)).toVar();
                const bestT = float(T_MAX).toVar();
                const bestTri = int(-1).toVar();
                traverseClosest(ro, rd, bestT, bestTri);
                If(bestTri.greaterThanEqual(int(0)), () => {
                    hits.addAssign(float(1.0));
                    const triId = uint(bestTri);
                    const p0 = fetchVert(triVert(triId, 0));
                    const p1 = fetchVert(triVert(triId, 1));
                    const p2 = fetchVert(triVert(triId, 2));
                    const ng = normalize(cross(p1.sub(p0), p2.sub(p0)));
                    If(dot(rd, ng).greaterThan(float(0.0)), () => { // backface → probe is behind this surface
                        back.addAssign(float(1.0));
                        If(bestT.lessThan(closeBackDist), () => { closeBackDist.assign(bestT); closeBackDir.assign(rd); });
                    }).Else(() => {
                        If(bestT.lessThan(closeFrontDist), () => { closeFrontDist.assign(bestT); });
                    });
                });
            });
            const frac = back.div(tslMax(hits, float(1.0)));
            const state = select(frac.greaterThan(float(BACKFACE_FRACTION)), float(0.0), float(1.0)).toVar();

            // RELOCATION: if the probe is behind a surface (closest hit is a backface),
            // push ALONG that ray past the surface into valid space. Clamp < relocClamp
            // so the probe never leaves its own cell. (Applied only when classifyStrength>0.)
            const off = vec3(0.0).toVar();
            If(back.greaterThan(float(0.5)).and(closeBackDist.lessThan(closeFrontDist)), () => {
                const step = closeBackDist.add(float(0.5).mul(tslMin(closeFrontDist, U.cellMin)));
                const raw = closeBackDir.mul(step);
                const len = length(raw);
                off.assign(raw.mul(tslMin(len, U.relocClamp).div(tslMax(len, float(1e-6)))));
            });

            const mb = p.mul(uint(4)).toVar();
            stateS.element(mb).assign(state);
            stateS.element(mb.add(uint(1))).assign(off.x);
            stateS.element(mb.add(uint(2))).assign(off.y);
            stateS.element(mb.add(uint(3))).assign(off.z);
        })().compute(probeTotal);

        // upload per-probe meta → atlas (1 texel/probe): R=state, GBA=relocation offset.
        const uploadStateKernel = Fn(() => {
            const p = instanceIndex.toVar();
            If(p.greaterThanEqual(uint(probeTotal)), () => { Return(); });
            const col = p.mod(U.resX);
            const row = p.div(U.resX.mul(U.resY)).mul(U.resY).add(p.div(U.resX).mod(U.resY));
            const mb = p.mul(uint(4));
            textureStore(stateAtlas, uvec2(col, row), vec4(
                stateRead.element(mb), stateRead.element(mb.add(uint(1))),
                stateRead.element(mb.add(uint(2))), stateRead.element(mb.add(uint(3))),
            )).toWriteOnly();
        })().compute(probeTotal);

        return { buffers, traceKernel, blendKernel, uploadKernel, classifyKernel, uploadStateKernel, atlas, depthAtlas, stateAtlas, irrBuffer, depthBuffer, stateBuffer, rayBuffer, maps: built.maps, lightCount: built.lightCount };
    }

    function updatedCap() {
        // round-robin: update ~1/4 of probes per tick (≥1).
        return Math.max(1, Math.ceil(Math.max(1, probeTotal) / 4));
    }

    async function ensureSceneBuilder() {
        if (!_buildSpectralScene) {
            const mod = await import('./spectral_scene.js');
            _buildSpectralScene = mod.buildSpectralScene;
            _collectLights = mod.collectLights || null;
            if (Number.isFinite(mod.LIGHT_STRIDE)) _LIGHT_STRIDE = mod.LIGHT_STRIDE;
        }
        return _buildSpectralScene;
    }

    async function rebuild() {
        const buildSpectralScene = await ensureSceneBuilder();
        const built = buildSpectralScene({ THREE, scene, maxTriangles: MAX_TRIANGLES });
        if (!built || built.error) { disposeGPU(); return false; }

        const box = new THREE.Box3();
        scene.updateMatrixWorld(true);
        box.setFromObject(scene);
        if (box.isEmpty()) { disposeGPU(); return false; }
        box.getSize(gridSize);
        gridMin.copy(box.min);
        // pad the grid slightly so surfaces sit inside the cage.
        const pad = gridSize.clone().multiplyScalar(0.06);
        gridMin.sub(pad); gridSize.add(pad.clone().multiplyScalar(2));
        res.copy(computeGridResolution(gridSize));
        probeTotal = res.x * res.y * res.z;
        atlasW = res.x * TILE;
        atlasH = res.y * res.z * TILE;

        disposeGPU();
        gpu = buildKernels(built);

        U.gridMin.value.copy(gridMin);
        U.gridSize.value.copy(gridSize);
        U.resX.value = res.x >>> 0; U.resY.value = res.y >>> 0; U.resZ.value = res.z >>> 0;
        U.probeTotal.value = probeTotal >>> 0;
        U.atlasDim.value.set(atlasW, atlasH);
        U.lightCount.value = Math.min(MAX_LIGHTS, gpu.lightCount) >>> 0;
        U.maxDist.value = gridSize.length();

        const minCell = Math.min(gridSize.x / Math.max(1, res.x - 1), gridSize.y / Math.max(1, res.y - 1), gridSize.z / Math.max(1, res.z - 1));
        U.cellMin.value = Math.max(1e-4, minCell);
        U.relocClamp.value = 0.45 * minCell;
        node.setAtlases(gpu.atlas, gpu.depthAtlas, gpu.stateAtlas);
        node.setGrid(gridMin, gridSize, res, atlasW, atlasH, minCell * 0.5);
        probeCursor = 0;
        dirty = false;
        needsClassify = true;
        return true;
    }

    async function tick() {
        if (disposed || inFlight || !node._enabled || !isSupported()) return;
        if (dirty || !gpu) { inFlight = true; let ok = false; try { ok = await rebuild(); } finally { inFlight = false; } if (!ok) return; }
        if (!gpu) return;

        // reactivity: detect live light/geometry edits (throttled). Light change →
        // cheap in-place buffer refresh; geometry change → full BVH rebuild next tick.
        checkCounter++;
        if (checkCounter % LIGHT_CHECK_INTERVAL === 0) {
            const ls = lightSignature();
            if (lastLightSig !== null && ls !== lastLightSig) refreshLights();
            lastLightSig = ls;
        }
        if (checkCounter % GEO_CHECK_INTERVAL === 0) {
            const gs = geoSignature();
            // debounce: only rebuild once the geometry has SETTLED (stable for one
            // interval), so a continuous drag doesn't trigger a rebuild every check.
            if (lastGeoSig !== null && gs !== lastGeoSig) geoChanged = true;
            else if (geoChanged) { geoChanged = false; reactiveTicks = REACTIVE_TICKS; requestRebuild(); }
            lastGeoSig = gs;
        }
        // drop hysteresis during a reactivity burst so the field re-converges fast.
        U.hysteresis.value = reactiveTicks > 0 ? REACTIVE_HYSTERESIS : baseHysteresis;
        if (reactiveTicks > 0) reactiveTicks--;

        const updated = Math.min(updatedCap(), probeTotal);
        U.probeOffset.value = probeCursor >>> 0;
        U.updatedCount.value = updated >>> 0;
        frameCounter = (frameCounter + 1) >>> 0;
        U.frameJitter.value = (frameCounter * 0.61803398875) % 1;
        probeCursor = probeTotal > 0 ? (probeCursor + updated) % probeTotal : 0;

        inFlight = true;
        try {
            if (needsClassify) {
                await renderer.computeAsync(gpu.classifyKernel);
                await renderer.computeAsync(gpu.uploadStateKernel);
                needsClassify = false;
            }
            await renderer.computeAsync(gpu.traceKernel);
            await renderer.computeAsync(gpu.blendKernel);
            await renderer.computeAsync(gpu.uploadKernel);
        } catch (e) {
            console.warn('max.js HALO-GI probe tick failed:', e);
            dirty = true;
        } finally {
            inFlight = false;
        }
    }

    function setEnabled(on) { node.setEnabled(on === true); if (on) dirty = true; }
    function requestRebuild() { dirty = true; }

    // ── reactivity helpers ──
    // Cheap scene signatures: a change flags a light refresh (in-place) or a full
    // BVH rebuild. Both kick a low-hysteresis burst so the field re-converges fast.
    function lightSignature() {
        let s = '', n = 0;
        scene.traverseVisible((o) => {
            if (!o.isLight || o.isAmbientLight || o.isHemisphereLight) return;
            o.getWorldPosition(_sigVec);
            const c = o.color;
            s += `${Math.round(_sigVec.x)},${Math.round(_sigVec.y)},${Math.round(_sigVec.z)}|`
               + `${c ? Math.round((c.r * 7 + c.g * 11 + c.b * 13) * 32) : 0}|`
               + `${Math.round((o.intensity || 0) * 10)}|${Math.round((o.angle || 0) * 100)};`;
            n++;
        });
        return n + ':' + s;
    }
    function geoSignature() {
        let meshes = 0, prims = 0, hash = 0;
        scene.traverseVisible((o) => {
            if (!o.isMesh && !o.isInstancedMesh) return;
            const p = o.geometry?.attributes?.position; if (!p) return;
            meshes++;
            prims += o.geometry.index ? o.geometry.index.count : p.count;
            const e = o.matrixWorld?.elements;
            if (e) hash += e[12] + e[13] * 1.7 + e[14] * 2.3 + p.count + (o.count || 1);
        });
        return `${meshes}:${prims}:${Math.round(hash)}`;
    }
    // re-collect lights into the existing buffer (no BVH rebuild). Count change → full rebuild.
    function refreshLights() {
        if (!gpu || !_collectLights) return;
        let records;
        try { records = _collectLights(THREE, scene); } catch { return; }
        if (records.length !== gpu.lightCount) { requestRebuild(); return; }
        const arr = gpu.buffers.lights.array;
        arr.fill(0);
        for (let i = 0; i < records.length; i++) arr.set(records[i], i * _LIGHT_STRIDE);
        gpu.buffers.lights.needsUpdate = true;
        reactiveTicks = REACTIVE_TICKS;
    }

    function dispose() { disposed = true; disposeGPU(); node.setEnabled(false); }

    return {
        node,
        tick,
        setEnabled,
        setIntensity: (v) => node.setIntensity(v),
        setChebyStrength: (v) => node.setChebyStrength(v),
        setClassifyStrength: (v) => {
            node.setClassifyStrength(v); // node-side: classification gate + relocation apply
            if (Number.isFinite(v)) U.classifyStrength.value = THREE.MathUtils.clamp(v, 0, 1); // trace-side relocation apply
        },
        requestRebuild,
        isSupported,
        hasData: () => node._hasData === true,
        getStats: () => ({ probes: probeTotal, res: res.clone(), atlas: [atlasW, atlasH], rays: RAYS_PER_PROBE, active: node.active }),
        getResolution: () => res.clone(),
        _debugAtlas: () => gpu?.atlas || null,
        _debugDepthAtlas: () => gpu?.depthAtlas || null,
        _debugStateAtlas: () => gpu?.stateAtlas || null,
        _debugStateBuffer: () => gpu?.stateBuffer || null,
        dispose,
    };
}

export default createProbeField;
