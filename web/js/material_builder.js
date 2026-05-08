// material_builder.js - snapshot material factory.
//
// Snapshot should consume the same MaxJSPBR descriptor contract as the live
// viewer. Keep backend-heavy features out of this file, but do not throw away
// exported material intent: bind every browser-safe map slot, honor Max texture
// transforms/channels, and stamp explicit fallback metadata for advanced
// runtime-only material sources.

import * as THREE from 'three';
import {
    FALLBACK_COLOR,
    applyTextureChannelSelection,
    applyTextureTransform,
    applyTextureUvChannel,
    classifyRuntimeMaterial,
    colorFromArray,
    finiteNumberOr,
    getEmissiveColor,
    getEmissiveIntensity,
    optimizedTextureTransformForSlot,
    pickMaterialSide,
    resolveTextureColorSpace,
    textureReadyForMaterialBinding,
} from './material_contract.js';

function setNumber(target, key, value) {
    const n = Number(value);
    if (Number.isFinite(n)) target[key] = n;
}

function hasNonZeroColor(rgb) {
    return Array.isArray(rgb)
        && rgb.length >= 3
        && rgb.some(value => Math.abs(finiteNumberOr(value, 0)) > 1.0e-5);
}

function hasWritableProperty(material, property) {
    return material && (property in material || typeof material[property] !== 'undefined');
}

function firstField(md, keys) {
    for (const key of keys) {
        const value = md?.[key];
        if (typeof value === 'string' && value.length > 0) return { key, value };
    }
    return { key: keys[0], value: null };
}

function firstTransform(md, keys) {
    for (const key of keys) {
        const value = md?.[key];
        if (value && typeof value === 'object') return value;
    }
    return null;
}

function createSolidTexture(r, g, b, a = 255, colorSpace = THREE.NoColorSpace) {
    const texture = new THREE.DataTexture(
        new Uint8Array([r, g, b, a]),
        1,
        1,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
    );
    texture.colorSpace = colorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
}

function createToonGradientTexture() {
    const values = [32, 96, 160, 255];
    const data = new Uint8Array(values.length * 4);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        data[i * 4 + 0] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, values.length, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    configureGradientTexture(texture);
    return texture;
}

function configureGradientTexture(texture) {
    if (!texture) return null;
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
}

function cloneFallbackTexture(texture, colorSpace, xf) {
    if (!texture?.isTexture) return null;
    const clone = texture.clone();
    clone.colorSpace = colorSpace;
    applyTextureTransform(clone, xf);
    clone.needsUpdate = true;
    return clone;
}

const DEFAULT_BAKE_STATE = Object.freeze({
    version: 1,
    enabled: false,
    mode: 'lightmap',
    match: 'scene',
    folder: '',
    sceneName: 'scene',
    lightSuffix: '_lightmap',
    beautySuffix: '_beauty',
    extension: 'png',
    intensity: 1.0,
    bakeExposure: 0,
});

function normalizeBakeState(payload) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const next = { ...DEFAULT_BAKE_STATE, ...raw };
    next.enabled = raw.enabled === true;
    next.mode = next.mode === 'beauty' ? 'beauty' : 'lightmap';
    next.match = ['scene', 'object', 'material'].includes(next.match) ? next.match : 'scene';
    next.folder = String(next.folder ?? '').trim();
    while (next.folder.length >= 2) {
        const first = next.folder[0];
        const last = next.folder[next.folder.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            next.folder = next.folder.slice(1, -1).trim();
            continue;
        }
        break;
    }
    next.sceneName = String(next.sceneName || DEFAULT_BAKE_STATE.sceneName).trim() || DEFAULT_BAKE_STATE.sceneName;
    next.lightSuffix = String(next.lightSuffix ?? DEFAULT_BAKE_STATE.lightSuffix);
    next.beautySuffix = String(next.beautySuffix ?? DEFAULT_BAKE_STATE.beautySuffix);
    next.extension = String(next.extension || DEFAULT_BAKE_STATE.extension).replace(/^\./, '') || DEFAULT_BAKE_STATE.extension;
    next.intensity = Number.isFinite(Number(next.intensity)) ? Math.max(0, Number(next.intensity)) : 1.0;
    next.bakeExposure = Number.isFinite(Number(next.bakeExposure)) ? Number(next.bakeExposure) : 0;
    return next;
}

