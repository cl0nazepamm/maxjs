// material_builder.js - snapshot material factory.
//
// Snapshot should consume the same MaxJSPBR descriptor contract as the live
// viewer. Keep backend-heavy features out of this file, but do not throw away
// exported material intent: bind every browser-safe map slot, honor Max texture
// transforms/channels, and stamp explicit fallback metadata for advanced
// runtime-only material sources.

import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
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
    getTextureExtension,
    maxMapChannelFromMapName,
    optimizedTextureTransformForSlot,
    pickMaterialSide,
    resolveTextureColorSpace,
    textureReadyForMaterialBinding,
} from './material_contract.js';
import * as TSL from 'three/tsl';
import { createTSLCompiler, makeBakeNodeToTexture } from './tsl_materials.js';

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

function suppressKnownExrMetadataWarnings(loader) {
    if (!loader || loader.userData?.maxjsQuietM44fHeader) return loader;
    const originalParse = typeof loader.parse === 'function' ? loader.parse.bind(loader) : null;
    if (!originalParse) return loader;
    loader.parse = (...args) => {
        const previousWarn = console.warn;
        console.warn = (...warnArgs) => {
            const msg = String(warnArgs?.[0] ?? '');
            if (
                msg.includes('THREE.EXRLoader: Skipped unknown header attribute type') &&
                msg.includes('m44f')
            ) {
                return;
            }
            previousWarn.apply(console, warnArgs);
        };
        try {
            return originalParse(...args);
        } finally {
            console.warn = previousWarn;
        }
    };
    loader.userData = { ...(loader.userData || {}), maxjsQuietM44fHeader: true };
    return loader;
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

function colorFallbackTexture(color, colorSpace = THREE.SRGBColorSpace) {
    const c = color?.isColor ? color : colorFromArray(color);
    const texture = new THREE.DataTexture(
        new Uint8Array([
            Math.round(THREE.MathUtils.clamp(c.r, 0, 1) * 255),
            Math.round(THREE.MathUtils.clamp(c.g, 0, 1) * 255),
            Math.round(THREE.MathUtils.clamp(c.b, 0, 1) * 255),
            255,
        ]),
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
    proxyDisplay: false,
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
    next.proxyDisplay = raw.proxyDisplay === true;
    next.files = Array.isArray(raw.files)
        ? raw.files.map(file => String(file || '')).filter(Boolean)
        : null;
    next.fileSet = next.files
        ? new Set(next.files.map(file => file.toLowerCase()))
        : null;
    next.fileMap = next.files
        ? new Map(next.files.map(file => [file.toLowerCase(), file]))
        : null;
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

function getBakeMaxMapChannel(url = '') {
    return maxMapChannelFromMapName(url, 2);
}

function hasGeometryMaxMapChannel(geom, maxMapChannel = 2) {
    const channel = Number.isFinite(Number(maxMapChannel))
        ? Math.max(1, Math.round(Number(maxMapChannel)))
        : 2;
    if (channel === 1) return !!geom?.getAttribute?.('uv');
    if (channel === 2) return hasGeometryUV2(geom);
    return false;
}

function markBakeMissingUv(material, maxMapChannel = 2) {
    material.userData ??= {};
    material.userData.maxjsBakeMissingUV = maxMapChannel;
    if (maxMapChannel === 2) material.userData.maxjsBakeMissingUV2 = true;
    else delete material.userData.maxjsBakeMissingUV2;
}

function clearBakeMissingUv(material) {
    if (!material?.userData) return;
    delete material.userData.maxjsBakeMissingUV;
    delete material.userData.maxjsBakeMissingUV2;
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
            if (!(Number.isFinite(material.alphaTest) && material.alphaTest > 0)) {
                material.transparent = true;
            }
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
    if (md?.transparent === true) params.transparent = true;
    if (md?.depthWrite != null) params.depthWrite = !!md.depthWrite;
    if (md?.depthTest != null) params.depthTest = !!md.depthTest;
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
    if (Number.isFinite(Number(md?.attenuationDistance)) && Number(md.attenuationDistance) > 0) {
        params.attenuationDistance = Number(md.attenuationDistance);
    }
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
    material.transparent = !!md?.transparent || material.opacity < 0.999;
    if ('depthWrite' in material && md?.depthWrite != null) material.depthWrite = !!md.depthWrite;
    if ('depthTest' in material && md?.depthTest != null) material.depthTest = !!md.depthTest;

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

const VIDEO_TEXTURE_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);

function canUploadVideoFrame(video) {
    return !!video &&
        !video.error &&
        !video.seeking &&
        video.readyState >= video.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0;
}

function installSafeVideoTexturePump(texture, video) {
    if (!texture || !video) return;
    if (texture.source) texture.source.dataReady = false;

    let disposed = false;
    let frameCallbackId = 0;
    const originalDispose = texture.dispose?.bind(texture);

    function markReady() {
        if (disposed || !canUploadVideoFrame(video)) return;
        if (texture.source) texture.source.dataReady = true;
        texture.needsUpdate = true;
    }

    function markNotReady() {
        if (texture.source) texture.source.dataReady = false;
    }

    function requestFrame() {
        if (disposed || typeof video.requestVideoFrameCallback !== 'function') return;
        frameCallbackId = video.requestVideoFrameCallback(() => {
            markReady();
            requestFrame();
        });
    }

    video.addEventListener('loadeddata', markReady);
    video.addEventListener('canplay', markReady);
    video.addEventListener('playing', markReady);
    video.addEventListener('seeked', markReady);
    video.addEventListener('seeking', markNotReady);
    video.addEventListener('waiting', markNotReady);
    video.addEventListener('stalled', markNotReady);
    requestFrame();

    texture.dispose = () => {
        if (disposed) return;
        disposed = true;
        if (frameCallbackId && typeof video.cancelVideoFrameCallback === 'function') {
            try { video.cancelVideoFrameCallback(frameCallbackId); } catch {}
        }
        video.pause?.();
        video.removeAttribute?.('src');
        video.load?.();
        originalDispose?.();
    };
}

/**
 * Creates a material-builder instance tied to a snapshot root URL.
 * Owns its own texture cache so re-applies do not refetch.
 */
export function createMaterialBuilder({ rootUrl = '.', bakeState = null, renderer = null } = {}) {
    const loader = new THREE.TextureLoader();
    const hdrLoader = new HDRLoader();
    const exrLoader = suppressKnownExrMetadataWarnings(new EXRLoader());
    loader.setCrossOrigin?.('anonymous');
    hdrLoader.setCrossOrigin?.('anonymous');
    exrLoader.setCrossOrigin?.('anonymous');
    const textureCache = new Map();
    let bakeOverrides = normalizeBakeState(bakeState);
    // Shared TSL compiler — the exact module the live viewer uses, so WebGPU
    // snapshots render real TSL instead of a PBR fallback. On the WebGL build
    // THREE has no node materials, so nodeMaterialsAvailable is false and the
    // TSL hooks below are skipped (the existing path is left untouched).
    // Its own raw-texture cache (the builder's textureCache holds entry objects).
    const tslTextureCache = new Map();
    const tslCompiler = createTSLCompiler({
        THREE,
        TSL,
        loadTexture: (url) => loadTex(url),
        textureCache: tslTextureCache,
        debugWarn: (...args) => console.warn(...args),
        bakeNodeToTexture: makeBakeNodeToTexture(renderer, THREE),
    });
    const fallbackTextures = {
        black: createSolidTexture(0, 0, 0, 255, THREE.NoColorSpace),
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

    function loaderForExtension(ext) {
        if (ext === 'exr') return exrLoader;
        if (ext === 'hdr') return hdrLoader;
        return loader;
    }

    function isVideoTextureSource(resolved, xf) {
        return !!xf?.video || VIDEO_TEXTURE_EXTS.has(getTextureExtension(resolved));
    }

    function isUnresolvedVirtualAssetUrl(url) {
        try {
            const parsed = new URL(url, location.href);
            return parsed.hostname === 'maxjs-assets.local' &&
                globalThis.location?.hostname !== 'maxjs-assets.local';
        } catch {
            return String(url || '').startsWith('https://maxjs-assets.local/');
        }
    }

    function fallbackForSlot(slot, colorSpace, xf) {
        const base = slot.fallback === 'white' && colorSpace === THREE.SRGBColorSpace
            ? fallbackTextures.whiteSrgb
            : fallbackTextures[slot.fallback] ?? fallbackTextures.white;
        return cloneFallbackTexture(base, colorSpace, xf);
    }

    function finishTextureLoad(entry, loaded, textureColorSpace, xf) {
        loaded.colorSpace = textureColorSpace;
        applyTextureChannelSelection(loaded, xf);
        applyTextureTransform(loaded, xf);
        loaded.needsUpdate = true;
        entry.texture = loaded;
        entry.loaded = true;
        const callbacks = entry.callbacks.splice(0);
        for (const callback of callbacks) callback(loaded);
    }

    function failTextureLoad(entry, err, { silent = false } = {}) {
        entry.failed = true;
        entry.loaded = true;
        entry.error = err;
        entry.callbacks.splice(0);
        if (!silent) console.warn('[material_builder] texture load failed:', entry.resolved, err);
    }

    function beginTextureLoad(entry, activeLoader, textureColorSpace, xf, { silent = false } = {}) {
        const loadedTexture = activeLoader.load(
            entry.resolved,
            (loaded) => finishTextureLoad(entry, loaded, textureColorSpace, xf),
            undefined,
            (err) => failTextureLoad(entry, err, { silent }),
        );
        loadedTexture.colorSpace = textureColorSpace;
        applyTextureTransform(loadedTexture, xf);
        return loadedTexture;
    }

    function beginVideoTextureLoad(entry, textureColorSpace, xf, { silent = false } = {}) {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.loop = xf?.loop !== false;
        video.muted = xf?.muted !== false;
        video.playbackRate = Number.isFinite(Number(xf?.rate)) ? Number(xf.rate) : 1.0;
        video.playsInline = true;
        video.autoplay = true;
        video.preload = 'auto';
        video.src = entry.resolved;

        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = textureColorSpace;
        applyTextureChannelSelection(texture, xf);
        applyTextureTransform(texture, xf);
        installSafeVideoTexturePump(texture, video);
        entry.texture = texture;

        const onReady = () => {
            if (!canUploadVideoFrame(video)) return;
            finishTextureLoad(entry, texture, textureColorSpace, xf);
        };
        video.addEventListener('loadeddata', onReady, { once: true });
        video.addEventListener('canplay', onReady, { once: true });
        video.addEventListener('error', (event) => failTextureLoad(entry, event, { silent }), { once: true });
        video.load?.();
        video.play?.().catch(() => {});
        return texture;
    }

    function loadTextureEntry(
        url,
        colorSpace = THREE.LinearSRGBColorSpace,
        xf = null,
        fallbackTexture = fallbackTextures.white,
        options = {},
    ) {
        if (!url) return null;
        const resolved = resolveUrl(url);
        if (isUnresolvedVirtualAssetUrl(resolved)) return null;
        const textureColorSpace = resolveTextureColorSpace(colorSpace, xf, resolved);
        const isVideoTexture = isVideoTextureSource(resolved, xf);
        const activeLoader = isVideoTexture ? null : loaderForExtension(getTextureExtension(resolved));
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

        if (isVideoTexture) {
            beginVideoTextureLoad(entry, textureColorSpace, xf, { silent: options.silent });
        } else {
            beginTextureLoad(entry, activeLoader, textureColorSpace, xf, { silent: options.silent });
        }
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

    function bakeFilenameHasExplicitUvChannel(filename) {
        const baseName = String(filename ?? '').replace(/\.[^./\\]+$/, '');
        return /(?:^|[_.\-\s])UV[12](?:$|[_.\-\s])/i.test(baseName);
    }

    function getBakeFilenameCandidates(stem, suffix, extension) {
        const exact = `${stem}${suffix}.${extension}`;
        const names = bakeFilenameHasExplicitUvChannel(exact)
            ? [exact]
            : [
                `${stem}_UV1.${extension}`,
                `${stem}_UV2.${extension}`,
                exact,
                ...(suffix ? [`${stem}.${extension}`] : []),
            ];
        return [...new Set(names)];
    }

    function getBakeTextureCandidates(nd, md, material, kind) {
        if (!bakeOverrides.enabled || !bakeOverrides.folder) return [];
        const folder = normalizeBakeFolderUrl(bakeOverrides.folder);
        if (!folder) return [];
        const suffix = kind === 'beauty' ? bakeOverrides.beautySuffix : bakeOverrides.lightSuffix;
        const stem = sanitizeBakeFileStem(getBakeTargetName(nd, md, material));
        const filenames = getBakeFilenameCandidates(stem, suffix, bakeOverrides.extension);
        return filenames
            .map(filename => bakeOverrides.fileMap?.get(filename.toLowerCase()) ?? (!bakeOverrides.fileMap ? filename : null))
            .filter(Boolean)
            .map(filename => ({
                filename,
                url: `${folder}${encodeURIComponent(filename)}`,
                maxMapChannel: getBakeMaxMapChannel(filename),
            }));
    }

    function getBakeTextureUrl(nd, md, material, kind) {
        return getBakeTextureCandidates(nd, md, material, kind)[0]?.url || '';
    }

    function bakeFileExistsForUrl(url) {
        if (!bakeOverrides.fileSet) return true;
        try {
            const parsed = new URL(url, new URL(`${rootUrl}/`, location.href));
            const filename = decodeURIComponent(parsed.pathname.split('/').pop() || '').toLowerCase();
            return bakeOverrides.fileSet.has(filename);
        } catch {
            const filename = decodeURIComponent(String(url || '').split(/[\\/]/).pop() || '').toLowerCase();
            return bakeOverrides.fileSet.has(filename);
        }
    }

    function loadBakeTextureEntry(
        url,
        colorSpace = THREE.LinearSRGBColorSpace,
        maxMapChannel = 2,
        fallbackTexture = fallbackTextures.white,
    ) {
        if (!bakeFileExistsForUrl(url)) return null;
        const xf = bakeIdentityXf(maxMapChannel);
        return loadTextureEntry(url, colorSpace, xf, fallbackTexture, { silent: true });
    }

    function loadBakeTextureEntryFromCandidates(
        candidates,
        colorSpace = THREE.LinearSRGBColorSpace,
        fallbackTexture = fallbackTextures.white,
    ) {
        let selected = null;
        for (const candidate of candidates || []) {
            const entry = loadBakeTextureEntry(candidate.url, colorSpace, candidate.maxMapChannel, fallbackTexture);
            if (entry && !selected) selected = { ...candidate, entry };
        }
        return selected;
    }

    function bakeExposureScale() {
        const scale = bakeOverrides.intensity * Math.pow(2, bakeOverrides.bakeExposure);
        return Number.isFinite(scale) ? Math.max(0, scale) : 1;
    }

    function isDisplayBakedBeautyProxy(url = '') {
        if (bakeOverrides.proxyDisplay !== true || bakeOverrides.mode !== 'beauty') return false;
        const ext = getTextureExtension(url);
        return ext !== 'exr' && ext !== 'hdr';
    }

    function createBeautyBakeMaterial(source, texture, url = '', maxMapChannel = 2) {
        const displayProxy = isDisplayBakedBeautyProxy(url);
        const exposureScale = displayProxy ? 1 : bakeExposureScale();
        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(exposureScale, exposureScale, exposureScale),
            map: applyTextureUvChannel(texture, maxMapChannel, 2),
            side: source?.side ?? THREE.FrontSide,
            transparent: !!source?.transparent || (Number.isFinite(source?.opacity) && source.opacity < 1),
            opacity: Number.isFinite(source?.opacity) ? source.opacity : 1,
            alphaMap: source?.alphaMap ?? null,
            depthWrite: source?.depthWrite ?? true,
            depthTest: source?.depthTest ?? true,
            toneMapped: !displayProxy,
        });
        material.name = source?.name ? `${source.name} bake beauty` : 'bake beauty';
        material.userData = { ...(source?.userData || {}), maxjsBakeOverride: 'beauty', maxjsBakeUvChannel: maxMapChannel };
        return material;
    }

    function buildBeautyBakeReplacement(descriptor, params, context = {}) {
        if (!bakeOverrides.enabled || bakeOverrides.mode !== 'beauty' || context.wantsLine) return null;
        const bakeNameSource = { name: descriptor?.name ?? 'material' };
        const candidates = getBakeTextureCandidates(context.nd, descriptor, bakeNameSource, 'beauty')
            .filter(candidate => hasGeometryMaxMapChannel(context.geom, candidate.maxMapChannel));
        if (!candidates.length) return null;

        const source = {
            name: descriptor?.name ?? 'material',
            side: params.side ?? THREE.FrontSide,
            transparent: !!params.transparent,
            opacity: Number.isFinite(params.opacity) ? params.opacity : 1,
            depthWrite: params.depthWrite ?? true,
            depthTest: params.depthTest ?? true,
            toneMapped: true,
            userData: {
                maxjsSourceMaterialName: descriptor?.name ?? 'material',
                maxjsRequestedMaterialModel: 'MeshBasicMaterial',
                maxjsMaterialModel: 'MeshBasicMaterial',
            },
        };

        const fallback = colorFallbackTexture(params.color, THREE.SRGBColorSpace);
        const bake = loadBakeTextureEntryFromCandidates(candidates, THREE.SRGBColorSpace, fallback);
        if (!bake) return null;
        const { entry } = bake;
        const baked = createBeautyBakeMaterial(source, entry.texture, bake.url, bake.maxMapChannel);
        baked.userData.maxjsBeautyBakeReplacement = true;
        baked.userData.maxjsBoundTextureSlots = ['map'];
        baked.userData.maxjsBakeSourceUrl = bake.url;
        if (!entry.loaded && !entry.failed) {
            entry.callbacks.push((texture) => {
                baked.map = texture;
                baked.needsUpdate = true;
            });
        }
        return baked;
    }

    function applyBakeOverrideToMaterial(material, md, { nd = null, geom = null, wantsLine = false } = {}) {
        if (!material || !bakeOverrides.enabled || wantsLine) return material;
        if (material.isLineBasicMaterial || material.isLineDashedMaterial) return material;
        const kind = bakeOverrides.mode === 'beauty' ? 'beauty' : 'lightmap';
        const candidates = getBakeTextureCandidates(nd, md, material, kind);
        if (!candidates.length) return material;
        const usableCandidates = candidates.filter(candidate => hasGeometryMaxMapChannel(geom, candidate.maxMapChannel));

        if (!usableCandidates.length) {
            markBakeMissingUv(material, candidates[0]?.maxMapChannel ?? 2);
            return material;
        }

        // If both explicit UV variants exist, prefer the authored lightmap
        // channel and otherwise fall back to UV1.
        const preferredChannel = Number.isFinite(Number(md?.lmCh))
            ? Math.max(1, Math.round(Number(md.lmCh)))
            : 1;
        const orderedCandidates = [...usableCandidates].sort((a, b) => {
            const aMatch = a.maxMapChannel === preferredChannel ? 0 : 1;
            const bMatch = b.maxMapChannel === preferredChannel ? 0 : 1;
            return aMatch - bMatch;
        });

        if (kind === 'beauty') {
            material.userData ??= {};
            clearBakeMissingUv(material);
            material.userData.maxjsSourceMaterialName = material.userData.maxjsSourceMaterialName ?? getMaterialBakeName(md, material);
            const bake = loadBakeTextureEntryFromCandidates(orderedCandidates, THREE.SRGBColorSpace, fallbackTextures.black);
            if (!bake) return material;
            const { entry } = bake;
            material.toneMapped = !isDisplayBakedBeautyProxy(bake.url);
            material.userData.maxjsBakeUvChannel = bake.maxMapChannel;
            const baked = createBeautyBakeMaterial(material, entry.texture, bake.url, bake.maxMapChannel);
            if (!entry.loaded && !entry.failed) {
                entry.callbacks.push((texture) => {
                    applyTextureUvChannel(texture, bake.maxMapChannel, 2);
                    baked.map = texture;
                    baked.needsUpdate = true;
                });
            }
            return baked;
        }

        const bake = loadBakeTextureEntryFromCandidates(orderedCandidates, THREE.LinearSRGBColorSpace);
        if (!bake) return material;
        const { entry } = bake;
        const assign = (texture) => {
            if (!textureReadyForMaterialBinding(texture)) return;
            applyTextureUvChannel(texture, bake.maxMapChannel, 2);
            material.lightMap = texture;
            material.lightMapIntensity = bakeExposureScale();
            material.userData ??= {};
            clearBakeMissingUv(material);
            material.userData.maxjsBakeOverride = 'lightmap';
            material.userData.maxjsBakeUvChannel = bake.maxMapChannel;
            material.needsUpdate = true;
        };
        assign(entry.texture);
        if (!entry.loaded && !entry.failed) entry.callbacks.push(assign);
        return material;
    }

    function bindTexture(material, slot, md) {
        if (!hasWritableProperty(material, slot.property)) return false;
        // Procedural TSL texmap in this slot (WebGPU only). Mirrors the viewer's
        // loadMapSlot precheck: md.<slot>TSL holds code, md.<slot>TSLParams the values.
        if (tslCompiler.nodeMaterialsAvailable) {
            const tslField = firstField(md, slot.urlKeys.map((k) => `${k}TSL`));
            if (tslField.value) {
                const tex = tslCompiler.evalTSLTexture(tslField.value, md?.[`${tslField.key}Params`]);
                if (tex) {
                    material[slot.property] = tex;
                    slot.onAssign?.(material, tex, md);
                    material.needsUpdate = true;
                    return true;
                }
            }
        }
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

    // Bake override owns lightMap while enabled; the regular lmMap callback
    // must not race it after async texture load.
    function slotIsSuppressedByBakeOverride(slot) {
        if (!bakeOverrides.enabled) return false;
        if (bakeOverrides.mode !== 'lightmap') return false;
        return slot.property === 'lightMap';
    }

    function bindSlots(material, md, slots, boundSlots) {
        for (const slot of slots) {
            if (slotIsSuppressedByBakeOverride(slot)) continue;
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
        const beautyReplacement = buildBeautyBakeReplacement(descriptor, params, context);
        if (beautyReplacement) return beautyReplacement;

        // Real TSL node material — WebGPU snapshot target only. On WebGL,
        // nodeMaterialsAvailable is false so we fall through to the existing path.
        if (info.wantsTSLMaterial && descriptor.tslCode && tslCompiler.nodeMaterialsAvailable) {
            const tslMaterial = tslCompiler.createTSLMaterial(descriptor);
            if (tslMaterial) {
                if (descriptor.name) tslMaterial.name = descriptor.name;
                tslMaterial.userData ??= {};
                tslMaterial.userData.maxjsRequestedMaterialModel = info.requestedModelName;
                tslMaterial.userData.maxjsMaterialModel = 'MeshTSLNodeMaterial';
                tslMaterial.userData.maxjsSourceMaterialName = descriptor.name ?? 'material';
                return applyBakeOverrideToMaterial(tslMaterial, descriptor, context);
            }
        }

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
        for (const texture of tslTextureCache.values()) texture?.dispose?.();
        tslTextureCache.clear();
        for (const texture of Object.values(fallbackTextures)) texture?.dispose?.();
    }

    // Lazily pull in the vendored tsl-textures preset library (WebGPU only).
    // snapshot_boot awaits this before applying the scene so preset materials
    // that reference the TEXTURES namespace compile correctly.
    async function loadTslTextures() {
        if (!tslCompiler.nodeMaterialsAvailable || tslCompiler.textures) return;
        try {
            const ns = await import('tsl-textures');
            tslCompiler.setTextures(ns);
        } catch (err) {
            console.warn('[material_builder] tsl-textures preset library unavailable:', err?.message || err);
        }
    }

    return { buildForNode, shouldUpdate, signature, loadTex, setBakeState, textureCache, dispose, loadTslTextures };
}
