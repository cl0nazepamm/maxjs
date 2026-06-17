// spectral_kernel.js — TSL compute kernel + blit material for the spectral
// path tracer. Pure-TSL (no raw WGSL); mirrors the compute idioms proven in
// web/js/layer_deform.js and web/js/gpu_normals.js on this r184 build.
//
// One invocation = one pixel = one full path (1 spp/frame, accumulated). The
// path carries a single hero wavelength λ; material reflectance is a 3-bin
// spectrum sampled at λ; the path's scalar radiance is converted to CIE XYZ
// (Wyman 2013 analytic fits) and summed in a storage buffer. The blit divides
// by the global sample count and maps XYZ→sRGB. "Fast not accurate" by design.
//
// Buffer strides come from spectral_scene.js: bvhNodes u32×8, triIndex u32×3,
// vertexData f32×8 (pos+normal+uv), triMaterial u32×1, materials f32×24,
// lights f32×16, accum f32×4 (xyz + pad). PBR maps arrive as DataArrayTextures
// (one per type) sampled at the hit UV.

import * as TSL from 'three/tsl';

const {
    Fn, Loop, If, Break, Return, instanceIndex, uniform, storage, texture, texture3D,
    float, int, uint, vec2, vec3, vec4,
    uintBitsToFloat, equirectUV,
    select, max, min, abs, sqrt, sin, cos, exp, pow, floor,
    dot, cross, normalize, reflect, mix, clamp, length, smoothstep,
} = TSL;

const PI = 3.141592653589793;
const LAMBDA_MIN = 380.0;
const LAMBDA_MAX = 720.0;
const LAMBDA_RANGE = LAMBDA_MAX - LAMBDA_MIN;
// ∫ȳ(λ)dλ over [380,720] for the Wyman fits below. Dividing the XYZ Monte
// Carlo estimate by this maps a unit flat spectrum to Y=1 (neutral white);
// without it a fully-lit white surface lands at Y≈107 and blows out to white.
const CIE_Y_INTEGRAL = 106.936;
const INV_U32 = 1.0 / 4294967296.0;
const T_MAX = 1e30;
const RAY_EPS = 1e-3;

// ── Wyman 2013 single-lobe CIE 1931 fits ───────────────────────────
function wymanG(x, mu, s1, s2) {
    const t = x.sub(mu);
    const s = select(x.lessThan(mu), float(s1), float(s2));
    const e = t.mul(s);
    return exp(e.mul(e).mul(-0.5));
}
function cieX(l) {
    return wymanG(l, 599.8, 0.0264, 0.0323).mul(1.056)
        .add(wymanG(l, 442.0, 0.0624, 0.0374).mul(0.362))
        .sub(wymanG(l, 501.1, 0.0490, 0.0382).mul(0.065));
}
function cieY(l) {
    return wymanG(l, 568.8, 0.0213, 0.0247).mul(0.821)
        .add(wymanG(l, 530.9, 0.0613, 0.0322).mul(0.286));
}
function cieZ(l) {
    return wymanG(l, 437.0, 0.0845, 0.0278).mul(1.217)
        .add(wymanG(l, 459.0, 0.0385, 0.0725).mul(0.681));
}

// Linear RGB → scalar reflectance at λ via a smooth 3-bin spectrum
// (blue→green→red). Cheap and good enough for averaged color.
function rgbToSpectral(rgbNode, lambda) {
    const t = clamp(lambda.sub(LAMBDA_MIN).div(LAMBDA_RANGE), 0.0, 1.0);
    const lo = mix(rgbNode.z, rgbNode.y, clamp(t.mul(2.0), 0.0, 1.0));
    const hi = mix(rgbNode.y, rgbNode.x, clamp(t.sub(0.5).mul(2.0), 0.0, 1.0));
    return select(t.lessThan(0.5), lo, hi);
}