function encodeAssetPath(path) {
    const normalized = String(path ?? '').replace(/\\/g, '/');
    const segments = normalized.split('/').filter((segment, index) => segment.length > 0 || index === 0);
    return segments.map(segment => encodeURIComponent(segment)).join('/');
}

function normalizeBakeFolderUrl(folder) {
    const raw = String(folder ?? '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/')) {
        return raw.endsWith('/') ? raw : `${raw}/`;
    }
    if (/^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) {
        return `https://maxjs-assets.local/${encodeAssetPath(raw).replace(/\/?$/, '/')}`;
    }
    return raw.endsWith('/') ? raw : `${raw}/`;
}

function sanitizeBakeFileStem(value) {
    return String(value ?? '')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '') || 'scene';
}

function bakeIdentityXf(maxMapChannel = 2) {
    return {
        scale: 1.0,
        tiling: [1.0, 1.0],
        offset: [0.0, 0.0],
        rotate: 0.0,
        center: [0.5, 0.5],
        realWorld: false,
        realWidth: 1.0,
        realHeight: 1.0,
        wrap: 'periodic',
        channel: 1,
        uvChannel: maxMapChannel,
        invert: false,
        colorSpace: '',
        manualGamma: 1.0,
    };
}

function hasGeometryUV2(geom) {
    return !!(geom?.getAttribute?.('uv1') || geom?.getAttribute?.('uv2'));
}

function materialIdentityValue(value) {
    if (Array.isArray(value)) return value.map(materialIdentityValue);
    if (!value || typeof value !== 'object') return value;
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
        const child = value[key];
        if (child === undefined) continue;
        normalized[key] = materialIdentityValue(child);
    }
    return normalized;
}

function combineModeFromMax(value) {
    const modes = [THREE.MultiplyOperation, THREE.MixOperation, THREE.AddOperation];
    return modes[Math.max(0, Math.round(Number(value) || 0))] ?? THREE.MultiplyOperation;
}

function depthPackingFromMax(value) {
    const modes = [
        THREE.BasicDepthPacking,
        THREE.RGBADepthPacking,
        THREE.RGBDepthPacking,
        THREE.RGDepthPacking,
    ];
    return modes[Math.max(0, Math.round(Number(value) || 0))] ?? THREE.BasicDepthPacking;
}

const COMMON_TEXTURE_SLOTS = [
    {
        canonical: 'map',
        urlKeys: ['map', 'diffMap', 'baseColorMap'],
        xfKeys: ['mapXf', 'diffMapXf', 'baseColorMapXf'],
        property: 'map',
        colorSpace: () => THREE.SRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'normMap',
        urlKeys: ['normMap', 'normalMap'],
        xfKeys: ['normMapXf', 'normalMapXf'],
        property: 'normalMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'flatNormal',
    },
    {
        canonical: 'bumpMap',
        urlKeys: ['bumpMap'],
        xfKeys: ['bumpMapXf'],
        property: 'bumpMap',
        colorSpace: () => THREE.NoColorSpace,
        fallback: 'height',
    },
    {
        canonical: 'dispMap',
        urlKeys: ['dispMap', 'displacementMap'],
        xfKeys: ['dispMapXf', 'displacementMapXf'],
        property: 'displacementMap',
        colorSpace: () => THREE.NoColorSpace,
        fallback: 'height',
    },
    {
        canonical: 'aoMap',
        urlKeys: ['aoMap'],
        xfKeys: ['aoMapXf'],
        property: 'aoMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'emMap',
        urlKeys: ['emMap', 'emisMap', 'emissiveMap'],
        xfKeys: ['emMapXf', 'emisMapXf', 'emissiveMapXf'],
        property: 'emissiveMap',
        colorSpace: () => THREE.SRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'opMap',
        urlKeys: ['opMap', 'alphaMap', 'opacityMap'],
        xfKeys: ['opMapXf', 'alphaMapXf', 'opacityMapXf'],
        property: 'alphaMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
        onAssign: (material) => {
            material.transparent = true;
        },
    },
    {
        canonical: 'lmMap',
        urlKeys: ['lmMap', 'lightMap'],
        xfKeys: ['lmMapXf', 'lightMapXf'],
        property: 'lightMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
        onAssign: (material, texture, md) => {
            applyTextureUvChannel(texture, md?.lmCh, 2);
            if ('lightMapIntensity' in material) {
                material.lightMapIntensity = Number.isFinite(md?.lmI)
                    ? md.lmI
                    : material.lightMapIntensity;
            }
        },
    },
    {
        canonical: 'matcapMap',
        urlKeys: ['matcapMap'],
        xfKeys: ['matcapMapXf'],
        property: 'matcap',
        colorSpace: () => THREE.SRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'specMap',
        urlKeys: ['specMap'],
        xfKeys: ['specMapXf'],
        property: 'specularMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
    },
];

