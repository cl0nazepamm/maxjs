// material_builder.js — simple PBR material factory for snapshot mode.
//
// Stage 5 deliverable from docs/SNAPSHOT_REFACTOR.md.
//
// Live mode in web/index.html runs a 1500+ line `createMaterial` that
// covers MeshTSLNodeMaterial, MaterialX (with async loading), VRay,
// OpenPBR, Toon, SSS, Backdrop, HTMLTextureOverride, baked specials,
// and per-renderer-backend optimizations. That belongs in its own
// module and a much later stage.
//
// This stage targets the common case: standard PBR materials with the
// base maps that snapshots realistically ship. Anything more exotic
// gracefully degrades to MeshStandardMaterial with the base color and
// PBR scalars honored, so the mesh still looks plausible.
//
// Supported (per material descriptor `md`):
//   - color [r,g,b]                    → params.color
//   - rough / metal / envI scalars     → roughness / metalness / envMapIntensity
//   - opacity (< 0.999)                → transparent + opacity
//   - side (0 = front, !=0 = double)   → THREE.FrontSide / DoubleSide
//   - emissive [r,g,b] / emissiveI     → emissive + emissiveIntensity
//   - alphaTest                        → params.alphaTest
//   - Texture maps:
//       diffMap → map (SRGB)
//       normMap → normalMap (Linear)
//       roughMap → roughnessMap (Linear)
//       metalMap → metalnessMap (Linear)
//       aoMap → aoMap (Linear)
//       emisMap → emissiveMap (SRGB)
//
// Multi/sub-object: `nd.mats[]` + `nd.groups[]` → array of materials.
//
// NOT covered (deferred):
//   - TSL / MaterialX / VRay / OpenPBR / Toon / SSS routes
//   - Texture transforms (xf), channel selection, EXR/HDR, video
//   - Specular intensity / color, clearcoat, sheen, iridescence, transmission
//   - Bake mode overrides
//   - Material-template caching (per-snapshot textureCache only)

import * as THREE from 'three/webgpu';
import * as THREE_STD from 'three-std';

const FALLBACK_COLOR = 0x888888;

function colorFromArray(rgb, fallback = FALLBACK_COLOR) {
    if (Array.isArray(rgb) && rgb.length >= 3) {
        return new THREE.Color(rgb[0], rgb[1], rgb[2]);
    }
    return new THREE.Color(fallback);
}

function pickSide(md) {
    return md?.side === 0 ? THREE.FrontSide : THREE.DoubleSide;
}

/**
 * Creates a material-builder instance tied to a snapshot root URL.
 * Owns its own texture cache so re-applies don't refetch.
 *
 * Usage:
 *   const mb = createMaterialBuilder({ rootUrl: '.' });
 *   const mat = mb.buildForNode({ nd, geom, wantsLine });
 *   mb.dispose();
 */