export function buildKernels({
    THREE, buffers, env, lut = null, lutRes = 0, maps = {}, width, height,
}) {
    // Storage nodes
    const bvhNodes = storage(buffers.bvhNodes, 'uint', buffers.bvhNodes.count);
    const triIndex = storage(buffers.triIndex, 'uint', buffers.triIndex.count);
    // Interleaved per-vertex: [px,py,pz, nx,ny,nz, u,v] (stride 8) — packed to
    // stay within the 8 storage-buffer budget.
    const vertexData = storage(buffers.vertexData, 'float', buffers.vertexData.count);
    const triMaterial = storage(buffers.triMaterial, 'uint', buffers.triMaterial.count);
    const materials = storage(buffers.materials, 'float', buffers.materials.count);
    const lights = storage(buffers.lights, 'float', buffers.lights.count);
    const accum = storage(buffers.accum, 'float', buffers.accum.count);

    // Uniforms (driven each frame by the tracer)
    const U = {
        camWorld: uniform(new THREE.Matrix4()),
        camProjInv: uniform(new THREE.Matrix4()),
        camPos: uniform(new THREE.Vector3()),
        resolution: uniform(new THREE.Vector2(width, height)),
        frameSeed: uniform(0, 'uint'),
        sampleCount: uniform(1),
        bounceCap: uniform(4, 'uint'),
        rrStart: uniform(2, 'uint'),
        radianceClamp: uniform(8.0),
        envIntensity: uniform(1.0),
        envRotation: uniform(0.0),
        hasEnv: uniform(env ? 1 : 0, 'uint'),
        lightCount: uniform(buffers.lightCount >>> 0, 'uint'),
        nodeCount: uniform(buffers.nodeCount >>> 0, 'uint'),
        exposure: uniform(1.0),
        // Thin-lens depth of field. apertureRadius 0 = pinhole (DOF off).
        apertureRadius: uniform(0.0),
        focusDistance: uniform(5.0),
        // 1 = tone-map + sRGB encode in the blit (direct-to-canvas);
        // 0 = emit LINEAR HDR for an external post stack to tone-map.
        toneMapEnabled: uniform(1, 'uint'),
    };

    const W = U.resolution.x;
    const H = U.resolution.y;

    // ── helpers (graph emitters) ───────────────────────────────────
    const VSTRIDE = uint(8);
    const fetchVert = (vid) => {
        const b = vid.mul(VSTRIDE);
        return vec3(vertexData.element(b), vertexData.element(b.add(uint(1))), vertexData.element(b.add(uint(2))));
    };
    const fetchNorm = (vid) => {
        const b = vid.mul(VSTRIDE).add(uint(3));
        return vec3(vertexData.element(b), vertexData.element(b.add(uint(1))), vertexData.element(b.add(uint(2))));
    };
    const fetchUV = (vid) => {
        const b = vid.mul(VSTRIDE).add(uint(6));
        return vec2(vertexData.element(b), vertexData.element(b.add(uint(1))));
    };
    const triVert = (triId, k) => triIndex.element(triId.mul(uint(3)).add(uint(k)));
    const matFloat = (matId, k) => materials.element(matId.mul(uint(24)).add(uint(k)));

    // ── PBR map array textures ─────────────────────────────────────
    // One DataArrayTexture per map type; null when no material binds that type
    // (we never reference an absent texture, so its GPU binding is never
    // created). Layer index lives in the material record; −1 = unmapped.
    const albedoTex = maps.albedo || null;
    const normalTex = maps.normal || null;
    const roughTex = maps.roughness || null;
    const metalTex = maps.metalness || null;
    const emissiveTex = maps.emissive || null;
    const haveAlbedoMap = !!albedoTex;
    const haveNormalMap = !!normalTex;
    const haveRoughMap = !!roughTex;
    const haveMetalMap = !!metalTex;
    const haveEmissiveMap = !!emissiveTex;

    // sRGB → linear (exact piecewise), component-wise. Colour maps (albedo,
    // emissive) are stored as raw sRGB bytes; data maps are already linear.
    const srgbToLinear = (c) => select(
        c.lessThanEqual(vec3(0.04045)),
        c.div(12.92),
        pow(max(c.add(0.055).div(1.055), vec3(0)), vec3(2.4)),
    );
    // Sample a map-array layer at the transformed UV. layerF is the material's
    // stored layer float (−1 = none); we clamp to 0 for the fetch and let the
    // caller gate on `useLayer` so an unmapped material ignores the result.
    const sampleLayer = (tex, uv, layerF) =>
        texture(tex, uv).depth(int(max(layerF, float(0)))).xyz;

    // PCG integer finalizer (full avalanche) — used to derive a well-mixed
    // initial state from (pixel, frame). The OLD seed `(pix ^ frameSeed)*prime`
    // only perturbed the low bits with frameSeed, so a pixel's mean over the
    // accumulated frames was dominated by its high bits (= its row) → each row
    // converged to a biased wavelength tint → horizontal colored banding.
    const pcgHash = (x) => {
        const st = x.mul(uint(747796405)).add(uint(2891336453));
        const word = st.shiftRight(st.shiftRight(uint(28)).add(uint(4))).bitXor(st).mul(uint(277803737));
        return word.shiftRight(uint(22)).bitXor(word);
    };

    // PCG-style RNG over a uint var; returns float in [0,1) and advances state.
    const rngState = { node: null };
    const nextRand = () => {
        const s = rngState.node;
        const ns = s.mul(uint(747796405)).add(uint(2891336453));
        s.assign(ns);
        const word = ns.shiftRight(ns.shiftRight(uint(28)).add(uint(4))).bitXor(ns).mul(uint(277803737));
        const res = word.shiftRight(uint(22)).bitXor(word);
        return float(res).mul(INV_U32);
    };

    // ── Jakob–Hanika RGB → reflectance upsampling ──────────────────
    // Fetch the (c0,c1,c2) triple from the precomputed LUT (3 argmax slabs,
    // uniform grid → hardware trilinear), then s(λ)=0.5+0.5·x/√(1+x²) with x a
    // quadratic in the wavelength remapped to [0,1] over the band. Reflectance
    // is bounded [0,1]; emission upsamples the unit-chroma and scales by
    // brightness so coloured lights/HDRI keep their hue but any intensity.
    const haveLut = !!(lut && lut.length === 3 && lutRes > 1);
    const LUTN = float(lutRes || 2);
    const lutUV = (g) => clamp(g, 0.0, 1.0).mul(LUTN.sub(1)).add(0.5).div(LUTN);
    const jhCoeffs = (rgb) => {
        const r = rgb.x, g = rgb.y, b = rgb.z;
        const fetch = (lt, zc, a, c) => {
            const z = max(zc, float(1e-4));
            return texture3D(lt, vec3(lutUV(a.div(z)), lutUV(c.div(z)), lutUV(clamp(zc, 0.0, 1.0)))).xyz;
        };
        const c0 = fetch(lut[0], r, g, b); // r is max: x=g/z, y=b/z
        const c1 = fetch(lut[1], g, b, r); // g is max: x=b/z, y=r/z
        const c2 = fetch(lut[2], b, r, g); // b is max: x=r/z, y=g/z
        const isB = b.greaterThanEqual(g).and(b.greaterThanEqual(r));
        const isG = g.greaterThanEqual(r);
        return select(isB, c2, select(isG, c1, c0));
    };
    const jhEval = (c, lambda) => {
        const Ln = clamp(lambda.sub(LAMBDA_MIN).div(LAMBDA_RANGE), 0.0, 1.0);
        const x = c.x.mul(Ln).add(c.y).mul(Ln).add(c.z);
        return float(0.5).add(x.mul(0.5).div(sqrt(x.mul(x).add(1.0))));
    };
    const jhReflectance = haveLut
        ? (rgb, lambda) => jhEval(jhCoeffs(clamp(rgb, 0.0, 1.0)), lambda)
        : (rgb, lambda) => rgbToSpectral(rgb, lambda);
    const jhEmission = haveLut
        ? (rgb, lambda) => {
            const m = max(max(rgb.x, rgb.y), rgb.z);
            return jhReflectance(rgb.div(max(m, float(1e-6))), lambda).mul(m);
        }
        : (rgb, lambda) => rgbToSpectral(rgb, lambda);

    // env radiance at λ for a world direction (or sky fallback)
    const envAtLambda = (dir, lambda) => {
        const out = float(0).toVar();
        if (env) {
            // rotate dir around Y by envRotation
            const cr = cos(U.envRotation), sr = sin(U.envRotation);
            const rdir = vec3(
                dir.x.mul(cr).sub(dir.z.mul(sr)),
                dir.y,
                dir.x.mul(sr).add(dir.z.mul(cr)),
            );
            const uv = equirectUV(normalize(rdir));
            // texture() auto-converts from the texture's colorSpace to linear
            // working space (HDR/EXR are already linear), so rgb is linear
            // radiance — same value the rasterizer's IBL feeds on.
            const rgb = texture(env, uv).level(0).xyz.mul(U.envIntensity);
            out.assign(jhEmission(rgb, lambda));
        } else {
            // No sampleable HDRI bound (sky/none/geospatial) — match the raster,
            // which has NO image-based environment light in that state, by
            // emitting black instead of a synthetic blue sky. The old gradient
            // injected an env light the viewport never showed ("always-blue").
            // Sky/geospatial drive scene.environmentNode (a TSL node, not an
            // equirect texture) and are intentionally out of scope here.
            out.assign(float(0));
        }
        return out;
    };

    // ── BVH closest-hit: returns {t, tri, normal} via out-vars ──────
    // Stackless threaded traversal. cursor walks node indices; miss link is
    // the escape. Returns bestT and best triangle id; caller computes normal.
    const traverseClosest = (ro, rd, bestTVar, bestTriVar) => {
        const invD = vec3(float(1).div(rd.x), float(1).div(rd.y), float(1).div(rd.z));
        const cursor = uint(0).toVar();
        Loop({ start: uint(0), end: U.nodeCount, type: 'uint', condition: '<' }, () => {
            If(cursor.greaterThanEqual(U.nodeCount), () => { Break(); });
            const base = cursor.mul(uint(8));
            const bmin = vec3(
                uintBitsToFloat(bvhNodes.element(base)),
                uintBitsToFloat(bvhNodes.element(base.add(uint(1)))),
                uintBitsToFloat(bvhNodes.element(base.add(uint(2)))));
            const bmax = vec3(
                uintBitsToFloat(bvhNodes.element(base.add(uint(3)))),
                uintBitsToFloat(bvhNodes.element(base.add(uint(4)))),
                uintBitsToFloat(bvhNodes.element(base.add(uint(5)))));
            const miss = bvhNodes.element(base.add(uint(6)));
            const payload = bvhNodes.element(base.add(uint(7)));

            // slab test against [0, bestT]
            const t0 = bmin.sub(ro).mul(invD);
            const t1 = bmax.sub(ro).mul(invD);
            const tsmall = min(t0, t1);
            const tbig = max(t0, t1);
            const tNear = max(max(tsmall.x, tsmall.y), tsmall.z);
            const tFar = min(min(tbig.x, tbig.y), tbig.z);

            If(tFar.greaterThanEqual(max(tNear, float(0))).and(tNear.lessThan(bestTVar)), () => {
                If(payload.equal(uint(0xFFFFFFFF)), () => {
                    cursor.assign(cursor.add(uint(1))); // internal → left child (contiguous)
                }).Else(() => {
                    const triOffset = payload.bitAnd(uint(0x00FFFFFF));
                    const triCount = payload.shiftRight(uint(24));
                    Loop({ start: uint(0), end: triCount, type: 'uint', condition: '<' }, ({ i }) => {
                        const triId = triOffset.add(i);
                        const i0 = triVert(triId, 0);
                        const i1 = triVert(triId, 1);
                        const i2 = triVert(triId, 2);
                        const p0 = fetchVert(i0);
                        const p1 = fetchVert(i1);
                        const p2 = fetchVert(i2);
                        const e1 = p1.sub(p0);
                        const e2 = p2.sub(p0);
                        const pv = cross(rd, e2);
                        const det = dot(e1, pv);
                        If(abs(det).greaterThan(float(1e-12)), () => {
                            const invDet = float(1).div(det);
                            const tv = ro.sub(p0);
                            const u = dot(tv, pv).mul(invDet);
                            If(u.greaterThanEqual(float(0)).and(u.lessThanEqual(float(1))), () => {
                                const qv = cross(tv, e1);
                                const vbar = dot(rd, qv).mul(invDet);
                                If(vbar.greaterThanEqual(float(0)).and(u.add(vbar).lessThanEqual(float(1))), () => {
                                    const tHit = dot(e2, qv).mul(invDet);
                                    If(tHit.greaterThan(float(RAY_EPS)).and(tHit.lessThan(bestTVar)), () => {
                                        bestTVar.assign(tHit);
                                        bestTriVar.assign(int(triId));
                                    });
                                });
                            });
                        });
                    });
                    cursor.assign(miss);
                });
            }).Else(() => {
                cursor.assign(miss);
            });
        });
    };

    // any-hit (shadow) traversal: returns 1.0 if blocked within maxDist
    const traverseAny = (ro, rd, maxDist) => {
        const invD = vec3(float(1).div(rd.x), float(1).div(rd.y), float(1).div(rd.z));
        const cursor = uint(0).toVar();
        const blocked = float(0).toVar();
        Loop({ start: uint(0), end: U.nodeCount, type: 'uint', condition: '<' }, () => {
            If(cursor.greaterThanEqual(U.nodeCount).or(blocked.greaterThan(float(0.5))), () => { Break(); });
            const base = cursor.mul(uint(8));
            const bmin = vec3(uintBitsToFloat(bvhNodes.element(base)), uintBitsToFloat(bvhNodes.element(base.add(uint(1)))), uintBitsToFloat(bvhNodes.element(base.add(uint(2)))));
            const bmax = vec3(uintBitsToFloat(bvhNodes.element(base.add(uint(3)))), uintBitsToFloat(bvhNodes.element(base.add(uint(4)))), uintBitsToFloat(bvhNodes.element(base.add(uint(5)))));
            const miss = bvhNodes.element(base.add(uint(6)));
            const payload = bvhNodes.element(base.add(uint(7)));
            const t0 = bmin.sub(ro).mul(invD);
            const t1 = bmax.sub(ro).mul(invD);
            const tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
            const tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
            If(tFar.greaterThanEqual(max(tNear, float(0))).and(tNear.lessThan(maxDist)), () => {
                If(payload.equal(uint(0xFFFFFFFF)), () => {
                    cursor.assign(cursor.add(uint(1)));
                }).Else(() => {
                    const triOffset = payload.bitAnd(uint(0x00FFFFFF));
                    const triCount = payload.shiftRight(uint(24));
                    Loop({ start: uint(0), end: triCount, type: 'uint', condition: '<' }, ({ i }) => {
                        const triId = triOffset.add(i);
                        const p0 = fetchVert(triVert(triId, 0));
                        const p1 = fetchVert(triVert(triId, 1));
                        const p2 = fetchVert(triVert(triId, 2));
                        const e1 = p1.sub(p0); const e2 = p2.sub(p0);
                        const pv = cross(rd, e2); const det = dot(e1, pv);
                        If(abs(det).greaterThan(float(1e-12)), () => {
                            const invDet = float(1).div(det);
                            const tv = ro.sub(p0);
                            const u = dot(tv, pv).mul(invDet);
                            If(u.greaterThanEqual(float(0)).and(u.lessThanEqual(float(1))), () => {
                                const qv = cross(tv, e1);
                                const vb = dot(rd, qv).mul(invDet);
                                If(vb.greaterThanEqual(float(0)).and(u.add(vb).lessThanEqual(float(1))), () => {
                                    const tHit = dot(e2, qv).mul(invDet);
                                    If(tHit.greaterThan(float(RAY_EPS)).and(tHit.lessThan(maxDist)), () => {
                                        // Glass is transparent to shadow rays: a transmissive
                                        // occluder lets direct light pass instead of casting a
                                        // solid shadow. Opaque hits behind it still block. (The
                                        // ray doesn't refract here — true prism caustics come
                                        // from BSDF path sampling against an emissive/env light,
                                        // not from this straight-line NEE occlusion test.)
                                        const occTrans = matFloat(triMaterial.element(triId), 5);
                                        If(occTrans.lessThan(float(0.5)), () => { blocked.assign(float(1)); });
                                    });
                                });
                            });
                        });
                    });
                    cursor.assign(miss);
                });
            }).Else(() => { cursor.assign(miss); });
        });
        return blocked;
    };

    // cosine-weighted hemisphere sample around n
    const cosineSample = (n, r1, r2) => {
        const phi = r1.mul(2 * PI);
        const cosT = sqrt(float(1).sub(r2));
        const sinT = sqrt(r2);
        // build tangent frame
        const a = select(abs(n.y).lessThan(float(0.999)), vec3(0, 1, 0), vec3(1, 0, 0));
        const t = normalize(cross(a, n));
        const b = cross(n, t);
        return normalize(
            t.mul(cos(phi).mul(sinT))
                .add(b.mul(sin(phi).mul(sinT)))
                .add(n.mul(cosT)));
    };

    // ── main trace kernel ──────────────────────────────────────────
    const traceKernel = Fn(() => {
        const pix = instanceIndex.toVar();
        const total = uint(width * height);
        If(pix.greaterThanEqual(total), () => { Return(); });

        // Fully hash both pixel index and frame into the initial RNG state so
        // every pixel samples wavelengths uniformly over the accumulation (no
        // per-row bias). See pcgHash note above.
        rngState.node = pcgHash(pix.bitXor(pcgHash(U.frameSeed))).toVar();

        const px = float(pix.mod(uint(width)));
        const py = float(pix.div(uint(width)));
        const jx = nextRand();
        const jy = nextRand();
        // NDC (-1..1), flip Y so image matches the rasterized camera
        const ndcX = px.add(jx).div(W).mul(2).sub(1);
        const ndcY = float(1).sub(py.add(jy).div(H).mul(2));

        // primary ray from inverse projection * camera world
        const clip = vec4(ndcX, ndcY, float(-1), float(1));
        const viewPos = U.camProjInv.mul(clip);
        const viewDir = vec3(viewPos.x, viewPos.y, viewPos.z).div(viewPos.w);
        const ro = vec3(U.camPos).toVar();
        const rdWorld = U.camWorld.mul(vec4(viewDir, 0)).xyz;
        const rd = normalize(rdWorld).toVar();

        // Thin-lens DOF: jitter the ray origin across the aperture disk and
        // re-aim at the point where the pinhole ray crosses the focal plane.
        // Physically-correct bokeh; converges with the accumulation. Pinhole
        // when apertureRadius == 0. (Uniform branch → consistent RNG draw.)
        If(U.apertureRadius.greaterThan(float(0)), () => {
            const camRight = U.camWorld.mul(vec4(1, 0, 0, 0)).xyz;
            const camUp = U.camWorld.mul(vec4(0, 1, 0, 0)).xyz;
            const camFwd = U.camWorld.mul(vec4(0, 0, -1, 0)).xyz;
            const tFocus = U.focusDistance.div(max(dot(rd, camFwd), float(1e-3)));
            const focusPoint = ro.add(rd.mul(tFocus));
            const ar = sqrt(nextRand()).mul(U.apertureRadius);
            const ang = nextRand().mul(2 * PI);
            const lensOff = camRight.mul(cos(ang).mul(ar)).add(camUp.mul(sin(ang).mul(ar)));
            ro.assign(ro.add(lensOff));
            rd.assign(normalize(focusPoint.sub(ro)));
        });

        const lambda = float(LAMBDA_MIN).add(nextRand().mul(LAMBDA_RANGE)).toVar();
        const throughput = float(1).toVar();
        const radiance = float(0).toVar();

        Loop({ start: uint(0), end: U.bounceCap, type: 'uint', condition: '<' }, ({ i }) => {
            // GI/firefly clamp ("GI Clamp" control): cap each INDIRECT bounce's
            // radiance contribution at radianceClamp. Direct contributions
            // (i==0 — a directly visible emitter/HDRI, or first-hit NEE) stay
            // exact, so only multi-bounce spikes (a bright emitter or HDRI sun
            // reached through a low-probability bounce) get bounded. Clamping
            // the throughput-weighted contribution is what actually suppresses
            // fireflies — clamping throughput alone never fires, since for
            // energy-conserving materials throughput ≤ 1 ≤ radianceClamp.
            const clampGI = (contrib) => select(i.greaterThan(uint(0)), min(contrib, U.radianceClamp), contrib);

            const bestT = float(T_MAX).toVar();
            const bestTri = int(-1).toVar();
            traverseClosest(ro, rd, bestT, bestTri);

            If(bestTri.lessThan(int(0)), () => {
                radiance.addAssign(clampGI(throughput.mul(envAtLambda(rd, lambda))));
                Break();
            });

            const triId = uint(bestTri);
            const matId = triMaterial.element(triId);
            const vi0 = triVert(triId, 0);
            const vi1 = triVert(triId, 1);
            const vi2 = triVert(triId, 2);
            const p0 = fetchVert(vi0);
            const p1 = fetchVert(vi1);
            const p2 = fetchVert(vi2);
            const ngRaw = normalize(cross(p1.sub(p0), p2.sub(p0)));
            const entering = dot(ngRaw, rd).lessThan(float(0));         // front-face hit
            const ng = ngRaw.mul(select(entering, float(1), float(-1))); // geometric, faces ray

            // Smooth shading normal: re-derive the hit barycentrics (Möller-
            // Trumbore) and interpolate the per-vertex normals. Falls back to
            // the geometric normal when no vertex normals were synced (length 0).
            const e1n = p1.sub(p0);
            const e2n = p2.sub(p0);
            const pvn = cross(rd, e2n);
            const invDetN = float(1).div(dot(e1n, pvn));
            const tvn = ro.sub(p0);
            const bU = dot(tvn, pvn).mul(invDetN);
            const bV = dot(rd, cross(tvn, e1n)).mul(invDetN);
            const bW = float(1).sub(bU).sub(bV);
            const nInterp = bW.mul(fetchNorm(vi0)).add(bU.mul(fetchNorm(vi1))).add(bV.mul(fetchNorm(vi2)));
            const nLen = length(nInterp);
            const Ns = select(nLen.greaterThan(float(0.01)), nInterp.div(max(nLen, float(1e-6))), ng).toVar();

            // Interpolated + transformed hit UV — shared by every map sample.
            const uvHit = fetchUV(vi0).mul(bW).add(fetchUV(vi1).mul(bU)).add(fetchUV(vi2).mul(bV));
            const uvRep = vec2(matFloat(matId, 18), matFloat(matId, 19));
            const uvOff = vec2(matFloat(matId, 20), matFloat(matId, 21));
            const uv = uvHit.mul(uvRep).add(uvOff).toVar();

            // Normal map: perturb Ns in a UV-derived tangent frame (applied
            // before the face-flip so back-faces are corrected post-perturbation).
            if (haveNormalMap) {
                const nmL = matFloat(matId, 13);
                If(nmL.greaterThan(float(-0.5)), () => {
                    const duv1 = fetchUV(vi1).sub(fetchUV(vi0));
                    const duv2 = fetchUV(vi2).sub(fetchUV(vi0));
                    const denom = duv1.x.mul(duv2.y).sub(duv2.x.mul(duv1.y));
                    If(abs(denom).greaterThan(float(1e-10)), () => {
                        const r = float(1).div(denom);
                        const tRaw = e1n.mul(duv2.y).sub(e2n.mul(duv1.y)).mul(r);
                        // Gram-Schmidt T against Ns; bitangent from the cross.
                        const T = normalize(tRaw.sub(Ns.mul(dot(Ns, tRaw))));
                        const B = cross(Ns, T);
                        const ns = matFloat(matId, 17);
                        const tn = sampleLayer(normalTex, uv, nmL).mul(2).sub(1); // [0,1]→[-1,1]
                        const perturbed = T.mul(tn.x.mul(ns)).add(B.mul(tn.y.mul(ns))).add(Ns.mul(tn.z));
                        Ns.assign(normalize(perturbed));
                    });
                });
            }
            // keep the shading normal on the geometric side that faces the ray
            Ns.assign(Ns.mul(select(dot(Ns, ng).lessThan(float(0)), float(-1), float(1))));

            const hitPoint = ro.add(rd.mul(bestT));
            const hitPos = hitPoint.add(ng.mul(float(RAY_EPS)));        // +ng offset for NEE

            // material fields (scalar PBR × optional maps sampled at the hit UV)
            const baseColor = vec3(matFloat(matId, 0), matFloat(matId, 1), matFloat(matId, 2)).toVar();
            const roughness = matFloat(matId, 3).toVar();
            const metalness = matFloat(matId, 4).toVar();
            const transmission = matFloat(matId, 5);
            const ior = matFloat(matId, 6);
            const emissive = vec3(matFloat(matId, 7), matFloat(matId, 8), matFloat(matId, 9)).toVar();
            const dispersionB = matFloat(matId, 11);

            // map mul-semantics mirror three (diffuse*=map, rough*=g, metal*=b,
            // emissive*=map); −1 layer → multiply by 1 (no-op).
            if (haveAlbedoMap) {
                const aL = matFloat(matId, 12);
                const s = srgbToLinear(sampleLayer(albedoTex, uv, aL));
                baseColor.assign(baseColor.mul(select(aL.greaterThan(float(-0.5)), s, vec3(1))));
            }
            if (haveRoughMap) {
                const rL = matFloat(matId, 14);
                const s = sampleLayer(roughTex, uv, rL).y; // green channel (glTF metallic-roughness)
                roughness.assign(roughness.mul(select(rL.greaterThan(float(-0.5)), s, float(1))));
            }
            if (haveMetalMap) {
                const mL = matFloat(matId, 15);
                const s = sampleLayer(metalTex, uv, mL).z; // blue channel (glTF metallic-roughness)
                metalness.assign(metalness.mul(select(mL.greaterThan(float(-0.5)), s, float(1))));
            }
            if (haveEmissiveMap) {
                const eL = matFloat(matId, 16);
                const s = srgbToLinear(sampleLayer(emissiveTex, uv, eL));
                emissive.assign(emissive.mul(select(eL.greaterThan(float(-0.5)), s, vec3(1))));
            }
            roughness.assign(clamp(roughness, float(0.02), float(1)));
            metalness.assign(clamp(metalness, float(0), float(1)));

            const isGlass = transmission.greaterThan(float(0.5));
            const notGlass = select(isGlass, float(0), float(1));

            // emissive contribution at λ
            radiance.addAssign(clampGI(throughput.mul(jhEmission(emissive, lambda))));

            const albedoL = jhReflectance(baseColor, lambda);

            // NEE: one light sample (diffuse only — fast). Mirrors the raster
            // punctual-light model (three getDistanceAttenuation +
            // getSpotAttenuation) so spot cones, decay and range agree with the
            // viewport. Reference: web/js/max_lights_node.js Masked*LightDataNode.
            If(U.lightCount.greaterThan(uint(0)), () => {
                const li = uint(min(float(U.lightCount).sub(1), floor(nextRand().mul(float(U.lightCount)))));
                const lb = li.mul(uint(16));
                const ltype = lights.element(lb);
                const lpos = vec3(lights.element(lb.add(uint(1))), lights.element(lb.add(uint(2))), lights.element(lb.add(uint(3))));
                const ldir = vec3(lights.element(lb.add(uint(4))), lights.element(lb.add(uint(5))), lights.element(lb.add(uint(6))));
                const lcol = vec3(lights.element(lb.add(uint(7))), lights.element(lb.add(uint(8))), lights.element(lb.add(uint(9))));
                const lrange = lights.element(lb.add(uint(10)));
                const ldecay = lights.element(lb.add(uint(11)));
                const lcosAngle = lights.element(lb.add(uint(12)));
                const lcosPen = lights.element(lb.add(uint(13)));

                // type: 0 directional, 1 point, 2 spot. ldir is the beam forward
                // (normalize(target-pos)); three's spotDirection is its negation.
                const isDir = ltype.lessThan(float(0.5));
                const isSpot = abs(ltype.sub(float(2))).lessThan(float(0.5));
                const toLight = select(isDir, ldir.mul(-1), lpos.sub(hitPos));
                const dist = select(isDir, float(1e4), max(length(toLight), float(1e-4)));
                const wi = normalize(toLight);
                const ndl = max(dot(Ns, wi), float(0));
                If(ndl.greaterThan(float(0)), () => {
                    const blocked = traverseAny(hitPos, wi, dist.sub(float(RAY_EPS)));
                    If(blocked.lessThan(float(0.5)), () => {
                        // distance attenuation — three getDistanceAttenuation:
                        // 1/max(dist^decay, 0.01), windowed by (1-(dist/range)^4)^2
                        // when range>0. Directional lights take no distance falloff.
                        const falloff = float(1).div(max(pow(dist, ldecay), float(0.01)));
                        const rr = dist.div(max(lrange, float(1e-4)));
                        const rr2 = rr.mul(rr);
                        const win = clamp(float(1).sub(rr2.mul(rr2)), float(0), float(1));
                        const ranged = falloff.mul(win.mul(win));
                        const posAtten = select(lrange.greaterThan(float(0)), ranged, falloff);
                        const distAtten = select(isDir, float(1), posAtten);
                        // spot cone — three getSpotAttenuation:
                        // smoothstep(coneCos, penumbraCos, dot(lightDir, spotDir)).
                        // angleCos = dot(wi, spotDir) = -dot(wi, ldir).
                        const angleCos = dot(wi, ldir).mul(-1);
                        const spotAtten = smoothstep(lcosAngle, lcosPen, angleCos);
                        const atten = distAtten.mul(select(isSpot, spotAtten, float(1)));
                        const lrad = jhEmission(lcol, lambda).mul(atten);
                        const diffuse = albedoL.mul(float(1).sub(metalness)).mul(1.0 / PI);
                        // glass is specular — skip the diffuse direct-light term for it
                        radiance.addAssign(clampGI(throughput.mul(diffuse).mul(ndl).mul(lrad).mul(float(U.lightCount)).mul(notGlass)));
                    });
                });
            });

            // Russian roulette after rrStart bounces
            If(i.greaterThanEqual(U.rrStart), () => {
                const pSurv = clamp(throughput, float(0.05), float(1));
                If(nextRand().greaterThan(pSurv), () => { Break(); });
                throughput.assign(throughput.div(pSurv));
            });

            // ── opaque BSDF: metal = rough mirror, else cosine diffuse ──
            const doMetal = nextRand().lessThan(metalness);
            const diffuseDir = cosineSample(Ns, nextRand(), nextRand());
            const mirror = reflect(rd, Ns);
            const glossy = normalize(mirror.add(cosineSample(Ns, nextRand(), nextRand()).sub(Ns).mul(roughness)));
            const opaqueDir = select(doMetal, glossy, diffuseDir);

            // ── dielectric (glass) BSDF with WAVELENGTH-DEPENDENT IOR ──
            // n(λ): shorter wavelengths refract more (normal dispersion), so a
            // prism fans white light into a spectrum. This is the path's
            // wavelength driving GEOMETRY (Snell), not just the final color.
            const nLambda = ior.add(dispersionB.mul(float(550).sub(lambda)).div(float(170)));
            // Reflect/refract against the smooth shading normal Ns (same as the
            // opaque lobe) so curved glass bends light smoothly instead of per
            // triangle facet. entering/eta stay on the geometric normal — which
            // medium we're crossing into is topological, and Ns can lie about it.
            const eta = select(entering, float(1).div(nLambda), nLambda);   // n_in / n_out
            const cosI = clamp(dot(rd, Ns).mul(float(-1)), float(0), float(1));
            const sin2T = eta.mul(eta).mul(float(1).sub(cosI.mul(cosI)));
            const tir = sin2T.greaterThan(float(1));                        // total internal reflection
            const cosT = sqrt(max(float(0), float(1).sub(sin2T)));
            const r0 = nLambda.sub(float(1)).div(nLambda.add(float(1)));
            const R0 = r0.mul(r0);
            const fcos = select(entering, cosI, cosT);                     // cosine in the denser medium
            const om = float(1).sub(fcos);
            const fres = R0.add(float(1).sub(R0).mul(om.mul(om).mul(om).mul(om).mul(om)));
            const refractDir = normalize(rd.mul(eta).add(Ns.mul(eta.mul(cosI).sub(cosT))));
            const reflectDir = reflect(rd, Ns);
            const doReflect = tir.or(nextRand().lessThan(fres));           // Fresnel importance sample
            const glassDir = select(doReflect, reflectDir, refractDir);

            // pick lobe; glass is clear (weight 1, Fresnel already sampled)
            const newDir = select(isGlass, glassDir, opaqueDir);
            const throughputMul = select(isGlass, float(1), albedoL);
            // GI Clamp now bounds radiance contributions (see clampGI above);
            // throughput just carries the path weight (≤1 for physical BSDFs).
            throughput.assign(throughput.mul(throughputMul));

            // offset the next ray's origin onto whichever side it actually leaves
            const sideN = ng.mul(select(dot(newDir, ng).greaterThan(float(0)), float(1), float(-1)));
            ro.assign(hitPoint.add(sideN.mul(float(RAY_EPS))));
            rd.assign(normalize(newDir));
        });

        // hero λ radiance → XYZ. ×LAMBDA_RANGE undoes the uniform pdf (1/range);
        // ÷CIE_Y_INTEGRAL normalizes luminance so unit radiance → Y≈1.
        const w = LAMBDA_RANGE / CIE_Y_INTEGRAL;
        const X = cieX(lambda).mul(radiance).mul(w);
        const Y = cieY(lambda).mul(radiance).mul(w);
        const Z = cieZ(lambda).mul(radiance).mul(w);

        const o = pix.mul(uint(4));
        accum.element(o).addAssign(X);
        accum.element(o.add(uint(1))).addAssign(Y);
        accum.element(o.add(uint(2))).addAssign(Z);
    })().compute(width * height);

    // clear kernel (reset accumulation)
    const clearKernel = Fn(() => {
        const pix = instanceIndex.toVar();
        const total = uint(width * height);
        If(pix.greaterThanEqual(total), () => { Return(); });
        const o = pix.mul(uint(4));
        accum.element(o).assign(float(0));
        accum.element(o.add(uint(1))).assign(float(0));
        accum.element(o.add(uint(2))).assign(float(0));
        accum.element(o.add(uint(3))).assign(float(0));
    })().compute(width * height);

    // ── blit material: XYZ accum → sRGB ────────────────────────────
    const blitMaterial = new THREE.MeshBasicNodeMaterial();
    blitMaterial.depthTest = false;
    blitMaterial.depthWrite = false;
    // The blit owns its tone map (neutralToneMapping when toneMapEnabled, else
    // linear pass-through for an external post stack). The renderer must not
    // apply its own on top — true would double-tone-map the direct path and
    // corrupt the linear handoff into the post pipeline.
    blitMaterial.toneMapped = false;
    blitMaterial.colorNode = Fn(() => {
        const sc = TSL.screenCoordinate;
        const ix = uint(sc.x);
        const iy = uint(sc.y);
        const idx = iy.mul(uint(width)).add(ix);
        const o = idx.mul(uint(4));
        const xyz = vec3(accum.element(o), accum.element(o.add(uint(1))), accum.element(o.add(uint(2))));
        const inv = float(1).div(max(U.sampleCount, float(1)));
        const c = xyz.mul(inv);
        // XYZ (D65) → linear sRGB
        const rgb = vec3(
            c.x.mul(3.2406).sub(c.y.mul(1.5372)).sub(c.z.mul(0.4986)),
            c.x.mul(-0.9689).add(c.y.mul(1.8758)).add(c.z.mul(0.0415)),
            c.x.mul(0.0557).sub(c.y.mul(0.2040)).add(c.z.mul(1.0570)),
        );
        // neutralToneMapping is Fn([color, exposure]) — BOTH inputs are
        // required; omitting exposure makes it multiply by an undefined node
        // and the whole blit resolves to NaN (black screen).
        const lin = max(rgb, vec3(0));
        // Direct-to-canvas: exposure + neutral tone map (display-referred).
        // External post stack: emit LINEAR HDR (exposure only) and let the
        // stack's bloom/grade run in linear before it tone-maps at output.
        const tone = TSL.neutralToneMapping(lin, U.exposure);
        const out = select(U.toneMapEnabled.equal(uint(1)), tone, lin.mul(U.exposure));
        return vec4(out, 1);
    })();

    return { traceKernel, clearKernel, blitMaterial, uniforms: U };
}

export { LAMBDA_MIN, LAMBDA_MAX };