const STANDARD_TEXTURE_SLOTS = [
    {
        canonical: 'roughMap',
        urlKeys: ['roughMap', 'roughnessMap'],
        xfKeys: ['roughMapXf', 'roughnessMapXf'],
        property: 'roughnessMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'metalMap',
        urlKeys: ['metalMap', 'metalnessMap'],
        xfKeys: ['metalMapXf', 'metalnessMapXf'],
        property: 'metalnessMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
    },
];

const PHYSICAL_TEXTURE_SLOTS = [
    {
        canonical: 'specIntMap',
        urlKeys: ['specIntMap'],
        xfKeys: ['specIntMapXf'],
        property: 'specularIntensityMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'specColMap',
        urlKeys: ['specColMap'],
        xfKeys: ['specColMapXf'],
        property: 'specularColorMap',
        colorSpace: () => THREE.SRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'ccMap',
        urlKeys: ['ccMap'],
        xfKeys: ['ccMapXf'],
        property: 'clearcoatMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'ccRoughMap',
        urlKeys: ['ccRoughMap'],
        xfKeys: ['ccRoughMapXf'],
        property: 'clearcoatRoughnessMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
    },
    {
        canonical: 'ccNormMap',
        urlKeys: ['ccNormMap'],
        xfKeys: ['ccNormMapXf'],
        property: 'clearcoatNormalMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'flatNormal',
    },
    {
        canonical: 'transMap',
        urlKeys: ['transMap'],
        xfKeys: ['transMapXf'],
        property: 'transmissionMap',
        colorSpace: () => THREE.LinearSRGBColorSpace,
        fallback: 'white',
        onAssign: (material) => {
            material.transparent = true;
        },
    },
];

function applyCommonScalarParams(params, md) {
    const emissiveColor = getEmissiveColor(md);
    const emissiveIntensity = getEmissiveIntensity(md);
    if (Array.isArray(emissiveColor)) {
        params.emissive = colorFromArray(emissiveColor, 0x000000);
    }
    if (Number.isFinite(emissiveIntensity)) params.emissiveIntensity = emissiveIntensity;
    if (Number.isFinite(md?.alphaTest) && md.alphaTest > 0) params.alphaTest = md.alphaTest;
    if (md?.opacity != null && md.opacity < 0.999) {
        params.transparent = true;
        params.opacity = md.opacity;
    }
    if (Number.isFinite(md?.normScl)) params.normalScale = new THREE.Vector2(md.normScl, md.normScl);
    setNumber(params, 'bumpScale', md?.bumpS);
    setNumber(params, 'displacementScale', md?.dispS);
    setNumber(params, 'displacementBias', md?.dispB);
    setNumber(params, 'aoMapIntensity', md?.aoI);
    setNumber(params, 'lightMapIntensity', md?.lmI);
}