export function createMaterialBuilder({ rootUrl = '.' } = {}) {
    const loader = new THREE_STD.TextureLoader();
    const textureCache = new Map(); // `${url}::${colorSpace}` → THREE.Texture

    // Resolve URL relative to the snapshot root so absolute paths and
    // relative paths both work.
    function resolveUrl(url) {
        try {
            return new URL(url, new URL(`${rootUrl}/`, location.href)).href;
        } catch {
            return url;
        }
    }

    function loadTex(url, colorSpace = THREE.LinearSRGBColorSpace) {
        if (!url) return null;
        const resolved = resolveUrl(url);
        const key = `${resolved}::${colorSpace}`;
        if (textureCache.has(key)) return textureCache.get(key);

        const tex = loader.load(
            resolved,
            (loaded) => { loaded.colorSpace = colorSpace; loaded.needsUpdate = true; },
            undefined,
            (err) => console.warn('[material_builder] texture load failed:', resolved, err),
        );
        tex.colorSpace = colorSpace;
        textureCache.set(key, tex);
        return tex;
    }

    function buildPbr(md) {
        if (!md) return new THREE.MeshStandardMaterial({ color: FALLBACK_COLOR, side: THREE.DoubleSide });

        const params = {
            color: colorFromArray(md.color),
            side: pickSide(md),
            roughness: Number.isFinite(md.rough) ? md.rough : 0.5,
            metalness: Number.isFinite(md.metal) ? md.metal : 0.0,
            envMapIntensity: Number.isFinite(md.envI) ? md.envI : 1.0,
        };

        if (md.opacity != null && md.opacity < 0.999) {
            params.transparent = true;
            params.opacity = md.opacity;
        }
        if (Number.isFinite(md.alphaTest) && md.alphaTest > 0) {
            params.alphaTest = md.alphaTest;
        }

        if (Array.isArray(md.emissive)) {
            params.emissive = colorFromArray(md.emissive, 0x000000);
        }
        if (Number.isFinite(md.emissiveI)) {
            params.emissiveIntensity = md.emissiveI;
        }

        // Texture maps. SRGB for color/emissive, linear for everything else.
        const diffuse = loadTex(md.diffMap, THREE.SRGBColorSpace);
        if (diffuse) params.map = diffuse;
        const normal = loadTex(md.normMap, THREE.LinearSRGBColorSpace);
        if (normal) params.normalMap = normal;
        const roughness = loadTex(md.roughMap, THREE.LinearSRGBColorSpace);
        if (roughness) params.roughnessMap = roughness;
        const metalness = loadTex(md.metalMap, THREE.LinearSRGBColorSpace);
        if (metalness) params.metalnessMap = metalness;
        const ao = loadTex(md.aoMap, THREE.LinearSRGBColorSpace);
        if (ao) params.aoMap = ao;
        const emissiveMap = loadTex(md.emisMap, THREE.SRGBColorSpace);
        if (emissiveMap) {
            params.emissiveMap = emissiveMap;
            // If emissive color wasn't set but emissiveMap is, default emissive to white
            // so the map actually contributes (otherwise emissive=black multiplies it out).
            if (!params.emissive) params.emissive = new THREE.Color(0xffffff);
        }

        const material = new THREE.MeshStandardMaterial(params);
        if (md.name) material.name = md.name;
        material.userData ??= {};
        material.userData.maxjsSourceMaterialName = md.name ?? 'pbr';
        material.userData.maxjsRequestedMaterialModel = md.model ?? 'MeshStandardMaterial';
        return material;
    }

    function buildLine(md) {
        const color = md ? colorFromArray(md.color) : new THREE.Color(FALLBACK_COLOR);
        return new THREE.LineBasicMaterial({ color });
    }

    /**
     * Hook target for `js/scene_applier.js`. Returns either a single
     * Material or an array (multi/sub).
     */
    function buildForNode({ nd, wantsLine }) {
        if (wantsLine) return buildLine(nd?.mat);
        if (nd?.mats?.length && nd?.groups?.length) {
            return nd.mats.map((m) => buildPbr(m));
        }
        return buildPbr(nd?.mat);
    }

    /**
     * Hook target for incremental updates. Stage 5 always rebuilds — caller
     * decides when to dispose. Returning `false` here tells the applier
     * "no material change" so meshes built with the same descriptor are
     * left alone.
     */
    function shouldUpdate({ mesh, nd }) {
        const existingSig = mesh?.userData?.maxjsMaterialSignature;
        const nextSig = signature(nd);
        if (existingSig === nextSig) return false;
        if (mesh) {
            mesh.userData ??= {};
            mesh.userData.maxjsMaterialSignature = nextSig;
        }
        return true;
    }

    function signature(nd) {
        if (!nd) return 'default';
        if (nd.mats?.length && nd.groups?.length) {
            return 'multi:' + JSON.stringify(nd.mats.map(materialIdentity));
        }
        return 'single:' + JSON.stringify(materialIdentity(nd.mat));
    }

    function materialIdentity(md) {
        if (!md) return null;
        // Compact identity that captures fields we map. Keeps caches stable
        // across re-applies while detecting genuine material edits.
        return {
            n: md.name,
            m: md.model,
            c: md.color,
            r: md.rough, mt: md.metal, e: md.envI, op: md.opacity,
            s: md.side, em: md.emissive, ei: md.emissiveI, at: md.alphaTest,
            d: md.diffMap, nm: md.normMap, rm: md.roughMap, mm: md.metalMap,
            ao: md.aoMap, emm: md.emisMap,
        };
    }

    function dispose() {
        for (const tex of textureCache.values()) tex?.dispose?.();
        textureCache.clear();
    }

    return { buildForNode, shouldUpdate, loadTex, textureCache, dispose };
}
