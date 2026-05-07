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
//   - MeshPhysicalMaterial scalars     → physical PBR fields when model asks for it
//   - Texture maps:
//       map / diffMap → map (SRGB)
//       normMap → normalMap (Linear)
//       roughMap → roughnessMap (Linear)
//       metalMap → metalnessMap (Linear)
//       aoMap → aoMap (Linear)
//       bumpMap → bumpMap (Linear)
//       alphaMap → alphaMap (Linear)
//       emisMap / emissiveMap → emissiveMap (SRGB)
//
// Multi/sub-object: `nd.mats[]` + `nd.groups[]` → array of materials.
//
// NOT covered (deferred):
//   - TSL / MaterialX / VRay / OpenPBR / Toon / SSS routes
//   - Channel selection, EXR/HDR, video
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

function isPhysicalMaterial(md) {
    return typeof md?.model === 'string' && md.model.includes('Physical');
}

function setNumber(target, key, value) {
    if (Number.isFinite(value)) target[key] = value;
}

function firstString(...values) {
    return values.find(value => typeof value === 'string' && value.length > 0) ?? null;
}

function applyTextureTransform(tex, xf) {
    if (!tex || !xf || typeof xf !== 'object') return tex;
    const tiling = Array.isArray(xf.tiling) ? xf.tiling : null;
    const offset = Array.isArray(xf.offset) ? xf.offset : null;
    const center = Array.isArray(xf.center) ? xf.center : null;
    if (tiling?.length >= 2) tex.repeat.set(tiling[0], tiling[1]);
    if (offset?.length >= 2) tex.offset.set(offset[0], offset[1]);
    if (center?.length >= 2) tex.center.set(center[0], center[1]);
    if (Number.isFinite(xf.rotate)) tex.rotation = xf.rotate;
    const wrap = String(xf.wrap ?? '').toLowerCase();
    if (wrap === 'clamp') {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
    } else if (wrap === 'mirror' || wrap === 'mirrored') {
        tex.wrapS = THREE.MirroredRepeatWrapping;
        tex.wrapT = THREE.MirroredRepeatWrapping;
    } else if (wrap || tiling || offset || center || Number.isFinite(xf.rotate)) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
    }
    tex.needsUpdate = true;
    return tex;
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
    const textureCache = new Map(); // `${url}::${colorSpace}::${xf}` → texture entry

    // Resolve URL relative to the snapshot root so absolute paths and
    // relative paths both work.
    function resolveUrl(url) {
        try {
            return new URL(url, new URL(`${rootUrl}/`, location.href)).href;
        } catch {
            return url;
        }
    }

    function loadTextureEntry(url, colorSpace = THREE.LinearSRGBColorSpace, xf = null) {
        if (!url) return null;
        const resolved = resolveUrl(url);
        const xfKey = xf ? JSON.stringify({
            tiling: xf.tiling,
            offset: xf.offset,
            center: xf.center,
            rotate: xf.rotate,
            wrap: xf.wrap,
        }) : '';
        const key = `${resolved}::${colorSpace}::${xfKey}`;
        if (textureCache.has(key)) return textureCache.get(key);

        const entry = {
            texture: null,
            loaded: false,
            callbacks: [],
        };
        textureCache.set(key, entry);

        const tex = loader.load(
            resolved,
            (loaded) => {
                loaded.colorSpace = colorSpace;
                applyTextureTransform(loaded, xf);
                loaded.needsUpdate = true;
                entry.texture = loaded;
                entry.loaded = true;
                const callbacks = entry.callbacks.splice(0);
                for (const callback of callbacks) callback(loaded);
            },
            undefined,
            (err) => {
                entry.error = err;
                entry.callbacks.splice(0);
                console.warn('[material_builder] texture load failed:', resolved, err);
            },
        );
        tex.colorSpace = colorSpace;
        applyTextureTransform(tex, xf);
        entry.texture = tex;
        return entry;
    }

    function loadTex(url, colorSpace = THREE.LinearSRGBColorSpace, xf = null) {
        return loadTextureEntry(url, colorSpace, xf)?.texture ?? null;
    }

    function bindTexture(material, property, url, colorSpace, xf = null, onAssign = null) {
        const entry = loadTextureEntry(url, colorSpace, xf);
        if (!entry) return false;

        const assign = (tex) => {
            material[property] = tex;
            onAssign?.(material, tex);
            material.needsUpdate = true;
        };

        if (entry.loaded && entry.texture?.image) {
            assign(entry.texture);
        } else {
            entry.callbacks.push(assign);
        }
        return true;
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
        if (Number.isFinite(md.aoI)) params.aoMapIntensity = md.aoI;
        if (Number.isFinite(md.lmI)) params.lightMapIntensity = md.lmI;
        if (Number.isFinite(md.normScl)) {
            params.normalScale = new THREE.Vector2(md.normScl, md.normScl);
        }

        const MaterialCtor = isPhysicalMaterial(md) ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
        if (MaterialCtor === THREE.MeshPhysicalMaterial) {
            setNumber(params, 'specularIntensity', md.specularIntensity);
            if (Array.isArray(md.specularColor)) params.specularColor = colorFromArray(md.specularColor, 0xffffff);
            setNumber(params, 'clearcoat', md.clearcoat);
            setNumber(params, 'clearcoatRoughness', md.clearcoatRoughness);
            setNumber(params, 'sheen', md.sheen);
            setNumber(params, 'sheenRoughness', md.sheenRoughness);
            if (Array.isArray(md.sheenColor)) params.sheenColor = colorFromArray(md.sheenColor, 0xffffff);
            setNumber(params, 'iridescence', md.iridescence);
            setNumber(params, 'iridescenceIOR', md.iridescenceIOR);
            setNumber(params, 'transmission', md.transmission);
            setNumber(params, 'ior', md.ior);
            setNumber(params, 'reflectivity', md.reflectivity);
            setNumber(params, 'thickness', md.thickness);
            setNumber(params, 'dispersion', md.dispersion);
            if (Array.isArray(md.attenuationColor)) params.attenuationColor = colorFromArray(md.attenuationColor, 0xffffff);
            setNumber(params, 'attenuationDistance', md.attenuationDistance);
            setNumber(params, 'anisotropy', md.anisotropy);
        }

        const material = new MaterialCtor(params);

        // Texture maps. SRGB for color/emissive, linear for everything else.
        // The WebGPU module's WebGL fallback can throw if a Texture is assigned
        // before its image exists, so maps are bound from the loader callback.
        bindTexture(material, 'map', firstString(md.map, md.diffMap, md.baseColorMap), THREE.SRGBColorSpace, md.mapXf ?? md.diffMapXf);
        bindTexture(material, 'normalMap', firstString(md.normMap, md.normalMap), THREE.LinearSRGBColorSpace, md.normMapXf ?? md.normalMapXf);
        bindTexture(material, 'roughnessMap', md.roughMap, THREE.LinearSRGBColorSpace, md.roughMapXf);
        bindTexture(material, 'metalnessMap', md.metalMap, THREE.LinearSRGBColorSpace, md.metalMapXf);
        bindTexture(material, 'aoMap', md.aoMap, THREE.LinearSRGBColorSpace, md.aoMapXf);
        if (bindTexture(material, 'bumpMap', md.bumpMap, THREE.LinearSRGBColorSpace, md.bumpMapXf)) {
            params.bumpScale = Number.isFinite(md.bumpS) ? md.bumpS : 1.0;
            material.bumpScale = params.bumpScale;
        }
        if (bindTexture(material, 'alphaMap', md.alphaMap, THREE.LinearSRGBColorSpace, md.alphaMapXf)) {
            params.transparent = true;
            material.transparent = true;
        }
        if (bindTexture(material, 'emissiveMap', firstString(md.emisMap, md.emissiveMap), THREE.SRGBColorSpace, md.emisMapXf ?? md.emissiveMapXf)) {
            // If emissive color wasn't set but emissiveMap is, default emissive to white
            // so the map actually contributes (otherwise emissive=black multiplies it out).
            if (!params.emissive) material.emissive = new THREE.Color(0xffffff);
        }

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
            ns: md.normScl, aoi: md.aoI, lmi: md.lmI,
            phys: {
                sc: md.specularColor,
                si: md.specularIntensity,
                cc: md.clearcoat,
                ccr: md.clearcoatRoughness,
                sh: md.sheen,
                shr: md.sheenRoughness,
                shc: md.sheenColor,
                ir: md.iridescence,
                iri: md.iridescenceIOR,
                tr: md.transmission,
                ior: md.ior,
                refl: md.reflectivity,
                th: md.thickness,
                disp: md.dispersion,
                ac: md.attenuationColor,
                ad: md.attenuationDistance,
                an: md.anisotropy,
            },
            d: firstString(md.map, md.diffMap, md.baseColorMap),
            nm: firstString(md.normMap, md.normalMap),
            rm: md.roughMap,
            mm: md.metalMap,
            ao: md.aoMap,
            bm: md.bumpMap,
            am: md.alphaMap,
            emm: firstString(md.emisMap, md.emissiveMap),
            xf: {
                map: md.mapXf ?? md.diffMapXf,
                norm: md.normMapXf ?? md.normalMapXf,
                rough: md.roughMapXf,
                metal: md.metalMapXf,
                ao: md.aoMapXf,
                bump: md.bumpMapXf,
                alpha: md.alphaMapXf,
                emissive: md.emisMapXf ?? md.emissiveMapXf,
            },
        };
    }

    function dispose() {
        for (const entry of textureCache.values()) {
            entry.callbacks?.splice(0);
            entry.texture?.dispose?.();
        }
        textureCache.clear();
    }

    return { buildForNode, shouldUpdate, loadTex, textureCache, dispose };
}