function applyPbrScalarParams(params, md) {
    params.roughness = Number.isFinite(md?.rough) ? md.rough : 0.5;
    params.metalness = Number.isFinite(md?.metal) ? md.metal : 0.0;
    params.envMapIntensity = Number.isFinite(md?.envI) ? md.envI : 1.0;
}

function applyPhysicalScalarParams(params, md) {
    setNumber(params, 'specularIntensity', md?.specularIntensity);
    if (Array.isArray(md?.specularColor)) params.specularColor = colorFromArray(md.specularColor, 0xffffff);
    setNumber(params, 'clearcoat', md?.clearcoat);
    setNumber(params, 'clearcoatRoughness', md?.clearcoatRoughness);
    setNumber(params, 'sheen', md?.sheen);
    setNumber(params, 'sheenRoughness', md?.sheenRoughness);
    if (Array.isArray(md?.sheenColor)) params.sheenColor = colorFromArray(md.sheenColor, 0xffffff);
    setNumber(params, 'iridescence', md?.iridescence);
    setNumber(params, 'iridescenceIOR', md?.iridescenceIOR);
    setNumber(params, 'transmission', md?.transmission);
    setNumber(params, 'ior', md?.ior);
    setNumber(params, 'reflectivity', md?.reflectivity);
    setNumber(params, 'thickness', md?.thickness);
    setNumber(params, 'dispersion', md?.dispersion);
    if (Array.isArray(md?.attenuationColor)) params.attenuationColor = colorFromArray(md.attenuationColor, 0xffffff);
    setNumber(params, 'attenuationDistance', md?.attenuationDistance);
    setNumber(params, 'anisotropy', md?.anisotropy);
    setNumber(params, 'anisotropyRotation', md?.anisotropyRotation);
    if ((md?.transmission ?? 0) > 0) params.transparent = true;
    if (md?.specularIntensity != null && Number(md.specularIntensity) < 0.001) {
        params.envMapIntensity = 0;
        params.ior = 1.0;
    }
}

function applyUtilityScalarParams(material, md) {
    material.side = pickMaterialSide(md);
    material.opacity = md?.opacity ?? 1.0;
    material.transparent = material.opacity < 0.999;

    if ('color' in material && Array.isArray(md?.color)) {
        material.color.setRGB(md.color[0], md.color[1], md.color[2]);
    }
    if ('emissive' in material) {
        const emissiveColor = getEmissiveColor(md);
        if (Array.isArray(emissiveColor)) {
            material.emissive.setRGB(emissiveColor[0], emissiveColor[1], emissiveColor[2]);
        }
        const emissiveIntensity = getEmissiveIntensity(md);
        material.emissiveIntensity = Number.isFinite(emissiveIntensity)
            ? emissiveIntensity
            : material.emissiveIntensity ?? 1.0;
    }
    if ('envMapIntensity' in material && md?.envI != null) material.envMapIntensity = md.envI;
    if ('reflectivity' in material && md?.reflectivity != null) material.reflectivity = md.reflectivity;
    if ('refractionRatio' in material && md?.refractionRatio != null) material.refractionRatio = md.refractionRatio;
    if ('flatShading' in material) material.flatShading = !!md?.flat;
    if ('wireframe' in material) material.wireframe = !!md?.wireframe;
    if ('fog' in material && md?.fog != null) material.fog = !!md.fog;
    if ('shininess' in material && md?.shininess != null) material.shininess = md.shininess;
    if ('specular' in material && Array.isArray(md?.spec)) material.specular.setRGB(md.spec[0], md.spec[1], md.spec[2]);
    if ('combine' in material && md?.combine != null) material.combine = combineModeFromMax(md.combine);
    if ('normalMapType' in material && md?.normalMapType != null) {
        material.normalMapType = md.normalMapType === 1 ? THREE.ObjectSpaceNormalMap : THREE.TangentSpaceNormalMap;
    }
    if ('depthPacking' in material && md?.depthPacking != null) material.depthPacking = depthPackingFromMax(md.depthPacking);
    if (md?.normScl != null && 'normalScale' in material) material.normalScale = new THREE.Vector2(md.normScl, md.normScl);
    if (md?.bumpS != null && 'bumpScale' in material) material.bumpScale = md.bumpS;
    if (md?.dispS != null && 'displacementScale' in material) material.displacementScale = md.dispS;
    if (md?.dispB != null && 'displacementBias' in material) material.displacementBias = md.dispB;
    if (md?.aoI != null && 'aoMapIntensity' in material) material.aoMapIntensity = md.aoI;
    if (md?.lmI != null && 'lightMapIntensity' in material) material.lightMapIntensity = md.lmI;
    if (Number.isFinite(md?.alphaTest) && 'alphaTest' in material) material.alphaTest = md.alphaTest;
}

function createMaterialForRuntimeModel(runtimeModelName, params) {
    switch (runtimeModelName) {
        case 'MeshDepthMaterial':
            return new THREE.MeshDepthMaterial(params);
        case 'MeshLambertMaterial':
            return new THREE.MeshLambertMaterial(params);
        case 'MeshMatcapMaterial':
            return new THREE.MeshMatcapMaterial(params);
        case 'MeshNormalMaterial':
            return new THREE.MeshNormalMaterial(params);
        case 'MeshPhongMaterial':
            return new THREE.MeshPhongMaterial(params);
        case 'MeshToonMaterial':
            return new THREE.MeshToonMaterial(params);
        case 'MeshPhysicalMaterial':
            return new THREE.MeshPhysicalMaterial(params);
        case 'MeshStandardMaterial':
        default:
            return new THREE.MeshStandardMaterial(params);
    }
}

/**
 * Creates a material-builder instance tied to a snapshot root URL.
 * Owns its own texture cache so re-applies do not refetch.
 */
export function createMaterialBuilder({ rootUrl = '.', bakeState = null } = {}) {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin?.('anonymous');
    const textureCache = new Map();
    let bakeOverrides = normalizeBakeState(bakeState);
    const fallbackTextures = {
        white: createSolidTexture(255, 255, 255, 255, THREE.NoColorSpace),
        whiteSrgb: createSolidTexture(255, 255, 255, 255, THREE.SRGBColorSpace),
        flatNormal: createSolidTexture(128, 128, 255, 255, THREE.NoColorSpace),
        height: createSolidTexture(255, 255, 255, 255, THREE.NoColorSpace),
        toonGradient: createToonGradientTexture(),
    };

    function resolveUrl(url) {
        try {
            return new URL(url, new URL(`${rootUrl}/`, location.href)).href;
        } catch {
            return url;
        }
    }

    function fallbackForSlot(slot, colorSpace, xf) {
        const base = slot.fallback === 'white' && colorSpace === THREE.SRGBColorSpace
            ? fallbackTextures.whiteSrgb
            : fallbackTextures[slot.fallback] ?? fallbackTextures.white;
        return cloneFallbackTexture(base, colorSpace, xf);
    }

    function loadTextureEntry(url, colorSpace = THREE.LinearSRGBColorSpace, xf = null, fallbackTexture = fallbackTextures.white) {
        if (!url) return null;
        const resolved = resolveUrl(url);
        const textureColorSpace = resolveTextureColorSpace(colorSpace, xf, resolved);
        const xfKey = xf ? JSON.stringify(xf) : '';
        const key = `${resolved}::${textureColorSpace}::${xfKey}`;
        if (textureCache.has(key)) return textureCache.get(key);

        const entry = {
            texture: cloneFallbackTexture(fallbackTexture, textureColorSpace, xf),
            loaded: false,
            failed: false,
            callbacks: [],
            resolved,
        };
        textureCache.set(key, entry);

        const loadedTexture = loader.load(
            resolved,
            (loaded) => {
                loaded.colorSpace = textureColorSpace;
                applyTextureChannelSelection(loaded, xf);
                applyTextureTransform(loaded, xf);
                loaded.needsUpdate = true;
                entry.texture = loaded;
                entry.loaded = true;
                const callbacks = entry.callbacks.splice(0);
                for (const callback of callbacks) callback(loaded);
            },
            undefined,
            (err) => {
                entry.failed = true;
                entry.loaded = true;
                entry.error = err;
                entry.callbacks.splice(0);
                console.warn('[material_builder] texture load failed:', resolved, err);
            },
        );

        loadedTexture.colorSpace = textureColorSpace;
        applyTextureTransform(loadedTexture, xf);
        return entry;
    }

    function loadTex(url, colorSpace = THREE.LinearSRGBColorSpace, xf = null) {
        const normalizedXf = optimizedTextureTransformForSlot('map', xf);
        return loadTextureEntry(url, colorSpace, normalizedXf, fallbackTextures.white)?.texture ?? null;
    }

    function getMaterialBakeName(md, material) {
        return String(
            md?.name ??
            material?.userData?.maxjsSourceMaterialName ??
            material?.name ??
            'material'
        ).trim() || 'material';
    }

    function getBakeTargetName(nd, md, material) {
        if (bakeOverrides.match === 'object') return nd?.n || nd?.name || `node_${nd?.h ?? '0'}`;
        if (bakeOverrides.match === 'material') return getMaterialBakeName(md, material);
        return bakeOverrides.sceneName;
    }

    function getBakeTextureUrl(nd, md, material, kind) {
        if (!bakeOverrides.enabled || !bakeOverrides.folder) return '';
        const folder = normalizeBakeFolderUrl(bakeOverrides.folder);
        if (!folder) return '';
        const suffix = kind === 'beauty' ? bakeOverrides.beautySuffix : bakeOverrides.lightSuffix;
        const stem = sanitizeBakeFileStem(getBakeTargetName(nd, md, material));
        return `${folder}${encodeURIComponent(`${stem}${suffix}.${bakeOverrides.extension}`)}`;
    }

    function loadBakeTextureEntry(url, colorSpace = THREE.LinearSRGBColorSpace, maxMapChannel = 2) {
        const xf = bakeIdentityXf(maxMapChannel);
        return loadTextureEntry(url, colorSpace, xf, fallbackTextures.white);
    }

    function createBeautyBakeMaterial(source, texture) {
        const exposureMul = bakeOverrides.intensity * Math.pow(2, bakeOverrides.bakeExposure);
        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(exposureMul, exposureMul, exposureMul),
            map: texture,
            side: source?.side ?? THREE.FrontSide,
            transparent: !!source?.transparent || (Number.isFinite(source?.opacity) && source.opacity < 1),
            opacity: Number.isFinite(source?.opacity) ? source.opacity : 1,
            alphaMap: source?.alphaMap ?? null,
            depthWrite: source?.depthWrite ?? true,
            depthTest: source?.depthTest ?? true,
        });
        material.name = source?.name ? `${source.name} bake beauty` : 'bake beauty';
        material.userData = { ...(source?.userData || {}), maxjsBakeOverride: 'beauty' };
        return material;
    }

    function applyBakeOverrideToMaterial(material, md, { nd = null, geom = null, wantsLine = false } = {}) {
        if (!material || !bakeOverrides.enabled || wantsLine) return material;
        if (material.isLineBasicMaterial || material.isLineDashedMaterial) return material;
        const kind = bakeOverrides.mode === 'beauty' ? 'beauty' : 'lightmap';
        const url = getBakeTextureUrl(nd, md, material, kind);
        if (!url) return material;

        if (!hasGeometryUV2(geom)) {
            material.userData ??= {};
            material.userData.maxjsBakeMissingUV2 = true;
            return material;
        }

        if (kind === 'beauty') {
            const entry = loadBakeTextureEntry(url, THREE.SRGBColorSpace, 2);
            if (!entry) return material;
            const baked = createBeautyBakeMaterial(material, entry.texture);
            if (!entry.loaded && !entry.failed) {
                entry.callbacks.push((texture) => {
                    baked.map = texture;
                    baked.needsUpdate = true;
                });
            }
            return baked;
        }

        const entry = loadBakeTextureEntry(url, THREE.LinearSRGBColorSpace, 2);
        if (!entry) return material;
        const assign = (texture) => {
            if (!textureReadyForMaterialBinding(texture)) return;
            material.lightMap = texture;
            material.lightMapIntensity = bakeOverrides.intensity * Math.pow(2, bakeOverrides.bakeExposure);
            material.userData ??= {};
            material.userData.maxjsBakeOverride = 'lightmap';
            material.needsUpdate = true;
        };
        assign(entry.texture);
        if (!entry.loaded && !entry.failed) entry.callbacks.push(assign);
        return material;
    }

    function bindTexture(material, slot, md) {
        if (!hasWritableProperty(material, slot.property)) return false;
        const { value: url } = firstField(md, slot.urlKeys);
        if (!url) return false;

        const rawXf = firstTransform(md, slot.xfKeys);
        const xf = optimizedTextureTransformForSlot(slot.canonical, rawXf);
        const colorSpace = slot.colorSpace(md);
        const fallbackTexture = fallbackForSlot(slot, colorSpace, xf);
        const entry = loadTextureEntry(url, colorSpace, xf, fallbackTexture);
        if (!entry) return false;

        const assign = (texture) => {
            material[slot.property] = texture;
            slot.onAssign?.(material, texture, md);
            material.needsUpdate = true;
        };

        if (textureReadyForMaterialBinding(entry.texture)) {
            assign(entry.texture);
        }
        if (!entry.loaded && !entry.failed) {
            entry.callbacks.push(assign);
        }
        return true;
    }

    function bindSlots(material, md, slots, boundSlots) {
        for (const slot of slots) {
            if (bindTexture(material, slot, md)) boundSlots.push(slot.property);
        }
    }

    function createParams(md, info) {
        const params = {
            color: colorFromArray(md?.color),
            side: pickMaterialSide(md),
        };
        applyCommonScalarParams(params, md);

        if (
            info.runtimeModelName === 'MeshStandardMaterial' ||
            info.runtimeModelName === 'MeshPhysicalMaterial'
        ) {
            applyPbrScalarParams(params, md);
        }
        if (info.runtimeModelName === 'MeshPhysicalMaterial') {
            applyPhysicalScalarParams(params, md);
        }

        const emissiveColor = getEmissiveColor(md);
        if (md?.emMap && !params.emissive) {
            params.emissive = hasNonZeroColor(emissiveColor)
                ? colorFromArray(emissiveColor, 0x000000)
                : new THREE.Color(0xffffff);
        }
        if (md?.emMap && (!Number.isFinite(params.emissiveIntensity) || params.emissiveIntensity <= 0)) {
            params.emissiveIntensity = Number.isFinite(md.emMapS) ? md.emMapS : 1.0;
        }
        return params;
    }

    function buildMaterial(md, context = {}) {
        const descriptor = md && typeof md === 'object' ? md : { color: [0.53, 0.53, 0.53] };
        const info = classifyRuntimeMaterial(descriptor, THREE);
        const params = createParams(descriptor, info);
        let material = createMaterialForRuntimeModel(info.runtimeModelName, params);
        const boundSlots = [];

        if (info.wantsUtilityMaterial) {
            applyUtilityScalarParams(material, descriptor);
        }
        if (info.runtimeModelName === 'MeshToonMaterial') {
            bindSlots(material, descriptor, [COMMON_TEXTURE_SLOTS[0]], boundSlots);
            bindSlots(material, descriptor, COMMON_TEXTURE_SLOTS.slice(1), boundSlots);
            const gradientSlot = {
                canonical: 'gradMap',
                urlKeys: ['gradMap', 'gradientMap'],
                xfKeys: ['gradMapXf', 'gradientMapXf'],
                property: 'gradientMap',
                colorSpace: () => THREE.NoColorSpace,
                fallback: 'toonGradient',
                onAssign: (_material, texture) => configureGradientTexture(texture),
            };
            if (bindTexture(material, gradientSlot, descriptor)) {
                boundSlots.push('gradientMap');
            } else {
                material.gradientMap = fallbackTextures.toonGradient;
            }
        } else {
            bindSlots(material, descriptor, COMMON_TEXTURE_SLOTS, boundSlots);
            if (!info.wantsUtilityMaterial) {
                bindSlots(material, descriptor, STANDARD_TEXTURE_SLOTS, boundSlots);
            }
            if (info.runtimeModelName === 'MeshPhysicalMaterial') {
                bindSlots(material, descriptor, PHYSICAL_TEXTURE_SLOTS, boundSlots);
            }
        }

        if ('normalMapType' in material && descriptor.normalMapType != null) {
            material.normalMapType = descriptor.normalMapType === 1
                ? THREE.ObjectSpaceNormalMap
                : THREE.TangentSpaceNormalMap;
        }

        if (descriptor.name) material.name = descriptor.name;
        material.userData ??= {};
        material.userData.maxjsRequestedMaterialModel = info.requestedModelName;
        material.userData.maxjsMaterialModel = info.runtimeModelName;
        material.userData.maxjsSourceMaterialName = descriptor.name ?? 'material';
        material.userData.maxjsBoundTextureSlots = boundSlots;
        material.userData.maxjsTextureSlotScalars = {
            map: descriptor.mapS,
            roughnessMap: descriptor.roughMapS,
            metalnessMap: descriptor.metalMapS,
            emissiveMap: descriptor.emMapS,
            alphaMap: descriptor.opMapS,
        };
        material.userData.maxjsAdvancedSourceFallback =
            info.hasAdvancedSource &&
            (info.wantsMaterialXMaterial || info.wantsTSLMaterial || info.wantsSSSMaterial);
        material.userData.maxjsLambertFromBlackSpecular = info.forceLambertForBlackSpecular;
        material.userData.maxjsUtilityMaterialFallback =
            info.wantsUtilityMaterial &&
            !info.forceLambertForBlackSpecular &&
            info.runtimeModelName !== info.requestedModelName;
        material.userData.maxjsToonMaterialFallback =
            info.wantsToonMaterial && info.runtimeModelName !== 'MeshToonMaterial';
        material.userData.maxjsSSSMaterialFallback =
            info.wantsSSSMaterial && info.runtimeModelName !== 'MeshSSSNodeMaterial';
        material.needsUpdate = true;
        return applyBakeOverrideToMaterial(material, descriptor, context);
    }

    function buildLine(md) {
        const color = md ? colorFromArray(md.color) : new THREE.Color(FALLBACK_COLOR);
        return new THREE.LineBasicMaterial({ color });
    }

    function buildForNode({ nd, geom, wantsLine }) {
        if (wantsLine) return buildLine(nd?.mat);
        if (nd?.mats?.length && nd?.groups?.length) {
            return nd.mats.map((m) => buildMaterial(m, { nd, geom, wantsLine }));
        }
        return buildMaterial(nd?.mat, { nd, geom, wantsLine });
    }

    function setBakeState(nextState) {
        bakeOverrides = normalizeBakeState(nextState);
    }

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
            return 'multi:' + JSON.stringify(nd.mats.map(materialIdentityValue));
        }
        return 'single:' + JSON.stringify(materialIdentityValue(nd.mat ?? null));
    }

    function dispose() {
        for (const entry of textureCache.values()) {
            entry.callbacks?.splice(0);
            entry.texture?.dispose?.();
        }
        textureCache.clear();
        for (const texture of Object.values(fallbackTextures)) texture?.dispose?.();
    }

    return { buildForNode, shouldUpdate, signature, loadTex, setBakeState, textureCache, dispose };
}
